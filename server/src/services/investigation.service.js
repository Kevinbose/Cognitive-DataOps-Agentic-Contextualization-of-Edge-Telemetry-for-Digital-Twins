/**
 * @file Investigations and diagnostic reports: persistence and transitions.
 *
 * The detector opens investigations, the agent closes them with a report, and
 * the detector resolves them when the machine is healthy again. Each step is
 * idempotent: opening twice for one machine is refused by the database's
 * partial unique index, and posting a second report for one investigation
 * replaces nothing (the first report wins).
 *
 * @module services/investigation.service
 */

import mongoose from 'mongoose';

import { DiagnosticReport } from '../models/DiagnosticReport.model.js';
import { Investigation } from '../models/Investigation.model.js';
import { ApiError } from '../utils/ApiError.js';
import { emitAgentAlert, emitAgentStatus } from './websocket.service.js';

/**
 * Public shape of an investigation.
 * @param {any} doc
 */
export function toPublicInvestigation(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    machineId: doc.machineId,
    assetId: doc.assetId ? String(doc.assetId) : null,
    sensorId: doc.sensorId,
    channelKey: doc.channelKey,
    kind: doc.kind,
    severity: doc.severity,
    status: doc.status,
    trigger: doc.trigger ?? {},
    openedAt: doc.openedAt,
    analysedAt: doc.analysedAt,
    resolvedAt: doc.resolvedAt,
    reportId: doc.reportId ? String(doc.reportId) : null,
    active: doc.active,
    error: doc.error ?? null,
  };
}

/**
 * Public shape of a report.
 * @param {any} doc
 */
export function toPublicReport(doc) {
  if (!doc) return null;
  const { _id, investigationId, assetId, ...rest } = doc;
  return {
    id: String(_id),
    investigationId: investigationId ? String(investigationId) : null,
    assetId: assetId ? String(assetId) : null,
    ...rest,
  };
}

/** The banner payload: what the twin needs to raise an alert, no evidence body. */
export function toAlert(report, investigation) {
  return {
    reportId: report.id,
    investigationId: report.investigationId,
    assetId: report.assetId,
    machineId: report.machineId,
    severity: report.severity,
    level: report.level,
    headline: report.headline,
    rootCause: report.rootCause,
    targets: report.targets,
    needsBinding: report.needsBinding,
    degraded: report.degraded,
    sensorId: investigation?.sensorId ?? null,
    createdAt: report.createdAt,
  };
}

/**
 * Open an investigation, or return null when the machine already has one.
 *
 * @param {object} params
 * @returns {Promise<ReturnType<typeof toPublicInvestigation>|null>}
 */
export async function openInvestigation({ machineId, assetId = null, sensorId, channelKey, kind, severity, trigger, openedAt }) {
  try {
    const doc = await Investigation.create({
      machineId,
      assetId: assetId && mongoose.Types.ObjectId.isValid(assetId) ? assetId : null,
      sensorId,
      channelKey,
      kind,
      severity,
      trigger,
      openedAt: new Date(openedAt ?? Date.now()),
      status: 'analysing',
      active: true,
    });
    const view = toPublicInvestigation(doc.toObject());
    emitAgentStatus({ investigationId: view.id, machineId, assetId: view.assetId, status: 'analysing', severity, sensorId, kind });
    return view;
  } catch (error) {
    if (error?.code === 11000) return null; // the machine is already being investigated
    throw error;
  }
}

/**
 * Move an investigation to a new status (no-op if unchanged).
 *
 * @param {string} investigationId
 * @param {string} status
 * @param {{error?: string|null}} [extra]
 */
export async function setInvestigationStatus(investigationId, status, extra = {}) {
  const doc = await Investigation.findByIdAndUpdate(
    investigationId,
    { $set: { status, ...(extra.error !== undefined ? { error: extra.error } : {}) } },
    { new: true },
  ).lean();
  if (doc) {
    emitAgentStatus({
      investigationId: String(doc._id), machineId: doc.machineId, assetId: doc.assetId ? String(doc.assetId) : null,
      status, severity: doc.severity, sensorId: doc.sensorId, kind: doc.kind,
    });
  }
  return toPublicInvestigation(doc);
}

/** Raise a warn investigation to alarm while it is still pending. */
export async function escalateInvestigation(investigationId, severity) {
  const doc = await Investigation.findOneAndUpdate(
    { _id: investigationId, severity: 'warn', reportId: null },
    { $set: { severity } },
    { new: true },
  ).lean();
  return toPublicInvestigation(doc);
}

