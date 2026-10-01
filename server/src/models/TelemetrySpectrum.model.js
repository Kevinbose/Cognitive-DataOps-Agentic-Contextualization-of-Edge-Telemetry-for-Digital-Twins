/**
 * @file `TelemetrySpectrum` — vibration spectra, stored as a time-series collection.
 *
 * A spectrum is an array of amplitude bins, not a scalar, so it lives in its own
 * collection rather than as a channel of `TelemetryReading`. The bin layout
 * (`startHz`, `stepHz`, `count`) is declared once in the device's `birth`
 * message and is deliberately not repeated on every document.
 *
 * Creation is explicit for the same reason as `TelemetryReading`; see that file.
 *
 * Document shape: `{ ts, meta: { machineId, key }, amp: number[] }`.
 *
 * @module models/TelemetrySpectrum.model
 */

import mongoose from 'mongoose';

import { config } from '../config/env.config.js';

const { Schema, model } = mongoose;

/** Collection name, shared with the fallback path in the store service. */
export const SPECTRA_COLLECTION = 'telemetry_spectra';

const telemetrySpectrumSchema = new Schema(
  {
    ts: { type: Date, required: true },
    meta: {
      machineId: { type: String, required: true },
      key: { type: String, required: true },
    },
    amp: { type: [Number], required: true },
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
    collection: SPECTRA_COLLECTION,
  },
);

/** @type {import('mongoose').Model<any>} */
export const TelemetrySpectrum = model('TelemetrySpectrum', telemetrySpectrumSchema);

export default TelemetrySpectrum;
