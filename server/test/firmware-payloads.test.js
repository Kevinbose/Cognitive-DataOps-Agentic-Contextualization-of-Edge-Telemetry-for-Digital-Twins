/**
 * The firmware's wire messages, checked without a board.
 *
 * `payloads.h` builds telemetry, spectrum, diag and ack with `snprintf`. JSON
 * written through printf is brittle: one missing quote or comma and the backend
 * silently drops every message from a board that otherwise looks healthy. There is
 * no C++ compiler on the development machine to run the code, so this test does the
 * next best thing. It reads the format strings straight out of `payloads.h`,
 * expands them the way `snprintf` would for sample values, and requires the result
 * to be JSON the backend's own validators accept.
 *
 * It cannot see an argument passed in the wrong order. The on-chip self-test and a
 * first run against a broker (`mqtt-tail`, `/health` invalid counters) cover that.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ackPayloadSchema,
  diagPayloadSchema,
  spectrumPayloadSchema,
  telemetryPayloadSchema,
} from '../src/validators/telemetry.validator.js';
import { loadCatalog } from '../scripts/lib/gateway.mjs';

const HEADER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'firmware', 'cdo-edge-gateway', 'payloads.h');
// Normalised: Git on Windows (core.autocrlf) checks the header out with CRLF.
const source = fs.readFileSync(HEADER, 'utf8').replace(/\r\n/g, '\n');
const catalog = loadCatalog();

/* ─── Reading format strings out of the C++ ───────────────────────────────── */

const PRI = { PRIu32: 'u', PRIu64: 'llu' };

/**
 * The text of one function in payloads.h: from its signature to the closing brace
 * at the start of a line.
 */
function functionBody(name) {
  const start = source.indexOf(`inline int ${name}(`);
  assert.ok(start >= 0, `payloads.h has no ${name}`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end);
}

/**
 * Every `out.print(...)` format string in a function, in order. A format is a run
 * of string literals and PRI macros up to the first comma outside a literal.
 */
function formatsOf(name) {
  const body = functionBody(name);
  const formats = [];
  let from = 0;

  for (;;) {
    const call = body.indexOf('out.print(', from);
    if (call < 0) break;
    let i = call + 'out.print('.length;
    let format = '';

    for (;;) {
      while (/\s/.test(body[i])) i += 1;
      if (body[i] === '"') {
        i += 1;
        while (body[i] !== '"') {
          if (body[i] === '\\') {
            const next = body[i + 1];
            format += next === 'n' ? '\n' : next;
            i += 2;
          } else {
            format += body[i];
            i += 1;
          }
        }
        i += 1;
      } else {
        const macro = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i))?.[0];
        if (!macro || !(macro in PRI)) break;
        format += PRI[macro];
        i += macro.length;
      }
    }
    formats.push(format);
    from = i;
  }
  return formats;
}

/**
 * snprintf for the handful of conversions the firmware uses: %s %d %u %llu %f %g,
 * with `.N` and `.*` precision.
 */
function sprintf(format, args) {
  const rest = [...args];
  const take = () => {
    assert.ok(rest.length > 0, `not enough arguments for "${format}"`);
    return rest.shift();
  };

  const out = format.replace(/%(%|(?:\.(\*|\d+))?(?:ll|l)?([sduf]|g))/g, (_m, pct, precision, conv) => {
    if (pct === '%') return '%';
    const digits = precision === '*' ? Number(take()) : precision === undefined ? undefined : Number(precision);
    const value = take();
    switch (conv) {
      case 's': return String(value);
      case 'd':
      case 'u': return String(value);
      case 'f': return Number(value).toFixed(digits ?? 6);
      case 'g': return String(Number(Number(value).toPrecision(6)));
      default: throw new Error(`unsupported conversion %${conv}`);
    }
  });

  assert.equal(rest.length, 0, `${rest.length} unused argument(s) for "${format}"`);
  return out;
}

/* ─── The messages ─────────────────────────────────────────────────────────── */

describe('telemetry', () => {
  const formats = formatsOf('formatTelemetry');

  it('is three prints: the head, one per channel, the tail', () => {
    assert.equal(formats.length, 3);
  });

  for (const [machineId, machine] of Object.entries(catalog.machines)) {
    it(`${machineId}: expands to JSON the backend accepts, with every channel and its decimals`, () => {
      const values = machine.channels.map((c) => (c.min + c.max) / 3);
      let text = sprintf(formats[0], [18234, 1767225600123n, 'true']);
      machine.channels.forEach((c, i) => {
        text += sprintf(formats[1], [i === 0 ? '' : ',', c.key, c.decimals, values[i]]);
      });
      text += sprintf(formats[2], []);

      const parsed = JSON.parse(text);
      const checked = telemetryPayloadSchema.parse(parsed);
      assert.deepEqual(Object.keys(checked.m), machine.channels.map((c) => c.key));
      assert.equal(checked.seq, 18234);
      assert.equal(checked.synced, true);

      machine.channels.forEach((c, i) => {
        const printed = text.match(new RegExp(`"${c.key}":(-?[0-9.]+)`))[1];
        assert.equal(printed.split('.')[1]?.length ?? 0, c.decimals, `${c.key} printed as ${printed}`);
      });
    });
  }

  it('says synced:false when the clock is not set', () => {
    const text = sprintf(formats[0], [1, 5000n, 'false']) + sprintf(formats[1], ['', 'X', 1, 1]) + sprintf(formats[2], []);
    assert.equal(telemetryPayloadSchema.parse(JSON.parse(text)).synced, false);
  });
});

