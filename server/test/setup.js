/**
 * @file Test environment, loaded with `node --import ./test/setup.js --test`.
 *
 * It must run BEFORE any application module is imported, because
 * `env.config.js` reads `process.env` once at import time and freezes the
 * result. A plain `NODE_ENV=test` prefix in the npm script would not work on
 * Windows `cmd.exe`, which is why this is a preload module instead.
 *
 * Each test FILE runs in its own process, so each gets its own random database
 * name and files can run in parallel without touching each other's data.
 * `helpers.js` refuses to drop any database whose name does not start with
 * `cdo_test_`, so a wrong connection string can never wipe real data.
 */

import { randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';

// Never inherit a developer's real database or broker.
process.env.MONGODB_URI = `mongodb://127.0.0.1:27017/cdo_test_${randomBytes(4).toString('hex')}`;
delete process.env.MQTT_URL;
delete process.env.MQTT_USERNAME;
delete process.env.MQTT_PASSWORD;

process.env.MQTT_SITE_ID = 'vit-lab';
process.env.ENABLE_DEVICE_COMMANDS = 'true';
process.env.COMMAND_MIN_INTERVAL_MS = '0';

// Flush and emit quickly so tests wait tenths of a second, not seconds.
process.env.TELEMETRY_PERSIST_HZ = '10';
process.env.TELEMETRY_EMIT_HZ_MAX = '20';
