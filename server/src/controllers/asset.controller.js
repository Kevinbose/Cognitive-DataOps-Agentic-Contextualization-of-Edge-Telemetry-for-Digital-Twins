/**
 * @file Asset HTTP controllers.
 *
 * Every handler here follows the same three-line shape: pull validated data off
 * the request, call exactly one service method, send the envelope. No branching,
 * no queries, no `try/catch` — errors propagate to the global handler via
 * `asyncHandler`, and any logic that appears here is logic in the wrong file.
 *
 * @module controllers/asset.controller
 */

import * as assetService from '../services/asset.service.js';
import { sendCreated, sendOk } from '../utils/ApiResponse.js';

/**
 * `POST /api/v1/assets` — create an asset, optionally with its CAD file.
 *
 * @type {import('express').RequestHandler}
 */
export async function createAsset(req, res) {
  const asset = await assetService.createAsset({
    name: req.body.name,
    uploader: req.body.uploader,
    sourceType: req.body.sourceType,
    notes: req.body.notes,
    file: req.file,
  });

  return sendCreated(res, asset, 'Asset created');
}

/**
 * `GET /api/v1/assets` — paginated, filterable asset list.
 *
 * @type {import('express').RequestHandler}
 */
export async function listAssets(req, res) {
  const { items, meta } = await assetService.listAssets({
    status: req.query.status,
    search: req.query.search,
    page: req.query.page,
    limit: req.query.limit,
  });

  return sendOk(res, items, 'Assets retrieved', meta);
}

/**
 * `GET /api/v1/assets/:assetId` — single asset metadata.
 *
 * @type {import('express').RequestHandler}
 */
export async function getAsset(req, res) {
  const asset = await assetService.getAssetById(req.params.assetId);
  return sendOk(res, asset, 'Asset retrieved');
}

/**
 * `PATCH /api/v1/assets/:assetId` — update descriptive fields.
 *
 * @type {import('express').RequestHandler}
 */
export async function updateAsset(req, res) {
  const asset = await assetService.updateAsset(req.params.assetId, req.body);
  return sendOk(res, asset, 'Asset updated');
}

/**
 * `DELETE /api/v1/assets/:assetId` — soft delete with cascade.
 *
 * @type {import('express').RequestHandler}
 */
export async function deleteAsset(req, res) {
  const summary = await assetService.softDeleteAsset(req.params.assetId);
  return sendOk(res, summary, 'Asset deleted');
}

/**
 * `POST /api/v1/assets/:assetId/original-file` — attach or replace the CAD file.
 *
 * @type {import('express').RequestHandler}
 */
export async function uploadOriginalFile(req, res) {
  const asset = await assetService.attachOriginalFile(req.params.assetId, req.file);
  return sendOk(res, asset, 'Source CAD file uploaded');
}

/**
 * `POST /api/v1/assets/:assetId/converted-file` — attach or replace the `.glb`.
 *
 * @type {import('express').RequestHandler}
 */
export async function uploadConvertedFile(req, res) {
  const asset = await assetService.attachConvertedFile(req.params.assetId, req.file);
  return sendOk(res, asset, 'Converted mesh uploaded');
}

/**
 * `GET /api/v1/assets/:assetId/original-file` — download the raw CAD file.
 *
 * @type {import('express').RequestHandler}
 */
export async function downloadOriginalFile(req, res) {
  const descriptor = await assetService.getDownloadDescriptor(req.params.assetId, 'original');

  res.type(descriptor.mimeType);
  return res.download(descriptor.absolutePath, descriptor.downloadName);
}

/**
 * `GET /api/v1/assets/:assetId/converted-file` — download the `.glb`.
 *
 * Note this is the *download* path, with a `Content-Disposition` attachment
 * header. The 3D viewer does not use it — it loads the mesh from the
 * `/static` mount, which supports the HTTP range requests that streaming
 * loaders rely on.
 *
 * @type {import('express').RequestHandler}
 */
export async function downloadConvertedFile(req, res) {
  const descriptor = await assetService.getDownloadDescriptor(req.params.assetId, 'converted');

  res.type(descriptor.mimeType);
  return res.download(descriptor.absolutePath, descriptor.downloadName);
}

/**
 * `GET /api/v1/assets/:assetId/scene` — the aggregated twin-scene payload.
 *
 * @type {import('express').RequestHandler}
 */
export async function getTwinScene(req, res) {
  const scene = await assetService.getTwinScene(req.params.assetId);
  return sendOk(res, scene, 'Twin scene retrieved');
}

export default {
  createAsset,
  listAssets,
  getAsset,
  updateAsset,
  deleteAsset,
  uploadOriginalFile,
  uploadConvertedFile,
  downloadOriginalFile,
  downloadConvertedFile,
  getTwinScene,
};
