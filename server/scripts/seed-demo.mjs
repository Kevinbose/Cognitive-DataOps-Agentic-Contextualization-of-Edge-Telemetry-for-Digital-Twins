#!/usr/bin/env node
/**
 * @file Prepare the dev database for the demo.
 *
 * Three jobs, all on the car factory asset and all optional:
 *
 * 1. **Rename** "Car Factory — Assembly Hall" to "Car Factory, Assembly Hall",
 *    so no em dash shows up in the registry. The machine shop asset is never
 *    touched.
 * 2. **Replay** the six demo bindings (`--bindings`) from
 *    `docs/demo-bindings.json`, so a database reset costs one command instead
 *    of six rounds of clicking. Off by default, so binding can still be shown
 *    live.
 * 3. **Capture** (`--capture`) the car factory's current bindings into that
 *    same file. glTF names are long, slash-laden strings; copying them by hand
 *    is how typos get in.
 *
 * Nothing is written without `--apply`; the default is a dry run. The script
 * refuses to run against any database other than `cognitive_dataops` or a
 * `cdo_test_*` one, because the local MongoDB also holds unrelated projects.
 *
 * Bindings go through `bindSensorToMeshName`, the same function the UI calls,
 * so every invariant (one sensor per mesh, one mesh per sensor, the status
 * ratchet, `isMapped`) holds. A sensor that is already bound to a different
 * mesh is reported and skipped, never moved: stealing a sensor is a decision
 * for a person in the UI.
 *
 * @module scripts/seed-demo
 */

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import mongoose from 'mongoose';
import { z } from 'zod';

import { connectDatabase, disconnectDatabase } from '../src/config/db.config.js';
import { Asset } from '../src/models/Asset.model.js';
import { Device } from '../src/models/Device.model.js';
import { MESH_OBJECT_TYPES } from '../src/models/MeshNode.model.js';
import { SENSOR_TYPES, SensorBinding } from '../src/models/SensorBinding.model.js';
import * as assetService from '../src/services/asset.service.js';
import { bindSensorToMeshName } from '../src/services/sensorBinding.service.js';
import { ApiError } from '../src/utils/ApiError.js';
import { loadCatalog } from './lib/gateway.mjs';

/** The name the car factory asset carries once seeded. */
export const SEEDED_ASSET_NAME = 'Car Factory, Assembly Hall';

/** Finds the car factory asset under either its old or its seeded name. */
const CAR_FACTORY_NAME = /^car factory\b/i;

/** `who` shown as "Bound by" in the inspector for replayed bindings. */
const BOUND_BY = 'seed-demo';

export const DEFAULT_BINDINGS_PATH = fileURLToPath(
  new URL('../../docs/demo-bindings.json', import.meta.url),
);

/** Databases this script may touch. Anything else is refused. */
const ALLOWED_DATABASE = /^(cognitive_dataops|cdo_test_[a-z0-9]+)$/;

/**
 * Honest labels for the mesh an operator picks, by convention. The meshes are
 * placeholders until a purpose-built car factory model exists, so the label,
 * not the geometry, says what the part stands for.
 */
const DISPLAY_NAMES = Object.freeze({
  'robot-weld-01': {
    AXIS_4_SERVO_TORQUE: 'Robot forearm (axis 4)',
    TOOL_CENTER_POINT_DEVIATION: 'Robot wrist and tool flange',
    WELD_GUN_TEMP: 'Spot weld gun',
  },
  'press-stamp-01': {
    MAIN_MOTOR_CURRENT: 'Main drive motor',
    LUBE_OIL_PRESSURE: 'Lubrication unit',
    BEARING_VIBRATION_RMS: 'Main bearing housing',
  },
});

const COMMENT =
  'Demo bindings for the car factory asset. meshName is the glTF node name exactly as it appears in the .glb, or null while the channel is not assigned. Fill it by hand, or make the bindings in the viewer and run `npm run seed:demo --workspace server -- --capture`. Replay with `--apply --bindings`.';

/* ─── Safety ───────────────────────────────────────────────────────────────── */

