/**
 * The simulator is demo insurance and the source of the thesis evaluation's
 * ground truth, so the properties the demo depends on are pinned here: which
 * faults alarm, which deliberately do not, and what each spectrum looks like.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildBirth, loadCatalog } from '../scripts/lib/gateway.mjs';
import { PressModel, RobotModel, createModel, mulberry32 } from '../scripts/lib/sim-models.mjs';
import { evaluateStatus } from '../src/utils/channelStatus.js';
import { sensorIdFor } from '../src/utils/mqttTopics.js';
import { sensorIdSchema } from '../src/validators/meshNode.validator.js';
import { birthPayloadSchema } from '../src/validators/telemetry.validator.js';

const catalog = loadCatalog();
const PRESS = catalog.machines['press-stamp-01'];
const ROBOT = catalog.machines['robot-weld-01'];
const limitsOf = (machine, key) => machine.channels.find((c) => c.key === key).limits;

/** Run a model for `seconds` at 2 Hz and collect every sample. */
function run(machineType, machine, scenario, r, { seconds = 300, seed = 5 } = {}) {
  const model = createModel(machineType, machine, mulberry32(seed));
  const samples = [];
  for (let t = 0; t < seconds; t += 0.5) samples.push(model.sample(t, scenario, r));
  return samples;
}

const series = (samples, key) => samples.map((s) => s.channels[key]);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const max = (xs) => Math.max(...xs);
const min = (xs) => Math.min(...xs);

/** Mean amplitude of the bins at or above `hz` across many spectra. */
function highBandMean(samples, layout, hz) {
  const first = Math.round((hz - layout.startHz) / layout.stepHz);
  const values = samples.flatMap((s) => s.spectrum.slice(first));
  return mean(values);
}

describe('catalog', () => {
  it('produces births the backend accepts, for every machine', () => {
    for (const [id, machine] of Object.entries(catalog.machines)) {
      const birth = buildBirth(id, machine, { fw: '1', mac: 'AA:BB:CC:DD:EE:FF', bootId: 'abcd1234' });
      const result = birthPayloadSchema.safeParse(birth);
      assert.ok(result.success, `${id}: ${result.error?.issues[0]?.message}`);
    }
  });

  it('announces exactly what the catalog declares (no drift between catalog and birth)', () => {
    for (const [id, machine] of Object.entries(catalog.machines)) {
      const birth = buildBirth(id, machine, { fw: '1', mac: 'AA:BB:CC:DD:EE:FF', bootId: 'abcd1234' });
      assert.deepEqual(birth.channels, machine.channels);
      assert.deepEqual(birth.spectrum, machine.spectrum);
      assert.deepEqual(birth.scenarios, machine.scenarios);
      assert.equal(birth.intervalMs, machine.intervalMs);
    }
  });

  it('gives every channel a valid, unique sensor id', () => {
    const seen = new Set();
    for (const [id, machine] of Object.entries(catalog.machines)) {
      for (const channel of machine.channels) {
        const sensorId = sensorIdFor(id, channel.key);
        assert.equal(sensorIdSchema.parse(sensorId), sensorId);
        assert.ok(!seen.has(sensorId), `duplicate ${sensorId}`);
        seen.add(sensorId);
      }
    }
    assert.equal(seen.size, 6, 'two machines with three channels each');
  });

  it('keeps every limit inside the channel range, with warn before alarm', () => {
    for (const machine of Object.values(catalog.machines)) {
      for (const { key, min: lo, max: hi, limits } of machine.channels) {
        for (const [name, value] of Object.entries(limits)) {
          assert.ok(value > lo && value < hi, `${key}.${name}=${value} outside (${lo}, ${hi})`);
        }
        if (limits.warnHigh !== undefined) assert.ok(limits.warnHigh < limits.alarmHigh, `${key} high limits`);
        if (limits.warnLow !== undefined) assert.ok(limits.warnLow > limits.alarmLow, `${key} low limits`);
      }
    }
  });

  it('keeps the firmware message sizes within the PubSubClient buffer budget', () => {
    const BUFFER = 2048;
    for (const [id, machine] of Object.entries(catalog.machines)) {
      const birth = JSON.stringify(buildBirth(id, machine, { fw: '1.0.0', mac: 'AA:BB:CC:DD:EE:FF', bootId: 'abcd1234' }));
      const topicLength = `cdo/v1/vit-lab/${id}/birth`.length;
      assert.ok(birth.length < 1400, `${id} birth is ${birth.length} bytes; the firmware budget is 1400`);
      assert.ok(5 + 2 + topicLength + birth.length <= BUFFER);
    }

    // Worst case spectrum: 64 bins printed as 9.999.
    const spectrum = JSON.stringify({
      v: 1,
      seq: 4_294_967_295,
      ts: 1_767_225_600_123,
      key: PRESS.spectrum.key,
      amp: Array(PRESS.spectrum.count).fill(9.999),
    });
    assert.ok(spectrum.length + 7 + 40 < 800, `spectrum frame is ${spectrum.length} bytes`);
  });
});

