/**
 * @file Telemetry routes, mounted at `/api/v1/telemetry`.
 *
 * @module routes/telemetry.routes
 */

import { Router } from 'express';

import * as telemetryController from '../controllers/telemetry.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  historyQuerySchema,
  latestQuerySchema,
  spectrumQuerySchema,
} from '../validators/telemetry.validator.js';

/** @type {import('express').Router} */
export const telemetryRouter = Router();

telemetryRouter.get(
  '/latest',
  validate({ query: latestQuerySchema }),
  telemetryController.getLatest,
);

telemetryRouter.get(
  '/history',
  validate({ query: historyQuerySchema }),
  asyncHandler(telemetryController.getHistory),
);

telemetryRouter.get(
  '/spectrum/latest',
  validate({ query: spectrumQuerySchema }),
  asyncHandler(telemetryController.getLatestSpectrum),
);

export default telemetryRouter;
