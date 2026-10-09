/**
 * @file `DiagnosticReport` model: the agent's located, explained, cited answer.
 *
 * Written only through the MCP tool `post_diagnostic_report`, which validates
 * every mesh name against the twin's geometry and every citation against the
 * evidence the agent retrieved. Numbers (scores, confidence) are computed by
 * code in the agent; the model only words the headline and the summary.
 *
 * @module models/DiagnosticReport.model
 */

import mongoose from 'mongoose';

import { MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';
import { ANOMALY_SEVERITIES } from './Investigation.model.js';

const { Schema, model } = mongoose;

export const SEVERITY_LEVELS = Object.freeze(['normal', 'watch', 'warning', 'alarm', 'critical']);

const causeSchema = new Schema(
  {
    id: { type: String, required: true, maxlength: 64 },
    name: { type: String, required: true, maxlength: 160 },
    confidence: { type: Number, min: 0, max: 1, required: true },
    faultCode: { type: String, default: null, maxlength: 16 },
  },
  { _id: false },
);

const evidenceSchema = new Schema(
  {
    test: { type: String, required: true, maxlength: 200 },
    channel: { type: String, default: null, maxlength: 64 },
    observed: { type: String, required: true, maxlength: 80 },
    expected: { type: String, required: true, maxlength: 120 },
    verdict: { type: String, enum: ['supports', 'contradicts', 'neutral'], required: true },
  },
  { _id: false },
);

const actionSchema = new Schema(
  {
    step: { type: String, required: true, maxlength: 400 },
    caveat: { type: String, default: null, maxlength: 300 },
  },
  { _id: false },
);

const citationSchema = new Schema(
  {
    chunkId: { type: String, required: true, maxlength: 120 },
    ref: { type: String, default: null, maxlength: 8 },
    document: { type: String, required: true, maxlength: 200 },
    section: { type: String, default: null, maxlength: 300 },
    page: { type: Number, default: null },
    filename: { type: String, default: null, maxlength: 200 },
  },
  { _id: false },
);

const targetSchema = new Schema(
  {
    meshName: { type: String, required: true, maxlength: 512 },
    label: { type: String, default: null, maxlength: 120 },
    tag: { type: String, default: null, maxlength: 64 },
    sensorId: { type: String, default: null, maxlength: 128 },
  },
  { _id: false },
);

const diagnosticReportSchema = new Schema(
  {
    investigationId: { type: Schema.Types.ObjectId, ref: 'Investigation', default: null, index: true },
    assetId: { type: Schema.Types.ObjectId, ref: 'Asset', default: null, index: true },
    machineId: { type: String, required: true, match: MACHINE_ID_PATTERN },
    severity: { type: String, enum: ANOMALY_SEVERITIES, required: true },
    level: { type: String, enum: SEVERITY_LEVELS, default: 'warning' },
    headline: { type: String, required: true, maxlength: 160 },
    summary: { type: String, default: '', maxlength: 2000 },
    rootCause: { type: causeSchema, required: true },
    alternatives: { type: [causeSchema], default: [] },
    evidence: { type: [evidenceSchema], default: [] },
    actions: { type: [actionSchema], default: [] },
    citations: { type: [citationSchema], default: [] },
    targets: { type: [targetSchema], default: [] },
    needsBinding: { type: [String], default: [] },
    degraded: { type: Boolean, default: false },
    needsReview: { type: Boolean, default: false },
    generatedBy: { type: String, enum: ['agent', 'template'], default: 'agent' },
    model: { type: String, default: null, maxlength: 80 },
  },
  { timestamps: true, versionKey: false },
);

diagnosticReportSchema.index({ assetId: 1, createdAt: -1 });

/** @type {import('mongoose').Model<any>} */
export const DiagnosticReport = model('DiagnosticReport', diagnosticReportSchema);

export default DiagnosticReport;