describe('spectrum', () => {
  const formats = formatsOf('formatSpectrum');

  it('is three prints: the head, one per bin, the tail', () => {
    assert.equal(formats.length, 3);
  });

  it('expands to a 64-bin frame the backend accepts, in the declared key', () => {
    const layout = catalog.machines['press-stamp-01'].spectrum;
    const bins = Array.from({ length: layout.count }, (_, i) => 0.03 + i / 1000);

    let text = sprintf(formats[0], [421, 1767225600123n, layout.key]);
    bins.forEach((b, i) => {
      text += sprintf(formats[1], [i === 0 ? '' : ',', b]);
    });
    text += sprintf(formats[2], []);

    const parsed = spectrumPayloadSchema.parse(JSON.parse(text));
    assert.equal(parsed.key, layout.key);
    assert.equal(parsed.amp.length, layout.count);
    assert.ok(text.length < 1024 - 7 - 128, `frame is ${text.length} B and must fit the 1024 B buffer`);
  });
});

describe('diag', () => {
  const formats = formatsOf('formatDiag');

  it('is three prints that together make one object', () => {
    assert.equal(formats.length, 3);
  });

  it('expands to JSON the strict backend schema accepts, field for field', () => {
    const text =
      sprintf(formats[0], [1767225600123n, '1.0.0', '7f3a9c21', 1234, -58, 212340, 198000, 'POWERON']) +
      sprintf(formats[1], [1, 2, 0, 3, 'true', 'false']) +
      sprintf(formats[2], ['CLOGGED_FILTER', 0.4217, 120]);

    const parsed = diagPayloadSchema.parse(JSON.parse(text));
    assert.equal(parsed.rssi, -58);
    assert.equal(parsed.tls, true);
    assert.equal(parsed.insecure, false);
    assert.deepEqual(parsed.sim, { scenario: 'CLOGGED_FILTER', ramp: 0.422, rampSec: 120 });
    assert.ok(text.length < 512, `diag is ${text.length} B and must fit the 512 B buffer`);
  });

  it('keeps a fractional ramp length intact', () => {
    const text =
      sprintf(formats[0], [1n, '1.0.0', 'aabbccdd', 5, -60, 1, 1, 'SW']) +
      sprintf(formats[1], [0, 0, 1, 0, 'false', 'false']) +
      sprintf(formats[2], ['NORMAL', 0, 7.5]);
    assert.equal(diagPayloadSchema.parse(JSON.parse(text)).sim.rampSec, 7.5);
  });
});

describe('ack', () => {
  const formats = formatsOf('formatAck');

  it('is one print', () => {
    assert.equal(formats.length, 1);
  });

  it('expands to JSON the backend accepts', () => {
    const text = sprintf(formats[0], ['c-8f2a', 'scenario', 'true', 'CLOGGED_FILTER ramp 120s', 1767225600456n]);
    const parsed = ackPayloadSchema.parse(JSON.parse(text));
    assert.equal(parsed.cmdId, 'c-8f2a');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.detail, 'CLOGGED_FILTER ramp 120s');
  });

  it('carries a refusal with its reason', () => {
    const text = sprintf(formats[0], ['c-1', 'scenario', 'false', 'unknown scenario GEARBOX_WEAR', 5n]);
    const parsed = ackPayloadSchema.parse(JSON.parse(text));
    assert.equal(parsed.ok, false);
    assert.match(parsed.detail, /unknown scenario/);
  });
});

describe('the format reader itself', () => {
  it('reads literal pieces and PRI macros the way the compiler joins them', () => {
    assert.deepEqual(formatsOf('formatAck'), [
      '{"cmdId":"%s","name":"%s","ok":%s,"detail":"%s","ts":%llu}',
    ]);
  });

  it('expands the conversions the firmware uses, and notices a wrong argument count', () => {
    assert.equal(sprintf('%s-%d-%u-%llu', ['a', 1, 2, 3n]), 'a-1-2-3');
    assert.equal(sprintf('%.2f|%.*f|%.3f', [1.005, 1, 2.25, 0.5]), `${(1.005).toFixed(2)}|${(2.25).toFixed(1)}|${(0.5).toFixed(3)}`);
    assert.equal(sprintf('%g|%g', [120, 7.5]), '120|7.5');
    assert.equal(sprintf('100%%', []), '100%');
    assert.throws(() => sprintf('%s %s', ['only one']), /not enough arguments/);
    assert.throws(() => sprintf('%s', ['a', 'b']), /unused argument/);
  });
});
