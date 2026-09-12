/**
 * @file `Asset` model — one industrial 3D asset and its two file artefacts.
 *
 * An Asset is the aggregate root of this phase. It tracks a two-stage pipeline
 * that mirrors physical reality:
 *
 *   1. `originalFile`  — raw CAD (`.stp` / `.step` / `.iges`). Stored for
 *      provenance and audit ONLY. It is never parsed, and never reaches a
 *      browser: WebGL cannot render parametric CAD geometry.
 *   2. `convertedFile` — a web-ready `.glb` mesh, produced manually in Blender.
 *      This is the only artefact React Three Fiber ever loads.
 *
 * @module models/Asset.model
 */

import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.plugin.js';

const { Schema, model } = mongoose;

/**
 * Accepted source CAD formats.
 * @readonly
 * @enum {string}
 */
export const SOURCE_TYPE = Object.freeze({
  STP: 'stp',
  STEP: 'step',
  IGES: 'iges',
  OTHER: 'other',
});

/** All valid `sourceType` values, for schema enums and request validators. */
export const SOURCE_TYPES = Object.freeze(Object.values(SOURCE_TYPE));

/**
 * Asset lifecycle states.
 *
 * `pending_conversion → converted → mapped` is a one-directional **ratchet**:
 * unbinding the last sensor does not demote an asset from `mapped` back to
 * `converted`, because `mapped` records that the asset has been through the
 * mapping workflow — which stays true forever.
 *
 * `failed` is a reserved terminal state for the future automated-conversion
 * pipeline; the manual-Blender workflow of Phase 1 never sets it.
 *
 * @readonly
 * @enum {string}
 */
export const ASSET_STATUS = Object.freeze({
  PENDING_CONVERSION: 'pending_conversion',
  CONVERTED: 'converted',
  MAPPED: 'mapped',
  FAILED: 'failed',
});

/** All valid `status` values, for schema enums and request validators. */
export const ASSET_STATUSES = Object.freeze(Object.values(ASSET_STATUS));

/**
 * Monotonic rank used to enforce the status ratchet. Higher never steps down.
 * `failed` is intentionally absent — it is set explicitly, not by promotion.
 *
 * @type {Readonly<Record<string, number>>}
 */
export const STATUS_RANK = Object.freeze({
  [ASSET_STATUS.PENDING_CONVERSION]: 0,
  [ASSET_STATUS.CONVERTED]: 1,
  [ASSET_STATUS.MAPPED]: 2,
});

/**
 * A stored binary artefact belonging to an Asset.
 *
 * @typedef {object} FileArtifact
 * @property {string} filename - Canonical on-disk filename, e.g. `"converted.glb"`.
 * @property {string} originalName - Filename as uploaded by the user, preserved for display.
 * @property {string} mimeType - Reported MIME type.
 * @property {number} sizeBytes - Size on disk in bytes.
 * @property {string} storageKey - Bucket-relative key, e.g. `"assets/<id>/converted.glb"`.
 * @property {string} checksum - Lowercase hex SHA-256 of the file contents.
 * @property {Date} uploadedAt - When the artefact was accepted into storage.
 */

/**
 * Embedded sub-schema for a stored file.
 *
 * `_id: false` because these are value objects identified by their parent
 * field (`originalFile` / `convertedFile`), not independently addressable.
 */
