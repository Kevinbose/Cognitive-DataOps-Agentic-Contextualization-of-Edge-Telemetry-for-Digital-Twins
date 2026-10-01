/**
 * @file Device registry — identity, liveness, diagnostics and commands.
 *
 * Holds one in-memory state object per machine. The registry is rebuilt from
 * three sources and needs no device action after a backend restart:
 *
 *   1. `Device` documents (catalog and last diagnostics, shown immediately),
 *   2. the retained `birth` message the broker replays on subscribe,
 *   3. the retained `status` message (`online` or `offline`).
 *
 * ## Liveness is derived, not trusted
 *
 * The broker's retained `status` can be wrong: if the broker itself restarts, a
 * dead board's retained `online` survives. So the public `state` combines the
 * broker status with freshness of actual traffic:
 *
 * | broker status | recent traffic | state     |
 * |---------------|----------------|-----------|
 * | `offline`     | any            | `offline` |
 * | `online`      | yes            | `online`  |
 * | `online`      | no             | `stale`   |
 * | none seen     | yes            | `online`  |
 * | none seen     | no             | `unknown` |
 *
 * "Recent" is `max(5 s, 4 x the device's declared interval)`.
 *
 * ## Ground truth
 *
 * A simulated device reports the fault scenario it is running in `diag.sim`.
 * That value is stored here and served only by {@link getSimTruth}. It is
 * removed from `diag` before the state is stored, broadcast or returned, so the
 * diagnosis agent cannot read the answer to its own test.
 *
 * @module services/device.service
 */

import { randomBytes } from 'node:crypto';

import { config } from '../config/env.config.js';
import { Asset } from '../models/Asset.model.js';
import { Device } from '../models/Device.model.js';
import { SensorBinding } from '../models/SensorBinding.model.js';
import { ApiError } from '../utils/ApiError.js';
import { DOMAIN_EVENT, emitDomainEvent } from '../utils/domainEvents.js';
import { buildTopic, sensorIdFor } from '../utils/mqttTopics.js';
import { syncIsMapped } from './meshNode.service.js';
import { publish } from './mqtt.service.js';
import { emitDeviceAck, emitDeviceUpdate } from './websocket.service.js';

/** Two births from one machine id with different MACs inside this window are a conflict. */
const IDENTITY_CONFLICT_WINDOW_MS = 60_000;
/** A conflict stays visible for this long after it was last seen. */
const IDENTITY_CONFLICT_VISIBLE_MS = 10 * 60_000;
/** A command with no acknowledgement after this long is reported failed. */
const ACK_TIMEOUT_MS = 5000;
/** Lifetime given to a command; the device discards it after this. */
const COMMAND_TTL_MS = 10_000;

/**
 * @typedef {object} ChannelMeta
 * @property {string} key
 * @property {string} sensorId - `MACHINE.KEY`, upper case.
 * @property {string} label
 * @property {string} unit
 * @property {string} sensorType
 * @property {number} min
 * @property {number} max
 * @property {number} decimals
 * @property {import('../utils/channelStatus.js').ChannelLimits} limits
 */

/**
 * @typedef {object} DeviceState
 * @property {string} machineId
 * @property {boolean} announced - True once a `birth` has been seen.
 * @property {string} machineType
 * @property {string} label
 * @property {string|null} fw
 * @property {string|null} mac
 * @property {string|null} bootId
 * @property {number} intervalMs
 * @property {string[]} scenarios
 * @property {Map<string, ChannelMeta>} channels
 * @property {object|null} spectrum
 * @property {'online'|'offline'|null} brokerStatus
 * @property {number|null} lastSeenAt - Any message, epoch ms.
 * @property {number|null} lastTelemetryAt
 * @property {number|null} lastBirthAt
 * @property {number|null} statusOnlineAt
 * @property {number} lastSeq
 * @property {number} received
 * @property {number} lost
 * @property {number} duplicates
 * @property {object|null} diag - Latest diagnostics, WITHOUT `sim`.
 * @property {object|null} simTruth - Simulator ground truth. Never broadcast.
 * @property {{rttMs: number, clockOffsetMs: number, at: number}|null} link
 * @property {{scenario: string, rampSec: number|null, at: number}|null} commanded
 * @property {number|null} identityConflictAt
 * @property {string|null} assetId - Twin this machine was added to, or null.
 * @property {number|null} attachedAt
 * @property {string} publishedState - Last state broadcast, to detect transitions.
 */

