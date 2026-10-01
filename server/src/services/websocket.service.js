/**
 * @file Socket.io transport to the browser.
 *
 * The browser never talks to the MQTT broker. It talks to this server, which
 * keeps broker credentials out of the page and makes every sample pass
 * validation and binding resolution before a user sees it.
 *
 * This module is transport only. It knows event names and delivery rules, and
 * nothing about what a telemetry sample means; `telemetry.service.js` calls the
 * `emit*` helpers below. The dependency points one way (telemetry to websocket),
 * so the initial `snapshot` content is passed in as a function rather than
 * imported.
 *
 * ## Delivery rules
 *
 * - High-rate events (`telemetry:batch`, `spectrum:frame`) are **volatile**: if
 *   a client cannot keep up, the message is dropped for that client instead of
 *   queueing. A slow tab must never accumulate a backlog of stale values.
 * - Low-rate events (`device:update`, `device:ack`, `twin:invalidate`) are
 *   reliable.
 * - A client connecting mid-stream gets a `snapshot` immediately, so a fresh
 *   tab is never blank while it waits for the next sample.
 *
 * @module services/websocket.service
 */

import { Server } from 'socket.io';
import mongoose from 'mongoose';

import { config } from '../config/env.config.js';
import { DOMAIN_EVENT, onDomainEvent } from '../utils/domainEvents.js';

/** @type {import('socket.io').Server|null} */
let io = null;
/** @type {(() => void)|null} */
let unsubscribeEvents = null;

/**
 * Attach Socket.io to an HTTP server.
 *
 * @param {import('node:http').Server} httpServer - The server that also serves REST.
 * @param {object} options
 * @param {() => object} options.getSnapshot - Builds the payload sent on connect.
 * @param {string[]} [options.allowedOrigins] - Browser origins allowed to connect.
 * @returns {import('socket.io').Server} The Socket.io server.
 */
export function attachWebsocket(httpServer, { getSnapshot, allowedOrigins = config.corsOrigins }) {
  io = new Server(httpServer, {
    serveClient: false,
    maxHttpBufferSize: 100_000,
    // `cors` only sets response headers for the polling handshake. It does NOT
    // stop a cross-site page from opening a WebSocket: browsers do not apply
    // CORS to the WebSocket upgrade. `allowRequest` below is what enforces it.
    cors: { origin: allowedOrigins },
    allowRequest(request, callback) {
      const origin = request.headers.origin;

      // No Origin header means a non-browser client (tests, curl, a script).
      // The check exists to stop other websites, which always send one.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback('Origin not allowed', false);
    },
  });

  io.on('connection', (socket) => {
    socket.emit('snapshot', getSnapshot());

    // A twin page joins a room per asset so `twin:invalidate` reaches only the
    // tabs that have that asset open.
    socket.on('subscribe:asset', (assetId) => {
      if (typeof assetId === 'string' && mongoose.Types.ObjectId.isValid(assetId)) {
        void socket.join(`asset:${assetId}`);
      }
    });

    socket.on('unsubscribe:asset', (assetId) => {
      if (typeof assetId === 'string') void socket.leave(`asset:${assetId}`);
    });
  });

  unsubscribeEvents = onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, ({ assetIds }) => {
    for (const assetId of assetIds ?? []) emitTwinInvalidate(assetId);
  });

  return io;
}

/**
 * Broadcast a coalesced batch of telemetry samples. Volatile.
 *
 * @param {object[]} samples - Normalised samples.
 * @returns {void}
 */
export function emitTelemetryBatch(samples) {
  if (io && samples.length > 0) io.volatile.emit('telemetry:batch', samples);
}

/**
 * Broadcast one spectrum frame. Volatile.
 *
 * @param {{machineId: string, key: string, ts: number, amp: number[]}} frame
 * @returns {void}
 */
export function emitSpectrumFrame(frame) {
  io?.volatile.emit('spectrum:frame', frame);
}

/**
 * Broadcast a device state or diagnostics change.
 *
 * @param {object} device - Public device view (never includes simulator truth).
 * @returns {void}
 */
export function emitDeviceUpdate(device) {
  io?.emit('device:update', device);
}

/**
 * Broadcast a command acknowledgement (or timeout).
 *
 * @param {object} ack
 * @returns {void}
 */
export function emitDeviceAck(ack) {
  io?.emit('device:ack', ack);
}

/**
 * Tell tabs viewing an asset that its scene changed and should be refetched.
 *
 * @param {string} assetId - Asset id.
 * @returns {void}
 */
export function emitTwinInvalidate(assetId) {
  io?.to(`asset:${assetId}`).emit('twin:invalidate', { assetId });
}

/**
 * @returns {{clients: number}} Counters for `/health`.
 */
export function getSocketStats() {
  return { clients: io?.engine?.clientsCount ?? 0 };
}

/**
 * Disconnect every client, close the engine and close the HTTP server.
 *
 * `io.close()` closes the HTTP server itself, so the caller must NOT call
 * `server.close()` afterwards: it would throw `ERR_SERVER_NOT_RUNNING` and turn
 * a clean shutdown into a failure.
 *
 * @returns {Promise<void>}
 */
export async function closeWebsocket() {
  unsubscribeEvents?.();
  unsubscribeEvents = null;

  if (!io) return;
  const server = io;
  io = null;
  await server.close();
}

export default {
  attachWebsocket,
  emitTelemetryBatch,
  emitSpectrumFrame,
  emitDeviceUpdate,
  emitDeviceAck,
  emitTwinInvalidate,
  getSocketStats,
  closeWebsocket,
};
