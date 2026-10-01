/**
 * Adding a machine to a twin: a gateway announces itself and is only AVAILABLE;
 * a person adds it to an asset, and only then are its channels bound there.
 * Removing it retires the bindings of its channels.
 *
 * Real infrastructure: an in-process MQTT broker, a disposable database, the real
 * services and HTTP app, and a simulated gateway speaking the wire contract.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { io } from 'socket.io-client';

import { SimulatedGateway } from '../scripts/lib/gateway.mjs';
import {
  connectTestDatabase,
  dropTestDatabase,
  fastCatalog,
  startBroker,
  startHttp,
  waitFor,
} from './helpers.js';

const PRESS = 'press-stamp-01';
const ROBOT = 'robot-weld-01';
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';
const VIB = 'PRESS-STAMP-01.BEARING_VIBRATION_RMS';
const TORQUE = 'ROBOT-WELD-01.AXIS_4_SERVO_TORQUE';

/** @type {any} */ let broker;
/** @type {any} */ let http;
/** @type {any} */ let socket;
/** @type {SimulatedGateway[]} */ const gateways = [];
/** @type {any} */ let devices;
/** @type {any} */ let bindings;
/** @type {any} */ let Asset;
/** @type {any} */ let Binding;
/** @type {any} */ let MeshNode;
/** @type {any} */ let assetA;
/** @type {any} */ let assetB;

const updates = [];
const invalidations = [];

