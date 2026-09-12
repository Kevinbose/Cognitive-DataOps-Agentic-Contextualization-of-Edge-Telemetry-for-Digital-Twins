/**
 * @file Sensor-binding logic — the heart of Phase 2.
 *
 * "Binding" is the act of declaring *this logical sensor drives that physical
 * mesh*. It is the operation the whole platform exists to support, and the one
 * with the most invariants:
 *
 *   1. A mesh has at most one live sensor.
 *   2. A sensor drives at most one live mesh.
 *   3. Retiring a binding preserves it as history — nothing is ever destroyed.
 *   4. `MeshNode.isMapped` always agrees with the live binding rows.
 *
 * Rules 1 and 2 are enforced by partial unique indexes at the database level
 * (see `SensorBinding.model.js`), not by application checks — application
 * checks race, indexes do not. This module's job is to sequence the writes
 * atomically and translate index violations into readable HTTP errors.
 *
 * @module services/sensorBinding.service
 */

import { Asset, ASSET_STATUS } from '../models/Asset.model.js';
import { MeshNode } from '../models/MeshNode.model.js';
import { SensorBinding } from '../models/SensorBinding.model.js';
import { ApiError } from '../utils/ApiError.js';
import { withTransaction } from '../utils/transaction.js';
import * as meshNodeService from './meshNode.service.js';

/**
 * Result of a successful bind.
 *
 * @typedef {object} BindingResult
 * @property {object} binding - The newly active `SensorBinding` document.
 * @property {object} meshNode - The mesh node it is attached to.
 * @property {boolean} meshNodeCreated - Whether the mesh node was registered by this call.
 * @property {boolean} replacedPreviousBinding - Whether an earlier binding on this mesh was retired.
 * @property {boolean} unchanged - True when the requested binding already existed verbatim.
 */

/**
 * Bind a sensor to a mesh, addressed by the mesh's raw glTF name.
 *
 * Name-addressed rather than id-addressed on purpose: the viewer's click
 * handler knows `e.object.name` and nothing else. Requiring a `meshNodeId`
 * would force a lookup-then-create round trip in the browser for every first
 * binding, so the mesh node is found-or-created here instead.
 *
 * The whole sequence runs in one transaction on a replica set (Atlas M0 and up)
 * and degrades to sequential writes with a loud warning on a standalone
 * `mongod` — see `utils/transaction.js`.
 *
 * @param {object} params
 * @param {string} params.assetId - Owning asset id.
 * @param {string} params.meshName - Raw glTF node name, exactly as in the `.glb`.
 * @param {string} params.sensorId - Logical sensor identifier (upper-cased on write).
 * @param {string} [params.sensorType] - Measured quantity; defaults to `generic`.
 * @param {string} [params.displayName] - Friendly label to store on the mesh node.
 * @param {string} [params.nodePath] - Ancestor breadcrumb for disambiguation.
 * @param {string} [params.objectType] - `Mesh` or `Group`.
 * @param {string} [params.boundBy] - Who performed the binding.
 * @param {string} [params.notes] - Commissioning notes.
 * @param {boolean} [params.reassign] - Allow stealing the sensor from another mesh.
 * @returns {Promise<BindingResult>} The resulting binding and its context.
 * @throws {ApiError} 404 when the asset is absent; 409 when the sensor is already
 *   bound elsewhere and `reassign` was not set.
 */
