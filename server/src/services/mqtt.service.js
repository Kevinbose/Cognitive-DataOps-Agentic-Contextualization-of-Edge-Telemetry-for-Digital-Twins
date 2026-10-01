/**
 * @file MQTT transport — connection, subscription and publishing. Nothing else.
 *
 * This module owns the broker connection and knows nothing about telemetry. It
 * hands every inbound message to a handler supplied by the caller
 * (`telemetry.service.js`) and offers `publish`. Keeping it that thin means the
 * interesting logic can be tested without a broker, and the broker can be
 * swapped (HiveMQ Cloud, local Mosquitto, the in-process aedes used by the
 * tests) by changing one URL.
 *
 * Behaviours worth knowing:
 *
 * - **The server boots without a broker.** `startMqtt` returns as soon as the
 *   client exists; connecting and reconnecting (every 2 s) happen in the
 *   background. REST and the twin viewer must keep working when the broker is
 *   unreachable.
 * - **Subscriptions are made on every `connect`.** The session is clean, so the
 *   broker forgets them on disconnect. The library's own `resubscribe` is
 *   turned off so they are not registered twice.
 * - **A handler can never crash the process.** Each message is dispatched inside
 *   a try/catch, including a rejected promise from an async handler; a bad
 *   payload must not become an unhandled rejection.
 * - **Retained messages replay on every (re)connect.** That is how the device
 *   registry is rebuilt after a restart, and why handlers must be idempotent.
 *
 * @module services/mqtt.service
 */

import os from 'node:os';

import { connect } from 'mqtt';

import { subscriptionFilters } from '../utils/mqttTopics.js';

/**
 * @callback MessageHandler
 * @param {string} topic - Topic the message arrived on.
 * @param {Buffer} payload - Raw payload.
 * @param {{retain: boolean, qos: number}} packet - Delivery metadata.
 * @returns {void|Promise<void>}
 */

/** @type {import('mqtt').MqttClient|null} */
let client = null;
/** @type {MessageHandler|null} */
let handler = null;
/** When false, messages are ignored. Cleared first during shutdown. */
let consuming = false;

const status = {
  /** @type {'disabled'|'connecting'|'connected'|'reconnecting'|'closed'} */
  state: 'disabled',
  broker: /** @type {string|null} */ (null),
  messagesIn: 0,
  lastMessageAt: /** @type {number|null} */ (null),
  reconnects: 0,
  lastError: /** @type {string|null} */ (null),
};

let lastErrorLoggedAt = 0;

/**
 * Connect to the broker and start delivering messages to `onMessage`.
 *
 * @param {object} options
 * @param {string} options.url - `mqtt://host:1883` or `mqtts://host:8883`. No credentials.
 * @param {string|null} [options.username] - Broker username.
 * @param {string|null} [options.password] - Broker password.
 * @param {string} options.siteId - Site id used to build subscription filters.
 * @param {MessageHandler} options.onMessage - Receives every inbound message.
 * @param {string} [options.clientId] - Override the generated client id.
 * @param {number} [options.reconnectPeriodMs] - Delay between reconnect attempts.
 * @returns {import('mqtt').MqttClient} The client (already connecting).
 */