/** Free the machine's active slot: it is healthy again. */
export async function resolveInvestigation(investigationId) {
  const doc = await Investigation.findOneAndUpdate(
    { _id: investigationId, active: true },
    {
      $set: { active: false, resolvedAt: new Date() },
      // keep "reported" visible as history; anything still pending becomes resolved
    },
    { new: true },
  ).lean();
  if (doc && doc.status === 'analysing') {
    await Investigation.updateOne({ _id: doc._id }, { $set: { status: 'resolved' } });
    doc.status = 'resolved';
  }
  if (doc) {
    emitAgentStatus({
      investigationId: String(doc._id), machineId: doc.machineId, assetId: doc.assetId ? String(doc.assetId) : null,
      status: 'resolved', severity: doc.severity, sensorId: doc.sensorId, kind: doc.kind,
    });
  }
  return toPublicInvestigation(doc);
}

export async function getInvestigation(investigationId) {
  if (!mongoose.Types.ObjectId.isValid(investigationId)) return null;
  return toPublicInvestigation(await Investigation.findById(investigationId).lean());
}

/** Active investigations, newest first, optionally for one twin. */
export async function listInvestigations({ assetId = null, activeOnly = true, limit = 20 } = {}) {
  const filter = {};
  if (activeOnly) filter.active = true;
  if (assetId) filter.assetId = assetId;
  const docs = await Investigation.find(filter).sort({ openedAt: -1 }).limit(limit).lean();
  return docs.map(toPublicInvestigation);
}

/** Every active investigation still marked active in the database (restart recovery). */
export async function listActiveInvestigationDocs() {
  return Investigation.find({ active: true }).lean();
}

/**
 * Persist the agent's report, close the investigation and raise the alert.
 *
 * Validation of meshes and citations happens before this call (the MCP tool);
 * this function trusts its input.
 *
 * @param {object} report - Already validated report fields.
 * @returns {Promise<{report: ReturnType<typeof toPublicReport>, alerted: boolean}>}
 */
export async function saveReport(report) {
  let investigation = null;
  if (report.investigationId) {
    investigation = await Investigation.findById(report.investigationId).lean();
    if (!investigation) throw ApiError.notFound(`Investigation ${report.investigationId} not found`);
    if (investigation.reportId) {
      const existing = await DiagnosticReport.findById(investigation.reportId).lean();
      return { report: toPublicReport(existing), alerted: false };
    }
  }
  const doc = await DiagnosticReport.create({
    ...report,
    investigationId: report.investigationId ?? null,
    assetId: report.assetId ?? investigation?.assetId ?? null,
  });
  const view = toPublicReport(doc.toObject());
  if (investigation) {
    await Investigation.updateOne(
      { _id: investigation._id },
      { $set: { status: 'reported', reportId: doc._id, analysedAt: new Date(), error: null } },
    );
    emitAgentStatus({
      investigationId: String(investigation._id), machineId: investigation.machineId,
      assetId: view.assetId, status: 'reported', severity: report.severity, sensorId: investigation.sensorId,
      kind: investigation.kind, reportId: view.id,
    });
  }
  emitAgentAlert(toAlert(view, investigation));
  return { report: view, alerted: true };
}

export async function getReport(reportId) {
  if (!mongoose.Types.ObjectId.isValid(reportId)) return null;
  return toPublicReport(await DiagnosticReport.findById(reportId).lean());
}

/** Like getReport, but a missing report is a 404. */
export async function getReportOrThrow(reportId) {
  const report = await getReport(reportId);
  if (!report) throw ApiError.notFound('Report not found');
  return report;
}

/** Recent reports, newest first. */
export async function listReports({ assetId = null, machineId = null, limit = 20 } = {}) {
  const filter = {};
  if (assetId) filter.assetId = assetId;
  if (machineId) filter.machineId = machineId;
  const docs = await DiagnosticReport.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  return docs.map(toPublicReport);
}

export default {
  openInvestigation,
  setInvestigationStatus,
  escalateInvestigation,
  resolveInvestigation,
  getInvestigation,
  listInvestigations,
  listActiveInvestigationDocs,
  saveReport,
  getReport,
  getReportOrThrow,
  listReports,
  toAlert,
};
