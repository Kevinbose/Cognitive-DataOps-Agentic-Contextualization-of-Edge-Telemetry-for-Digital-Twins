/**
 * @file Host side of the on-chip parity self-test.
 *
 * The firmware's models (`firmware/cdo-edge-gateway/simulation.h`) are a C++ port
 * of `sim-models.mjs`. A port can be wrong in ways nobody sees until a demo: a
 * sign, an integer division, an operand order. The self-test settles it on the
 * real chip. A build with `-DCDO_SELFTEST=1` prints the models' output for a
 * fixed plan (seed, ramps and times, all from `catalog.json`), this module builds
 * the same vectors from the JavaScript models, and `compareVectors` says whether
 * they agree.
 *
 * The plan, in the order both sides walk it:
 *
 *   for each machine, in catalog order
 *     for each of its scenarios
 *       for each ramp r (NORMAL uses only r = 0)
 *         a FRESH model seeded with `selftest.seed`
 *         for each time in `selftest.times[machineType]`: one vector
 *
 * @module scripts/lib/selftest
 */

import { createModel, mulberry32 } from './sim-models.mjs';

/** Relative and absolute tolerance. The firmware prints 12 significant digits. */
export const DEFAULT_TOLERANCE = Object.freeze({ rel: 1e-8, abs: 1e-10 });

/**
 * One vector: what the models produce for one (machine, scenario, r, t).
 *
 * @typedef {object} Vector
 * @property {string} m - Machine type, `robot` or `press`.
 * @property {string} sc - Scenario name.
 * @property {number} r - Ramp.
 * @property {number} t - Simulated time in seconds.
 * @property {number[]} v - The three channel values, in catalog order.
 * @property {number[]} [bins] - The press spectrum.
 */

/**
 * The vectors the JavaScript models produce for the catalog's plan.
 *
 * @param {any} catalog
 * @returns {Vector[]}
 */
export function expectedVectors(catalog) {
  const plan = catalog.selftest;
  if (!plan) throw new Error('catalog.json has no "selftest" section');

  /** @type {Vector[]} */
  const vectors = [];

  for (const machine of Object.values(catalog.machines)) {
    const times = plan.times[machine.machineType];
    if (!times) throw new Error(`selftest.times has no entry for "${machine.machineType}"`);

    for (const scenario of machine.scenarios) {
      const ramps = scenario === 'NORMAL' ? [0] : plan.ramps;

      for (const r of ramps) {
        const model = createModel(machine.machineType, machine, mulberry32(plan.seed));
        for (const t of times) {
          const sample = model.sample(t, scenario, r);
          const values = machine.channels.map((c) => sample.channels[c.key]);
          vectors.push({
            m: machine.machineType,
            sc: scenario,
            r,
            t,
            v: values,
            ...(sample.spectrum ? { bins: sample.spectrum } : {}),
          });
        }
      }
    }
  }
  return vectors;
}

/**
 * Pull the first COMPLETE self-test block out of raw serial output.
 *
 * Serial output is messy: boot messages before the block, a block that began
 * before the monitor attached, the same block repeated every few seconds. Only a
 * block with both a BEGIN and an END marker counts, and the first one wins.
 *
 * @param {string} text
 * @returns {{complete: boolean, header: any|null, vectors: Vector[], errors: string[]}}
 */
export function parseSerial(text) {
  const errors = [];
  let header = null;
  /** @type {Vector[]} */
  let vectors = [];
  let inside = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();

    if (line === 'CDO-SELFTEST-BEGIN') {
      inside = true;
      header = null;
      vectors = [];
      continue;
    }
    if (line === 'CDO-SELFTEST-END') {
      if (inside) return { complete: true, header, vectors, errors };
      continue;
    }
    if (!inside) continue;

    if (line.startsWith('H ') || line.startsWith('S ')) {
      try {
        const parsed = JSON.parse(line.slice(2));
        if (line[0] === 'H') header = parsed;
        else vectors.push(parsed);
      } catch {
        errors.push(`Unreadable line: ${line.slice(0, 80)}`);
      }
    }
  }
  return { complete: false, header, vectors, errors };
}