/**
 * Throw unless `name` is a database this script may touch.
 *
 * @param {string|undefined} name - The connected database's name.
 * @returns {void}
 */
export function assertAllowedDatabase(name) {
  if (!name || !ALLOWED_DATABASE.test(name)) {
    throw new Error(
      `Refusing to run against database "${name}". ` +
        'This script only touches "cognitive_dataops" and "cdo_test_*" databases.',
    );
  }
}

/* ─── The binding file ─────────────────────────────────────────────────────── */

/**
 * One demo binding, as stored in the file.
 *
 * @typedef {object} BindingRow
 * @property {string} sensorId - `MACHINE-ID.CHANNEL_KEY`, upper case.
 * @property {string} sensorType
 * @property {string} displayName - Label for the mesh node.
 * @property {string} objectType - `Mesh` or `Group`.
 * @property {string|null} meshName - glTF node name, or `null` while unassigned.
 */

/**
 * The six rows the demo needs, in catalog order, with no mesh assigned.
 * Derived from the catalog so a catalog edit cannot leave this list behind.
 *
 * @param {{machines: Record<string, any>}} catalog
 * @returns {BindingRow[]}
 */
export function defaultBindingRows(catalog) {
  /** @type {BindingRow[]} */
  const rows = [];
  for (const [machineId, machine] of Object.entries(catalog.machines)) {
    for (const channel of machine.channels) {
      rows.push({
        sensorId: `${machineId}.${channel.key}`.toUpperCase(),
        sensorType: channel.sensorType,
        displayName: DISPLAY_NAMES[machineId]?.[channel.key] ?? channel.label,
        objectType: 'Mesh',
        meshName: null,
      });
    }
  }
  return rows;
}

const rowSchema = z
  .object({
    sensorId: z.string().trim().min(1),
    sensorType: z.enum(/** @type {[string, ...string[]]} */ (SENSOR_TYPES)),
    displayName: z.string().trim().min(1).max(200),
    objectType: z.enum(/** @type {[string, ...string[]]} */ (MESH_OBJECT_TYPES)).default('Mesh'),
    meshName: z.string().trim().min(1).max(512).nullable(),
  })
  .strict();

const fileSchema = z
  .object({
    $comment: z.string().optional(),
    assetName: z.string().optional(),
    bindings: z.array(rowSchema).max(32),
  })
  .strict();

/**
 * Parse and check a bindings file.
 *
 * Beyond the shape, it enforces the two cardinality rules up front, so a bad
 * file fails before anything is written: every sensor is a real catalog
 * channel, and no sensor or mesh appears twice.
 *
 * @param {unknown} json - Parsed file contents.
 * @param {{machines: Record<string, any>}} catalog
 * @returns {BindingRow[]}
 * @throws {Error} With every problem listed, not just the first.
 */
export function parseBindingFile(json, catalog) {
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new Error(`Invalid bindings file:\n  ${problems.join('\n  ')}`);
  }

  const known = new Set(defaultBindingRows(catalog).map((r) => r.sensorId));
  const problems = [];
  const sensors = new Set();
  const meshes = new Set();

  parsed.data.bindings.forEach((row, i) => {
    const sensorId = row.sensorId.toUpperCase();
    if (!known.has(sensorId)) problems.push(`bindings.${i}: "${row.sensorId}" is not a catalog channel`);
    if (sensors.has(sensorId)) problems.push(`bindings.${i}: "${sensorId}" appears twice`);
    sensors.add(sensorId);
    if (row.meshName) {
      if (meshes.has(row.meshName)) problems.push(`bindings.${i}: mesh "${row.meshName}" is used twice`);
      meshes.add(row.meshName);
    }
  });

  if (problems.length > 0) throw new Error(`Invalid bindings file:\n  ${problems.join('\n  ')}`);

  return parsed.data.bindings.map((row) => ({ ...row, sensorId: row.sensorId.toUpperCase() }));
}

/**
 * @param {string} filePath
 * @param {{machines: Record<string, any>}} catalog
 * @returns {BindingRow[]}
 */
