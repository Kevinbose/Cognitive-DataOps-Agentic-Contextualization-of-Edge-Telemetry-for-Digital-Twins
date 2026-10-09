/**
 * @file The MCP tool catalogue the diagnosis agent may call.
 *
 * Every tool reads through an existing service; none adds business logic.
 * The agent can read, explain and point. It cannot act on a machine: there is
 * no tool for device commands, for the simulator's ground truth, or for
 * changing a binding, and a test asserts the list stays that way. Results are
 * small JSON documents with hard caps, because a model reads them, and any
 * `sim` field is stripped before a result leaves (defence in depth: the
 * services already keep it out).
 *
 * @module mcp/tools
 */

import { z } from 'zod';

import { MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';
import { listAssets } from '../services/asset.service.js';
import { getChannelFeatures, getRawWindow } from '../services/anomaly.service.js';
import { getChannelMeta, getDeviceState, listMachinesForAsset, listPublicDevices } from '../services/device.service.js';
import { getGlbIndex, hasMesh } from '../services/glbIndex.service.js';
import {
  getInvestigation,
  getReport,
  listInvestigations,
  listReports,
  saveReport,
  setInvestigationStatus,
} from '../services/investigation.service.js';
import { listBindingsForAsset } from '../services/sensorBinding.service.js';
import { getLatestSamples, getLatestSpectrumFrame } from '../services/telemetry.service.js';
import { findRawReadings, findRecentSpectra, queryHistory } from '../services/telemetryStore.service.js';
import { emitUiCommand, SESSION_ID_PATTERN } from '../services/websocket.service.js';

const assetId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'a 24-character asset id');
const machineId = z.string().regex(MACHINE_ID_PATTERN, 'a machine id such as press-stamp-01');
const sensorId = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,48}\.[A-Za-z][A-Za-z0-9_]{0,63}$/, 'a sensor id such as PRESS-STAMP-01.LUBE_OIL_PRESSURE')
  .transform((s) => s.toUpperCase());
const meshName = z.string().min(1).max(512);

/** Remove ground-truth fields wherever they appear. */
export function stripSim(value) {
  if (Array.isArray(value)) return value.map(stripSim);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'sim' || k === 'simTruth') continue;
      out[k] = stripSim(v);
    }
    return out;
  }
  return value;
}

function round(x, d = 3) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null;
}

function channelView(c) {
  return {
    key: c.key,
    sensorId: c.sensorId,
    label: c.label,
    unit: c.unit,
    sensorType: c.sensorType,
    decimals: c.decimals,
    min: c.min,
    max: c.max,
    limits: c.limits ?? {},
  };
}

async function bindingRows(asset) {
  const rows = await listBindingsForAsset(asset);
  return rows.map((b) => ({
    sensorId: b.sensorId,
    sensorType: b.sensorType,
    meshName: b.meshNodeId?.meshName ?? null,
    displayName: b.meshNodeId?.displayName ?? null,
    machineId: String(b.sensorId).split('.')[0].toLowerCase(),
  }));
}

function summarise(rows, unit) {
  const points = rows.filter((r) => Number.isFinite(r.avg));
  if (!points.length) return { n: 0, unit };
  const n = points.reduce((s, r) => s + (r.n ?? 1), 0);
  const mean = points.reduce((s, r) => s + r.avg * (r.n ?? 1), 0) / n;
  const std = Math.sqrt(points.reduce((s, r) => s + (r.avg - mean) ** 2, 0) / points.length);
  const t0 = new Date(points[0].ts).getTime();
  const xs = points.map((r) => (new Date(r.ts).getTime() - t0) / 60_000);
  const xm = xs.reduce((a, b) => a + b, 0) / xs.length;
  const ym = points.reduce((s, r) => s + r.avg, 0) / points.length;
  let num = 0;
  let den = 0;
  points.forEach((r, i) => {
    num += (xs[i] - xm) * (r.avg - ym);
    den += (xs[i] - xm) ** 2;
  });
  return {
    n,
    unit,
    mean: round(mean),
    std: round(std),
    min: round(Math.min(...points.map((r) => r.min))),
    max: round(Math.max(...points.map((r) => r.max))),
    first: round(points[0].avg),
    last: round(points[points.length - 1].avg),
    slopePerMin: den > 0 ? round(num / den, 4) : 0,
  };
}

