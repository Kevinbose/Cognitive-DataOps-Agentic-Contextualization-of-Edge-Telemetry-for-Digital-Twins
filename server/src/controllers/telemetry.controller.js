/**
 * @file Telemetry HTTP controllers.
 *
 * @module controllers/telemetry.controller
 */

import * as telemetryService from '../services/telemetry.service.js';
import * as telemetryStore from '../services/telemetryStore.service.js';
import { sendOk } from '../utils/ApiResponse.js';

/**
 * `GET /api/v1/telemetry/latest` — newest value per channel, from memory.
 *
 * @type {import('express').RequestHandler}
 */
export function getLatest(req, res) {
  return sendOk(res, telemetryService.getLatestSamples(req.query.machineId), 'Latest samples retrieved');
}

/**
 * `GET /api/v1/telemetry/history` — bucketed min, average and max for a sensor.
 *
 * @type {import('express').RequestHandler}
 */
export async function getHistory(req, res) {
  const { sensorId, from, to, bucketSec } = req.query;
  const points = await telemetryStore.queryHistory(req.query);

  return sendOk(res, points, 'History retrieved', {
    sensorId,
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSec,
    count: points.length,
  });
}

/**
 * `GET /api/v1/telemetry/spectrum/latest` — newest spectrum for a machine.
 *
 * Served from memory when a frame has arrived since boot, otherwise from the
 * most recent stored one.
 *
 * @type {import('express').RequestHandler}
 */
export async function getLatestSpectrum(req, res) {
  const { machineId } = req.query;

  const live = telemetryService.getLatestSpectrumFrame(machineId);
  if (live) return sendOk(res, live, 'Latest spectrum retrieved');

  const stored = await telemetryStore.findLatestSpectrum(machineId);
  return sendOk(
    res,
    stored ? { machineId, key: stored.key, ts: stored.ts.getTime(), amp: stored.amp } : null,
    stored ? 'Latest spectrum retrieved' : 'No spectrum recorded for this machine',
  );
}

export default { getLatest, getHistory, getLatestSpectrum };
