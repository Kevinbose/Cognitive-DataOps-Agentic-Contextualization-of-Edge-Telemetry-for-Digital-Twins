/**
 * @file `/mcp`: the Model Context Protocol endpoint the diagnosis agent uses.
 *
 * Mounted outside `/api/v1` because it is not part of the browser API: it is
 * service-to-service, bearer-authenticated and loopback-only by default.
 *
 * @module routes/mcp.routes
 */

import { Router } from 'express';

import { handleMcp, mcpMethodNotAllowed } from '../controllers/mcp.controller.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { requireServiceAuth } from '../middleware/serviceAuth.middleware.js';

export const mcpRouter = Router();

mcpRouter.post('/', requireServiceAuth, asyncHandler(handleMcp));
mcpRouter.get('/', requireServiceAuth, mcpMethodNotAllowed);
mcpRouter.delete('/', requireServiceAuth, mcpMethodNotAllowed);

export default mcpRouter;
