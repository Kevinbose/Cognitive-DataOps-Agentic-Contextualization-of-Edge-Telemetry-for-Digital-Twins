import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import reducer, {
  SERIES_LENGTH,
  ackReceived,
  announced,
  announcementsConsumed,
  connectionChanged,
  deviceUpdated,
  samplesReceived,
  selectAlarmTints,
  selectDeviceSummary,
  snapshotReceived,
  tintsEqual,
} from '../src/features/telemetry/telemetrySlice.js';

const device = (machineId, state = 'online', extra = {}) => ({
  machineId,
  label: `Device ${machineId}`,
  state,
  channels: [
    { key: 'PRESSURE', sensorId: `${machineId.toUpperCase()}.PRESSURE`, label: 'Oil pressure', unit: 'bar' },
  ],
  ...extra,
});

const sample = (machineId, status = 'normal', extra = {}) => ({
  sensorId: `${machineId.toUpperCase()}.PRESSURE`,
  machineId,
  key: 'PRESSURE',
  value: 4.5,
  unit: 'bar',
  decimals: 2,
  ts: 1,
  rx: 1,
  status,
  ...extra,
});

const initial = () => reducer(undefined, { type: '@@init' });
const run = (actions, start = initial()) => actions.reduce((state, action) => reducer(state, action), start);
const texts = (state) => state.announcements.map((a) => a.text);

describe('samples', () => {
  it('keeps the newest sample per channel and a bounded series', () => {
    let state = initial();
    for (let i = 0; i < SERIES_LENGTH + 50; i += 1) {
      state = reducer(state, samplesReceived([sample('press', 'normal', { value: i })]));
    }
    assert.equal(state.latest['PRESS.PRESSURE'].value, SERIES_LENGTH + 49);
    assert.equal(state.series['PRESS.PRESSURE'].length, SERIES_LENGTH);
    assert.equal(state.series['PRESS.PRESSURE'][0], 50, 'the oldest points were dropped');
  });

  it('handles a batch of many samples in one action', () => {
    const state = reducer(undefined, samplesReceived([sample('a'), sample('b'), sample('c')]));
    assert.equal(Object.keys(state.latest).length, 3);
  });
});

describe('announcements are about CONDITIONS, damped, and never about values', () => {
  const withDevice = () =>
    run([snapshotReceived({ devices: [device('press')], latest: {}, spectra: {} })]);

  it('is silent for the first sample and for steady values', () => {
    const state = run(Array.from({ length: 20 }, () => samplesReceived([sample('press')])), withDevice());
    assert.deepEqual(texts(state), []);
  });

  it('announces a new condition only after it has held for four samples', () => {
    let state = run([samplesReceived([sample('press')])], withDevice());
    for (let i = 0; i < 3; i += 1) state = reducer(state, samplesReceived([sample('press', 'alarm')]));
    assert.deepEqual(texts(state), [], 'three samples is still noise');

    state = reducer(state, samplesReceived([sample('press', 'alarm')]));
    assert.deepEqual(texts(state), ['Oil pressure is in alarm']);
  });

  it('does not announce a flap that recovers inside the window', () => {
    let state = run([samplesReceived([sample('press')])], withDevice());
    const pattern = ['alarm', 'alarm', 'normal', 'alarm', 'normal', 'alarm', 'alarm', 'normal'];
    for (const status of pattern) state = reducer(state, samplesReceived([sample('press', status)]));
    assert.deepEqual(texts(state), []);
  });

  it('announces the way back to normal, and says so once', () => {
    let state = run([samplesReceived([sample('press')])], withDevice());
    for (let i = 0; i < 4; i += 1) state = reducer(state, samplesReceived([sample('press', 'warn')]));
    for (let i = 0; i < 10; i += 1) state = reducer(state, samplesReceived([sample('press', 'normal')]));
    assert.deepEqual(texts(state), ['Oil pressure is in warning', 'Oil pressure is normal']);
  });

  it('announces device state changes, but not an unchanged update', () => {
    let state = run([snapshotReceived({ devices: [device('press')], latest: {}, spectra: {} })]);
    state = reducer(state, deviceUpdated(device('press', 'online', { label: 'Device press' })));
    assert.deepEqual(texts(state), []);

    state = reducer(state, deviceUpdated(device('press', 'offline')));
    assert.deepEqual(texts(state), ['Device press is offline']);
  });

  it('treats the first connection as silent and later changes as news', () => {
    let state = reducer(undefined, connectionChanged('live'));
    assert.deepEqual(texts(state), []);

    state = reducer(state, connectionChanged('reconnecting'));
    state = reducer(state, connectionChanged('live'));
    assert.deepEqual(texts(state), [
      'Live data connection lost, reconnecting',
      'Live data connection restored',
    ]);
  });

  it('consumes announcements up to an id and keeps the later ones', () => {
    let state = run([announced('one'), announced('two'), announced('three')]);
    const secondId = state.announcements[1].id;
    state = reducer(state, announcementsConsumed(secondId));
    assert.deepEqual(texts(state), ['three']);
  });

  it('bounds the queue so a long outage cannot grow it without limit', () => {
    let state = initial();
    for (let i = 0; i < 50; i += 1) state = reducer(state, announced(`n${i}`));
    assert.ok(state.announcements.length <= 8);
    assert.equal(state.announcements.at(-1).text, 'n49');
  });
});

