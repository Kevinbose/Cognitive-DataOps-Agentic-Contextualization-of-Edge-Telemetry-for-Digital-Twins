/**
 * @file Object-storage service — the **only** module that performs file I/O.
 *
 * Every other layer deals exclusively in bucket-relative *storage keys*
 * (`"assets/<id>/converted.glb"`), never absolute paths. That single constraint
 * is what makes the eventual migration to real S3 a one-file change: swap
 * `fs.rename` for `s3.putObject`, `fs.createReadStream` for `s3.getObject`, and
 * no controller, route, or model needs to know.
 *
 * @module services/storage.service
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { STORAGE_ROOT, TEMP_UPLOAD_DIR, buildAssetPrefix } from '../config/storage.config.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * The four magic bytes that open every binary glTF file: ASCII `glTF`.
 * Defined by the glTF 2.0 specification's 12-byte header.
 * @type {Buffer}
 */
const GLB_MAGIC = Buffer.from('glTF', 'ascii');

/**
 * Create the storage directories if they do not exist yet.
 * Called once during server boot so the first upload never races directory
 * creation.
 *
 * @returns {Promise<void>}
 */
export async function ensureStorageReady() {
  await fs.mkdir(path.join(STORAGE_ROOT, 'assets'), { recursive: true });
  await fs.mkdir(TEMP_UPLOAD_DIR, { recursive: true });
}

/**
 * Translate a bucket-relative storage key into an absolute filesystem path,
 * refusing anything that would escape the bucket root.
 *
 * This is a genuine security boundary, not ceremony: storage keys are built
 * from database values, and a malformed or tampered key containing `../`
 * segments must never be able to read or delete files elsewhere on the host.
 *
 * @param {string} storageKey - Bucket-relative key.
 * @returns {string} Absolute path inside the bucket.
 * @throws {ApiError} 400 when the key resolves outside the storage root.
 */
export function resolveAbsolutePath(storageKey) {
  const absolute = path.resolve(STORAGE_ROOT, storageKey);
  const rootWithSeparator = path.resolve(STORAGE_ROOT) + path.sep;

  if (!absolute.startsWith(rootWithSeparator)) {
    throw ApiError.badRequest(`Invalid storage key: "${storageKey}"`);
  }
  return absolute;
}

/**
 * Stream a file through SHA-256 and return the lowercase hex digest.
 *
 * Streaming rather than `readFile` keeps memory flat: a 20 MB CAD file — or a
 * future 500 MB one — never lands in a single buffer.
 *
 * @param {string} absolutePath - Absolute path of the file to hash.
 * @returns {Promise<string>} Lowercase hex SHA-256 digest.
 */
export async function computeChecksum(absolutePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest('hex');
}

/**
 * Verify that a file really is a binary glTF by inspecting its magic bytes.
 *
 * Extension and MIME checks are trivially spoofed — a `.stp` renamed to `.glb`
 * passes both, then fails confusingly inside the browser's loader. Reading four
 * bytes catches it at the API boundary with a clear error and costs nothing.
 *
 * @param {string} absolutePath - Absolute path of the candidate `.glb`.
 * @returns {Promise<void>} Resolves when the file is a valid GLB container.
 * @throws {ApiError} 415 when the magic bytes do not match.
 */
export async function assertGlbMagic(absolutePath) {
  let handle;
  try {
    handle = await fs.open(absolutePath, 'r');
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);

    if (bytesRead < 4 || !buffer.equals(GLB_MAGIC)) {
      throw ApiError.unsupportedMediaType(
        'File is not a valid binary glTF (.glb): expected the file to begin with the ' +
          'ASCII magic bytes "glTF". A .gltf + .bin pair must be packed into a single ' +
          '.glb first, for example with `npx gltf-pipeline -i model.gltf -o model.glb`.',
      );
    }
  } finally {
    await handle?.close();
  }
}

