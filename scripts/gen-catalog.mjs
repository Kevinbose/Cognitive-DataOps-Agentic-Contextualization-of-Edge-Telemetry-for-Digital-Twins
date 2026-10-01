#!/usr/bin/env node
/**
 * @file Generate the firmware's catalog header (and root CA header) from the
 * single source of truth, `firmware/catalog.json`.
 *
 *   node scripts/gen-catalog.mjs          write the headers
 *   node scripts/gen-catalog.mjs --check  exit 1 if catalog.h is stale
 *
 * ## Outputs
 *
 * `firmware/cdo-edge-gateway/catalog.h` (committed). For each machine: its id,
 * cadence, channel table (key, clamp range, decimals), scenario names, spectrum
 * layout, and the BIRTH MESSAGE as a printf template. The template is rendered
 * here with `buildBirth`, the same function the software simulator publishes
 * with, so the two cannot drift: a backend test expands the template and
 * deep-compares it with `buildBirth`.
 *
 * `firmware/cdo-edge-gateway/root_ca.h` (gitignored), only when
 * `firmware/certs/root_ca.pem` exists. It holds the CA bundle the board uses to
 * verify the broker's TLS certificate. Every certificate is parsed and its
 * validity checked here, so a bad bundle fails on the laptop instead of as a
 * mysterious handshake error on a headless board.
 *
 * `arduino-cli` compiles a COPY of the sketch folder, so the sketch cannot
 * include `../certs/*.pem`. Generating the header into the sketch folder is what
 * makes the PEM reachable.
 *
 * @module scripts/gen-catalog
 */

import { X509Certificate, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildBirth, loadCatalog } from '../server/scripts/lib/gateway.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKETCH_DIR = path.join(ROOT, 'firmware', 'cdo-edge-gateway');
export const CATALOG_HEADER = path.join(SKETCH_DIR, 'catalog.h');
export const ROOT_CA_HEADER = path.join(SKETCH_DIR, 'root_ca.h');
export const ROOT_CA_PEM = path.join(ROOT, 'firmware', 'certs', 'root_ca.pem');

/** Stand-ins for the three values only the board knows. Never sent on the wire. */
const MARKER = Object.freeze({ fw: '@@CDO_FW@@', mac: '@@CDO_MAC@@', bootId: '@@CDO_BOOT@@' });

/** Extra room the three `%s` fields can add to the rendered birth, in bytes. */
const BIRTH_SLACK = 24 + 17 + 16;

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * @param {string} text
 * @param {string} what - For the error message.
 * @returns {void}
 */
function assertPrintableAscii(text, what) {
  if (!/^[\x20-\x7e]*$/.test(text)) {
    throw new Error(`${what} must be printable ASCII to be embedded in firmware`);
  }
}

/**
 * A C `double` literal. Whole numbers get a `.0` so they are not `int`.
 *
 * @param {number} n
 * @returns {string}
 */
export function cDouble(n) {
  if (!Number.isFinite(n)) throw new Error(`Not a finite number: ${n}`);
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

/**
 * A C string literal, split across lines. Each chunk is escaped on its own, and
 * adjacent literals are concatenated by the compiler, so a split never lands
 * inside an escape sequence. Splits prefer to follow a comma, which keeps the
 * JSON readable in the generated header.
 *
 * @param {string} text - Printable ASCII.
 * @param {string} indent
 * @param {number} [width] - Longest chunk, in raw characters.
 * @returns {string}
 */
export function cString(text, indent = '    ', width = 88) {
  assertPrintableAscii(text, 'String');
  if (text.length === 0) return '""';

  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + width, text.length);
    if (end < text.length) {
      const comma = text.lastIndexOf(',', end - 1);
      if (comma >= start + width / 2) end = comma + 1;
    }
    parts.push(JSON.stringify(text.slice(start, end)));
    start = end;
  }
  return parts.join(`\n${indent}`);
}

/**
 * The birth message for one machine, as a `printf` template with exactly three
 * `%s` conversions: firmware version, MAC, boot id, in that order. Any other
 * `%` in the JSON is escaped.
 *
 * @param {string} machineId
 * @param {any} machine - The machine's catalog entry.
 * @returns {string}
 */
