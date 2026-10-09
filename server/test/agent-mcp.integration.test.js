/**
 * The agent's side door: the MCP endpoint, the report and alert path, and the
 * assistant chat proxy.
 *
 * Real infrastructure: an in-process MQTT broker, simulated gateways, a
 * disposable database, the HTTP app, a small `.glb` with labelled nodes, and
 * the official MCP client over Streamable HTTP with the service key.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { io } from 'socket.io-client';

import { SimulatedGateway } from '../scripts/lib/gateway.mjs';
import {
  connectTestDatabase,
  dropTestDatabase,
  fastCatalog,
  hasKey,
  startBroker,
  startHttp,
  waitFor,
} from './helpers.js';

const KEY = process.env.AGENT_SERVICE_KEY;
const PRESS = 'press-stamp-01';
const ROBOT = 'robot-weld-01';
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';
const SESSION = 'session_test_0001';

/** A minimal binary glTF: a JSON chunk only, enough for the name index. */
function writeGlb(file) {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3, 4] }],
    meshes: [{ name: 'M0', primitives: [{ attributes: {} }] }, { name: 'OLDMESH', primitives: [{ attributes: {} }, { attributes: {} }] }],
    nodes: [
      { name: 'PRESS_LUBE_UNIT', mesh: 0, extras: { cdo_label: 'Central lubrication unit (oil reservoir)', cdo_machine: PRESS, cdo_tags: 'lube_unit,lube_reservoir' } },
      { name: 'PRESS_MAIN_MOTOR', mesh: 0, extras: { cdo_label: 'Main drive motor, 250 kW', cdo_machine: PRESS, cdo_tags: 'main_motor', cdo_suggested_channel: 'PRESS-STAMP-01.MAIN_MOTOR_CURRENT' } },
      { name: 'ROBOT_WELD_GUN', mesh: 0, extras: { cdo_label: 'Servo spot-welding gun', cdo_machine: ROBOT } },
      { name: 'Old part.001', mesh: 1 },
      { name: 'VIEW_HOME' },
    ],
  };
  let body = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (body.length % 4)) % 4;
  body = Buffer.concat([body, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.write('JSON', 16, 'ascii');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

let broker;
let web;
let socket;
let mcp;
let assetId;
let fakeAgent;
let fakeAgentLog = [];
const gateways = [];
const uiCommands = [];
const alerts = [];

async function call(name, args) {
  const result = await mcp.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  return { isError: Boolean(result.isError), text, data: result.isError ? null : JSON.parse(text) };
}

describe('agent integration: MCP endpoint, reports and chat proxy', () => {
  before(async () => {
    const telemetry = await import('../src/services/telemetry.service.js');
    const store = await import('../src/services/telemetryStore.service.js');
    const { startBindingIndex } = await import('../src/services/bindingIndex.service.js');
    const { waitForConnection } = await import('../src/services/mqtt.service.js');
    const devices = await import('../src/services/device.service.js');
    const bindings = await import('../src/services/sensorBinding.service.js');
    const { Asset } = await import('../src/models/Asset.model.js');
    const { config } = await import('../src/config/env.config.js');

    broker = await startBroker();
    await connectTestDatabase();
    await store.ensureTelemetryStore();
    web = await startHttp();
    await startBindingIndex({ periodicMs: 0 });
    await telemetry.startIngestion({ url: broker.url, persist: true, clientId: 'test-backend-agent' });
    await waitForConnection();

    for (const machineId of [PRESS, ROBOT]) {
      const g = new SimulatedGateway({ machineId, url: broker.url, siteId: 'vit-lab', catalog: fastCatalog(), seed: 3 });
      gateways.push(g);
      await g.start();
    }
    await waitFor(() => devices.listPublicDevices().filter((d) => d.announced).length === 2, { message: 'both gateways' });

    const asset = await Asset.create({ name: 'Plant twin under test', uploader: 'test', status: 'converted' });
    assetId = String(asset._id);
    const storageKey = `assets/${assetId}/converted.glb`;
    writeGlb(path.join(config.storageRoot, storageKey));
    await Asset.updateOne({ _id: asset._id }, {
      $set: { convertedFile: { filename: 'converted.glb', originalName: 'tiny.glb', mimeType: 'model/gltf-binary', sizeBytes: 1, storageKey, checksum: 'abc', uploadedAt: new Date() } },
    });
    await devices.attachMachine(assetId, PRESS);
    await bindings.bindSensorToMeshName({ assetId, meshName: 'PRESS_LUBE_UNIT', sensorId: LUBE, sensorType: 'pressure' });

    socket = io(web.url, { transports: ['websocket'], forceNew: true });
    socket.on('ui:command', (p) => uiCommands.push(p));
    socket.on('agent:alert', (p) => alerts.push(p));
    await new Promise((resolve) => socket.on('connect', resolve));
    socket.emit('subscribe:session', SESSION);

    mcp = new Client({ name: 'test-agent', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${web.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${KEY}` } },
    }));

    fakeAgent = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        fakeAgentLog.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        if (req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok","llm":"stub"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: token\ndata: {"text":"Lube oil "}\n\n');
        res.write('event: token\ndata: {"text":"pressure is 4.5 bar."}\n\n');
        res.end('event: done\ndata: {}\n\n');
      });
    });
    await new Promise((resolve) => fakeAgent.listen(0, '127.0.0.1', resolve));
    const client = await import('../src/services/agentClient.service.js');
    client.setAgentUrlForTests(`http://127.0.0.1:${fakeAgent.address().port}`);
  });

  after(async () => {
    socket?.close();
    await mcp?.close().catch(() => {});
    await Promise.all(gateways.map((g) => g.stop({ graceful: true }).catch(() => {})));
    const telemetry = await import('../src/services/telemetry.service.js');
    await telemetry.stopIngestionAndDisconnect().catch(() => {});
    await new Promise((resolve) => fakeAgent.close(resolve));
    await web?.stop();
    await broker?.stop();
    await dropTestDatabase();
  });

  it('refuses the MCP endpoint without the service key', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    assert.equal((await fetch(`${web.url}/mcp`, { method: 'POST', headers, body })).status, 401);
    assert.equal((await fetch(`${web.url}/mcp`, { method: 'POST', headers: { ...headers, authorization: 'Bearer nope' }, body })).status, 401);
    assert.equal((await fetch(`${web.url}/mcp`, { headers: { authorization: `Bearer ${KEY}` } })).status, 405);
  });

  it('lists exactly the read and point tools, and nothing that can act on a machine', async () => {
    const { tools } = await mcp.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'emit_ui_command', 'find_meshes', 'get_active_anomalies', 'get_channel_features', 'get_device_catalog',
      'get_diagnostic_report', 'get_historical_telemetry', 'get_latest_telemetry', 'get_mesh_bindings',
      'get_mesh_context', 'get_raw_window', 'get_spectrum', 'list_reports', 'list_twins', 'post_diagnostic_report',
      'report_investigation_failure',
    ]);
    for (const n of names) assert.doesNotMatch(n, /command(?!$)|scenario|reboot|sim|bind_|unbind|delete|truth/i, n);
    for (const t of tools) assert.ok(t.description.length > 30, `${t.name} has a usable description`);
  });

  it('reads the catalogue, live values and twins with no simulator ground truth anywhere', async () => {
    await waitFor(async () => (await call('get_latest_telemetry', { machineId: PRESS })).data.length === 3, { message: 'press samples' });
    for (const [name, args] of [['get_device_catalog', {}], ['get_latest_telemetry', {}], ['list_twins', {}], ['get_spectrum', { machineId: PRESS }]]) {
      const r = await call(name, args);
      assert.equal(r.isError, false, `${name}: ${r.text}`);
      assert.equal(hasKey(r.data, (k) => k === 'sim' || k === 'simTruth'), false, `${name} leaks sim`);
    }
    const catalog = (await call('get_device_catalog', { machineId: PRESS })).data[0];
    const lube = catalog.channels.find((c) => c.key === 'LUBE_OIL_PRESSURE');
    assert.deepEqual(lube.limits, { warnLow: 3.6, alarmLow: 3 });
    assert.equal(catalog.spectrum.fundamentalHz, 24.7);
    const twins = (await call('list_twins', {})).data;
    assert.equal(twins.find((t) => t.assetId === assetId).machines[0].machineId, PRESS);
    const raw = await call('get_raw_window', { sensorId: 'PRESS-STAMP-01.LUBE_OIL_PRESSURE', seconds: 30 });
    assert.equal(raw.isError, false, raw.text);
    assert.ok(Array.isArray(raw.data.samples));
    for (const [dt, v] of raw.data.samples) assert.ok(dt >= 0 && Number.isFinite(v));
  });

  it('finds the lubrication unit by words and explains what it is and how it runs', async () => {
    const found = (await call('find_meshes', { assetId, query: 'the lubrication unit' })).data;
    assert.equal(found[0].meshName, 'PRESS_LUBE_UNIT');
    assert.equal(found[0].sensorId, LUBE);
    const ctx = (await call('get_mesh_context', { assetId, meshName: 'PRESS_LUBE_UNIT' })).data;
    assert.equal(ctx.exists, true);
    assert.equal(ctx.bound, true);
    assert.equal(ctx.binding.sensorId, LUBE);
    assert.equal(ctx.label, 'Central lubrication unit (oil reservoir)');
    assert.ok(Number.isFinite(ctx.latest.value));
    assert.deepEqual(ctx.limits, { warnLow: 3.6, alarmLow: 3 });
    const motor = (await call('get_mesh_context', { assetId, meshName: 'PRESS_MAIN_MOTOR' })).data;
    assert.equal(motor.bound, false);
    assert.equal(motor.suggestedChannel, 'PRESS-STAMP-01.MAIN_MOTOR_CURRENT');
  });

  it('rejects a mesh that is not in the twin and sends the rest to the asking session only', async () => {
    const r = (await call('emit_ui_command', {
      assetId,
      sessionId: SESSION,
      commands: [
        { type: 'highlight', meshName: 'PRESS_MAIN_MOTOR', tone: 'agent', pulse: true },
        { type: 'camera_focus', meshName: 'PRESS_GHOST_PART' },
        { type: 'select_mesh', meshName: 'OLDMESH_1' },
      ],
    })).data;
    assert.equal(r.accepted.length, 2);
    assert.deepEqual(r.rejected.map((x) => x.index), [1]);
    await waitFor(() => uiCommands.length === 1, { message: 'ui:command' });
    assert.deepEqual(uiCommands[0].commands.map((c) => c.meshName), ['PRESS_MAIN_MOTOR', 'OLDMESH_1']);
    const bad = await call('emit_ui_command', { assetId, commands: [{ type: 'run_program', meshName: 'X' }] });
    assert.equal(bad.isError, true, 'a command outside the closed set is refused');
  });

  it('publishes a report: persisted, investigation closed, alert raised, unknown meshes dropped', async () => {
    const { openInvestigation } = await import('../src/services/investigation.service.js');
    const inv = await openInvestigation({
      machineId: PRESS, assetId, sensorId: LUBE, channelKey: 'LUBE_OIL_PRESSURE', kind: 'threshold', severity: 'warn',
      trigger: { value: 3.4, limit: 3.6, limitName: 'warnLow', unit: 'bar' }, openedAt: Date.now(),
    });
    const r = (await call('post_diagnostic_report', {
      investigationId: inv.id,
      machineId: PRESS,
      severity: 'warn',
      level: 'warning',
      headline: 'Clogged lube filter starving the main bearing',
      rootCause: { id: 'F01', name: 'Clogged lube filter', confidence: 0.86, faultCode: 'F01' },
      evidence: [{ test: 'P60 below warn', channel: 'LUBE_OIL_PRESSURE', observed: '3.40 bar', expected: 'at or below 3.6 bar', verdict: 'supports' }],
      citations: [{ chunkId: 'ps01-doc02-0007', document: 'Failure Modes and Fault Signatures', page: 6 }],
      targets: [{ meshName: 'PRESS_LUBE_UNIT', label: 'Lubrication unit', tag: 'lube_unit' }, { meshName: 'PRESS_INVENTED_FILTER' }],
    })).data;
    assert.equal(r.alerted, true);
    assert.deepEqual(r.droppedTargets, ['PRESS_INVENTED_FILTER']);
    await waitFor(() => alerts.length === 1, { message: 'agent:alert' });
    assert.equal(alerts[0].headline, 'Clogged lube filter starving the main bearing');
    assert.equal(alerts[0].assetId, assetId);
    assert.deepEqual(alerts[0].targets.map((t) => t.meshName), ['PRESS_LUBE_UNIT']);
    const stored = await (await fetch(`${web.url}/api/v1/reports/${r.reportId}`)).json();
    assert.equal(stored.data.needsReview, true, 'a dropped target puts the report up for review');
    const invs = await (await fetch(`${web.url}/api/v1/investigations?assetId=${assetId}`)).json();
    assert.equal(invs.data[0].status, 'reported');
    assert.equal(invs.data[0].reportId, r.reportId);
    const again = (await call('post_diagnostic_report', {
      investigationId: inv.id, machineId: PRESS, severity: 'warn', headline: 'second', rootCause: { id: 'x', name: 'x', confidence: 0.1 },
    })).data;
    assert.equal(again.reportId, r.reportId, 'the first report wins');
    assert.equal(again.alerted, false);
  });

  it('streams a chat answer through Node, adds the twin name, and keeps the agent hidden', async () => {
    fakeAgentLog = [];
    const res = await fetch(`${web.url}/api/v1/assistant/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'How is this running?',
        threadId: 'chat:test-thread-1',
        sessionId: SESSION,
        context: { scope: 'twin', assetId, selectedMesh: 'PRESS_LUBE_UNIT', activePanel: 'components' },
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /pressure is 4\.5 bar/);
    assert.match(text, /event: done/);
    const forwarded = fakeAgentLog.find((x) => x.url === '/v1/chat');
    assert.equal(forwarded.auth, `Bearer ${KEY}`);
    assert.equal(forwarded.body.context.assetName, 'Plant twin under test');
    assert.equal(forwarded.body.context.selectedMesh, 'PRESS_LUBE_UNIT');

    const invalid = await fetch(`${web.url}/api/v1/assistant/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '', threadId: 'x', sessionId: SESSION, context: { scope: 'twin' } }),
    });
    assert.equal(invalid.status, 422);
    const status = await (await fetch(`${web.url}/api/v1/agent/status`)).json();
    assert.equal(status.data.agent.reachable, true);
    assert.equal(typeof status.data.detector.channels, 'number');
  });
});
