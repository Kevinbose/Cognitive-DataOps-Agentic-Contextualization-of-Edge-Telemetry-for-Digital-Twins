/**
 * @file Asset business logic — creation, listing, file attachment, twin scene.
 *
 * Controllers call into this module and do nothing else. Status transitions,
 * storage-key construction, and the twin-scene assembly all live here so they
 * are testable without an HTTP layer.
 *
 * @module services/asset.service
 */

import path from 'node:path';

import { Asset, ASSET_STATUS } from '../models/Asset.model.js';
import { MeshNode } from '../models/MeshNode.model.js';
import { SensorBinding } from '../models/SensorBinding.model.js';
import { buildConvertedKey, buildOriginalKey, buildPublicPath } from '../config/storage.config.js';
import { ApiError } from '../utils/ApiError.js';
import { buildPaginationMeta } from '../utils/ApiResponse.js';
import * as storageService from './storage.service.js';

/**
 * A Multer-staged upload, as handed over by `upload.middleware.js`.
 *
 * @typedef {object} StagedUpload
 * @property {string} path - Absolute path of the temp file on disk.
 * @property {string} originalname - Filename as supplied by the client.
 * @property {string} mimetype - Reported MIME type.
 * @property {number} size - Size in bytes.
 */

/**
 * Fetch a live asset by id, or throw a 404.
 *
 * Centralised so every "asset must exist" check produces an identical error
 * message, and so soft-deleted assets uniformly read as absent.
 *
 * @param {string} assetId - Asset id.
 * @returns {Promise<import('mongoose').Document>} The asset document.
 * @throws {ApiError} 404 when no live asset has that id.
 */
export async function getAssetOrThrow(assetId) {
  const asset = await Asset.findActiveById(assetId);
  if (!asset) {
    throw ApiError.notFound(`Asset "${assetId}" was not found`);
  }
  return asset;
}

/**
 * Create an asset, optionally accepting its raw CAD file in the same request.
 *
 * The document is saved **before** the file is moved into storage, because the
 * storage key embeds the asset's `_id`. If the file step then fails, the
 * half-created asset is rolled back by hand — this is one write to each of two
 * different systems (MongoDB and the filesystem), which no database transaction
 * can cover.
 *
 * @param {object} params
 * @param {string} params.name - Human-readable asset name.
 * @param {string} params.uploader - Who is uploading.
 * @param {string} [params.sourceType] - CAD format; defaults to the schema default.
 * @param {string} [params.notes] - Optional operator notes.
 * @param {StagedUpload} [params.file] - Staged CAD upload, when provided.
 * @returns {Promise<import('mongoose').Document>} The created asset.
 */