const api = async (method, path, body) => {
  const res = await fetch(`${http.url}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

const publicDevice = (machineId) => devices.listPublicDevices().find((d) => d.machineId === machineId);

describe('adding machines to a twin', () => {
  before(async () => {
    const telemetry = await import('../src/services/telemetry.service.js');
    devices = await import('../src/services/device.service.js');
    bindings = await import('../src/services/sensorBinding.service.js');
    ({ Asset } = await import('../src/models/Asset.model.js'));
    ({ SensorBinding: Binding } = await import('../src/models/SensorBinding.model.js'));
    ({ MeshNode } = await import('../src/models/MeshNode.model.js'));
    const store = await import('../src/services/telemetryStore.service.js');
    const { startBindingIndex } = await import('../src/services/bindingIndex.service.js');
    const { waitForConnection } = await import('../src/services/mqtt.service.js');

    broker = await startBroker();
    await connectTestDatabase();
    await store.ensureTelemetryStore();
    http = await startHttp();
    await startBindingIndex({ periodicMs: 0 });
    await telemetry.startIngestion({ url: broker.url, persist: false, clientId: 'test-backend' });
    await waitForConnection();

    assetA = await Asset.create({ name: 'Twin A', uploader: 'test', status: 'converted' });
    assetB = await Asset.create({ name: 'Twin B', uploader: 'test', status: 'converted' });

    socket = io(http.url, { transports: ['websocket'], forceNew: true });
    socket.on('device:update', (d) => updates.push(d));
    socket.on('twin:invalidate', (p) => invalidations.push(p.assetId));
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.emit('subscribe:asset', String(assetA._id));

    for (const machineId of [PRESS, ROBOT]) {
      const gateway = new SimulatedGateway({ machineId, url: broker.url, siteId: 'vit-lab', catalog: fastCatalog(), seed: 5 });
      gateways.push(gateway);
      await gateway.start();
    }
    await waitFor(() => publicDevice(PRESS)?.announced && publicDevice(ROBOT)?.announced, { message: 'both announced' });
  });

  after(async () => {
    socket?.close();
    await Promise.all(gateways.map((g) => g.stop({ graceful: true }).catch(() => {})));
    const telemetry = await import('../src/services/telemetry.service.js');
    await telemetry.stopIngestionAndDisconnect().catch(() => {});
    await http?.stop();
    await broker?.stop();
    await dropTestDatabase();
  });

  it('lists a freshly announced machine as available, on no twin', async () => {
    assert.equal(publicDevice(PRESS).assetId, null);
    const res = await api('GET', `/assets/${assetA._id}/machines`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, []);
  });

  it('refuses a machine that has not announced itself, and an unknown twin', async () => {
    const ghost = await api('POST', `/assets/${assetA._id}/machines`, { machineId: 'ghost-01' });
    assert.equal(ghost.status, 404);
    assert.match(ghost.body.message, /has not announced itself/);

    const noTwin = await api('POST', `/assets/64b000000000000000000000/machines`, { machineId: PRESS });
    assert.equal(noTwin.status, 404);

    assert.equal((await api('POST', `/assets/${assetA._id}/machines`, { machineId: 'Bad Id' })).status, 422);
    assert.equal((await api('POST', `/assets/${assetA._id}/machines`, { machineId: PRESS, extra: 1 })).status, 422);
  });

  it('adds a machine to a twin, announces it to browsers, and is idempotent', async () => {
    const before = updates.length;
    const added = await api('POST', `/assets/${assetA._id}/machines`, { machineId: PRESS });
    assert.equal(added.status, 201);
    assert.equal(added.body.data.assetId, String(assetA._id));

    await waitFor(() => updates.slice(before).some((d) => d.machineId === PRESS && d.assetId === String(assetA._id)), {
      message: 'device:update carrying the asset',
    });

    const listed = await api('GET', `/assets/${assetA._id}/machines`);
    assert.deepEqual(listed.body.data.map((d) => d.machineId), [PRESS]);

    const again = await api('POST', `/assets/${assetA._id}/machines`, { machineId: PRESS });
    assert.equal(again.status, 200);
    assert.match(again.body.message, /already/);
  });

  it('keeps the other machine available while the first is added', async () => {
    assert.equal(publicDevice(ROBOT).assetId, null);
    assert.deepEqual((await api('GET', `/assets/${assetB._id}/machines`)).body.data, []);
  });

  it('refuses to add a machine that belongs to another twin', async () => {
    const res = await api('POST', `/assets/${assetB._id}/machines`, { machineId: PRESS });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /another twin/);
  });

  it('remembers the twin across a backend restart', async () => {
    const { Device } = await import('../src/models/Device.model.js');
    const stored = await Device.findOne({ machineId: PRESS }).lean();
    assert.equal(String(stored.assetId), String(assetA._id));

    const before = devices.getDeviceState(PRESS);
    devices.resetDevicesForTests();
    assert.equal(devices.getDeviceState(PRESS), undefined);
    await devices.initDeviceRegistry({ siteId: 'vit-lab' });
    assert.equal(devices.getDeviceState(PRESS).assetId, String(assetA._id));
    assert.ok(before);
    // The live gateways keep publishing and re-announce on the next birth.
  });

  it('removes a machine, retires only its bindings, and frees it again', async () => {
    // Re-announce so the registry holds live state again after the reset above.
    await waitFor(() => publicDevice(PRESS)?.announced, { message: 'press registry restored' });

    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'mesh/lube/0', sensorId: LUBE, sensorType: 'pressure' });
    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'mesh/vib/0', sensorId: VIB, sensorType: 'vibration' });
    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'mesh/robot/0', sensorId: TORQUE, sensorType: 'torque' });

    const before = invalidations.length;
    const res = await api('DELETE', `/assets/${assetA._id}/machines/${PRESS}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.bindingsRetired, 2);

    const live = await Binding.find({ assetId: assetA._id, isActive: true }).lean();
    assert.deepEqual(live.map((b) => b.sensorId), [TORQUE], "the robot's binding is untouched");

    const history = await Binding.find({ sensorId: { $in: [LUBE, VIB] } }).lean();
    assert.ok(history.every((b) => b.isActive === false && b.unboundAt), 'retired as history, not deleted');

    const pressNodes = await MeshNode.find({ assetId: assetA._id, meshName: { $in: ['mesh/lube/0', 'mesh/vib/0'] } }).lean();
    assert.ok(pressNodes.every((n) => n.isMapped === false), 'the mirror flag follows the bindings');

    await waitFor(() => invalidations.length > before, { message: 'twin:invalidate after removal' });
    assert.equal(publicDevice(PRESS).assetId, null);
    assert.deepEqual((await api('GET', `/assets/${assetA._id}/machines`)).body.data, []);
  });

  it('can add the freed machine to a different twin', async () => {
    const res = await api('POST', `/assets/${assetB._id}/machines`, { machineId: PRESS });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.assetId, String(assetB._id));
  });

  it('frees its machines when a twin is deleted', async () => {
    const res = await api('DELETE', `/assets/${assetB._id}`);
    assert.equal(res.status, 200);
    assert.equal(publicDevice(PRESS).assetId, null);

    const { Device } = await import('../src/models/Device.model.js');
    assert.equal((await Device.findOne({ machineId: PRESS }).lean()).assetId, null);
  });

  it('refuses to remove a machine that is not on this twin', async () => {
    const wrongTwin = await api('DELETE', `/assets/${assetA._id}/machines/${PRESS}`);
    assert.equal(wrongTwin.status, 404);
    const never = await api('DELETE', `/assets/${assetA._id}/machines/${ROBOT}`);
    assert.equal(never.status, 404);
  });
});
