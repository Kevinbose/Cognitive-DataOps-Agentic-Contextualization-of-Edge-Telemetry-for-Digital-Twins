/**
 * @file Bounded FIFO buffers used on the telemetry write path.
 *
 * Two small structures, both pure and independent of Mongo so they can be unit
 * tested directly.
 *
 * @module utils/writeBuffer
 */

/**
 * A FIFO queue with a hard capacity.
 *
 * Memory must stay bounded when the database is slow or away: an unbounded
 * array is how a one-minute MongoDB outage becomes an out-of-memory crash an
 * hour later. When the queue is full the OLDEST entries are discarded, because
 * for live telemetry the newest data is the most valuable, and every discard is
 * counted so it shows in `/health` rather than happening silently.
 */
export class BoundedBuffer {
  /**
   * @param {number} capacity - Maximum number of items held.
   */
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('BoundedBuffer capacity must be a positive integer');
    }

    /** @type {number} */
    this.capacity = capacity;
    /** @type {any[]} */
    this.items = [];
    /** @type {number} Items discarded because the queue was full. */
    this.overflowed = 0;
  }

  /** @returns {number} Current item count. */
  get size() {
    return this.items.length;
  }

  /**
   * Append items at the tail, discarding the oldest on overflow.
   *
   * @param {any[]} incoming - Items to append.
   * @returns {void}
   */
  push(incoming) {
    for (const item of incoming) this.items.push(item);
    this.#trim();
  }

  /**
   * Remove and return up to `count` items from the head.
   *
   * @param {number} count - Maximum number of items.
   * @returns {any[]} The removed items, oldest first.
   */
  take(count) {
    return this.items.splice(0, count);
  }

  /**
   * Put items back at the head, e.g. after a transient write failure.
   *
   * They are older than anything already queued, so they go in front. If that
   * pushes the queue over capacity the oldest of them are the ones dropped.
   *
   * @param {any[]} returned - Items to restore, oldest first.
   * @returns {void}
   */
  requeueFront(returned) {
    this.items.unshift(...returned);
    this.#trim();
  }

  #trim() {
    const excess = this.items.length - this.capacity;
    if (excess > 0) {
      this.items.splice(0, excess);
      this.overflowed += excess;
    }
  }
}

/**
 * Keeps the newest value per key and releases them in one batch.
 *
 * Used twice: to coalesce samples before a websocket emit (so no sensor is sent
 * more often than the configured rate) and to thin samples to one per channel
 * per second before persistence.
 */
export class LatestPerKey {
  constructor() {
    /** @type {Map<string, any>} */
    this.pending = new Map();
  }

  /** @returns {number} Number of keys with an undelivered value. */
  get size() {
    return this.pending.size;
  }

  /**
   * Record a value, replacing any undelivered one for the same key.
   *
   * @param {string} key - Identity of the series, e.g. a sensor id.
   * @param {any} value - Newest value.
   * @returns {void}
   */
  offer(key, value) {
    this.pending.set(key, value);
  }

  /**
   * Take every undelivered value and clear the set.
   *
   * @returns {any[]} One value per key that changed since the last drain.
   */
  drain() {
    if (this.pending.size === 0) return [];
    const values = [...this.pending.values()];
    this.pending.clear();
    return values;
  }
}

export default { BoundedBuffer, LatestPerKey };
