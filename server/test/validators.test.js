import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBirth, loadCatalog } from '../scripts/lib/gateway.mjs';
import { commandBodySchema } from '../src/validators/device.validator.js';
import {
  ackPayloadSchema,
  birthPayloadSchema,
  diagPayloadSchema,
  historyQuerySchema,
  spectrumPayloadSchema,
  statusPayloadSchema,
  telemetryPayloadSchema,
} from '../src/validators/telemetry.validator.js';

const catalog = loadCatalog();
const identity = { fw: '1.0.0', mac: 'AA:BB:CC:DD:EE:FF', bootId: 'abcd1234' };
const pressBirth = () => structuredClone(buildBirth('press-stamp-01', catalog.machines['press-stamp-01'], identity));

const ok = (schema, value) => assert.equal(schema.safeParse(value).success, true, JSON.stringify(value).slice(0, 120));
const bad = (schema, value, label) =>
  assert.equal(schema.safeParse(value).success, false, `should reject: ${label}`);

describe('birth payload', () => {
  it('accepts what the catalog generates for both machines', () => {
    for (const id of Object.keys(catalog.machines)) {
      ok(birthPayloadSchema, buildBirth(id, catalog.machines[id], identity));
    }
  });

  it('rejects malformed births', () => {
    const cases = {
      'unknown field': { ...pressBirth(), extra: 1 },
      'wrong version': { ...pressBirth(), v: 2 },
      'bad MAC': { ...pressBirth(), mac: 'not-a-mac' },
      'bad boot id': { ...pressBirth(), bootId: 'zzzz' },
      'no channels': { ...pressBirth(), channels: [] },
      'lowercase channel key': (() => {
        const b = pressBirth();
        b.channels[0].key = 'lower_case';
        return b;
      })(),
      'unknown sensor type': (() => {
        const b = pressBirth();
        b.channels[0].sensorType = 'magic';
        return b;
      })(),
      'min not below max': (() => {
        const b = pressBirth();
        b.channels[0].min = 10;
        b.channels[0].max = 10;
        return b;
      })(),
      'duplicate channel key': (() => {
        const b = pressBirth();
        b.channels[1].key = b.channels[0].key;
        return b;
      })(),
      'too many channels': (() => {
        const b = pressBirth();
        b.channels = Array.from({ length: 33 }, (_, i) => ({ ...b.channels[0], key: `CH_${i}` }));
        return b;
      })(),
      'empty spectrum': (() => {
        const b = pressBirth();
        b.spectrum.count = 0;
        return b;
      })(),
      'unknown limit field': (() => {
        const b = pressBirth();
        b.channels[0].limits.bogus = 1;
        return b;
      })(),
    };
    for (const [label, value] of Object.entries(cases)) bad(birthPayloadSchema, value, label);
  });

  it('allows a machine with no spectrum', () => {
    ok(birthPayloadSchema, buildBirth('robot-weld-01', catalog.machines['robot-weld-01'], identity));
  });
});

describe('status payload', () => {
  it('accepts only online and offline', () => {
    ok(statusPayloadSchema, 'online');
    ok(statusPayloadSchema, 'offline');
    for (const value of ['ONLINE', 'up', '', 'online\n', 1, null]) bad(statusPayloadSchema, value, String(value));
  });
});

describe('telemetry payload', () => {
  const good = { v: 1, seq: 7, ts: 1_767_225_600_123, synced: true, m: { MAIN_MOTOR_CURRENT: 96.4 } };

  it('accepts a well-formed message', () => ok(telemetryPayloadSchema, good));

  it('rejects malformed messages', () => {
    const cases = {
      'no channels': { ...good, m: {} },
      'lowercase key': { ...good, m: { motor: 1 } },
      'string value': { ...good, m: { MAIN_MOTOR_CURRENT: '96.4' } },
      'NaN value': { ...good, m: { MAIN_MOTOR_CURRENT: NaN } },
      'Infinity value': { ...good, m: { MAIN_MOTOR_CURRENT: Infinity } },
      'null value': { ...good, m: { MAIN_MOTOR_CURRENT: null } },
      'negative seq': { ...good, seq: -1 },
      'fractional seq': { ...good, seq: 1.5 },
      'missing synced': (({ synced: _s, ...rest }) => rest)(good),
      'unknown field': { ...good, extra: true },
      'wrong version': { ...good, v: 0 },
      'too many channels': {
        ...good,
        m: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`CH_${i}`, i])),
      },
    };
    for (const [label, value] of Object.entries(cases)) bad(telemetryPayloadSchema, value, label);
  });
});

describe('spectrum payload', () => {
  const good = { v: 1, seq: 1, ts: 1, key: 'BEARING_SPECTRUM', amp: [0.1, 0.2, 0.3] };
  it('accepts a frame', () => ok(spectrumPayloadSchema, good));
  it('rejects bad frames', () => {
    bad(spectrumPayloadSchema, { ...good, amp: [] }, 'empty');
    bad(spectrumPayloadSchema, { ...good, amp: [0.1, -0.2] }, 'negative amplitude');
    bad(spectrumPayloadSchema, { ...good, amp: Array(257).fill(0.1) }, 'too many bins');
    bad(spectrumPayloadSchema, { ...good, amp: [0.1, NaN] }, 'NaN');
    bad(spectrumPayloadSchema, { ...good, key: 'bad key' }, 'bad key');
  });
});

