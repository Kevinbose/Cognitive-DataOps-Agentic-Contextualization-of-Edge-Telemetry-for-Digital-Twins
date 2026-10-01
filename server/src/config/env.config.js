/**
 * @file Centralised environment configuration.
 *
 * Every `process.env` read in the codebase happens HERE and nowhere else.
 * That gives us a single fail-fast boundary: if a required variable is missing
 * or malformed, the process refuses to boot with an actionable message instead
 * of throwing a confusing `undefined` error deep inside a request handler.
 *
 * @module config/env.config
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Absolute path to the `server/` workspace directory.
 * Derived from this file's own location (`server/src/config/env.config.js`),
 * so it stays correct no matter what the current working directory is —
 * `npm run dev` from the repo root and `node src/server.js` from `server/`
 * both resolve identically.
 * @type {string}
 */
export const SERVER_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Absolute path to the monorepo root (the parent of `server/` and `client/`).
 * @type {string}
 */
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

// Load `server/.env` if present. Absent file is not fatal — real deployments
// inject variables through the platform rather than a dotfile.
//
// Never under test: a test run must not inherit a developer's real database,
// broker or feature switches. `test/setup.js` sets everything a test relies on.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: path.join(SERVER_ROOT, '.env') });
}

/**
 * Read a required string variable, or throw a descriptive boot-time error.
 *
 * @param {string} key - Environment variable name.
 * @param {string} [fallback] - Value used when the variable is unset. When
 *   omitted, the variable is treated as mandatory.
 * @returns {string} The resolved value.
 * @throws {Error} When the variable is unset and no fallback was supplied.
 */
function readString(key, fallback) {
  const raw = process.env[key];
  if (raw !== undefined && raw !== '') return raw;
  if (fallback !== undefined) return fallback;
  throw new Error(
    `[env] Missing required environment variable "${key}". ` +
      `Copy server/.env.example to server/.env and fill it in.`,
  );
}

/**
 * Read a variable that must parse as a positive integer.
 *
 * @param {string} key - Environment variable name.
 * @param {number} fallback - Value used when the variable is unset.
 * @returns {number} The parsed integer.
 * @throws {Error} When the value is present but not a positive integer.
 */
function readPositiveInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[env] "${key}" must be a positive integer, received "${raw}".`);
  }
  return parsed;
}

/**
 * Read a variable that must parse as a non-negative integer (zero allowed).
 *
 * `readPositiveInt` rejects 0, which is the wrong rule for switches such as a
 * retention of "0 = keep nothing" or a rate of "0 = unlimited".
 *
 * @param {string} key - Environment variable name.
 * @param {number} fallback - Value used when the variable is unset.
 * @returns {number} The parsed integer.
 * @throws {Error} When the value is present but not a non-negative integer.
 */
function readNonNegativeInt(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`[env] "${key}" must be a non-negative integer, received "${raw}".`);
  }
  return parsed;
}

/**
 * Read a boolean switch from literal tokens.
 *
 * Matches tokens instead of calling `Boolean()`, because `Boolean("false")` is
 * `true` and a flag that reads as off but behaves as on is the worst kind of
 * configuration bug. Anything ambiguous fails the boot.
 *
 * @param {string} key - Environment variable name.
 * @param {boolean} fallback - Value used when the variable is unset.
 * @returns {boolean} The parsed flag.
 * @throws {Error} When the value is not a recognised boolean token.
 */
function readBool(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;

  const token = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(token)) return true;
  if (['false', '0', 'no', 'off'].includes(token)) return false;
  throw new Error(`[env] "${key}" must be true or false, received "${raw}".`);
}

/**
 * Read a string that must be one of a fixed set of values.
 *
 * @param {string} key - Environment variable name.
 * @param {readonly string[]} allowed - Accepted values.
 * @param {string} fallback - Value used when the variable is unset.
 * @returns {string} The validated value.
 * @throws {Error} When the value is not in `allowed`.
 */
function readEnum(key, allowed, fallback) {
  const value = readString(key, fallback);
  if (!allowed.includes(value)) {
    throw new Error(`[env] "${key}" must be one of ${allowed.join(', ')}, received "${value}".`);
  }
  return value;
}

/**
 * Read an optional string: `null` when unset or empty, never an exception.
 *
 * @param {string} key - Environment variable name.
 * @returns {string|null} The value, or `null`.
 */
function readOptionalString(key) {
  const raw = process.env[key];
  return raw !== undefined && raw !== '' ? raw : null;
}

/**
 * Read a comma-separated list into a trimmed, non-empty string array.
 *
 * @param {string} key - Environment variable name.
 * @param {string} fallback - Comma-separated default.
 * @returns {string[]} Parsed list.
 */
function readList(key, fallback) {
  return readString(key, fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const nodeEnv = readEnum('NODE_ENV', ['development', 'production', 'test'], 'development');

/** `MQTT_URL` decides whether ingestion runs at all; see `mqtt.service.js`. */
const mqttUrl = readOptionalString('MQTT_URL');
// `@` is excluded from the host part so `user:password@host` cannot slip through.
if (mqttUrl !== null && !/^mqtts?:\/\/[^\s/@]+(:\d+)?$/.test(mqttUrl)) {
  // Never echo a password back into a log or terminal: redact any userinfo.
  const redacted = mqttUrl.replace(/\/\/[^/@\s]*@/, '//***@');
  throw new Error(
    `[env] "MQTT_URL" must look like mqtt://host:1883 or mqtts://host:8883 (no path, no credentials), ` +
      `received "${redacted}". Put the credentials in MQTT_USERNAME and MQTT_PASSWORD.`,
  );
}

