/**
 * @file Request schemas for the device endpoints.
 *
 * @module validators/device.validator
 */

import { z } from 'zod';

import { MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';
import { objectIdSchema } from './common.validator.js';

/** Route params containing a single `:machineId`. */
export const machineIdParamSchema = z.object({
  machineId: z.string().regex(MACHINE_ID_PATTERN, 'Machine id must be lowercase kebab-case'),
});

const scenarioArgs = z
  .object({
    name: z.literal('scenario'),
    args: z
      .object({
        scenario: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, 'Scenario must be UPPER_SNAKE_CASE'),
        rampSec: z.number().int().min(5).max(600).optional(),
      })
      .strict(),
  })
  .strict();

const intervalArgs = z
  .object({
    name: z.literal('interval'),
    args: z.object({ intervalMs: z.number().int().min(250).max(5000) }).strict(),
  })
  .strict();

const noArgs = (name) =>
  z
    .object({
      name: z.literal(name),
      args: z.object({}).strict().optional().default({}),
    })
    .strict();

/**
 * Body for `POST /devices/:machineId/commands`.
 *
 * A discriminated union so each command validates only its own arguments, and a
 * typo in a command name fails at the edge instead of reaching the broker.
 * The scenario name is checked against the device's own declared scenarios in
 * `device.service.js`, because that list comes from its `birth` message.
 */
export const commandBodySchema = z.discriminatedUnion('name', [
  scenarioArgs,
  intervalArgs,
  noArgs('reboot'),
  noArgs('ping'),
]);

/** Body for `POST /assets/:assetId/machines`: which discovered machine to add. */
export const addMachineBodySchema = z
  .object({
    machineId: z.string().regex(MACHINE_ID_PATTERN, 'Machine id must be lowercase kebab-case'),
  })
  .strict();

/** Params for `DELETE /assets/:assetId/machines/:machineId`. */
export const assetMachineParamSchema = z.object({
  assetId: objectIdSchema,
  machineId: z.string().regex(MACHINE_ID_PATTERN, 'Machine id must be lowercase kebab-case'),
});

export default { machineIdParamSchema, commandBodySchema, addMachineBodySchema, assetMachineParamSchema };
