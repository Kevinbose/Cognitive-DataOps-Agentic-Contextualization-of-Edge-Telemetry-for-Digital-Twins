/**
 * @file Request schemas for mesh-node and sensor-binding endpoints.
 *
 * @module validators/meshNode.validator
 */

import { z } from 'zod';

import { MESH_OBJECT_TYPES } from '../models/MeshNode.model.js';
import { SENSOR_TYPES } from '../models/SensorBinding.model.js';
import { booleanFlag, nonEmptyString, objectIdSchema, optionalText } from './common.validator.js';

/**
 * A raw glTF node name.
 *
 * Trimmed only — deliberately not normalised further. Real asset packs produce
 * names like `038-tool-hire-depot-and-plant-yard-depot-wall-module/0`, complete
 * with slashes and mixed case, and this string must match the scene graph
 * byte-for-byte for `getObjectByName` to resolve it in the browser.
 *
 * @type {import('zod').ZodString}
 */
export const meshNameSchema = nonEmptyString({ max: 512, label: 'Mesh name' });

/**
 * A logical sensor identifier.
 *
 * Constrained to `A-Z 0-9 _ - .` because this value becomes an MQTT topic
 * segment in Phase 3, and spaces or wildcards (`+`, `#`) there are a debugging
 * nightmare. Upper-cased so casing can never fork one sensor into two.
 *
 * @type {import('zod').ZodEffects<import('zod').ZodString, string, string>}
 */
export const sensorIdSchema = z
  .string()
  .trim()
  .min(1, 'Sensor ID cannot be empty')
  .max(128, 'Sensor ID cannot exceed 128 characters')
  .regex(
    /^[A-Za-z0-9_\-.]+$/,
    'Sensor ID may only contain letters, digits, underscore, hyphen, and dot ' +
      '(it becomes an MQTT topic segment downstream)',
  )
  .transform((value) => value.toUpperCase());

/**
 * Route params for `.../mesh-nodes/by-name/:meshName/sensor-binding`.
 *
 * `meshName` arrives percent-encoded because real names contain slashes;
 * Express decodes it before validation runs.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const meshNameParamSchema = z.object({
  assetId: objectIdSchema,
  meshName: meshNameSchema,
});

/**
 * Body for `PUT .../mesh-nodes/by-name/:meshName/sensor-binding` — the primary
 * "save a mapping" call.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const saveBindingSchema = z.object({
  sensorId: sensorIdSchema,
  sensorType: z.enum(/** @type {[string, ...string[]]} */ (SENSOR_TYPES)).optional(),

  // Mesh-node enrichment, applied when the node is created or refreshed.
  displayName: z.string().trim().max(200).nullish(),
  nodePath: z.string().trim().max(2000).nullish(),
  objectType: z.enum(/** @type {[string, ...string[]]} */ (MESH_OBJECT_TYPES)).optional(),

  boundBy: z.string().trim().max(120).nullish(),
  notes: optionalText(2000),

  /**
   * Opt in to moving a sensor that is currently bound to a different mesh.
   * Defaults to `false` so the safe outcome (a 409) is the one you get by
   * accident, and the destructive one requires intent.
   */
  reassign: booleanFlag(false),
});

/**
 * Body for `POST /assets/:assetId/mesh-nodes` — register a node without binding.
 * @type {import('zod').ZodObject<any>}
 */
export const registerMeshNodeSchema = z.object({
  meshName: meshNameSchema,
  displayName: z.string().trim().max(200).nullish(),
  nodePath: z.string().trim().max(2000).nullish(),
  objectType: z.enum(/** @type {[string, ...string[]]} */ (MESH_OBJECT_TYPES)).optional(),
  createdBy: z.string().trim().max(120).nullish(),
});

/**
 * Body for `PATCH /mesh-nodes/:meshNodeId`.
 *
 * `meshName` is absent by design: it is the join key into the glTF scene graph,
 * so renaming it would detach the node from its geometry.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const updateMeshNodeSchema = z
  .object({
    displayName: z.string().trim().max(200).nullish(),
    nodePath: z.string().trim().max(2000).nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * Query for `GET /assets/:assetId/mesh-nodes`.
 * @type {import('zod').ZodObject<any>}
 */
export const listMeshNodesQuerySchema = z.object({
  mappedOnly: booleanFlag(false),
});

/**
 * Query for `GET /assets/:assetId/sensor-bindings`.
 * @type {import('zod').ZodObject<any>}
 */
export const listBindingsQuerySchema = z.object({
  includeInactive: booleanFlag(false),
});

/**
 * Route params containing a single `:meshNodeId`.
 * @type {import('zod').ZodObject<any>}
 */
export const meshNodeIdParamSchema = z.object({
  meshNodeId: objectIdSchema,
});

/**
 * Route params containing a single `:bindingId`.
 * @type {import('zod').ZodObject<any>}
 */
export const bindingIdParamSchema = z.object({
  bindingId: objectIdSchema,
});

export default {
  meshNameSchema,
  sensorIdSchema,
  meshNameParamSchema,
  saveBindingSchema,
  registerMeshNodeSchema,
  updateMeshNodeSchema,
  listMeshNodesQuerySchema,
  listBindingsQuerySchema,
  meshNodeIdParamSchema,
  bindingIdParamSchema,
};