/**
 * Move a file into the bucket, overwriting any existing object at that key.
 *
 * `fs.rename` is attempted first because it is atomic and instant within one
 * filesystem. It fails with `EXDEV` when the temp directory and the bucket live
 * on different volumes (common on Windows with a non-default `STORAGE_ROOT`),
 * so a copy-then-unlink fallback covers that case.
 *
 * @param {string} tempPath - Absolute path of the staged upload.
 * @param {string} storageKey - Destination bucket-relative key.
 * @returns {Promise<string>} Absolute path of the stored object.
 */
async function moveIntoBucket(tempPath, storageKey) {
  const destination = resolveAbsolutePath(storageKey);
  await fs.mkdir(path.dirname(destination), { recursive: true });

  try {
    await fs.rename(tempPath, destination);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(tempPath, destination);
    await fs.unlink(tempPath);
  }

  return destination;
}

/**
 * Accept a staged upload into permanent storage and describe it.
 *
 * @param {object} params
 * @param {string} params.tempPath - Absolute path Multer wrote the upload to.
 * @param {string} params.storageKey - Destination key from `storage.config.js`.
 * @param {string} params.originalName - Filename as supplied by the client.
 * @param {string} params.mimeType - Reported MIME type.
 * @param {boolean} [params.verifyGlb] - When true, enforce GLB magic bytes
 *   *before* the file is allowed into the bucket.
 * @returns {Promise<import('../models/Asset.model.js').FileArtifact>} Artefact
 *   descriptor ready to assign to `Asset.originalFile` / `Asset.convertedFile`.
 * @throws {ApiError} 415 when `verifyGlb` is set and the file is not a GLB.
 */
export async function persistUpload({
  tempPath,
  storageKey,
  originalName,
  mimeType,
  verifyGlb = false,
}) {
  // Validate while the file is still in the staging area, so a rejected upload
  // never touches the real bucket.
  if (verifyGlb) {
    await assertGlbMagic(tempPath);
  }

  const checksum = await computeChecksum(tempPath);
  const absolutePath = await moveIntoBucket(tempPath, storageKey);
  const { size } = await fs.stat(absolutePath);

  return {
    filename: path.basename(storageKey),
    originalName,
    mimeType,
    sizeBytes: size,
    storageKey,
    checksum,
    uploadedAt: new Date(),
  };
}

/**
 * Delete a staged upload that was never accepted.
 *
 * Intentionally forgiving: cleanup failures must not mask the real error that
 * triggered the cleanup in the first place.
 *
 * @param {string|undefined} tempPath - Absolute path of the staged file.
 * @returns {Promise<void>}
 */
export async function discardTempFile(tempPath) {
  if (!tempPath) return;
  try {
    await fs.unlink(tempPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[storage] Failed to remove temp file "${tempPath}":`, error.message);
    }
  }
}

/**
 * Check whether an object exists at the given key.
 *
 * @param {string} storageKey - Bucket-relative key.
 * @returns {Promise<boolean>} True when the object is present and readable.
 */
export async function objectExists(storageKey) {
  try {
    await fs.access(resolveAbsolutePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a single stored object.
 *
 * @param {string} storageKey - Bucket-relative key.
 * @returns {Promise<void>}
 */
export async function removeObject(storageKey) {
  try {
    await fs.unlink(resolveAbsolutePath(storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/**
 * Recursively delete every object owned by one asset.
 *
 * Only invoked for hard cleanup paths — the standard `DELETE /assets/:id` is a
 * soft delete and deliberately leaves the binaries in place, because the audit
 * trail is the entire reason raw CAD is retained.
 *
 * @param {string} assetId - Asset id whose prefix should be removed.
 * @returns {Promise<void>}
 */
export async function removeAssetObjects(assetId) {
  const prefix = resolveAbsolutePath(buildAssetPrefix(assetId));
  await fs.rm(prefix, { recursive: true, force: true });
}

export default {
  ensureStorageReady,
  resolveAbsolutePath,
  computeChecksum,
  assertGlbMagic,
  persistUpload,
  discardTempFile,
  objectExists,
  removeObject,
  removeAssetObjects,
};
