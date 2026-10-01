/**
 * @file Formatting for values the operator reads.
 *
 * Numbers are formatted with the channel's own `decimals`, declared by the
 * device, so a torque and a pressure are never printed to the same precision
 * by accident.
 *
 * @module lib/format
 */

/** Non-breaking space: keeps a figure and its unit on one line. */
const NBSP = ' ';

/**
 * @param {number|null|undefined} value
 * @param {number} [decimals]
 * @returns {string} The value to `decimals` places, or `No data` when absent.
 */
export function formatValue(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'No data';
  return value.toFixed(decimals);
}

/**
 * A value with its unit, joined by a non-breaking space.
 *
 * @param {number|null|undefined} value
 * @param {string} unit
 * @param {number} [decimals]
 * @returns {string}
 */
export function formatWithUnit(value, unit, decimals = 2) {
  const text = formatValue(value, decimals);
  return unit && text !== 'No data' ? `${text}${NBSP}${unit}` : text;
}

/**
 * How long ago something happened, coarse enough to read at a glance.
 *
 * @param {number|null|undefined} timestamp - Epoch ms.
 * @param {number} now - Epoch ms.
 * @returns {string} `Just now`, `4 s ago`, `3 min ago`, or `Never`.
 */
export function formatAge(timestamp, now) {
  if (!timestamp) return 'Never';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 2) return 'Just now';
  if (seconds < 60) return `${seconds}${NBSP}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${NBSP}min ago`;
  return `${Math.round(minutes / 60)}${NBSP}h ago`;
}

/**
 * `CLOGGED_FILTER` to `Clogged filter`.
 *
 * @param {string|null|undefined} scenario
 * @returns {string}
 */
export function humanizeScenario(scenario) {
  if (!scenario) return 'Unknown';
  const words = scenario.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Status word for a sample, sentence case. */
export const STATUS_LABEL = Object.freeze({
  normal: 'Normal',
  warn: 'Warning',
  alarm: 'Alarm',
});