/** @type {Map<string, DeviceState>} */
const registry = new Map();

/** @type {string} */
let siteId = config.mqtt.siteId;

/** @type {NodeJS.Timeout|null} */
let tickTimer = null;

/** @type {Map<string, {machineId: string, name: string, args: object, issuedAt: number, timer: NodeJS.Timeout}>} */
const pendingCommands = new Map();
/** @type {Map<string, number>} */
const lastCommandAt = new Map();

/* ─── State helpers ────────────────────────────────────────────────────────── */

/**
 * @param {string} machineId
 * @returns {DeviceState}
 */
function createState(machineId) {
  return {
    machineId,
    announced: false,
    machineType: 'unknown',
    label: machineId,
    fw: null,
    mac: null,
    bootId: null,
    intervalMs: 500,
    scenarios: [],
    channels: new Map(),
    spectrum: null,
    brokerStatus: null,
    lastSeenAt: null,
    lastTelemetryAt: null,
    lastBirthAt: null,
    statusOnlineAt: null,
    lastSeq: -1,
    received: 0,
    lost: 0,
    duplicates: 0,
    diag: null,
    simTruth: null,
    link: null,
    commanded: null,
    identityConflictAt: null,
    assetId: null,
    attachedAt: null,
    publishedState: 'unknown',
  };
}

/**
 * Get the state for a machine, creating a placeholder if it is new.
 *
 * A placeholder exists so traffic that arrives before the `birth` (a retained
 * `status` replayed first, say) has somewhere to land.
 *
 * @param {string} machineId
 * @returns {DeviceState}
 */
export function ensureDeviceState(machineId) {
  let state = registry.get(machineId);
  if (!state) {
    state = createState(machineId);
    registry.set(machineId, state);
  }
  return state;
}

/**
 * @param {string} machineId
 * @returns {DeviceState|undefined}
 */
export function getDeviceState(machineId) {
  return registry.get(machineId);
}

/**
 * Metadata for one channel of one machine.
 *
 * @param {string} machineId
 * @param {string} key - Channel key.
 * @returns {ChannelMeta|undefined} `undefined` until the machine's `birth` declared it.
 */
export function getChannelMeta(machineId, key) {
  return registry.get(machineId)?.channels.get(key);
}

/**
 * How long without traffic before an "online" device is called stale.
 * @param {DeviceState} state
 * @returns {number} Milliseconds.
 */
function freshnessWindowMs(state) {
  return Math.max(5000, 4 * state.intervalMs);
}

/**
 * Derive the public state from broker status and traffic freshness.
 *
 * @param {DeviceState} state
 * @param {number} now - Epoch ms.
 * @returns {'online'|'stale'|'offline'|'unknown'}
 */
export function deriveState(state, now) {
  if (state.brokerStatus === 'offline') return 'offline';

  const lastActivity = Math.max(
    state.lastTelemetryAt ?? 0,
    state.statusOnlineAt ?? 0,
    state.lastBirthAt ?? 0,
  );
  const fresh = lastActivity > 0 && now - lastActivity <= freshnessWindowMs(state);

  if (state.brokerStatus === 'online') return fresh ? 'online' : 'stale';
  return fresh ? 'online' : 'unknown';
}

/**
 * The view of a device that leaves this process. Excludes `simTruth` by
 * construction: it is not copied.
 *
 * @param {DeviceState} state
 * @param {number} [now]
 * @returns {object} Serialisable device description.
 */
