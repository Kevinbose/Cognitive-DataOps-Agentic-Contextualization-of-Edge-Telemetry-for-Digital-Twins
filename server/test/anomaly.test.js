/**
 * The anomaly detector: the threshold rule, the drift rule, one investigation
 * per machine, escalation, resolution with cooldown, and the hand-off to the
 * agent (accepted, or marked unavailable when nothing answers).
 *
 * Samples carry synthetic timestamps, so fifteen simulated minutes run in a
 * few milliseconds and every result is deterministic (seeded noise).
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import { buildBirth, loadCatalog } from '../scripts/lib/gateway.mjs';
import { connectTestDatabase, dropTestDatabase, waitFor } from './helpers.js';

const catalog = loadCatalog();
const PRESS = 'press-stamp-01';
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';
const VIB = 'PRESS-STAMP-01.BEARING_VIBRATION_RMS';
const CURRENT = 'PRESS-STAMP-01.MAIN_MOTOR_CURRENT';

/** Deterministic noise in [-1, 1]. */
function noise(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

let anomaly;
let Investigation;
let agentRequests = [];
let fakeAgent;
let fakeAgentUrl;
let t0;

/** Feed the three press channels for `seconds` at 2 Hz. */
function feed(seconds, { lube = () => 4.5, vib = () => 1.3, current = () => 95 } = {}, rnd = noise(7)) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const ts = t0;
    t0 += 500;
    const s = i / 2;
    anomaly.observe({ sensorId: LUBE, machineId: PRESS, key: 'LUBE_OIL_PRESSURE', value: lube(s) + 0.05 * rnd(), ts, unit: 'bar' });
    anomaly.observe({ sensorId: VIB, machineId: PRESS, key: 'BEARING_VIBRATION_RMS', value: vib(s) + 0.12 * rnd(), ts, unit: 'mm/s' });
    anomaly.observe({ sensorId: CURRENT, machineId: PRESS, key: 'MAIN_MOTOR_CURRENT', value: current(s) + 2 * rnd(), ts, unit: 'A' });
  }
}

