/**
 * @file Async controller wrapper.
 *
 * Express 4 does not understand promises: if an `async` handler rejects, the
 * rejection is unhandled and the request hangs until the client times out —
 * no error, no log, no response. Wrapping every async controller routes those
 * rejections into `next()` so the global error handler always runs.
 *
 * @module middleware/asyncHandler
 */

/**
 * @callback AsyncRequestHandler
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {Promise<unknown>}
 */

/**
 * Wrap an async request handler so rejections reach the error middleware.
 *
 * @param {AsyncRequestHandler} handler - The async controller to wrap.
 * @returns {import('express').RequestHandler} An Express-safe handler.
 *
 * @example
 * router.get('/assets', asyncHandler(assetController.list));
 */
export function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export default asyncHandler;