export function toPublicDevice(state, now = Date.now()) {
  return {
    machineId: state.machineId,
    announced: state.announced,
    state: deriveState(state, now),
    label: state.label,
    machineType: state.machineType,
    fw: state.fw,
    mac: state.mac,
    bootId: state.bootId,
    intervalMs: state.intervalMs,
    scenarios: state.scenarios,
    lastSeenAt: state.lastSeenAt,
    lastTelemetryAt: state.lastTelemetryAt,
    channels: [...state.channels.values()],
    spectrum: state.spectrum,
    diag: state.diag,
    link: state.link,
    assetId: state.assetId,
    rx: { received: state.received, lost: state.lost, duplicates: state.duplicates },
    identityConflict:
      state.identityConflictAt !== null &&
      now - state.identityConflictAt < IDENTITY_CONFLICT_VISIBLE_MS,
  };
}

/**
 * Broadcast a device, and remember the state that was published.
 * @param {DeviceState} state
 * @returns {void}
 */
function publishDevice(state) {
  const view = toPublicDevice(state);
  state.publishedState = view.state;
  emitDeviceUpdate(view);
}

/**
 * Broadcast only if the derived state changed since the last broadcast.
 * @param {DeviceState} state
 * @param {number} now
 * @returns {void}
 */
function publishIfStateChanged(state, now) {
  if (deriveState(state, now) !== state.publishedState) publishDevice(state);
}

/* ─── Persistence ──────────────────────────────────────────────────────────── */

/**
 * Write a device's slow-changing facts to MongoDB. Failures are logged and
 * swallowed: live state is authoritative and the next event retries.
 *
 * @param {DeviceState} state
 * @returns {Promise<void>}
 */
async function persistDevice(state) {
  if (!state.announced) return;

  try {
    await Device.updateOne(
      { machineId: state.machineId },
      {
        $set: {
          siteId,
          machineType: state.machineType,
          label: state.label,
          fw: state.fw,
          mac: state.mac,
          bootId: state.bootId,
          intervalMs: state.intervalMs,
          scenarios: state.scenarios,
          channels: [...state.channels.values()].map(({ sensorId: _omit, ...channel }) => channel),
          spectrum: state.spectrum,
          brokerStatus: state.brokerStatus,
          lastSeenAt: state.lastSeenAt ? new Date(state.lastSeenAt) : null,
          lastBirthAt: state.lastBirthAt ? new Date(state.lastBirthAt) : null,
          diag: state.diag,
          simTruth: state.simTruth,
        },
      },
      { upsert: true },
    );
  } catch (error) {
    console.error(`[devices] Could not persist ${state.machineId}: ${error.message}`);
  }
}

/**
 * Load known devices from MongoDB so the UI has them before the broker replays
 * anything. Liveness is NOT restored: a stored `online` is stale by definition.
 *
 * @param {object} [options]
 * @param {string} [options.siteId] - Site id used to build command topics.
 * @returns {Promise<number>} Number of devices loaded.
 */
export async function initDeviceRegistry({ siteId: site = config.mqtt.siteId } = {}) {
  siteId = site;

  const docs = await Device.find({ siteId }).select('+simTruth').lean();
  for (const doc of docs) {
    const state = ensureDeviceState(doc.machineId);
    state.announced = true;
    state.machineType = doc.machineType;
    state.label = doc.label;
    state.fw = doc.fw;
    state.mac = doc.mac;
    state.bootId = doc.bootId;
    state.intervalMs = doc.intervalMs;
    state.scenarios = doc.scenarios ?? [];
    state.spectrum = doc.spectrum ?? null;
    state.diag = doc.diag ?? null;
    state.simTruth = doc.simTruth ?? null;
    state.lastSeenAt = doc.lastSeenAt ? doc.lastSeenAt.getTime() : null;
    state.assetId = doc.assetId ? String(doc.assetId) : null;
    state.attachedAt = doc.attachedAt ? doc.attachedAt.getTime() : null;
    state.channels = new Map(
      (doc.channels ?? []).map((channel) => [
        channel.key,
        { ...channel, sensorId: sensorIdFor(doc.machineId, channel.key) },
      ]),
    );
    // brokerStatus stays null on purpose; the retained status will arrive.
    state.publishedState = deriveState(state, Date.now());
  }

  return docs.length;
}

/* ─── Inbound events ───────────────────────────────────────────────────────── */

/**
 * Apply a validated `birth` message.
 *
 * @param {string} machineId - From the topic (already checked against the payload).
 * @param {object} birth - Validated birth payload.
 * @param {{retained: boolean}} [context]
 * @returns {void}
 */
