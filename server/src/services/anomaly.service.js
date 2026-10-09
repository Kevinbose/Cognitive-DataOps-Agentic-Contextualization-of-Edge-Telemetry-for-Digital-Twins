/**
 * @file The anomaly detector: deterministic rules that open investigations.
 *
 * No model runs here. Every normalised sample passes through `observe`, which
 * is synchronous and cheap (a ring buffer per channel), and two rules decide
 * whether the machine needs a diagnosis:
 *
 * - **Threshold.** The 10 s window mean is beyond a warn or alarm limit, held
 *   for `holdSec`. This matches the knowledge base's persistence rule ("limit
 *   reached on the 10 s window mean").
 * - **Drift.** The 60 s mean has moved `driftSigma` baseline deviations away
 *   from the channel's own learned baseline, towards its limit, for
 *   `driftHoldSec`, while still inside the limits. This is the case alarms
 *   miss: main-bearing wear raises vibration to about 2.9 mm/s and never
 *   reaches the 4.0 mm/s alarm.
 *
 * One investigation per machine at a time (also enforced by a unique index),
 * a cooldown after it resolves, and escalation from warn to alarm while the
 * report is pending. An investigation resolves after the machine has been
 * healthy for a minute. If the agent is unreachable, the investigation is
 * marked so and the ordinary alarm still shows: nothing is lost.
 *
 * @module services/anomaly.service
 */

import { config } from '../config/env.config.js';
import { evaluateStatus } from '../utils/channelStatus.js';
import { requestInvestigation } from './agentClient.service.js';
import { getChannelMeta, getDeviceState } from './device.service.js';
import {
  escalateInvestigation,
  listActiveInvestigationDocs,
  openInvestigation,
  resolveInvestigation,
  setInvestigationStatus,
} from './investigation.service.js';

const WINDOW_MS = 120_000;
const HEALTHY_TO_RESOLVE_MS = 60_000;
const BASELINE_ALPHA = 0.002;

/**
 * @typedef {object} Track
 * @property {string} machineId
 * @property {string} key
 * @property {string} sensorId
 * @property {Array<{t: number, v: number}>} samples
 * @property {{n: number, mean: number, m2: number, std: number, startedAt: number|null, ready: boolean}} base
 * @property {{threshold: number|null, drift: number|null}} hold
 * @property {{mean10: number|null, mean60: number|null, z: number, status: string, dir: number}} last
 */

/** @type {Map<string, Track>} */
const tracks = new Map();
/** Starts from configuration; tests switch it per suite. */
let enabled = config.anomaly.enabled;
/** @type {Map<string, {activeId: string|null, activeSeverity: string|null, cooldownUntil: number, opening: boolean, healthySince: number|null, resolving: boolean}>} */
const machines = new Map();
const counters = { observed: 0, opened: 0, escalated: 0, resolved: 0, agentUnavailable: 0 };

function machine(machineId) {
  let m = machines.get(machineId);
  if (!m) {
    m = { activeId: null, activeSeverity: null, cooldownUntil: 0, opening: false, pendingAlarm: false, healthySince: null, resolving: false };
    machines.set(machineId, m);
  }
  return m;
}

function track(sample) {
  let tr = tracks.get(sample.sensorId);
  if (!tr) {
    tr = {
      machineId: sample.machineId,
      key: sample.key,
      sensorId: sample.sensorId,
      samples: [],
      base: { n: 0, mean: 0, m2: 0, std: 0, startedAt: null, ready: false },
      hold: { threshold: null, drift: null },
      last: { mean10: null, mean60: null, z: 0, status: 'normal', dir: 0 },
    };
    tracks.set(sample.sensorId, tr);
  }
  return tr;
}

function windowMean(samples, fromT) {
  let sum = 0;
  let n = 0;
  for (let i = samples.length - 1; i >= 0 && samples[i].t >= fromT; i -= 1) {
    sum += samples[i].v;
    n += 1;
  }
  return n ? sum / n : null;
}

/** +1 when the channel's limits are upper limits, -1 for lower, 0 for none. */
function limitDirection(limits) {
  if (!limits) return 0;
  if (limits.warnHigh !== undefined || limits.alarmHigh !== undefined) return 1;
  if (limits.warnLow !== undefined || limits.alarmLow !== undefined) return -1;
  return 0;
}

function limitFor(limits, severity, dir) {
  if (!limits) return { limit: null, limitName: null };
  if (dir >= 0) {
    return severity === 'alarm'
      ? { limit: limits.alarmHigh ?? null, limitName: 'alarmHigh' }
      : { limit: limits.warnHigh ?? null, limitName: 'warnHigh' };
  }
  return severity === 'alarm'
    ? { limit: limits.alarmLow ?? null, limitName: 'alarmLow' }
    : { limit: limits.warnLow ?? null, limitName: 'warnLow' };
}

/**
 * Feed one normalised sample. Synchronous, never throws.
 *
 * @param {{sensorId: string, machineId: string, key: string, value: number, ts: number, unit?: string, decimals?: number}} sample
 */
