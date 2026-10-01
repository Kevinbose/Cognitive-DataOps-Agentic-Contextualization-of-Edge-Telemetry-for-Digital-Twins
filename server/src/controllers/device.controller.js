/**
 * @file Device HTTP controllers.
 *
 * @module controllers/device.controller
 */

import * as deviceService from '../services/device.service.js';
import { sendAccepted, sendOk } from '../utils/ApiResponse.js';

/**
 * `GET /api/v1/devices` — every known device with its catalog and diagnostics.
 *
 * @type {import('express').RequestHandler}
 */
export function listDevices(_req, res) {
  return sendOk(res, deviceService.listPublicDevices(), 'Devices retrieved');
}

/**
 * `POST /api/v1/devices/:machineId/commands` — send a command.
 *
 * `202 Accepted`, not `200`: the command is published, not yet carried out.
 * The outcome arrives as a `device:ack` event on the websocket.
 *
 * @type {import('express').RequestHandler}
 */
export async function sendCommand(req, res) {
  const result = await deviceService.sendCommand(req.params.machineId, req.body);
  return sendAccepted(res, result, 'Command sent; awaiting acknowledgement');
}

/**
 * `GET /api/v1/devices/:machineId/sim` — simulator ground truth.
 *
 * For the fault-injection panel and the evaluation harness only.
 *
 * @type {import('express').RequestHandler}
 */
export async function getSim(req, res) {
  return sendOk(res, await deviceService.getSimTruth(req.params.machineId), 'Simulator state retrieved');
}

export default { listDevices, sendCommand, getSim };