describe('diag payload', () => {
  const good = {
    v: 1,
    ts: 1,
    fw: '1.0.0',
    bootId: 'abcd1234',
    uptimeS: 10,
    rssi: -58,
    heapFree: 200_000,
    heapMin: 190_000,
    reset: 'POWERON',
    wifiReconnects: 0,
    mqttReconnects: 0,
    restarts: 0,
    publishFailures: 0,
    tls: true,
    insecure: false,
  };
  it('accepts diag with and without simulator truth', () => {
    ok(diagPayloadSchema, good);
    ok(diagPayloadSchema, { ...good, sim: { scenario: 'CLOGGED_FILTER', ramp: 0.4, rampSec: 120 } });
  });
  it('rejects bad diag', () => {
    bad(diagPayloadSchema, { ...good, rssi: 10 }, 'positive rssi');
    bad(diagPayloadSchema, { ...good, sim: { scenario: 'X', ramp: 1.5, rampSec: 1 } }, 'ramp above 1');
    bad(diagPayloadSchema, { ...good, extra: 1 }, 'unknown field');
  });
});

describe('ack payload', () => {
  const good = { cmdId: 'c-8f2a', name: 'scenario', ok: true, detail: 'done' };
  it('accepts an ack', () => ok(ackPayloadSchema, good));
  it('rejects bad acks', () => {
    bad(ackPayloadSchema, { ...good, name: 'format-disk' }, 'unknown command');
    bad(ackPayloadSchema, { ...good, detail: 'x'.repeat(161) }, 'long detail');
    bad(ackPayloadSchema, { ...good, cmdId: 'has space' }, 'bad id');
  });
});

describe('history query', () => {
  const sensorId = 'press-stamp-01.lube_oil_pressure';

  it('upper-cases the sensor and defaults to the last 15 minutes', () => {
    const q = historyQuerySchema.parse({ sensorId });
    assert.equal(q.sensorId, 'PRESS-STAMP-01.LUBE_OIL_PRESSURE');
    const spanMs = q.to.getTime() - q.from.getTime();
    assert.ok(Math.abs(spanMs - 15 * 60_000) < 2000);
    assert.equal(q.maxPoints, 600);
    assert.equal(q.bucketSec, Math.ceil(900 / 600));
  });

  it('clamps a window older than retention instead of failing', () => {
    const q = historyQuerySchema.parse({ sensorId, from: '2000-01-01T00:00:00Z' });
    const ageHours = (Date.now() - q.from.getTime()) / 3_600_000;
    assert.ok(ageHours <= 48.01 && ageHours > 47.9);
  });

  it('derives a bucket wide enough to honour maxPoints', () => {
    const q = historyQuerySchema.parse({ sensorId, maxPoints: 100 });
    const span = (q.to.getTime() - q.from.getTime()) / 1000;
    assert.ok(span / q.bucketSec <= 100 + 1);
  });

  it('rejects an inverted window, a hostile sensor id and out-of-range limits', () => {
    bad(historyQuerySchema, { sensorId, from: '2026-01-02', to: '2026-01-01' }, 'from after to');
    bad(historyQuerySchema, { sensorId: 'a/b' }, 'slash in sensor');
    bad(historyQuerySchema, { sensorId: '' }, 'empty sensor');
    bad(historyQuerySchema, { sensorId, maxPoints: 5 }, 'maxPoints too small');
    bad(historyQuerySchema, { sensorId, maxPoints: 99_999 }, 'maxPoints too large');
    bad(historyQuerySchema, { sensorId, bucketSec: 0 }, 'zero bucket');
  });
});

describe('command body', () => {
  it('validates each command against its own arguments', () => {
    ok(commandBodySchema, { name: 'scenario', args: { scenario: 'CLOGGED_FILTER', rampSec: 60 } });
    ok(commandBodySchema, { name: 'scenario', args: { scenario: 'NORMAL' } });
    ok(commandBodySchema, { name: 'interval', args: { intervalMs: 1000 } });
    ok(commandBodySchema, { name: 'ping' });
    ok(commandBodySchema, { name: 'reboot', args: {} });
  });

  it('fills in empty args for argument-less commands', () => {
    assert.deepEqual(commandBodySchema.parse({ name: 'ping' }).args, {});
  });

  it('rejects unknown commands and out-of-range arguments', () => {
    bad(commandBodySchema, { name: 'format-disk' }, 'unknown command');
    bad(commandBodySchema, { name: 'scenario', args: { scenario: 'lower' } }, 'lower-case scenario');
    bad(commandBodySchema, { name: 'scenario', args: { scenario: 'NORMAL', rampSec: 1 } }, 'ramp too short');
    bad(commandBodySchema, { name: 'scenario', args: { scenario: 'NORMAL', rampSec: 9999 } }, 'ramp too long');
    bad(commandBodySchema, { name: 'interval', args: { intervalMs: 10 } }, 'interval too fast');
    bad(commandBodySchema, { name: 'interval', args: { intervalMs: 60_000 } }, 'interval too slow');
    bad(commandBodySchema, { name: 'ping', args: { surprise: 1 } }, 'extra arg on ping');
    bad(commandBodySchema, { name: 'scenario' }, 'scenario without args');
  });
});
