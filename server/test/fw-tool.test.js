/**
 * The firmware tool's safety rails: which ports it will touch, when it refuses an
 * upload, and how it stages a build. The hardware steps themselves (compile,
 * upload, monitor) need a toolchain and a board, so they are not tested here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { loadCatalog } from '../scripts/lib/gateway.mjs';

/** A scratch build root, set before the tool is imported (it reads it once). */
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdo-fw-test-'));
process.env.CDO_FW_BUILD_ROOT = buildRoot;
const fw = await import('../../scripts/fw.mjs');

/** Contents of the committed sketch folder, without any local secrets. */
function copySketch(into) {
  fs.mkdirSync(into, { recursive: true });
  for (const file of fs.readdirSync(fw.SKETCH_DIR)) {
    if (!/\.(ino|h)$/.test(file) || file === 'secrets.h' || file === 'root_ca.h') continue;
    fs.copyFileSync(path.join(fw.SKETCH_DIR, file), path.join(into, file));
  }
}

after(() => fs.rmSync(buildRoot, { recursive: true, force: true }));

describe('USB allow-list', () => {
  it('recognises the ESP32 bridges, with or without 0x and in any case', () => {
    assert.equal(fw.classifyUsb('10C4', 'EA60')?.name, 'Silicon Labs CP210x');
    assert.equal(fw.classifyUsb('0x10c4', '0xea60')?.name, 'Silicon Labs CP210x');
    assert.equal(fw.classifyUsb('1A86', '7523')?.name, 'WCH CH340');
    assert.equal(fw.classifyUsb('1A86', '55D4')?.name, 'WCH CH9102');
    assert.equal(fw.classifyUsb('0403', '6001')?.name, 'FTDI FT232');
  });

  it('accepts any Espressif native USB product (vendor 303A)', () => {
    assert.ok(fw.classifyUsb('303A', '1001'));
    assert.ok(fw.classifyUsb('0x303a', '0x0002'));
  });

  it('refuses everything else: other products of a known vendor, unknown vendors, no id', () => {
    assert.equal(fw.classifyUsb('10C4', '0001'), null, 'same vendor, different product');
    assert.equal(fw.classifyUsb('0A12', '0001'), null, 'a Bluetooth radio');
    assert.equal(fw.classifyUsb(null, null), null);
    assert.equal(fw.classifyUsb(undefined, 'EA60'), null);
    assert.equal(fw.classifyUsb('not-hex', 'EA60'), null);
  });

  it('reads arduino-cli board list output, flagging only real bridges', () => {
    const rows = fw.parseBoardList({
      detected_ports: [
        { port: { address: 'COM3', protocol: 'serial', protocol_label: 'Serial Port', properties: {} } },
        {
          port: {
            address: 'COM7',
            protocol: 'serial',
            protocol_label: 'Serial Port (USB)',
            properties: { vid: '0x10C4', pid: '0xEA60', serialNumber: '0001' },
          },
          matching_boards: [{ name: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32' }],
        },
        { port: { address: 'COM9', protocol: 'serial', properties: { vid: '0x2341', pid: '0x0043' } } },
      ],
    });

    assert.deepEqual(rows.map((r) => [r.address, Boolean(r.bridge)]), [['COM3', false], ['COM7', true], ['COM9', false]]);
    assert.equal(rows[1].vid, '10C4');
    assert.equal(rows[1].pid, 'EA60');
    assert.deepEqual(rows[1].boards, ['ESP32 Dev Module']);
    assert.deepEqual(fw.parseBoardList({}), []);
  });
});

describe('secrets and machine select', () => {
  it('finds the CHANGE_ME values in the template by name', () => {
    const template = fs.readFileSync(path.join(fw.SKETCH_DIR, 'secrets.example.h'), 'utf8');
    const left = fw.findPlaceholders(template);

    for (const name of ['WIFI_SSID_1', 'WIFI_PASS_1', 'MQTT_HOST', 'MQTT_USER_ROBOT', 'MQTT_PASS_PRESS']) {
      assert.ok(left.includes(name), `${name} should be flagged`);
    }
    assert.ok(!left.includes('SITE_ID'), 'real defaults are not placeholders');
  });

  it('ignores CHANGE_ME inside comments, and passes a filled-in file', () => {
    const filled = [
      '/* CHANGE_ME is what the template says */',
      '// #define OTA_PASSWORD "CHANGE_ME_ota_password"',
      '#define WIFI_SSID_1 "HomeNet"',
      '#define MQTT_HOST "abc.s1.eu.hivemq.cloud" // not CHANGE_ME',
      '#define WIFI_SSID_2 ""',
    ].join('\n');
    assert.deepEqual(fw.findPlaceholders(filled), []);
  });

  it('strips line and block comments', () => {
    assert.equal(fw.stripComments('a /* x\ny */ b // c\nd').replace(/\s+/g, ' ').trim(), 'a b d');
  });

  it('reads and rewrites MACHINE_TYPE without touching anything else', () => {
    const text = fs.readFileSync(path.join(fw.SKETCH_DIR, 'machine_select.h'), 'utf8');
    // Whichever board the working tree is set up for: the selector is edited often.
    const current = fw.parseMachineType(text);
    assert.ok(current === 1 || current === 2, `MACHINE_TYPE is ${current}`);

    const other = current === 1 ? 2 : 1;
    const switched = fw.withMachineType(text, other);
    assert.equal(fw.parseMachineType(switched), other);
    assert.equal(switched.replace(`MACHINE_TYPE ${other}`, `MACHINE_TYPE ${current}`), text);
    assert.throws(() => fw.withMachineType('// nothing here', 1), /no "#define MACHINE_TYPE/);
  });

  it('maps machine names to catalog entries', () => {
    const catalog = loadCatalog();
    assert.deepEqual(fw.machineChoices(catalog), {
      robot: { id: 'robot-weld-01', typeCode: 1 },
      press: { id: 'press-stamp-01', typeCode: 2 },
    });
  });
});

describe('sketch fingerprint and build output', () => {
  it('is stable across line endings and changes when a source file changes', () => {
    const dir = fs.mkdtempSync(path.join(buildRoot, 'hash-'));
    fs.writeFileSync(path.join(dir, 'a.ino'), 'void setup() {}\nvoid loop() {}\n');
    fs.writeFileSync(path.join(dir, 'b.h'), '#define X 1\n');
    const first = fw.sketchHash(dir);

    fs.writeFileSync(path.join(dir, 'a.ino'), 'void setup() {}\r\nvoid loop() {}\r\n');
    assert.equal(fw.sketchHash(dir), first, 'CRLF checkout must not look like a change');

    fs.writeFileSync(path.join(dir, 'b.h'), '#define X 2\n');
    assert.notEqual(fw.sketchHash(dir), first);

    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    const withNotes = fw.sketchHash(dir);
    fs.rmSync(path.join(dir, 'notes.txt'));
    assert.equal(fw.sketchHash(dir), withNotes, 'only .ino and .h files count');
  });

  it('reads flash use from the compiler output', () => {
    const out = 'Sketch uses 1077454 bytes (82%) of program storage space. Maximum is 1310720 bytes.';
    assert.deepEqual(fw.parseSketchSize(out), { bytes: 1077454, percent: 82, max: 1310720 });
    assert.equal(fw.parseSketchSize('nothing'), null);
  });

  it('names the chip from an FQBN', () => {
    assert.equal(fw.chipOf('esp32:esp32:esp32'), 'esp32');
    assert.equal(fw.chipOf('esp32:esp32:esp32s3:CDCOnBoot=cdc'), 'esp32s3');
  });
});

describe('staging a build', () => {
  /** @type {string} */ let sketch;

  before(() => {
    sketch = path.join(buildRoot, 'sketch-copy', fw.SKETCH_NAME);
    copySketch(sketch);
  });

  it('builds against the template when there is no secrets.h, and says it is a compile check', () => {
    const staged = fw.stageSketch({ tls: true, sketchDir: sketch });

    assert.equal(staged.compileCheckOnly, true);
    assert.equal(staged.usedExampleSecrets, true);
    assert.equal(staged.usedDummyCa, true);
    assert.ok(fs.existsSync(path.join(staged.dir, 'secrets.h')));
    assert.match(fs.readFileSync(path.join(staged.dir, 'root_ca.h'), 'utf8'), /COMPILE CHECK ONLY/);
    assert.match(fs.readFileSync(path.join(staged.dir, 'secrets.h'), 'utf8'), /#define CDO_TLS 1/);
  });

  it('can compile-check without TLS, which needs no certificate', () => {
    const staged = fw.stageSketch({ tls: false, sketchDir: sketch });

    assert.equal(staged.usedDummyCa, false);
    assert.match(fs.readFileSync(path.join(staged.dir, 'secrets.h'), 'utf8'), /#define CDO_TLS 0/);
    assert.equal(fs.existsSync(path.join(staged.dir, 'root_ca.h')), false);
  });

  it('copies source files only, and never writes into the source folder', () => {
    const before = fs.readdirSync(sketch).sort();
    const staged = fw.stageSketch({ sketchDir: sketch });

    assert.deepEqual(fs.readdirSync(sketch).sort(), before, 'the source sketch is untouched');
    assert.ok(fs.existsSync(path.join(staged.dir, `${fw.SKETCH_NAME}.ino`)));
    assert.ok(fs.existsSync(path.join(staged.dir, 'catalog.h')));
    assert.ok(path.relative(buildRoot, staged.dir).startsWith('stage'));
  });

  it('is not a compile check when real secrets and a certificate are present', () => {
    fs.writeFileSync(path.join(sketch, 'secrets.h'), '#define CDO_TLS 1\n#define MQTT_HOST "x"\n');
    fs.writeFileSync(path.join(sketch, 'root_ca.h'), '#pragma once\n');
    try {
      const staged = fw.stageSketch({ sketchDir: sketch });
      assert.equal(staged.compileCheckOnly, false);
      assert.equal(staged.usedExampleSecrets, false);
      assert.equal(staged.usedDummyCa, false);
    } finally {
      fs.rmSync(path.join(sketch, 'secrets.h'));
      fs.rmSync(path.join(sketch, 'root_ca.h'));
    }
  });

  it('wants a dummy certificate only when real secrets turn TLS on', () => {
    fs.writeFileSync(path.join(sketch, 'secrets.h'), '#define CDO_TLS 0\n#define MQTT_HOST "192.168.1.5"\n');
    try {
      const staged = fw.stageSketch({ sketchDir: sketch });
      assert.equal(staged.usedDummyCa, false);
      assert.equal(staged.compileCheckOnly, false);
    } finally {
      fs.rmSync(path.join(sketch, 'secrets.h'));
    }
  });
});

describe('when an upload is refused', () => {
  const good = Object.freeze({
    record: {
      machine: 'press',
      machineId: 'press-stamp-01',
      selftest: false,
      compileCheckOnly: false,
      sketchHash: 'abc123',
    },
    confirmMachine: 'press',
    confirmOverwrite: false,
    currentHash: 'abc123',
    currentMachine: 'press',
    secretsText: '#define WIFI_SSID_1 "HomeNet"\n#define MQTT_HOST "x.hivemq.cloud"\n',
    port: { address: 'COM7', vid: '10C4', pid: 'EA60', bridge: { name: 'Silicon Labs CP210x' } },
    requestedPort: 'COM7',
  });

  const blockers = (change) => fw.uploadBlockers({ ...good, ...change });
  const assertBlocked = (change, pattern) => {
    const problems = blockers(change);
    assert.ok(problems.some((p) => pattern.test(p)), `expected ${pattern}, got ${JSON.stringify(problems)}`);
  };

  it('lets a correct upload through', () => {
    assert.deepEqual(blockers({}), []);
  });

  it('refuses when nothing was compiled', () => {
    assert.deepEqual(blockers({ record: null }), ['Nothing has been compiled yet. Run: fw compile']);
  });

  it('refuses a compile-check-only build', () => {
    assertBlocked({ record: { ...good.record, compileCheckOnly: true } }, /COMPILE CHECK ONLY/);
  });

  it('refuses when the sketch changed after it was compiled', () => {
    assertBlocked({ currentHash: 'different' }, /changed since it was compiled/);
  });

  it('wants the machine named, and refuses a different one', () => {
    assertBlocked({ confirmMachine: undefined }, /--confirm-machine press/);
    assertBlocked({ confirmMachine: 'robot' }, /does not match the compiled build, which is press/);
  });

  it('refuses when machine_select.h no longer matches the build', () => {
    assertBlocked({ currentMachine: 'robot' }, /machine_select\.h now says robot/);
  });

  it('refuses without secrets.h, and with placeholders left in it', () => {
    assertBlocked({ secretsText: null }, /no secrets\.h/);
    assertBlocked({ secretsText: '#define WIFI_SSID_1 "CHANGE_ME_x"\n#define MQTT_HOST "ok"' }, /placeholder values: WIFI_SSID_1/);
  });

  it('refuses a port that is absent', () => {
    assertBlocked({ port: undefined }, /Port COM7 is not present/);
  });

  it('refuses a port that is not an ESP32 bridge, such as a Bluetooth serial port', () => {
    assertBlocked({ port: { address: 'COM3', vid: null, pid: null, bridge: null }, requestedPort: 'COM3' }, /no USB id\) is not an ESP32 USB bridge/);
    assertBlocked({ port: { address: 'COM9', vid: '2341', pid: '0043', bridge: null }, requestedPort: 'COM9' }, /2341:0043\) is not an ESP32 USB bridge/);
  });

  it('reports every problem at once', () => {
    const problems = blockers({ currentHash: 'x', confirmMachine: undefined, secretsText: null, port: undefined });
    assert.ok(problems.length >= 4);
  });

  describe('the self-test build', () => {
    const selftest = { ...good.record, selftest: true, machine: 'robot' };

    it('needs --confirm-overwrite instead of a machine name, and no secrets', () => {
      assertBlocked({ record: selftest, confirmMachine: undefined, secretsText: null }, /--confirm-overwrite/);
      assert.deepEqual(blockers({ record: selftest, confirmMachine: undefined, confirmOverwrite: true, secretsText: null }), []);
    });

    it('still refuses a port that is not an ESP32 bridge', () => {
      assertBlocked(
        { record: selftest, confirmOverwrite: true, port: { address: 'COM3', vid: null, pid: null, bridge: null }, requestedPort: 'COM3' },
        /not an ESP32 USB bridge/,
      );
    });
  });
});
