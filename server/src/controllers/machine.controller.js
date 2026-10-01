/**
 * @file Controllers for the machines added to a twin.
 *
 * @module controllers/machine.controller
 */

import * as deviceService from '../services/device.service.js';
import { sendCreated, sendOk } from '../utils/ApiResponse.js';

/**
 * `GET /api/v1/assets/:assetId/machines` — the machines added to this twin.
 *
 * @type {import('express').RequestHandler}
 */
export function listMachines(req, res) {
  return sendOk(res, deviceService.listMachinesForAsset(req.params.assetId), 'Machines retrieved');
}

/**
 * `POST /api/v1/assets/:assetId/machines` — add a discovered machine to the twin.
 *
 * @type {import('express').RequestHandler}
 */
export async function addMachine(req, res) {
  const { device, unchanged } = await deviceService.attachMachine(req.params.assetId, req.body.machineId);
  return unchanged
    ? sendOk(res, device, 'Machine is already on this twin')
    : sendCreated(res, device, 'Machine added to this twin');
}

/**
 * `DELETE /api/v1/assets/:assetId/machines/:machineId` — take a machine off the
 * twin and retire the bindings of its channels.
 *
 * @type {import('express').RequestHandler}
 */
export async function removeMachine(req, res) {
  const result = await deviceService.detachMachine(req.params.assetId, req.params.machineId);
  return sendOk(res, result, 'Machine removed from this twin');
}

export default { listMachines, addMachine, removeMachine };
