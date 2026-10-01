/**
 * @file In-memory index from sensor id to the mesh it drives.
 *
 * Every incoming telemetry sample needs "which mesh does this sensor drive?".
 * Answering that with a database query per sample would put a read on the hot
 * path at several hundred per minute, so the active bindings are held in a Map
 * and swapped atomically when they change.
 *
 * ## Keeping the copy honest
 *
 * A cache is only acceptable if it cannot stay wrong. Three mechanisms:
 *
 *   1. **Event-driven reload.** Every site that changes a binding emits
 *      `binding:changed` after its write commits; this module reloads on it.
 *   2. **Single-flight.** A reload that is already running is not started a
 *      second time. If another request arrives meanwhile, it sets a dirty flag
 *      and one more reload runs afterwards, so the last change is never missed
 *      and reloads never overlap.
 *   3. **Periodic reload (30 s).** Covers a second backend instance that never
 *      sees this process's in-memory events, and any path that forgot to emit.
 *
 * The map is replaced in one assignment, so a reader never sees a half-built
 * index.
 *
 * @module services/bindingIndex.service
 */

import { SensorBinding } from '../models/SensorBinding.model.js';
import { DOMAIN_EVENT, onDomainEvent } from '../utils/domainEvents.js';

/**
 * What the index knows about one bound sensor.
 *
 * @typedef {object} BoundMesh
 * @property {string} assetId
 * @property {string} meshNodeId
 * @property {string} meshName - Raw glTF node name.
 * @property {string|null} displayName
 */

/** @type {Map<string, BoundMesh>} */
let index = new Map();

/** Incremented per reload started; a result is installed only if still newest. */
let generation = 0;
/** @type {Promise<void>|null} */
let inflight = null;
let dirty = false;

let loadedAt = /** @type {number|null} */ (null);
let loadCount = 0;
let lastError = /** @type {string|null} */ (null);

/** @type {NodeJS.Timeout|null} */
let periodicTimer = null;
/** @type {(() => void)|null} */
let unsubscribe = null;

/**
 * Read the active bindings and build a fresh Map.
 *
 * Bindings whose mesh node was soft-deleted are skipped: the cascade retires
 * them, but a row mid-cascade must not route samples to a deleted mesh.
 *
 * @returns {Promise<Map<string, BoundMesh>>}
 */
async function loadSnapshot() {
  const rows = await SensorBinding.find({ isActive: true })
    .populate({ path: 'meshNodeId', select: 'meshName displayName assetId isDeleted' })
    .lean();

  /** @type {Map<string, BoundMesh>} */
  const next = new Map();

  for (const row of rows) {
    const node = /** @type {any} */ (row.meshNodeId);
    if (!node || node.isDeleted) continue;

    next.set(row.sensorId, {
      assetId: String(row.assetId),
      meshNodeId: String(node._id),
      meshName: node.meshName,
      displayName: node.displayName ?? null,
    });
  }

  return next;
}

/**
 * Reload the index from the database.
 *
 * Safe to call from anywhere, any number of times: concurrent calls coalesce.
 * A failed reload keeps the previous index (stale data beats no data) and is
 * recorded for `/health`; it never throws.
 *
 * @param {string} [reason] - Label for logs.
 * @returns {Promise<void>} Resolves when the index reflects a load that STARTED
 *   after this call.
 */
export function reloadBindingIndex(reason = 'manual') {
  if (inflight) {
    dirty = true;
    return inflight;
  }

  inflight = (async () => {
    try {
      do {
        dirty = false;
        const myGeneration = ++generation;
        try {
          const snapshot = await loadSnapshot();
          // Only the newest load may install its result.
          if (myGeneration === generation) {
            index = snapshot;
            loadedAt = Date.now();
            loadCount += 1;
            lastError = null;
          }
        } catch (error) {
          lastError = error?.message ?? String(error);
          console.error(`[bindings] Index reload failed (${reason}): ${lastError}`);
        }
      } while (dirty);
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Which mesh does a sensor currently drive?
 *
 * @param {string} sensorId - Upper-case sensor id.
 * @returns {BoundMesh|undefined} The bound mesh, or `undefined` when unbound.
 */
export function resolveSensor(sensorId) {
  return index.get(sensorId);
}

/**
 * Begin event-driven and periodic reloading. Performs the first load.
 *
 * @param {object} [options]
 * @param {number} [options.periodicMs] - Safety-net reload interval. 0 disables.
 * @returns {Promise<void>}
 */
export async function startBindingIndex({ periodicMs = 30_000 } = {}) {
  unsubscribe?.();
  unsubscribe = onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, (payload) =>
    reloadBindingIndex(payload?.reason ?? 'event'),
  );

  await reloadBindingIndex('boot');

  if (periodicMs > 0) {
    periodicTimer = setInterval(() => void reloadBindingIndex('periodic'), periodicMs);
    periodicTimer.unref();
  }
}

/**
 * Stop reloading. The current index is left in place.
 * @returns {void}
 */
export function stopBindingIndex() {
  unsubscribe?.();
  unsubscribe = null;
  if (periodicTimer) clearInterval(periodicTimer);
  periodicTimer = null;
}

/**
 * @returns {{size: number, loadedAt: number|null, loads: number, lastError: string|null}}
 *   Counters for `/health`.
 */
export function getBindingIndexStats() {
  return { size: index.size, loadedAt, loads: loadCount, lastError };
}

export default {
  startBindingIndex,
  stopBindingIndex,
  reloadBindingIndex,
  resolveSensor,
  getBindingIndexStats,
};
