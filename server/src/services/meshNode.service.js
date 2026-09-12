/**
 * @file Mesh-node registry logic.
 *
 * A `MeshNode` is created the moment an operator decides a glTF node matters —
 * usually implicitly, as a side effect of binding a sensor to it. This module
 * owns that find-or-create path plus the administrative list/register/remove
 * operations.
 *
 * @module services/meshNode.service
 */

import { MeshNode } from '../models/MeshNode.model.js';
import { SensorBinding } from '../models/SensorBinding.model.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Fetch a live mesh node by id, or throw a 404.
 *
 * @param {string} meshNodeId - Mesh node id.
 * @returns {Promise<import('mongoose').Document>} The mesh node document.
 * @throws {ApiError} 404 when absent.
 */
export async function getMeshNodeOrThrow(meshNodeId) {
  const meshNode = await MeshNode.findActiveById(meshNodeId);
  if (!meshNode) {
    throw ApiError.notFound(`Mesh node "${meshNodeId}" was not found`);
  }
  return meshNode;
}

/**
 * List every registered mesh node for an asset.
 *
 * Note this returns only *registered* nodes — the ones someone has chosen to
 * instrument. The full ~1,000-node scene graph is never persisted; the browser
 * discovers it by traversing the loaded `.glb`.
 *
 * @param {string} assetId - Owning asset id.
 * @param {object} [options]
 * @param {boolean} [options.mappedOnly] - Restrict to nodes with a live binding.
 * @returns {Promise<import('mongoose').Document[]>} Registered mesh nodes.
 */
export async function listMeshNodes(assetId, { mappedOnly = false } = {}) {
  /** @type {Record<string, unknown>} */
  const filter = { assetId };
  if (mappedOnly) filter.isMapped = true;

  return MeshNode.findActive(filter).sort({ createdAt: 1 });
}

/**
 * Find a live mesh node by its glTF name within an asset, or create it.
 *
 * This is the hot path behind the binding endpoint: the operator clicks a mesh
 * in the 3D viewer, and the backend has never heard of that name before.
 *
 * Concurrency: two simultaneous requests for the same new name would both see
 * "not found" and both insert. The partial unique index on
 * `{assetId, meshName}` turns the loser into an `E11000` duplicate-key error,
 * which is caught here and resolved by re-reading the row the winner wrote.
 * That is why this is safe without an application-level lock.
 *
 * @param {object} params
 * @param {string} params.assetId - Owning asset id.
 * @param {string} params.meshName - Raw glTF node name.
 * @param {string} [params.displayName] - Optional friendly label.
 * @param {string} [params.nodePath] - Optional ancestor breadcrumb.
 * @param {string} [params.objectType] - `Mesh` or `Group`.
 * @param {string} [params.createdBy] - Who triggered the registration.
 * @param {import('mongoose').ClientSession|null} [params.session] - Enclosing session.
 * @returns {Promise<import('mongoose').Document>} Existing or newly created node.
 */
export async function findOrCreateByName({
  assetId,
  meshName,
  displayName,
  nodePath,
  objectType,
  createdBy,
  session = null,
}) {
  const existing = await MeshNode.findOne({
    assetId,
    meshName,
    isDeleted: false,
  }).session(session);

  if (existing) {
    // Let a later request enrich a node that was first created with only a name.
    let touched = false;
    if (displayName !== undefined && displayName !== null && displayName !== existing.displayName) {
      existing.displayName = displayName;
      touched = true;
    }
    if (nodePath && nodePath !== existing.nodePath) {
      existing.nodePath = nodePath;
      touched = true;
    }
    if (touched) await existing.save({ session });

    return existing;
  }

  try {
    const [created] = await MeshNode.create(
      [
        {
          assetId,
          meshName,
          displayName: displayName ?? null,
          nodePath: nodePath ?? null,
          ...(objectType ? { objectType } : {}),
          createdBy: createdBy ?? null,
        },
      ],
      { session },
    );
    return created;
  } catch (error) {
    // Lost an insert race against a concurrent identical request — the row we
    // wanted now exists, so adopt it.
    if (error?.code === 11000) {
      const winner = await MeshNode.findOne({
        assetId,
        meshName,
        isDeleted: false,
      }).session(session);
      if (winner) return winner;
    }
    throw error;
  }
}