export function applyBirth(machineId, birth, { retained = false } = {}) {
  const now = Date.now();
  const state = ensureDeviceState(machineId);
  const mac = birth.mac.toUpperCase();

  // A retained replay of the birth we already hold changes nothing.
  const isReplay = retained && state.announced && state.bootId === birth.bootId;

  if (
    !isReplay &&
    state.announced &&
    state.mac &&
    state.mac !== mac &&
    state.lastBirthAt !== null &&
    now - state.lastBirthAt < IDENTITY_CONFLICT_WINDOW_MS
  ) {
    state.identityConflictAt = now;
    console.warn(
      `[devices] Identity conflict: "${machineId}" announced by ${state.mac} and ${mac} within ` +
        `${IDENTITY_CONFLICT_WINDOW_MS / 1000} s. Two boards share one machine id.`,
    );
  }

  if (state.bootId !== birth.bootId) {
    // A new boot restarts the device's sequence counter; that is not packet loss.
    state.lastSeq = -1;
  }

  state.announced = true;
  state.machineType = birth.machineType;
  state.label = birth.label;
  state.fw = birth.fw;
  state.mac = mac;
  state.bootId = birth.bootId;
  state.intervalMs = birth.intervalMs;
  state.scenarios = birth.scenarios;
  state.spectrum = birth.spectrum;
  state.channels = new Map(
    birth.channels.map((channel) => [
      channel.key,
      { ...channel, sensorId: sensorIdFor(machineId, channel.key) },
    ]),
  );
  state.lastBirthAt = now;
  state.lastSeenAt = now;

  if (!isReplay) void persistDevice(state);
  publishDevice(state);
}

/**
 * Apply a `status` message (`online` or `offline`).
 *
 * @param {string} machineId
 * @param {'online'|'offline'} brokerStatus
 * @returns {void}
 */
export function applyStatus(machineId, brokerStatus) {
  const now = Date.now();
  const state = ensureDeviceState(machineId);
  const changed = state.brokerStatus !== brokerStatus;

  state.brokerStatus = brokerStatus;
  if (brokerStatus === 'online') {
    state.statusOnlineAt = now;
    state.lastSeenAt = now;
  }

  if (changed) {
    console.log(`[devices] ${machineId} is ${brokerStatus}`);
    void persistDevice(state);
  }
  publishDevice(state);
}

/**
 * Account for one telemetry message: sequence tracking and freshness.
 *
 * @param {string} machineId
 * @param {number} seq - Device-side message counter.
 * @returns {boolean} False when the message is a duplicate and must be dropped.
 */
export function noteTelemetry(machineId, seq) {
  const now = Date.now();
  const state = ensureDeviceState(machineId);

  if (state.lastSeq !== -1) {
    if (seq === state.lastSeq) {
      state.duplicates += 1;
      return false;
    }
    if (seq > state.lastSeq + 1) {
      state.lost += seq - state.lastSeq - 1;
    }
    // seq < lastSeq without a new birth: the board restarted and its birth was
    // missed. Treat it as a restart, not as loss.
  }

  state.lastSeq = seq;
  state.received += 1;
  state.lastTelemetryAt = now;
  state.lastSeenAt = now;

  publishIfStateChanged(state, now);
  return true;
}

/**
 * Mark a device as heard from, without touching telemetry counters.
 * @param {string} machineId
 * @returns {void}
 */
export function noteActivity(machineId) {
  const state = ensureDeviceState(machineId);
  state.lastSeenAt = Date.now();
}

/**
 * Apply a validated `diag` message.
 *
 * `sim` is split off here: it goes to `simTruth`, never into `diag`.
 *
 * @param {string} machineId
 * @param {object} diag - Validated diag payload.
 * @returns {void}
 */
export function applyDiag(machineId, diag) {
  const now = Date.now();
  const state = ensureDeviceState(machineId);
  const { sim, ...publicDiag } = diag;

  state.diag = { ...publicDiag, receivedAt: now };
  state.lastSeenAt = now;

  if (sim) {
    state.simTruth = { ...sim, reportedAt: now };
  }

  void persistDevice(state);
  publishDevice(state);
}

