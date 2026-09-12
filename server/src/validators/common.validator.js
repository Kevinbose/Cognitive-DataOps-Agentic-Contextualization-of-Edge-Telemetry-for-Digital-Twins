/**
 * @file Shared Zod primitives reused across validators.
 *
 * @module validators/common.validator
 */

import mongoose from 'mongoose';
import { z } from 'zod';

/**
 * A MongoDB ObjectId supplied as a 24-character hex string.
 *
 * Validating this at the edge means a malformed id returns a clean 422 instead
 * of surfacing as a Mongoose `CastError` from somewhere deep in a service.
 *
 * @type {import('zod').ZodString}
 */
export const objectIdSchema = z
  .string()
  .refine((value) => mongoose.Types.ObjectId.isValid(value), {
    message: 'Must be a valid MongoDB ObjectId (24-character hex string)',
  });

/**
 * A non-empty, trimmed string with an upper length bound.
 *
 * @param {object} [options]
 * @param {number} [options.max] - Maximum length after trimming.
 * @param {string} [options.label] - Field name used in error messages.
 * @returns {import('zod').ZodString} Configured schema.
 */
export function nonEmptyString({ max = 200, label = 'Value' } = {}) {
  return z
    .string()
    .trim()
    .min(1, `${label} cannot be empty`)
    .max(max, `${label} cannot exceed ${max} characters`);
}

/**
 * Optional free-text field that accepts `null` to explicitly clear the value.
 *
 * The `null` case matters: a PATCH sending `{"notes": null}` means "erase the
 * notes", which is different from omitting the key entirely ("leave unchanged").
 *
 * @param {number} [max] - Maximum length.
 * @returns {import('zod').ZodTypeAny} Configured schema.
 */
export function optionalText(max = 2000) {
  return z.string().trim().max(max).nullish();
}

/**
 * A boolean supplied as a query-string or form-field value.
 *
 * `z.coerce.boolean()` must NOT be used for this: it applies JavaScript's
 * `Boolean()`, and `Boolean("false") === true`, so `?flag=false` would silently
 * mean *true* — a bug that reads as correct code. This parser matches the
 * literal tokens instead and rejects anything ambiguous.
 *
 * @param {boolean} [defaultValue] - Value used when the field is absent.
 * @returns {import('zod').ZodTypeAny} Configured schema.
 */
export function booleanFlag(defaultValue = false) {
  return z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return value === 'true' || value === '1' || value === 'yes';
    });
}

/**
 * Standard pagination query parameters.
 *
 * Query strings are always strings, so `coerce` converts them to numbers before
 * the integer and range checks run.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Capped at 100 so a client cannot request the entire collection in one page.
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Route params containing a single `:assetId`.
 * @type {import('zod').ZodObject<any>}
 */
export const assetIdParamSchema = z.object({
  assetId: objectIdSchema,
});

export default {
  objectIdSchema,
  nonEmptyString,
  optionalText,
  booleanFlag,
  paginationSchema,
  assetIdParamSchema,
};
