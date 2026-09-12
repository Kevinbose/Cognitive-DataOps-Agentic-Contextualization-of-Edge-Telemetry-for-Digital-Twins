/**
 * @file `SensorBinding` model — the link between a logical sensor and a 3D mesh.
 *
 * ## Why this is its own collection rather than a field on `MeshNode`
 *
 * Phase 3 ingests live MQTT telemetry, and that workload queries from the
 * *sensor* side: "a reading just arrived for `MOTOR_01_TEMP` — which mesh does
 * it drive?". That lookup must not require loading an Asset or its mesh graph.
 * A dedicated collection answers it with a single indexed `findOne`.
 *
 * It also makes rebind history free. Moving a sensor to a different part closes
 * the old row (`isActive: false`, `unboundAt` stamped) and inserts a new one,
 * leaving an append-only audit log — which an industrial maintenance record
 * needs, and which an overwritten embedded field would destroy.
 *
 * @module models/SensorBinding.model
 */

import mongoose from 'mongoose';

const { Schema, model } = mongoose;

/**
 * Physical quantity a bound sensor measures.
 *
 * Values mirror the sensor kinds named in the project's own research notes
 * (temperature / vibration / rpm / pressure / current), plus a `generic` escape
 * hatch so an unanticipated sensor can still be mapped without a schema change.
 *
 * @readonly
 * @enum {string}
 */
export const SENSOR_TYPE = Object.freeze({
  TEMPERATURE: 'temperature',
  VIBRATION: 'vibration',
  RPM: 'rpm',
  PRESSURE: 'pressure',
  CURRENT: 'current',
  GENERIC: 'generic',
});

/** All valid `sensorType` values, for schema enums and request validators. */
export const SENSOR_TYPES = Object.freeze(Object.values(SENSOR_TYPE));

const sensorBindingSchema = new Schema(
  {
    /**
     * Denormalised owning asset.
     *
     * Strictly derivable by joining through `meshNodeId`, but stored directly
     * so the twin-scene endpoint can fetch every binding for an asset in one
     * indexed query instead of a two-step lookup.
     */
    assetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      required: [true, 'assetId is required'],
      index: true,
    },

    meshNodeId: {
      type: Schema.Types.ObjectId,
      ref: 'MeshNode',
      required: [true, 'meshNodeId is required'],
      index: true,
    },

    /**
     * The logical sensor identifier the operator assigns, e.g. `MOTOR_01_TEMP`.
     *
     * Upper-cased on write so `motor_01_temp` and `MOTOR_01_TEMP` cannot become
     * two distinct sensors — important because the Phase 3 MQTT topic will be
     * derived from this value, and topic casing mismatches are painful to debug.
     */
    sensorId: {
      type: String,
      required: [true, 'sensorId is required'],
      trim: true,
      uppercase: true,
      maxlength: 128,
      index: true,
    },

    sensorType: {
      type: String,
      enum: {
        values: SENSOR_TYPES,
        message: '`{VALUE}` is not a supported sensor type',
      },
      default: SENSOR_TYPE.GENERIC,
    },

    /**
     * Whether this binding is the currently-live one.
     *
     * Unbinding never deletes a row; it flips this to `false`. All uniqueness
     * rules below are scoped to `isActive: true`, so historical rows never
     * obstruct a new binding.
     */
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    /** Who created the binding. Free text until auth exists. */
    boundBy: {
      type: String,
      trim: true,
      maxlength: 120,
      default: null,
    },

    /** When the binding became active. */
    boundAt: {
      type: Date,
      default: Date.now,
    },

    /** When the binding was retired; `null` while active. */
    unboundAt: {
      type: Date,
      default: null,
    },

    /** Free-text commissioning notes, e.g. `"Probe mounted on NDE bearing"`. */
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret.__v;
        return ret;
      },
    },
  },
);

/* ─── Indexes ──────────────────────────────────────────────────────────────── */
/*
 * These two partial unique indexes are the real enforcement of the mapping
 * rules — not application-level checks, which race under concurrent requests.
 * Scoping each to `isActive: true` is what allows an append-only history to
 * coexist with "exactly one live binding" semantics.
 */

/**
 * A sensor feeds at most one mesh at a time. Prevents `MOTOR_01_TEMP` from
 * simultaneously driving two different parts of the twin.
 */
sensorBindingSchema.index(
  { sensorId: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: 'uniq_active_sensor',
  },
);

/**
 * A mesh is driven by at most one sensor at a time. Rebinding a mesh must
 * replace its binding, never silently accumulate a second one.
 */
sensorBindingSchema.index(
  { meshNodeId: 1 },
  {
    unique: true,
    partialFilterExpression: { isActive: true },
    name: 'uniq_active_mesh_binding',
  },
);

/** Primary read path for the twin-scene payload. */
sensorBindingSchema.index({ assetId: 1, isActive: 1 });

/**
 * @typedef {import('mongoose').Model<any>} SensorBindingModel
 */

/** @type {SensorBindingModel} */
export const SensorBinding = model('SensorBinding', sensorBindingSchema);

export default SensorBinding;
