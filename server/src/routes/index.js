/**
 * @file API v1 router — the single place every route is mounted.
 *
 * Versioning the whole surface under `/api/v1` from day one costs nothing now
 * and is the difference between "ship a breaking change" and "run both for a
 * fortnight" once Phase 3's telemetry clients exist.
 *
 * @module routes/index
 */

import { Router } from 'express';
import mongoose from 'mongoose';

import { assetRouter } from './asset.routes.js';
import { meshNodeRouter } from './meshNode.routes.js';
import { sensorBindingRouter } from './sensorBinding.routes.js';
import { sendOk } from '../utils/ApiResponse.js';

/** @type {import('express').Router} */
export const apiRouter = Router();

/**
 * `GET /api/v1/health` — liveness and dependency check.
 *
 * Reports the MongoDB connection state rather than a bare `"ok"`, because the
 * failure this needs to catch is "API is up but the database is not" — the case
 * where every real endpoint 500s while a naive health check stays green.
 */
apiRouter.get('/health', (_req, res) => {
  /** @type {Record<number, string>} Mongoose readyState codes. */
  const readyStates = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };

  const dbState = readyStates[mongoose.connection.readyState] ?? 'unknown';

  return sendOk(
    res,
    {
      status: dbState === 'connected' ? 'healthy' : 'degraded',
      database: dbState,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    },
    'Health check',
  );
});

apiRouter.use('/assets', assetRouter);
apiRouter.use('/mesh-nodes', meshNodeRouter);
apiRouter.use('/sensor-bindings', sensorBindingRouter);

export default apiRouter;
