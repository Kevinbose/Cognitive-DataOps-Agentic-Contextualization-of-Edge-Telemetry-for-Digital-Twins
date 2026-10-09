/**
 * @file Request schemas for the agent, report and assistant endpoints.
 *
 * @module validators/agent.validator
 */

import { z } from 'zod';

import { MACHINE_ID_PATTERN } from '../utils/mqttTopics.js';
import { SESSION_ID_PATTERN } from '../services/websocket.service.js';
import { objectIdSchema } from './common.validator.js';

const boolString = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

export const listInvestigationsQuerySchema = z
  .object({
    assetId: objectIdSchema.optional(),
    active: boolString.optional().default('true'),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .strict();

export const listReportsQuerySchema = z
  .object({
    assetId: objectIdSchema.optional(),
    machineId: z.string().regex(MACHINE_ID_PATTERN).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();

export const reportIdParamSchema = z.object({ reportId: objectIdSchema });

export const THREAD_ID_PATTERN = /^[A-Za-z0-9:_-]{8,96}$/;

export const threadIdParamSchema = z.object({ threadId: z.string().regex(THREAD_ID_PATTERN) });

export const chatBodySchema = z
  .object({
    message: z.string().trim().min(1, 'Type a question first').max(2000),
    threadId: z.string().regex(THREAD_ID_PATTERN),
    sessionId: z.string().regex(SESSION_ID_PATTERN),
    context: z
      .object({
        scope: z.enum(['plant', 'twin']),
        assetId: objectIdSchema.optional(),
        selectedMesh: z.string().max(512).nullish(),
        hoveredMesh: z.string().max(512).nullish(),
        activePanel: z.enum(['machines', 'components', 'telemetry', 'faults']).nullish(),
        reportId: objectIdSchema.nullish(),
      })
      .strict()
      .refine((c) => c.scope === 'plant' || Boolean(c.assetId), 'A twin conversation needs the twin id'),
  })
  .strict();

export default {
  listInvestigationsQuerySchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  threadIdParamSchema,
  chatBodySchema,
};
