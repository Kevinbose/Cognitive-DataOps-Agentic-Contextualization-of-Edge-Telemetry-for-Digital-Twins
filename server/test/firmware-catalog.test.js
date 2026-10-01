/**
 * The firmware catalog generator: the committed header must be what the
 * generator produces, each birth template must expand to exactly the message the
 * software simulator publishes, and the certificate handling must fail loudly.
 *
 * These are the checks behind the promise that the C++ side and the JavaScript
 * side cannot drift apart.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { describe, it } from 'node:test';

import {
  CATALOG_HEADER,
  cDouble,
  cString,
  expandBirthTemplate,
  generate,
  parsePemBundle,
  renderBirthTemplate,
  renderCatalogHeader,
  renderRootCaHeader,
} from '../../scripts/gen-catalog.mjs';
import { buildBirth, loadCatalog } from '../scripts/lib/gateway.mjs';

const catalog = loadCatalog();
const IDENTITY = { fw: '1.0.0', mac: 'AA:BB:CC:DD:EE:FF', bootId: '7f3a9c21' };

/** Longest site id the firmware accepts (config.h `CDO_SITE_ID_MAX`). */
const SITE_ID_MAX = 32;
/** PubSubClient's fixed per-publish overhead: 5 header bytes plus a 2-byte topic length. */
const MQTT_OVERHEAD = 7;
const MQTT_BUFFER = 2048;

