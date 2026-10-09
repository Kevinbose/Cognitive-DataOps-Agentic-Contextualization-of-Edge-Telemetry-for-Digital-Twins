/**
 * End-to-end ingestion against real infrastructure: an in-process MQTT broker
 * (aedes), a disposable MongoDB database, the real services, a real Socket.io
 * connection, and two simulated gateways speaking the wire contract.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { io } from 'socket.io-client';

import { SimulatedGateway } from '../scripts/lib/gateway.mjs';
import {
  connectTestDatabase,
  dropTestDatabase,
  fastCatalog,
  hasKey,
  rawClient,
  startBroker,
  startHttp,
  waitFor,
} from './helpers.js';

const SITE = 'vit-lab';
const PRESS = 'press-stamp-01';
const ROBOT = 'robot-weld-01';
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';

/** @type {any} */ let broker;
/** @type {any} */ let http;
/** @type {any} */ let socket;
/** @type {SimulatedGateway[]} */ let gateways = [];

// Services are imported dynamically: they read config at import time, and
// `test/setup.js` must have set the environment first.
/** @type {any} */ let telemetry;
/** @type {any} */ let devices;
/** @type {any} */ let store;
/** @type {any} */ let models;

const events = { batches: [], spectra: [], updates: [], acks: [], snapshot: null };

