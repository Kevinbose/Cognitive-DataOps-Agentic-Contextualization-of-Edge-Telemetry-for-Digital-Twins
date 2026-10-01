#!/usr/bin/env node
/**
 * @file Print the MQTT traffic of the contract namespace, formatted and bounded.
 *
 * ```
 * node server/scripts/mqtt-tail.mjs                          # 10 s of everything
 * node server/scripts/mqtt-tail.mjs --seconds 30 --only status,diag,ack,birth
 * node server/scripts/mqtt-tail.mjs --machine press-stamp-01 --max 40
 * node server/scripts/mqtt-tail.mjs --raw                    # payloads as received
 * ```
 *
 * Bounded by default (10 seconds, 200 lines) so it is safe to run from an
 * assistant or a script: it always exits. Retained messages that the broker
 * replays on subscribe are marked `[retained]`, which is how a stale `online`
 * from a dead board is spotted.
 *
 * Options: `--url` (default `mqtt://127.0.0.1:1883`, env `TAIL_MQTT_URL`),
 * `--user`, `--pass`, `--site` (default `vit-lab`), `--machine`, `--only`
 * (comma-separated suffixes), `--seconds`, `--max`, `--raw`.
 *
 * Like the simulator, it does not read `server/.env`; credentials are passed
 * explicitly.
 */

import { connect } from 'mqtt';

/** @returns {Record<string, string|true>} */
function parseArgs(argv) {
  /** @type {Record<string, string|true>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const url = String(args.url ?? process.env.TAIL_MQTT_URL ?? 'mqtt://127.0.0.1:1883');
const site = String(args.site ?? 'vit-lab');
const seconds = Number(args.seconds ?? 10);
const maxLines = Number(args.max ?? 200);
const raw = args.raw === true;
const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const machine = args.machine ? String(args.machine) : '+';

const filter = `cdo/v1/${site}/${machine}/#`;
let lines = 0;

/**
 * One readable line per message type.
 *
 * @param {string} suffix
 * @param {Buffer} payload
 * @returns {string}
 */
function summarise(suffix, payload) {
  const text = payload.toString('utf8');
  if (raw) return text;

  try {
    const json = JSON.parse(text);
    switch (suffix) {
      case 'telemetry':
        return `seq=${json.seq} ${Object.entries(json.m).map(([k, v]) => `${k}=${v}`).join(' ')}`;
      case 'spectrum': {
        const peak = json.amp.reduce((best, v, i) => (v > best.v ? { v, i } : best), { v: -1, i: 0 });
        return `seq=${json.seq} bins=${json.amp.length} peak=${peak.v} @bin ${peak.i}`;
      }
      case 'birth':
        return `${json.label} fw=${json.fw} boot=${json.bootId} channels=${json.channels.map((c) => c.key).join(',')}`;
      case 'diag':
        return (
          `up=${json.uptimeS}s rssi=${json.rssi} heap=${json.heapFree}/${json.heapMin} ` +
          `reconn=${json.wifiReconnects}/${json.mqttReconnects} tls=${json.tls}` +
          (json.sim ? ` sim=${json.sim.scenario}@${json.sim.ramp}` : '')
        );
      case 'ack':
        return `${json.name} ${json.ok ? 'ok' : 'FAILED'} cmd=${json.cmdId} ${json.detail}`;
      default:
        return text;
    }
  } catch {
    return text;
  }
}

const client = connect(url, {
  clientId: `cdo-tail-${process.pid}`,
  username: args.user ? String(args.user) : undefined,
  password: args.pass ? String(args.pass) : undefined,
  clean: true,
  connectTimeout: 8000,
  reconnectPeriod: 0,
});

const timer = setTimeout(() => finish(0), seconds * 1000);

function finish(code) {
  clearTimeout(timer);
  client.end(true, {}, () => process.exit(code));
}

client.on('connect', () => {
  console.log(`# ${new URL(url).host} ${filter} for ${seconds}s`);
  client.subscribe(filter, { qos: 0 });
});

client.on('error', (error) => {
  console.error(`# error: ${error.message}`);
  finish(1);
});

client.on('message', (topic, payload, packet) => {
  const parts = topic.split('/');
  const suffix = parts.slice(4).join('/');
  if (only && !only.includes(parts[4])) return;

  const stamp = new Date().toISOString().slice(11, 23);
  const tag = packet.retain ? ' [retained]' : '';
  console.log(`${stamp} ${parts[3]}/${suffix}${tag}  ${summarise(parts[4], payload)}`);

  lines += 1;
  if (lines >= maxLines) finish(0);
});
