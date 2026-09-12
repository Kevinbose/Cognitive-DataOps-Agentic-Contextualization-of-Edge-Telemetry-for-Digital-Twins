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
dotenv.config({ path: path.join(SERVER_ROOT, '.env') });

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

const nodeEnv = readString('NODE_ENV', 'development');

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
 */

/** @type {Readonly<AppConfig>} */
export const config = Object.freeze({
  nodeEnv,
  isProduction: nodeEnv === 'production',
  isTest: nodeEnv === 'test',

  port: readPositiveInt('PORT', 5000),

  mongoUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017/cognitive_dataops'),

  // A relative STORAGE_ROOT is interpreted against the repo root so that the
  // default value ("storage") points at the committed top-level directory
  // regardless of where the process was launched from.
  storageRoot: path.resolve(PROJECT_ROOT, readString('STORAGE_ROOT', 'storage')),

  corsOrigins: readList('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173'),

  maxCadUploadBytes: readPositiveInt('MAX_CAD_UPLOAD_MB', 25) * MB,
  maxGlbUploadBytes: readPositiveInt('MAX_GLB_UPLOAD_MB', 50) * MB,
});

export default config;