export function renderBirthTemplate(machineId, machine) {
  const json = JSON.stringify(buildBirth(machineId, machine, MARKER));
  assertPrintableAscii(json, `Birth message of ${machineId}`);

  const order = [MARKER.fw, MARKER.mac, MARKER.bootId].map((m) => json.indexOf(m));
  if (order.some((i) => i < 0) || order[0] > order[1] || order[1] > order[2]) {
    throw new Error('buildBirth must emit fw, mac and bootId, in that order');
  }

  return json
    .replaceAll('%', '%%')
    .replace(MARKER.fw, '%s')
    .replace(MARKER.mac, '%s')
    .replace(MARKER.bootId, '%s');
}

/**
 * Expand a birth template the way the firmware's `snprintf` does. Used by tests.
 *
 * @param {string} template
 * @param {{fw: string, mac: string, bootId: string}} values
 * @returns {string}
 */
export function expandBirthTemplate(template, { fw, mac, bootId }) {
  const args = [fw, mac, bootId];
  return template.replace(/%([%s])/g, (_, kind) => (kind === '%' ? '%' : args.shift()));
}

/**
 * Upper-case macro prefix for a machine: `robot` becomes `ROBOT`.
 *
 * @param {any} machine
 * @returns {string}
 */
const prefixOf = (machine) => machine.machineType.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/* ─── catalog.h ────────────────────────────────────────────────────────────── */

/**
 * Stable identity of the catalog's CONTENT (independent of line endings), shown
 * in the serial banner so a board's build can be matched to a catalog.
 *
 * @param {any} catalog
 * @returns {string} Ten hex characters.
 */
export function catalogId(catalog) {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex').slice(0, 10);
}

/**
 * Validate the self-test plan, so a typo fails here and not as a confusing
 * mismatch on the chip.
 *
 * @param {any} catalog
 * @returns {{seed: number, ramps: number[], times: Record<string, number[]>}}
 */
export function checkSelftestPlan(catalog) {
  const plan = catalog.selftest;
  if (!plan) throw new Error('catalog.json has no "selftest" section');
  const isTimes = (a) => Array.isArray(a) && a.length > 0 && a.every((n) => Number.isFinite(n) && n >= 0);

  if (!Number.isInteger(plan.seed) || plan.seed < 0 || plan.seed > 0xffffffff) {
    throw new Error('selftest.seed must be an integer from 0 to 4294967295');
  }
  if (!Array.isArray(plan.ramps) || plan.ramps.length === 0 || !plan.ramps.every((r) => r >= 0 && r <= 1)) {
    throw new Error('selftest.ramps must be a non-empty list of numbers from 0 to 1');
  }
  for (const machine of Object.values(catalog.machines)) {
    if (!isTimes(plan.times?.[machine.machineType])) {
      throw new Error(`selftest.times.${machine.machineType} must be a non-empty list of times in seconds`);
    }
  }
  return plan;
}

/**
 * @param {string} machineId
 * @param {any} machine
 * @returns {string[]} Lines of C.
 */
