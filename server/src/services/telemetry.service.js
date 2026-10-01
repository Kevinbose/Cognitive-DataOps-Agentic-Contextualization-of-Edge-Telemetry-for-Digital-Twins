/**
 * @file Telemetry ingestion pipeline.
 *
 * Everything between "bytes arrived on a topic" and "a number is on a screen
 * and in the database":
 *
 * ```
 * mqtt.service ─▶ handleMessage ─▶ parse topic ─▶ parse + validate payload
 *                                      │
 *            ┌─────────────────────────┼──────────────────────────┐
 *         birth/status/diag/ack     telemetry                  spectrum
 *       (device.service registry)       │                          │
 *                                normalise: sensorId, unit,    frame ─▶ emit + store
 *                                status from limits, binding
 *                                       │
 *                       ┌───────────────┴───────────────┐
 *                 coalesce ─▶ emit (volatile)     1 per s ─▶ BatchWriter
 * ```
 *
 * Design rules:
 *
 * - **Nothing a device sends can throw.** Every failure path ends in
 *   `reject()`, which counts the message and moves on. A malformed payload must
 *   not become an unhandled rejection or stop the stream for other devices.
 * - **Handlers are idempotent.** The broker replays retained `birth` and
 *   `status` on every reconnect; applying them twice must equal applying once.
 * - **The device clock is a claim, not a fact.** A timestamp is used only when
 *   the device says it is synced and the value is within two minutes of the
 *   server clock; otherwise the receive time is used and the sample is marked.
 * - **Persistence is thinned.** One sample per channel per second reaches the
 *   database regardless of how fast the device publishes.
 *
 * @module services/telemetry.service
 */

import { config } from '../config/env.config.js';
import { evaluateStatus } from '../utils/channelStatus.js';
import { LatestPerKey } from '../utils/writeBuffer.js';
import { parseInboundTopic, sensorIdFor } from '../utils/mqttTopics.js';
import {
  MAX_PAYLOAD_BYTES,
  ackPayloadSchema,
  birthPayloadSchema,
  diagPayloadSchema,
  spectrumPayloadSchema,
  statusPayloadSchema,
  telemetryPayloadSchema,
} from '../validators/telemetry.validator.js';
import { resolveSensor } from './bindingIndex.service.js';
import * as deviceService from './device.service.js';
import { endMqtt, getMqttStatus, startMqtt } from './mqtt.service.js';
import {
  enqueueReadings,
  enqueueSpectrum,
  getStoreStats,
  startTelemetryWriter,
  stopTelemetryWriter,
} from './telemetryStore.service.js';
import { emitSpectrumFrame, emitTelemetryBatch } from './websocket.service.js';

/** A device timestamp further than this from the server clock is not believed. */
const MAX_CLOCK_SKEW_MS = 120_000;

/**
 * One scalar sample as sent to browsers.
 *
 * @typedef {object} Sample
 * @property {string} sensorId - `MACHINE.KEY`, upper case.
 * @property {string} machineId
 * @property {string} key
 * @property {number} value
 * @property {string} unit
 * @property {number} decimals
 * @property {number} ts - Sample time, epoch ms.
 * @property {number} rx - Server receive time, epoch ms.
 * @property {'normal'|'warn'|'alarm'} status
 * @property {string} [assetId] - Present when the sensor is bound.
 * @property {string} [meshName] - Present when the sensor is bound.
 */

const counters = {
  received: 0,
  accepted: 0,
  invalid: 0,
  unknownTopic: 0,
  tsStamped: 0,
  /** @type {Record<string, number>} */
  invalidByReason: {},
};

/** @type {Map<string, Sample>} */
const latest = new Map();
/** @type {Map<string, {machineId: string, key: string, ts: number, amp: number[]}>} */
const latestSpectrum = new Map();

/** Newest sample per sensor since the last browser emit. */
const emitPending = new LatestPerKey();
/** Newest sample per sensor since the last persistence tick. */
const persistPending = new LatestPerKey();

/** @type {NodeJS.Timeout|null} */
let emitTimer = null;
/** @type {NodeJS.Timeout|null} */
let persistTimer = null;
let persistEnabled = false;
let activeSiteId = config.mqtt.siteId;
const lastRejectLogAt = new Map();

/* ─── Rejection ────────────────────────────────────────────────────────────── */

