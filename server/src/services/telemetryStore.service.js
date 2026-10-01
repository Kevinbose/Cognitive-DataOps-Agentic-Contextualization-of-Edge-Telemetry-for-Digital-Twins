/**
 * @file Telemetry persistence — store creation, batched writes, history reads.
 *
 * Three jobs, kept together because they all concern the two time-series
 * collections and share their failure modes:
 *
 *   1. `ensureTelemetryStore()` creates the collections explicitly (see the
 *      note in `TelemetryReading.model.js` for why Mongoose's own creation is
 *      not trusted) and reports which mode it ended up in.
 *   2. Two `BatchWriter`s accept documents from the ingestion pipeline and
 *      insert them in bounded, retrying batches.
 *   3. Read helpers for the history and spectrum endpoints.
 *
 * @module services/telemetryStore.service
 */

import mongoose from 'mongoose';

import { config } from '../config/env.config.js';
import { SPECTRA_COLLECTION, TelemetrySpectrum } from '../models/TelemetrySpectrum.model.js';
import { READINGS_COLLECTION, TelemetryReading } from '../models/TelemetryReading.model.js';
import { BatchWriter } from '../utils/batchWriter.js';

/**
 * How a collection was created.
 *
 * - `timeseries`: a native MongoDB time-series collection with TTL.
 * - `fallback`: an ordinary collection with an explicit TTL index, used when
 *   time series are unavailable (an Atlas tier or server version without them).
 * - `unknown`: `ensureTelemetryStore` has not run.
 *
 * @typedef {'timeseries'|'fallback'|'unknown'} StoreMode
 */

/** @type {{readings: StoreMode, spectra: StoreMode}} */
const storeMode = { readings: 'unknown', spectra: 'unknown' };

/** Options passed to every insert: no casting, no ordering, raw driver result. */
const INSERT_OPTIONS = Object.freeze({ ordered: false, lean: true, rawResult: true });

/**
 * Insert one batch through Mongoose and report how many documents failed.
 *
 * `insertMany` with `ordered: false` keeps going after a bad document, so a
 * partial failure is normal and is reported as a count, not thrown.
 *
 * @param {import('mongoose').Model<any>} Model - Target model.
 * @param {any[]} batch - Documents (plain objects; `ts` must be a `Date`).
 * @returns {Promise<{failed: number}>}
 */
async function insertBatch(Model, batch) {
  try {
    await Model.insertMany(batch, { ...INSERT_OPTIONS });
    return { failed: 0 };
  } catch (error) {
    const writeErrors = error?.writeErrors ?? error?.results?.writeErrors;
    if (Array.isArray(writeErrors) && writeErrors.length > 0) {
      console.error(
        `[store] ${writeErrors.length} of ${batch.length} documents rejected: ` +
          `${writeErrors[0]?.errmsg ?? writeErrors[0]?.err?.errmsg ?? 'write error'}`,
      );
      return { failed: writeErrors.length };
    }
    throw error;
  }
}

/** @type {BatchWriter|null} */
let readingWriter = null;
/** @type {BatchWriter|null} */
let spectrumWriter = null;
/** @type {NodeJS.Timeout|null} */
let flushTimer = null;

/**
 * Create one collection, preferring a native time-series collection.
 *
 * @param {import('mongoose').Model<any>} Model - Model whose schema declares the time series.
 * @param {string} name - Collection name.
 * @param {Array<{key: Record<string, 1|-1>, name: string}>} fallbackIndexes - Lookup
 *   indexes for the plain-collection fallback (a time-series collection indexes
 *   `meta` and `ts` itself).
 * @param {number} retentionHours - TTL in hours.
 * @returns {Promise<StoreMode>} The resulting mode.
 */
async function ensureCollection(Model, name, fallbackIndexes, retentionHours) {
  const db = mongoose.connection.db;
  const expireAfterSeconds = retentionHours * 3600;

  const [existing] = await db.listCollections({ name }, { nameOnly: false }).toArray();

  if (existing?.type === 'timeseries') {
    // Retention is an environment variable; honour a changed value on restart.
    if (existing.options?.expireAfterSeconds !== expireAfterSeconds) {
      await db.command({ collMod: name, expireAfterSeconds });
      console.log(`[store] ${name}: retention set to ${retentionHours} h`);
    }
    return 'timeseries';
  }

  if (!existing) {
    try {
      await Model.createCollection();
      return 'timeseries';
    } catch (error) {
      console.warn(
        `[store] ${name}: time-series creation failed (${error.message}). ` +
          'Falling back to a plain collection with a TTL index.',
      );
      await db.createCollection(name);
    }
  }

  // Plain collection (fresh fallback, or one that already existed): make sure
  // expiry and lookup indexes are in place.
  const collection = db.collection(name);
  try {
    await collection.createIndex({ ts: 1 }, { expireAfterSeconds, name: 'ttl_ts' });
  } catch (error) {
    // Same key, different TTL: an existing index's TTL can only change via collMod.
    if (error?.code === 85 || error?.code === 86) {
      await db.command({
        collMod: name,
        index: { name: 'ttl_ts', expireAfterSeconds },
      });
    } else {
      throw error;
    }
  }
  for (const index of fallbackIndexes) {
    await collection.createIndex(index.key, { name: index.name });
  }

  return 'fallback';
}

