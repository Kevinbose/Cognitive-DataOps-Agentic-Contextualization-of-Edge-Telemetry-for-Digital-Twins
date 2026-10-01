/**
 * The host side of the on-chip parity self-test: the plan it walks, the way it
 * reads messy serial output, and the verdicts it gives.
 *
 * The device's output is simulated here in the firmware's own format, rounded to
 * the 12 significant digits the firmware prints. That proves the plumbing and
 * that 12 digits are enough to tell a faithful port from a broken one. Whether
 * the C++ really computes the same numbers is what `fw selftest` settles on the
 * chip.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadCatalog } from '../scripts/lib/gateway.mjs';
import { compareVectors, expectedVectors, judge, parseSerial } from '../scripts/lib/selftest.mjs';

const catalog = loadCatalog();
const CATALOG_ID = 'abc123def0';

/** What `printf("%.12g")` prints, as a JSON number. */
const g12 = (n) => String(Number(n.toPrecision(12)));

/** One vector the way selftest.h prints it. */
function deviceLine(vector) {
  const v = vector.v.map(g12).join(',');
  const bins = vector.bins ? `,"bins":[${vector.bins.map(g12).join(',')}]` : '';
  return `S {"m":"${vector.m}","sc":"${vector.sc}","r":${vector.r},"t":${vector.t},"v":[${v}]${bins}}`;
}

/** A whole block as the board prints it. */
function deviceBlock(vectors, catalogId = CATALOG_ID) {
  return [
    'CDO-SELFTEST-BEGIN',
    `H {"fw":"1.0.0","catalog":"${catalogId}","seed":${catalog.selftest.seed}}`,
    ...vectors.map(deviceLine),
    'CDO-SELFTEST-END',
  ].join('\r\n');
}

describe('the self-test plan', () => {
  const vectors = expectedVectors(catalog);

  it('walks machine, scenario, ramp and time in catalog order', () => {
    const plan = catalog.selftest;
    const robotCases = 1 + plan.ramps.length; // NORMAL once, GEARBOX_WEAR per ramp
    const pressCases = 1 + 2 * plan.ramps.length; // NORMAL once, two faults per ramp

    assert.equal(vectors.length, robotCases * plan.times.robot.length + pressCases * plan.times.press.length);

    assert.deepEqual(
      [vectors[0].m, vectors[0].sc, vectors[0].r, vectors[0].t],
      ['robot', 'NORMAL', 0, plan.times.robot[0]],
    );
    const firstFault = vectors.find((x) => x.sc === 'GEARBOX_WEAR');
    assert.deepEqual([firstFault.r, firstFault.t], [plan.ramps[0], plan.times.robot[0]]);
    assert.deepEqual([vectors.at(-1).m, vectors.at(-1).sc, vectors.at(-1).r], ['press', 'BEARING_WEAR', 1]);
  });

  it('carries a 64-bin spectrum for the press only, and three values everywhere', () => {
    for (const x of vectors) {
      assert.equal(x.v.length, 3);
      assert.ok(x.v.every(Number.isFinite));
      if (x.m === 'press') assert.equal(x.bins.length, 64);
      else assert.equal(x.bins, undefined);
    }
  });

  it('is deterministic: the seed fixes every number', () => {
    assert.deepEqual(expectedVectors(catalog), vectors);
  });

  it('differs between scenarios, so a port that ignored the scenario would be caught', () => {
    const at = (m, sc, r) => vectors.find((x) => x.m === m && x.sc === sc && x.r === r && x.t === catalog.selftest.times[m][0]);
    assert.notDeepEqual(at('robot', 'NORMAL', 0).v, at('robot', 'GEARBOX_WEAR', 1).v);
    assert.notDeepEqual(at('press', 'NORMAL', 0).bins, at('press', 'CLOGGED_FILTER', 1).bins);
    assert.notDeepEqual(at('press', 'CLOGGED_FILTER', 1).bins, at('press', 'BEARING_WEAR', 1).bins);
  });

  it('refuses a catalog with no plan', () => {
    assert.throws(() => expectedVectors({ ...catalog, selftest: undefined }), /no "selftest" section/);
  });
});

