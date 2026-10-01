/**
 * @file Routes for the machines added to a twin.
 *
 * A gateway announces itself and is listed by `GET /devices`. Adding it here is
 * the deliberate step that makes its channels bindable on this twin.
 *
 * @module routes/machine.routes
 */

import { Router } from 'express';

import * as machineController from '../controllers/machine.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.middleware.js';
import { assetIdParamSchema } from '../validators/common.validator.js';
import { addMachineBodySchema, assetMachineParamSchema } from '../validators/device.validator.js';

/**
 * Routes mounted at `/api/v1/assets/:assetId/machines`.
 * @type {import('express').Router}
 */
export const assetScopedMachineRouter = Router({ mergeParams: true });

assetScopedMachineRouter.get('/', validate({ params: assetIdParamSchema }), machineController.listMachines);

assetScopedMachineRouter.post(
  '/',
  validate({ params: assetIdParamSchema, body: addMachineBodySchema }),
  asyncHandler(machineController.addMachine),
);

assetScopedMachineRouter.delete(
  '/:machineId',
  validate({ params: assetMachineParamSchema }),
  asyncHandler(machineController.removeMachine),
);

export default assetScopedMachineRouter;
