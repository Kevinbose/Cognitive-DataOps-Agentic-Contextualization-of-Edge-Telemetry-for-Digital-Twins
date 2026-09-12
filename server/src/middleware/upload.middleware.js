/**
 * @file Multer upload middleware.
 *
 * Two configurations, because the two artefact kinds have genuinely different
 * rules: raw CAD is large and may carry several extensions, while a converted
 * mesh must be exactly one format.
 *
 * Uploads are staged in a temp directory first. Nothing reaches the real bucket
 * until `storage.service.js` has verified it — which for `.glb` means reading
 * the file's magic bytes, something that can only happen after the bytes land.
 *
 * @module middleware/upload.middleware
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';

import { config } from '../config/env.config.js';
import { TEMP_UPLOAD_DIR } from '../config/storage.config.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Extensions accepted for raw CAD uploads.
 * `.igs` is included because IGES files use both spellings in the wild.
 * @type {ReadonlySet<string>}
 */
const CAD_EXTENSIONS = new Set(['.stp', '.step', '.iges', '.igs']);

/**
 * Extensions accepted for converted mesh uploads.
 *
 * Only `.glb` — the single-file binary container. A `.gltf` arrives as a JSON
 * file plus sidecar `.bin` and texture files, which this single-file upload
 * endpoint cannot keep together. Operators pack them first with
 * `npx gltf-pipeline -i model.gltf -o model.glb`.
 * @type {ReadonlySet<string>}
 */
const MESH_EXTENSIONS = new Set(['.glb']);

// Multer needs the destination to exist before the first request arrives.
fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

/**
 * Disk storage that writes to the staging area under a random filename.
 *
 * The client's filename is never used on disk: it is attacker-controlled and a
 * rich source of path-traversal and encoding bugs. The original is preserved in
 * MongoDB as `originalName` for display and download instead.
 */
const tempStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    cb(null, TEMP_UPLOAD_DIR);
  },
  filename(_req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

/**
 * Build a Multer `fileFilter` that accepts only the given extensions.
 *
 * Extension checks are a cheap first gate, not a guarantee — they reject the
 * obvious mistakes before a large body is even written. Content verification
 * (GLB magic bytes) happens later, in the storage service.
 *
 * @param {ReadonlySet<string>} allowed - Permitted lowercase extensions.
 * @param {string} label - Human-readable description for the error message.
 * @returns {import('multer').Options['fileFilter']} A Multer file filter.
 */
function extensionFilter(allowed, label) {
  return function fileFilter(_req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!allowed.has(extension)) {
      cb(
        ApiError.unsupportedMediaType(
          `Unsupported file type "${extension || '(none)'}" for ${label}. ` +
            `Expected one of: ${[...allowed].join(', ')}.`,
        ),
      );
      return;
    }
    cb(null, true);
  };
}

/**
 * Accepts a single raw CAD file under the form field `originalFile`.
 * @type {import('express').RequestHandler}
 */
export const uploadOriginalCad = multer({
  storage: tempStorage,
  limits: { fileSize: config.maxCadUploadBytes, files: 1 },
  fileFilter: extensionFilter(CAD_EXTENSIONS, 'a source CAD file'),
}).single('originalFile');

/**
 * Accepts a single converted mesh under the form field `convertedFile`.
 * @type {import('express').RequestHandler}
 */
export const uploadConvertedGlb = multer({
  storage: tempStorage,
  limits: { fileSize: config.maxGlbUploadBytes, files: 1 },
  fileFilter: extensionFilter(MESH_EXTENSIONS, 'a converted mesh'),
}).single('convertedFile');

/**
 * Reject a request that did not include a file.
 *
 * Multer treats a missing file as success, so endpoints where the upload is
 * mandatory need this guard placed immediately after the upload middleware.
 *
 * @param {string} fieldName - Expected multipart field name, used in the error.
 * @returns {import('express').RequestHandler} Guard middleware.
 */
export function requireFile(fieldName) {
  return function requireFileMiddleware(req, _res, next) {
    if (!req.file) {
      next(
        ApiError.badRequest(
          `No file received. Send the file as multipart/form-data under the field "${fieldName}".`,
        ),
      );
      return;
    }
    next();
  };
}

export default { uploadOriginalCad, uploadConvertedGlb, requireFile };
