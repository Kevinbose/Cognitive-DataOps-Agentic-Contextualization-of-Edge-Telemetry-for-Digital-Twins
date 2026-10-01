/**
 * @file Device routes, mounted at `/api/v1/devices`.
 *
 * @module routes/device.routes
 */

import { Router } from 'express';

import * as deviceController from '../controllers/device.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireAllowedOrigin } from '../middleware/origin.middleware.js';
import { validate } from '../middleware/validate.middleware.js';
import { commandBodySchema, machineIdParamSchema } from '../validators/device.validator.js';

/** @type {import('express').Router} */
export const deviceRouter = Router();

deviceRouter.get('/', deviceController.listDevices);

deviceRouter.post(
  '/:machineId/commands',
  requireAllowedOrigin,
  validate({ params: machineIdParamSchema, body: commandBodySchema }),
  asyncHandler(deviceController.sendCommand),
);

deviceRouter.get(
  '/:machineId/sim',
  validate({ params: machineIdParamSchema }),
  asyncHandler(deviceController.getSim),
);

export default deviceRouter;
