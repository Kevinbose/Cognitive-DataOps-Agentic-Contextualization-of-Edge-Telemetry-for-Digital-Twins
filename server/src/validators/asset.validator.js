/**
 * @file Request schemas for the asset endpoints.
 *
 * @module validators/asset.validator
 */

import { z } from 'zod';

import { ASSET_STATUSES, SOURCE_TYPES } from '../models/Asset.model.js';
import { nonEmptyString, optionalText, paginationSchema } from './common.validator.js';

/**
 * Body for `POST /assets`.
 *
 * Sent as `multipart/form-data` alongside the optional CAD file, so every value
 * arrives as a string — `partCount` is coerced rather than declared as a number.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const createAssetSchema = z.object({
  name: nonEmptyString({ max: 200, label: 'Asset name' }),
  uploader: nonEmptyString({ max: 120, label: 'Uploader' }),
  sourceType: z.enum(/** @type {[string, ...string[]]} */ (SOURCE_TYPES)).optional(),
  notes: optionalText(2000),
});

/**
 * Body for `PATCH /assets/:assetId`.
 *
 * Only descriptive fields are editable. `status`, `version`, and the file
 * sub-documents are pipeline-owned and deliberately unreachable here — a client
 * must not be able to declare an asset `mapped` without doing the mapping.
 *
 * @type {import('zod').ZodObject<any>}
 */
export const updateAssetSchema = z
  .object({
    name: nonEmptyString({ max: 200, label: 'Asset name' }).optional(),
    notes: optionalText(2000),
    units: z.string().trim().max(32).nullish(),
    partCount: z.coerce.number().int().min(0).nullish(),
  })
  // Reject an empty PATCH rather than performing a pointless write.
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * Query for `GET /assets`.
 * @type {import('zod').ZodObject<any>}
 */
export const listAssetsQuerySchema = paginationSchema.extend({
  status: z.enum(/** @type {[string, ...string[]]} */ (ASSET_STATUSES)).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export default { createAssetSchema, updateAssetSchema, listAssetsQuerySchema };
