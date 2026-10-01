/**
 * @file `TelemetryReading` — scalar samples, stored as a time-series collection.
 *
 * One document per channel per second ("tall" rows). That shape keeps the
 * per-sensor history query (`meta.sensorId` plus a time range) a single
 * indexed scan, and lets a channel be added to a machine without a schema
 * change.
 *
 * ## Why creation is explicit
 *
 * Mongoose creates collections lazily, and swallows the error when it cannot
 * (`model.init().catch(noop)`). A failed time-series creation would therefore
 * silently become an ordinary collection with no TTL, growing without bound on
 * a 0.5 GB Atlas M0. So the schema opts out of auto-creation
 * (`autoCreate: false`) and `telemetryStore.service.js#ensureTelemetryStore`
 * creates the collection itself, logs the outcome, and falls back to a plain
 * collection with explicit TTL and lookup indexes when time series are not
 * available.
 *
 * `expireAfterSeconds` is a top-level schema option; it is NOT part of
 * `timeseries`.
 *
 * Document shape: `{ ts, meta: { sensorId }, value, q? }` where `q` is `1` when
 * the server stamped `ts` because the device clock was unsynced or implausible.
 *
 * @module models/TelemetryReading.model
 */

import mongoose from 'mongoose';

import { config } from '../config/env.config.js';

const { Schema, model } = mongoose;

/** Collection name, shared with the fallback path in the store service. */
export const READINGS_COLLECTION = 'telemetry_readings';

const telemetryReadingSchema = new Schema(
  {
    ts: { type: Date, required: true },
    meta: {
      sensorId: { type: String, required: true },
    },
    value: { type: Number, required: true },
    q: { type: Number, default: undefined },
  },
  {
    timeseries: {
      timeField: 'ts',
      metaField: 'meta',
      granularity: 'seconds',
    },
    expireAfterSeconds: config.telemetry.retentionHours * 3600,
    autoCreate: false,
    autoIndex: false,
    _id: false,
    versionKey: false,
    collection: READINGS_COLLECTION,
  },
);

/** @type {import('mongoose').Model<any>} */
export const TelemetryReading = model('TelemetryReading', telemetryReadingSchema);

export default TelemetryReading;
