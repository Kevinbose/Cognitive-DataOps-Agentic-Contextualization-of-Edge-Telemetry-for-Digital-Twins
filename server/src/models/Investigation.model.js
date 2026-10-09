/**
 * @file `Investigation` model: one anomaly the detector opened, and its fate.
 *
 * The anomaly detector (deterministic, no model) opens an investigation when a
 * channel holds a limit or drifts away from its own baseline. The diagnosis
 * agent then analyses it and posts a `DiagnosticReport`. At most one
 * investigation per machine is active at a time; the partial unique index
 * enforces that in the database, not in application code.
 *
 * Status:
 *   analysing           handed to the agent, report pending
 *   reported            the agent posted a report
 *   agent_unavailable   the agent could not be reached; the alarm still shows
 *   failed              the agent tried and gave up
 *   resolved            the channel is back to normal (set by the detector)
 *
 * @module models/Investigation.model
 */

import mongoose from 'mongoose';

import { MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';

const { Schema, model } = mongoose;

export const INVESTIGATION_STATUSES = Object.freeze([
  'analysing',
  'reported',
  'agent_unavailable',
  'failed',
  'resolved',
]);

/** Statuses that keep the machine "busy": no second investigation opens. */
export const ACTIVE_INVESTIGATION_STATUSES = Object.freeze(['analysing', 'reported', 'agent_unavailable', 'failed']);

export const ANOMALY_KINDS = Object.freeze(['threshold', 'drift']);
export const ANOMALY_SEVERITIES = Object.freeze(['warn', 'alarm']);

const triggerSchema = new Schema(
  {
    value: Number,
    mean10: Number,
    mean60: Number,
    baseline: Number,
    baselineStd: Number,
    limit: Number,
    limitName: { type: String, maxlength: 16 },
    unit: { type: String, maxlength: 16 },
  },
  { _id: false },
);

const investigationSchema = new Schema(
  {
    machineId: { type: String, required: true, match: MACHINE_ID_PATTERN, index: true },
    assetId: { type: Schema.Types.ObjectId, ref: 'Asset', default: null, index: true },
    sensorId: { type: String, required: true, maxlength: 128 },
    channelKey: { type: String, required: true, maxlength: 64 },
    kind: { type: String, enum: ANOMALY_KINDS, required: true },
    severity: { type: String, enum: ANOMALY_SEVERITIES, required: true },
    status: { type: String, enum: INVESTIGATION_STATUSES, default: 'analysing', index: true },
    trigger: { type: triggerSchema, default: () => ({}) },
    openedAt: { type: Date, required: true },
    analysedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    reportId: { type: Schema.Types.ObjectId, ref: 'DiagnosticReport', default: null },
    // True while the machine holds the single active slot (cleared on resolve).
    active: { type: Boolean, default: true },
    error: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true, versionKey: false },
);

/** One active investigation per machine, enforced by the database. */
investigationSchema.index(
  { machineId: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'uniq_active_investigation' },
);

investigationSchema.index({ assetId: 1, openedAt: -1 });

/** @type {import('mongoose').Model<any>} */
export const Investigation = model('Investigation', investigationSchema);

export default Investigation;
