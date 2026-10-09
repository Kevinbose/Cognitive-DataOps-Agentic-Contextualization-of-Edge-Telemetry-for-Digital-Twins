/**
 * @file The knowledge base's five condition levels, mapped onto the console's
 * marker shapes. Watch and warning share the triangle, alarm and critical the
 * square; the word always says which.
 *
 * @module features/agent/components/levels
 */

/** @type {Record<string, {marker: 'normal'|'warn'|'alarm', label: string}>} */
export const LEVELS = {
  normal: { marker: 'normal', label: 'Normal' },
  watch: { marker: 'warn', label: 'Watch' },
  warning: { marker: 'warn', label: 'Warning' },
  alarm: { marker: 'alarm', label: 'Alarm' },
  critical: { marker: 'alarm', label: 'Critical' },
};

/** @param {string|null|undefined} level */
export function levelOf(level) {
  return LEVELS[level ?? ''] ?? LEVELS.warning;
}

/**
 * Banner wording: alarm and critical are announced as critical.
 *
 * @param {string|null|undefined} level
 * @returns {string}
 */
export function anomalyTitle(level) {
  return level === 'alarm' || level === 'critical' ? 'Critical anomaly detected' : 'Anomaly detected';
}

/** @param {number|null|undefined} x @returns {string} */
export function percent(x) {
  return typeof x === 'number' ? `${Math.round(x * 100)}%` : 'n/a';
}

/**
 * A machine's display name from the device registry (its birth message), or
 * its id when the gateway has not announced itself in this session.
 *
 * @param {string|null|undefined} machineId
 * @param {Array<{machineId: string, label?: string}>} devices
 */
export function machineLabel(machineId, devices) {
  return devices?.find((d) => d.machineId === machineId)?.label ?? machineId ?? 'Machine';
}

/** @param {string|null|undefined} key e.g. LUBE_OIL_PRESSURE @returns {string} "lube oil pressure" */
export function channelWords(key) {
  return String(key ?? '').replace(/_/g, ' ').toLowerCase();
}
