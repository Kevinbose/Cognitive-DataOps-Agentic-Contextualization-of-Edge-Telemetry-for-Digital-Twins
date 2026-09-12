/**
 * @file The single global error handler.
 *
 * Every failure in the API converges here: thrown `ApiError`s, Mongoose
 * validation and cast errors, MongoDB duplicate-key violations, Multer upload
 * limits, and genuine programmer bugs. Each is normalised into one envelope:
 *
 * ```json
 * { "success": false, "data": null, "message": "…", "errors": [ … ] }
 * ```
 *
 * Two rules govern what reaches the client:
 *   1. Operational errors (`ApiError`) keep their status and message — they
 *      exist to be shown to a user.
 *   2. Everything else becomes a generic 500. An unexpected exception's message
 *      can carry connection strings, file paths, or query fragments, none of
 *      which belong in a browser. The full detail goes to the server log.
 *
 * @module middleware/errorHandler.middleware
 */

import multer from 'multer';
import mongoose from 'mongoose';

import { config } from '../config/env.config.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Translate a Multer error into an `ApiError`.
 *
 * @param {import('multer').MulterError} error - The Multer failure.
 * @returns {ApiError} Normalised operational error.
 */
function fromMulterError(error) {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return ApiError.payloadTooLarge(
        `File exceeds the maximum allowed size ` +
          `(CAD: ${Math.round(config.maxCadUploadBytes / 1024 / 1024)} MB, ` +
          `GLB: ${Math.round(config.maxGlbUploadBytes / 1024 / 1024)} MB).`,
      );
    case 'LIMIT_FILE_COUNT':
      return ApiError.badRequest('Only one file may be uploaded per request.');
    case 'LIMIT_UNEXPECTED_FILE':
      return ApiError.badRequest(
        `Unexpected file field "${error.field}". Check the multipart field name.`,
      );
    default:
      return ApiError.badRequest(`File upload failed: ${error.message}`);
  }
}

/**
 * Translate a MongoDB duplicate-key error into a readable conflict.
 *
 * These are not incidental — the partial unique indexes on `SensorBinding` are
 * the primary enforcement of the mapping invariants, so this path is a designed
 * outcome rather than a surprise.
 *
 * @param {object} error - The raw MongoServerError with `code === 11000`.
 * @returns {ApiError} Normalised 409.
 */
function fromDuplicateKeyError(error) {
  const fields = Object.keys(error.keyPattern ?? {});

  /** @type {Record<string, string>} Index name → human explanation. */
  const explanations = {
    uniq_active_sensor: 'That sensor already has an active binding to another mesh.',
    uniq_active_mesh_binding: 'That mesh already has an active sensor binding.',
    uniq_live_mesh_per_asset: 'That mesh name is already registered for this asset.',
  };

  const message =
    explanations[error.message?.match(/index: (\w+)/)?.[1]] ??
    `A record with the same ${fields.join(' + ') || 'unique value'} already exists.`;

  return ApiError.conflict(
    message,
    fields.map((field) => ({ field, message: 'Must be unique' })),
  );
}

/**
 * Translate a Mongoose schema-validation failure into a 422.
 *
 * @param {import('mongoose').Error.ValidationError} error - The failure.
 * @returns {ApiError} Normalised 422 with per-field detail.
 */
function fromMongooseValidationError(error) {
  const errors = Object.values(error.errors).map((issue) => ({
    field: issue.path,
    message: issue.message,
  }));
  return ApiError.validation(errors, 'Document validation failed');
}

/**
 * Express error-handling middleware.
 *
 * Must be registered **last** in `app.js`, and must keep all four parameters —
 * Express identifies error handlers by arity, so dropping the unused `next`
 * silently turns this into an ordinary middleware that never runs.
 *
 * @param {unknown} error - Whatever was thrown or passed to `next()`.
 * @param {import('express').Request} req - Incoming request.
 * @param {import('express').Response} res - Outgoing response.
 * @param {import('express').NextFunction} _next - Required for arity detection.
 * @returns {void}
 */
// eslint-disable-next-line no-unused-vars -- four-arg signature is required by Express
export function errorHandler(error, req, res, _next) {
  /** @type {ApiError} */
  let normalised;

  if (error instanceof ApiError || error?.isOperational === true) {
    normalised = /** @type {ApiError} */ (error);
  } else if (error instanceof multer.MulterError) {
    normalised = fromMulterError(error);
  } else if (error?.code === 11000) {
    normalised = fromDuplicateKeyError(error);
  } else if (error instanceof mongoose.Error.ValidationError) {
    normalised = fromMongooseValidationError(error);
  } else if (error instanceof mongoose.Error.CastError) {
    normalised = ApiError.badRequest(
      `"${error.value}" is not a valid ${error.kind} for field "${error.path}"`,
    );
  } else if (error instanceof SyntaxError && 'body' in error) {
    // Thrown by express.json() when a client sends malformed JSON.
    normalised = ApiError.badRequest('Request body is not valid JSON');
  } else {
    normalised = ApiError.internal('An unexpected error occurred', error);
  }

  // Log server-side faults and genuine bugs with full context. Client mistakes
  // (4xx) are not logged as errors — they would drown out real signal.
  if (normalised.statusCode >= 500) {
    console.error(
      `[error] ${req.method} ${req.originalUrl} → ${normalised.statusCode}`,
      error instanceof Error ? error.stack : error,
    );
  }

  /** @type {{success: false, data: null, message: string, errors?: object[], stack?: string}} */
  const payload = {
    success: false,
    data: null,
    message: normalised.message,
  };

  if (normalised.errors?.length > 0) {
    payload.errors = normalised.errors;
  }

  // Stack traces are a development affordance only — never shipped to a client
  // in production, where they would expose internal file layout.
  if (!config.isProduction && normalised.statusCode >= 500 && error instanceof Error) {
    payload.stack = error.stack;
  }

  res.status(normalised.statusCode).json(payload);
}

export default errorHandler;
