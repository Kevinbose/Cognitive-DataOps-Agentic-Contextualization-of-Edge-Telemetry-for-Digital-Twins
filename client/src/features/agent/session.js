/**
 * @file Identities the assistant needs from the browser.
 *
 * - The **session id** names this tab. The agent's "show me" commands are sent
 *   to it alone, so a colleague looking at the same twin in another tab does
 *   not have their camera moved. It lives in `sessionStorage` (per tab).
 * - A **thread id** per scope (the plant, or one twin) keeps each conversation
 *   separate and lets it be restored after a reload. It lives in
 *   `localStorage`; "New chat" replaces it.
 *
 * Storage can throw (private mode, blocked site data), so every access is
 * guarded and falls back to an in-memory value.
 *
 * @module features/agent/session
 */

const SESSION_KEY = 'cdo.assistant.session';
const THREAD_PREFIX = 'cdo.assistant.thread.';
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
/** @type {Map<string, string>} */
const memory = new Map();

function randomId(length = 24) {
  const raw = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}${Math.random()}`;
  return raw.replace(/[^A-Za-z0-9]/g, '').slice(0, length);
}

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(storage, key, value) {
  memory.set(key, value);
  try {
    storage?.setItem(key, value);
  } catch {
    /* in-memory only */
  }
}

/** @returns {string} This tab's session id. */
export function getSessionId() {
  const existing = read(globalThis.sessionStorage, SESSION_KEY);
  if (existing && ID_PATTERN.test(existing)) return existing;
  const id = randomId();
  write(globalThis.sessionStorage, SESSION_KEY, id);
  return id;
}

/**
 * The conversation key for a scope.
 *
 * @param {'plant'|'twin'} scope
 * @param {string|null|undefined} assetId
 * @returns {string}
 */
export function scopeKeyOf(scope, assetId) {
  return scope === 'twin' && assetId ? `twin-${assetId}` : 'plant';
}

/** @param {string} scopeKey @returns {string} The stored thread id, created on first use. */
export function threadIdFor(scopeKey) {
  const existing = read(globalThis.localStorage, THREAD_PREFIX + scopeKey);
  if (existing && /^[A-Za-z0-9:_-]{8,96}$/.test(existing)) return existing;
  return newThreadId(scopeKey);
}

/** @param {string} scopeKey @returns {string} A fresh thread id, stored. */
export function newThreadId(scopeKey) {
  const id = `chat-${scopeKey}-${randomId(12)}`.slice(0, 96);
  write(globalThis.localStorage, THREAD_PREFIX + scopeKey, id);
  return id;
}