/** @param {number} a @param {number} b @param {{rel: number, abs: number}} tol */
const close = (a, b, tol) => Math.abs(a - b) <= tol.abs + tol.rel * Math.max(Math.abs(a), Math.abs(b));

/**
 * Compare the firmware's vectors with the expected ones.
 *
 * @param {Vector[]} expected
 * @param {Vector[]} actual
 * @param {{rel: number, abs: number}} [tolerance]
 * @returns {{ok: boolean, checked: number, worst: {where: string, expected: number, actual: number}|null, failures: string[]}}
 */
export function compareVectors(expected, actual, tolerance = DEFAULT_TOLERANCE) {
  const failures = [];
  let checked = 0;
  let worst = null;
  let worstError = -1;

  const note = (where, e, a) => {
    const error = Math.abs(e - a);
    if (error > worstError) {
      worstError = error;
      worst = { where, expected: e, actual: a };
    }
  };

  if (actual.length !== expected.length) {
    failures.push(`Expected ${expected.length} vectors, the board printed ${actual.length}.`);
  }

  const count = Math.min(expected.length, actual.length);
  for (let i = 0; i < count; i += 1) {
    const e = expected[i];
    const a = actual[i];
    const label = `${e.m} ${e.sc} r=${e.r} t=${e.t}`;

    if (a.m !== e.m || a.sc !== e.sc || !close(a.r, e.r, tolerance) || !close(a.t, e.t, tolerance)) {
      failures.push(`Vector ${i} is out of step: expected ${label}, got ${a.m} ${a.sc} r=${a.r} t=${a.t}.`);
      continue;
    }

    const pairs = [
      ...e.v.map((value, k) => [`${label} channel ${k}`, value, a.v?.[k]]),
      ...(e.bins ?? []).map((value, k) => [`${label} bin ${k}`, value, a.bins?.[k]]),
    ];
    if (e.bins && a.bins?.length !== e.bins.length) {
      failures.push(`${label}: expected ${e.bins.length} bins, got ${a.bins?.length ?? 0}.`);
    }

    for (const [where, value, got] of pairs) {
      checked += 1;
      if (typeof got !== 'number' || !Number.isFinite(got)) {
        failures.push(`${where}: expected ${value}, got ${got}.`);
        continue;
      }
      note(where, value, got);
      if (!close(value, got, tolerance)) {
        failures.push(`${where}: expected ${value}, got ${got} (off by ${Math.abs(value - got).toExponential(2)}).`);
      }
    }
  }

  return { ok: failures.length === 0, checked, worst, failures };
}

/**
 * Judge a whole serial capture against the catalog.
 *
 * @param {string} serialText
 * @param {any} catalog
 * @param {string} catalogId - From `gen-catalog.mjs`, to spot a stale build.
 * @returns {{ok: boolean, message: string, details: string[]}}
 */
export function judge(serialText, catalog, catalogId) {
  const parsed = parseSerial(serialText);

  if (!parsed.complete) {
    return {
      ok: false,
      message: 'No complete self-test block was found in the serial output.',
      details: ['The block starts with CDO-SELFTEST-BEGIN and ends with CDO-SELFTEST-END. Is the self-test build the one running?'],
    };
  }
  if (parsed.header?.catalog && parsed.header.catalog !== catalogId) {
    return {
      ok: false,
      message: `The board was built from catalog ${parsed.header.catalog}, the repository has ${catalogId}.`,
      details: ['Rebuild and upload the self-test again.'],
    };
  }

  const result = compareVectors(expectedVectors(catalog), parsed.vectors);
  if (result.ok) {
    return {
      ok: true,
      message: `Firmware and JavaScript models agree on ${result.checked} values.`,
      details: result.worst
        ? [`Largest difference: ${Math.abs(result.worst.expected - result.worst.actual).toExponential(2)} at ${result.worst.where}.`]
        : [],
    };
  }
  return {
    ok: false,
    message: `Firmware and JavaScript models disagree (${result.failures.length} problem(s)).`,
    details: [...result.failures.slice(0, 12), ...(result.failures.length > 12 ? [`...and ${result.failures.length - 12} more.`] : []), ...parsed.errors],
  };
}

export default { expectedVectors, parseSerial, compareVectors, judge, DEFAULT_TOLERANCE };