export async function bindSensorToMeshName({
  assetId,
  meshName,
  sensorId,
  sensorType,
  displayName,
  nodePath,
  objectType,
  boundBy,
  notes,
  reassign = false,
}) {
  const asset = await Asset.findActiveById(assetId);
  if (!asset) {
    throw ApiError.notFound(`Asset "${assetId}" was not found`);
  }

  // Normalise here so the pre-flight conflict check compares like with like —
  // the schema's `uppercase: true` only applies once a document is written.
  const normalisedSensorId = sensorId.trim().toUpperCase();

  return withTransaction(
    async (session) => {
      /* ── 1. Resolve (or register) the target mesh node ──────────────────── */
      const meshNodeCountBefore = await MeshNode.countDocuments({
        assetId,
        meshName,
        isDeleted: false,
      }).session(session);

      const meshNode = await meshNodeService.findOrCreateByName({
        assetId,
        meshName,
        displayName,
        nodePath,
        objectType,
        createdBy: boundBy,
        session,
      });

      const meshNodeCreated = meshNodeCountBefore === 0;

      /* ── 2. Is this exact binding already in place? ─────────────────────── */
      const currentOnMesh = await SensorBinding.findOne({
        meshNodeId: meshNode._id,
        isActive: true,
      }).session(session);

      if (
        currentOnMesh &&
        currentOnMesh.sensorId === normalisedSensorId &&
        (sensorType === undefined || currentOnMesh.sensorType === sensorType)
      ) {
        // Idempotent: re-submitting the same mapping is a no-op, not an error.
        // Keeps the UI safe against double-clicks and retried requests.
        return {
          binding: currentOnMesh.toJSON(),
          meshNode: meshNode.toJSON(),
          meshNodeCreated,
          replacedPreviousBinding: false,
          unchanged: true,
        };
      }

      /* ── 3. Is this sensor already driving a different mesh? ────────────── */
      const currentOnSensor = await SensorBinding.findOne({
        sensorId: normalisedSensorId,
        isActive: true,
      }).session(session);

      const sensorHeldElsewhere =
        currentOnSensor && String(currentOnSensor.meshNodeId) !== String(meshNode._id);

      if (sensorHeldElsewhere && !reassign) {
        // Refuse by default. Silently relocating a sensor from another part of
        // the plant is exactly the kind of "helpful" behaviour that produces a
        // twin nobody trusts. The caller can opt in explicitly.
        throw ApiError.conflict(
          `Sensor "${normalisedSensorId}" is already bound to another mesh in this deployment. ` +
            'Unbind it first, or retry with `reassign: true` to move it.',
          [{ field: 'sensorId', message: 'Sensor already has an active binding' }],
        );
      }

      const now = new Date();

      /* ── 4. Retire whatever is being replaced ───────────────────────────── */
      if (sensorHeldElsewhere) {
        await SensorBinding.updateOne(
          { _id: currentOnSensor._id },
          { $set: { isActive: false, unboundAt: now } },
          { session },
        );
        // The mesh that just lost its sensor needs its mirror flag refreshed.
        await meshNodeService.syncIsMapped(currentOnSensor.meshNodeId, session);
      }

      if (currentOnMesh) {
        await SensorBinding.updateOne(
          { _id: currentOnMesh._id },
          { $set: { isActive: false, unboundAt: now } },
          { session },
        );
      }

      /* ── 5. Create the new live binding ─────────────────────────────────── */
      let created;
      try {
        [created] = await SensorBinding.create(
          [
            {
              assetId,
              meshNodeId: meshNode._id,
              sensorId: normalisedSensorId,
              ...(sensorType ? { sensorType } : {}),
              boundBy: boundBy ?? null,
              notes: notes ?? null,
              boundAt: now,
              isActive: true,
            },
          ],
          { session },
        );
      } catch (error) {
        if (error?.code === 11000) {
          // A concurrent request won the race for this sensor or mesh. The
          // index did its job; translate it into an actionable 409.
          throw ApiError.conflict(
            'That sensor or mesh was bound by a concurrent request. Reload and try again.',
            [{ field: 'sensorId', message: 'Duplicate active binding' }],
          );
        }
        throw error;
      }

      /* ── 6. Keep the denormalised mirrors honest ────────────────────────── */
      await meshNodeService.syncIsMapped(meshNode._id, session);

      // First successful mapping promotes the asset along the status ratchet.
      if (asset.promoteStatus(ASSET_STATUS.MAPPED)) {
        await asset.save({ session });
      }

      // Mirror the flag on the in-memory document rather than re-reading it.
      // A fresh query outside this session would not see the uncommitted write,
      // and querying inside it just to echo a value we already know is waste.
      meshNode.isMapped = true;

      return {
        binding: created.toJSON(),
        meshNode: meshNode.toJSON(),
        meshNodeCreated,
        replacedPreviousBinding: Boolean(currentOnMesh),
        unchanged: false,
      };
    },
    { label: `bind ${normalisedSensorId} → ${meshName}` },
  );
}

/**
 * Retire a binding by id.
 *
 * Sets `isActive: false` and stamps `unboundAt`; the row itself survives as
 * history and stops occupying the partial unique indexes.
 *
 * @param {string} bindingId - Binding id.
 * @returns {Promise<object>} The retired binding.
 * @throws {ApiError} 404 when absent; 409 when it was already retired.
 */
export async function unbindById(bindingId) {
  const binding = await SensorBinding.findById(bindingId);

  if (!binding) {
    throw ApiError.notFound(`Sensor binding "${bindingId}" was not found`);
  }
  if (!binding.isActive) {
    throw ApiError.conflict(`Sensor binding "${bindingId}" is already inactive`);
  }

  binding.isActive = false;
  binding.unboundAt = new Date();
  await binding.save();

  await meshNodeService.syncIsMapped(binding.meshNodeId);

  return binding.toJSON();
}

/**
 * List bindings for an asset.
 *
 * @param {string} assetId - Owning asset id.
 * @param {object} [options]
 * @param {boolean} [options.includeInactive] - Include retired bindings (the
 *   rebind history) rather than only the live ones.
 * @returns {Promise<object[]>} Bindings, newest first.
 */
export async function listBindingsForAsset(assetId, { includeInactive = false } = {}) {
  /** @type {Record<string, unknown>} */
  const filter = { assetId };
  if (!includeInactive) filter.isActive = true;

  return SensorBinding.find(filter)
    .sort({ boundAt: -1 })
    .populate('meshNodeId', 'meshName displayName objectType')
    .lean();
}

/**
 * Resolve which mesh a sensor currently drives.
 *
 * Not used by the Phase 2 UI — this is the reverse lookup Phase 3's MQTT
 * ingestion will call on every inbound reading, and it is the reason
 * `SensorBinding` is a standalone collection with its own `sensorId` index.
 *
 * @param {string} sensorId - Logical sensor identifier (case-insensitive).
 * @returns {Promise<object|null>} The active binding with its mesh node
 *   populated, or `null` when the sensor is unbound.
 */
export async function getActiveBindingBySensorId(sensorId) {
  return SensorBinding.findOne({
    sensorId: sensorId.trim().toUpperCase(),
    isActive: true,
  })
    .populate('meshNodeId', 'meshName displayName assetId')
    .lean();
}

export default {
  bindSensorToMeshName,
  unbindById,
  listBindingsForAsset,
  getActiveBindingBySensorId,
};
