/**
 * @file Process entry point — boot sequence and graceful shutdown.
 *
 * @module server
 */

import http from 'node:http';

import { createApp } from './app.js';
import { config } from './config/env.config.js';
import { connectDatabase, disconnectDatabase } from './config/db.config.js';
import { startBindingIndex, stopBindingIndex } from './services/bindingIndex.service.js';
import { endMqtt, stopConsuming } from './services/mqtt.service.js';
import { ensureStorageReady } from './services/storage.service.js';
import { getSnapshot, startIngestion, stopIngestion } from './services/telemetry.service.js';
import { ensureTelemetryStore } from './services/telemetryStore.service.js';
import { attachWebsocket, closeWebsocket } from './services/websocket.service.js';
import { isShuttingDown, registerShutdownHook, runShutdownHooks } from './utils/lifecycle.js';

/**
 * Open the listening socket, surfacing a bind failure as a rejection.
 *
 * `app.listen` would print its "listening" banner even when the port is taken,
 * because its callback also receives the error and the original ignored it.
 *
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Boot the service: prepare storage, connect the database, then listen.
 *
 * Order matters. Both dependencies are established *before* the port opens, so
 * the process never accepts a request it cannot serve — a server that answers
 * during startup with 500s is worse than one that is briefly unreachable.
 * Telemetry ingestion starts last and is optional: without `MQTT_URL` the
 * server behaves exactly as it did in Phases 1 and 2.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  await ensureStorageReady();
  console.log(`[storage] Bucket root ready at ${config.storageRoot}`);

  await connectDatabase();
  // Registered first, so it runs last: the database must outlive every service
  // that might still be writing to it while the others stop.
  registerShutdownHook('database', () => disconnectDatabase());

  const ingestionEnabled = config.mqtt.url !== null;

  if (ingestionEnabled && config.telemetry.persist) {
    await ensureTelemetryStore();
  }

  const app = createApp();
  const server = http.createServer(app);
  attachWebsocket(server, { getSnapshot });

  await listen(server);
  // A listen error after start-up (rare) must not be silent.
  server.on('error', (error) => console.error('[server] HTTP server error:', error));

  console.log(
    `[server] Cognitive DataOps API listening on http://${config.host}:${config.port} ` +
      `(${config.nodeEnv})`,
  );
  console.log(`[server] Health check: http://${config.host}:${config.port}/api/v1/health`);

  if (ingestionEnabled) {
    await startBindingIndex();
    await startIngestion();
    console.log(
      `[server] Telemetry ingestion enabled (site "${config.mqtt.siteId}", ` +
        `persistence ${config.telemetry.persist ? 'on' : 'off'}, ` +
        `device commands ${config.enableDeviceCommands ? 'ON' : 'off'})`,
    );
  } else {
    console.log('[server] MQTT_URL is not set; telemetry ingestion is disabled');
  }

  /*
   * Teardown order (hooks run in REVERSE registration order, so the list below
   * reads bottom-up as "what happens first"):
   *
   *   1. stop consuming MQTT       no new work enters the pipeline
   *   2. close sockets and HTTP    `io.close()` also closes the HTTP server;
   *                                calling `server.close()` again would throw
   *   3. flush telemetry           write what is buffered, bounded by a timeout
   *   4. end the MQTT connection
   *   5. disconnect the database   (registered earlier, runs last)
   */
  registerShutdownHook('mqtt-end', () => endMqtt(), { timeoutMs: 3000 });
  registerShutdownHook(
    'telemetry-flush',
    async () => {
      stopBindingIndex();
      await stopIngestion();
    },
    { timeoutMs: 4000 },
  );
  registerShutdownHook('websocket-and-http', () => closeWebsocket(), { timeoutMs: 4000 });
  registerShutdownHook('mqtt-stop-consuming', () => stopConsuming());

  /**
   * Shut down cleanly.
   *
   * @param {string} signal - What triggered it, for the log.
   * @param {number} exitCode - 0 for a requested stop, 1 for a fault.
   * @returns {Promise<void>}
   */
  async function shutdown(signal, exitCode) {
    // A second signal, or a rejection raised during teardown, must not start a
    // second teardown on top of the first.
    if (isShuttingDown()) return;
    console.log(`\n[server] ${signal} received, shutting down gracefully...`);

    // Hard ceiling: if something is wedged, exit anyway rather than hanging a
    // supervisor's restart indefinitely.
    const forceExit = setTimeout(() => {
      console.error('[server] Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    const { ok, failed } = await runShutdownHooks();
    console.log(ok ? '[server] Shutdown complete' : `[server] Shutdown finished with failures: ${failed.join(', ')}`);
    process.exit(ok ? exitCode : 1);
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));

  /**
   * A rejected promise nobody handled means state is now unknown. Log loudly
   * and shut down with a NON-ZERO code, so a supervisor sees a crash rather
   * than a clean stop and restarts into a known-good process. (`node --watch`
   * itself waits for a file change after any exit, so this helps supervisors,
   * not the dev runner.)
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[server] Unhandled promise rejection:', reason);
    void shutdown('unhandledRejection', 1);
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
