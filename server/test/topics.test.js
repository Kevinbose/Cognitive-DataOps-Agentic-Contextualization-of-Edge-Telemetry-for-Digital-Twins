import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMMAND_NAMES,
  INBOUND_SUFFIXES,
  buildTopic,
  parseInboundTopic,
  sensorIdFor,
  subscriptionFilters,
} from '../src/utils/mqttTopics.js';
import { sensorIdSchema } from '../src/validators/meshNode.validator.js';

const SITE = 'vit-lab';

describe('parseInboundTopic', () => {
  for (const suffix of INBOUND_SUFFIXES) {
    it(`accepts the ${suffix} topic`, () => {
      assert.deepEqual(parseInboundTopic(`cdo/v1/${SITE}/press-stamp-01/${suffix}`, SITE), {
        siteId: SITE,
        machineId: 'press-stamp-01',
        suffix,
      });
    });
  }

  it('ignores another site', () => {
    assert.equal(parseInboundTopic('cdo/v1/other-lab/press-stamp-01/telemetry', SITE), null);
  });

  it('rejects anything that is not exactly the grammar', () => {
    const hostile = [
      'cdo/v1/vit-lab/press-stamp-01/telemetry/extra',
      'cdo/v1/vit-lab/press-stamp-01',
      'cdo/v1/vit-lab//telemetry',
      'cdo/v1/vit-lab/PRESS-STAMP-01/telemetry', // upper case machine id
      'cdo/v1/vit-lab/press stamp/telemetry',
      'cdo/v1/vit-lab/+/telemetry', // wildcards are never a real machine
      'cdo/v1/vit-lab/#',
      'cdo/v1/vit-lab/../status',
      'cdo/v1/vit-lab/press-stamp-01/cmd/scenario', // outbound, not inbound
      'cdo/v2/vit-lab/press-stamp-01/telemetry',
      '$SYS/broker/uptime',
      `cdo/v1/vit-lab/${'a'.repeat(49)}/telemetry`, // machine id too long
      `cdo/v1/vit-lab/press-stamp-01/${'x'.repeat(200)}`,
      '',
    ];
    for (const topic of hostile) {
      assert.equal(parseInboundTopic(topic, SITE), null, `should reject "${topic}"`);
    }
  });

  it('rejects non-string input without throwing', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.equal(parseInboundTopic(/** @type {any} */ (value), SITE), null);
    }
  });
});

describe('topic construction', () => {
  it('builds command topics under the machine', () => {
    assert.equal(
      buildTopic(SITE, 'press-stamp-01', 'cmd/scenario'),
      'cdo/v1/vit-lab/press-stamp-01/cmd/scenario',
    );
  });

  it('subscribes to one explicit filter per inbound suffix and never to commands', () => {
    const filters = subscriptionFilters(SITE);
    assert.equal(filters.length, INBOUND_SUFFIXES.length);
    for (const { filter } of filters) {
      assert.match(filter, /^cdo\/v1\/vit-lab\/\+\/[a-z]+$/);
      assert.ok(!filter.includes('cmd'), 'the backend must not subscribe to its own command topics');
    }
  });

  it('gives identity and acknowledgements QoS 1 and high-rate data QoS 0', () => {
    const qos = Object.fromEntries(
      subscriptionFilters(SITE).map(({ filter, qos: q }) => [filter.split('/').pop(), q]),
    );
    assert.deepEqual(qos, { birth: 1, status: 1, ack: 1, telemetry: 0, spectrum: 0, diag: 0, log: 0 });
  });

  it('names exactly the four documented commands', () => {
    assert.deepEqual([...COMMAND_NAMES], ['scenario', 'interval', 'reboot', 'ping']);
  });
});

describe('sensorIdFor', () => {
  it('upper-cases the machine and keeps the channel key', () => {
    assert.equal(
      sensorIdFor('press-stamp-01', 'LUBE_OIL_PRESSURE'),
      'PRESS-STAMP-01.LUBE_OIL_PRESSURE',
    );
  });

  it('always satisfies the binding form validator unchanged', () => {
    for (const [machine, key] of [
      ['robot-weld-01', 'AXIS_4_SERVO_TORQUE'],
      ['robot-weld-01', 'TOOL_CENTER_POINT_DEVIATION'],
      ['press-stamp-01', 'BEARING_VIBRATION_RMS'],
    ]) {
      const id = sensorIdFor(machine, key);
      assert.equal(sensorIdSchema.parse(id), id);
    }
  });
});