describe('reading serial output', () => {
  const vectors = expectedVectors(catalog);

  it('finds the block among boot noise, and tolerates CRLF', () => {
    const text = `ets Jun 8 2016 00:22:57\r\nrst:0x1 (POWERON_RESET)\r\n${deviceBlock(vectors)}\r\ntrailing\r\n`;
    const parsed = parseSerial(text);

    assert.equal(parsed.complete, true);
    assert.equal(parsed.vectors.length, vectors.length);
    assert.equal(parsed.header.catalog, CATALOG_ID);
    assert.deepEqual(parsed.errors, []);
  });

  it('ignores a block that began before the monitor attached, and takes the first whole one', () => {
    const tail = vectors.slice(10).map(deviceLine).join('\n');
    const text = `${tail}\nCDO-SELFTEST-END\n${deviceBlock(vectors)}\n${deviceBlock(vectors.slice(0, 3))}`;
    const parsed = parseSerial(text);

    assert.equal(parsed.complete, true);
    assert.equal(parsed.vectors.length, vectors.length, 'the first complete block, not the later short one');
  });

  it('reports an unfinished block as incomplete', () => {
    const cut = deviceBlock(vectors).split('\r\n').slice(0, 10).join('\n');
    assert.equal(parseSerial(cut).complete, false);
    assert.equal(parseSerial('nothing useful').complete, false);
  });

  it('records a damaged line instead of throwing', () => {
    const text = 'CDO-SELFTEST-BEGIN\nS {"m":"robot",\nS {"m":"robot","sc":"NORMAL","r":0,"t":4,"v":[1,2,3]}\nCDO-SELFTEST-END';
    const parsed = parseSerial(text);

    assert.equal(parsed.complete, true);
    assert.equal(parsed.vectors.length, 1);
    assert.equal(parsed.errors.length, 1);
  });
});

describe('comparing vectors', () => {
  const expected = expectedVectors(catalog);
  const clone = () => structuredClone(expected);

  it('accepts identical vectors and reports the largest difference', () => {
    const result = compareVectors(expected, clone());
    assert.equal(result.ok, true);
    assert.ok(result.checked > 1000);
    assert.equal(result.worst.expected, result.worst.actual);
  });

  it('accepts differences inside the tolerance, rejects those outside', () => {
    const near = clone();
    near[0].v[0] *= 1 + 1e-10;
    assert.equal(compareVectors(expected, near).ok, true);

    const far = clone();
    far[0].v[0] *= 1 + 1e-4;
    const result = compareVectors(expected, far);
    assert.equal(result.ok, false);
    assert.match(result.failures[0], /robot NORMAL r=0 t=4 channel 0/);
  });

  it('names the exact spectrum bin that is wrong', () => {
    const bad = clone();
    const press = bad.findIndex((x) => x.m === 'press');
    bad[press].bins[37] += 0.01;

    const result = compareVectors(expected, bad);
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((f) => f.includes('bin 37')));
  });

  it('catches a missing vector, an out-of-step vector and a missing spectrum', () => {
    assert.match(compareVectors(expected, clone().slice(0, -1)).failures[0], /Expected 58 vectors/);

    const swapped = clone();
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    assert.ok(compareVectors(expected, swapped).failures.some((f) => /out of step/.test(f)));

    const flat = clone();
    delete flat.find((x) => x.m === 'press').bins;
    assert.equal(compareVectors(expected, flat).ok, false);
  });

  it('treats NaN, null and a missing number as a failure', () => {
    const bad = clone();
    bad[0].v[1] = null;
    assert.equal(compareVectors(expected, bad).ok, false);
  });
});

describe('judging a capture', () => {
  const expected = expectedVectors(catalog);

  it('passes output that matches to 12 significant digits', () => {
    const verdict = judge(`boot noise\n${deviceBlock(expected)}\n`, catalog, CATALOG_ID);
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    assert.match(verdict.message, /agree on \d+ values/);
  });

  it('fails a port with a subtle equation error, such as a wrong coefficient', () => {
    const broken = structuredClone(expected);
    for (const x of broken.filter((v) => v.m === 'press' && v.sc === 'CLOGGED_FILTER')) x.v[1] *= 0.999;

    const verdict = judge(deviceBlock(broken), catalog, CATALOG_ID);
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /disagree/);
    assert.ok(verdict.details.some((d) => d.includes('press CLOGGED_FILTER')));
  });

  it('says so when the board was built from a different catalog', () => {
    const verdict = judge(deviceBlock(expected, 'ffffffffff'), catalog, CATALOG_ID);
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /built from catalog ffffffffff/);
  });

  it('says so when there is no complete block', () => {
    const verdict = judge('just some boot messages', catalog, CATALOG_ID);
    assert.equal(verdict.ok, false);
    assert.match(verdict.message, /No complete self-test block/);
  });

  it('shortens a long list of problems', () => {
    const wrecked = expected.map((x) => ({ ...x, v: x.v.map((n) => n + 1), bins: x.bins }));
    const verdict = judge(deviceBlock(wrecked), catalog, CATALOG_ID);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.details.some((d) => /and \d+ more/.test(d)));
    assert.ok(verdict.details.length <= 14);
  });
});
