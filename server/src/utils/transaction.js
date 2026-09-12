/**
 * @file Transaction helper with a documented standalone-MongoDB fallback.
 *
 * The sensor-rebind flow performs three writes that must not be observed
 * half-applied (close the old binding, create the new one, update the mesh
 * node's denormalised `isMapped` flag). On a replica set — which includes every
 * MongoDB Atlas tier, M0 included — those run inside a real transaction.
 *
 * A bare local `mongod` standalone cannot start a transaction at all. Rather
 * than crash a teammate whose local setup differs, we detect that case once at
 * boot and fall back to running the same callback without a session. The
 * fallback is *not* atomic, and the log line says so out loud, because silently
 * degrading a correctness guarantee is worse than a noisy one.
 *
 * @module utils/transaction
 */

import mongoose from 'mongoose';
import { supportsTransactions } from '../config/db.config.js';

/**
 * Work performed inside (or, on standalone, in place of) a transaction.
 *
 * @template T
 * @callback TransactionalWork
 * @param {import('mongoose').ClientSession|null} session - Active session, or
 *   `null` when running on a deployment without transaction support. Pass it
 *   through to every query as `{ session }`; Mongoose ignores a `null` session.
 * @returns {Promise<T>} The work's result.
 */

/**
 * Run `work` atomically when the deployment allows it.
 *
 * @template T
 * @param {TransactionalWork<T>} work - Callback receiving the session.
 * @param {object} [options]
 * @param {string} [options.label] - Short name used in the degradation warning.
 * @returns {Promise<T>} Whatever `work` resolves to.
 */
export async function withTransaction(work, { label = 'operation' } = {}) {
  const canUseTransactions = await supportsTransactions();

  if (!canUseTransactions) {
    console.warn(
      `[tx] Running "${label}" WITHOUT a transaction (standalone MongoDB). ` +
        'Partial writes are possible if this fails midway.',
    );
    return work(null);
  }

  const session = await mongoose.startSession();
  try {
    /** @type {T} */
    let result;

    // `withTransaction` (the driver's own helper, distinct from this wrapper)
    // handles automatic retries on transient transaction errors — the retry
    // semantics MongoDB explicitly recommends over a manual start/commit pair.
    await session.withTransaction(async () => {
      result = await work(session);
    });

    // @ts-expect-error — assigned inside the callback, which always runs.
    return result;
  } finally {
    await session.endSession();
  }
}

export default withTransaction;
