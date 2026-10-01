/**
 * @file Shared test helpers: in-process broker, disposable database, polling.
 */

import http from 'node:http';
import net from 'node:net';

import { Aedes } from 'aedes';
import mongoose from 'mongoose';
import { connect } from 'mqtt';

import { loadCatalog } from '../scripts/lib/gateway.mjs';

/** Prefix every test database must carry. Anything else is refused. */
const TEST_DB_PREFIX = 'cdo_test_';

/**
 * Start an MQTT broker inside this process on a random port.
 *
 * @returns {Promise<{url: string, port: number, broker: any, stop: () => Promise<void>}>}
 */
export async function startBroker() {
  const broker = await Aedes.createBroker();
  const server = net.createServer(broker.handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    url: `mqtt://127.0.0.1:${port}`,
    port,
    broker,
    async stop() {
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Connect Mongoose to this process's disposable database.
 *
 * @returns {Promise<void>}
 */
export async function connectTestDatabase() {
  const { connectDatabase } = await import('../src/config/db.config.js');
  await connectDatabase();
  assertTestDatabase();
}

/**
 * Throw unless the connected database is a disposable test database.
 *
 * @returns {void}
 */
export function assertTestDatabase() {
  const name = mongoose.connection.name;
  if (!name?.startsWith(TEST_DB_PREFIX)) {
    throw new Error(
      `Refusing to touch database "${name}": test databases must start with "${TEST_DB_PREFIX}".`,
    );
  }
}

/**
 * Drop the test database and disconnect.
 *
 * @returns {Promise<void>}
 */
export async function dropTestDatabase() {
  assertTestDatabase();
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
}

/**
 * Poll until `check` returns a truthy value.
 *
 * @template T
 * @param {() => T|Promise<T>} check - Condition.
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.intervalMs]
 * @param {string} [options.message] - Failure message.
 * @returns {Promise<T>} The truthy value.
 */
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 25, message = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${message}`);
}

/**
 * A bare MQTT client for publishing hand-made (often malformed) messages.
 *
 * @param {string} url
 * @returns {Promise<{publish: (topic: string, payload: string|Buffer, opts?: object) => Promise<void>, end: () => Promise<void>}>}
 */
export async function rawClient(url) {
  const client = connect(url, { clientId: `test-raw-${Math.random().toString(16).slice(2)}` });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });

  return {
    publish: (topic, payload, opts = {}) =>
      new Promise((resolve, reject) => {
        client.publish(topic, payload, opts, (error) => (error ? reject(error) : resolve()));
      }),
    end: () => new Promise((resolve) => client.end(false, {}, resolve)),
  };
}

/**
 * Serve the Express app and a Socket.io server on a random port.
 *
 * @returns {Promise<{url: string, server: import('node:http').Server, stop: () => Promise<void>}>}
 */
export async function startHttp() {
  const { createApp } = await import('../src/app.js');
  const { attachWebsocket, closeWebsocket } = await import('../src/services/websocket.service.js');
  const { getSnapshot } = await import('../src/services/telemetry.service.js');

  const server = http.createServer(createApp());
  attachWebsocket(server, { getSnapshot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  return {
    url: `http://127.0.0.1:${port}`,
    server,
    async stop() {
      // `io.close()` also closes the HTTP server.
      await closeWebsocket();
      server.closeAllConnections?.();
    },
  };
}

/**
 * Recursively test whether any key in a value matches.
 *
 * @param {unknown} value
 * @param {(key: string) => boolean} predicate
 * @returns {boolean}
 */
export function hasKey(value, predicate) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, predicate));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => predicate(key) || hasKey(inner, predicate));
  }
  return false;
}

/**
 * The real catalog with fast cadences, so tests wait tenths of a second.
 *
 * @returns {any}
 */
export function fastCatalog() {
  const catalog = structuredClone(loadCatalog());
  for (const machine of Object.values(catalog.machines)) {
    machine.intervalMs = 200;
    if (machine.spectrum) machine.spectrum.intervalMs = 500;
  }
  return catalog;
}
