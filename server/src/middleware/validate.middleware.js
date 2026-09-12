/**
 * @file Zod-backed request validation.
 *
 * Validation runs at the edge so services can trust their inputs. Everything a
 * handler receives has already been parsed, coerced, and stripped of unknown
 * keys — which means a service never has to defend against `page="abc"` or a
 * client sneaking `status: "mapped"` into a PATCH body.
 *
 * @module middleware/validate.middleware
 */

import { ApiError } from '../utils/ApiError.js';

/**
 * Which parts of the request to validate. Each value is a Zod schema.
 *
 * @typedef {object} ValidationSchemas
 * @property {import('zod').ZodTypeAny} [body] - Schema for `req.body`.
 * @property {import('zod').ZodTypeAny} [params] - Schema for `req.params`.
 * @property {import('zod').ZodTypeAny} [query] - Schema for `req.query`.
 */

/**
 * Convert a Zod error into the API's flat field-error list.
 *
 * @param {import('zod').ZodError} zodError - The validation failure.
 * @param {string} source - Which request part failed (`body` / `params` / `query`).
 * @returns {import('../utils/ApiError.js').FieldError[]} Field-level errors.
 */
function toFieldErrors(zodError, source) {
  return zodError.issues.map((issue) => ({
    // Prefix with the source so `"body.sensorId"` is unambiguous when a request
    // has a same-named field in more than one place.
    field: [source, ...issue.path].join('.'),
    message: issue.message,
  }));
}

/**
 * Build validation middleware for one or more request parts.
 *
 * Parsed output replaces the raw input, so downstream code gets coerced types
 * (e.g. `page` as a real `number`) rather than raw strings.
 *
 * @param {ValidationSchemas} schemas - Schemas to apply.
 * @returns {import('express').RequestHandler} Validation middleware.
 *
 * @example
 * router.get('/assets', validate({ query: listAssetsQuerySchema }), handler);
 */
export function validate(schemas) {
  return function validateMiddleware(req, _res, next) {
    /** @type {import('../utils/ApiError.js').FieldError[]} */
    const errors = [];

    for (const source of /** @type {const} */ (['params', 'query', 'body'])) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (!result.success) {
        errors.push(...toFieldErrors(result.error, source));
        continue;
      }

      // `req.query` is a getter-only property on some Express/Node combinations,
      // so assignment is done defensively rather than with a bare `=`.
      Object.defineProperty(req, source, {
        value: result.data,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    }

    if (errors.length > 0) {
      // Report every problem at once. Returning them one at a time turns form
      // correction into a guessing game.
      next(ApiError.validation(errors));
      return;
    }

    next();
  };
}

export default validate;