const silence = async (fn) => {
  const { warn } = console;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

const publicState = (machineId) => devices.listPublicDevices().find((d) => d.machineId === machineId);
const latestOf = (sensorId) => telemetry.getLatestSamples().find((s) => s.sensorId === sensorId);

function startGateway(machineId, extra = {}) {
  const gateway = new SimulatedGateway({
    machineId,
    url: broker.url,
    siteId: SITE,
    catalog: fastCatalog(),
    seed: 3,
    ...extra,
  });
  gateways.push(gateway);
  return gateway.start().then(() => gateway);
}

describe('ingestion pipeline', () => {
  before(async () => {
    telemetry = await import('../src/services/telemetry.service.js');
    devices = await import('../src/services/device.service.js');
    store = await import('../src/services/telemetryStore.service.js');
    models = {
      Device: (await import('../src/models/Device.model.js')).Device,
      Reading: (await import('../src/models/TelemetryReading.model.js')).TelemetryReading,
      Spectrum: (await import('../src/models/TelemetrySpectrum.model.js')).TelemetrySpectrum,
    };
    const { startBindingIndex } = await import('../src/services/bindingIndex.service.js');
    const { waitForConnection } = await import('../src/services/mqtt.service.js');

    broker = await startBroker();
    await connectTestDatabase();
    await store.ensureTelemetryStore();
    http = await startHttp();
    await startBindingIndex({ periodicMs: 0 });

    await telemetry.startIngestion({ url: broker.url, persist: true, clientId: 'test-backend' });
    await waitForConnection();

    socket = io(http.url, { transports: ['websocket'], forceNew: true });
    socket.on('snapshot', (s) => (events.snapshot = s));
    socket.on('telemetry:batch', (b) => events.batches.push(b));
    socket.on('spectrum:frame', (f) => events.spectra.push(f));
    socket.on('device:update', (d) => events.updates.push(d));
    socket.on('device:ack', (a) => events.acks.push(a));
    await new Promise((resolve) => socket.on('connect', resolve));

    await startGateway(ROBOT);
    await startGateway(PRESS);
  });

  after(async () => {
    socket?.close();
    await Promise.all(gateways.map((g) => g.stop({ graceful: true }).catch(() => {})));
    await telemetry.stopIngestionAndDisconnect().catch(() => {});
    await http?.stop();
    await broker?.stop();
    await dropTestDatabase();
  });

  it('builds the device registry from retained birth and status messages', async () => {
    await waitFor(
      () =>
        [ROBOT, PRESS].every((id) => publicState(id)?.state === 'online' && publicState(id)?.announced),
      { message: 'both devices announced and online' },
    );

    const press = publicState(PRESS);
    assert.equal(press.label, 'Stamping press 01');
    assert.equal(press.machineType, 'press');
    assert.deepEqual(
      press.channels.map((c) => c.key),
      ['MAIN_MOTOR_CURRENT', 'LUBE_OIL_PRESSURE', 'BEARING_VIBRATION_RMS'],
    );
    assert.equal(press.channels[1].sensorId, LUBE);
    assert.equal(press.spectrum.count, 64);
    assert.deepEqual(press.scenarios, ['NORMAL', 'CLOGGED_FILTER', 'BEARING_WEAR']);
  });

  it('persists the device catalog so the UI has it before the broker replays anything', async () => {
    const doc = await waitFor(() => models.Device.findOne({ machineId: PRESS }).lean(), { message: 'device doc' });
    assert.equal(doc.channels.length, 3);
    assert.equal(doc.siteId, SITE);
    assert.ok(!('sensorId' in doc.channels[0]), 'derived sensor ids are not stored');
  });

  it('sends a snapshot on connect so a fresh tab is never blank', async () => {
    await waitFor(() => latestOf(LUBE), { message: 'a sample to snapshot' });

    const late = io(http.url, { transports: ['websocket'], forceNew: true });
    try {
      const snapshot = await new Promise((resolve, reject) => {
        late.on('snapshot', resolve);
        late.on('connect_error', reject);
      });
      assert.equal(typeof snapshot.serverTime, 'number');
      assert.ok(snapshot.devices.some((d) => d.machineId === PRESS && d.channels.length === 3));
      assert.ok(snapshot.latest[LUBE], 'latest values are included');
    } finally {
      late.close();
    }
  });

  it('normalises samples: sensor id, unit, decimals, status, timestamps', async () => {
    await waitFor(() => events.batches.flat().some((s) => s.sensorId === LUBE), { message: 'lube samples' });
    const sample = events.batches.flat().find((s) => s.sensorId === LUBE);

    assert.equal(sample.machineId, PRESS);
    assert.equal(sample.key, 'LUBE_OIL_PRESSURE');
    assert.equal(sample.unit, 'bar');
    assert.equal(sample.decimals, 2);
    assert.equal(sample.status, 'normal');
    assert.ok(Math.abs(sample.value - 4.5) < 0.5);
    assert.ok(Math.abs(sample.ts - Date.now()) < 5000);
    assert.ok(sample.rx >= sample.ts - 1000);
    assert.ok(!('assetId' in sample), 'an unbound sensor carries no asset');
  });

  it('streams 64-bin spectrum frames that match the declared layout', async () => {
    await waitFor(() => events.spectra.length > 0, { message: 'spectrum frame' });
    const frame = events.spectra.at(-1);
    assert.equal(frame.machineId, PRESS);
    assert.equal(frame.key, 'BEARING_SPECTRUM');
    assert.equal(frame.amp.length, 64);
    assert.ok(frame.amp.every((a) => a >= 0));
  });

  it('never exposes simulator ground truth on any outbound surface', async () => {
    await waitFor(() => events.updates.length > 0, { message: 'device updates' });
    await waitFor(() => devices.getDeviceState(PRESS).simTruth, { message: 'diag with sim truth' });

    const forbidden = (key) => ['sim', 'simTruth', 'scenario', 'ramp'].includes(key.toLowerCase()) && key !== 'scenarios';
    assert.equal(hasKey(events.updates, forbidden), false, 'device:update payloads');
    assert.equal(hasKey(events.snapshot, forbidden), false, 'snapshot');
    assert.equal(hasKey(devices.listPublicDevices(), forbidden), false, 'device list');
    assert.equal(hasKey(events.batches, forbidden), false, 'telemetry batches');

    const res = await fetch(`${http.url}/api/v1/devices`);
    assert.equal(hasKey(await res.json(), forbidden), false, 'GET /devices');

    // The dedicated endpoint is the only place it appears.
    const truth = await (await fetch(`${http.url}/api/v1/devices/${PRESS}/sim`)).json();
    assert.equal(truth.data.scenario, 'NORMAL');
  });

  it('writes readings and spectra into the time-series collections', async () => {
    await waitFor(async () => (await models.Reading.countDocuments({ 'meta.sensorId': LUBE })) >= 3, {
      message: 'stored readings',
    });
    const doc = await models.Reading.findOne({ 'meta.sensorId': LUBE }).lean();
    assert.deepEqual(Object.keys(doc).sort(), ['_id', 'meta', 'ts', 'value']);
    assert.ok(doc.ts instanceof Date);

    await waitFor(async () => (await models.Spectrum.countDocuments({ 'meta.machineId': PRESS })) >= 1, {
      message: 'stored spectra',
    });
    const spectrum = await models.Spectrum.findOne({ 'meta.machineId': PRESS }).lean();
    assert.equal(spectrum.amp.length, 64);
    assert.equal(store.getStoreStats().mode.readings, 'timeseries');
  });

  it('serves bucketed history from what it stored', async () => {
    const res = await fetch(`${http.url}/api/v1/telemetry/history?sensorId=${LUBE}&bucketSec=1`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.data.length >= 1);
    const point = body.data[0];
    assert.ok(point.min <= point.avg && point.avg <= point.max);
    assert.equal(body.meta.sensorId, LUBE);

    assert.equal((await fetch(`${http.url}/api/v1/telemetry/history?sensorId=a/b`)).status, 422);
    assert.equal(
      (await fetch(`${http.url}/api/v1/telemetry/history?sensorId=${LUBE}&from=2026-02-02&to=2026-02-01`)).status,
      422,
    );
  });

  it('counts and ignores malformed traffic without disturbing the good stream', async () => {
    const before = telemetry.getIngestStats().messages;
    const raw = await rawClient(broker.url);
    const base = `cdo/v1/${SITE}`;

    await raw.publish(`${base}/ghost-01/telemetry`, 'this is not json');
    await raw.publish(`${base}/ghost-01/telemetry`, JSON.stringify({ v: 1, seq: 1, ts: 1, synced: true, m: { lower: 1 } }));
    await raw.publish(`${base}/ghost-01/telemetry`, JSON.stringify({ v: 1, seq: 1, ts: 1, synced: true, m: { A: 'x' } }));
    await raw.publish(`${base}/ghost-01/status`, 'maybe');
    await raw.publish(`${base}/ghost-01/telemetry`, 'x'.repeat(9000)); // oversized
    await raw.publish(`${base}/ghost-01/birth`, JSON.stringify({ v: 1 }));
    await raw.publish(`${base}/ghost-01/ack`, JSON.stringify({ cmdId: 'c-1', name: 'explode', ok: true, detail: '' }));
    await raw.publish(`${base}/ghost-01/not-a-suffix`, '1');
    await raw.publish(`${base}/BAD_ID/telemetry`, '{}');
    await raw.publish(`cdo/v1/other-lab/${PRESS}/telemetry`, '{}'); // wrong site

    // A birth whose body claims a different machine than its topic.
    const steal = structuredClone(fastCatalog().machines[PRESS]);
    await raw.publish(
      `${base}/ghost-01/birth`,
      JSON.stringify({
        v: 1,
        machineId: PRESS,
        machineType: 'press',
        label: 'Hijack',
        fw: '9',
        mac: 'AA:BB:CC:DD:EE:01',
        bootId: 'deadbeef',
        intervalMs: 500,
        scenarios: [],
        channels: steal.channels,
        spectrum: null,
      }),
    );

    // A sentinel on the same connection acts as a barrier: once it has been
    // processed, everything published before it has been too.
    await raw.publish(`${base}/sentinel-01/status`, 'online');
    await raw.end();
    await waitFor(() => devices.getDeviceState('sentinel-01'), { message: 'sentinel processed' });

    const after = telemetry.getIngestStats().messages;
    assert.equal(after.invalid - before.invalid, 8, 'eight well-addressed messages were invalid');
    assert.equal(after.unknownTopic - before.unknownTopic, 1, 'a malformed machine id matches the wildcard but not the grammar');
    assert.equal(after.invalidByReason['machine-id-mismatch'] >= 1, true);
    assert.equal(after.invalidByReason.oversized >= 1, true);

    assert.equal(devices.getDeviceState('ghost-01'), undefined, 'garbage must not create a device');
    assert.equal(publicState(PRESS).label, 'Stamping press 01', 'a mismatched birth must not overwrite a machine');

    const seen = latestOf(LUBE).rx;
    await waitFor(() => latestOf(LUBE).rx > seen, { message: 'good stream still flowing' });
  });

  it('drops duplicate sequence numbers and counts gaps as packet loss', async () => {
    const dummy = 'lab-dummy-01';
    const raw = await rawClient(broker.url);
    const base = `cdo/v1/${SITE}/${dummy}`;
    const birth = (bootId) =>
      JSON.stringify({
        v: 1,
        machineId: dummy,
        machineType: 'press',
        label: 'Dummy',
        fw: '1',
        mac: 'AA:BB:CC:DD:EE:FF',
        bootId,
        intervalMs: 500,
        scenarios: ['NORMAL'],
        channels: [
          { key: 'X', label: 'X', unit: 'u', sensorType: 'generic', min: 0, max: 10, decimals: 1, limits: { warnHigh: 5, alarmHigh: 8 } },
        ],
        spectrum: null,
      });
    const tele = (seq, extra = {}) =>
      JSON.stringify({ v: 1, seq, ts: Date.now(), synced: true, m: { X: 1 }, ...extra });

    await raw.publish(`${base}/birth`, birth('aaaa0001'));
    await raw.publish(`${base}/status`, 'online');
    for (const seq of [0, 1, 1, 2, 5]) await raw.publish(`${base}/telemetry`, tele(seq));
    await waitFor(() => publicState(dummy)?.rx.received === 4, { message: 'four accepted' });

    assert.deepEqual(publicState(dummy).rx, { received: 4, lost: 2, duplicates: 1 });

    // A reboot (new boot id) restarts the counter: that is NOT packet loss.
    await raw.publish(`${base}/birth`, birth('bbbb0002'));
    await raw.publish(`${base}/telemetry`, tele(0));
    await waitFor(() => publicState(dummy).rx.received === 5, { message: 'post-reboot sample' });
    assert.equal(publicState(dummy).rx.lost, 2);

    await raw.end();
  });

  it('does not trust a device clock that is unsynced or wildly wrong', async () => {
    const dummy = 'lab-dummy-01';
    const raw = await rawClient(broker.url);
    const topic = `cdo/v1/${SITE}/${dummy}/telemetry`;
    const sensorId = 'LAB-DUMMY-01.X';
    const sent = Date.now();

    // Persistence keeps one sample per channel per tick, so flush after each
    // publish to store every sample this test sends.
    const send = async (seq, value, fields) => {
      await raw.publish(topic, JSON.stringify({ v: 1, seq, m: { X: value }, ...fields }));
      await waitFor(() => latestOf(sensorId)?.value === value, { message: `value ${value}` });
      telemetry.flushPersist();
    };

    await send(100, 2, { ts: 12_345, synced: false });
    assert.ok(Math.abs(latestOf(sensorId).ts - sent) < 3000, 'unsynced: server receive time used');

    await send(101, 3, { ts: sent - 3_600_000, synced: true });
    assert.ok(Math.abs(latestOf(sensorId).ts - sent) < 3000, 'skewed: server receive time used');

    await send(102, 4, { ts: Date.now(), synced: true });
    assert.ok(Math.abs(latestOf(sensorId).ts - Date.now()) < 3000);

    assert.ok(telemetry.getIngestStats().messages.timestampsStamped >= 2);

    // Stamped samples are flagged in storage so analysis can discount them.
    await waitFor(async () => (await models.Reading.countDocuments({ 'meta.sensorId': sensorId, q: 1 })) >= 2, {
      message: 'stamped readings stored with q=1',
    });
    await waitFor(
      async () => (await models.Reading.countDocuments({ 'meta.sensorId': sensorId, q: { $exists: false } })) >= 1,
      { message: 'an unflagged reading stored' },
    );
    await raw.end();
  });

  it('applies limits from birth: a value past a limit is marked warn or alarm', async () => {
    const dummy = 'lab-dummy-01';
    const raw = await rawClient(broker.url);
    const topic = `cdo/v1/${SITE}/${dummy}/telemetry`;
    const sensorId = 'LAB-DUMMY-01.X';

    let seq = 200;
    for (const [value, expected] of [[1, 'normal'], [6, 'warn'], [9, 'alarm']]) {
      await raw.publish(topic, JSON.stringify({ v: 1, seq: seq++, ts: Date.now(), synced: true, m: { X: value } }));
      await waitFor(() => latestOf(sensorId)?.value === value, { message: `value ${value}` });
      assert.equal(latestOf(sensorId).status, expected);
    }
    await raw.end();
  });

  it('flags two boards that claim one machine id', async () => {
    const dummy = 'lab-dummy-01';
    const raw = await rawClient(broker.url);
    const base = structuredClone(fastCatalog().machines[PRESS]);
    await raw.publish(
      `cdo/v1/${SITE}/${dummy}/birth`,
      JSON.stringify({
        v: 1,
        machineId: dummy,
        machineType: 'press',
        label: 'Dummy',
        fw: '1',
        mac: '11:22:33:44:55:66',
        bootId: 'cccc0003',
        intervalMs: 500,
        scenarios: ['NORMAL'],
        channels: base.channels,
        spectrum: null,
      }),
    );
    await waitFor(() => publicState(dummy)?.identityConflict === true, { message: 'identity conflict' });
    await raw.end();
  });

  it('derives "stale" from silence even while the broker still says online', async () => {
    const dummy = 'lab-dummy-01';
    const state = devices.getDeviceState(dummy);
    devices.applyStatus(dummy, 'online');
    state.lastTelemetryAt = Date.now();
    state.statusOnlineAt = Date.now();
    state.lastBirthAt = Date.now();

    assert.equal(devices.deriveState(state, Date.now()), 'online');
    // max(5 s, 4 x 500 ms interval) = 5 s of silence.
    assert.equal(devices.deriveState(state, Date.now() + 4000), 'online');
    assert.equal(devices.deriveState(state, Date.now() + 6000), 'stale');

    devices.applyStatus(dummy, 'offline');
    assert.equal(devices.deriveState(state, Date.now()), 'offline');
  });

  it('marks a device offline when its connection drops without a goodbye (Last Will)', async () => {
    const press = gateways.find((g) => g.machineId === PRESS);
    await press.stop({ graceful: false });
    await waitFor(() => publicState(PRESS)?.state === 'offline', { message: 'Last Will delivered' });

    await press.start();
    await waitFor(() => publicState(PRESS)?.state === 'online', { message: 'recovery after reconnect' });
  });

  it('acknowledges a scenario command and records the change as ground truth', async () => {
    const before = events.acks.length;
    const sent = await devices.sendCommand(PRESS, {
      name: 'scenario',
      args: { scenario: 'CLOGGED_FILTER', rampSec: 5 },
    });
    assert.match(sent.cmdId, /^c-[0-9a-f]{8}$/);

    const ack = await waitFor(() => events.acks.slice(before).find((a) => a.cmdId === sent.cmdId), {
      message: 'device:ack',
    });
    assert.equal(ack.ok, true);
    assert.equal(ack.name, 'scenario');
    assert.equal(ack.external, false);
    assert.ok(ack.rttMs >= 0 && ack.rttMs < 2000);

    await waitFor(async () => (await devices.getSimTruth(PRESS)).scenario === 'CLOGGED_FILTER', {
      message: 'ground truth updated',
    });
    const truth = await devices.getSimTruth(PRESS);
    assert.equal(truth.commanded.scenario, 'CLOGGED_FILTER');
  });

  it('shows the fault in the data: lube pressure falls into alarm as the ramp completes', async () => {
    await waitFor(() => latestOf(LUBE)?.status === 'alarm', { timeoutMs: 15_000, message: 'lube pressure alarm' });
    assert.ok(latestOf(LUBE).value <= 3.0, `lube ${latestOf(LUBE).value} in alarm`);
    await waitFor(() => latestOf('PRESS-STAMP-01.BEARING_VIBRATION_RMS')?.status === 'alarm', {
      timeoutMs: 8000,
      message: 'vibration alarm',
    });
  });

  it('refuses commands that are unsafe, unknown or unsupported', async () => {
    await assert.rejects(
      devices.sendCommand(PRESS, { name: 'scenario', args: { scenario: 'NOT_A_SCENARIO' } }),
      (e) => e.statusCode === 422,
    );
    await assert.rejects(devices.sendCommand('nobody-01', { name: 'ping', args: {} }), (e) => e.statusCode === 404);

    devices.applyStatus('lab-dummy-01', 'offline');
    await assert.rejects(
      devices.sendCommand('lab-dummy-01', { name: 'ping', args: {} }),
      (e) => e.statusCode === 409,
    );
  });

  it('rejects a command from a foreign browser origin', async () => {
    const res = await fetch(`${http.url}/api/v1/devices/${PRESS}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ name: 'ping' }),
    });
    assert.equal(res.status, 403);
  });

  it('accepts a command over REST with 202 and reports the acknowledgement', async () => {
    const before = events.acks.length;
    const res = await fetch(`${http.url}/api/v1/devices/${ROBOT}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      body: JSON.stringify({ name: 'ping' }),
    });
    assert.equal(res.status, 202);
    const { data } = await res.json();
    await waitFor(() => events.acks.slice(before).find((a) => a.cmdId === data.cmdId), { message: 'ping ack' });

    // A ping ack carries the device clock, which yields a clock-offset estimate.
    await waitFor(() => publicState(ROBOT).link, { message: 'link estimate' });
    assert.ok(publicState(ROBOT).link.rttMs < 2000);
  });

  it('rebuilds the whole registry from retained messages alone after a backend restart', async () => {
    // Forget everything the backend knows, including what it persisted.
    await telemetry.stopIngestionAndDisconnect();
    devices.resetDevicesForTests();
    telemetry.resetTelemetryForTests();
    await models.Device.deleteMany({});
    assert.equal(devices.listPublicDevices().length, 0);

    const { waitForConnection } = await import('../src/services/mqtt.service.js');
    await telemetry.startIngestion({ url: broker.url, persist: true, clientId: 'test-backend-2' });
    await waitForConnection();

    await waitFor(() => publicState(ROBOT)?.announced && publicState(PRESS)?.announced, {
      message: 'registry restored from the broker',
    });
    assert.equal(publicState(PRESS).channels.length, 3);
    assert.equal(publicState(PRESS).spectrum.count, 64);
    await waitFor(() => publicState(PRESS).state === 'online', { message: 'online again' });
  });

  it('reports ingestion health without leaking credentials', async () => {
    const body = await (await fetch(`${http.url}/api/v1/health`)).json();
    assert.equal(body.data.database, 'connected');
    assert.ok(!JSON.stringify(body).match(/password|secret|username/i));
    assert.equal(telemetry.getIngestStats().mqtt.state, 'connected');
    assert.match(telemetry.getIngestStats().mqtt.broker, /^127\.0\.0\.1:\d+$/);
  });

  it('serves the metadata the binding form needs', async () => {
    const { data } = await (await fetch(`${http.url}/api/v1/meta`)).json();
    assert.ok(data.sensorTypes.includes('torque'));
    assert.ok(data.sensorTypes.includes('displacement'));
    assert.equal(data.features.deviceCommands, true);
    assert.equal(data.siteId, SITE);
  });

  it('keeps ingestion running after a burst of nonsense', async () => {
    const raw = await rawClient(broker.url);
    await silence(async () => {
      for (let i = 0; i < 200; i += 1) {
        await raw.publish(`cdo/v1/${SITE}/${PRESS}/telemetry`, Buffer.from([0xff, 0xfe, i & 0xff]));
      }
    });
    await raw.end();
    const seen = latestOf(LUBE)?.rx ?? 0;
    await waitFor(() => (latestOf(LUBE)?.rx ?? 0) > seen, { message: 'stream survives' });
  });
});