export function observe(sample) {
  if (!enabled) return;
  try {
    observeUnsafe(sample);
  } catch (error) {
    console.error(`[anomaly] ${sample?.sensorId}: ${error.message}`);
  }
}

function observeUnsafe(sample) {
  counters.observed += 1;
  const t = Number(sample.ts) || Date.now();
  const v = Number(sample.value);
  if (!Number.isFinite(v)) return;

  const tr = track(sample);
  tr.samples.push({ t, v });
  while (tr.samples.length && tr.samples[0].t < t - WINDOW_MS) tr.samples.shift();

  const meta = getChannelMeta(sample.machineId, sample.key);
  const limits = meta?.limits;
  const dir = limitDirection(limits);
  const m = machine(sample.machineId);

  const mean10 = windowMean(tr.samples, t - 10_000);
  const mean60 = windowMean(tr.samples, t - 60_000);
  const span = tr.samples.length ? t - tr.samples[0].t : 0;
  const status10 = mean10 === null ? 'normal' : evaluateStatus(mean10, limits);

  // ---- baseline: learned at first, then followed slowly while healthy
  const b = tr.base;
  if (b.startedAt === null) b.startedAt = t;
  const decimals = Number.isInteger(meta?.decimals) ? meta.decimals : 2;
  const floor = Math.max(10 ** -decimals, Math.abs(b.mean) * 0.002, 1e-6);
  const std = Math.max(b.std, floor);
  const z = b.ready && mean60 !== null ? (mean60 - b.mean) / std : 0;

  if (!b.ready) {
    b.n += 1;
    const delta = v - b.mean;
    b.mean += delta / b.n;
    b.m2 += delta * (v - b.mean);
    b.std = b.n > 1 ? Math.sqrt(b.m2 / (b.n - 1)) : 0;
    if (t - b.startedAt >= config.anomaly.baselineSec * 1000 && b.n >= 20) b.ready = true;
  } else if (!m.activeId && status10 === 'normal' && Math.abs(z) < 3 && mean10 !== null && Math.abs(mean10 - b.mean) < 3 * std) {
    // follow slow, healthy change only: a step the 10 s mean already shows is not baseline
    const delta = v - b.mean;
    b.mean += BASELINE_ALPHA * delta;
    const variance = (1 - BASELINE_ALPHA) * (b.std ** 2 + BASELINE_ALPHA * delta * delta);
    b.std = Math.sqrt(variance);
  }

  tr.last = { mean10, mean60, z, status: status10, dir };

  // ---- threshold rule
  if (status10 !== 'normal') {
    tr.hold.threshold ??= t;
    if (t - tr.hold.threshold >= config.anomaly.holdSec * 1000) {
      trigger(tr, 'threshold', status10 === 'alarm' ? 'alarm' : 'warn', { v, mean10, mean60, limits, dir, unit: sample.unit, t });
    }
  } else {
    tr.hold.threshold = null;
  }

  // ---- drift rule: inside the limits, but walking towards one
  if (b.ready && dir !== 0 && status10 === 'normal' && span >= 30_000 && dir * z >= config.anomaly.driftSigma) {
    tr.hold.drift ??= t;
    if (t - tr.hold.drift >= config.anomaly.driftHoldSec * 1000) {
      trigger(tr, 'drift', 'warn', { v, mean10, mean60, limits, dir, unit: sample.unit, t });
    }
  } else {
    tr.hold.drift = null;
  }

  updateHealth(sample.machineId, t);
}

function trigger(tr, kind, severity, ctx) {
  const m = machine(tr.machineId);
  if (m.activeId) {
    if (severity === 'alarm' && m.activeSeverity === 'warn') {
      m.activeSeverity = 'alarm';
      counters.escalated += 1;
      void escalateInvestigation(m.activeId, 'alarm').catch((error) =>
        console.error(`[anomaly] escalate failed: ${error.message}`));
    }
    return;
  }
  if (m.opening) {
    // the investigation is being written: remember an alarm and apply it after
    if (severity === 'alarm') m.pendingAlarm = true;
    return;
  }
  if (ctx.t < m.cooldownUntil) return;

  m.opening = true;
  m.pendingAlarm = false;
  const { limit, limitName } = limitFor(ctx.limits, severity, ctx.dir);
  const params = {
    machineId: tr.machineId,
    assetId: getDeviceState(tr.machineId)?.assetId ?? null,
    sensorId: tr.sensorId,
    channelKey: tr.key,
    kind,
    severity,
    openedAt: ctx.t,
    trigger: {
      value: round(ctx.v),
      mean10: round(ctx.mean10),
      mean60: round(ctx.mean60),
      baseline: round(tr.base.mean),
      baselineStd: round(tr.base.std),
      limit,
      limitName,
      unit: ctx.unit ?? '',
    },
  };
  void openAndHandOff(m, params);
}

