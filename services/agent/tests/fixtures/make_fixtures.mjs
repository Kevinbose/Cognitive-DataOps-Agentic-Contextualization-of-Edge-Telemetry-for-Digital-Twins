/**
 * Telemetry windows from the simulator's own models, for the agent's tests.
 *
 * Uses server/scripts/lib/sim-models.mjs (the same equations as the firmware)
 * at fixed fault severities, so the Python features are checked against the
 * physics the boards and the simulator really produce. Regenerate with:
 *
 *   node services/agent/tests/fixtures/make_fixtures.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createModel, mulberry32, roundTo } from '../../../../server/scripts/lib/sim-models.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.resolve(here, '../../../../firmware/catalog.json'), 'utf8'));
const SECONDS = 120;

function run(machineId, scenario, r, seed) {
  const machine = catalog.machines[machineId];
  const model = createModel(machine.machineType, machine, mulberry32(seed));
  const channels = Object.fromEntries(machine.channels.map((c) => [c.key, []]));
  const spectra = [];
  const t0 = 1000;
  for (let i = 0; i < SECONDS * 2; i += 1) {
    const t = t0 + i * 0.5;
    const s = model.sample(t, scenario, typeof r === 'function' ? r(i / 2) : r);
    for (const c of machine.channels) channels[c.key].push([Math.round(t * 1000), roundTo(s.channels[c.key], c.decimals)]);
    if (s.spectrum && i % 4 === 0) spectra.push(s.spectrum.map((a) => roundTo(a, 4)));
  }
  return { channels, spectra: spectra.slice(-3) };
}

const out = {
  'press-stamp-01': {
    NORMAL: run('press-stamp-01', 'NORMAL', 0, 11),
    CLOGGED_FILTER_30: run('press-stamp-01', 'CLOGGED_FILTER', 0.3, 12),
    CLOGGED_FILTER_60: run('press-stamp-01', 'CLOGGED_FILTER', 0.6, 13),
    CLOGGED_FILTER_100: run('press-stamp-01', 'CLOGGED_FILTER', 1.0, 14),
    BEARING_WEAR_30: run('press-stamp-01', 'BEARING_WEAR', 0.3, 15),
    BEARING_WEAR_60: run('press-stamp-01', 'BEARING_WEAR', 0.6, 16),
    BEARING_WEAR_100: run('press-stamp-01', 'BEARING_WEAR', 1.0, 17),
  },
  'robot-weld-01': {
    NORMAL: run('robot-weld-01', 'NORMAL', 0, 21),
    GEARBOX_WEAR_30: run('robot-weld-01', 'GEARBOX_WEAR', 0.3, 22),
    GEARBOX_WEAR_60: run('robot-weld-01', 'GEARBOX_WEAR', 0.6, 23),
    GEARBOX_WEAR_100: run('robot-weld-01', 'GEARBOX_WEAR', 1.0, 24),
    GEARBOX_WEAR_RAMP: run('robot-weld-01', 'GEARBOX_WEAR', (s) => Math.min(1, s / 240) + 0.25, 25),
  },
};

fs.writeFileSync(path.join(here, 'sim_windows.json'), JSON.stringify(out));
console.log(`wrote ${path.join(here, 'sim_windows.json')}`);
