/**
 * @file A software stand-in for one ESP32 edge gateway.
 *
 * `SimulatedGateway` speaks exactly the wire contract in
 * `docs/mqtt-contract.md`: a retained `birth`, a retained `status` with a Last
 * Will, `telemetry` and `spectrum` streams, periodic `diag` (carrying the
 * scenario ground truth in `diag.sim`), and the `cmd/*` topics with
 * acknowledgements. The ingestion service cannot tell it from the real board,
 * which is the point: it is demo insurance when a board or the Wi-Fi fails, and
 * it lets teammates without hardware work on the whole pipeline.
 *
 * The channel catalog comes from `firmware/catalog.json`, the same file that
 * generates the firmware header, so the two cannot drift apart.
 *
 * @module scripts/lib/gateway
 */

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

import { connect } from 'mqtt';

import { createModel, mulberry32, rampOf, roundTo } from './sim-models.mjs';

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CATALOG_URL = new URL('../../../firmware/catalog.json', import.meta.url);

/**
 * Read `firmware/catalog.json`.
 *
 * @returns {{contractVersion: number, defaultSiteId: string, machines: Record<string, any>}}
 */
export function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_URL, 'utf8'));
}

/**
 * Build the `birth` payload for a machine. Deep-equal to the catalog on
 * purpose: a backend test asserts it, so a catalog edit cannot silently change
 * what a gateway announces.
 *
 * @param {string} machineId
 * @param {any} machine - The machine's catalog entry.
 * @param {{fw: string, mac: string, bootId: string}} identity
 * @returns {object} Birth payload.
 */
export function buildBirth(machineId, machine, { fw, mac, bootId }) {
  return {
    v: 1,
    machineId,
    machineType: machine.machineType,
    label: machine.label,
    fw,
    mac,
    bootId,
    intervalMs: machine.intervalMs,
    scenarios: machine.scenarios,
    channels: machine.channels,
    spectrum: machine.spectrum,
  };
}