export async function createAsset({ name, uploader, sourceType, notes, file }) {
  const asset = new Asset({
    name,
    uploader,
    ...(sourceType ? { sourceType } : {}),
    metadata: { notes: notes ?? null },
  });

  await asset.save();

  if (!file) return asset;

  try {
    const extension = path.extname(file.originalname) || '.stp';
    const artifact = await storageService.persistUpload({
      tempPath: file.path,
      storageKey: buildOriginalKey(asset.id, extension),
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    asset.originalFile = artifact;
    await asset.save();
    return asset;
  } catch (error) {
    // Compensating action: the asset only exists to own this file, so a failed
    // upload should not leave an orphaned shell in the dashboard.
    await Asset.deleteOne({ _id: asset._id });
    await storageService.discardTempFile(file.path);
    throw error;
  }
}

/**
 * List live assets with filtering, search, and pagination.
 *
 * @param {object} [params]
 * @param {string} [params.status] - Exact status filter.
 * @param {string} [params.search] - Case-insensitive substring match on name/uploader.
 * @param {number} [params.page] - 1-based page index.
 * @param {number} [params.limit] - Page size.
 * @returns {Promise<{items: import('mongoose').Document[], meta: import('../utils/ApiResponse.js').PaginationMeta}>}
 */
export async function listAssets({ status, search, page = 1, limit = 20 } = {}) {
  /** @type {Record<string, unknown>} */
  const filter = { isDeleted: false };

  if (status) filter.status = status;

  if (search) {
    // Escape regex metacharacters so a search for "motor (v2)" is treated as
    // literal text rather than an invalid or pathological pattern.
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(escaped, 'i');
    filter.$or = [{ name: pattern }, { uploader: pattern }];
  }

  const skip = (page - 1) * limit;

  // Run the page query and the count concurrently — they are independent.
  const [items, total] = await Promise.all([
    Asset.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Asset.countDocuments(filter),
  ]);

  return { items, meta: buildPaginationMeta({ page, limit, total }) };
}

/**
 * Fetch a single live asset.
 *
 * @param {string} assetId - Asset id.
 * @returns {Promise<import('mongoose').Document>} The asset document.
 * @throws {ApiError} 404 when absent.
 */
export async function getAssetById(assetId) {
  return getAssetOrThrow(assetId);
}

/**
 * Update an asset's editable descriptive fields.
 *
 * Deliberately narrow: `status`, `version`, and both file sub-documents are
 * owned by the pipeline, not by a generic PATCH, so they are not reachable here.
 *
 * @param {string} assetId - Asset id.
 * @param {object} patch - Editable fields.
 * @param {string} [patch.name] - New display name.
 * @param {string} [patch.notes] - New operator notes.
 * @param {string} [patch.units] - Source CAD units.
 * @param {number} [patch.partCount] - Recorded part count.
 * @returns {Promise<import('mongoose').Document>} The updated asset.
 * @throws {ApiError} 404 when absent.
 */
export async function updateAsset(assetId, patch) {
  const asset = await getAssetOrThrow(assetId);

  if (patch.name !== undefined) asset.name = patch.name;
  if (patch.notes !== undefined) asset.metadata.notes = patch.notes;
  if (patch.units !== undefined) asset.metadata.units = patch.units;
  if (patch.partCount !== undefined) asset.metadata.partCount = patch.partCount;

  await asset.save();
  return asset;
}

/**
 * Attach (or replace) the web-ready `.glb` and promote the asset to `converted`.
 *
 * Replacing an existing mesh bumps `version`, which the frontend appends to the
 * model URL as a cache-buster — without it, drei's `useGLTF` would keep serving
 * the previously cached geometry after a re-upload.
 *
 * Existing `MeshNode` rows are intentionally left untouched on replacement: a
 * re-export from Blender normally preserves node names, so discarding the
 * operator's sensor mappings would be destructive. Names that genuinely
 * disappeared simply stop matching in the viewer and can be removed by hand.
 *
 * @param {string} assetId - Asset id.
 * @param {StagedUpload} file - Staged `.glb` upload.
 * @returns {Promise<import('mongoose').Document>} The updated asset.
 * @throws {ApiError} 404 when the asset is absent; 415 when the file is not a GLB.
 */
export async function attachConvertedFile(assetId, file) {
  const asset = await getAssetOrThrow(assetId);
  const isReplacement = Boolean(asset.convertedFile);

  try {
    const artifact = await storageService.persistUpload({
      tempPath: file.path,
      storageKey: buildConvertedKey(asset.id),
      originalName: file.originalname,
      mimeType: file.mimetype,
      // Enforce the glTF magic bytes before this file can reach a browser.
      verifyGlb: true,
    });

    asset.convertedFile = artifact;
    if (isReplacement) asset.version += 1;
    asset.promoteStatus(ASSET_STATUS.CONVERTED);

    await asset.save();
    return asset;
  } catch (error) {
    await storageService.discardTempFile(file.path);
    throw error;
  }
}

/**
 * Attach (or replace) the raw CAD file on an existing asset.
 *
 * @param {string} assetId - Asset id.
 * @param {StagedUpload} file - Staged CAD upload.
 * @returns {Promise<import('mongoose').Document>} The updated asset.
 * @throws {ApiError} 404 when the asset is absent.
 */
export async function attachOriginalFile(assetId, file) {
  const asset = await getAssetOrThrow(assetId);

  try {
    const extension = path.extname(file.originalname) || '.stp';
    asset.originalFile = await storageService.persistUpload({
      tempPath: file.path,
      storageKey: buildOriginalKey(asset.id, extension),
      originalName: file.originalname,
      mimeType: file.mimetype,
    });

    await asset.save();
    return asset;
  } catch (error) {
    await storageService.discardTempFile(file.path);
    throw error;
  }
}

/**
 * Soft-delete an asset and cascade to its mesh nodes and active bindings.
 *
 * Stored binaries are deliberately **not** removed: retaining the raw CAD is
 * the entire point of tracking it, and a soft delete must stay reversible.
 *
 * @param {string} assetId - Asset id.
 * @returns {Promise<{assetId: string, meshNodesDeleted: number, bindingsClosed: number}>}
 *   Cascade summary, surfaced to the client so the effect is visible.
 * @throws {ApiError} 404 when absent.
 */
export async function softDeleteAsset(assetId) {
  const asset = await getAssetOrThrow(assetId);
  const now = new Date();

  const [meshResult, bindingResult] = await Promise.all([
    MeshNode.updateMany(
      { assetId: asset._id, isDeleted: false },
      { $set: { isDeleted: true, deletedAt: now } },
    ),
    // Bindings are closed rather than flagged deleted: `isActive: false` is
    // already their retirement state, and it releases the partial unique
    // indexes so the mesh/sensor can be reused after a restore.
    SensorBinding.updateMany(
      { assetId: asset._id, isActive: true },
      { $set: { isActive: false, unboundAt: now } },
    ),
  ]);

  await asset.softDelete();

  return {
    assetId: asset.id,
    meshNodesDeleted: meshResult.modifiedCount ?? 0,
    bindingsClosed: bindingResult.modifiedCount ?? 0,
  };
}

/**
 * Resolve the information needed to stream one of an asset's files back.
 *
 * @param {string} assetId - Asset id.
 * @param {'original'|'converted'} artifactKind - Which artefact to download.
 * @returns {Promise<{absolutePath: string, downloadName: string, mimeType: string}>}
 * @throws {ApiError} 404 when the asset or the requested artefact is absent.
 */
export async function getDownloadDescriptor(assetId, artifactKind) {
  const asset = await getAssetOrThrow(assetId);
  const artifact = artifactKind === 'original' ? asset.originalFile : asset.convertedFile;

  if (!artifact) {
    throw ApiError.notFound(
      `Asset "${assetId}" has no ${artifactKind} file. ` +
        (artifactKind === 'converted'
          ? 'Upload a converted .glb first.'
          : 'Upload the source CAD file first.'),
    );
  }

  if (!(await storageService.objectExists(artifact.storageKey))) {
    // Database and bucket have diverged — surface it plainly rather than
    // letting the download stream fail with an opaque ENOENT.
    throw ApiError.notFound(
      `The ${artifactKind} file for asset "${assetId}" is recorded in the database ` +
        `but missing from storage (key: ${artifact.storageKey}).`,
    );
  }

  return {
    absolutePath: storageService.resolveAbsolutePath(artifact.storageKey),
    downloadName: artifact.originalName,
    mimeType: artifact.mimeType,
  };
}

/**
 * Build the aggregated **twin scene** payload — everything the 3D viewer needs
 * for one asset in a single round trip.
 *
 * Assembled with three indexed queries plus an in-memory join rather than an
 * aggregation pipeline. At this cardinality (tens of mesh nodes per asset) the
 * cost is identical, and plain JavaScript is far easier for the team to debug
 * than a `$lookup` chain.
 *
 * @param {string} assetId - Asset id.
 * @returns {Promise<{
 *   asset: object,
 *   modelUrl: string|null,
 *   meshNodes: Array<object>,
 *   stats: {registeredNodes: number, mappedNodes: number}
 * }>} Scene payload.
 * @throws {ApiError} 404 when the asset is absent.
 */
export async function getTwinScene(assetId) {
  const asset = await getAssetOrThrow(assetId);

  const [meshNodes, activeBindings] = await Promise.all([
    // Plain `.lean()` — virtuals are not hydrated on lean documents, so the
    // `label` fallback is recomputed explicitly in the map below.
    MeshNode.findActive({ assetId: asset._id }).sort({ createdAt: 1 }).lean(),
    SensorBinding.find({ assetId: asset._id, isActive: true }).lean(),
  ]);

  // Index bindings by mesh node so the join below is O(n) rather than O(n²).
  const bindingByMeshNode = new Map(
    activeBindings.map((binding) => [String(binding.meshNodeId), binding]),
  );

  const nodes = meshNodes.map((node) => {
    const binding = bindingByMeshNode.get(String(node._id)) ?? null;
    return {
      _id: node._id,
      meshName: node.meshName,
      displayName: node.displayName,
      label: node.displayName || node.meshName,
      nodePath: node.nodePath,
      objectType: node.objectType,
      isMapped: Boolean(binding),
      activeBinding: binding
        ? {
            _id: binding._id,
            sensorId: binding.sensorId,
            sensorType: binding.sensorType,
            boundBy: binding.boundBy,
            boundAt: binding.boundAt,
            notes: binding.notes,
          }
        : null,
    };
  });

  return {
    asset: asset.toJSON(),
    // The cache-busting `?v=` is what makes a re-uploaded mesh actually appear.
    modelUrl: asset.convertedFile
      ? `${buildPublicPath(asset.convertedFile.storageKey)}?v=${asset.version}`
      : null,
    meshNodes: nodes,
    stats: {
      registeredNodes: nodes.length,
      mappedNodes: nodes.filter((node) => node.isMapped).length,
    },
  };
}

export default {
  getAssetOrThrow,
  createAsset,
  listAssets,
  getAssetById,
  updateAsset,
  attachConvertedFile,
  attachOriginalFile,
  softDeleteAsset,
  getDownloadDescriptor,
  getTwinScene,
};
