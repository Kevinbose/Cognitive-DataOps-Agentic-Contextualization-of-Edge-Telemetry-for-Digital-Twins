/**
 * @file Asset routes, including the asset-scoped sub-resources.
 *
 * @module routes/asset.routes
 */

import { Router } from 'express';

import * as assetController from '../controllers/asset.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import {
  requireFile,
  uploadConvertedGlb,
  uploadOriginalCad,
} from '../middleware/upload.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  createAssetSchema,
  listAssetsQuerySchema,
  updateAssetSchema,
} from '../validators/asset.validator.js';
import { assetIdParamSchema } from '../validators/common.validator.js';
import { assetScopedMeshNodeRouter } from './meshNode.routes.js';
import { assetScopedBindingRouter } from './sensorBinding.routes.js';

/** @type {import('express').Router} */
export const assetRouter = Router();

/* ─── Collection ───────────────────────────────────────────────────────────── */

/**
 * `POST /` — create an asset.
 *
 * Multer runs before validation because the body arrives as `multipart/form-data`:
 * until it has been parsed, `req.body` is empty and any schema would reject a
 * perfectly valid request.
 */
assetRouter.post(
  '/',
  uploadOriginalCad,
  validate({ body: createAssetSchema }),
  asyncHandler(assetController.createAsset),
);

assetRouter.get(
  '/',
  validate({ query: listAssetsQuerySchema }),
  asyncHandler(assetController.listAssets),
);

/* ─── Single asset ─────────────────────────────────────────────────────────── */

assetRouter.get(
  '/:assetId',
  validate({ params: assetIdParamSchema }),
  asyncHandler(assetController.getAsset),
);

assetRouter.patch(
  '/:assetId',
  validate({ params: assetIdParamSchema, body: updateAssetSchema }),
  asyncHandler(assetController.updateAsset),
);

assetRouter.delete(
  '/:assetId',
  validate({ params: assetIdParamSchema }),
  asyncHandler(assetController.deleteAsset),
);

/* ─── File artefacts ───────────────────────────────────────────────────────── */

assetRouter.post(
  '/:assetId/original-file',
  validate({ params: assetIdParamSchema }),
  uploadOriginalCad,
  requireFile('originalFile'),
  asyncHandler(assetController.uploadOriginalFile),
);

assetRouter.post(
  '/:assetId/converted-file',
  validate({ params: assetIdParamSchema }),
  uploadConvertedGlb,
  requireFile('convertedFile'),
  asyncHandler(assetController.uploadConvertedFile),
);

assetRouter.get(
  '/:assetId/original-file',
  validate({ params: assetIdParamSchema }),
  asyncHandler(assetController.downloadOriginalFile),
);

assetRouter.get(
  '/:assetId/converted-file',
  validate({ params: assetIdParamSchema }),
  asyncHandler(assetController.downloadConvertedFile),
);

/* ─── Twin scene ───────────────────────────────────────────────────────────── */

/**
 * `GET /:assetId/scene` — everything the 3D viewer needs in one request:
 * asset metadata, the cache-busted model URL, and every registered mesh node
 * with its active binding already joined in.
 */
assetRouter.get(
  '/:assetId/scene',
  validate({ params: assetIdParamSchema }),
  asyncHandler(assetController.getTwinScene),
);

/* ─── Asset-scoped sub-resources ───────────────────────────────────────────── */

assetRouter.use('/:assetId/mesh-nodes', assetScopedMeshNodeRouter);
assetRouter.use('/:assetId/sensor-bindings', assetScopedBindingRouter);

export default assetRouter;