async function openAndHandOff(m, params) {
  try {
    const inv = await openInvestigation(params);
    if (!inv) {
      await adoptActive(params.machineId);
      return;
    }
    counters.opened += 1;
    m.activeId = inv.id;
    m.activeSeverity = inv.severity;
    m.healthySince = null;
    if (m.pendingAlarm && inv.severity === 'warn') {
      m.activeSeverity = 'alarm';
      counters.escalated += 1;
      await escalateInvestigation(inv.id, 'alarm');
    }
    m.pendingAlarm = false;
    console.log(`[anomaly] ${inv.machineId}: ${inv.kind} on ${inv.channelKey} (${inv.severity}), investigation ${inv.id}`);
    const result = await requestInvestigation(inv);
    if (!result.accepted) {
      counters.agentUnavailable += 1;
      await setInvestigationStatus(inv.id, 'agent_unavailable', { error: result.error ?? 'agent unavailable' });
    }
  } catch (error) {
    console.error(`[anomaly] could not open an investigation: ${error.message}`);
  } finally {
    m.opening = false;
  }
}

async function adoptActive(machineId) {
  const docs = await listActiveInvestigationDocs();
  const doc = docs.find((d) => d.machineId === machineId);
  if (doc) {
    const m = machine(machineId);
    m.activeId = String(doc._id);
    m.activeSeverity = doc.severity;
  }
}

function updateHealth(machineId, t) {
  const m = machine(machineId);
  if (!m.activeId || m.resolving) return;
  let healthy = true;
  for (const tr of tracks.values()) {
    if (tr.machineId !== machineId) continue;
    if (tr.last.status !== 'normal' || Math.abs(tr.last.z) >= 3) {
      healthy = false;
      break;
    }
  }
  if (!healthy) {
    m.healthySince = null;
    return;
  }
  m.healthySince ??= t;
  if (t - m.healthySince < HEALTHY_TO_RESOLVE_MS) return;

  m.resolving = true;
  const id = m.activeId;
  void resolveInvestigation(id)
    .then(() => {
      counters.resolved += 1;
      m.activeId = null;
      m.activeSeverity = null;
      m.healthySince = null;
      m.cooldownUntil = t + config.anomaly.cooldownSec * 1000;
      for (const tr of tracks.values()) {
        if (tr.machineId === machineId) tr.hold = { threshold: null, drift: null };
      }
    })
    .catch((error) => console.error(`[anomaly] resolve failed: ${error.message}`))
    .finally(() => {
      m.resolving = false;
    });
}

function round(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

/**
 * Restore which machines are busy after a restart.
 *
 * @returns {Promise<void>}
 */
export async function initAnomalyDetector() {
  if (!enabled) return;
  try {
    for (const doc of await listActiveInvestigationDocs()) {
      const m = machine(doc.machineId);
      m.activeId = String(doc._id);
      m.activeSeverity = doc.severity;
    }
  } catch (error) {
    console.error(`[anomaly] could not restore active investigations: ${error.message}`);
  }
}

/**
 * The detector's view of one channel: window means, baseline, z-score.
 * Read by the MCP tool `get_channel_features`.
 *
 * @param {string} sensorId
 */
export function getChannelFeatures(sensorId) {
  const tr = tracks.get(sensorId);
  if (!tr) return null;
  return {
    sensorId,
    machineId: tr.machineId,
    channelKey: tr.key,
    mean10: round(tr.last.mean10),
    mean60: round(tr.last.mean60),
    status10: tr.last.status,
    baseline: tr.base.ready ? { mean: round(tr.base.mean), std: round(tr.base.std) } : null,
    z60: round(tr.last.z),
    samplesInWindow: tr.samples.length,
  };
}

/**
 * The raw samples the detector holds for one channel (up to two minutes),
 * oldest first, or null when it has not seen the channel.
 *
 * @param {string} sensorId
 * @param {number} seconds
 * @returns {Array<{t: number, v: number}>|null}
 */
export function getRawWindow(sensorId, seconds) {
  const tr = tracks.get(sensorId);
  if (!tr || !tr.samples.length) return null;
  const from = tr.samples[tr.samples.length - 1].t - seconds * 1000;
  return tr.samples.filter((s) => s.t > from).map((s) => ({ t: s.t, v: s.v }));
}

export function getAnomalyStats() {
  return {
    enabled,
    channels: tracks.size,
    baselinesReady: [...tracks.values()].filter((tr) => tr.base.ready).length,
    activeMachines: [...machines.entries()].filter(([, m]) => m.activeId).map(([id]) => id),
    ...counters,
  };
}

export function setAnomalyEnabledForTests(value) {
  enabled = Boolean(value);
}

export function resetAnomalyForTests() {
  tracks.clear();
  machines.clear();
  for (const k of Object.keys(counters)) counters[k] = 0;
}

export default { observe, initAnomalyDetector, getChannelFeatures, getAnomalyStats, resetAnomalyForTests };
