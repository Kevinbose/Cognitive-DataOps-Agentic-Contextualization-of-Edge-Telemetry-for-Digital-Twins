/**
 * @file Mesh-node routes.
 *
 * Exports two routers because mesh nodes are addressed two different ways:
 *
 *   - **Asset-scoped** (`/assets/:assetId/mesh-nodes/...`) — how the viewer
 *     works. It knows the asset it is displaying and the glTF name it just
 *     clicked, but not any database id.
 *   - **Top-level** (`/mesh-nodes/:meshNodeId`) — administrative edits on a
 *     node that is already known by id.
 *
 * @module routes/meshNode.routes
 */

import { Router } from 'express';

import * as meshNodeController from '../controllers/meshNode.controller.js';
import * as sensorBindingController from '../controllers/sensorBinding.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.middleware.js';
import { assetIdParamSchema } from '../validators/common.validator.js';
import {
  listMeshNodesQuerySchema,
  meshNameParamSchema,
  meshNodeIdParamSchema,
  registerMeshNodeSchema,
  saveBindingSchema,
  updateMeshNodeSchema,
} from '../validators/meshNode.validator.js';

/**
 * Routes mounted at `/api/v1/assets/:assetId/mesh-nodes`.
 *
 * `mergeParams: true` is essential — without it `req.params.assetId` from the
 * parent mount point is invisible here, and every handler would 404.
 *
 * @type {import('express').Router}
 */
export const assetScopedMeshNodeRouter = Router({ mergeParams: true });

assetScopedMeshNodeRouter.get(
  '/',
  validate({ params: assetIdParamSchema, query: listMeshNodesQuerySchema }),
  asyncHandler(meshNodeController.listMeshNodes),
);

assetScopedMeshNodeRouter.post(
  '/',
  validate({ params: assetIdParamSchema, body: registerMeshNodeSchema }),
  asyncHandler(meshNodeController.registerMeshNode),
);

/**
 * The primary mapping endpoint.
 *
 * The mesh is addressed **by name** rather than by id because that is the only
 * identifier the 3D viewer has at click time (`event.object.name`). Requiring an
 * id would force a lookup-or-create round trip in the browser before every
 * first binding.
 *
 * Real glTF names contain slashes (`.../wall-module/0`), so clients must
 * percent-encode the segment: `encodeURIComponent(meshName)`. Express matches
 * on the raw path and decodes afterwards, so `%2F` stays inside one segment.
 */
assetScopedMeshNodeRouter.put(
  '/by-name/:meshName/sensor-binding',
  validate({ params: meshNameParamSchema, body: saveBindingSchema }),
  asyncHandler(sensorBindingController.saveBinding),
);

/**
 * Routes mounted at `/api/v1/mesh-nodes`.
 * @type {import('express').Router}
 */
export const meshNodeRouter = Router();

meshNodeRouter.patch(
  '/:meshNodeId',
  validate({ params: meshNodeIdParamSchema, body: updateMeshNodeSchema }),
  asyncHandler(meshNodeController.updateMeshNode),
);

meshNodeRouter.delete(
  '/:meshNodeId',
  validate({ params: meshNodeIdParamSchema }),
  asyncHandler(meshNodeController.deleteMeshNode),
);

export default { assetScopedMeshNodeRouter, meshNodeRouter };
