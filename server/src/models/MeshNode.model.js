/**
 * @file `MeshNode` model — one instrumentable sub-part inside an asset's `.glb`.
 *
 * ## Why these are created on demand, never bulk-imported
 *
 * The real sample assets in `Joe_Samples/` are not tidy three-part demos. Their
 * GLB headers declare **811–1,203 nodes each**, with machine-generated names
 * like `038-tool-hire-depot-and-plant-yard-depot-wall-module/0`. Eagerly
 * inserting one document per node would mean ~1,000 writes per upload to
 * support the handful an operator actually instruments.
 *
 * So: the browser discovers names by traversing the loaded scene graph (free —
 * the mesh is already in memory for rendering), and a `MeshNode` row is created
 * only at the moment someone binds a sensor to that name. `meshName` is the
 * join key between MongoDB and the glTF scene graph, which is why it is stored
 * verbatim and never normalised.
 *
 * @module models/MeshNode.model
 */

import mongoose from 'mongoose';
import { softDeletePlugin } from './plugins/softDelete.plugin.js';

const { Schema, model } = mongoose;

/**
 * Kind of glTF scene-graph object a `MeshNode` points at.
 *
 * Most bindings target a leaf `Mesh`. `Group` is supported because a logical
 * machine part is sometimes an assembly container rather than a single mesh.
 *
 * @readonly
 * @enum {string}
 */
export const MESH_OBJECT_TYPE = Object.freeze({
  MESH: 'Mesh',
  GROUP: 'Group',
});

/** All valid `objectType` values. */
export const MESH_OBJECT_TYPES = Object.freeze(Object.values(MESH_OBJECT_TYPE));

const meshNodeSchema = new Schema(
  {
    assetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      required: [true, 'assetId is required'],
      index: true,
    },

    /**
     * The glTF node name, exactly as it appears in the `.glb`.
     *
     * Trimmed but otherwise untouched — NOT lowercased, NOT slugified. This is
     * the lookup key used by `scene.getObjectByName()` in the browser, so any
     * normalisation here would silently break the 3D highlight.
     */
    meshName: {
      type: String,
      required: [true, 'meshName is required'],
      trim: true,
      maxlength: 512,
    },

    /**
     * Optional operator-friendly label shown in the UI instead of `meshName`.
     * Essential in practice: `"Main Drive Motor"` is reviewable in a demo,
     * `038-tool-hire-depot-...-wall-module/0` is not.
     */
    displayName: {
      type: String,
      trim: true,
      maxlength: 200,
      default: null,
    },

    /**
     * Breadcrumb of ancestor node names, e.g. `"Scene/Building/Wall_03"`.
     * Disambiguates the duplicate leaf names that asset packs frequently reuse.
     */
    nodePath: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },

    objectType: {
      type: String,
      enum: {
        values: MESH_OBJECT_TYPES,
        message: '`{VALUE}` is not a valid glTF object type',
      },
      default: MESH_OBJECT_TYPE.MESH,
    },

    /**
     * Denormalised "has an active sensor binding" flag.
     *
     * The authoritative answer lives in the `SensorBinding` collection; this
     * mirror exists so the viewer can tint every instrumented mesh without
     * issuing a join per node. `sensorBinding.service.js` owns keeping it in
     * sync, inside the same transaction as the binding write.
     */
    isMapped: {
      type: Boolean,
      default: false,
      index: true,
    },

    /** Who registered this node. Free text until auth exists (see Asset.uploader). */
    createdBy: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },
  },
  {
    timestamps: true,
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

meshNodeSchema.plugin(softDeletePlugin);

/* ─── Indexes ──────────────────────────────────────────────────────────────── */

/**
 * The core integrity rule: a given mesh name is registered at most once per
 * asset.
 *
 * Implemented as a **partial** unique index scoped to live documents. A plain
 * unique index would let a soft-deleted row permanently block re-registering
 * that same mesh name — an operator who removed a node by mistake could never
 * add it back. Restricting uniqueness to `isDeleted: false` preserves the
 * intended constraint while keeping soft delete genuinely reversible.
 */
meshNodeSchema.index(
  { assetId: 1, meshName: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: 'uniq_live_mesh_per_asset',
  },
);

// Supports "which nodes of this asset are still un-instrumented?".
meshNodeSchema.index({ assetId: 1, isMapped: 1 });

/* ─── Virtuals ─────────────────────────────────────────────────────────────── */

/**
 * The label the UI should render: operator override when set, raw glTF name
 * otherwise. Keeps that fallback decision in one place instead of scattering
 * `displayName || meshName` across components.
 *
 * @name MeshNode#label
 * @type {string}
 */
meshNodeSchema.virtual('label').get(function label() {
  return this.displayName || this.meshName;
});

/**
 * @typedef {import('mongoose').Model<any> & {
 *   findActive(filter?: object): import('mongoose').Query<any, any>,
 *   findOneActive(filter?: object): import('mongoose').Query<any, any>,
 *   findActiveById(id: string): import('mongoose').Query<any, any>,
 *   countActive(filter?: object): import('mongoose').Query<number, any>,
 * }} MeshNodeModel
 */

/** @type {MeshNodeModel} */
export const MeshNode = model('MeshNode', meshNodeSchema);

export default MeshNode;