/**
 * Apply a validated `ack`: resolve the pending command and notify browsers.
 *
 * @param {string} machineId
 * @param {{cmdId: string, name: string, ok: boolean, detail: string, ts?: number}} ack
 * @returns {void}
 */
export function applyAck(machineId, ack) {
  const now = Date.now();
  const state = ensureDeviceState(machineId);
  const pending = pendingCommands.get(ack.cmdId);

  let rttMs = null;
  if (pending) {
    clearTimeout(pending.timer);
    pendingCommands.delete(ack.cmdId);
    rttMs = now - pending.issuedAt;

    if (ack.name === 'ping' && typeof ack.ts === 'number') {
      // One-way delay is taken as half the round trip. The estimate is only as
      // good as that symmetry, which is why the UI labels latency "indicative".
      state.link = {
        rttMs,
        clockOffsetMs: Math.round(ack.ts - (pending.issuedAt + rttMs / 2)),
        at: now,
      };
    }

    if (ack.name === 'scenario' && ack.ok) {
      state.commanded = {
        scenario: /** @type {any} */ (pending.args).scenario,
        rampSec: /** @type {any} */ (pending.args).rampSec ?? null,
        at: now,
      };
    }
  }

  emitDeviceAck({
    machineId,
    cmdId: ack.cmdId,
    name: ack.name,
    ok: ack.ok,
    detail: ack.detail,
    rttMs,
    external: !pending,
  });

  if (state.link) publishDevice(state);
}

/* ─── Liveness ticker ──────────────────────────────────────────────────────── */

/**
 * Re-evaluate every device and broadcast the ones whose state changed.
 *
 * Needed because staleness is the ABSENCE of messages: nothing arrives to
 * trigger it, so a timer must notice.
 *
 * @param {number} [now]
 * @returns {void}
 */
export function tickDeviceStates(now = Date.now()) {
  for (const state of registry.values()) {
    publishIfStateChanged(state, now);
  }
}

/**
 * Start the once-per-second liveness check.
 * @param {number} [intervalMs]
 * @returns {void}
 */
export function startDeviceTicker(intervalMs = 1000) {
  if (tickTimer) return;
  tickTimer = setInterval(() => tickDeviceStates(), intervalMs);
  tickTimer.unref();
}

/**
 * Stop the liveness check and cancel pending command timers.
 * @returns {void}
 */
export function stopDeviceTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  for (const pending of pendingCommands.values()) clearTimeout(pending.timer);
  pendingCommands.clear();
}

/* ─── Adding a machine to a twin ───────────────────────────────────────────── */

/** @param {string} text @returns {string} */
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Add a discovered machine to a twin.
 *
 * A gateway announces itself and appears as available; this is the deliberate
 * step that says "this machine belongs to this twin". Until it is taken, the
 * machine's channels are not offered for binding there. A machine belongs to one
 * twin at a time.
 *
 * @param {string} assetId
 * @param {string} machineId
 * @returns {Promise<{device: object, unchanged: boolean}>}
 * @throws {ApiError} 404 unknown asset or a machine that has not announced itself;
 *   409 when it already belongs to another twin.
 */
export async function attachMachine(assetId, machineId) {
  const asset = await Asset.findActiveById(assetId);
  if (!asset) throw ApiError.notFound(`Asset "${assetId}" was not found`);

  const state = registry.get(machineId);
  if (!state?.announced) {
    throw ApiError.notFound(
      `Machine "${machineId}" has not announced itself yet. Power on its gateway, or start the simulator, and try again.`,
    );
  }

  if (state.assetId === String(assetId)) {
    return { device: toPublicDevice(state), unchanged: true };
  }
  if (state.assetId) {
    throw ApiError.conflict(
      `Machine "${machineId}" already belongs to another twin. Remove it there first.`,
    );
  }

  const now = new Date();
  // Write first: if MongoDB refuses, nothing in memory has changed.
  await Device.updateOne(
    { machineId },
    {
      $set: {
        assetId,
        attachedAt: now,
        siteId,
        machineType: state.machineType,
        label: state.label,
      },
    },
    { upsert: true },
  );

  state.assetId = String(assetId);
  state.attachedAt = now.getTime();
  publishDevice(state);
  console.log(`[devices] ${machineId} added to asset ${assetId}`);
  return { device: toPublicDevice(state), unchanged: false };
}

