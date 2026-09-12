/**
 * @file Standardised success envelope.
 *
 * Every successful response in this API has the exact same top-level shape, so
 * the frontend never has to special-case "does this endpoint return an array or
 * an object?". RTK Query transforms responses by reading `.data` uniformly.
 *
 * ```json
 * { "success": true, "data": { ... }, "message": "…", "meta": { … } }
 * ```
 *
 * The mirrored failure shape (`success: false`, `data: null`, plus `errors`)
 * is produced by `middleware/errorHandler.middleware.js`.
 *
 * @module utils/ApiResponse
 */

/**
 * Pagination descriptor attached to list responses.
 * @typedef {object} PaginationMeta
 * @property {number} page - 1-based page index that was returned.
 * @property {number} limit - Maximum items per page.
 * @property {number} total - Total matching documents across all pages.
 * @property {number} totalPages - Total number of pages available.
 * @property {boolean} hasNextPage - Whether a further page exists.
 */

/**
 * Success envelope.
 *
 * @template T
 */
export class ApiResponse {
  /**
   * @param {T} data - Payload. Use `null` for endpoints with no body (e.g. deletes).
   * @param {string} [message] - Short human-readable summary.
   * @param {PaginationMeta|object} [meta] - Optional metadata (pagination, counts).
   */
  constructor(data, message = 'OK', meta = undefined) {
    /** @type {true} Always true — mirrors `success: false` on the error path. */
    this.success = true;

    /** @type {T} */
    this.data = data;

    /** @type {string} */
    this.message = message;

    // Only serialise `meta` when it carries something, to keep payloads lean.
    if (meta !== undefined) {
      /** @type {PaginationMeta|object|undefined} */
      this.meta = meta;
    }
  }
}

/**
 * Send a `200 OK` success envelope.
 *
 * @template T
 * @param {import('express').Response} res - Express response.
 * @param {T} data - Payload.
 * @param {string} [message] - Summary message.
 * @param {PaginationMeta|object} [meta] - Optional metadata.
 * @returns {import('express').Response} The response, for `return` chaining.
 */
export function sendOk(res, data, message = 'OK', meta = undefined) {
  return res.status(200).json(new ApiResponse(data, message, meta));
}

/**
 * Send a `201 Created` success envelope.
 *
 * @template T
 * @param {import('express').Response} res - Express response.
 * @param {T} data - The newly created resource.
 * @param {string} [message] - Summary message.
 * @returns {import('express').Response} The response, for `return` chaining.
 */
export function sendCreated(res, data, message = 'Created') {
  return res.status(201).json(new ApiResponse(data, message));
}

/**
 * Build a {@link PaginationMeta} object from raw counts.
 *
 * @param {object} params
 * @param {number} params.page - 1-based page index.
 * @param {number} params.limit - Page size.
 * @param {number} params.total - Total matching documents.
 * @returns {PaginationMeta} Normalised pagination metadata.
 */
export function buildPaginationMeta({ page, limit, total }) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
  };
}

export default ApiResponse;
