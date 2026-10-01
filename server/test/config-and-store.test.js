/**
 * Configuration parsing (in child processes, because the config module freezes
 * `process.env` at import time) and the telemetry store's creation logic.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import mongoose from 'mongoose';

import { assertTestDatabase, connectTestDatabase, dropTestDatabase } from './helpers.js';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load the config in a fresh process with the given environment.
 *
 * @param {Record<string, string>} env
 * @returns {{status: number|null, stdout: string, stderr: string, config?: any}}
 */
function loadConfig(env) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const { config } = await import('./src/config/env.config.js'); console.log(JSON.stringify(config));",
    ],
    {
      cwd: SERVER_ROOT,
      encoding: 'utf8',
      // Start from a clean slate so the developer's own settings cannot change
      // the outcome. NODE_ENV=test also stops the config module reading the
      // developer's dotfile, which a clean environment alone would not.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', ...env },
    },
  );
  let config;
  try {
    config = JSON.parse(result.stdout.trim().split('\n').at(-1));
  } catch {
    /* failed to boot, as expected in negative cases */
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, config };
}

describe('environment configuration', () => {
  it('has safe defaults: loopback, no ingestion, commands off', () => {
    const { status, config } = loadConfig({});
    assert.equal(status, 0);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.mqtt.url, null);
    assert.equal(config.enableDeviceCommands, false);
    assert.equal(config.telemetry.persist, true);
    assert.equal(config.telemetry.retentionHours, 48);
    assert.equal(config.mqtt.siteId, 'vit-lab');
  });

  it('reads a boolean by its meaning, never by truthiness ("false" must mean false)', () => {
    for (const off of ['false', '0', 'no', 'off', 'FALSE']) {
      assert.equal(loadConfig({ TELEMETRY_PERSIST: off }).config.telemetry.persist, false, off);
      assert.equal(loadConfig({ ENABLE_DEVICE_COMMANDS: off }).config.enableDeviceCommands, false, off);
    }
    for (const on of ['true', '1', 'yes', 'on', 'True']) {
      assert.equal(loadConfig({ ENABLE_DEVICE_COMMANDS: on }).config.enableDeviceCommands, true, on);
    }
  });

  it('refuses to boot on an ambiguous boolean', () => {
    const result = loadConfig({ ENABLE_DEVICE_COMMANDS: 'banana' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENABLE_DEVICE_COMMANDS/);
  });

  it('refuses an MQTT URL that carries credentials, so they cannot leak through /health or logs', () => {
    const result = loadConfig({ MQTT_URL: 'mqtts://user:secret@broker.example:8883' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /no credentials/);
    assert.ok(!result.stderr.includes('secret@'), 'the error must not echo the password');
  });

  it('accepts mqtt and mqtts URLs and rejects other schemes and paths', () => {
    assert.equal(loadConfig({ MQTT_URL: 'mqtt://127.0.0.1:1883' }).config.mqtt.url, 'mqtt://127.0.0.1:1883');
    assert.equal(
      loadConfig({ MQTT_URL: 'mqtts://abc.s1.eu.hivemq.cloud:8883' }).config.mqtt.url,
      'mqtts://abc.s1.eu.hivemq.cloud:8883',
    );
    assert.notEqual(loadConfig({ MQTT_URL: 'http://broker:1883' }).status, 0);
    assert.notEqual(loadConfig({ MQTT_URL: 'mqtt://broker:1883/some/path' }).status, 0);
  });

  it('validates the site id, because it becomes a topic segment', () => {
    assert.notEqual(loadConfig({ MQTT_SITE_ID: 'Has Space' }).status, 0);
    assert.notEqual(loadConfig({ MQTT_SITE_ID: 'a/b' }).status, 0);
    assert.equal(loadConfig({ MQTT_SITE_ID: 'plant-2' }).config.mqtt.siteId, 'plant-2');
  });

  it('allows zero where zero is meaningful and rejects it where it is not', () => {
    assert.equal(loadConfig({ COMMAND_MIN_INTERVAL_MS: '0' }).config.commandMinIntervalMs, 0);
    assert.notEqual(loadConfig({ TELEMETRY_RETENTION_HOURS: '0' }).status, 0);
    assert.notEqual(loadConfig({ TELEMETRY_PERSIST_HZ: '-1' }).status, 0);
    assert.notEqual(loadConfig({ NODE_ENV: 'staging' }).status, 0);
  });
});

describe('telemetry store creation', () => {
  /** @type {any} */ let store;

  before(async () => {
    store = await import('../src/services/telemetryStore.service.js');
    await connectTestDatabase();
  });

  after(dropTestDatabase);

  it('refuses to run against anything but a disposable test database', () => {
    assertTestDatabase();
    assert.match(mongoose.connection.name, /^cdo_test_/);
  });

  it('creates native time-series collections with the configured retention', async () => {
    const modes = await store.ensureTelemetryStore({ retentionHours: 48 });
    assert.deepEqual(modes, { readings: 'timeseries', spectra: 'timeseries' });

    const [readings] = await mongoose.connection.db.listCollections({ name: 'telemetry_readings' }).toArray();
    assert.equal(readings.type, 'timeseries');
    assert.equal(readings.options.timeseries.timeField, 'ts');
    assert.equal(readings.options.timeseries.metaField, 'meta');
    assert.equal(readings.options.expireAfterSeconds, 48 * 3600);
  });

  it('is idempotent, and applies a changed retention with collMod instead of failing', async () => {
    await store.ensureTelemetryStore({ retentionHours: 48 });
    const modes = await store.ensureTelemetryStore({ retentionHours: 12 });
    assert.equal(modes.readings, 'timeseries');

    const [readings] = await mongoose.connection.db.listCollections({ name: 'telemetry_readings' }).toArray();
    assert.equal(readings.options.expireAfterSeconds, 12 * 3600);
  });

  it('stores and reads back a reading with a Date timestamp', async () => {
    store.startTelemetryWriter({ intervalMs: 60_000 });
    const ts = new Date();
    store.enqueueReadings([{ ts, meta: { sensorId: 'X.Y' }, value: 1.5 }]);
    await store.flushTelemetryStore();
    await store.stopTelemetryWriter();

    const points = await store.queryHistory({
      sensorId: 'X.Y',
      from: new Date(ts.getTime() - 1000),
      to: new Date(ts.getTime() + 1000),
      bucketSec: 1,
      maxPoints: 10,
    });
    assert.equal(points.length, 1);
    assert.equal(points[0].avg, 1.5);
  });

  it('falls back to a plain collection with TTL and lookup indexes when one already exists', async () => {
    await mongoose.connection.db.dropCollection('telemetry_readings');
    await mongoose.connection.db.createCollection('telemetry_readings'); // plain

    const modes = await store.ensureTelemetryStore({ retentionHours: 24 });
    assert.equal(modes.readings, 'fallback');

    const indexes = await mongoose.connection.db.collection('telemetry_readings').indexes();
    const ttl = indexes.find((i) => i.name === 'ttl_ts');
    assert.equal(ttl.expireAfterSeconds, 24 * 3600);
    assert.ok(indexes.some((i) => i.name === 'by_sensor_ts'));

    // A changed retention updates the existing TTL index in place.
    await store.ensureTelemetryStore({ retentionHours: 6 });
    const after = (await mongoose.connection.db.collection('telemetry_readings').indexes()).find(
      (i) => i.name === 'ttl_ts',
    );
    assert.equal(after.expireAfterSeconds, 6 * 3600);
  });
});