function readBindingFile(filePath, catalog) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error.message}`);
  }
  return parseBindingFile(json, catalog);
}

/* ─── Steps ────────────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<import('mongoose').Document>}
 * @throws {Error} When there is not exactly one car factory asset.
 */
async function findCarFactory() {
  const matches = await Asset.findActive({ name: CAR_FACTORY_NAME });
  if (matches.length === 0) {
    throw new Error('No live asset whose name starts with "Car Factory" was found.');
  }
  if (matches.length > 1) {
    const names = matches.map((a) => `"${a.name}" (${a.id})`).join(', ');
    throw new Error(`More than one asset matches "Car Factory": ${names}. Rename or remove the extras first.`);
  }
  return matches[0];
}

/** The rename step. */
async function renameStep(asset, apply, log) {
  if (asset.name === SEEDED_ASSET_NAME) {
    log(`rename   already named "${SEEDED_ASSET_NAME}"`);
    return false;
  }
  if (!apply) {
    log(`rename   would rename "${asset.name}" to "${SEEDED_ASSET_NAME}"`);
    return false;
  }
  await assetService.updateAsset(asset.id, { name: SEEDED_ASSET_NAME });
  log(`rename   renamed "${asset.name}" to "${SEEDED_ASSET_NAME}"`);
  return true;
}

/** The replay step. */
async function replayStep(asset, rows, apply, log) {
  const summary = { bound: [], unchanged: [], skipped: [], failed: [] };

  for (const row of rows) {
    if (!row.meshName) {
      summary.skipped.push(row.sensorId);
      log(`bind     skip   ${row.sensorId}: no mesh recorded`);
      continue;
    }
    if (!apply) {
      log(`bind     would bind ${row.sensorId} to ${row.meshName} as "${row.displayName}"`);
      continue;
    }

    try {
      const result = await bindSensorToMeshName({
        assetId: asset.id,
        meshName: row.meshName,
        sensorId: row.sensorId,
        sensorType: row.sensorType,
        displayName: row.displayName,
        objectType: row.objectType,
        boundBy: BOUND_BY,
      });
      if (result.unchanged) {
        summary.unchanged.push(row.sensorId);
        log(`bind     same   ${row.sensorId} is already bound to ${row.meshName}`);
      } else {
        summary.bound.push(row.sensorId);
        const note = result.replacedPreviousBinding ? ' (replaced the sensor that was on this mesh)' : '';
        log(`bind     done   ${row.sensorId} to ${row.meshName}${note}`);
      }
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      summary.failed.push(row.sensorId);
      log(`bind     FAILED ${row.sensorId}: ${error.message}`);
    }
  }

  await attachMachinesStep(asset, rows, apply, log);
  return summary;
}

/**
 * Put the machines behind the replayed bindings back on the twin, so the
 * Telemetry tab and the binding form see them as the viewer would after adding
 * them by hand. This writes the registry document directly, so a running API
 * learns of it on its next restart. A machine that has never announced itself
 * has no document yet and is left for the Machines tab.
 */
async function attachMachinesStep(asset, rows, apply, log) {
  const machineIds = [
    ...new Set(rows.filter((r) => r.meshName).map((r) => r.sensorId.split('.')[0].toLowerCase())),
  ];

  for (const machineId of machineIds) {
    if (!apply) {
      log(`machine  would add ${machineId} to the twin`);
      continue;
    }
    const result = await Device.updateOne(
      { machineId, $or: [{ assetId: null }, { assetId: asset._id }] },
      { $set: { assetId: asset._id, attachedAt: new Date() } },
    );
    log(
      result.matchedCount > 0
        ? `machine  added ${machineId} to the twin (restart the API to pick it up)`
        : `machine  ${machineId} is unknown or belongs to another twin: add it from the Machines tab`,
    );
  }
}

/**
 * The capture step: database to file. Reads the database and never writes it.
 *
 * @returns {Promise<{captured: number, path: string}>}
 */
async function captureStep(asset, catalog, filePath, log) {
  const rows = defaultBindingRows(catalog);
  const active = await SensorBinding.find({ assetId: asset._id, isActive: true })
    .populate('meshNodeId', 'meshName displayName objectType isDeleted')
    .lean();
  const bySensor = new Map(active.map((b) => [b.sensorId, b]));

  let captured = 0;
  for (const row of rows) {
    const binding = bySensor.get(row.sensorId);
    const node = /** @type {any} */ (binding?.meshNodeId);
    if (!node || node.isDeleted) continue;
    row.meshName = node.meshName;
    row.sensorType = binding.sensorType;
    row.objectType = node.objectType ?? 'Mesh';
    if (node.displayName) row.displayName = node.displayName;
    captured += 1;
    log(`capture  ${row.sensorId} on ${row.meshName}`);
  }

  const file = { $comment: COMMENT, assetName: SEEDED_ASSET_NAME, bindings: rows };
  fs.writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  log(`capture  wrote ${captured} of ${rows.length} bindings to ${filePath}`);
  return { captured, path: filePath };
}

/* ─── Entry points ─────────────────────────────────────────────────────────── */

/**
 * Run the seed against the connected database.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply] - Write to the database. Default: dry run.
 * @param {boolean} [options.bindings] - Replay the recorded bindings.
 * @param {boolean} [options.capture] - Record current bindings into the file.
 * @param {string} [options.file] - Bindings file path.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{
 *   asset: {id: string, name: string},
 *   renamed: boolean,
 *   replay: {bound: string[], unchanged: string[], skipped: string[], failed: string[]}|null,
 *   capture: {captured: number, path: string}|null,
 * }>}
 */
export async function runSeed({
  apply = false,
  bindings = false,
  capture = false,
  file = DEFAULT_BINDINGS_PATH,
  log = console.log,
} = {}) {
  if (bindings && capture) {
    throw new Error('--bindings and --capture are opposites (file to database, database to file). Use one.');
  }
  assertAllowedDatabase(mongoose.connection.name);

  const catalog = loadCatalog();
  // Read the file before any write, so a bad file fails with nothing changed.
  const rows = bindings ? readBindingFile(file, catalog) : null;

  log(`database ${mongoose.connection.name}${apply ? '' : '  (dry run, nothing will be written)'}`);

  const asset = await findCarFactory();
  const renamed = await renameStep(asset, apply, log);
  const fresh = renamed ? await assetService.getAssetById(asset.id) : asset;

  const replay = rows ? await replayStep(fresh, rows, apply, log) : null;
  const captured = capture ? await captureStep(fresh, catalog, file, log) : null;

  if (!apply) log('\nDry run only. Add --apply to make these changes.');
  else if (replay) {
    log(
      `\n${replay.bound.length} bound, ${replay.unchanged.length} unchanged, ` +
        `${replay.skipped.length} skipped, ${replay.failed.length} failed.`,
    );
    log('A running API refreshes its binding index within 30 s. Reload the viewer to see the change.');
  }

  return {
    asset: { id: fresh.id, name: fresh.name },
    renamed,
    replay,
    capture: captured,
  };
}

const USAGE = `Usage: node server/scripts/seed-demo.mjs [options]

Prepares the dev database for the demo. A dry run unless --apply is given.

  --apply      Write the changes. Without it, the script only prints them.
  --bindings   Also bind the demo channels to the meshes recorded in
               docs/demo-bindings.json.
  --capture    Record the car factory's current bindings into that file. Reads
               the database, never writes to it.
  --file PATH  Use a different bindings file.
  --help       Show this text.
`;

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        apply: { type: 'boolean', default: false },
        bindings: { type: 'boolean', default: false },
        capture: { type: 'boolean', default: false },
        file: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  try {
    await connectDatabase();
    const result = await runSeed({
      apply: values.apply,
      bindings: values.bindings,
      capture: values.capture,
      ...(values.file ? { file: values.file } : {}),
    });
    if (result.replay?.failed.length) process.exitCode = 2;
  } catch (error) {
    console.error(`\n${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