export function startMqtt({
  url,
  username = null,
  password = null,
  siteId,
  onMessage,
  clientId,
  reconnectPeriodMs = 2000,
}) {
  if (client) throw new Error('MQTT client already started');

  handler = onMessage;
  consuming = true;

  status.state = 'connecting';
  status.broker = new URL(url).host;
  status.lastError = null;

  const id =
    clientId ?? `cdo-backend-${os.hostname().replace(/[^a-zA-Z0-9-]/g, '')}-${process.pid}`;

  client = connect(url, {
    clientId: id,
    username: username ?? undefined,
    password: password ?? undefined,
    clean: true,
    keepalive: 30,
    reconnectPeriod: reconnectPeriodMs,
    connectTimeout: 10_000,
    resubscribe: false,
  });

  client.on('connect', () => {
    status.state = 'connected';
    status.lastError = null;

    const filters = subscriptionFilters(siteId);
    client?.subscribe(
      Object.fromEntries(filters.map(({ filter, qos }) => [filter, { qos }])),
      (error) => {
        if (error) {
          status.lastError = `subscribe failed: ${error.message}`;
          console.error(`[mqtt] ${status.lastError}`);
        } else {
          console.log(
            `[mqtt] Connected to ${status.broker}, subscribed to ${filters.length} topic filters`,
          );
        }
      },
    );
  });

  client.on('reconnect', () => {
    status.state = 'reconnecting';
    status.reconnects += 1;
  });

  client.on('close', () => {
    if (status.state !== 'closed') status.state = 'reconnecting';
  });

  client.on('error', (error) => {
    status.lastError = error.message;
    // A down broker raises this every reconnect attempt; log it at most every
    // ten seconds so the console stays readable.
    const now = Date.now();
    if (now - lastErrorLoggedAt > 10_000) {
      lastErrorLoggedAt = now;
      console.error(`[mqtt] ${error.message}`);
    }
  });

  client.on('message', (topic, payload, packet) => {
    if (!consuming || !handler) return;

    status.messagesIn += 1;
    status.lastMessageAt = Date.now();

    try {
      const result = handler(topic, payload, { retain: packet.retain, qos: packet.qos });
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          console.error(`[mqtt] Handler failed for ${topic}:`, error?.message ?? error);
        });
      }
    } catch (error) {
      console.error(`[mqtt] Handler threw for ${topic}:`, error?.message ?? error);
    }
  });

  return client;
}

/**
 * Publish a message.
 *
 * @param {string} topic - Destination topic.
 * @param {string|Buffer} payload - Message body.
 * @param {object} [options]
 * @param {0|1|2} [options.qos] - Delivery guarantee. Default 0.
 * @param {boolean} [options.retain] - Retain on the broker. Default false.
 * @returns {Promise<void>} Resolves when the broker has accepted the publish.
 * @throws {Error} When not connected: a command must fail visibly, never queue
 *   invisibly and fire after the operator has moved on.
 */
export function publish(topic, payload, { qos = 0, retain = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error('MQTT broker is not connected'));
      return;
    }
    client.publish(topic, payload, { qos, retain }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Wait until the client is connected. Used by tests and start-up scripts.
 *
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<void>}
 * @throws {Error} On timeout.
 */
export function waitForConnection(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (client?.connected) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      client?.off('connect', onConnect);
      reject(new Error(`MQTT did not connect within ${timeoutMs} ms`));
    }, timeoutMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve();
    };
    client?.once('connect', onConnect);
  });
}

/**
 * Stop delivering messages to the handler. The connection stays open.
 *
 * First step of shutdown: no new work enters the pipeline while it drains.
 * @returns {void}
 */
export function stopConsuming() {
  consuming = false;
}

/**
 * Close the broker connection.
 *
 * @param {boolean} [force] - Skip waiting for in-flight packets.
 * @returns {Promise<void>}
 */
export async function endMqtt(force = false) {
  consuming = false;
  status.state = 'closed';
  if (!client) return;

  const closing = client;
  client = null;
  handler = null;
  await closing.endAsync(force);
}

/**
 * @returns {{state: string, broker: string|null, messagesIn: number,
 *   lastMessageAt: number|null, reconnects: number, lastError: string|null}}
 *   Counters for `/health`. Never includes credentials.
 */
export function getMqttStatus() {
  return { ...status };
}

/**
 * Reset counters. Test-only.
 * @returns {void}
 */
export function resetMqttForTests() {
  status.state = 'disabled';
  status.broker = null;
  status.messagesIn = 0;
  status.lastMessageAt = null;
  status.reconnects = 0;
  status.lastError = null;
}

export default {
  startMqtt,
  publish,
  waitForConnection,
  stopConsuming,
  endMqtt,
  getMqttStatus,
  resetMqttForTests,
};
