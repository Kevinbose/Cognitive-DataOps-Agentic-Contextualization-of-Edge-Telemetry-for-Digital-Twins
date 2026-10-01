/**
 * @file MQTT topic grammar for contract v1.
 *
 * ```
 * cdo/v1/{siteId}/{machineId}/{suffix}
 * ```
 *
 * Every topic an incoming message arrives on is parsed here with a strict
 * regular expression before anything else happens. The machine id in a topic
 * ends up in database keys and websocket payloads, so the parser is also the
 * injection guard: a topic that does not match the grammar byte for byte is
 * rejected, never partially interpreted.
 *
 * @module utils/mqttTopics
 */

/** Root of the namespace. Bumped only with a breaking contract change. */
export const TOPIC_ROOT = 'cdo/v1';

/** `robot-weld-01`, `press-stamp-01`: lowercase kebab. */
export const MACHINE_ID_PATTERN = /^[a-z0-9-]{1,48}$/;

/** `AXIS_4_SERVO_TORQUE`: upper snake, leading letter. */
export const CHANNEL_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** `vit-lab`. */
export const SITE_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Suffixes a device publishes and the backend consumes.
 * @readonly
 */
export const INBOUND_SUFFIXES = Object.freeze([
  'birth',
  'status',
  'telemetry',
  'spectrum',
  'diag',
  'log',
  'ack',
]);

/**
 * Command names the backend may publish under `cmd/`.
 * @readonly
 */
export const COMMAND_NAMES = Object.freeze(['scenario', 'interval', 'reboot', 'ping']);

/**
 * Subscription QoS per inbound suffix. Identity and acknowledgements must not
 * be lost; high-rate data tolerates loss, and a QoS 1 subscription on it would
 * only add broker bookkeeping.
 * @type {Readonly<Record<string, 0|1>>}
 */
export const SUBSCRIPTION_QOS = Object.freeze({
  birth: 1,
  status: 1,
  ack: 1,
  telemetry: 0,
  spectrum: 0,
  diag: 0,
  log: 0,
});

const INBOUND_PATTERN = new RegExp(
  `^${TOPIC_ROOT}/([a-z0-9-]{1,32})/([a-z0-9-]{1,48})/(${INBOUND_SUFFIXES.join('|')})$`,
);

/**
 * @typedef {object} ParsedTopic
 * @property {string} siteId
 * @property {string} machineId
 * @property {string} suffix - One of {@link INBOUND_SUFFIXES}.
 */

/**
 * Parse an inbound topic.
 *
 * @param {string} topic - Topic the message arrived on.
 * @param {string} expectedSiteId - The configured site; other sites are ignored.
 * @returns {ParsedTopic|null} The parts, or `null` when the topic is not ours.
 */
export function parseInboundTopic(topic, expectedSiteId) {
  if (typeof topic !== 'string' || topic.length > 160) return null;

  const match = INBOUND_PATTERN.exec(topic);
  if (!match) return null;

  const [, siteId, machineId, suffix] = match;
  if (siteId !== expectedSiteId) return null;

  return { siteId, machineId, suffix };
}

/**
 * Build a topic string.
 *
 * @param {string} siteId - Site id.
 * @param {string} machineId - Machine id.
 * @param {string} suffix - Topic suffix, e.g. `telemetry` or `cmd/scenario`.
 * @returns {string} Full topic.
 */
export function buildTopic(siteId, machineId, suffix) {
  return `${TOPIC_ROOT}/${siteId}/${machineId}/${suffix}`;
}

/**
 * Explicit subscription filters for the backend.
 *
 * One filter per suffix rather than `+/+`: a two-level wildcard would not match
 * `cmd/scenario`, and explicit filters keep the broker permission model honest
 * (the backend never subscribes to its own command topics).
 *
 * @param {string} siteId - Site id.
 * @returns {Array<{filter: string, qos: 0|1}>} Filters with their QoS.
 */
export function subscriptionFilters(siteId) {
  return INBOUND_SUFFIXES.map((suffix) => ({
    filter: `${TOPIC_ROOT}/${siteId}/+/${suffix}`,
    qos: SUBSCRIPTION_QOS[suffix],
  }));
}

/**
 * Global sensor identifier for a channel: `MACHINE_ID.CHANNEL_KEY`, upper case.
 *
 * Satisfies `sensorIdSchema` (letters, digits, underscore, hyphen, dot), so a
 * channel id can be typed into the binding form or chosen from the dropdown
 * with no mapping layer in between.
 *
 * @param {string} machineId - Machine id (lowercase kebab).
 * @param {string} channelKey - Channel key (upper snake).
 * @returns {string} e.g. `PRESS-STAMP-01.LUBE_OIL_PRESSURE`.
 */
export function sensorIdFor(machineId, channelKey) {
  return `${machineId.toUpperCase()}.${channelKey}`;
}

export default {
  TOPIC_ROOT,
  MACHINE_ID_PATTERN,
  CHANNEL_KEY_PATTERN,
  SITE_ID_PATTERN,
  INBOUND_SUFFIXES,
  COMMAND_NAMES,
  SUBSCRIPTION_QOS,
  parseInboundTopic,
  buildTopic,
  subscriptionFilters,
  sensorIdFor,
};