function renderMachine(machineId, machine, selftestTimes) {
  machine = { ...machine, selftestTimes };
  const P = `CDO_${prefixOf(machine)}`;
  const template = renderBirthTemplate(machineId, machine);
  const lines = [];

  lines.push(`/* --- ${machineId} (MACHINE_TYPE ${machine.typeCode}) ${'-'.repeat(Math.max(3, 60 - machineId.length))} */`);
  lines.push('');
  lines.push(`#define ${P}_TYPE_CODE ${machine.typeCode}`);
  lines.push(`#define ${P}_MACHINE_ID ${JSON.stringify(machineId)}`);
  lines.push(`#define ${P}_INTERVAL_MS ${machine.intervalMs}`);
  lines.push(`#define ${P}_CYCLE_SEC ${cDouble(machine.sim.cycleSec)}`);
  lines.push('');

  lines.push(`#define ${P}_CHANNEL_COUNT ${machine.channels.length}`);
  lines.push(`static constexpr CdoChannel ${P}_CHANNELS[${P}_CHANNEL_COUNT] = {`);
  for (const c of machine.channels) {
    lines.push(`  {${JSON.stringify(c.key)}, ${cDouble(c.min)}, ${cDouble(c.max)}, ${c.decimals}},`);
  }
  lines.push('};');
  lines.push('');

  assertPrintableAscii(machine.scenarios.join(','), 'Scenario names');
  lines.push(`#define ${P}_SCENARIO_COUNT ${machine.scenarios.length}`);
  lines.push(`static constexpr const char* ${P}_SCENARIOS[${P}_SCENARIO_COUNT] = {`);
  for (const s of machine.scenarios) lines.push(`  ${JSON.stringify(s)},`);
  lines.push('};');
  lines.push('');

  if (machine.spectrum) {
    const s = machine.spectrum;
    lines.push(`#define ${P}_HAS_SPECTRUM 1`);
    lines.push(`#define ${P}_SPECTRUM_KEY ${JSON.stringify(s.key)}`);
    lines.push(`#define ${P}_SPECTRUM_START_HZ ${cDouble(s.startHz)}`);
    lines.push(`#define ${P}_SPECTRUM_STEP_HZ ${cDouble(s.stepHz)}`);
    lines.push(`#define ${P}_SPECTRUM_COUNT ${s.count}`);
    lines.push(`#define ${P}_SPECTRUM_INTERVAL_MS ${s.intervalMs}`);
    lines.push(`#define ${P}_SHAFT_HZ ${cDouble(s.fundamentalHz ?? 0)}`);
  } else {
    lines.push(`#define ${P}_HAS_SPECTRUM 0`);
    lines.push(`#define ${P}_SPECTRUM_KEY ""`);
    lines.push(`#define ${P}_SPECTRUM_START_HZ 0.0`);
    lines.push(`#define ${P}_SPECTRUM_STEP_HZ 1.0`);
    lines.push(`#define ${P}_SPECTRUM_COUNT 0`);
    lines.push(`#define ${P}_SPECTRUM_INTERVAL_MS 0`);
    lines.push(`#define ${P}_SHAFT_HZ 0.0`);
  }
  lines.push('');

  const times = machine.selftestTimes ?? [];
  lines.push(`#define ${P}_SELFTEST_TIME_COUNT ${times.length}`);
  lines.push(
    `static constexpr double ${P}_SELFTEST_TIMES[${Math.max(1, times.length)}] = {${times.length ? times.map(cDouble).join(', ') : '0.0'}};`,
  );
  lines.push('');

  lines.push('/* Birth message as a printf template: firmware version, MAC, boot id (all %s). */');
  lines.push(`static const char ${P}_BIRTH_FMT[] =`);
  lines.push(`    ${cString(template)};`);
  lines.push(`#define ${P}_BIRTH_MAX (sizeof(${P}_BIRTH_FMT) + ${BIRTH_SLACK})`);
  lines.push('');
  return lines;
}

/**
 * Render `catalog.h`.
 *
 * @param {{machines: Record<string, any>, contractVersion: number, defaultSiteId: string}} catalog
 * @returns {string}
 */
