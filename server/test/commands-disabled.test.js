/**
 * Device commands are OFF unless an operator opts in. This file runs in its own
 * process with the flag explicitly false, because the setting is read once at
 * import time.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

process.env.ENABLE_DEVICE_COMMANDS = 'false';

const { connectTestDatabase, dropTestDatabase, startHttp } = await import('./helpers.js');

describe('device commands disabled by default', () => {
  /** @type {any} */ let http;

  before(async () => {
    await connectTestDatabase();
    http = await startHttp();
  });

  after(async () => {
    await http?.stop();
    await dropTestDatabase();
  });

  it('refuses a command with an explanation of how to enable it', async () => {
    const res = await fetch(`${http.url}/api/v1/devices/press-stamp-01/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'reboot' }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.message, /ENABLE_DEVICE_COMMANDS/);
  });

  it('advertises the setting so the UI can hide the fault panel', async () => {
    const { data } = await (await fetch(`${http.url}/api/v1/meta`)).json();
    assert.equal(data.features.deviceCommands, false);
    assert.equal(data.features.ingestion, false, 'no MQTT_URL is set in the test environment');
  });

  it('validates the body before anything else, so typos never reach a broker', async () => {
    const res = await fetch(`${http.url}/api/v1/devices/press-stamp-01/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'format-disk' }),
    });
    assert.equal(res.status, 422);
  });

  it('lists no devices and reports ingestion off when no broker is configured', async () => {
    const devices = await (await fetch(`${http.url}/api/v1/devices`)).json();
    assert.deepEqual(devices.data, []);
    const health = await (await fetch(`${http.url}/api/v1/health`)).json();
    assert.equal(health.data.ingestion.enabled, false);
  });

  it('answers 404 for the ground truth of a device it has never heard of', async () => {
    const res = await fetch(`${http.url}/api/v1/devices/nobody-01/sim`);
    assert.equal(res.status, 404);
  });

  it('turns a foreign browser origin into a 403, not a 500', async () => {
    const res = await fetch(`${http.url}/api/v1/devices`, { headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });
});