/**
 * Create both telemetry collections if needed. Safe to call on every boot.
 *
 * @param {object} [options]
 * @param {number} [options.retentionHours] - TTL in hours; defaults to config.
 * @returns {Promise<{readings: StoreMode, spectra: StoreMode}>} Resulting modes.
 */
export async function ensureTelemetryStore({
  retentionHours = config.telemetry.retentionHours,
} = {}) {
  storeMode.readings = await ensureCollection(
    TelemetryReading,
    READINGS_COLLECTION,
    [{ key: { 'meta.sensorId': 1, ts: -1 }, name: 'by_sensor_ts' }],
    retentionHours,
  );
  storeMode.spectra = await ensureCollection(
    TelemetrySpectrum,
    SPECTRA_COLLECTION,
    [{ key: { 'meta.machineId': 1, 'meta.key': 1, ts: -1 }, name: 'by_machine_ts' }],
    retentionHours,
  );

  console.log(
    `[store] Telemetry store ready (readings: ${storeMode.readings}, spectra: ${storeMode.spectra}, ` +
      `retention ${retentionHours} h)`,
  );

  return { ...storeMode };
}

/**
 * Start the batched writers and their flush timer.
 *
 * @param {object} [options]
 * @param {number} [options.intervalMs] - Flush cadence. Default one second.
 * @param {number} [options.bufferMax] - Queue capacity. Defaults to config.
 * @returns {void}
 */
export function startTelemetryWriter({
  intervalMs = Math.round(1000 / config.telemetry.persistHz),
  bufferMax = config.telemetry.bufferMax,
} = {}) {
  readingWriter = new BatchWriter({
    name: 'readings',
    capacity: bufferMax,
    insert: (batch) => insertBatch(TelemetryReading, batch),
  });
  spectrumWriter = new BatchWriter({
    name: 'spectra',
    capacity: 2000,
    batchSize: 100,
    insert: (batch) => insertBatch(TelemetrySpectrum, batch),
  });

  flushTimer = setInterval(() => {
    void flushTelemetryStore();
  }, intervalMs);
  flushTimer.unref();
}

/**
 * Stop the flush timer and write whatever is still queued.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Ceiling on the final flush.
 * @returns {Promise<void>}
 */
export async function stopTelemetryWriter({ timeoutMs = 2500 } = {}) {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;

  await Promise.race([
    flushTelemetryStore(),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/**
 * Queue scalar readings for persistence.
 *
 * @param {Array<{ts: Date, meta: {sensorId: string}, value: number, q?: number}>} docs
 * @returns {void}
 */
export function enqueueReadings(docs) {
  readingWriter?.enqueue(docs);
}

/**
 * Queue one spectrum frame for persistence.
 *
 * @param {{ts: Date, meta: {machineId: string, key: string}, amp: number[]}} doc
 * @returns {void}
 */
export function enqueueSpectrum(doc) {
  spectrumWriter?.enqueue([doc]);
}

/**
 * Write every queued document now.
 * @returns {Promise<void>}
 */
export async function flushTelemetryStore() {
  await Promise.all([readingWriter?.flush(), spectrumWriter?.flush()]);
}

/**
 * @returns {{mode: {readings: StoreMode, spectra: StoreMode}, readings: object|null, spectra: object|null}}
 *   Store mode and writer counters, for `/health`.
 */
export function getStoreStats() {
  return {
    mode: { ...storeMode },
    readings: readingWriter?.stats() ?? null,
    spectra: spectrumWriter?.stats() ?? null,
  };
}

/**
 * Bucketed history for one sensor.
 *
 * Aggregates on the server with `$dateTrunc`, so a 48 h window is returned as a
 * bounded number of points instead of 170,000 rows.
 *
 * @param {object} params
 * @param {string} params.sensorId - Upper-case sensor id.
 * @param {Date} params.from - Window start (already clamped to retention).
 * @param {Date} params.to - Window end.
 * @param {number} params.bucketSec - Bucket width in seconds.
 * @param {number} params.maxPoints - Hard cap on returned points.
 * @returns {Promise<Array<{ts: Date, min: number, avg: number, max: number, n: number}>>}
 */
export async function queryHistory({ sensorId, from, to, bucketSec, maxPoints }) {
  const rows = await TelemetryReading.aggregate([
    { $match: { 'meta.sensorId': sensorId, ts: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { $dateTrunc: { date: '$ts', unit: 'second', binSize: bucketSec } },
        min: { $min: '$value' },
        avg: { $avg: '$value' },
        max: { $max: '$value' },
        n: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: maxPoints },
  ]);

  return rows.map((row) => ({
    ts: row._id,
    min: row.min,
    avg: row.avg,
    max: row.max,
    n: row.n,
  }));
}

/**
 * Most recent stored spectrum for a machine.
 *
 * @param {string} machineId - Machine id.
 * @returns {Promise<{ts: Date, key: string, amp: number[]}|null>}
 */
export async function findLatestSpectrum(machineId) {
  const doc = await TelemetrySpectrum.findOne({ 'meta.machineId': machineId })
    .sort({ ts: -1 })
    .lean();

  return doc ? { ts: doc.ts, key: doc.meta.key, amp: doc.amp } : null;
}

export default {
  ensureTelemetryStore,
  startTelemetryWriter,
  stopTelemetryWriter,
  enqueueReadings,
  enqueueSpectrum,
  flushTelemetryStore,
  getStoreStats,
  queryHistory,
  findLatestSpectrum,
};
