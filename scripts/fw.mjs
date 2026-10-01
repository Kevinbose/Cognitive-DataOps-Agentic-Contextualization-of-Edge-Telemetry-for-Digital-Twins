#!/usr/bin/env node
/**
 * @file Firmware tool: ports, machine select, compile, upload, monitor, self-test.
 *
 * A thin wrapper around the `arduino-cli` that ships inside the Arduino IDE, so
 * nothing has to be installed and the IDE's ESP32 core and libraries are reused.
 * It exists to make the risky steps safe, for a person or for Claude Code:
 *
 *   - **Boards are found by USB VID:PID, never by COM number.** COM numbers move
 *     around and Bluetooth serial ports look like boards. Only a port whose
 *     VID:PID is on the allow-list of ESP32 USB bridges can be uploaded to.
 *   - **An upload names the machine it carries** (`--confirm-machine press`) and
 *     is refused unless that is what was compiled, the sketch has not changed
 *     since, and `secrets.h` is real. Flashing the robot image onto the press
 *     board, or a half-filled secrets file onto either, cannot happen by accident.
 *   - **A compile never needs secrets.h.** With none, it builds against the
 *     template and is marked "compile check only", which `upload` refuses.
 *   - **Build output lives in a short path** under the system temp directory.
 *     The ESP32 toolchain overruns Windows' 260 character limit inside a deep
 *     repository path.
 *
 * See firmware/README.md for the bring-up protocol.
 *
 * @module scripts/fw
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { loadCatalog } from '../server/scripts/lib/gateway.mjs';
import { judge, parseSerial } from '../server/scripts/lib/selftest.mjs';
import { catalogId, generate } from './gen-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKETCH_DIR = path.join(ROOT, 'firmware', 'cdo-edge-gateway');
export const SKETCH_NAME = 'cdo-edge-gateway';
const LOGS_DIR = path.join(ROOT, 'firmware', '.logs');
const MACHINE_SELECT = path.join(SKETCH_DIR, 'machine_select.h');
const SECRETS = path.join(SKETCH_DIR, 'secrets.h');
const ROOT_CA = path.join(SKETCH_DIR, 'root_ca.h');

/** Build output root. Short on purpose (Windows MAX_PATH). Override for tests. */
export const BUILD_ROOT = process.env.CDO_FW_BUILD_ROOT ?? path.join(os.tmpdir(), 'cdo-fw');

export const DEFAULT_FQBN = 'esp32:esp32:esp32';
const BAUD = 115200;
/** Flash use above this share suggests switching to a larger app partition. */
const FLASH_WARN_PERCENT = 90;

/* ─── USB allow-list ───────────────────────────────────────────────────────── */

/**
 * USB bridges found on ESP32 boards. A port is uploadable only if its VID:PID is
 * here. `pid: '*'` matches any product of that vendor.
 */
export const USB_BRIDGES = Object.freeze([
  { vid: '10C4', pid: 'EA60', name: 'Silicon Labs CP210x' },
  { vid: '1A86', pid: '7523', name: 'WCH CH340' },
  { vid: '1A86', pid: '55D4', name: 'WCH CH9102' },
  { vid: '0403', pid: '6001', name: 'FTDI FT232' },
  { vid: '303A', pid: '*', name: 'Espressif native USB' },
]);

/**
 * @param {string|null|undefined} vid - Hex, with or without `0x`.
 * @param {string|null|undefined} pid
 * @returns {{vid: string, pid: string, name: string}|null}
 */
export function classifyUsb(vid, pid) {
  const v = normaliseHex(vid);
  const p = normaliseHex(pid);
  if (!v) return null;
  return USB_BRIDGES.find((b) => b.vid === v && (b.pid === '*' || b.pid === p)) ?? null;
}