const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'me', 'show', 'where', 'is', 'which', 'what', 'part', 'and', 'for', 'this', 'that', 'its', 'it']);

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !STOP.has(t));
}

const commandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('highlight'),
    meshName,
    tone: z.enum(['agent', 'warn', 'alarm']).optional(),
    pulse: z.boolean().optional(),
    label: z.string().max(80).optional(),
    durationMs: z.number().int().min(1000).max(60_000).optional(),
  }).strict(),
  z.object({ type: z.literal('camera_focus'), meshName }).strict(),
  z.object({ type: z.literal('select_mesh'), meshName }).strict(),
  z.object({ type: z.literal('clear_highlights') }).strict(),
  z.object({ type: z.literal('open_report'), reportId: z.string().regex(/^[0-9a-fA-F]{24}$/) }).strict(),
]);

const causeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  faultCode: z.string().max(16).nullish(),
});

/**
 * @typedef {object} ToolDef
 * @property {string} name
 * @property {string} title
 * @property {string} description
 * @property {Record<string, import('zod').ZodTypeAny>} input
 * @property {(args: any) => Promise<any>} handler
 */

/** @type {ToolDef[]} */
export const TOOLS = [
  {
    name: 'list_twins',
    title: 'List digital twins',
    description:
      'Every digital twin (asset) in the plant with the machines added to it and how many investigations are open. Use it to answer plant-wide questions or to find a twin id.',
    input: {},
    async handler() {
      const { items } = await listAssets({ limit: 50 });
      const open = await listInvestigations({ activeOnly: true, limit: 100 });
      return items.map((a) => ({
        assetId: String(a._id),
        name: a.name,
        status: a.status,
        hasModel: Boolean(a.convertedFile),
        machines: listMachinesForAsset(String(a._id)).map((d) => ({ machineId: d.machineId, label: d.label, state: d.state })),
        openInvestigations: open.filter((i) => i.assetId === String(a._id)).length,
      }));
    },
  },
  {
    name: 'get_device_catalog',
    title: 'Machine catalogue',
    description:
      'Machines (edge gateways) with their channels, units, limits (warnHigh, alarmHigh, warnLow, alarmLow), spectrum layout including fundamentalHz, live state and the twin they belong to.',
    input: { machineId: machineId.optional() },
    async handler({ machineId: id }) {
      return listPublicDevices()
        .filter((d) => d.announced && (!id || d.machineId === id))
        .map((d) => ({
          machineId: d.machineId,
          label: d.label,
          machineType: d.machineType,
          state: d.state,
          assetId: d.assetId,
          lastTelemetryAt: d.lastTelemetryAt,
          intervalMs: d.intervalMs,
          channels: d.channels.map(channelView),
          spectrum: d.spectrum ?? null,
        }));
    },
  },
  {
    name: 'get_latest_telemetry',
    title: 'Latest readings',
    description: 'The newest reading of each channel, with its status (normal, warn, alarm), age in ms and the mesh it is bound to, if any.',
    input: { machineId: machineId.optional(), sensorIds: z.array(sensorId).max(20).optional() },
    async handler({ machineId: id, sensorIds }) {
      const now = Date.now();
      const wanted = sensorIds?.length ? new Set(sensorIds) : null;
      return getLatestSamples(id)
        .filter((s) => !wanted || wanted.has(s.sensorId))
        .map((s) => ({
          sensorId: s.sensorId,
          machineId: s.machineId,
          channelKey: s.key,
          value: s.value,
          unit: s.unit,
          status: s.status,
          ageMs: now - s.ts,
          meshName: s.meshName ?? null,
          assetId: s.assetId ?? null,
        }));
    },
  },
  {
    name: 'get_historical_telemetry',
    title: 'Channel history',
    description:
      'Bucketed history (min, avg, max per bucket) of one channel over the last N minutes, plus a summary: mean, std, min, max, first, last and slope per minute.',
    input: {
      sensorId,
      minutes: z.number().int().min(1).max(1440).default(10),
      maxPoints: z.number().int().min(10).max(600).default(120),
    },
    async handler({ sensorId: id, minutes, maxPoints }) {
      const to = new Date();
      const from = new Date(to.getTime() - minutes * 60_000);
      const bucketSec = Math.max(1, Math.ceil((minutes * 60) / maxPoints));
      const rows = await queryHistory({ sensorId: id, from, to, bucketSec, maxPoints });
      const [mid, key] = id.toLowerCase().split('.');
      const unit = getChannelMeta(mid, key.toUpperCase())?.unit ?? '';
      return {
        sensorId: id,
        minutes,
        bucketSec,
        buckets: rows.map((r) => ({ t: r.ts, min: round(r.min), avg: round(r.avg), max: round(r.max) })),
        summary: summarise(rows, unit),
      };
    },
  },
  {
    name: 'get_raw_window',
    title: 'Raw samples',
    description:
      'Every sample of one channel over the last N seconds (10 to 120), oldest first, as [ms since window start, value] pairs. Use it for cycle-locked features that bucketing would average away.',
    input: { sensorId, seconds: z.number().int().min(10).max(120).default(60) },
    async handler({ sensorId: id, seconds }) {
      let samples = getRawWindow(id, seconds);
      let source = 'detector';
      if (!samples?.length) {
        const to = new Date();
        samples = await findRawReadings({ sensorId: id, from: new Date(to.getTime() - seconds * 1000), to, limit: seconds * 4 });
        source = 'store';
      }
      const t0 = samples[0]?.t ?? Date.now();
      return {
        sensorId: id,
        seconds,
        source,
        startedAt: new Date(t0).toISOString(),
        samples: samples.map((s) => [s.t - t0, round(s.v, 4)]),
      };
    },
  },
  {
    name: 'get_channel_features',
    title: 'Detector features',
    description:
      "The anomaly detector's live view of one channel: 10 s and 60 s means, the learned baseline (mean, std), the 60 s z-score against it, and the channel's limits.",
    input: { sensorId },
    async handler({ sensorId: id }) {
      const f = getChannelFeatures(id);
      const [mid, key] = id.toLowerCase().split('.');
      const meta = getChannelMeta(mid, key.toUpperCase());
      return { ...(f ?? { sensorId: id, note: 'no samples seen yet' }), unit: meta?.unit ?? null, limits: meta?.limits ?? {} };
    },
  },
  {
    name: 'get_spectrum',
    title: 'Vibration spectrum',
    description: 'The newest spectrum frames of a machine (amplitude per bin) with the layout: startHz, stepHz, count, fundamentalHz.',
    input: { machineId, frames: z.number().int().min(1).max(5).default(1) },
    async handler({ machineId: id, frames }) {
      const layout = getDeviceState(id)?.spectrum ?? null;
      let list = [];
      if (frames === 1) {
        const f = getLatestSpectrumFrame(id);
        if (f) list = [{ ts: new Date(f.ts), amp: f.amp }];
      }
      if (!list.length) list = (await findRecentSpectra(id, frames)).map((f) => ({ ts: f.ts, amp: f.amp }));
      return { machineId: id, layout, frames: list.map((f) => ({ ts: f.ts, amp: f.amp.map((a) => round(a, 4)) })) };
    },
  },
  {
    name: 'get_mesh_bindings',
    title: 'Sensor to mesh bindings',
    description: 'Active bindings of a twin: which sensor drives which mesh. Filter by sensorId or meshName.',
    input: { assetId, sensorId: sensorId.optional(), meshName: meshName.optional() },
    async handler({ assetId: id, sensorId: sid, meshName: mn }) {
      return (await bindingRows(id)).filter((b) => (!sid || b.sensorId === sid) && (!mn || b.meshName === mn));
    },
  },
  {
    name: 'get_mesh_context',
    title: 'What is this part',
    description:
      'Everything about one mesh of a twin: whether it exists, its label, the sensor bound to it (or the channel suggested for it), the machine, the latest reading, the limits and the detector features. Use it for "what is this" and "how is this running".',
    input: { assetId, meshName },
    async handler({ assetId: id, meshName: name }) {
      const index = await getGlbIndex(id);
      const node = index?.nodes.find((n) => n.meshName === name) ?? null;
      const binding = (await bindingRows(id)).find((b) => b.meshName === name) ?? null;
      const out = {
        meshName: name,
        exists: index ? hasMesh(index, name) : null,
        label: node?.label ?? binding?.displayName ?? null,
        zone: node?.zone ?? null,
        tags: node?.tags ?? [],
        bound: Boolean(binding),
        suggestedChannel: node?.suggestedChannel ?? null,
      };
      const sid = binding?.sensorId ?? null;
      const mid = binding?.machineId ?? node?.machineId ?? null;
      if (mid) {
        const d = getDeviceState(mid);
        out.machine = d ? { machineId: mid, label: d.label, onThisTwin: d.assetId === id } : { machineId: mid };
      }
      if (sid) {
        out.binding = binding;
        const s = getLatestSamples(binding.machineId).find((x) => x.sensorId === sid);
        if (s) out.latest = { value: s.value, unit: s.unit, status: s.status, ageMs: Date.now() - s.ts };
        out.features = getChannelFeatures(sid);
        const [m, key] = sid.toLowerCase().split('.');
        out.limits = getChannelMeta(m, key.toUpperCase())?.limits ?? {};
      }
      return out;
    },
  },
  {
    name: 'find_meshes',
    title: 'Find parts by name',
    description:
      'Search a twin for parts by words, for example "lubrication unit" or "weld gun". Matches mesh names, labels, tags and bound sensor names. Returns real mesh names only.',
    input: { assetId, query: z.string().min(1).max(120), limit: z.number().int().min(1).max(10).default(6) },
    async handler({ assetId: id, query, limit }) {
      const index = await getGlbIndex(id);
      const bindings = await bindingRows(id);
      const byName = new Map();
      for (const n of index?.nodes ?? []) {
        byName.set(n.meshName, { meshName: n.meshName, label: n.label, tags: n.tags, machineId: n.machineId, sensorId: null });
      }
      for (const b of bindings) {
        if (!b.meshName) continue;
        const prev = byName.get(b.meshName) ?? { meshName: b.meshName, label: null, tags: [], machineId: b.machineId };
        byName.set(b.meshName, { ...prev, label: prev.label ?? b.displayName, sensorId: b.sensorId });
      }
      const q = tokens(query);
      const exact = String(query).trim().toUpperCase();
      const scored = [];
      for (const item of byName.values()) {
        if (item.meshName === exact) {
          scored.push({ item, score: 100 });
          continue;
        }
        const hay = new Set(tokens(`${item.meshName.replace(/_/g, ' ')} ${item.label ?? ''} ${(item.tags ?? []).join(' ')} ${item.sensorId ?? ''}`));
        let score = 0;
        for (const t of q) {
          if (hay.has(t)) score += 2;
          else if ([...hay].some((h) => h.startsWith(t) || t.startsWith(h))) score += 1;
        }
        if (score > 0) {
          if (item.sensorId) score += 0.5;
          if (item.label) score += 0.25;
          scored.push({ item, score });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.item.meshName.localeCompare(b.item.meshName));
      return scored.slice(0, limit).map(({ item, score }) => ({ ...item, score }));
    },
  },
  {
    name: 'get_active_anomalies',
    title: 'Open investigations',
    description: 'Investigations the anomaly detector has open, newest first, with severity, trigger values and the report id when there is one.',
    input: { assetId: assetId.optional() },
    async handler({ assetId: id }) {
      return listInvestigations({ assetId: id ?? null, activeOnly: true, limit: 20 });
    },
  },
  {
    name: 'list_reports',
    title: 'Recent diagnostic reports',
    description: 'The newest diagnostic reports (headline, root cause, severity, time), optionally for one twin or machine.',
    input: { assetId: assetId.optional(), machineId: machineId.optional(), limit: z.number().int().min(1).max(10).default(5) },
    async handler({ assetId: id, machineId: mid, limit }) {
      const reports = await listReports({ assetId: id ?? null, machineId: mid ?? null, limit });
      return reports.map((r) => ({
        reportId: r.id,
        machineId: r.machineId,
        assetId: r.assetId,
        severity: r.severity,
        level: r.level,
        headline: r.headline,
        rootCause: r.rootCause,
        createdAt: r.createdAt,
      }));
    },
  },
  {
    name: 'get_diagnostic_report',
    title: 'One diagnostic report',
    description: 'A stored diagnostic report in full: root cause, alternatives, evidence table, actions, citations and target meshes.',
    input: { reportId: z.string().regex(/^[0-9a-fA-F]{24}$/) },
    async handler({ reportId }) {
      const r = await getReport(reportId);
      if (!r) throw new Error(`report ${reportId} not found`);
      return r;
    },
  },
  {
    name: 'emit_ui_command',
    title: 'Point at the twin',
    description:
      'Highlight, focus the camera on, or select parts in the 3D twin, clear highlights, or open a report. Mesh names are checked against the twin; unknown names are rejected and reported back.',
    input: {
      assetId,
      sessionId: z.string().regex(SESSION_ID_PATTERN).optional(),
      commands: z.array(commandSchema).min(1).max(6),
    },
    async handler({ assetId: id, sessionId, commands }) {
      const index = await getGlbIndex(id);
      const accepted = [];
      const rejected = [];
      commands.forEach((c, i) => {
        if ('meshName' in c && !(index && hasMesh(index, c.meshName))) {
          rejected.push({ index: i, reason: `mesh "${c.meshName}" is not in this twin` });
          return;
        }
        accepted.push(c);
      });
      if (accepted.length) emitUiCommand({ assetId: id, sessionId: sessionId ?? null, commands: accepted });
      return { accepted, rejected };
    },
  },
  {
    name: 'post_diagnostic_report',
    title: 'Publish a diagnostic report',
    description:
      'Persist a finished diagnosis and raise the alert on the twin. Target meshes are checked against the twin; unknown ones are dropped and the report is marked for review.',
    input: {
      investigationId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
      assetId: assetId.optional(),
      machineId,
      severity: z.enum(['warn', 'alarm']),
      level: z.enum(['normal', 'watch', 'warning', 'alarm', 'critical']).default('warning'),
      headline: z.string().min(1).max(160),
      summary: z.string().max(2000).default(''),
      rootCause: causeSchema,
      alternatives: z.array(causeSchema).max(5).default([]),
      evidence: z
        .array(z.object({
          test: z.string().min(1).max(200),
          channel: z.string().max(64).nullish(),
          observed: z.string().min(1).max(80),
          expected: z.string().min(1).max(120),
          verdict: z.enum(['supports', 'contradicts', 'neutral']),
        }))
        .max(20)
        .default([]),
      actions: z.array(z.object({ step: z.string().min(1).max(400), caveat: z.string().max(300).nullish() })).max(10).default([]),
      citations: z
        .array(z.object({
          chunkId: z.string().min(1).max(120),
          ref: z.string().max(8).nullish(),
          document: z.string().min(1).max(200),
          section: z.string().max(300).nullish(),
          page: z.number().int().nullish(),
          filename: z.string().max(200).nullish(),
        }))
        .max(12)
        .default([]),
      targets: z
        .array(z.object({ meshName, label: z.string().max(120).nullish(), tag: z.string().max(64).nullish(), sensorId: z.string().max(128).nullish() }))
        .max(6)
        .default([]),
      needsBinding: z.array(z.string().max(128)).max(10).default([]),
      degraded: z.boolean().default(false),
      needsReview: z.boolean().default(false),
      generatedBy: z.enum(['agent', 'template']).default('agent'),
      model: z.string().max(80).nullish(),
    },
    async handler(args) {
      const inv = args.investigationId ? await getInvestigation(args.investigationId) : null;
      if (args.investigationId && !inv) throw new Error(`investigation ${args.investigationId} not found`);
      const asset = args.assetId ?? inv?.assetId ?? null;
      const index = asset ? await getGlbIndex(asset) : null;
      const kept = [];
      const dropped = [];
      for (const t of args.targets) {
        if (index && hasMesh(index, t.meshName)) kept.push(t);
        else dropped.push(t.meshName);
      }
      const { report, alerted } = await saveReport({
        ...args,
        assetId: asset,
        targets: kept,
        needsReview: args.needsReview || dropped.length > 0,
      });
      return { reportId: report.id, alerted, droppedTargets: dropped };
    },
  },
  {
    name: 'report_investigation_failure',
    title: 'Give up on an investigation',
    description: 'Mark an investigation as failed when no report could be produced, with a short reason. The twin keeps showing the plain alarm.',
    input: { investigationId: z.string().regex(/^[0-9a-fA-F]{24}$/), reason: z.string().min(1).max(300) },
    async handler({ investigationId, reason }) {
      const inv = await setInvestigationStatus(investigationId, 'failed', { error: reason });
      if (!inv) throw new Error(`investigation ${investigationId} not found`);
      return { investigationId, status: inv.status };
    },
  },
];

export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

export default TOOLS;
