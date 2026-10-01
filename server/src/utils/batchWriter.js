/**
 * @file Batched, bounded, failure-aware writer.
 *
 * Telemetry arrives far faster than it is worth writing one document at a time
 * (Atlas M0 also throttles at 100 operations per second), so documents queue up
 * and are inserted in batches. The writer is deliberately independent of
 * Mongoose: it takes an `insert(batch)` function, which keeps the failure
 * handling below unit-testable with a fake.
 *
 * Failure policy, chosen so that a database outage degrades gracefully instead
 * of either losing everything or eating all memory:
 *
 *   - **Transient failure** (network, no primary, buffering timeout): put the
 *     batch back at the head of the queue and stop. The next flush retries.
 *   - **Write error** (validation, duplicate, bad document): drop just the
 *     failed documents and count them. Retrying would fail forever.
 *   - **Overflow** (queue full): the oldest documents are discarded and
 *     counted.
 *
 * @module utils/batchWriter
 */

import { BoundedBuffer } from './writeBuffer.js';

/**
 * Decide whether an insert failure is worth retrying.
 *
 * @param {any} error - The thrown error.
 * @returns {boolean} True for connectivity-class failures.
 */
export function isTransientWriteError(error) {
  if (!error) return false;

  const name = String(error.name ?? '');
  if (
    [
      'MongoNetworkError',
      'MongoNetworkTimeoutError',
      'MongoServerSelectionError',
      'MongoNotConnectedError',
      'MongoTopologyClosedError',
    ].includes(name)
  ) {
    return true;
  }

  // The driver labels errors it considers safe to retry.
  if (typeof error.hasErrorLabel === 'function') {
    if (error.hasErrorLabel('RetryableWriteError') || error.hasErrorLabel('TransientTransactionError')) {
      return true;
    }
  }

  // Mongoose buffers commands while disconnected and rejects after its timeout.
  if (/buffering timed out|Client must be connected|connection .* closed/i.test(error.message ?? '')) {
    return true;
  }

  return false;
}

/**
 * @typedef {object} BatchWriterStats
 * @property {number} buffered - Documents waiting.
 * @property {number} flushed - Documents written successfully.
 * @property {number} dropped - Documents lost to write errors or overflow.
 * @property {number} errors - Flush attempts that failed.
 * @property {string|null} lastError - Message of the most recent failure.
 * @property {number|null} lastFlushAt - Epoch ms of the last successful flush.
 */

export class BatchWriter {
  /**
   * @param {object} options
   * @param {string} options.name - Label for logs.
   * @param {(batch: any[]) => Promise<{failed?: number}|void>} options.insert - Writes one batch.
   *   May return `{failed}` for partial failures on an unordered insert.
   * @param {number} options.capacity - Queue capacity.
   * @param {number} [options.batchSize] - Documents per insert call.
   * @param {(error: any) => boolean} [options.isTransient] - Retry classifier.
   */
  constructor({ name, insert, capacity, batchSize = 500, isTransient = isTransientWriteError }) {
    this.name = name;
    this.insert = insert;
    this.batchSize = batchSize;
    this.isTransient = isTransient;
    this.buffer = new BoundedBuffer(capacity);

    this.flushedCount = 0;
    this.droppedCount = 0;
    this.errorCount = 0;
    /** @type {string|null} */
    this.lastError = null;
    /** @type {number|null} */
    this.lastFlushAt = null;

    /** @type {Promise<void>} Serialises flushes so two never overlap. */
    this.chain = Promise.resolve();
  }

  /**
   * Queue documents for the next flush.
   *
   * @param {any[]} docs - Documents to write.
   * @returns {void}
   */
  enqueue(docs) {
    if (docs.length > 0) this.buffer.push(docs);
  }

  /**
   * Write everything queued, in batches.
   *
   * Flushes are chained, so a caller awaiting this gets a settled state even
   * when a timer-driven flush is already in flight.
   *
   * @returns {Promise<void>}
   */
  flush() {
    this.chain = this.chain.then(() => this.#drain()).catch(() => {});
    return this.chain;
  }

  async #drain() {
    while (this.buffer.size > 0) {
      const batch = this.buffer.take(this.batchSize);

      try {
        const result = await this.insert(batch);
        const failed = Math.min(result?.failed ?? 0, batch.length);
        this.flushedCount += batch.length - failed;
        this.droppedCount += failed;
        this.lastFlushAt = Date.now();
      } catch (error) {
        this.errorCount += 1;
        this.lastError = error?.message ?? String(error);

        if (this.isTransient(error)) {
          this.buffer.requeueFront(batch);
          console.warn(`[store] ${this.name}: transient write failure, will retry: ${this.lastError}`);
          return;
        }

        this.droppedCount += batch.length;
        console.error(`[store] ${this.name}: dropped ${batch.length} documents: ${this.lastError}`);
      }
    }
  }

  /**
   * @returns {BatchWriterStats} Counters for `/health`.
   */
  stats() {
    return {
      buffered: this.buffer.size,
      flushed: this.flushedCount,
      dropped: this.droppedCount + this.buffer.overflowed,
      errors: this.errorCount,
      lastError: this.lastError,
      lastFlushAt: this.lastFlushAt,
    };
  }
}

export default { BatchWriter, isTransientWriteError };