/** @param {string|null|undefined} value */
function normaliseHex(value) {
  if (!value) return null;
  const hex = String(value).replace(/^0x/i, '').toUpperCase();
  return /^[0-9A-F]{1,4}$/.test(hex) ? hex.padStart(4, '0') : null;
}

/**
 * Turn `arduino-cli board list --format json` into plain rows.
 *
 * @param {any} json
 * @returns {Array<{address: string, protocol: string, label: string, vid: string|null, pid: string|null, boards: string[], bridge: {name: string}|null}>}
 */
export function parseBoardList(json) {
  const detected = json?.detected_ports ?? [];
  return detected.map((entry) => {
    const port = entry.port ?? {};
    const vid = normaliseHex(port.properties?.vid);
    const pid = normaliseHex(port.properties?.pid);
    return {
      address: String(port.address ?? ''),
      protocol: String(port.protocol ?? ''),
      label: String(port.protocol_label ?? port.label ?? ''),
      vid,
      pid,
      boards: (entry.matching_boards ?? []).map((b) => b.name),
      bridge: classifyUsb(vid, pid),
    };
  });
}

/* ─── The sketch on disk ───────────────────────────────────────────────────── */

/**
 * Drop C comments. Naive on purpose: secrets.h is plain `#define` lines.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * The names of settings in a secrets file that still hold a CHANGE_ME value.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function findPlaceholders(text) {
  return stripComments(text)
    .split(/\r?\n/)
    .filter((line) => line.includes('CHANGE_ME'))
    .map((line) => /#\s*define\s+(\w+)/.exec(line)?.[1] ?? line.trim());
}

/**
 * Which machine `machine_select.h` currently names.
 *
 * @param {string} text
 * @returns {number|null}
 */
