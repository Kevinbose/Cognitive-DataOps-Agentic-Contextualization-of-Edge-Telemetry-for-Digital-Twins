/**
 * Bindings and the live caches that depend on them: the domain events emitted
 * after every change, the in-memory binding index that routes each sample, and
 * the websocket invalidation that keeps other tabs honest.
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
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';
const VIB = 'PRESS-STAMP-01.BEARING_VIBRATION_RMS';

/** @type {any} */ let broker;
/** @type {any} */ let http;
/** @type {SimulatedGateway} */ let gateway;
/** @type {any[]} */ const sockets = [];

/** @type {any} */ let telemetry;
/** @type {any} */ let bindings;
/** @type {any} */ let index;
/** @type {any} */ let assets;
/** @type {any} */ let events;
/** @type {any} */ let Binding;

/** Domain events seen, in order. */
const domain = [];
/** `twin:invalidate` payloads received per asset room. */
const invalidations = { a: [], b: [] };
/** Last telemetry batch sample per sensor, as a browser would see it. */
const browser = new Map();

const latestOf = (sensorId) => telemetry.getLatestSamples().find((s) => s.sensorId === sensorId);
const indexed = (sensorId) => index.resolveSensor(sensorId);
const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

function connectSocket(assetId, bucket) {
  const socket = io(http.url, { transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  socket.on('twin:invalidate', (payload) => bucket.push(payload.assetId));
  socket.on('telemetry:batch', (batch) => batch.forEach((s) => browser.set(s.sensorId, s)));
  return new Promise((resolve) =>
    socket.on('connect', () => {
      socket.emit('subscribe:asset', assetId);
      // The join is processed server-side after the emit; give it a beat.
      setTimeout(resolve, 80);
    }),
  );
}

describe('bindings', () => {
  /** @type {any} */ let assetA;
  /** @type {any} */ let assetB;

  before(async () => {
    telemetry = await import('../src/services/telemetry.service.js');
    bindings = await import('../src/services/sensorBinding.service.js');
    index = await import('../src/services/bindingIndex.service.js');
    assets = await import('../src/services/asset.service.js');
    events = await import('../src/utils/domainEvents.js');
    const meshNodes = await import('../src/services/meshNode.service.js');
    Binding = (await import('../src/models/SensorBinding.model.js')).SensorBinding;
    const { waitForConnection } = await import('../src/services/mqtt.service.js');

    broker = await startBroker();
    await connectTestDatabase();
    const store = await import('../src/services/telemetryStore.service.js');
    await store.ensureTelemetryStore();
    http = await startHttp();
    await index.startBindingIndex({ periodicMs: 0 });

    events.onDomainEvent(events.DOMAIN_EVENT.BINDING_CHANGED, (payload) => domain.push(payload));

    await telemetry.startIngestion({ url: broker.url, persist: false, clientId: 'test-backend-bindings' });
    await waitForConnection();

    gateway = new SimulatedGateway({ machineId: PRESS, url: broker.url, siteId: 'vit-lab', catalog: fastCatalog() });
    await gateway.start();

    assetA = await assets.createAsset({ name: 'Press line A', uploader: 'test' });
    assetB = await assets.createAsset({ name: 'Press line B', uploader: 'test' });
    void meshNodes; // imported so the service graph is loaded before first use

    await connectSocket(String(assetA._id), invalidations.a);
    await connectSocket(String(assetB._id), invalidations.b);
    await waitFor(() => latestOf(LUBE), { message: 'first sample' });
  });

  after(async () => {
    for (const socket of sockets) socket.close();
    await gateway?.stop().catch(() => {});
    await telemetry.stopIngestionAndDisconnect().catch(() => {});
    await http?.stop();
    await broker?.stop();
    await dropTestDatabase();
  });

  it('routes a sample to its mesh once the sensor is bound, with no restart', async () => {
    assert.equal(indexed(LUBE), undefined);
    assert.equal(latestOf(LUBE).meshName, undefined);

    const result = await bindings.bindSensorToMeshName({
      assetId: String(assetA._id),
      meshName: 'Mesh_Lube_Unit',
      sensorId: LUBE,
      sensorType: 'pressure',
      displayName: 'Lubrication unit',
    });
    assert.equal(result.unchanged, false);
    assert.ok(!('affectedAssetIds' in result), 'internal bookkeeping must not leak into the API result');

    await waitFor(() => indexed(LUBE), { message: 'index reloaded by the event' });
    assert.equal(indexed(LUBE).meshName, 'Mesh_Lube_Unit');
    assert.equal(indexed(LUBE).displayName, 'Lubrication unit');
    assert.equal(indexed(LUBE).assetId, String(assetA._id));

    // The browser receives the routing on the very next sample.
    await waitFor(() => browser.get(LUBE)?.meshName === 'Mesh_Lube_Unit', { message: 'sample carries meshName' });
    assert.equal(browser.get(LUBE).assetId, String(assetA._id));
  });

  it('tells the tabs viewing that asset to refetch, and nobody else', async () => {
    await waitFor(() => invalidations.a.length >= 1, { message: 'twin:invalidate for asset A' });
    assert.ok(invalidations.a.every((id) => id === String(assetA._id)));
    assert.equal(invalidations.b.length, 0, 'a tab on asset B is not disturbed by a change to asset A');
  });

  it('emits exactly one domain event per change, and none for a repeat of the same binding', async () => {
    await tick();
    const before = domain.length;

    const repeat = await bindings.bindSensorToMeshName({
      assetId: String(assetA._id),
      meshName: 'Mesh_Lube_Unit',
      sensorId: LUBE,
      sensorType: 'pressure',
    });
    assert.equal(repeat.unchanged, true);
    await tick();
    assert.equal(domain.length, before, 'an unchanged bind must not reload caches or refresh viewers');
  });

  it('refuses to steal a sensor without reassign, and emits nothing for the refusal', async () => {
    await tick();
    const before = domain.length;

    await assert.rejects(
      bindings.bindSensorToMeshName({ assetId: String(assetB._id), meshName: 'Other_Mesh', sensorId: LUBE }),
      (error) => error.statusCode === 409 && /already bound/i.test(error.message),
    );
    await tick();
    assert.equal(domain.length, before, 'a 409 wrote nothing, so there is nothing to refresh');
    assert.equal(indexed(LUBE).assetId, String(assetA._id), 'the original binding is intact');
  });

  it('on reassign, notifies BOTH assets, because the sensor rule is global', async () => {
    const aBefore = invalidations.a.length;
    const bBefore = invalidations.b.length;
    const domainBefore = domain.length;

    const result = await bindings.bindSensorToMeshName({
      assetId: String(assetB._id),
      meshName: 'Other_Mesh',
      sensorId: LUBE,
      reassign: true,
    });
    assert.equal(result.unchanged, false);

    await waitFor(() => domain.length > domainBefore, { message: 'domain event' });
    const event = domain.at(-1);
    assert.deepEqual([...event.assetIds].sort(), [String(assetA._id), String(assetB._id)].sort());
    assert.equal(event.reason, 'bind');

    // Both tabs are told, including the one that LOST the sensor.
    await waitFor(() => invalidations.a.length > aBefore && invalidations.b.length > bBefore, {
      message: 'both asset rooms invalidated',
    });

    await waitFor(() => indexed(LUBE)?.assetId === String(assetB._id), { message: 'index follows the move' });
    assert.equal(indexed(LUBE).meshName, 'Other_Mesh');

    // The old binding is retired as history, not deleted.
    const history = await Binding.find({ sensorId: LUBE }).sort({ boundAt: 1 }).lean();
    assert.equal(history.length, 2);
    assert.equal(history[0].isActive, false);
    assert.ok(history[0].unboundAt);
    assert.equal(history[1].isActive, true);
  });

  it('keeps one mesh to one sensor: rebinding a mesh retires its previous sensor', async () => {
    await bindings.bindSensorToMeshName({ assetId: String(assetB._id), meshName: 'Other_Mesh', sensorId: VIB });
    await waitFor(() => indexed(VIB), { message: 'vibration bound' });
    await waitFor(() => !indexed(LUBE), { message: 'the displaced sensor is dropped from the index' });
    assert.equal(indexed(VIB).meshName, 'Other_Mesh');
  });

  it('stops routing samples as soon as a sensor is unbound', async () => {
    const active = await Binding.findOne({ sensorId: VIB, isActive: true });
    await bindings.unbindById(String(active._id));

    await waitFor(() => !indexed(VIB), { message: 'index drops the sensor' });
    await waitFor(() => browser.get(VIB) && !browser.get(VIB).meshName, { message: 'sample no longer carries a mesh' });
    assert.equal(domain.at(-1).reason, 'unbind');
  });

  it('drops every binding of a deleted asset from the live index', async () => {
    await bindings.bindSensorToMeshName({ assetId: String(assetB._id), meshName: 'Another_Mesh', sensorId: VIB });
    await waitFor(() => indexed(VIB), { message: 'bound again' });

    await assets.softDeleteAsset(String(assetB._id));
    await waitFor(() => !indexed(VIB), { message: 'index cleared by asset deletion' });
    assert.equal(domain.at(-1).reason, 'asset-deleted');
  });

  it('keeps a bind successful even when a listener of the change event throws', async () => {
    const off = events.onDomainEvent(events.DOMAIN_EVENT.BINDING_CHANGED, () => {
      throw new Error('a buggy subscriber');
    });
    const { error } = console;
    console.error = () => {};
    try {
      const result = await bindings.bindSensorToMeshName({
        assetId: String(assetA._id),
        meshName: 'Resilient_Mesh',
        sensorId: LUBE,
      });
      assert.equal(result.unchanged, false);
      await waitFor(() => indexed(LUBE)?.meshName === 'Resilient_Mesh', { message: 'healthy listeners still ran' });
    } finally {
      console.error = error;
      off();
    }
  });

  it('never loses an update when changes arrive while a reload is running', async () => {
    // Fire several changes back to back: the reload is single-flight, and the
    // dirty flag must guarantee a final load that sees the last change.
    // LUBE is still held by the previous test's mesh, so the first move needs reassign.
    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'Burst_1', sensorId: LUBE, reassign: true });
    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'Burst_2', sensorId: VIB });
    await bindings.bindSensorToMeshName({ assetId: String(assetA._id), meshName: 'Burst_3', sensorId: LUBE, reassign: true });

    await waitFor(() => indexed(LUBE)?.meshName === 'Burst_3' && indexed(VIB)?.meshName === 'Burst_2', {
      message: 'index reflects the final state',
    });
    assert.ok(index.getBindingIndexStats().loads >= 2);
    assert.equal(index.getBindingIndexStats().lastError, null);
  });
});
