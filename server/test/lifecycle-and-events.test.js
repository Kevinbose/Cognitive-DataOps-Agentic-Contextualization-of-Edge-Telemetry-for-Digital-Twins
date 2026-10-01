import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  DOMAIN_EVENT,
  emitDomainEvent,
  onDomainEvent,
  resetDomainEventsForTests,
} from '../src/utils/domainEvents.js';
import {
  isShuttingDown,
  registerShutdownHook,
  resetLifecycleForTests,
  runShutdownHooks,
} from '../src/utils/lifecycle.js';

const silence = async (fn) => {
  const { error } = console;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = error;
  }
};

describe('shutdown hooks', () => {
  afterEach(resetLifecycleForTests);

  it('run in reverse registration order', async () => {
    const order = [];
    registerShutdownHook('first registered', () => void order.push('db'));
    registerShutdownHook('second', async () => void order.push('flush'));
    registerShutdownHook('last registered', () => void order.push('consume'));

    const result = await runShutdownHooks();
    assert.deepEqual(order, ['consume', 'flush', 'db']);
    assert.equal(result.ok, true);
  });

  it('keeps going when one hook throws or hangs, and reports both', async () => {
    const ran = [];
    registerShutdownHook('db', () => void ran.push('db'));
    registerShutdownHook('hangs', () => new Promise(() => {}), { timeoutMs: 40 });
    registerShutdownHook('throws', () => {
      throw new Error('boom');
    });
    registerShutdownHook('ok', () => void ran.push('ok'));

    const result = await silence(() => runShutdownHooks());
    assert.deepEqual(ran, ['ok', 'db'], 'hooks after the failures still ran');
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed.sort(), ['hangs', 'throws']);
  });

  it('latches: a second run does nothing', async () => {
    let count = 0;
    registerShutdownHook('once', () => void (count += 1));
    assert.equal(isShuttingDown(), false);
    await runShutdownHooks();
    await runShutdownHooks();
    assert.equal(count, 1);
    assert.equal(isShuttingDown(), true);
  });
});

describe('domain events', () => {
  afterEach(resetDomainEventsForTests);

  it('deliver asynchronously, after the emitter has returned', async () => {
    const seen = [];
    onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, (p) => void seen.push(p.reason));
    emitDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, { assetIds: ['a'], reason: 'bind' });
    assert.deepEqual(seen, [], 'not delivered synchronously');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['bind']);
  });

  it('cannot be broken by a failing listener', async () => {
    const seen = [];
    onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, () => {
      throw new Error('listener bug');
    });
    onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, async () => {
      throw new Error('async listener bug');
    });
    onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, () => void seen.push('healthy'));

    await silence(async () => {
      assert.doesNotThrow(() => emitDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, { assetIds: [], reason: 'x' }));
      await new Promise((r) => setImmediate(r));
    });
    assert.deepEqual(seen, ['healthy']);
  });

  it('stop delivering after unsubscribe', async () => {
    const seen = [];
    const off = onDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, () => void seen.push(1));
    off();
    emitDomainEvent(DOMAIN_EVENT.BINDING_CHANGED, { assetIds: [], reason: 'x' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, []);
  });
});
