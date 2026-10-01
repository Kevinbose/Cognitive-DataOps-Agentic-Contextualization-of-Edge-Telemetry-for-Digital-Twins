import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHANNEL_STATUS, evaluateStatus } from '../src/utils/channelStatus.js';
import { BatchWriter, isTransientWriteError } from '../src/utils/batchWriter.js';
import { BoundedBuffer, LatestPerKey } from '../src/utils/writeBuffer.js';

describe('evaluateStatus', () => {
  const highOnly = { warnHigh: 26, alarmHigh: 30 };
  const lowOnly = { warnLow: 3.6, alarmLow: 3.0 };

  it('is normal below the warn limit and without limits', () => {
    assert.equal(evaluateStatus(25.99, highOnly), CHANNEL_STATUS.NORMAL);
    assert.equal(evaluateStatus(1e9, undefined), CHANNEL_STATUS.NORMAL);
    assert.equal(evaluateStatus(1e9, {}), CHANNEL_STATUS.NORMAL);
  });

  it('treats reaching a high limit as a breach', () => {
    assert.equal(evaluateStatus(26, highOnly), CHANNEL_STATUS.WARN);
    assert.equal(evaluateStatus(29.99, highOnly), CHANNEL_STATUS.WARN);
    assert.equal(evaluateStatus(30, highOnly), CHANNEL_STATUS.ALARM);
    assert.equal(evaluateStatus(99, highOnly), CHANNEL_STATUS.ALARM);
  });

  it('treats falling to a low limit as a breach (lube pressure falls on a clog)', () => {
    assert.equal(evaluateStatus(4.5, lowOnly), CHANNEL_STATUS.NORMAL);
    assert.equal(evaluateStatus(3.6, lowOnly), CHANNEL_STATUS.WARN);
    assert.equal(evaluateStatus(3.2, lowOnly), CHANNEL_STATUS.WARN);
    assert.equal(evaluateStatus(3.0, lowOnly), CHANNEL_STATUS.ALARM);
    assert.equal(evaluateStatus(0, lowOnly), CHANNEL_STATUS.ALARM);
  });

  it('lets alarm win when both limits are breached', () => {
    assert.equal(evaluateStatus(31, { warnHigh: 10, alarmHigh: 30 }), CHANNEL_STATUS.ALARM);
  });
});

describe('BoundedBuffer', () => {
  it('drops the OLDEST items on overflow and counts them', () => {
    const buffer = new BoundedBuffer(3);
    buffer.push([1, 2, 3, 4, 5]);
    assert.equal(buffer.size, 3);
    assert.equal(buffer.overflowed, 2);
    assert.deepEqual(buffer.take(10), [3, 4, 5]);
  });

  it('takes from the head and leaves the rest', () => {
    const buffer = new BoundedBuffer(10);
    buffer.push([1, 2, 3, 4]);
    assert.deepEqual(buffer.take(2), [1, 2]);
    assert.equal(buffer.size, 2);
  });

  it('requeues at the head, and trims the oldest if that overflows', () => {
    const buffer = new BoundedBuffer(4);
    buffer.push([5, 6, 7]);
    buffer.requeueFront([1, 2, 3]);
    // capacity 4: the two oldest (1, 2) are discarded, order is preserved.
    assert.deepEqual(buffer.take(10), [3, 5, 6, 7]);
    assert.equal(buffer.overflowed, 2);
  });

  it('rejects an invalid capacity', () => {
    assert.throws(() => new BoundedBuffer(0), RangeError);
    assert.throws(() => new BoundedBuffer(1.5), RangeError);
  });
});

describe('LatestPerKey', () => {
  it('keeps only the newest value per key and empties on drain', () => {
    const latest = new LatestPerKey();
    latest.offer('a', 1);
    latest.offer('b', 10);
    latest.offer('a', 2);
    assert.equal(latest.size, 2);
    assert.deepEqual(latest.drain().sort((x, y) => x - y), [2, 10]);
    assert.equal(latest.size, 0);
    assert.deepEqual(latest.drain(), []);
  });
});

