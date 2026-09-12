/**
 * @file Express application assembly.
 *
 * Exported without being started so tests can import the app and drive it with
 * Supertest, while `server.js` owns the network listener and process lifecycle.
 *
 * Middleware order is load-bearing and should not be shuffled:
 *   security headers → CORS → body parsers → logging → static → routes
 *   → 404 → error handler (always last).
 *
 * @module app
 */

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';

import { config } from './config/env.config.js';
import { STORAGE_ROOT } from './config/storage.config.js';
import { errorHandler } from './middleware/errorHandler.middleware.js';
import { notFoundHandler } from './middleware/notFound.middleware.js';
import { apiRouter } from './routes/index.js';

/**
 * Build the configured Express application.
 *
 * @returns {import('express').Express} The assembled app.
 */
export function createApp() {
  const app = express();

  /* ─── Security ───────────────────────────────────────────────────────────── */

  app.use(
    helmet({
      // The default `cross-origin` resource policy would block the browser from
      // loading `.glb` files served here into a canvas hosted on the Vite dev
      // origin (5173). The static mount serves public, non-sensitive geometry.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      // No HTML is served from this origin, so the CSP has nothing to protect
      // and its default directives interfere with static asset delivery.
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // A missing Origin header means a non-browser client (curl, Postman,
        // server-to-server). CORS is a browser policy, so there is nothing to
        // enforce for those and rejecting them would only break tooling.
        if (!origin) return callback(null, true);

        if (config.corsOrigins.includes(origin)) return callback(null, true);

        return callback(new Error(`Origin "${origin}" is not allowed by CORS policy`));
      },
      credentials: true,
    }),
  );

  /* ─── Body parsing ───────────────────────────────────────────────────────── */

  // Modest JSON limit: every large payload in this API is a file upload, and
  // those go through Multer's multipart path with its own size ceilings.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  /* ─── Logging ────────────────────────────────────────────────────────────── */

  if (!config.isTest) {
    app.use(morgan(config.isProduction ? 'combined' : 'dev'));
  }

  /* ─── Static asset delivery ──────────────────────────────────────────────── */

  /**
   * Serve stored binaries directly.
   *
   * This is how the 3D viewer loads meshes. It bypasses the controller layer on
   * purpose: `express.static` handles HTTP range requests, conditional GETs, and
   * ETags, all of which streaming glTF loaders rely on and none of which a
   * hand-rolled `res.sendFile` controller would provide.
   *
   * Everything under `storage/` is non-sensitive geometry. The `.tmp-uploads`
   * staging directory is explicitly excluded — an in-flight, unvalidated upload
   * must never be publicly reachable.
   */
  app.use(
    '/static',
    (req, res, next) => {
      if (req.path.startsWith('/.tmp-uploads')) {
        res.status(404).end();
        return;
      }
      next();
    },
    express.static(STORAGE_ROOT, {
      // Meshes are immutable per version — the `?v=` cache-buster changes when
      // the file does — so a long max-age is safe and avoids refetching
      // multi-megabyte geometry on every navigation.
      maxAge: config.isProduction ? '7d' : 0,
      etag: true,
      index: false,
      dotfiles: 'deny',
    }),
  );

  /* ─── API ────────────────────────────────────────────────────────────────── */

  app.use('/api/v1', apiRouter);

  /**
   * Root banner. Purely a developer convenience so hitting the bare origin
   * explains what this service is instead of returning a bald 404.
   */
  app.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        service: 'Cognitive DataOps API',
        version: '0.1.0',
        docs: '/api/v1/health',
      },
      message: 'Cognitive DataOps — Agentic Contextualization of Edge Telemetry for Digital Twins',
    });
  });

  /* ─── Terminal handlers ──────────────────────────────────────────────────── */

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
