/**
 * The demo seed: what it renames, what it replays, and what it refuses.
 *
 * The pure parts (row building, file validation, the database guard) are unit
 * tests. The rest runs against this process's disposable `cdo_test_*` database.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadCatalog } from '../scripts/lib/gateway.mjs';
import {
  DEFAULT_BINDINGS_PATH,
  SEEDED_ASSET_NAME,
  assertAllowedDatabase,
  defaultBindingRows,
  parseBindingFile,
  runSeed,
} from '../scripts/seed-demo.mjs';
import { connectTestDatabase, dropTestDatabase } from './helpers.js';

const catalog = loadCatalog();

const TORQUE = 'ROBOT-WELD-01.AXIS_4_SERVO_TORQUE';
const LUBE = 'PRESS-STAMP-01.LUBE_OIL_PRESSURE';

/** The committed rows with `meshName` set for the given sensors only. */
function rowsWith(assignments) {
  return defaultBindingRows(catalog).map((row) => ({
    ...row,
    meshName: assignments[row.sensorId] ?? null,
  }));
}

describe('seed-demo: rows and file validation', () => {
  it('builds the six catalog channels, upper case, with the catalog sensor types', () => {
    const rows = defaultBindingRows(catalog);
    assert.equal(rows.length, 6);
    assert.deepEqual(
      rows.map((r) => r.sensorId),
      [
        'ROBOT-WELD-01.AXIS_4_SERVO_TORQUE',
        'ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION',
        'ROBOT-WELD-01.WELD_GUN_TEMP',
        'PRESS-STAMP-01.MAIN_MOTOR_CURRENT',
        'PRESS-STAMP-01.LUBE_OIL_PRESSURE',
        'PRESS-STAMP-01.BEARING_VIBRATION_RMS',
      ],
    );
    for (const row of rows) {
      const [machineId, key] = row.sensorId.toLowerCase().split('.');
      const channel = catalog.machines[machineId].channels.find((c) => c.key.toLowerCase() === key);
      assert.equal(row.sensorType, channel.sensorType, row.sensorId);
      assert.equal(row.meshName, null);
    }
  });

  it('keeps the committed docs/demo-bindings.json consistent with the catalog', () => {
    const json = JSON.parse(fs.readFileSync(DEFAULT_BINDINGS_PATH, 'utf8'));
    const rows = parseBindingFile(json, catalog);
    assert.deepEqual(
      rows.map((r) => r.sensorId),
      defaultBindingRows(catalog).map((r) => r.sensorId),
    );
    assert.equal(json.assetName, SEEDED_ASSET_NAME);
  });

  it('rejects an unknown sensor, a repeated sensor, a repeated mesh and stray keys, listing every problem', () => {
    const bad = {
      bindings: [
        { sensorId: 'WALKWAY_08_VIBRATION', sensorType: 'vibration', displayName: 'x', meshName: 'm1' },
        { sensorId: TORQUE, sensorType: 'torque', displayName: 'x', meshName: 'm2' },
        { sensorId: TORQUE.toLowerCase(), sensorType: 'torque', displayName: 'x', meshName: 'm2' },
      ],
    };
    assert.throws(
      () => parseBindingFile(bad, catalog),
      (error) => {
        assert.match(error.message, /"WALKWAY_08_VIBRATION" is not a catalog channel/);
        assert.match(error.message, /appears twice/);
        assert.match(error.message, /mesh "m2" is used twice/);
        return true;
      },
    );

    assert.throws(
      () =>
        parseBindingFile(
          { bindings: [{ sensorId: TORQUE, sensorType: 'torque', displayName: 'x', meshName: null, extra: 1 }] },
          catalog,
        ),
      /Unrecognized key/,
    );
    assert.throws(
      () =>
        parseBindingFile(
          { bindings: [{ sensorId: TORQUE, sensorType: 'sparkle', displayName: 'x', meshName: null }] },
          catalog,
        ),
      /Invalid bindings file/,
    );
  });

  it('allows only cognitive_dataops and cdo_test_* databases', () => {
    assert.doesNotThrow(() => assertAllowedDatabase('cognitive_dataops'));
    assert.doesNotThrow(() => assertAllowedDatabase('cdo_test_1a2b3c4d'));

    for (const name of ['amazona', 'vitpool', 'yakkay', 'cognitive_dataops_backup', 'cdo_testing', 'cdo_test_', '', undefined]) {
      assert.throws(() => assertAllowedDatabase(name), /Refusing to run/, String(name));
    }
  });
});