export function renderCatalogHeader(catalog) {
  const plan = checkSelftestPlan(catalog);
  const out = [
    '/*',
    ' * GENERATED FILE. Do not edit.',
    ' *',
    ' * Source:    firmware/catalog.json',
    ' * Generator: node scripts/gen-catalog.mjs',
    ` * Catalog:   ${catalogId(catalog)}`,
    ' *',
    ' * A backend test checks that this file is what the generator produces, and',
    ' * that each birth template expands to the message the software simulator',
    ' * publishes, so the firmware and the simulator cannot disagree about a channel.',
    ' */',
    '#pragma once',
    '',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '',
    `#define CDO_CONTRACT_VERSION ${catalog.contractVersion}`,
    `#define CDO_DEFAULT_SITE_ID ${JSON.stringify(catalog.defaultSiteId)}`,
    `#define CDO_CATALOG_ID ${JSON.stringify(catalogId(catalog))}`,
    '',
    '/* Fixed-seed parity plan for the on-chip self-test (catalog.json, "selftest"). */',
    `#define CDO_SELFTEST_SEED ${plan.seed}u`,
    `#define CDO_SELFTEST_RAMP_COUNT ${plan.ramps.length}`,
    `static constexpr double CDO_SELFTEST_RAMPS[CDO_SELFTEST_RAMP_COUNT] = {${plan.ramps.map(cDouble).join(', ')}};`,
    '',
    '/* One scalar channel. lo and hi are the clamp range; decimals is the print precision. */',
    'struct CdoChannel {',
    '  const char* key;',
    '  double lo;',
    '  double hi;',
    '  uint8_t decimals;',
    '};',
    '',
  ];

  for (const [machineId, machine] of Object.entries(catalog.machines)) {
    out.push(...renderMachine(machineId, machine, plan.times[machine.machineType] ?? []));
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/* ─── root_ca.h ────────────────────────────────────────────────────────────── */

/**
 * Split a PEM bundle into its certificates and check each one.
 *
 * @param {string} pem
 * @param {Date} [now]
 * @returns {Array<{pem: string, subject: string, notAfter: Date}>}
 * @throws {Error} When the bundle is empty, malformed, or holds an expired certificate.
 */
export function parsePemBundle(pem, now = new Date()) {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks) throw new Error('No "BEGIN CERTIFICATE" block found in the PEM file');

  return blocks.map((block, i) => {
    let cert;
    try {
      cert = new X509Certificate(block);
    } catch (error) {
      throw new Error(`Certificate ${i + 1} in the bundle cannot be parsed: ${error.message}`);
    }
    const notAfter = new Date(cert.validTo);
    if (notAfter < now) {
      throw new Error(`Certificate ${i + 1} (${cert.subject.replace(/\n/g, ', ')}) expired on ${cert.validTo}`);
    }
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return { pem: `${lines.join('\n')}\n`, subject: cert.subject.replace(/\n/g, ', '), notAfter };
  });
}

/**
 * @param {Array<{pem: string}>} certs
 * @returns {string}
 */
export function renderRootCaHeader(certs) {
  const body = certs
    .flatMap(({ pem }) => pem.split('\n').filter(Boolean).map((line) => `    ${JSON.stringify(`${line}\n`)}`))
    .join('\n');
  return [
    '/*',
    ' * GENERATED FILE. Do not edit, and do not commit (it is gitignored).',
    ' *',
    ' * Source:    firmware/certs/root_ca.pem',
    ' * Generator: node scripts/gen-catalog.mjs',
    ' */',
    '#pragma once',
    '',
    'static const char CDO_ROOT_CA_PEM[] PROGMEM =',
    `${body};`,
    '',
  ].join('\n');
}

/* ─── Entry point ──────────────────────────────────────────────────────────── */

/** @param {string} text */
const normalise = (text) => text.replace(/\r\n/g, '\n');

/**
 * @param {object} [options]
 * @param {boolean} [options.check] - Do not write; report whether catalog.h is current.
 * @param {(line: string) => void} [options.log]
 * @returns {{current: boolean, rootCa: 'written'|'absent'|'skipped'}}
 */
export function generate({ check = false, log = console.log } = {}) {
  const catalog = loadCatalog();
  const wanted = renderCatalogHeader(catalog);

  const existing = fs.existsSync(CATALOG_HEADER) ? normalise(fs.readFileSync(CATALOG_HEADER, 'utf8')) : null;
  const current = existing === wanted;

  if (check) {
    log(current ? 'catalog.h is current.' : 'catalog.h is stale. Run: node scripts/gen-catalog.mjs');
    return { current, rootCa: 'skipped' };
  }

  if (current) {
    log('catalog.h is already current.');
  } else {
    fs.writeFileSync(CATALOG_HEADER, wanted, 'utf8');
    log(`Wrote ${path.relative(ROOT, CATALOG_HEADER)} (catalog ${catalogId(catalog)}).`);
  }

  if (!fs.existsSync(ROOT_CA_PEM)) {
    log(`No ${path.relative(ROOT, ROOT_CA_PEM)}, so root_ca.h was not generated. TLS builds need it (see firmware/README.md).`);
    return { current: true, rootCa: 'absent' };
  }

  const certs = parsePemBundle(fs.readFileSync(ROOT_CA_PEM, 'utf8'));
  fs.writeFileSync(ROOT_CA_HEADER, renderRootCaHeader(certs), 'utf8');
  log(`Wrote ${path.relative(ROOT, ROOT_CA_HEADER)} with ${certs.length} certificate(s):`);
  for (const c of certs) log(`  ${c.subject}  (valid until ${c.notAfter.toISOString().slice(0, 10)})`);
  return { current: true, rootCa: 'written' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { current } = generate({ check: process.argv.includes('--check') });
    if (process.argv.includes('--check') && !current) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
