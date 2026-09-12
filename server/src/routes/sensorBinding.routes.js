/**
 * @file Sensor-binding routes.
 *
 * The *creation* path lives in `meshNode.routes.js`, because it is addressed
 * through the mesh (`.../mesh-nodes/by-name/:meshName/sensor-binding`). What
 * remains here is reading and retiring bindings.
 *
 * @module routes/sensorBinding.routes
 */

import { Router } from 'express';

import * as sensorBindingController from '../controllers/sensorBinding.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.middleware.js';
import { assetIdParamSchema } from '../validators/common.validator.js';
import {
  bindingIdParamSchema,
  listBindingsQuerySchema,
} from '../validators/meshNode.validator.js';

/**
 * Routes mounted at `/api/v1/assets/:assetId/sensor-bindings`.
 * @type {import('express').Router}
 */
export const assetScopedBindingRouter = Router({ mergeParams: true });

assetScopedBindingRouter.get(
  '/',
  validate({ params: assetIdParamSchema, query: listBindingsQuerySchema }),
  asyncHandler(sensorBindingController.listBindings),
);

/**
 * Routes mounted at `/api/v1/sensor-bindings`.
 * @type {import('express').Router}
 */
export const sensorBindingRouter = Router();

sensorBindingRouter.delete(
  '/:bindingId',
  validate({ params: bindingIdParamSchema }),
  asyncHandler(sensorBindingController.unbind),
);

export default { assetScopedBindingRouter, sensorBindingRouter };