describe('snapshot and acknowledgements', () => {
  it('seeds devices, latest values and series from the snapshot', () => {
    const state = reducer(
      undefined,
      snapshotReceived({
        devices: [device('press'), device('robot')],
        latest: { 'PRESS.PRESSURE': sample('press') },
        spectra: { press: { key: 'S', ts: 1, amp: [0.1] } },
      }),
    );
    assert.deepEqual(Object.keys(state.devices).sort(), ['press', 'robot']);
    assert.deepEqual(state.series['PRESS.PRESSURE'], [4.5]);
    assert.equal(state.spectra.press.amp.length, 1);
  });

  it('keeps the newest acks first and bounded', () => {
    let state = initial();
    for (let i = 0; i < 30; i += 1) state = reducer(state, ackReceived({ cmdId: `c${i}`, machineId: 'press' }));
    assert.equal(state.acks[0].cmdId, 'c29');
    assert.ok(state.acks.length <= 12);
  });
});

describe('selectAlarmTints', () => {
  const stateOf = (devices, latest) => ({ telemetry: { devices, latest } });
  const bound = (machineId, status, meshName) => sample(machineId, status, { meshName });

  it('tints only bound channels in warn or alarm', () => {
    const tints = selectAlarmTints(
      stateOf(
        { press: device('press'), robot: device('robot') },
        {
          'PRESS.PRESSURE': bound('press', 'alarm', 'Pump'),
          'ROBOT.PRESSURE': sample('robot', 'alarm'), // unbound: no mesh
        },
      ),
    );
    assert.deepEqual(tints, [['Pump', 'alarm']]);
  });

  it('ignores normal readings', () => {
    const tints = selectAlarmTints(
      stateOf({ press: device('press') }, { 'PRESS.PRESSURE': bound('press', 'normal', 'Pump') }),
    );
    assert.deepEqual(tints, []);
  });

  it('drops the tint when the device is no longer online (a stale value is not evidence)', () => {
    for (const state of ['stale', 'offline', 'unknown']) {
      const tints = selectAlarmTints(
        stateOf({ press: device('press', state) }, { 'PRESS.PRESSURE': bound('press', 'alarm', 'Pump') }),
      );
      assert.deepEqual(tints, [], state);
    }
  });

  it('lets alarm outrank warn when two channels drive one mesh', () => {
    const tints = selectAlarmTints(
      stateOf(
        { a: device('a'), b: device('b') },
        { 'A.PRESSURE': bound('a', 'warn', 'Pump'), 'B.PRESSURE': bound('b', 'alarm', 'Pump') },
      ),
    );
    assert.deepEqual(tints, [['Pump', 'alarm']]);
  });

  it('is sorted, so equal meaning compares equal', () => {
    const tints = selectAlarmTints(
      stateOf(
        { a: device('a'), b: device('b') },
        { 'B.PRESSURE': bound('b', 'warn', 'Zed'), 'A.PRESSURE': bound('a', 'warn', 'Alpha') },
      ),
    );
    assert.deepEqual(tints.map(([mesh]) => mesh), ['Alpha', 'Zed']);
  });

  it('tintsEqual compares by meaning, not identity', () => {
    assert.equal(tintsEqual([['a', 'warn']], [['a', 'warn']]), true);
    assert.equal(tintsEqual([['a', 'warn']], [['a', 'alarm']]), false);
    assert.equal(tintsEqual([['a', 'warn']], []), false);
    assert.equal(tintsEqual([], []), true);
  });
});

describe('selectDeviceSummary', () => {
  it('counts online devices out of all devices', () => {
    const state = run([
      snapshotReceived({
        devices: [device('a'), device('b', 'offline'), device('c', 'stale')],
        latest: {},
        spectra: {},
      }),
    ]);
    assert.deepEqual(selectDeviceSummary({ telemetry: state }), { online: 1, total: 3 });
  });
});