/**
 * Remove a machine from a twin, and retire every binding of its channels there.
 *
 * Retired, not deleted: the rows stay as history, like any unbind.
 *
 * @param {string} assetId
 * @param {string} machineId
 * @returns {Promise<{machineId: string, bindingsRetired: number}>}
 * @throws {ApiError} 404 when the machine is not on this twin.
 */
export async function detachMachine(assetId, machineId) {
  const state = registry.get(machineId);
  if (!state || state.assetId !== String(assetId)) {
    throw ApiError.notFound(`Machine "${machineId}" is not on this twin`);
  }

  const prefix = `${machineId.toUpperCase()}.`;
  const live = await SensorBinding.find({
    assetId,
    isActive: true,
    sensorId: { $regex: `^${escapeRegex(prefix)}` },
  }).select('_id meshNodeId');

  if (live.length > 0) {
    await SensorBinding.updateMany(
      { _id: { $in: live.map((b) => b._id) } },
      { $set: { isActive: false, unboundAt: new Date() } },
    );
    for (const meshNodeId of new Set(live.map((b) => String(b.meshNodeId)))) {
      await syncIsMapped(meshNodeId);
    }
  }

  await Device.updateOne({ machineId }, { $set: { assetId: null, attachedAt: null } });

  state.assetId = null;
  state.attachedAt = null;
  publishDevice(state);

  if (live.length > 0) {
    emitDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, { assetIds: [String(assetId)], reason: 'machine-removed' });
  }
  console.log(`[devices] ${machineId} removed from asset ${assetId} (${live.length} binding(s) retired)`);
  return { machineId, bindingsRetired: live.length };
}

/**
 * Free every machine that belongs to a twin that is being deleted, so the
 * gateways become available to add to another one. Bindings are retired by the
 * caller.
 *
 * @param {string} assetId
 * @returns {Promise<number>} Machines released.
 */
export async function releaseMachinesOfAsset(assetId) {
  await Device.updateMany({ assetId }, { $set: { assetId: null, attachedAt: null } });

  let released = 0;
  for (const state of registry.values()) {
    if (state.assetId !== String(assetId)) continue;
    state.assetId = null;
    state.attachedAt = null;
    publishDevice(state);
    released += 1;
  }
  return released;
}

/**
 * @param {string} assetId
 * @returns {object[]} The machines added to this twin, sorted by machine id.
 */
export function listMachinesForAsset(assetId) {
  return listPublicDevices().filter((device) => device.assetId === String(assetId));
}

/* ─── Reads ────────────────────────────────────────────────────────────────── */

/**
 * @returns {object[]} Every known device, sorted by machine id.
 */
export function listPublicDevices() {
  const now = Date.now();
  return [...registry.values()]
    .sort((a, b) => a.machineId.localeCompare(b.machineId))
    .map((state) => toPublicDevice(state, now));
}

/**
 * Simulator ground truth for one machine.
 *
 * This is the ONLY place `simTruth` leaves the service. It backs the
 * fault-injection panel and the evaluation harness, and must never be mounted
 * under the agent-facing tool API.
 *
 * @param {string} machineId
 * @returns {Promise<{machineId: string, scenario: string|null, ramp: number|null,
 *   rampSec: number|null, reportedAt: number|null, commanded: object|null}>}
 * @throws {ApiError} 404 when the device is unknown.
 */
export async function getSimTruth(machineId) {
  const state = registry.get(machineId);
  if (!state) {
    throw ApiError.notFound(`Device "${machineId}" is not known to this server`);
  }

  let truth = state.simTruth;
  if (!truth) {
    const doc = await Device.findOne({ machineId }).select('+simTruth').lean();
    truth = doc?.simTruth ?? null;
  }

  return {
    machineId,
    scenario: truth?.scenario ?? null,
    ramp: truth?.ramp ?? null,
    rampSec: truth?.rampSec ?? null,
    reportedAt: truth?.reportedAt ?? null,
    commanded: state.commanded,
  };
}

