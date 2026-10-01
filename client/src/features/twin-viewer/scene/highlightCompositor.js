/**
 * @file The highlight compositor: one mechanism for every tint on the model.
 *
 * Selection, hover, the green bind flash, live warning and alarm state, and (in
 * Phase 5) the diagnosis agent's "look here" all want to colour a mesh. The
 * first version of the viewer applied them independently, and that cannot be
 * made safe. Verified failure modes of that design:
 *
 *   - last writer wins: nothing blends, nothing is prioritised;
 *   - each effect's cleanup restores the ORIGINAL material, erasing another
 *     tint that is still supposed to be showing;
 *   - an orphaned clone is not disposed until its own cleanup runs;
 *   - a module-level `THREE.Color` was assigned as a material's `emissive`, so
 *     animating it in place would have recoloured every tint using that
 *     constant;
 *   - a mesh with several materials was flattened to its first one;
 *   - `getObjectByName` is an O(n) scan on every change.
 *
 * This module replaces it with a single pass: decide ONE winning layer per
 * mesh (`computeLayers`, pure) and realise it on the materials (`MaterialTinter`,
 * framework-free, so it is testable without a canvas).
 *
 * ## Priority, highest first
 *
 * agent, alarm, warn, bind flash, selection, hover.
 *
 * Alarm and warn are "live state" and outrank the transient green flash and the
 * operator's own selection: a fault must not be hidden by a hover.
 *
 * ## Materials
 *
 * The real asset packs share a dozen materials across hundreds of meshes
 * (`car_factory.glb` has 12 for 429 meshes), so a material is NEVER edited in
 * place. Each tinted mesh gets private clones of ALL its materials (an array is
 * respected, not flattened), each with its own colour, and the originals are put
 * back, and the clones disposed, when no layer remains.
 *
 * @module features/twin-viewer/scene/highlightCompositor
 */

import * as THREE from 'three';

/**
 * @typedef {'agent'|'alarm'|'warn'|'flash'|'select'|'hover'} ToneKey
 */

/**
 * @typedef {object} Tone
 * @property {number} priority - Higher wins.
 * @property {string} color - Emissive colour. These are 3D light colours, not UI tokens.
 * @property {number} intensity - Emissive strength.
 * @property {boolean} pulse - Whether the tone breathes (steady under reduced motion).
 */

/**
 * The tones. Amber for warn is brighter than the UI's `warning` text colour
 * (#8c5300) because an emissive tint on a pale model has to read as a light, not
 * as a dark text colour.
 *
 * @type {Readonly<Record<ToneKey, Tone>>}
 */
export const TONES = Object.freeze({
  agent: { priority: 5, color: '#b3261e', intensity: 1.0, pulse: true },
  alarm: { priority: 4, color: '#b3261e', intensity: 0.9, pulse: true },
  warn: { priority: 3, color: '#d98400', intensity: 0.85, pulse: false },
  flash: { priority: 2, color: '#24a148', intensity: 1.0, pulse: false },
  select: { priority: 1, color: '#135e66', intensity: 1.0, pulse: false },
  hover: { priority: 0, color: '#2f8a94', intensity: 0.45, pulse: false },
});

/**
 * @typedef {object} Layer
 * @property {ToneKey} tone
 * @property {boolean} pulse
 */

/**
 * Decide the single winning layer for each mesh that has any.
 *
 * Pure: the same inputs always give the same answer, which is what makes the
 * priority rules testable.
 *
 * @param {object} inputs
 * @param {string|null} inputs.selectedMeshName
 * @param {string|null} inputs.hoveredMeshName
 * @param {Record<string, Array<{source: 'flash'|'agent', pulse?: boolean}>>} inputs.highlights
 * @param {Array<[string, 'warn'|'alarm']>} inputs.alarmTints - From live telemetry.
 * @returns {Map<string, Layer>} Mesh name to its winning layer.
 */
export function computeLayers({ selectedMeshName, hoveredMeshName, highlights, alarmTints }) {
  /** @type {Map<string, Layer>} */
  const winners = new Map();

  /** @param {string} name @param {ToneKey} tone @param {boolean} [pulse] */
  const offer = (name, tone, pulse = TONES[tone].pulse) => {
    const current = winners.get(name);
    if (!current || TONES[tone].priority > TONES[current.tone].priority) {
      winners.set(name, { tone, pulse });
    }
  };

  // The hovered mesh needs no hover tint while it is also the selected one.
  if (hoveredMeshName && hoveredMeshName !== selectedMeshName) offer(hoveredMeshName, 'hover');
  if (selectedMeshName) offer(selectedMeshName, 'select');

  for (const [name, items] of Object.entries(highlights ?? {})) {
    for (const item of items) {
      offer(name, item.source === 'agent' ? 'agent' : 'flash', item.pulse);
    }
  }

  for (const [name, tone] of alarmTints ?? []) offer(name, tone);

  return winners;
}