describe('simulation models', () => {
  it('are reproducible for a given seed', () => {
    const a = run('press', PRESS, 'CLOGGED_FILTER', 0.6, { seconds: 30, seed: 9 });
    const b = run('press', PRESS, 'CLOGGED_FILTER', 0.6, { seconds: 30, seed: 9 });
    const c = run('press', PRESS, 'CLOGGED_FILTER', 0.6, { seconds: 30, seed: 10 });
    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });

  it('compute the RMS scalar from the spectrum bins, so the two views agree', () => {
    for (const scenario of ['NORMAL', 'CLOGGED_FILTER', 'BEARING_WEAR']) {
      for (const sample of run('press', PRESS, scenario, 0.5, { seconds: 20 })) {
        assert.ok(Math.abs(sample.channels.BEARING_VIBRATION_RMS - PressModel.rmsOf(sample.spectrum)) < 1e-9);
      }
    }
  });
});

describe('press, healthy', () => {
  const samples = run('press', PRESS, 'NORMAL', 0, { seconds: 600 });

  it('holds vibration near 1.3 mm/s and never reaches the warn limit', () => {
    const rms = series(samples, 'BEARING_VIBRATION_RMS');
    assert.ok(mean(rms) > 1.2 && mean(rms) < 1.45, `mean RMS ${mean(rms).toFixed(3)}`);
    assert.ok(max(rms) < limitsOf(PRESS, 'BEARING_VIBRATION_RMS').warnHigh);
  });

  it('holds lube pressure at 4.5 bar and motor current under the warn limit', () => {
    const pressure = series(samples, 'LUBE_OIL_PRESSURE');
    assert.ok(Math.abs(mean(pressure) - 4.5) < 0.02);
    assert.ok(min(pressure) > limitsOf(PRESS, 'LUBE_OIL_PRESSURE').warnLow);
    assert.ok(max(series(samples, 'MAIN_MOTOR_CURRENT')) < limitsOf(PRESS, 'MAIN_MOTOR_CURRENT').warnHigh);
  });

  it('raises no false alarm on any channel', () => {
    for (const channel of PRESS.channels) {
      for (const value of series(samples, channel.key)) {
        assert.equal(evaluateStatus(value, channel.limits), 'normal', `${channel.key}=${value}`);
      }
    }
  });

  it('peaks at the motor shaft frequency (1X, 24.7 Hz, bin 2)', () => {
    const spectrum = samples[10].spectrum;
    const peak = spectrum.indexOf(Math.max(...spectrum));
    assert.equal(peak, 2);
  });
});

describe('press, CLOGGED_FILTER', () => {
  const late = run('press', PRESS, 'CLOGGED_FILTER', 1);
  const healthy = run('press', PRESS, 'NORMAL', 0);
  const layout = PRESS.spectrum;

  it('drops lube pressure into alarm (the transducer is downstream of the filter)', () => {
    assert.ok(mean(series(late, 'LUBE_OIL_PRESSURE')) < limitsOf(PRESS, 'LUBE_OIL_PRESSURE').alarmLow);
  });

  it('raises vibration into alarm', () => {
    assert.ok(mean(series(late, 'BEARING_VIBRATION_RMS')) > limitsOf(PRESS, 'BEARING_VIBRATION_RMS').alarmHigh);
  });

  it('crosses the pressure alarm at about three quarters of the ramp', () => {
    const crossing = [0.5, 0.6, 0.7, 0.8, 0.9].find((r) => {
      const s = run('press', PRESS, 'CLOGGED_FILTER', r, { seconds: 120 });
      return mean(series(s, 'LUBE_OIL_PRESSURE')) <= 3.0;
    });
    assert.ok(crossing >= 0.7 && crossing <= 0.8, `crossed at r=${crossing}`);
  });

  it('adds a BROADBAND floor above 300 Hz: energy rises everywhere, with no dominant line', () => {
    assert.ok(highBandMean(late, layout, 300) > 8 * highBandMean(healthy, layout, 300));

    const flatness = late.slice(-40).map((s) => {
      const band = [...s.spectrum.slice(Math.round(300 / layout.stepHz))].sort((a, b) => a - b);
      return band.at(-1) / band[Math.floor(band.length / 2)];
    });
    assert.ok(mean(flatness) < 2.5, `peak-to-median above 300 Hz is ${mean(flatness).toFixed(2)}; broadband should be flat`);
  });

  it('raises motor current only slightly (friction)', () => {
    const ratio = mean(series(late, 'MAIN_MOTOR_CURRENT')) / mean(series(healthy, 'MAIN_MOTOR_CURRENT'));
    assert.ok(ratio > 1.0 && ratio < 1.06, `ratio ${ratio.toFixed(3)}`);
  });
});