/* ─── Commands ─────────────────────────────────────────────────────────────── */

/**
 * Send a command to a device.
 *
 * Guarded four ways, because a command can reboot a machine: the feature must
 * be switched on, the device must be online, the scenario must be one the
 * device declared, and commands to one device are rate limited.
 *
 * @param {string} machineId
 * @param {{name: string, args: Record<string, any>}} command - Validated body.
 * @returns {Promise<{cmdId: string, machineId: string, name: string, issuedAt: number, ttlMs: number}>}
 * @throws {ApiError} 403 disabled, 404 unknown, 409 not online, 422 bad scenario,
 *   429 rate limited, 503 broker unreachable.
 */
export async function sendCommand(machineId, { name, args }) {
  if (!config.enableDeviceCommands) {
    throw ApiError.forbidden(
      'Device commands are disabled on this server. Set ENABLE_DEVICE_COMMANDS=true to enable them.',
    );
  }

  const state = registry.get(machineId);
  if (!state || !state.announced) {
    throw ApiError.notFound(`Device "${machineId}" has not announced itself yet`);
  }

  const current = deriveState(state, Date.now());
  if (current !== 'online') {
    throw ApiError.conflict(
      `Device "${machineId}" is ${current}. Commands are only sent to online devices.`,
    );
  }

  if (name === 'scenario' && !state.scenarios.includes(args.scenario)) {
    throw ApiError.validation(
      [
        {
          field: 'body.args.scenario',
          message: `Must be one of ${state.scenarios.join(', ') || '(none declared)'}`,
        },
      ],
      `Device "${machineId}" does not support scenario "${args.scenario}"`,
    );
  }

  const now = Date.now();
  const previous = lastCommandAt.get(machineId) ?? 0;
  if (config.commandMinIntervalMs > 0 && now - previous < config.commandMinIntervalMs) {
    throw ApiError.tooManyRequests(
      `Wait ${Math.ceil((config.commandMinIntervalMs - (now - previous)) / 1000)} s before sending ` +
        `another command to "${machineId}".`,
    );
  }
  lastCommandAt.set(machineId, now);

  const cmdId = `c-${randomBytes(4).toString('hex')}`;
  const payload = { cmdId, issuedAt: now, ttlMs: COMMAND_TTL_MS, ...args };

  const timer = setTimeout(() => {
    pendingCommands.delete(cmdId);
    emitDeviceAck({
      machineId,
      cmdId,
      name,
      ok: false,
      detail: 'No acknowledgement within 5 s',
      rttMs: null,
      timedOut: true,
    });
  }, ACK_TIMEOUT_MS);
  timer.unref();
  pendingCommands.set(cmdId, { machineId, name, args, issuedAt: now, timer });

  try {
    await publish(buildTopic(siteId, machineId, `cmd/${name}`), JSON.stringify(payload), { qos: 1 });
  } catch (error) {
    clearTimeout(timer);
    pendingCommands.delete(cmdId);
    throw ApiError.unavailable(`Could not reach the MQTT broker: ${error.message}`);
  }

  return { cmdId, machineId, name, issuedAt: now, ttlMs: COMMAND_TTL_MS };
}

/**
 * Forget every device. Test-only.
 * @returns {void}
 */
export function resetDevicesForTests() {
  stopDeviceTicker();
  registry.clear();
  lastCommandAt.clear();
}

export default {
  initDeviceRegistry,
  ensureDeviceState,
  getDeviceState,
  getChannelMeta,
  deriveState,
  toPublicDevice,
  applyBirth,
  applyStatus,
  noteTelemetry,
  noteActivity,
  applyDiag,
  applyAck,
  tickDeviceStates,
  startDeviceTicker,
  stopDeviceTicker,
  listPublicDevices,
  getSimTruth,
  sendCommand,
  attachMachine,
  detachMachine,
  releaseMachinesOfAsset,
  listMachinesForAsset,
  resetDevicesForTests,
};