export function parseMachineType(text) {
  const m = /^\s*#\s*define\s+MACHINE_TYPE\s+(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * @param {string} text - Contents of machine_select.h.
 * @param {number} typeCode
 * @returns {string}
 */
export function withMachineType(text, typeCode) {
  if (parseMachineType(text) === null) throw new Error('machine_select.h has no "#define MACHINE_TYPE n" line');
  return text.replace(/^(\s*#\s*define\s+MACHINE_TYPE\s+)\d+/m, `$1${typeCode}`);
}

/**
 * A fingerprint of every source file in the sketch, so an upload can tell that
 * what it is about to flash is what was compiled.
 *
 * @param {string} [dir]
 * @returns {string}
 */
export function sketchHash(dir = SKETCH_DIR) {
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(dir).filter((f) => /\.(ino|h)$/.test(f)).sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * @param {string} fqbn
 * @returns {string} The chip family, for example `esp32s3`.
 */
export function chipOf(fqbn) {
  return fqbn.split(':')[2] ?? 'esp32';
}

/** Flash use reported by the compiler, or null. */
export function parseSketchSize(output) {
  const m = /Sketch uses (\d+) bytes \((\d+)%\) of program storage space\. Maximum is (\d+) bytes/.exec(output);
  return m ? { bytes: Number(m[1]), percent: Number(m[2]), max: Number(m[3]) } : null;
}

/* ─── arduino-cli ──────────────────────────────────────────────────────────── */

/**
 * Find arduino-cli: `$ARDUINO_CLI`, then the PATH, then the copy bundled with
 * the Arduino IDE 2.x.
 *
 * @returns {string|null}
 */
export function findArduinoCli() {
  const candidates = [];
  if (process.env.ARDUINO_CLI) candidates.push(process.env.ARDUINO_CLI);

  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['arduino-cli'], { encoding: 'utf8' });
  if (probe.status === 0) candidates.push(...probe.stdout.split(/\r?\n/).filter(Boolean));

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA, 'Programs', 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', 'arduino-cli.exe'),
    );
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources/arduino-cli');
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

function requireCli() {
  const cli = findArduinoCli();
  if (!cli) {
    throw new Error(
      'arduino-cli was not found. Install the Arduino IDE 2.x (it bundles one), or set ARDUINO_CLI to its path.',
    );
  }
  return cli;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Run arduino-cli to completion and collect its output.
 *
 * @param {string[]} args
 * @param {object} [options]
 * @param {(chunk: string) => void} [options.onOutput] - Called for each chunk as it arrives.
 * @returns {Promise<{code: number, output: string}>}
 */
function runCli(args, { onOutput } = {}) {
  const cli = requireCli();
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['--no-color', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (chunk) => {
      const text = chunk.toString('utf8').replace(ANSI, '');
      output += text;
      onOutput?.(text);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/* ─── Ports ────────────────────────────────────────────────────────────────── */

/** @returns {Promise<ReturnType<typeof parseBoardList>>} */
export async function listPorts() {
  const { code, output } = await runCli(['board', 'list', '--format', 'json']);
  if (code !== 0) throw new Error(`arduino-cli board list failed:\n${output}`);
  return parseBoardList(JSON.parse(output));
}

/**
 * USB devices with an allow-listed VID:PID that Windows knows about, whether or
 * not they got a COM port. A board with a missing driver shows up here with an
 * error status and no COM port, which is exactly the case `board list` hides.
 *
 * @returns {Array<{name: string, vid: string, pid: string, status: string, bridge: string}>}
 */
export function listUsbDevicesWindows() {
  if (process.platform !== 'win32') return [];
  const script =
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -match '^USB.*VID_(10C4|1A86|0403|303A)' } | " +
    'Select-Object Name, PNPDeviceID, Status | ConvertTo-Json -Compress';
  const run = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (run.status !== 0 || !run.stdout.trim()) return [];

  let rows = [];
  try {
    const parsed = JSON.parse(run.stdout);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  return rows.flatMap((row) => {
    const id = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(row.PNPDeviceID ?? '');
    if (!id) return [];
    const bridge = classifyUsb(id[1], id[2]);
    return bridge
      ? [{ name: String(row.Name ?? ''), vid: id[1].toUpperCase(), pid: id[2].toUpperCase(), status: String(row.Status ?? ''), bridge: bridge.name }]
      : [];
  });
}

async function cmdPorts({ json = false } = {}) {
  const ports = await listPorts();
  const usb = listUsbDevicesWindows();
  const boards = ports.filter((p) => p.bridge);

  if (json) {
    console.log(JSON.stringify({ ports, usb, esp32Candidates: boards.length }, null, 2));
    return 0;
  }

  console.log('Serial ports (arduino-cli):');
  if (ports.length === 0) console.log('  none');
  for (const p of ports) {
    const id = p.vid ? `${p.vid}:${p.pid}` : 'no USB id';
    const verdict = p.bridge ? `ESP32-class bridge, ${p.bridge.name}` : 'not an ESP32 bridge, will not be used';
    console.log(`  ${p.address.padEnd(8)} ${id.padEnd(10)} ${p.label.padEnd(24)} ${verdict}`);
  }

  if (usb.length > 0) {
    console.log('\nUSB devices Windows knows about (ESP32 bridge vendors):');
    for (const d of usb) {
      const warning = d.status && d.status !== 'OK' ? `   STATUS ${d.status}: a driver is probably missing` : '';
      console.log(`  ${d.vid}:${d.pid}  ${d.bridge}  "${d.name}"${warning}`);
    }
  }

  console.log(`\nESP32 candidates: ${boards.length}`);
  if (boards.length === 0) {
    console.log('  Plug the board in by its data cable (some cables only charge), then run this again.');
    console.log('  CH340 and CH9102 boards may need the WCH driver; CP210x needs the Silicon Labs driver.');
  }
  return 0;
}

/* ─── select ───────────────────────────────────────────────────────────────── */

/** @returns {Record<string, {id: string, typeCode: number}>} machine type name to catalog entry. */
export function machineChoices(catalog = loadCatalog()) {
  return Object.fromEntries(
    Object.entries(catalog.machines).map(([id, m]) => [m.machineType, { id, typeCode: m.typeCode }]),
  );
}

function selectedMachine(catalog = loadCatalog()) {
  const typeCode = parseMachineType(fs.readFileSync(MACHINE_SELECT, 'utf8'));
  const entry = Object.entries(machineChoices(catalog)).find(([, m]) => m.typeCode === typeCode);
  if (!entry) throw new Error(`machine_select.h names MACHINE_TYPE ${typeCode}, which the catalog does not define`);
  return { type: entry[0], ...entry[1] };
}

function cmdSelect(name) {
  const choices = machineChoices();
  if (!name || !choices[name]) {
    console.error(`Usage: fw select <${Object.keys(choices).join('|')}>`);
    return 2;
  }
  const next = withMachineType(fs.readFileSync(MACHINE_SELECT, 'utf8'), choices[name].typeCode);
  fs.writeFileSync(MACHINE_SELECT, next, 'utf8');
  console.log(`Selected ${name} (${choices[name].id}, MACHINE_TYPE ${choices[name].typeCode}).`);
  console.log('This edits machine_select.h, a tracked file, so `git status` will show it.');
  return 0;
}

/* ─── compile ──────────────────────────────────────────────────────────────── */

const BUILD_RECORD = () => path.join(BUILD_ROOT, 'last-build.json');

/** @returns {any|null} */
export function readBuildRecord() {
  try {
    return JSON.parse(fs.readFileSync(BUILD_RECORD(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Copy the sketch to a short path, filling in what is missing.
 *
 * @param {object} [options]
 * @param {boolean} [options.tls] - Only honoured when secrets.h is absent.
 * @param {string} [options.sketchDir] - Source sketch folder. Tests pass a copy.
 * @returns {{dir: string, compileCheckOnly: boolean, usedExampleSecrets: boolean, usedDummyCa: boolean}}
 */
export function stageSketch({ tls = true, sketchDir = SKETCH_DIR } = {}) {
  const stageRoot = path.join(BUILD_ROOT, 'stage');
  const dir = path.join(stageRoot, SKETCH_NAME);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  for (const file of fs.readdirSync(sketchDir)) {
    if (/\.(ino|h)$/.test(file)) fs.copyFileSync(path.join(sketchDir, file), path.join(dir, file));
  }

  const secretsPath = path.join(sketchDir, 'secrets.h');
  const haveSecrets = fs.existsSync(secretsPath);
  let usedExampleSecrets = false;
  if (!haveSecrets) {
    usedExampleSecrets = true;
    const example = fs.readFileSync(path.join(sketchDir, 'secrets.example.h'), 'utf8');
    fs.writeFileSync(path.join(dir, 'secrets.h'), example.replace(/#define CDO_TLS \d/, `#define CDO_TLS ${tls ? 1 : 0}`));
  }

  const needsCa = haveSecrets ? /#\s*define\s+CDO_TLS\s+1/.test(stripComments(fs.readFileSync(secretsPath, 'utf8'))) : tls;
  let usedDummyCa = false;
  if (needsCa && !fs.existsSync(path.join(sketchDir, 'root_ca.h'))) {
    usedDummyCa = true;
    fs.writeFileSync(
      path.join(dir, 'root_ca.h'),
      '#pragma once\nstatic const char CDO_ROOT_CA_PEM[] PROGMEM = "COMPILE CHECK ONLY";\n',
    );
  }

  return { dir, compileCheckOnly: usedExampleSecrets || usedDummyCa, usedExampleSecrets, usedDummyCa };
}

/**
 * Compile the sketch.
 *
 * @param {object} [options]
 * @param {string} [options.fqbn]
 * @param {boolean} [options.tls] - Compile-check only: TLS on or off when there is no secrets.h.
 * @param {boolean} [options.selftest] - Build the parity self-test instead of the gateway.
 * @param {boolean} [options.quiet]
 * @returns {Promise<{ok: boolean, record: any|null}>}
 */
export async function compile({ fqbn = DEFAULT_FQBN, tls = true, selftest = false, quiet = false } = {}) {
  const catalog = loadCatalog();
  const machine = selectedMachine(catalog);

  generate({ log: () => {} });

  const staged = stageSketch({ tls });
  const tag = `${chipOf(fqbn)}-${selftest ? 'selftest' : machine.type}`;
  const buildPath = path.join(BUILD_ROOT, 'build', tag);
  fs.mkdirSync(buildPath, { recursive: true });

  const say = quiet ? () => {} : (line) => console.log(line);
  say(`Compiling ${selftest ? 'the parity self-test' : `${machine.type} (${machine.id})`} for ${fqbn}`);
  if (!selftest && staged.compileCheckOnly) {
    const why = [staged.usedExampleSecrets && 'no secrets.h', staged.usedDummyCa && 'no root_ca.h'].filter(Boolean).join(' and ');
    say(`  ${why}: COMPILE CHECK ONLY. This build cannot be uploaded.`);
  }

  const args = [
    'compile',
    '--fqbn', fqbn,
    '--build-path', buildPath,
    '--warnings', 'all',
    ...(selftest ? ['--build-property', 'compiler.cpp.extra_flags=-DCDO_SELFTEST=1'] : []),
    staged.dir,
  ];
  const { code, output } = await runCli(args);
  const size = parseSketchSize(output);

  if (code !== 0) {
    console.error(output.split('\n').slice(-40).join('\n'));
    return { ok: false, record: null };
  }

  const ownWarnings = output.split('\n').filter((l) => /warning:/.test(l) && l.includes(SKETCH_NAME));
  if (ownWarnings.length > 0) {
    say(`  ${ownWarnings.length} warning(s) in the sketch:`);
    for (const line of ownWarnings.slice(0, 10)) say(`    ${line.trim()}`);
  }
  if (size) {
    say(`  Flash: ${size.bytes} of ${size.max} bytes (${size.percent}%)`);
    if (size.percent > FLASH_WARN_PERCENT) {
      say(`  Over ${FLASH_WARN_PERCENT}%: switch to a larger app partition, for example the min_spiffs scheme.`);
    }
  }

  const record = {
    machine: machine.type,
    machineId: machine.id,
    fqbn,
    selftest,
    compileCheckOnly: selftest ? false : staged.compileCheckOnly,
    sketchHash: sketchHash(),
    catalog: catalogId(catalog),
    builtAt: new Date().toISOString(),
    buildPath,
    flashPercent: size?.percent ?? null,
  };
  fs.writeFileSync(BUILD_RECORD(), `${JSON.stringify(record, null, 2)}\n`);
  say('  OK');
  return { ok: true, record };
}

/* ─── upload ───────────────────────────────────────────────────────────────── */

/**
 * Every reason an upload must be refused. Pure, so it is unit-tested.
 *
 * @param {object} input
 * @param {any|null} input.record - The last build record.
 * @param {string|undefined} input.confirmMachine
 * @param {boolean} input.confirmOverwrite
 * @param {string} input.currentHash
 * @param {string} input.currentMachine
 * @param {string|null} input.secretsText - null when there is no secrets.h.
 * @param {ReturnType<typeof parseBoardList>[number]|undefined} input.port
 * @param {string} input.requestedPort
 * @returns {string[]} Empty when the upload may proceed.
 */
export function uploadBlockers({ record, confirmMachine, confirmOverwrite, currentHash, currentMachine, secretsText, port, requestedPort }) {
  const problems = [];

  if (!record) return ['Nothing has been compiled yet. Run: fw compile'];

  if (record.compileCheckOnly) {
    problems.push('The last build was a COMPILE CHECK ONLY (no real secrets.h or root_ca.h). Fill them in and compile again.');
  }
  if (record.sketchHash !== currentHash) {
    problems.push('The sketch has changed since it was compiled. Compile again.');
  }

  if (record.selftest) {
    if (!confirmOverwrite) problems.push('This is the self-test build. Add --confirm-overwrite to replace whatever is on the board.');
  } else {
    if (!confirmMachine) problems.push(`Name the machine this board will be: --confirm-machine ${record.machine}`);
    else if (confirmMachine !== record.machine) {
      problems.push(`--confirm-machine ${confirmMachine} does not match the compiled build, which is ${record.machine}.`);
    }
    if (record.machine !== currentMachine) {
      problems.push(`machine_select.h now says ${currentMachine}, but the compiled build is ${record.machine}. Compile again.`);
    }
    if (secretsText === null) problems.push('There is no secrets.h. Copy secrets.example.h and fill it in.');
    else {
      const left = findPlaceholders(secretsText);
      if (left.length > 0) problems.push(`secrets.h still has placeholder values: ${left.join(', ')}`);
    }
  }

  if (!port) problems.push(`Port ${requestedPort} is not present. Run: fw ports`);
  else if (!port.bridge) {
    const id = port.vid ? `${port.vid}:${port.pid}` : 'no USB id';
    problems.push(`Port ${requestedPort} (${id}) is not an ESP32 USB bridge, so it will not be flashed.`);
  }

  return problems;
}

async function cmdUpload({ port, confirmMachine, confirmOverwrite }) {
  if (!port) {
    console.error('Usage: fw upload --port <COMx> --confirm-machine <robot|press>');
    return 2;
  }

  const record = readBuildRecord();
  const ports = await listPorts();
  const match = ports.find((p) => p.address.toLowerCase() === port.toLowerCase());

  const problems = uploadBlockers({
    record,
    confirmMachine,
    confirmOverwrite,
    currentHash: sketchHash(),
    currentMachine: selectedMachine().type,
    secretsText: fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : null,
    port: match,
    requestedPort: port,
  });
  if (problems.length > 0) {
    console.error('Upload refused:');
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  console.log(`Uploading ${record.selftest ? 'the parity self-test' : record.machineId} to ${match.address}`);
  console.log(`  USB ${match.vid}:${match.pid}, ${match.bridge.name}`);
  console.log('  Close any serial monitor first: it holds the port.');

  const stagedSketch = path.join(BUILD_ROOT, 'stage', SKETCH_NAME);
  const { code } = await runCli(
    ['upload', '--fqbn', record.fqbn, '--port', match.address, '--input-dir', record.buildPath, stagedSketch],
    { onOutput: (chunk) => process.stdout.write(chunk) },
  );
  if (code !== 0) {
    console.error('\nUpload failed. If it cannot connect, hold the BOOT button while it says "Connecting", or retry at a lower speed.');
    return 1;
  }
  console.log('\nUploaded. Watch it start with: fw monitor --port ' + match.address);
  return 0;
}

/* ─── monitor ──────────────────────────────────────────────────────────────── */

/**
 * Read a serial port for a while, teeing it to a log file under firmware/.logs.
 *
 * `arduino-cli monitor` exits when its stdin closes, so stdin is held open. It
 * also has no log flag, hence the tee. The log is what Claude reads.
 *
 * @param {object} options
 * @param {string} options.port
 * @param {number} [options.seconds]
 * @param {(text: string) => boolean} [options.until] - Stop early when this returns true for the text so far.
 * @param {boolean} [options.echo]
 * @returns {Promise<{logPath: string, text: string}>}
 */
export async function monitor({ port, seconds = 30, until, echo = true, attempts = 4 }) {
  const cli = requireCli();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const logPath = path.join(LOGS_DIR, `${stamp}-${port.replace(/[^A-Za-z0-9]/g, '')}.log`);
  const log = fs.createWriteStream(logPath);

  let text = '';
  const deadline = Date.now() + seconds * 1000;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const child = spawn(cli, ['--no-color', 'monitor', '--port', port, '--config', `baudrate=${BAUD}`], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      child.kill();
    };
    const take = (chunk) => {
      const piece = chunk.toString('utf8').replace(ANSI, '');
      text += piece;
      log.write(piece);
      if (echo) process.stdout.write(piece);
      if (until?.(text)) stop();
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);

    const startedAt = Date.now();
    const timer = setTimeout(stop, Math.max(0, deadline - Date.now()));
    const code = await new Promise((resolve) => child.on('close', resolve));
    clearTimeout(timer);

    // A monitor that dies within a few seconds never got the port, typically
    // because the board is still re-enumerating after an upload. Try again.
    const diedEarly = !stopped && code !== 0 && Date.now() - startedAt < 4000;
    if (!diedEarly || attempt === attempts || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  await new Promise((resolve) => log.end(resolve));
  return { logPath, text };
}

async function cmdMonitor({ port, seconds }) {
  if (!port) {
    console.error('Usage: fw monitor --port <COMx> [--seconds 30]');
    return 2;
  }
  const { logPath } = await monitor({ port, seconds });
  console.log(`\nLog saved to ${path.relative(ROOT, logPath)}`);
  return 0;
}

/* ─── self-test ────────────────────────────────────────────────────────────── */

async function cmdSelftest({ port, confirmOverwrite, fqbn }) {
  if (!port) {
    console.error('Usage: fw selftest --port <COMx> --confirm-overwrite');
    return 2;
  }

  const built = await compile({ fqbn, selftest: true });
  if (!built.ok) return 1;

  const code = await cmdUpload({ port, confirmMachine: undefined, confirmOverwrite });
  if (code !== 0) return code;

  console.log('\nReading the self-test output (it repeats every 10 s)...');
  const catalog = loadCatalog();
  const { text } = await monitor({
    port,
    seconds: 60,
    echo: false,
    until: (t) => parseSerial(t).complete,
  });

  const verdict = judge(text, catalog, catalogId(catalog));
  console.log(`\n${verdict.ok ? 'PASS' : 'FAIL'}: ${verdict.message}`);
  for (const line of verdict.details) console.log(`  ${line}`);
  console.log('\nThe board is still running the self-test. Compile and upload the real firmware to put it back.');
  return verdict.ok ? 0 : 1;
}

/* ─── doctor, log ──────────────────────────────────────────────────────────── */

async function cmdDoctor() {
  let bad = 0;
  const line = (ok, label, detail = '') => {
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
  };

  const cli = findArduinoCli();
  line(Boolean(cli), 'arduino-cli', cli ?? 'not found');
  if (cli) {
    const cores = JSON.parse((await runCli(['core', 'list', '--format', 'json'])).output || '{}');
    const list = cores.platforms ?? cores;
    const esp = (Array.isArray(list) ? list : []).find((p) => p.id === 'esp32:esp32');
    line(Boolean(esp), 'ESP32 core', esp ? `esp32:esp32 ${esp.installed_version ?? esp.installed}` : 'not installed: arduino-cli core install esp32:esp32');

    const libs = JSON.parse((await runCli(['lib', 'list', '--format', 'json'])).output || '{}');
    const names = new Set((libs.installed_libraries ?? []).map((l) => l.library?.name));
    for (const name of ['PubSubClient', 'ArduinoJson']) line(names.has(name), `library ${name}`);
  }

  line(generate({ check: true, log: () => {} }).current, 'catalog.h is current');

  const secrets = fs.existsSync(SECRETS) ? fs.readFileSync(SECRETS, 'utf8') : null;
  line(secrets !== null, 'secrets.h exists', secrets === null ? 'copy secrets.example.h to secrets.h' : '');
  if (secrets !== null) {
    const left = findPlaceholders(secrets);
    line(left.length === 0, 'secrets.h has no placeholders', left.join(', '));
  }
  const tlsOn = secrets === null || /#\s*define\s+CDO_TLS\s+1/.test(stripComments(secrets));
  if (tlsOn) line(fs.existsSync(ROOT_CA), 'root_ca.h exists (TLS)', fs.existsSync(ROOT_CA) ? '' : 'put the CA bundle in firmware/certs/root_ca.pem, then: fw gen');

  const selected = selectedMachine();
  console.log(`\nSelected machine: ${selected.type} (${selected.id})`);
  const record = readBuildRecord();
  console.log(record ? `Last build: ${record.selftest ? 'self-test' : record.machine}, ${record.compileCheckOnly ? 'compile check only' : 'uploadable'}, ${record.builtAt}` : 'No build yet.');
  return bad === 0 ? 0 : 1;
}

function cmdLog({ lines }) {
  if (!fs.existsSync(LOGS_DIR)) {
    console.log('No monitor logs yet.');
    return 0;
  }
  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.endsWith('.log')).sort();
  if (files.length === 0) {
    console.log('No monitor logs yet.');
    return 0;
  }
  const latest = path.join(LOGS_DIR, files[files.length - 1]);
  console.log(`# ${path.relative(ROOT, latest)}`);
  console.log(fs.readFileSync(latest, 'utf8').split(/\r?\n/).slice(-lines).join('\n'));
  return 0;
}

/* ─── Entry point ──────────────────────────────────────────────────────────── */

const USAGE = `Usage: node scripts/fw.mjs <command> [options]

  doctor                      Check the toolchain, catalog, secrets and certificates.
  ports [--json]              List serial ports and USB devices. Flags ESP32 bridges.
  select <robot|press>        Choose which machine the sketch plays (edits machine_select.h).
  gen                         Regenerate catalog.h (and root_ca.h if a PEM exists).
  compile [--fqbn F] [--tls 0|1]
                              Compile. Needs no secrets.h (then it is a compile check only).
  upload --port P --confirm-machine <robot|press>
                              Upload the last build. Refuses a wrong, stale or unsafe upload.
  monitor --port P [--seconds N]
                              Read the serial port and save it under firmware/.logs/.
  selftest --port P --confirm-overwrite
                              Flash the parity self-test, read it, compare with the JS models.
  log [--lines N]             Show the end of the newest monitor log.

The default board is ${DEFAULT_FQBN} (ESP32 Dev Module).
Nothing here picks a port for you. Identify your board with \`ports\` first.`;

async function main(argv) {
  const [command, ...rest] = argv;

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      fqbn: { type: 'string', default: DEFAULT_FQBN },
      tls: { type: 'string', default: '1' },
      seconds: { type: 'string', default: '30' },
      lines: { type: 'string', default: '60' },
      'confirm-machine': { type: 'string' },
      'confirm-overwrite': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  switch (command) {
    case 'doctor': return cmdDoctor();
    case 'ports': return cmdPorts({ json: values.json });
    case 'select': return cmdSelect(positionals[0]);
    case 'gen': generate(); return 0;
    case 'compile': return (await compile({ fqbn: values.fqbn, tls: values.tls !== '0' })).ok ? 0 : 1;
    case 'upload':
      return cmdUpload({ port: values.port, confirmMachine: values['confirm-machine'], confirmOverwrite: values['confirm-overwrite'] });
    case 'monitor': return cmdMonitor({ port: values.port, seconds: Number(values.seconds) });
    case 'selftest': return cmdSelftest({ port: values.port, confirmOverwrite: values['confirm-overwrite'], fqbn: values.fqbn });
    case 'log': return cmdLog({ lines: Number(values.lines) });
    default:
      console.log(USAGE);
      return command && command !== 'help' && command !== '--help' ? 2 : 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
