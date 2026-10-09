/**
 * @file Service-to-service authentication for the agent's endpoints.
 *
 * The agent presents the shared service key as a bearer token. Requests are
 * also refused from anything but loopback unless an explicit
 * `AGENT_SERVICE_KEY` was configured (a deployment that runs the agent on
 * another host has chosen its own key on purpose).
 *
 * @module middleware/serviceAuth.middleware
 */

import { config } from '../config/env.config.js';
import { isValidServiceAuth } from '../services/agentKey.service.js';
import { ApiError } from '../utils/ApiError.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function requireServiceAuth(req, _res, next) {
  if (!config.agent.serviceKey && !LOOPBACK.has(req.socket.remoteAddress ?? '')) {
    next(ApiError.forbidden('The agent endpoints are loopback-only unless AGENT_SERVICE_KEY is set'));
    return;
  }
  if (!isValidServiceAuth(req.headers.authorization)) {
    next(new ApiError(401, 'A valid service bearer token is required'));
    return;
  }
  next();
}

export default requireServiceAuth;