/** Locally administered MAC derived from the machine id, so it is stable per machine. */
function macFor(machineId) {
  let hash = 0;
  for (const ch of machineId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `02:CD:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}:${hex.slice(6, 8)}`.toUpperCase();
}

/**
 * @typedef {object} GatewayOptions
 * @property {string} machineId - Key into the catalog, e.g. `press-stamp-01`.
 * @property {string} url - Broker URL.
 * @property {string|null} [username]
 * @property {string|null} [password]
 * @property {string} [siteId]
 * @property {number} [speed] - Simulated seconds per wall-clock second. 1 is real time.
 * @property {number} [seed] - PRNG seed.
 * @property {string} [scenario] - Scenario to start in.
 * @property {number} [rampSec] - Ramp length for the starting scenario, in simulated seconds.
 * @property {(line: string) => void} [log]
 * @property {any} [catalog] - Override the catalog (tests).
 */

export class SimulatedGateway {
  /** @param {GatewayOptions} options */
  constructor({
    machineId,
    url,
    username = null,
    password = null,
    siteId,
    speed = 1,
    seed = 1,
    scenario = 'NORMAL',
    rampSec = 120,
    log = () => {},
    catalog = loadCatalog(),
  }) {
    const machine = catalog.machines[machineId];
    if (!machine) {
      throw new Error(
        `Unknown machine "${machineId}". Known: ${Object.keys(catalog.machines).join(', ')}`,
      );
    }

    this.machineId = machineId;
    this.machine = machine;
    this.url = url;
    this.username = username;
    this.password = password;
    this.siteId = siteId ?? catalog.defaultSiteId;
    this.speed = speed;
    this.log = log;

    this.mac = macFor(machineId);
    this.fw = 'sim-1.0.0';
    this.bootId = randomBytes(4).toString('hex');
    this.base = `cdo/v1/${this.siteId}/${machineId}`;

    this.rng = mulberry32(seed);
    this.model = createModel(machine.machineType, machine, this.rng);
    this.intervalMs = machine.intervalMs;

    this.scenario = { scenario: 'NORMAL', startedAtSec: 0, rampSec: 120 };
    this.startScenario = { scenario, rampSec };

    this.seq = 0;
    this.spectrumSeq = 0;
    this.restarts = 0;
    this.mqttReconnects = 0;
    this.startedAt = Date.now();
    this.lastSpectrumAt = 0;

    /** @type {import('mqtt').MqttClient|null} */
    this.client = null;
    /** @type {NodeJS.Timeout|null} */
    this.tickTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.diagTimer = null;
    this.seenCommands = new Set();
    this.stopped = false;
  }

  /** Simulated seconds since this gateway "booted". */
  get simTime() {
    return ((Date.now() - this.startedAt) / 1000) * this.speed;
  }

  /**
   * Connect and start publishing.
   *
   * @returns {Promise<void>} Resolves when the broker has accepted the connection.
   */
  start() {
    this.stopped = false;
    return this.#connect();
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const client = connect(this.url, {
        clientId: `cdo-${this.machineId}-${this.mac.slice(-8).replace(/:/g, '')}`,
        username: this.username ?? undefined,
        password: this.password ?? undefined,
        clean: true,
        // Matches the real firmware: a 10 s keepalive puts the Last Will on the
        // wire about 15 s after a silent drop.
        keepalive: 10,
        reconnectPeriod: 2000,
        connectTimeout: 10_000,
        will: { topic: `${this.base}/status`, payload: Buffer.from('offline'), qos: 1, retain: true },
      });
      this.client = client;

      let first = true;
      client.on('connect', () => {
        const wasFirst = first;
        first = false;
        if (!wasFirst) this.mqttReconnects += 1;
        // start() resolves only once identity, status and diagnostics are out.
        void this.#onConnect().then(() => {
          if (wasFirst) resolve();
        });
      });
      client.on('error', (error) => {
        this.log(`[${this.machineId}] MQTT error: ${error.message}`);
        if (first && this.stopped) reject(error);
      });
      client.on('message', (topic, payload) => this.#onMessage(topic, payload));
    });
  }

  async #onConnect() {
    const { client } = this;
    if (!client) return;

    client.subscribe(`${this.base}/cmd/#`, { qos: 1 });

    // Identity first, then state, then diagnostics, with a short pause between
    // them. The real firmware cannot publish back to back either: PubSubClient
    // needs loop time between packets. The pause also sidesteps a race in the
    // in-process test broker (aedes), which drops a retained QoS 0 message when
    // the same client publishes again in the same tick; Mosquitto and HiveMQ do
    // not have that problem.
    this.#publish('birth', JSON.stringify(this.#birth()), { retain: true, qos: 0 });
    await sleep(40);
    this.#publish('status', 'online', { retain: true, qos: 1 });
    await sleep(40);
    this.#publishDiag();

    if (!this.tickTimer) {
      if (this.startScenario.scenario !== 'NORMAL') {
        this.#setScenario(this.startScenario.scenario, this.startScenario.rampSec);
      }
      this.#armTick();
      this.diagTimer = setInterval(() => this.#publishDiag(), 15_000);
    }
    this.log(`[${this.machineId}] online (bootId ${this.bootId})`);
  }

  #birth() {
    return buildBirth(this.machineId, this.machine, {
      fw: this.fw,
      mac: this.mac,
      bootId: this.bootId,
    });
  }

  #armTick() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.#tick(), this.intervalMs);
  }

  /** Current scenario and ramp, as reported in `diag.sim`. */
  #sim() {
    const t = this.simTime;
    return {
      scenario: this.scenario.scenario,
      ramp: roundTo(rampOf(this.scenario, t), 3),
      rampSec: this.scenario.rampSec,
    };
  }

  #setScenario(name, rampSec) {
    this.scenario = { scenario: name, startedAtSec: this.simTime, rampSec };
  }

  #tick() {
    if (!this.client?.connected) return;

    const t = this.simTime;
    const r = rampOf(this.scenario, t);
    const result = this.model.sample(t, this.scenario.scenario, r);

    const m = {};
    for (const channel of this.machine.channels) {
      m[channel.key] = roundTo(result.channels[channel.key], channel.decimals);
    }

    this.#publish(
      'telemetry',
      JSON.stringify({ v: 1, seq: this.seq, ts: Date.now(), synced: true, m }),
    );
    this.seq += 1;

    const spectrum = this.machine.spectrum;
    if (spectrum && result.spectrum && Date.now() - this.lastSpectrumAt >= spectrum.intervalMs) {
      this.lastSpectrumAt = Date.now();
      this.#publish(
        'spectrum',
        JSON.stringify({
          v: 1,
          seq: this.spectrumSeq,
          ts: Date.now(),
          key: spectrum.key,
          amp: result.spectrum.map((a) => roundTo(a, 3)),
        }),
      );
      this.spectrumSeq += 1;
    }
  }

  #publishDiag() {
    this.#publish(
      'diag',
      JSON.stringify({
        v: 1,
        ts: Date.now(),
        fw: this.fw,
        bootId: this.bootId,
        uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
        rssi: -52 - Math.round(this.rng() * 8),
        heapFree: 210_000 + Math.round(this.rng() * 2000),
        heapMin: 198_000,
        reset: 'POWERON',
        wifiReconnects: 0,
        mqttReconnects: this.mqttReconnects,
        restarts: this.restarts,
        publishFailures: 0,
        tls: false,
        insecure: false,
        sim: this.#sim(),
      }),
    );
  }

  /**
   * @param {string} suffix
   * @param {string} payload
   * @param {{retain?: boolean, qos?: 0|1}} [options]
   */
  #publish(suffix, payload, { retain = false, qos = 0 } = {}) {
    this.client?.publish(`${this.base}/${suffix}`, payload, { retain, qos });
  }

  #ack(cmd, name, ok, detail) {
    this.#publish(
      'ack',
      JSON.stringify({ cmdId: cmd.cmdId, name, ok, detail: String(detail).slice(0, 160), ts: Date.now() }),
    );
  }

  #onMessage(topic, payload) {
    const match = /\/cmd\/([a-z]+)$/.exec(topic);
    if (!match) return;
    const name = match[1];

    let cmd;
    try {
      cmd = JSON.parse(payload.toString('utf8'));
    } catch {
      return;
    }
    if (typeof cmd?.cmdId !== 'string') return;

    // QoS 1 can deliver twice. Acknowledge the repeat without acting on it.
    if (this.seenCommands.has(cmd.cmdId)) {
      this.#ack(cmd, name, true, 'duplicate ignored');
      return;
    }
    this.seenCommands.add(cmd.cmdId);
    if (this.seenCommands.size > 64) this.seenCommands.delete(this.seenCommands.values().next().value);

    if (typeof cmd.issuedAt === 'number' && typeof cmd.ttlMs === 'number') {
      if (Date.now() - cmd.issuedAt > cmd.ttlMs) {
        this.#ack(cmd, name, false, 'expired');
        return;
      }
    }

    switch (name) {
      case 'scenario': {
        if (!this.machine.scenarios.includes(cmd.scenario)) {
          this.#ack(cmd, name, false, `unknown scenario ${cmd.scenario}`);
          return;
        }
        const rampSec = Number.isFinite(cmd.rampSec) ? cmd.rampSec : 120;
        this.#setScenario(cmd.scenario, rampSec);
        this.#ack(cmd, name, true, `${cmd.scenario} ramp ${rampSec}s`);
        this.#publishDiag();
        break;
      }
      case 'interval': {
        const ms = Number(cmd.intervalMs);
        if (!Number.isInteger(ms) || ms < 250 || ms > 5000) {
          this.#ack(cmd, name, false, 'intervalMs out of range');
          return;
        }
        this.intervalMs = ms;
        this.#armTick();
        this.#ack(cmd, name, true, `interval ${ms}ms`);
        break;
      }
      case 'ping':
        this.#ack(cmd, name, true, 'pong');
        break;
      case 'reboot':
        this.#ack(cmd, name, true, 'rebooting');
        setTimeout(() => void this.#reboot(), 200);
        break;
      default:
        this.#ack(cmd, name, false, 'unknown command');
    }
  }

  /** Drop the connection without a DISCONNECT (so the Last Will fires), then boot again. */
  async #reboot() {
    this.log(`[${this.machineId}] rebooting`);
    this.#stopTimers();
    const old = this.client;
    this.client = null;
    await new Promise((resolve) => old?.end(true, {}, resolve));

    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (this.stopped) return;

    this.restarts += 1;
    this.bootId = randomBytes(4).toString('hex');
    this.seq = 0;
    this.spectrumSeq = 0;
    this.startedAt = Date.now();
    this.scenario = { scenario: 'NORMAL', startedAtSec: 0, rampSec: 120 };
    this.startScenario = { scenario: 'NORMAL', rampSec: 120 };
    this.model = createModel(this.machine.machineType, this.machine, this.rng);
    await this.#connect();
  }

  #stopTimers() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.diagTimer) clearInterval(this.diagTimer);
    this.tickTimer = null;
    this.diagTimer = null;
  }

  /**
   * Stop publishing.
   *
   * @param {object} [options]
   * @param {boolean} [options.graceful] - `true` (default) publishes `offline` and
   *   sends a clean DISCONNECT. `false` drops the socket without one, which is
   *   what a power cut looks like: the broker then publishes the Last Will.
   * @returns {Promise<void>}
   */
  async stop({ graceful = true } = {}) {
    this.stopped = true;
    this.#stopTimers();
    const client = this.client;
    this.client = null;
    if (!client) return;

    if (graceful) {
      await new Promise((resolve) =>
        client.publish(`${this.base}/status`, 'offline', { retain: true, qos: 1 }, resolve),
      );
      await new Promise((resolve) => client.end(false, {}, resolve));
    } else {
      await new Promise((resolve) => client.end(true, {}, resolve));
    }
  }
}

export default { SimulatedGateway, buildBirth, loadCatalog };
