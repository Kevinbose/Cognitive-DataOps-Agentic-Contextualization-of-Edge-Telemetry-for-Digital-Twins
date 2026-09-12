/**
 * @file Catch-all for unmatched routes.
 *
 * Mounted after every router so an unknown path produces the same JSON envelope
 * as any other error, instead of Express's default HTML error page — which
 * would break a fetch client expecting JSON.
 *
 * @module middleware/notFound.middleware
 */

import { ApiError } from '../utils/ApiError.js';

/**
 * Convert any unmatched request into a 404 `ApiError`.
 *
 * @param {import('express').Request} req - Incoming request.
 * @param {import('express').Response} _res - Unused.
 * @param {import('express').NextFunction} next - Passes control to the error handler.
 * @returns {void}
 */
export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} does not exist on this API`));
}

export default notFoundHandler;
