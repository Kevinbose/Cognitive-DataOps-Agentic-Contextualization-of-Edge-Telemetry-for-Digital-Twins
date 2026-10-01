/**
 * @file Shutdown hook registry.
 *
 * A process that owns a broker connection, a websocket server, a write buffer
 * and a database connection has to stop them in a specific order, and each
 * owner knows best how to stop itself. Instead of one growing `shutdown()`
 * function that knows about everything, each service registers a named hook
 * when it starts, and `server.js` runs them all.
 *
 * Hooks run in REVERSE registration order (last started, first stopped), one at
 * a time, each under its own timeout, so one wedged dependency cannot stop the
 * rest from being torn down.
 *
 * @module utils/lifecycle
 */

/**
 * @typedef {object} ShutdownHook
 * @property {string} name - Label used in logs.
 * @property {() => Promise<void>|void} run - Teardown work.
 * @property {number} timeoutMs - Per-hook ceiling before the hook is abandoned.
 */

/** @type {ShutdownHook[]} */
const hooks = [];

let shuttingDown = false;

/**
 * Register a teardown step.
 *
 * @param {string} name - Label used in logs.
 * @param {() => Promise<void>|void} run - Teardown work. May be async.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Ceiling for this hook. Default 3000.
 * @returns {void}
 */
export function registerShutdownHook(name, run, { timeoutMs = 3000 } = {}) {
  hooks.push({ name, run, timeoutMs });
}

/**
 * Whether shutdown has begun.
 *
 * Checked by signal and `unhandledRejection` handlers so that a second signal,
 * or a rejection raised *during* teardown, does not start a second teardown on
 * top of the first.
 *
 * @returns {boolean}
 */
export function isShuttingDown() {
  return shuttingDown;
}

/**
 * Run every registered hook in reverse order.
 *
 * Never throws: a failing or timed-out hook is logged and the next one still
 * runs. Calling it twice is a no-op, so the latch cannot be raced.
 *
 * @returns {Promise<{ok: boolean, failed: string[]}>} Whether every hook finished cleanly.
 */
export async function runShutdownHooks() {
  if (shuttingDown) return { ok: true, failed: [] };
  shuttingDown = true;

  /** @type {string[]} */
  const failed = [];

  for (const hook of [...hooks].reverse()) {
    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(hook.run),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${hook.timeoutMs} ms`)),
            hook.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failed.push(hook.name);
      console.error(`[shutdown] Hook "${hook.name}" failed:`, error?.message ?? error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: failed.length === 0, failed };
}

/**
 * Forget every hook and clear the latch. Test-only: lets one process run
 * several start/stop cycles without inheriting the previous cycle's state.
 *
 * @returns {void}
 */
export function resetLifecycleForTests() {
  hooks.length = 0;
  shuttingDown = false;
}

export default { registerShutdownHook, runShutdownHooks, isShuttingDown, resetLifecycleForTests };