describe('press, BEARING_WEAR', () => {
  const late = run('press', PRESS, 'BEARING_WEAR', 1, { seconds: 600 });
  const healthy = run('press', PRESS, 'NORMAL', 0);
  const layout = PRESS.spectrum;
  const limits = limitsOf(PRESS, 'BEARING_VIBRATION_RMS');

  it('NEVER reaches the vibration alarm limit, so a threshold rule cannot catch it', () => {
    assert.ok(max(series(late, 'BEARING_VIBRATION_RMS')) < limits.alarmHigh);
  });

  it('does raise vibration clearly above healthy, past the warn limit on average', () => {
    const rms = series(late, 'BEARING_VIBRATION_RMS');
    assert.ok(mean(rms) > limits.warnHigh);
    assert.ok(mean(rms) > 1.8 * mean(series(healthy, 'BEARING_VIBRATION_RMS')));
  });

  it('leaves lube pressure healthy: that is what separates it from a clogged filter', () => {
    const pressure = series(late, 'LUBE_OIL_PRESSURE');
    assert.ok(Math.abs(mean(pressure) - 4.5) < 0.02);
    assert.ok(min(pressure) > limitsOf(PRESS, 'LUBE_OIL_PRESSURE').warnLow);
  });

  it('adds a DISCRETE harmonic family at 3.55 to 17.75 times the shaft frequency', () => {
    const shaft = PRESS.spectrum.fundamentalHz;
    const avg = Array(layout.count).fill(0);
    for (const { spectrum } of late) spectrum.forEach((a, i) => (avg[i] += a / late.length));
    const base = Array(layout.count).fill(0);
    for (const { spectrum } of healthy) spectrum.forEach((a, i) => (base[i] += a / healthy.length));

    for (const order of [3.55, 7.1, 10.65, 14.2, 17.75]) {
      const bin = Math.round((order * shaft) / layout.stepHz);
      assert.ok(avg[bin] > 4 * base[bin], `no defect line at ${(order * shaft).toFixed(0)} Hz (bin ${bin})`);
    }
  });

  it('is PEAKY above 300 Hz where a clogged filter is flat', () => {
    const peakiness = late.slice(-40).map((s) => {
      const band = [...s.spectrum.slice(Math.round(300 / layout.stepHz))].sort((a, b) => a - b);
      return band.at(-1) / band[Math.floor(band.length / 2)];
    });
    assert.ok(mean(peakiness) > 3, `peak-to-median above 300 Hz is ${mean(peakiness).toFixed(2)}`);
  });
});

describe('robot', () => {
  it('runs healthy without a false warn on any channel', () => {
    const samples = run('robot', ROBOT, 'NORMAL', 0, { seconds: 600 });
    for (const channel of ROBOT.channels) {
      const values = series(samples, channel.key).slice(60); // let the gun warm up
      for (const value of values) {
        assert.equal(evaluateStatus(value, channel.limits), 'normal', `${channel.key}=${value}`);
      }
    }
  });

  it('keeps weld-gun temperature in its documented band (about 37 to 58 degC)', () => {
    const temp = series(run('robot', ROBOT, 'NORMAL', 0, { seconds: 600 }), 'WELD_GUN_TEMP').slice(60);
    assert.ok(min(temp) > 35 && max(temp) < 62, `${min(temp).toFixed(1)} to ${max(temp).toFixed(1)}`);
  });

  it('GEARBOX_WEAR drives torque through warn to alarm as the ramp advances', () => {
    const torqueLimits = limitsOf(ROBOT, 'AXIS_4_SERVO_TORQUE');
    const peakAt = (r) => max(series(run('robot', ROBOT, 'GEARBOX_WEAR', r, { seconds: 200 }), 'AXIS_4_SERVO_TORQUE'));

    assert.ok(peakAt(0) < torqueLimits.warnHigh);
    assert.ok(peakAt(0.5) >= torqueLimits.warnHigh, 'warn by mid-ramp');
    assert.ok(peakAt(0.4) < torqueLimits.alarmHigh);
    assert.ok(peakAt(1) >= torqueLimits.alarmHigh, 'alarm at full wear');
  });

  it('GEARBOX_WEAR pushes tool-centre-point deviation into alarm', () => {
    const tcp = series(run('robot', ROBOT, 'GEARBOX_WEAR', 1, { seconds: 100 }), 'TOOL_CENTER_POINT_DEVIATION');
    assert.ok(mean(tcp) > limitsOf(ROBOT, 'TOOL_CENTER_POINT_DEVIATION').alarmHigh);
  });

  it('heats the weld gun only while the gun is energised (first-order model)', () => {
    const model = new RobotModel({ cycleSec: 8, rng: mulberry32(1), channels: ROBOT.channels });
    // Off-phase: temperature relaxes toward the 32 degC ambient.
    assert.equal(RobotModel.weld(0.3), 0);
    assert.equal(RobotModel.weld(0.6), 1);
    const before = model.sample(0, 'NORMAL', 0).channels.WELD_GUN_TEMP;
    const afterWeld = model.sample(6, 'NORMAL', 0).channels.WELD_GUN_TEMP; // spans p = 0.55..0.75
    assert.ok(afterWeld > before);
  });
});
