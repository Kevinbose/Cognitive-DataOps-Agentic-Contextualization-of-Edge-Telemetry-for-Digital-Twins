/**
 * @file `Device` model — the registry of edge gateways.
 *
 * One document per machine that has ever announced itself with a `birth`
 * message. It exists so the UI can show a device (and its channel catalog)
 * before the broker has replayed anything after a backend restart, and so the
 * last known diagnostics survive one.
 *
 * The live, per-second state (derived online/stale, sequence counters) is held
 * in memory by `device.service.js`; only the slow-changing facts land here.
 *
 * ## Simulator ground truth
 *
 * `simTruth` holds the scenario a simulated gateway says it is running. It is
 * the automatic ground-truth label for the Phase 5 evaluation, so it must never
 * reach the diagnosis agent. The field is `select: false`: no query returns it
 * unless it asks for it by name, which makes leaking it an explicit act rather
 * than an oversight.
 *
 * @module models/Device.model
 */

import mongoose from 'mongoose';

import { CHANNEL_KEY_PATTERN, MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';
import { SENSOR_TYPES } from './SensorBinding.model.js';

const { Schema, model } = mongoose;

const limitsSchema = new Schema(
  {
    warnLow: Number,
    warnHigh: Number,
    alarmLow: Number,
    alarmHigh: Number,
  },
  { _id: false },
);

const channelSchema = new Schema(
  {
    key: { type: String, required: true, match: CHANNEL_KEY_PATTERN },
    label: { type: String, required: true, maxlength: 80 },
    unit: { type: String, default: '', maxlength: 16 },
    sensorType: { type: String, enum: SENSOR_TYPES, default: 'generic' },
    min: { type: Number, required: true },
    max: { type: Number, required: true },
    decimals: { type: Number, default: 2, min: 0, max: 6 },
    limits: { type: limitsSchema, default: () => ({}) },
  },
  { _id: false },
);

const spectrumLayoutSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true, maxlength: 80 },
    unit: { type: String, default: '', maxlength: 16 },
    startHz: { type: Number, required: true },
    stepHz: { type: Number, required: true },
    count: { type: Number, required: true },
    intervalMs: { type: Number, required: true },
    fundamentalHz: { type: Number, default: undefined },
  },
  { _id: false },
);

const deviceSchema = new Schema(
  {
    machineId: {
      type: String,
      required: true,
      unique: true,
      match: MACHINE_ID_PATTERN,
    },
    siteId: { type: String, required: true },
    machineType: { type: String, required: true, maxlength: 24 },
    label: { type: String, required: true, maxlength: 80 },
    fw: { type: String, maxlength: 24, default: null },
    mac: { type: String, maxlength: 17, default: null },
    bootId: { type: String, maxlength: 16, default: null },
    intervalMs: { type: Number, default: 500 },
    scenarios: { type: [String], default: [] },
    channels: { type: [channelSchema], default: [] },
    spectrum: { type: spectrumLayoutSchema, default: null },

    /**
     * The twin (asset) this machine has been added to, or `null` while it is only
     * discovered. A gateway announces itself; a person adds it to a twin. Only an
     * added machine's channels are offered for binding.
     */
    assetId: { type: Schema.Types.ObjectId, ref: 'Asset', default: null, index: true },
    attachedAt: { type: Date, default: null },

    /** Last broker-reported state. `null` until a `status` message is seen. */
    brokerStatus: { type: String, enum: ['online', 'offline', null], default: null },
    lastSeenAt: { type: Date, default: null },
    lastBirthAt: { type: Date, default: null },

    /** Latest `diag` payload with `sim` removed. */
    diag: { type: Schema.Types.Mixed, default: null },

    /** Simulator ground truth. Excluded from every query unless requested. */
    simTruth: { type: Schema.Types.Mixed, default: null, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret.__v;
        // Belt and braces: even if a query asked for it, never serialise it.
        delete ret.simTruth;
        return ret;
      },
    },
  },
);

/** @type {import('mongoose').Model<any>} */
export const Device = model('Device', deviceSchema);

export default Device;
