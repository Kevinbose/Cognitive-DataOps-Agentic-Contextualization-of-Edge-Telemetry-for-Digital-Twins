/**
 * @file The shared secret between this API and the diagnosis agent.
 *
 * Used twice: the agent presents it to `/mcp`, and this API presents it when
 * it calls the agent. `AGENT_SERVICE_KEY` wins when set. Otherwise a random
 * key is created once in `storage/.agent/service.key` (mode 600, gitignored,
 * and refused by the `/static` mount because the directory is a dotfile), and
 * the agent reads the same file, so local development needs no setup.
 *
 * @module services/agentKey.service
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config/env.config.js';

/** @type {string|null} */
let cached = null;

/**
 * The service key, creating the key file on first use when no variable is set.
 *
 * @returns {string}
 */
export function getServiceKey() {
  if (cached) return cached;
  if (config.agent.serviceKey) {
    cached = config.agent.serviceKey;
    return cached;
  }
  const file = config.agent.keyFile;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) {
      cached = existing;
      return cached;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  cached = key;
  return cached;
}

/**
 * Constant-time comparison of a presented bearer token with the key.
 *
 * @param {string|undefined} header - The raw `Authorization` header.
 * @returns {boolean}
 */
export function isValidServiceAuth(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(getServiceKey());
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

/** Forget the cached key (tests swap the key file between cases). */
export function resetServiceKeyForTests() {
  cached = null;
}

export default { getServiceKey, isValidServiceAuth, resetServiceKeyForTests };
