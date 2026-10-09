/**
 * @file Browser API for Phase 5: agent status, investigations, reports, chat.
 *
 * @module routes/agent.routes
 */

import { Router } from 'express';

import * as agentController from '../controllers/agent.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.middleware.js';
import {
  chatBodySchema,
  listInvestigationsQuerySchema,
  listReportsQuerySchema,
  reportIdParamSchema,
  threadIdParamSchema,
} from '../validators/agent.validator.js';

export const agentRouter = Router();
agentRouter.get('/status', asyncHandler(agentController.getStatus));

export const investigationRouter = Router();
investigationRouter.get('/', validate({ query: listInvestigationsQuerySchema }), asyncHandler(agentController.listInvestigations));

export const reportRouter = Router();
reportRouter.get('/', validate({ query: listReportsQuerySchema }), asyncHandler(agentController.listReports));
reportRouter.get('/:reportId', validate({ params: reportIdParamSchema }), asyncHandler(agentController.getReport));

export const assistantRouter = Router();
assistantRouter.post('/chat', validate({ body: chatBodySchema }), asyncHandler(agentController.chat));
assistantRouter.get('/threads/:threadId', validate({ params: threadIdParamSchema }), asyncHandler(agentController.getThread));

export default { agentRouter, investigationRouter, reportRouter, assistantRouter };
