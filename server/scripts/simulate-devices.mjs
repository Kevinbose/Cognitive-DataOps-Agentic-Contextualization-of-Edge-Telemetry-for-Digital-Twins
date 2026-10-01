#!/usr/bin/env node
/**
 * @file Impersonate the two ESP32 edge gateways from software.
 *
 * ```
 * node server/scripts/simulate-devices.mjs                     # both machines, local Mosquitto
 * node server/scripts/simulate-devices.mjs --machines press-stamp-01 --scenario CLOGGED_FILTER --ramp 90
 * node server/scripts/simulate-devices.mjs --speed 10          # 10x faster faults
 * ```
 *
 * Options (each also has a `SIM_*` environment variable):
 *
 * | Flag         | Env                | Default                     |
 * |--------------|--------------------|-----------------------------|
 * | `--url`      | `SIM_MQTT_URL`     | `mqtt://127.0.0.1:1883`     |
 * | `--user`     | `SIM_MQTT_USER`    | none                        |
 * | `--pass`     | `SIM_MQTT_PASS`    | none                        |
 * | `--site`     | `SIM_SITE_ID`      | catalog `defaultSiteId`     |
 * | `--machines` | `SIM_MACHINES`     | every machine in the catalog|
 * | `--scenario` |                    | `NORMAL`                    |
 * | `--ramp`     |                    | `120` (simulated seconds)   |
 * | `--speed`    |                    | `1`                         |
 * | `--seed`     |                    | `1`                         |
 *
 * The script deliberately does NOT read `server/.env`. A simulator that
 * defaulted to the backend's cloud credentials would publish fake data into the
 * same broker the real boards use and ruin a demo. Pointing it at a cloud
 * broker takes an explicit `--url`.
 *
 * Ctrl+C publishes `offline` and disconnects cleanly. `--crash` makes it drop
 * the connection without a DISCONNECT instead, which is what a power cut looks
 * like and is how the Last Will is exercised.
 */

import { SimulatedGateway, loadCatalog } from './lib/gateway.mjs';

/**
 * @param {string[]} argv
 * @returns {Record<string, string|true>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const env = process.env;
const catalog = loadCatalog();

const url = String(args.url ?? env.SIM_MQTT_URL ?? 'mqtt://127.0.0.1:1883');
const username = String(args.user ?? env.SIM_MQTT_USER ?? '') || null;
const password = String(args.pass ?? env.SIM_MQTT_PASS ?? '') || null;
const siteId = String(args.site ?? env.SIM_SITE_ID ?? catalog.defaultSiteId);
const speed = Number(args.speed ?? 1);
const seed = Number(args.seed ?? 1);
const scenario = String(args.scenario ?? 'NORMAL').toUpperCase();
const rampSec = Number(args.ramp ?? 120);
const machineIds = String(args.machines ?? env.SIM_MACHINES ?? Object.keys(catalog.machines))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

if (!Number.isFinite(speed) || speed <= 0) {
  console.error('--speed must be a positive number');
  process.exit(2);
}

const log = (line) => console.log(`${new Date().toISOString().slice(11, 23)} ${line}`);

log(`Simulating ${machineIds.join(', ')} -> ${new URL(url).host} (site "${siteId}", speed x${speed})`);

const gateways = machineIds.map(
  (machineId, index) =>
    new SimulatedGateway({
      machineId,
      url,
      username,
      password,
      siteId,
      speed,
      seed: seed + index,
      scenario,
      rampSec,
      log,
    }),
);

try {
  await Promise.all(gateways.map((gateway) => gateway.start()));
} catch (error) {
  console.error(`Could not start: ${error.message}`);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  const graceful = args.crash !== true;
  log(`${signal}: stopping ${graceful ? 'cleanly' : 'WITHOUT a DISCONNECT (simulated power cut)'}`);
  await Promise.all(gateways.map((gateway) => gateway.stop({ graceful })));
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
