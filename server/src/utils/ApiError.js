/**
 * @file Operational error type for the API.
 *
 * `ApiError` marks an error as *expected* — a client sent bad input, asked for
 * something that does not exist, or violated a business rule. The global error
 * handler renders these with their intended status code and message.
 *
 * Anything that is NOT an `ApiError` is treated as an unexpected programmer
 * error: logged with a full stack trace and rendered as a generic 500 so we
 * never leak internals to a browser.
 *
 * @module utils/ApiError
 */

/**
 * A single field-level validation problem.
 * @typedef {object} FieldError
 * @property {string} field - Dot-path of the offending field, e.g. `"body.sensorId"`.
 * @property {string} message - Human-readable explanation.
 */

/**
 * Operational (expected) API error.
 *
 * @extends Error
 */
export class ApiError extends Error {
  /**
   * @param {number} statusCode - HTTP status code to return.
   * @param {string} message - Client-safe message.
   * @param {FieldError[]} [errors] - Optional field-level validation details.
   * @param {object} [options] - Extra options.
   * @param {unknown} [options.cause] - Underlying error, preserved for logs.
   */
  constructor(statusCode, message, errors = [], options = {}) {
    super(message, { cause: options.cause });

    /** @type {string} */
    this.name = 'ApiError';

    /** @type {number} HTTP status code. */
    this.statusCode = statusCode;

    /** @type {FieldError[]} Field-level details, empty for non-validation errors. */
    this.errors = errors;

    /**
     * Marks this as a known, safe-to-surface failure. The error handler uses
     * this flag rather than an `instanceof` check so errors that cross module
     * or realm boundaries are still classified correctly.
     * @type {true}
     */
    this.isOperational = true;

    Error.captureStackTrace?.(this, ApiError);
  }

  /* ─── Named constructors ───────────────────────────────────────────────── */
  /* Using these instead of raw status codes keeps call sites self-documenting
     and prevents the classic 400-vs-422 inconsistency across a codebase. */

  /**
   * 400 — the request was malformed or semantically wrong.
   * @param {string} [message]
   * @param {FieldError[]} [errors]
   * @returns {ApiError}
   */
  static badRequest(message = 'Bad request', errors = []) {
    return new ApiError(400, message, errors);
  }

  /**
   * 404 — the addressed resource does not exist (or is soft-deleted).
   * @param {string} [message]
   * @returns {ApiError}
   */
  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }

  /**
   * 409 — the request conflicts with current state, e.g. a uniqueness rule.
   * @param {string} [message]
   * @param {FieldError[]} [errors]
   * @returns {ApiError}
   */
  static conflict(message = 'Conflict with current resource state', errors = []) {
    return new ApiError(409, message, errors);
  }

  /**
   * 413 — the uploaded payload exceeded the configured size ceiling.
   * @param {string} [message]
   * @returns {ApiError}
   */
  static payloadTooLarge(message = 'Uploaded file is too large') {
    return new ApiError(413, message);
  }

  /**
   * 415 — the uploaded file's type is not supported by this endpoint.
   * @param {string} [message]
   * @returns {ApiError}
   */
  static unsupportedMediaType(message = 'Unsupported file type') {
    return new ApiError(415, message);
  }

  /**
   * 422 — the request was well-formed but failed schema validation.
   * @param {FieldError[]} errors - Field-level failures from the validator.
   * @param {string} [message]
   * @returns {ApiError}
   */
  static validation(errors, message = 'Request validation failed') {
    return new ApiError(422, message, errors);
  }

  /**
   * 500 — an unexpected internal failure the client cannot act on.
   * @param {string} [message]
   * @param {unknown} [cause]
   * @returns {ApiError}
   */
  static internal(message = 'Internal server error', cause = undefined) {
    return new ApiError(500, message, [], { cause });
  }
}

export default ApiError;