describe('isTransientWriteError', () => {
  it('retries connectivity failures and gives up on data errors', () => {
    assert.equal(isTransientWriteError(Object.assign(new Error('x'), { name: 'MongoNetworkError' })), true);
    assert.equal(isTransientWriteError(Object.assign(new Error('x'), { name: 'MongoServerSelectionError' })), true);
    assert.equal(isTransientWriteError(new Error('Operation `x.insertMany()` buffering timed out after 10000ms')), true);
    assert.equal(
      isTransientWriteError(Object.assign(new Error('x'), { hasErrorLabel: (l) => l === 'RetryableWriteError' })),
      true,
    );
    assert.equal(isTransientWriteError(new Error('E11000 duplicate key')), false);
    assert.equal(isTransientWriteError(Object.assign(new Error('bad doc'), { name: 'ValidationError' })), false);
    assert.equal(isTransientWriteError(undefined), false);
  });
});

describe('BatchWriter', () => {
  const docs = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({ n: i + offset }));
  const silence = async (fn) => {
    const { warn, error } = console;
    console.warn = console.error = () => {};
    try {
      return await fn();
    } finally {
      console.warn = warn;
      console.error = error;
    }
  };

  it('writes in batches of the configured size', async () => {
    const sizes = [];
    const writer = new BatchWriter({ name: 't', capacity: 5000, batchSize: 500, insert: async (b) => void sizes.push(b.length) });
    writer.enqueue(docs(1200));
    await writer.flush();
    assert.deepEqual(sizes, [500, 500, 200]);
    assert.equal(writer.stats().flushed, 1200);
    assert.equal(writer.stats().buffered, 0);
  });

  it('keeps data through a transient outage and preserves order on recovery', async () => {
    const written = [];
    let healthy = false;
    const writer = new BatchWriter({
      name: 't',
      capacity: 5000,
      batchSize: 100,
      insert: async (batch) => {
        if (!healthy) throw Object.assign(new Error('no primary'), { name: 'MongoServerSelectionError' });
        written.push(...batch.map((d) => d.n));
      },
    });

    writer.enqueue(docs(250));
    await silence(() => writer.flush());
    assert.equal(writer.stats().buffered, 250, 'nothing is lost while the database is away');
    assert.equal(writer.stats().errors, 1);
    assert.equal(writer.stats().dropped, 0);

    healthy = true;
    writer.enqueue(docs(10, 250));
    await writer.flush();
    assert.equal(written.length, 260);
    assert.deepEqual(written, [...Array(260).keys()], 'oldest first, in order');
  });

  it('drops (and counts) documents that can never succeed, then carries on', async () => {
    const written = [];
    let call = 0;
    const writer = new BatchWriter({
      name: 't',
      capacity: 5000,
      batchSize: 10,
      insert: async (batch) => {
        call += 1;
        if (call === 1) throw Object.assign(new Error('document failed validation'), { name: 'ValidationError' });
        written.push(...batch);
      },
    });
    writer.enqueue(docs(30));
    await silence(() => writer.flush());
    assert.equal(writer.stats().dropped, 10);
    assert.equal(writer.stats().flushed, 20);
    assert.equal(written.length, 20);
  });

  it('counts partial failures of an unordered insert as drops', async () => {
    const writer = new BatchWriter({ name: 't', capacity: 100, insert: async () => ({ failed: 2 }) });
    writer.enqueue(docs(10));
    await writer.flush();
    assert.equal(writer.stats().flushed, 8);
    assert.equal(writer.stats().dropped, 2);
  });

  it('reports overflow as dropped documents', () => {
    const writer = new BatchWriter({ name: 't', capacity: 5, insert: async () => {} });
    writer.enqueue(docs(8));
    assert.equal(writer.stats().buffered, 5);
    assert.equal(writer.stats().dropped, 3);
  });

  it('never runs two flushes at once', async () => {
    let running = 0;
    let peak = 0;
    const writer = new BatchWriter({
      name: 't',
      capacity: 1000,
      batchSize: 10,
      insert: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 10));
        running -= 1;
      },
    });
    writer.enqueue(docs(50));
    await Promise.all([writer.flush(), writer.flush(), writer.flush()]);
    assert.equal(peak, 1);
    assert.equal(writer.stats().flushed, 50);
  });
});