/**
 * The state kept for one tinted mesh.
 *
 * @typedef {object} Applied
 * @property {THREE.Mesh} mesh
 * @property {THREE.Material|THREE.Material[]} original - What to put back.
 * @property {THREE.Material[]} clones - Private, disposable.
 * @property {THREE.Material|THREE.Material[]} assigned - What this tinter put on the mesh.
 * @property {ToneKey|null} tone
 * @property {number} baseIntensity
 * @property {boolean} pulse
 */

/**
 * Realises layers on meshes by swapping in private material clones.
 */
export class MaterialTinter {
  /**
   * @param {Map<string, THREE.Mesh>} meshByName - O(1) lookup, built once after load.
   */
  constructor(meshByName) {
    this.meshByName = meshByName;
    /** @type {Map<string, Applied>} */
    this.applied = new Map();
    /** @type {Set<Applied>} Entries that currently pulse; all `tick` touches. */
    this.pulsing = new Set();
  }

  /**
   * Make the meshes match `layers`: add what is new, update what changed,
   * restore what is gone. Safe to call repeatedly with the same layers.
   *
   * @param {Map<string, Layer>} layers
   * @returns {void}
   */
  apply(layers) {
    for (const [name, entry] of [...this.applied]) {
      if (!layers.has(name)) this.#restore(name, entry);
    }

    for (const [name, layer] of layers) {
      const mesh = this.meshByName.get(name);
      if (!mesh) continue;

      let entry = this.applied.get(name);
      if (!entry) entry = this.#attach(name, mesh);
      this.#paint(entry, layer);
    }
  }

  /**
   * Advance the pulse. Iterates ONLY the pulsing entries, so a scene with no
   * alarm costs nothing per frame.
   *
   * @param {number} elapsedSeconds - Clock time.
   * @param {boolean} reducedMotion - Hold pulsing tones steady.
   * @returns {void}
   */
  tick(elapsedSeconds, reducedMotion) {
    if (this.pulsing.size === 0) return;

    const factor = reducedMotion ? 1 : 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(elapsedSeconds * 4.4));
    for (const entry of this.pulsing) {
      for (const clone of entry.clones) {
        if ('emissive' in clone) {
          /** @type {THREE.MeshStandardMaterial} */ (clone).emissiveIntensity =
            entry.baseIntensity * factor;
        }
      }
    }
  }

  /**
   * Restore every mesh and release every clone.
   * @returns {void}
   */
  dispose() {
    for (const [name, entry] of [...this.applied]) this.#restore(name, entry);
  }

  /**
   * @param {string} name
   * @param {THREE.Mesh} mesh
   * @returns {Applied}
   */
  #attach(name, mesh) {
    const original = mesh.material;
    const sources = Array.isArray(original) ? original : [original];
    const clones = sources.map((material) => material.clone());
    const assigned = Array.isArray(original) ? clones : clones[0];

    mesh.material = assigned;

    /** @type {Applied} */
    const entry = {
      mesh,
      original,
      clones,
      assigned,
      tone: null,
      baseIntensity: 1,
      pulse: false,
    };
    this.applied.set(name, entry);
    return entry;
  }

  /**
   * @param {Applied} entry
   * @param {Layer} layer
   * @returns {void}
   */
  #paint(entry, layer) {
    const tone = TONES[layer.tone];

    for (const clone of entry.clones) {
      if ('emissive' in clone) {
        // `clone()` gave this material its OWN emissive Color; set() mutates that
        // private instance and nothing shared.
        const standard = /** @type {THREE.MeshStandardMaterial} */ (clone);
        standard.emissive.set(tone.color);
        standard.emissiveIntensity = tone.intensity;
      } else if ('color' in clone) {
        // Materials with no emissive channel (unlit basic materials) are tinted by colour.
        /** @type {THREE.MeshBasicMaterial} */ (clone).color.set(tone.color);
      }
    }

    entry.tone = layer.tone;
    entry.baseIntensity = tone.intensity;
    entry.pulse = layer.pulse;

    if (layer.pulse) this.pulsing.add(entry);
    else this.pulsing.delete(entry);
  }

  /**
   * @param {string} name
   * @param {Applied} entry
   * @returns {void}
   */
  #restore(name, entry) {
    // Only put the original back if the mesh still wears OUR clones; if some
    // other code has replaced the material since, leave its choice alone.
    if (entry.mesh.material === entry.assigned) entry.mesh.material = entry.original;

    // Release the clones' GPU programs. Without this, sweeping the cursor over a
    // large model leaks VRAM steadily.
    for (const clone of entry.clones) clone.dispose();

    this.pulsing.delete(entry);
    this.applied.delete(name);
  }
}

/**
 * Index the first mesh of each name, once, after the model loads.
 *
 * Matches `collectNamedMeshes` (first occurrence wins, unnamed skipped), so the
 * set of names the picker offers is exactly the set this can tint.
 *
 * @param {THREE.Object3D} root
 * @returns {Map<string, THREE.Mesh>}
 */
export function indexMeshesByName(root) {
  /** @type {Map<string, THREE.Mesh>} */
  const map = new Map();
  root.traverse((object) => {
    const mesh = /** @type {THREE.Mesh} */ (object);
    if (mesh.isMesh && mesh.name && !map.has(mesh.name)) map.set(mesh.name, mesh);
  });
  return map;
}
