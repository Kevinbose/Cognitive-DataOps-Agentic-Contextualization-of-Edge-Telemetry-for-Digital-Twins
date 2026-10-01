/**
 * @file Channel status evaluation from alarm limits.
 *
 * @module utils/channelStatus
 */

/**
 * Alarm limits as declared in a device's `birth` message.
 *
 * @typedef {object} ChannelLimits
 * @property {number} [warnLow]
 * @property {number} [warnHigh]
 * @property {number} [alarmLow]
 * @property {number} [alarmHigh]
 */

/**
 * Sample status, in increasing severity.
 *
 * @readonly
 * @enum {string}
 */
export const CHANNEL_STATUS = Object.freeze({
  NORMAL: 'normal',
  WARN: 'warn',
  ALARM: 'alarm',
});

/**
 * Classify a value against its limits.
 *
 * A limit is breached when the value reaches it (`>=` for a high limit, `<=`
 * for a low one). Alarm wins over warn. A channel with no limits is always
 * normal, which is also the answer for a sample whose `birth` has not arrived
 * yet.
 *
 * @param {number} value - Measured value.
 * @param {ChannelLimits|null|undefined} limits - The channel's limits.
 * @returns {'normal'|'warn'|'alarm'} Status.
 */
export function evaluateStatus(value, limits) {
  if (!limits) return CHANNEL_STATUS.NORMAL;

  const { warnLow, warnHigh, alarmLow, alarmHigh } = limits;

  if (
    (alarmHigh !== undefined && value >= alarmHigh) ||
    (alarmLow !== undefined && value <= alarmLow)
  ) {
    return CHANNEL_STATUS.ALARM;
  }

  if (
    (warnHigh !== undefined && value >= warnHigh) ||
    (warnLow !== undefined && value <= warnLow)
  ) {
    return CHANNEL_STATUS.WARN;
  }

  return CHANNEL_STATUS.NORMAL;
}

export default { CHANNEL_STATUS, evaluateStatus };