describe('seed-demo: against a disposable database', () => {
  /** @type {any} */ let Asset;
  /** @type {any} */ let Binding;
  /** @type {any} */ let carFactory;
  /** @type {any} */ let machineShop;
  /** @type {string} */ let dir;
  /** @type {string[]} */ let lines = [];

  const log = (line) => lines.push(line);
  const fileOf = (name, rows) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ assetName: SEEDED_ASSET_NAME, bindings: rows }));
    return file;
  };
  const activeBindings = () => Binding.find({ assetId: carFactory._id, isActive: true }).lean();

  before(async () => {
    await connectTestDatabase();
    ({ Asset } = await import('../src/models/Asset.model.js'));
    ({ SensorBinding: Binding } = await import('../src/models/SensorBinding.model.js'));

    carFactory = await Asset.create({ name: 'Car Factory — Assembly Hall', uploader: 'test', status: 'converted' });
    machineShop = await Asset.create({ name: 'Machine Shop — Tooling Floor', uploader: 'test', status: 'converted' });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdo-seed-'));
  });

  after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await dropTestDatabase();
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    lines = [];
    const result = await runSeed({ log });

    assert.equal(result.renamed, false);
    assert.equal((await Asset.findById(carFactory._id)).name, 'Car Factory — Assembly Hall');
    assert.ok(lines.some((l) => /would rename "Car Factory — Assembly Hall" to "Car Factory, Assembly Hall"/.test(l)));
    assert.ok(lines.some((l) => /Dry run only/.test(l)));
  });

  it('renames the car factory and leaves the machine shop alone', async () => {
    const result = await runSeed({ apply: true, log });

    assert.equal(result.renamed, true);
    assert.equal((await Asset.findById(carFactory._id)).name, SEEDED_ASSET_NAME);
    assert.equal((await Asset.findById(machineShop._id)).name, 'Machine Shop — Tooling Floor');

    lines = [];
    const again = await runSeed({ apply: true, log });
    assert.equal(again.renamed, false);
    assert.ok(lines.some((l) => /already named/.test(l)));
  });

  it('replays the recorded bindings through the real bind path and skips unassigned channels', async () => {
    // The press has announced itself (it has a registry document); the robot has not.
    const { Device } = await import('../src/models/Device.model.js');
    await Device.create({ machineId: 'press-stamp-01', siteId: 'vit-lab', machineType: 'press', label: 'Stamping press 01' });

    const file = fileOf('two.json', rowsWith({ [TORQUE]: 'test/mesh-one/0', [LUBE]: 'test/mesh-two/0' }));
    lines = [];
    const result = await runSeed({ apply: true, bindings: true, file, log });

    assert.equal(String((await Device.findOne({ machineId: 'press-stamp-01' })).assetId), String(carFactory._id));
    assert.equal(await Device.countDocuments({ machineId: 'robot-weld-01' }), 0, 'an unannounced machine is not invented');
    assert.ok(lines.some((l) => /robot-weld-01 is unknown/.test(l)), 'and the log says to add it by hand');

    assert.deepEqual(result.replay.bound.sort(), [LUBE, TORQUE].sort());
    assert.equal(result.replay.skipped.length, 4);
    assert.equal(result.replay.failed.length, 0);

    const active = await activeBindings();
    assert.equal(active.length, 2);
    assert.ok(active.every((b) => b.boundBy === 'seed-demo'));
    assert.equal((await Asset.findById(carFactory._id)).status, 'mapped');

    const { MeshNode } = await import('../src/models/MeshNode.model.js');
    const node = await MeshNode.findOne({ assetId: carFactory._id, meshName: 'test/mesh-two/0' });
    assert.equal(node.displayName, 'Lubrication unit');
    assert.equal(node.isMapped, true);
  });

  it('is idempotent: a second replay reports the bindings as unchanged', async () => {
    const file = path.join(dir, 'two.json');
    const result = await runSeed({ apply: true, bindings: true, file, log });

    assert.equal(result.replay.bound.length, 0);
    assert.equal(result.replay.unchanged.length, 2);
    assert.equal((await activeBindings()).length, 2);
  });

  it('reports a sensor held by another mesh and never moves it', async () => {
    const file = fileOf('conflict.json', rowsWith({ [TORQUE]: 'test/mesh-elsewhere/0' }));
    lines = [];
    const result = await runSeed({ apply: true, bindings: true, file, log });

    assert.deepEqual(result.replay.failed, [TORQUE]);
    assert.ok(lines.some((l) => l.includes('FAILED') && l.includes(TORQUE)));

    const held = (await activeBindings()).find((b) => b.sensorId === TORQUE);
    const { MeshNode } = await import('../src/models/MeshNode.model.js');
    const node = await MeshNode.findById(held.meshNodeId);
    assert.equal(node.meshName, 'test/mesh-one/0', 'the sensor stayed on its original mesh');
  });

  it('writes nothing when the file is invalid', async () => {
    const before = await Binding.countDocuments();
    const file = fileOf('bad.json', [
      ...rowsWith({ [TORQUE]: 'test/mesh-one/0' }),
      { sensorId: 'NOT_A_CHANNEL', sensorType: 'generic', displayName: 'x', objectType: 'Mesh', meshName: 'test/mesh-x/0' },
    ]);

    await assert.rejects(() => runSeed({ apply: true, bindings: true, file, log }), /not a catalog channel/);
    assert.equal(await Binding.countDocuments(), before);
  });

  it('captures the current bindings into a file that reads back, without writing to the database', async () => {
    const before = await Binding.countDocuments();
    const file = path.join(dir, 'captured.json');
    const result = await runSeed({ capture: true, file, log });

    assert.equal(result.capture.captured, 2);
    assert.equal(await Binding.countDocuments(), before);

    const rows = parseBindingFile(JSON.parse(fs.readFileSync(file, 'utf8')), catalog);
    assert.equal(rows.length, 6);
    assert.equal(rows.find((r) => r.sensorId === TORQUE).meshName, 'test/mesh-one/0');
    assert.equal(rows.find((r) => r.sensorId === LUBE).meshName, 'test/mesh-two/0');
    assert.equal(rows.filter((r) => r.meshName === null).length, 4);
  });

  it('refuses --bindings together with --capture', async () => {
    await assert.rejects(() => runSeed({ bindings: true, capture: true, log }), /opposites/);
  });
});
