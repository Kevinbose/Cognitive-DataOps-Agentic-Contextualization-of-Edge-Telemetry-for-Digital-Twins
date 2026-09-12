/**
 * @file MongoDB connection lifecycle.
 *
 * Owns connecting, connection-event logging, graceful disconnect, and the
 * runtime probe that tells the sensor-binding service whether this deployment
 * supports multi-document transactions.
 *
 * @module config/db.config
 */

import mongoose from 'mongoose';
import { config } from './env.config.js';

/**
 * Cached result of the transaction-support probe.
 * `null` means "not yet determined".
 * @type {boolean|null}
 */
let transactionSupport = null;

/**
 * Attach one-time listeners to the shared Mongoose connection so operational
 * events surface in logs rather than failing silently.
 * @returns {void}
 */
function registerConnectionListeners() {
  const { connection } = mongoose;

  connection.on('connected', () => {
    // `connection.name` is the resolved database name — useful when a teammate
    // accidentally points at the wrong Atlas database.
    console.log(`[db] Connected to MongoDB database "${connection.name}"`);
  });

  connection.on('error', (error) => {
    console.error('[db] Connection error:', error.message);
  });

  connection.on('disconnected', () => {
    console.warn('[db] Disconnected from MongoDB');
  });
}

/**
 * Determine whether the connected deployment supports multi-document
 * transactions (i.e. it is a replica set or sharded cluster, not a bare
 * standalone `mongod`).
 *
 * Atlas — including the free M0 tier — always satisfies this. A local
 * standalone does not, which is why the binding service needs a documented
 * non-transactional fallback rather than a hard crash.
 *
 * The probe reads the `hello` command's topology markers instead of attempting
 * and rolling back a throwaway transaction, so it costs one cheap admin call.
 *
 * @returns {Promise<boolean>} True when transactions can be used.
 */
export async function supportsTransactions() {
  if (transactionSupport !== null) return transactionSupport;

  try {
    const admin = mongoose.connection.db.admin();
    const info = await admin.command({ hello: 1 });

    // `setName` is present on replica-set members; `msg === 'isdbgrid'`
    // identifies a mongos router in front of a sharded cluster.
    transactionSupport = Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch (error) {
    // If the probe itself fails, assume no transaction support: the fallback
    // path is always safe to run, whereas assuming support would throw later.
    console.warn('[db] Transaction-support probe failed, assuming standalone:', error.message);
    transactionSupport = false;
  }

  if (!transactionSupport) {
    console.warn(
      '[db] This MongoDB deployment is a STANDALONE and does not support transactions.\n' +
        '     Sensor-binding rebinds will run without atomicity (sequential writes).\n' +
        '     Use a MongoDB Atlas M0 cluster or a local replica set for full guarantees.',
    );
  }

  return transactionSupport;
}

/**
 * Establish the MongoDB connection.
 *
 * @returns {Promise<typeof mongoose>} The connected Mongoose instance.
 * @throws {Error} Propagates connection failures so the caller can abort boot.
 */
export async function connectDatabase() {
  // Reject writes to fields that are not declared in a schema. Without this,
  // a typo like `sensorID` would silently persist as an unknown field.
  mongoose.set('strictQuery', true);

  registerConnectionListeners();

  await mongoose.connect(config.mongoUri, {
    // Fail fast instead of buffering commands for 30s when the cluster is
    // unreachable — a misconfigured URI should surface immediately.
    serverSelectionTimeoutMS: 10_000,
  });

  // Warm the probe during boot so the first binding request does not pay for it.
  await supportsTransactions();

  return mongoose;
}

/**
 * Close the MongoDB connection. Used by the graceful-shutdown handler.
 * @returns {Promise<void>}
 */
export async function disconnectDatabase() {
  await mongoose.connection.close();
}

export default { connectDatabase, disconnectDatabase, supportsTransactions };
