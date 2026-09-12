/**
 * @file Process entry point — boot sequence and graceful shutdown.
 *
 * @module server
 */

import { createApp } from './app.js';
import { config } from './config/env.config.js';
import { connectDatabase, disconnectDatabase } from './config/db.config.js';
import { ensureStorageReady } from './services/storage.service.js';

/**
 * Boot the service: prepare storage, connect the database, then listen.
 *
 * Order matters. Both dependencies are established *before* the port opens, so
 * the process never accepts a request it cannot serve — a server that answers
 * during startup with 500s is worse than one that is briefly unreachable.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  await ensureStorageReady();
  console.log(`[storage] Bucket root ready at ${config.storageRoot}`);

  await connectDatabase();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(
      `[server] Cognitive DataOps API listening on http://localhost:${config.port} ` +
        `(${config.nodeEnv})`,
    );
    console.log(`[server] Health check: http://localhost:${config.port}/api/v1/health`);
  });

  /**
   * Shut down cleanly: stop accepting connections, drain in-flight requests,
   * then close the database. Without this, an in-progress upload or transaction
   * is severed mid-write on every restart.
   *
   * @param {NodeJS.Signals} signal - The signal that triggered shutdown.
   * @returns {Promise<void>}
   */
  async function shutdown(signal) {
    console.log(`\n[server] ${signal} received, shutting down gracefully...`);

    // Hard ceiling on the drain phase: if a request is wedged, exit anyway
    // rather than hanging a container restart indefinitely.
    const forceExit = setTimeout(() => {
      console.error('[server] Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve(undefined)));
      });
      await disconnectDatabase();
      console.log('[server] Shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('[server] Error during shutdown:', error);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /**
   * A rejected promise nobody handled means state is now unknown. Log loudly
   * and exit so a supervisor restarts into a clean process, rather than
   * limping on in an indeterminate state.
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
    void shutdown('SIGTERM');
  });

  process.on('uncaughtException', (error) => {
    console.error('[server] Uncaught exception:', error);
    process.exit(1);
  });
}

bootstrap().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exit(1);
});