const mqttSiteId = readString('MQTT_SITE_ID', 'vit-lab');
if (!/^[a-z0-9-]{1,32}$/.test(mqttSiteId)) {
  throw new Error(`[env] "MQTT_SITE_ID" must match ^[a-z0-9-]{1,32}$, received "${mqttSiteId}".`);
}

/** Megabyte-to-byte multiplier. */
const MB = 1024 * 1024;

/**
 * Frozen, validated application configuration.
 *
 * @typedef {object} AppConfig
 * @property {string}   nodeEnv          - `development` | `production` | `test`.
 * @property {boolean}  isProduction     - Convenience flag for `nodeEnv === 'production'`.
 * @property {boolean}  isTest           - Convenience flag for `nodeEnv === 'test'`.
 * @property {number}   port             - TCP port for the HTTP server.
 * @property {string}   mongoUri         - MongoDB connection string.
 * @property {string}   storageRoot      - Absolute path to the asset storage bucket root.
 * @property {string[]} corsOrigins      - Allow-listed browser origins.
 * @property {number}   maxCadUploadBytes - Upload ceiling for raw CAD files, in bytes.
 * @property {number}   maxGlbUploadBytes - Upload ceiling for converted `.glb` files, in bytes.
 * @property {string}   host             - Interface the HTTP server binds to.
 * @property {{url: string|null, username: string|null, password: string|null, siteId: string}} mqtt
 *   Broker settings. Ingestion is enabled only when `url` is set.
 * @property {{persist: boolean, persistHz: number, retentionHours: number, emitHzMax: number, bufferMax: number}} telemetry
 *   Ingestion and persistence tuning.
 * @property {boolean}  enableDeviceCommands - Whether `POST /devices/:id/commands` is live.
 * @property {number}   commandMinIntervalMs - Per-device command rate limit; 0 disables it.
 */

/** @type {Readonly<AppConfig>} */
export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  port: readPositiveInt('PORT', 5000),

  // Loopback by default: there is no authentication yet, so the API must not be
  // reachable from the rest of the network unless someone opts in with HOST=0.0.0.0.
  host: readString('HOST', '127.0.0.1'),

  mongoUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017/cognitive_dataops'),

  // A relative STORAGE_ROOT is interpreted against the repo root so that the
  // default value ("storage") points at the committed top-level directory
  // regardless of where the process was launched from.
  storageRoot: path.resolve(PROJECT_ROOT, readString('STORAGE_ROOT', 'storage')),

  corsOrigins: readList('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173'),

  maxCadUploadBytes: readPositiveInt('MAX_CAD_UPLOAD_MB', 25) * MB,
  maxGlbUploadBytes: readPositiveInt('MAX_GLB_UPLOAD_MB', 50) * MB,

  mqtt: Object.freeze({
    url: mqttUrl,
    username: readOptionalString('MQTT_USERNAME'),
    password: readOptionalString('MQTT_PASSWORD'),
    siteId: mqttSiteId,
  }),

  telemetry: Object.freeze({
    // Exactly one backend per database may persist. Time-series collections
    // cannot enforce uniqueness, so two writers store every sample twice.
    persist: readBool('TELEMETRY_PERSIST', true),
    persistHz: readPositiveInt('TELEMETRY_PERSIST_HZ', 1),
    retentionHours: readPositiveInt('TELEMETRY_RETENTION_HOURS', 48),
    emitHzMax: readPositiveInt('TELEMETRY_EMIT_HZ_MAX', 10),
    bufferMax: readPositiveInt('TELEMETRY_BUFFER_MAX', 20_000),
  }),

  // Off unless the operator opts in: a command can reboot a machine.
  enableDeviceCommands: readBool('ENABLE_DEVICE_COMMANDS', false),

  // Minimum gap between two commands to the same device. 0 disables the limit,
  // which is why this uses the non-negative reader.
  commandMinIntervalMs: readNonNegativeInt('COMMAND_MIN_INTERVAL_MS', 2000),
});

export default config;