describe('anomaly detector', () => {
  before(async () => {
    await connectTestDatabase();
    ({ Investigation } = await import('../src/models/Investigation.model.js'));
    await Investigation.init();
    const devices = await import('../src/services/device.service.js');
    devices.applyBirth(PRESS, buildBirth(PRESS, catalog.machines[PRESS], { fw: '1.0.0', mac: '02:CD:00:00:00:01', bootId: 'b1' }));
    anomaly = await import('../src/services/anomaly.service.js');
    anomaly.setAnomalyEnabledForTests(true);

    fakeAgent = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        agentRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":true}');
      });
    });
    await new Promise((resolve) => fakeAgent.listen(0, '127.0.0.1', resolve));
    fakeAgentUrl = `http://127.0.0.1:${fakeAgent.address().port}`;
    const client = await import('../src/services/agentClient.service.js');
    client.setAgentUrlForTests(fakeAgentUrl);
  });

  beforeEach(async () => {
    anomaly.resetAnomalyForTests();
    const client = await import('../src/services/agentClient.service.js');
    client.resetAgentClientForTests();
    client.setAgentUrlForTests(fakeAgentUrl);
    await Investigation.deleteMany({});
    agentRequests = [];
    t0 = Date.UTC(2026, 9, 9, 8, 0, 0);
  });

  after(async () => {
    anomaly.setAnomalyEnabledForTests(false);
    await new Promise((resolve) => fakeAgent.close(resolve));
    await dropTestDatabase();
  });

  it('learns a baseline and stays quiet on healthy noise', async () => {
    feed(300);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await Investigation.countDocuments(), 0);
    const f = anomaly.getChannelFeatures(LUBE);
    assert.ok(f.baseline, 'baseline learned');
    assert.ok(Math.abs(f.baseline.mean - 4.5) < 0.02, `baseline mean ${f.baseline.mean}`);
    assert.ok(Math.abs(f.z60) < 3, `z ${f.z60}`);
  });

  it('opens one threshold investigation when pressure holds below the warn limit, and hands it to the agent', async () => {
    feed(120);
    feed(30, { lube: () => 3.4 });
    const inv = await waitFor(() => Investigation.findOne({ machineId: PRESS }).lean(), { message: 'investigation' });
    assert.equal(inv.kind, 'threshold');
    assert.equal(inv.severity, 'warn');
    assert.equal(inv.sensorId, LUBE);
    assert.equal(inv.trigger.limitName, 'warnLow');
    assert.equal(inv.trigger.limit, 3.6);
    await waitFor(() => agentRequests.length === 1, { message: 'agent hand-off' });
    assert.equal(agentRequests[0].url, '/v1/investigations');
    assert.match(agentRequests[0].auth, /^Bearer test-service-key/);
    assert.equal(agentRequests[0].body.investigationId, String(inv._id));
    assert.equal(agentRequests[0].body.channelKey, 'LUBE_OIL_PRESSURE');
    assert.equal(JSON.stringify(agentRequests[0].body).includes('"sim"'), false);
  });

  it('keeps one investigation per machine and escalates warn to alarm while the report is pending', async () => {
    feed(120);
    feed(30, { lube: () => 3.4 });
    await waitFor(() => Investigation.findOne({ machineId: PRESS }).lean(), { message: 'investigation' });
    feed(30, { lube: () => 2.8, vib: () => 4.6 });
    await waitFor(async () => (await Investigation.findOne({ machineId: PRESS }).lean())?.severity === 'alarm', { message: 'escalation' });
    assert.equal(await Investigation.countDocuments(), 1);
    assert.equal(agentRequests.length, 1, 'the agent is asked once');
  });

  it('opens a drift investigation for vibration creeping up inside its limits (the case alarms miss)', async () => {
    feed(180);
    // bearing wear: vibration walks from 1.3 towards 2.3 mm/s, never reaching the 2.5 warn
    feed(120, { vib: (s) => 1.3 + Math.min(1, s / 60) * 1.0 });
    const inv = await waitFor(() => Investigation.findOne({ machineId: PRESS }).lean(), { message: 'drift investigation' });
    assert.equal(inv.kind, 'drift');
    assert.equal(inv.sensorId, VIB);
    assert.equal(inv.severity, 'warn');
    assert.ok(inv.trigger.mean60 < 2.5, 'still inside the limits when it fired');
    assert.ok(inv.trigger.baseline > 1.2 && inv.trigger.baseline < 1.4);
  });

  it('resolves after a healthy minute, then waits out the cooldown', async () => {
    feed(120);
    feed(30, { lube: () => 3.4 });
    const inv = await waitFor(() => Investigation.findOne({ machineId: PRESS }).lean(), { message: 'investigation' });
    // the 60 s mean recovers first, then the machine must stay healthy for a minute
    feed(150);
    await waitFor(async () => (await Investigation.findById(inv._id).lean()).active === false, { message: 'resolution' });
    const done = await Investigation.findById(inv._id).lean();
    assert.equal(done.status, 'resolved');
    assert.ok(done.resolvedAt);
    feed(30, { lube: () => 3.4 });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await Investigation.countDocuments(), 1, 'cooldown holds a second investigation back');
  });

  it('marks the investigation agent_unavailable when nothing answers, without losing it', async () => {
    const client = await import('../src/services/agentClient.service.js');
    client.setAgentUrlForTests('http://127.0.0.1:9');
    feed(120);
    feed(30, { lube: () => 3.4 });
    const inv = await waitFor(async () => {
      const doc = await Investigation.findOne({ machineId: PRESS }).lean();
      return doc?.status === 'agent_unavailable' ? doc : null;
    }, { timeoutMs: 8000, message: 'agent_unavailable' });
    assert.match(inv.error, /unreachable/);
    assert.equal(inv.active, true);
  });
});
