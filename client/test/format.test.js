import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatAge, formatValue, formatWithUnit, humanizeScenario } from '../src/lib/format.js';
import { formatBytes } from '../src/lib/three-helpers.js';

describe('formatValue', () => {
  it('uses the channel decimals, not a global precision', () => {
    assert.equal(formatValue(4.5, 2), '4.50');
    assert.equal(formatValue(0.1, 3), '0.100');
    assert.equal(formatValue(96.44, 1), '96.4');
  });

  it('says "No data" for anything that is not a finite number', () => {
    for (const value of [undefined, null, NaN, Infinity, '4.5']) assert.equal(formatValue(value), 'No data');
  });
});

describe('formatWithUnit', () => {
  it('joins value and unit with a non-breaking space so they never wrap apart', () => {
    assert.equal(formatWithUnit(4.5, 'bar', 2), '4.50 bar');
  });
  it('leaves "No data" without a dangling unit', () => {
    assert.equal(formatWithUnit(undefined, 'bar'), 'No data');
  });
});

describe('formatBytes', () => {
  it('keeps the figure and unit together', () => {
    assert.equal(formatBytes(7.5 * 1024 * 1024), '7.5 MB');
    assert.equal(formatBytes(0), '0 B');
  });
});

describe('formatAge', () => {
  const now = 1_000_000;
  it('reads at a glance', () => {
    assert.equal(formatAge(null, now), 'Never');
    assert.equal(formatAge(now - 500, now), 'Just now');
    assert.equal(formatAge(now - 4000, now), '4 s ago');
    assert.equal(formatAge(now - 3 * 60_000, now), '3 min ago');
    assert.equal(formatAge(now - 2 * 3_600_000, now), '2 h ago');
  });
  it('never goes negative when a clock runs ahead', () => {
    assert.equal(formatAge(now + 5000, now), 'Just now');
  });
});

describe('humanizeScenario', () => {
  it('turns an identifier into a sentence-case label', () => {
    assert.equal(humanizeScenario('CLOGGED_FILTER'), 'Clogged filter');
    assert.equal(humanizeScenario('NORMAL'), 'Normal');
    assert.equal(humanizeScenario(null), 'Unknown');
  });
});
