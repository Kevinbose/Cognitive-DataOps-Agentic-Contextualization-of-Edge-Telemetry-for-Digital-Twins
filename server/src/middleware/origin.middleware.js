/**
 * @file Origin guard for state-changing device endpoints.
 *
 * CORS protects a browser from reading another origin's responses; it does not
 * stop a hostile page from SENDING a request to a server on the visitor's own
 * machine. The command endpoint can reboot a machine, and the API has no
 * authentication yet, so it adds an explicit allow-list check: a request that
 * carries an `Origin` header must carry an allowed one.
 *
 * Requests with no `Origin` (curl, scripts, server-to-server) pass, because
 * only browsers send one, and the server binds to loopback by default.
 *
 * @module middleware/origin.middleware
 */

import { config } from '../config/env.config.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Reject requests from browser origins that are not on the allow-list.
 *
 * @type {import('express').RequestHandler}
 */
export function requireAllowedOrigin(req, _res, next) {
  const origin = req.get('origin');

  if (origin && !config.corsOrigins.includes(origin)) {
    next(ApiError.forbidden(`Origin "${origin}" is not allowed to send device commands`));
    return;
  }

  next();
}

export default requireAllowedOrigin;