/**
 * Count and (rate-limited) log a dropped message.
 *
 * @param {string} reason - Short stable label, e.g. `telemetry-schema`.
 * @param {string} topic - Topic it arrived on.
 * @param {string} [detail] - First validation message, for the log.
 * @returns {void}
 */
function reject(reason, topic, detail) {
  counters.invalid += 1;
  counters.invalidByReason[reason] = (counters.invalidByReason[reason] ?? 0) + 1;

  // One line per reason per ten seconds: a broken device publishing at 2 Hz
  // would otherwise bury the console.
  const now = Date.now();
  if (now - (lastRejectLogAt.get(reason) ?? 0) > 10_000) {
    lastRejectLogAt.set(reason, now);
    console.warn(`[ingest] Dropped message on ${topic} (${reason})${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Format the first issue of a zod failure for a log line.
 * @param {import('zod').ZodError} error
 * @returns {string}
 */
function firstIssue(error) {
  const issue = error.issues[0];
  return issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid';
}

/**
 * Decode a payload as JSON, or return `undefined`.
 * @param {Buffer} payload
 * @returns {unknown}
 */
function parseJson(payload) {
  try {
    return JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Decide which timestamp to trust for a sample.
 *
 * @param {{ts: number, synced?: boolean}} message
 * @param {number} now - Server receive time, epoch ms.
 * @returns {{ts: number, stamped: boolean}} The timestamp and whether the server set it.
 */
export function resolveTimestamp(message, now) {
  const synced = message.synced ?? true;
  if (synced && message.ts > 0 && Math.abs(message.ts - now) <= MAX_CLOCK_SKEW_MS) {
    return { ts: message.ts, stamped: false };
  }
  counters.tsStamped += 1;
  return { ts: now, stamped: true };
}

/* ─── Message handlers ─────────────────────────────────────────────────────── */

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 * @param {{retain: boolean}} packet
 */
function onBirth(machineId, topic, payload, packet) {
  const json = parseJson(payload);
  const result = birthPayloadSchema.safeParse(json);
  if (!result.success) return reject('birth-schema', topic, firstIssue(result.error));

  // The machine id is in both the topic and the body. They must agree, or a
  // device could overwrite another machine's registry entry.
  if (result.data.machineId !== machineId) {
    return reject('machine-id-mismatch', topic, `topic says ${machineId}, body says ${result.data.machineId}`);
  }

  counters.accepted += 1;
  deviceService.applyBirth(machineId, result.data, { retained: packet.retain });
  return undefined;
}

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 */
function onStatus(machineId, topic, payload) {
  const result = statusPayloadSchema.safeParse(payload.toString('utf8').trim());
  if (!result.success) return reject('status-value', topic);

  counters.accepted += 1;
  deviceService.applyStatus(machineId, result.data);
  return undefined;
}

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 */
function onTelemetry(machineId, topic, payload) {
  const result = telemetryPayloadSchema.safeParse(parseJson(payload));
  if (!result.success) return reject('telemetry-schema', topic, firstIssue(result.error));

  const now = Date.now();
  const message = result.data;

  if (!deviceService.noteTelemetry(machineId, message.seq)) {
    return reject('telemetry-duplicate', topic);
  }

  counters.accepted += 1;
  const { ts, stamped } = resolveTimestamp(message, now);

  for (const [key, value] of Object.entries(message.m)) {
    const meta = deviceService.getChannelMeta(machineId, key);
    const sensorId = sensorIdFor(machineId, key);
    const bound = resolveSensor(sensorId);

    /** @type {Sample} */
    const sample = {
      sensorId,
      machineId,
      key,
      value,
      unit: meta?.unit ?? '',
      decimals: meta?.decimals ?? 2,
      ts,
      rx: now,
      status: evaluateStatus(value, meta?.limits),
      ...(bound ? { assetId: bound.assetId, meshName: bound.meshName } : {}),
    };

    latest.set(sensorId, sample);
    emitPending.offer(sensorId, sample);
    persistPending.offer(sensorId, { sample, stamped });
  }
  return undefined;
}

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 */
function onSpectrum(machineId, topic, payload) {
  const result = spectrumPayloadSchema.safeParse(parseJson(payload));
  if (!result.success) return reject('spectrum-schema', topic, firstIssue(result.error));

  const layout = deviceService.getDeviceState(machineId)?.spectrum;
  const message = result.data;

  // Once the birth has declared a layout, frames must match it exactly; a
  // mismatch would draw a wrong frequency axis.
  if (layout && (message.key !== layout.key || message.amp.length !== layout.count)) {
    return reject(
      'spectrum-layout',
      topic,
      `expected ${layout.key} x ${layout.count}, got ${message.key} x ${message.amp.length}`,
    );
  }

  counters.accepted += 1;
  deviceService.noteActivity(machineId);

  const { ts } = resolveTimestamp({ ts: message.ts }, Date.now());
  const frame = { machineId, key: message.key, ts, amp: message.amp };

  latestSpectrum.set(machineId, frame);
  emitSpectrumFrame(frame);

  if (persistEnabled) {
    enqueueSpectrum({
      ts: new Date(ts),
      meta: { machineId, key: message.key },
      amp: message.amp,
    });
  }
  return undefined;
}

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 */
function onDiag(machineId, topic, payload) {
  const result = diagPayloadSchema.safeParse(parseJson(payload));
  if (!result.success) return reject('diag-schema', topic, firstIssue(result.error));

  counters.accepted += 1;
  deviceService.applyDiag(machineId, result.data);
  return undefined;
}

/**
 * @param {string} machineId
 * @param {string} topic
 * @param {Buffer} payload
 */
function onAck(machineId, topic, payload) {
  const result = ackPayloadSchema.safeParse(parseJson(payload));
  if (!result.success) return reject('ack-schema', topic, firstIssue(result.error));

  counters.accepted += 1;
  deviceService.applyAck(machineId, result.data);
  return undefined;
}

/**
 * Remote debug lines from an untethered board. Printed, never stored.
 *
 * @param {string} machineId
 * @param {Buffer} payload
 */
function onLog(machineId, payload) {
  // Device text is untrusted: strip control characters (terminal escape
  // injection) and cap the length before it reaches a console.
  const line = payload
    .toString('utf8')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, 200);
  console.log(`[device:${machineId}] ${line}`);
}

/**
 * Entry point for every inbound MQTT message.
 *
 * Synchronous and total: it never throws and never awaits, so the caller's
 * try/catch is a second line of defence, not the first.
 *
 * @param {string} topic - Topic the message arrived on.
 * @param {Buffer} payload - Raw payload.
 * @param {{retain: boolean, qos: number}} packet - Delivery metadata.
 * @returns {void}
 */
export function handleMessage(topic, payload, packet) {
  counters.received += 1;

  const parsed = parseInboundTopic(topic, activeSiteId);
  if (!parsed) {
    counters.unknownTopic += 1;
    return;
  }

  if (payload.length > MAX_PAYLOAD_BYTES) {
    reject('oversized', topic, `${payload.length} bytes`);
    return;
  }

  const { machineId, suffix } = parsed;

  switch (suffix) {
    case 'birth':
      onBirth(machineId, topic, payload, packet);
      break;
    case 'status':
      onStatus(machineId, topic, payload);
      break;
    case 'telemetry':
      onTelemetry(machineId, topic, payload);
      break;
    case 'spectrum':
      onSpectrum(machineId, topic, payload);
      break;
    case 'diag':
      onDiag(machineId, topic, payload);
      break;
    case 'ack':
      onAck(machineId, topic, payload);
      break;
    case 'log':
      onLog(machineId, payload);
      break;
    default:
      counters.unknownTopic += 1;
  }
}

/* ─── Timers ───────────────────────────────────────────────────────────────── */

/** Send the coalesced samples to browsers. */
export function flushEmit() {
  emitTelemetryBatch(emitPending.drain());
}

/** Move one thinned sample per channel into the write queue. */
export function flushPersist() {
  if (!persistEnabled) return;

  const docs = persistPending.drain().map(({ sample, stamped }) => ({
    ts: new Date(sample.ts),
    meta: { sensorId: sample.sensorId },
    value: sample.value,
    ...(stamped ? { q: 1 } : {}),
  }));

  enqueueReadings(docs);
}

/* ─── Lifecycle ────────────────────────────────────────────────────────────── */

/**
 * Start ingestion: registry, timers, writers and the broker connection.
 *
 * @param {object} [options]
 * @param {string} [options.url] - Broker URL. Defaults to `MQTT_URL`.
 * @param {string|null} [options.username]
 * @param {string|null} [options.password]
 * @param {string} [options.siteId]
 * @param {boolean} [options.persist] - Write to MongoDB. Defaults to `TELEMETRY_PERSIST`.
 * @param {string} [options.clientId]
 * @returns {Promise<void>}
 */
export async function startIngestion({
  url = /** @type {string} */ (config.mqtt.url),
  username = config.mqtt.username,
  password = config.mqtt.password,
  siteId = config.mqtt.siteId,
  persist = config.telemetry.persist,
  clientId,
} = {}) {
  activeSiteId = siteId;
  persistEnabled = persist;

  await deviceService.initDeviceRegistry({ siteId });
  deviceService.startDeviceTicker();

  emitTimer = setInterval(flushEmit, Math.round(1000 / config.telemetry.emitHzMax));
  emitTimer.unref();

  if (persistEnabled) {
    startTelemetryWriter();
    persistTimer = setInterval(flushPersist, Math.round(1000 / config.telemetry.persistHz));
    persistTimer.unref();
  }

  startMqtt({ url, username, password, siteId, onMessage: handleMessage, clientId });
}

/**
 * Stop the timers and write what is left. Does NOT close the broker
 * connection; shutdown stops consumption first and ends the connection last.
 *
 * @returns {Promise<void>}
 */
export async function stopIngestion() {
  if (emitTimer) clearInterval(emitTimer);
  if (persistTimer) clearInterval(persistTimer);
  emitTimer = null;
  persistTimer = null;

  deviceService.stopDeviceTicker();

  if (persistEnabled) {
    flushPersist();
    await stopTelemetryWriter();
  }
}

/**
 * Stop ingestion and close the broker connection. Convenience for tests.
 * @returns {Promise<void>}
 */
export async function stopIngestionAndDisconnect() {
  await stopIngestion();
  await endMqtt();
}

/**
 * Payload for a browser's first message, so a fresh tab is never blank.
 *
 * @returns {{serverTime: number, devices: object[], latest: Record<string, Sample>,
 *   spectra: Record<string, object>}}
 */
export function getSnapshot() {
  return {
    serverTime: Date.now(),
    devices: deviceService.listPublicDevices(),
    latest: Object.fromEntries(latest),
    spectra: Object.fromEntries(latestSpectrum),
  };
}

/**
 * Newest sample per channel.
 *
 * @param {string} [machineId] - Restrict to one machine.
 * @returns {Sample[]}
 */
export function getLatestSamples(machineId) {
  const all = [...latest.values()];
  return machineId ? all.filter((sample) => sample.machineId === machineId) : all;
}

/**
 * Newest in-memory spectrum frame for a machine.
 *
 * @param {string} machineId
 * @returns {{machineId: string, key: string, ts: number, amp: number[]}|null}
 */
export function getLatestSpectrumFrame(machineId) {
  return latestSpectrum.get(machineId) ?? null;
}

/**
 * Ingestion counters for `/health`.
 *
 * @returns {object}
 */
export function getIngestStats() {
  return {
    mqtt: getMqttStatus(),
    messages: {
      received: counters.received,
      accepted: counters.accepted,
      invalid: counters.invalid,
      unknownTopic: counters.unknownTopic,
      timestampsStamped: counters.tsStamped,
      invalidByReason: { ...counters.invalidByReason },
    },
    store: getStoreStats(),
    persisting: persistEnabled,
  };
}

/**
 * Clear in-memory state. Test-only.
 * @returns {void}
 */
export function resetTelemetryForTests() {
  latest.clear();
  latestSpectrum.clear();
  emitPending.drain();
  persistPending.drain();
  counters.received = 0;
  counters.accepted = 0;
  counters.invalid = 0;
  counters.unknownTopic = 0;
  counters.tsStamped = 0;
  counters.invalidByReason = {};
  lastRejectLogAt.clear();
}

export default {
  handleMessage,
  startIngestion,
  stopIngestion,
  stopIngestionAndDisconnect,
  getSnapshot,
  getLatestSamples,
  getLatestSpectrumFrame,
  getIngestStats,
  resolveTimestamp,
  flushEmit,
  flushPersist,
  resetTelemetryForTests,
};
