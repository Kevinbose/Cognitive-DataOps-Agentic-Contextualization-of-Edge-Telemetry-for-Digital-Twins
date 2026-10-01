/**
 * @file Metadata controller — enumerations and feature flags the client needs.
 *
 * Serving these instead of hard-coding them in the browser means the client has
 * no second copy of `SENSOR_TYPES` to fall out of step with the schema.
 *
 * @module controllers/meta.controller
 */

import { config } from '../config/env.config.js';
import { MESH_OBJECT_TYPES } from '../models/MeshNode.model.js';
import { SENSOR_TYPES } from '../models/SensorBinding.model.js';
import { sendOk } from '../utils/ApiResponse.js';

/**
 * `GET /api/v1/meta`
 *
 * @type {import('express').RequestHandler}
 */
export function getMeta(_req, res) {
  return sendOk(
    res,
    {
      sensorTypes: SENSOR_TYPES,
      meshObjectTypes: MESH_OBJECT_TYPES,
      features: {
        // Whether this server is ingesting telemetry at all.
        ingestion: config.mqtt.url !== null,
        // Whether the fault-injection panel should be offered.
        deviceCommands: config.enableDeviceCommands,
      },
      siteId: config.mqtt.siteId,
    },
    'Metadata retrieved',
  );
}

export default { getMeta };
