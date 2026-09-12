/**
 * @file Storage layout constants and key construction.
 *
 * This module defines the *shape* of the object store; `services/storage.service.js`
 * performs the actual I/O. Keeping key construction separate means the naming
 * convention is testable in isolation and identical whether the bytes land on
 * the local filesystem today or in an S3 bucket later.
 *
 * Key format (deliberately S3-flavoured — forward slashes, no leading slash):
 *
 *   assets/<assetId>/original.stp
 *   assets/<assetId>/converted.glb
 *
 * @module config/storage.config
 */

import path from 'node:path';
import { config } from './env.config.js';

/**
 * Top-level "folder" prefix for asset binaries inside the bucket.
 * @type {string}
 */
export const ASSET_PREFIX = 'assets';

/**
 * Canonical filenames stored per asset. Using fixed names (rather than the
 * user's original filename) keeps keys predictable and sidesteps an entire
 * class of path-traversal and unicode-filename bugs. The user-supplied name is
 * still preserved in MongoDB as `originalName` for display and download.
 *
 * @readonly
 * @enum {string}
 */
export const CANONICAL_FILENAME = Object.freeze({
  ORIGINAL: 'original',
  CONVERTED: 'converted.glb',
});

/**
 * Absolute path to the bucket root on disk.
 * @type {string}
 */
export const STORAGE_ROOT = config.storageRoot;

/**
 * Absolute path to the scratch directory that Multer writes to before a file
 * is accepted. Uploads land here first so that a rejected file (bad magic
 * bytes, oversized, wrong extension) never pollutes the real bucket.
 * @type {string}
 */
export const TEMP_UPLOAD_DIR = path.join(STORAGE_ROOT, '.tmp-uploads');

/**
 * Build the storage key for an asset's raw CAD file.
 *
 * The original extension is preserved (`.stp`, `.step`, `.iges`, ...) because
 * downstream CAD tooling is extension-sensitive, unlike the always-`.glb`
 * converted artefact.
 *
 * @param {string} assetId - MongoDB ObjectId as a string.
 * @param {string} extension - File extension including the leading dot, e.g. `".stp"`.
 * @returns {string} Bucket-relative key, e.g. `"assets/65f.../original.stp"`.
 */
export function buildOriginalKey(assetId, extension) {
  const normalised = extension.startsWith('.') ? extension : `.${extension}`;
  return `${ASSET_PREFIX}/${assetId}/${CANONICAL_FILENAME.ORIGINAL}${normalised.toLowerCase()}`;
}

/**
 * Build the storage key for an asset's converted `.glb` file.
 *
 * @param {string} assetId - MongoDB ObjectId as a string.
 * @returns {string} Bucket-relative key, e.g. `"assets/65f.../converted.glb"`.
 */
export function buildConvertedKey(assetId) {
  return `${ASSET_PREFIX}/${assetId}/${CANONICAL_FILENAME.CONVERTED}`;
}

/**
 * Build the bucket-relative "directory" prefix owned by a single asset.
 *
 * @param {string} assetId - MongoDB ObjectId as a string.
 * @returns {string} e.g. `"assets/65f..."`.
 */
export function buildAssetPrefix(assetId) {
  return `${ASSET_PREFIX}/${assetId}`;
}

/**
 * Public URL path (served by `express.static`) for a given storage key.
 *
 * The frontend feeds this straight into drei's `useGLTF`, so the file is served
 * by the static middleware — which supports HTTP range requests — rather than
 * being proxied through a controller.
 *
 * @param {string} storageKey - Bucket-relative key.
 * @returns {string} e.g. `"/static/assets/65f.../converted.glb"`.
 */
export function buildPublicPath(storageKey) {
  return `/static/${storageKey}`;
}

export default {
  ASSET_PREFIX,
  CANONICAL_FILENAME,
  STORAGE_ROOT,
  TEMP_UPLOAD_DIR,
  buildOriginalKey,
  buildConvertedKey,
  buildAssetPrefix,
  buildPublicPath,
};