const fileArtifactSchema = new Schema(
  {
    filename: { type: String, required: true, trim: true },
    originalName: { type: String, required: true, trim: true },
    mimeType: { type: String, required: true, trim: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    storageKey: { type: String, required: true, trim: true },
    // SHA-256 gives us tamper detection and cheap duplicate-upload detection.
    checksum: { type: String, required: true, trim: true, lowercase: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

/**
 * Operator-supplied descriptive metadata. All optional — an asset is usable
 * with none of it filled in.
 */
const assetMetadataSchema = new Schema(
  {
    /** Mesh/part count, recorded after conversion for capacity planning. */
    partCount: { type: Number, min: 0, default: null },
    /** Source CAD units, e.g. `"mm"`. Informational; no conversion is applied. */
    units: { type: String, trim: true, default: null },
    /** Free-text operator notes. */
    notes: { type: String, trim: true, maxlength: 2000, default: null },
  },
  { _id: false },
);

const assetSchema = new Schema(
  {
    /** Human-readable asset name, e.g. `"Tool & Plant Hire Depot"`. */
    name: {
      type: String,
      required: [true, 'Asset name is required'],
      trim: true,
      minlength: 1,
      maxlength: 200,
    },

    /**
     * Who uploaded this asset. Free text by design: Phase 1–2 ships no
     * authentication, so there is no `User` collection to reference yet. When
     * auth lands this becomes a `ref: 'User'` — the field name is already
     * chosen to make that migration a type change rather than a rename.
     */
    uploader: {
      type: String,
      required: [true, 'Uploader name is required'],
      trim: true,
      maxlength: 120,
    },

    sourceType: {
      type: String,
      enum: {
        values: SOURCE_TYPES,
        message: '`{VALUE}` is not a supported source type',
      },
      default: SOURCE_TYPE.STP,
    },

    status: {
      type: String,
      enum: {
        values: ASSET_STATUSES,
        message: '`{VALUE}` is not a valid asset status',
      },
      default: ASSET_STATUS.PENDING_CONVERSION,
      index: true,
    },

    /** Raw CAD artefact. `null` until a CAD file is uploaded. */
    originalFile: { type: fileArtifactSchema, default: null },

    /** Web-ready `.glb` artefact. `null` until conversion is uploaded. */
    convertedFile: { type: fileArtifactSchema, default: null },

    /**
     * Incremented every time `convertedFile` is replaced. Lets the frontend
     * bust drei's `useGLTF` cache by appending `?v=<version>` to the URL —
     * without this, a re-uploaded model would keep rendering the stale mesh.
     */
    version: { type: Number, default: 1, min: 1 },

    metadata: { type: assetMetadataSchema, default: () => ({}) },
  },
  {
    timestamps: true,
    // Expose virtuals (`isRenderable`, `id`) when documents are serialised to
    // JSON, and drop Mongoose's internal version key from API payloads.
    toJSON: {
      virtuals: true,
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
    toObject: { virtuals: true },
  },
);

assetSchema.plugin(softDeletePlugin);

/* ─── Indexes ──────────────────────────────────────────────────────────────── */

// Default dashboard query: live assets, newest first.
assetSchema.index({ isDeleted: 1, createdAt: -1 });

// Supports `?search=` across the two free-text fields the UI searches on.
// A case-insensitive regex is used at the service layer rather than `$text`
// because regex composes cleanly with the other filters (`status`, `isDeleted`)
// and the expected corpus is hundreds of assets, not millions.
assetSchema.index({ name: 1 });
assetSchema.index({ uploader: 1 });

/* ─── Virtuals ─────────────────────────────────────────────────────────────── */

/**
 * Whether this asset can actually be opened in the 3D viewer.
 *
 * Status alone is not sufficient — we also require the `.glb` artefact to be
 * present, so a hand-edited status in the database cannot produce a viewer that
 * loads nothing.
 *
 * @name Asset#isRenderable
 * @type {boolean}
 */
assetSchema.virtual('isRenderable').get(function isRenderable() {
  const hasMesh = Boolean(this.convertedFile?.storageKey);
  const statusAllows =
    this.status === ASSET_STATUS.CONVERTED || this.status === ASSET_STATUS.MAPPED;
  return hasMesh && statusAllows;
});

/* ─── Instance methods ─────────────────────────────────────────────────────── */

/**
 * Promote `status` forward along the ratchet, never backwards.
 *
 * @param {string} target - Desired status, one of {@link ASSET_STATUS}.
 * @returns {boolean} True when the status actually changed.
 * @this {import('mongoose').Document & { status: string }}
 */
assetSchema.methods.promoteStatus = function promoteStatus(target) {
  // `failed` is terminal-ish: it is only ever set explicitly, and it is never
  // overwritten by a promotion, so a failed conversion stays visible.
  if (this.status === ASSET_STATUS.FAILED) return false;

  const currentRank = STATUS_RANK[this.status] ?? 0;
  const targetRank = STATUS_RANK[target];

  if (targetRank === undefined || targetRank <= currentRank) return false;

  this.status = target;
  return true;
};

/**
 * @typedef {import('mongoose').Model<any> & {
 *   findActive(filter?: object): import('mongoose').Query<any, any>,
 *   findOneActive(filter?: object): import('mongoose').Query<any, any>,
 *   findActiveById(id: string): import('mongoose').Query<any, any>,
 *   countActive(filter?: object): import('mongoose').Query<number, any>,
 * }} AssetModel
 */

/** @type {AssetModel} */
export const Asset = model('Asset', assetSchema);

export default Asset;
