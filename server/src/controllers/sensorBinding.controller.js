/**
 * @file Sensor-binding HTTP controllers.
 *
 * @module controllers/sensorBinding.controller
 */

import * as sensorBindingService from '../services/sensorBinding.service.js';
import { sendOk } from '../utils/ApiResponse.js';

/**
 * `PUT /api/v1/assets/:assetId/mesh-nodes/by-name/:meshName/sensor-binding`
 *
 * The primary "save a mapping" endpoint. `PUT` rather than `POST` because the
 * operation is idempotent: submitting the same sensor for the same mesh twice
 * leaves the system in exactly one state, and the response says so via
 * `result.unchanged`.
 *
 * @type {import('express').RequestHandler}
 */
export async function saveBinding(req, res) {
  const result = await sensorBindingService.bindSensorToMeshName({
    assetId: req.params.assetId,
    meshName: req.params.meshName,
    sensorId: req.body.sensorId,
    sensorType: req.body.sensorType,
    displayName: req.body.displayName,
    nodePath: req.body.nodePath,
    objectType: req.body.objectType,
    boundBy: req.body.boundBy,
    notes: req.body.notes,
    reassign: req.body.reassign,
  });

  const message = result.unchanged
    ? 'Sensor binding already up to date'
    : result.replacedPreviousBinding
      ? 'Sensor binding replaced'
      : 'Sensor binding created';

  return sendOk(res, result, message);
}

/**
 * `GET /api/v1/assets/:assetId/sensor-bindings` — list bindings for an asset.
 *
 * @type {import('express').RequestHandler}
 */
export async function listBindings(req, res) {
  const bindings = await sensorBindingService.listBindingsForAsset(req.params.assetId, {
    includeInactive: req.query.includeInactive,
  });

  return sendOk(res, bindings, 'Sensor bindings retrieved');
}

/**
 * `DELETE /api/v1/sensor-bindings/:bindingId` — retire a binding.
 *
 * @type {import('express').RequestHandler}
 */
export async function unbind(req, res) {
  const binding = await sensorBindingService.unbindById(req.params.bindingId);
  return sendOk(res, binding, 'Sensor unbound');
}

export default { saveBinding, listBindings, unbind };