describe('catalog.h', () => {
  it('is exactly what the generator produces from firmware/catalog.json', () => {
    const onDisk = fs.readFileSync(CATALOG_HEADER, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(onDisk, renderCatalogHeader(catalog), 'run: node scripts/gen-catalog.mjs');
    assert.equal(generate({ check: true, log: () => {} }).current, true);
  });

  it('lists every channel in catalog order with its clamp range and decimals', () => {
    const header = renderCatalogHeader(catalog);

    for (const machine of Object.values(catalog.machines)) {
      const prefix = `CDO_${machine.machineType.toUpperCase()}`;
      const table = new RegExp(`${prefix}_CHANNELS\\[[^\\]]+\\] = \\{([\\s\\S]*?)\\n\\};`).exec(header);
      assert.ok(table, `${prefix}_CHANNELS table`);

      const rows = [...table[1].matchAll(/\{"([A-Z0-9_]+)", ([^,]+), ([^,]+), (\d+)\}/g)].map((m) => ({
        key: m[1],
        lo: Number(m[2]),
        hi: Number(m[3]),
        decimals: Number(m[4]),
      }));

      assert.deepEqual(
        rows,
        machine.channels.map((c) => ({ key: c.key, lo: c.min, hi: c.max, decimals: c.decimals })),
      );
      assert.match(header, new RegExp(`${prefix}_TYPE_CODE ${machine.typeCode}\\b`));
    }
  });

  it('exposes the press spectrum layout, including the shaft frequency the model uses', () => {
    const header = renderCatalogHeader(catalog);
    const s = catalog.machines['press-stamp-01'].spectrum;
    assert.match(header, /CDO_PRESS_HAS_SPECTRUM 1/);
    assert.match(header, new RegExp(`CDO_PRESS_SPECTRUM_COUNT ${s.count}\\b`));
    assert.match(header, /CDO_PRESS_SPECTRUM_STEP_HZ 12\.5/);
    assert.match(header, /CDO_PRESS_SHAFT_HZ 24\.7/);
    assert.match(header, /CDO_ROBOT_HAS_SPECTRUM 0/);
  });
});

describe('birth templates', () => {
  for (const [machineId, machine] of Object.entries(catalog.machines)) {
    it(`${machineId}: expands to exactly the message the simulator publishes`, () => {
      const template = renderBirthTemplate(machineId, machine);
      const expanded = expandBirthTemplate(template, IDENTITY);

      assert.equal(expanded, JSON.stringify(buildBirth(machineId, machine, IDENTITY)));
      assert.deepEqual(JSON.parse(expanded), buildBirth(machineId, machine, IDENTITY));
    });

    it(`${machineId}: has exactly three conversions and no stray percent sign`, () => {
      const template = renderBirthTemplate(machineId, machine);
      assert.equal((template.match(/%s/g) ?? []).length, 3);
      assert.equal(template.replace(/%s/g, '').includes('%'), false);
    });

    it(`${machineId}: fits the MQTT buffer with room to spare`, () => {
      const worst = expandBirthTemplate(renderBirthTemplate(machineId, machine), {
        fw: 'x'.repeat(24),
        mac: 'AA:BB:CC:DD:EE:FF',
        bootId: 'f'.repeat(16),
      });
      const topic = `cdo/v1/${'s'.repeat(SITE_ID_MAX)}/${machineId}/birth`;

      assert.ok(worst.length < 1400, `birth is ${worst.length} B, plan limit is 1400`);
      assert.ok(MQTT_OVERHEAD + topic.length + worst.length <= MQTT_BUFFER - 64);
    });
  }

  it('escapes a literal percent sign so snprintf prints it', () => {
    const odd = { ...catalog.machines['robot-weld-01'], label: '100% robot' };
    const template = renderBirthTemplate('robot-weld-01', odd);
    assert.match(template, /100%% robot/);
    assert.equal(JSON.parse(expandBirthTemplate(template, IDENTITY)).label, '100% robot');
  });

  it('refuses non-ASCII text, which the firmware cannot embed safely', () => {
    const odd = { ...catalog.machines['robot-weld-01'], label: 'Robot — 01' };
    assert.throws(() => renderBirthTemplate('robot-weld-01', odd), /printable ASCII/);
  });
});

describe('C literal helpers', () => {
  it('prints whole numbers as doubles and keeps fractions exact', () => {
    assert.equal(cDouble(45), '45.0');
    assert.equal(cDouble(0), '0.0');
    assert.equal(cDouble(0.085), '0.085');
    assert.equal(cDouble(24.7), '24.7');
    assert.equal(cDouble(-3), '-3.0');
    assert.throws(() => cDouble(Number.NaN), /finite/);
    assert.throws(() => cDouble(Infinity), /finite/);
  });

  it('splits long strings without losing or altering a character', () => {
    const text = `{"a":"${'x'.repeat(40)}","b":"q\\"uote","c":[1,2,3],"d":"${'y'.repeat(200)}"}`;
    const literal = cString(text, '', 40);
    const joined = [...literal.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`)).join('');

    assert.equal(joined, text);
    assert.ok(literal.split('\n').length > 3);
  });

  it('escapes quotes and backslashes, and rejects non-ASCII', () => {
    assert.equal(cString('a"b\\c'), '"a\\"b\\\\c"');
    assert.equal(cString(''), '""');
    assert.throws(() => cString('café'), /printable ASCII/);
  });
});

describe('certificate bundle', () => {
  const isrg = tls.rootCertificates.find((pem) => new X509Certificate(pem).subject.includes('ISRG Root X1'));

  it('parses a real root certificate and reports its subject and expiry', () => {
    assert.ok(isrg, "Node's bundled roots include ISRG Root X1");
    const [cert] = parsePemBundle(isrg);

    assert.match(cert.subject, /ISRG Root X1/);
    assert.ok(cert.notAfter > new Date());
    assert.ok(cert.pem.startsWith('-----BEGIN CERTIFICATE-----\n'));
    assert.ok(cert.pem.endsWith('-----END CERTIFICATE-----\n'));
  });

  it('accepts a bundle of several certificates', () => {
    const second = tls.rootCertificates.find((pem) => pem !== isrg);
    assert.equal(parsePemBundle(`${isrg}\n${second}`).length, 2);
  });

  it('rejects an expired certificate, an empty file and garbage', () => {
    assert.throws(() => parsePemBundle(isrg, new Date('2100-01-01')), /expired on/);
    assert.throws(() => parsePemBundle('no certificates here'), /No "BEGIN CERTIFICATE"/);
    assert.throws(
      () => parsePemBundle('-----BEGIN CERTIFICATE-----\nnot-base64!!\n-----END CERTIFICATE-----'),
      /cannot be parsed/,
    );
  });

  it('renders a header whose string decodes back to the PEM', () => {
    const certs = parsePemBundle(isrg);
    const header = renderRootCaHeader(certs);

    assert.match(header, /static const char CDO_ROOT_CA_PEM\[\] PROGMEM =/);
    const decoded = [...header.matchAll(/^ {4}("(?:[^"\\]|\\.)*");?$/gm)].map((m) => JSON.parse(m[1])).join('');
    assert.equal(decoded, certs[0].pem);
  });
});
