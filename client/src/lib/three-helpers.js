/**
 * @file three.js scene-graph utilities.
 *
 * Pure functions over a loaded glTF scene — no React, no Redux — so they can be
 * reasoned about and tested without mounting a canvas.
 *
 * @module lib/three-helpers
 */

import * as THREE from 'three';

/**
 * A mesh discovered by traversing a loaded scene.
 *
 * @typedef {object} DiscoveredMesh
 * @property {string} name - Raw glTF node name. The join key for the backend.
 * @property {string} path - Ancestor breadcrumb, e.g. `"Scene/Building/Wall_03"`.
 * @property {'Mesh'|'Group'} objectType
 * @property {number} vertexCount
 */

/**
 * Walk a loaded glTF scene and collect every named mesh.
 *
 * This is why the backend never parses a `.glb`: the geometry is already
 * decoded in browser memory for rendering, so enumerating it is essentially
 * free. A `MeshNode` document is written only when the operator actually binds
 * one of these names — an 811-node depot does not create 811 rows.
 *
 * Unnamed nodes are skipped: without a stable name there is nothing to persist
 * a binding against.
 *
 * @param {THREE.Object3D} root - Typically `gltf.scene`.
 * @returns {DiscoveredMesh[]} Named meshes, in traversal order.
 */
export function collectNamedMeshes(root) {
  /** @type {DiscoveredMesh[]} */
  const found = [];
  /** @type {Set<string>} Guards against duplicate names in asset packs. */
  const seen = new Set();

  root.traverse((object) => {
    if (!(/** @type {THREE.Mesh} */ (object).isMesh)) return;
    if (!object.name || seen.has(object.name)) return;

    seen.add(object.name);

    // Build the ancestor breadcrumb, stopping before the scene root so the
    // path stays readable.
    /** @type {string[]} */
    const segments = [];
    let cursor = object.parent;
    while (cursor && cursor !== root) {
      if (cursor.name) segments.unshift(cursor.name);
      cursor = cursor.parent;
    }

    const geometry = /** @type {THREE.Mesh} */ (object).geometry;

    found.push({
      name: object.name,
      path: segments.join('/'),
      objectType: 'Mesh',
      vertexCount: geometry?.attributes?.position?.count ?? 0,
    });
  });

  return found;
}

/**
 * Compute a camera placement that frames an object completely.
 *
 * Essential here because asset scale is unknown and wildly inconsistent —
 * these models come from third-party packs authored in different units. A
 * fixed camera position renders either a speck or the inside of a wall.
 *
 * The distance is derived from the bounding sphere and the camera's vertical
 * FOV, then padded, so the fit is correct rather than eyeballed.
 *
 * @param {THREE.Object3D} object - The object to frame.
 * @param {THREE.PerspectiveCamera} camera - Camera whose FOV drives the maths.
 * @param {number} [padding] - Multiplier for breathing room around the subject.
 * @returns {{position: THREE.Vector3, target: THREE.Vector3, near: number, far: number}}
 *   Suggested camera placement and clipping planes.
 */
export function computeFramingForObject(object, camera, padding = 1.6) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());

  const target = sphere.center.clone();
  // Guard against a degenerate/empty bounding sphere (a scene of empties).
  const radius = sphere.radius > 0 ? sphere.radius : 1;

  const fovRadians = (camera.fov * Math.PI) / 180;
  const distance = (radius / Math.sin(fovRadians / 2)) * padding;

  // A three-quarter view: models read better from an angle than head-on, and
  // this matches how CAD reviewers habitually orient an assembly.
  const direction = new THREE.Vector3(1, 0.55, 1).normalize();
  const position = target.clone().add(direction.multiplyScalar(distance));

  return {
    position,
    target,
    // Clipping planes scaled to the subject. A fixed `near` of 0.1 on a
    // 500-unit factory model causes severe z-fighting on distant surfaces.
    near: Math.max(distance / 1000, 0.01),
    far: distance * 10,
  };
}

/**
 * Format a byte count for display.
 *
 * @param {number} bytes - Size in bytes.
 * @returns {string} e.g. `"7.9 MB"`.
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Dispose of a scene's geometries, materials, and textures.
 *
 * three.js allocates GPU resources that JavaScript's garbage collector cannot
 * reclaim. Navigating between several multi-megabyte twins without this leaks
 * VRAM until the WebGL context is lost.
 *
 * @param {THREE.Object3D} root - Scene root to dispose.
 * @returns {void}
 */
export function disposeSceneResources(root) {
  root.traverse((object) => {
    const mesh = /** @type {THREE.Mesh} */ (object);
    if (!mesh.isMesh) return;

    mesh.geometry?.dispose();

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && /** @type {THREE.Texture} */ (value).isTexture) {
          /** @type {THREE.Texture} */ (value).dispose();
        }
      }
      material.dispose();
    }
  });
}