/**
 * Explicitly register a mesh node without binding a sensor to it.
 *
 * Useful for pre-annotating parts of interest ahead of commissioning.
 *
 * @param {object} params
 * @param {string} params.assetId - Owning asset id.
 * @param {string} params.meshName - Raw glTF node name.
 * @param {string} [params.displayName] - Optional friendly label.
 * @param {string} [params.nodePath] - Optional ancestor breadcrumb.
 * @param {string} [params.objectType] - `Mesh` or `Group`.
 * @param {string} [params.createdBy] - Who registered it.
 * @returns {Promise<import('mongoose').Document>} The registered node.
 */
export async function registerMeshNode(params) {
  return findOrCreateByName(params);
}

/**
 * Update a mesh node's operator-facing labels.
 *
 * `meshName` is immutable by design — it is the join key into the glTF scene
 * graph, so editing it would silently detach the node from the geometry it
 * describes. Rename the label instead.
 *
 * @param {string} meshNodeId - Mesh node id.
 * @param {object} patch
 * @param {string|null} [patch.displayName] - New friendly label.
 * @param {string|null} [patch.nodePath] - New ancestor breadcrumb.
 * @returns {Promise<import('mongoose').Document>} The updated node.
 * @throws {ApiError} 404 when absent.
 */
export async function updateMeshNode(meshNodeId, patch) {
  const meshNode = await getMeshNodeOrThrow(meshNodeId);

  if (patch.displayName !== undefined) meshNode.displayName = patch.displayName;
  if (patch.nodePath !== undefined) meshNode.nodePath = patch.nodePath;

  await meshNode.save();
  return meshNode;
}

/**
 * Soft-delete a mesh node and retire any active binding attached to it.
 *
 * Both writes matter: leaving an active binding behind would keep the sensor's
 * slot in the partial unique index occupied, blocking it from being rebound
 * elsewhere.
 *
 * @param {string} meshNodeId - Mesh node id.
 * @returns {Promise<{meshNodeId: string, bindingsClosed: number}>} Cascade summary.
 * @throws {ApiError} 404 when absent.
 */
export async function softDeleteMeshNode(meshNodeId) {
  const meshNode = await getMeshNodeOrThrow(meshNodeId);

  const result = await SensorBinding.updateMany(
    { meshNodeId: meshNode._id, isActive: true },
    { $set: { isActive: false, unboundAt: new Date() } },
  );

  meshNode.isMapped = false;
  await meshNode.softDelete();

  return { meshNodeId: meshNode.id, bindingsClosed: result.modifiedCount ?? 0 };
}

/**
 * Recompute a mesh node's denormalised `isMapped` flag from live binding rows.
 *
 * Called inside the binding transaction so the mirror can never drift from the
 * authoritative `SensorBinding` collection.
 *
 * @param {string|import('mongoose').Types.ObjectId} meshNodeId - Mesh node id.
 * @param {import('mongoose').ClientSession|null} [session] - Enclosing session.
 * @returns {Promise<boolean>} The recomputed flag value.
 */
export async function syncIsMapped(meshNodeId, session = null) {
  const activeCount = await SensorBinding.countDocuments({
    meshNodeId,
    isActive: true,
  }).session(session);

  const isMapped = activeCount > 0;

  await MeshNode.updateOne({ _id: meshNodeId }, { $set: { isMapped } }, { session });

  return isMapped;
}

export default {
  getMeshNodeOrThrow,
  listMeshNodes,
  findOrCreateByName,
  registerMeshNode,
  updateMeshNode,
  softDeleteMeshNode,
  syncIsMapped,
};
