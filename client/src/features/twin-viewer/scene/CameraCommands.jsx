/**
 * @file Applies toolbar camera nudges (zoom, rotate) to the orbit controls.
 *
 * Runs INSIDE `<Canvas>` because that is where the camera and controls live,
 * and renders nothing. The toolbar is ordinary DOM outside the canvas; the two
 * are connected only by the `cameraCommand` counter in the viewer slice, the
 * same pattern as the camera reset.
 *
 * Orbit, pan and zoom are otherwise mouse gestures. These commands give each
 * one a click and keyboard alternative. `focus` frames a single named mesh: how
 * an operator finds one part among hundreds, and how the diagnosis agent will
 * point at the component it blames.
 *
 * @module features/twin-viewer/scene/CameraCommands
 */

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useAppSelector } from '../../../app/hooks.js';
import { selectCameraCommand } from '../twinViewerSlice.js';

/** One zoom step moves the camera this fraction of the way to (or from) the target. */
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1.25;
/** One rotate step, in radians (15 degrees). */
const ROTATE_STEP = Math.PI / 12;
/** Focus frames a mesh from this many of its bounding radii away. */
const FOCUS_DISTANCE_RADII = 3.2;

/**
 * @returns {null}
 */
export function CameraCommands() {
  const { camera, controls, scene } = useThree();
  const command = useAppSelector(selectCameraCommand);
  const handled = useRef(command.nonce);

  useEffect(() => {
    // Only act on a NEW command, never on mount or a re-render.
    if (command.nonce === handled.current) return;
    handled.current = command.nonce;

    const orbit = /** @type {any} */ (controls);
    if (!orbit?.target || !command.action) return;

    const offset = camera.position.clone().sub(orbit.target);

    if (command.action === 'focus') {
      const target = command.meshName ? scene.getObjectByName(command.meshName) : null;
      if (!target) return;

      // Keep the current viewing direction; move the pivot to the mesh and
      // back off far enough to frame it, within the limits set for this model.
      const sphere = new THREE.Box3().setFromObject(target).getBoundingSphere(new THREE.Sphere());
      const distance = THREE.MathUtils.clamp(
        Math.max(sphere.radius, 0.01) * FOCUS_DISTANCE_RADII,
        orbit.minDistance ?? 0,
        orbit.maxDistance ?? Infinity,
      );
      orbit.target.copy(sphere.center);
      offset.setLength(distance);
    } else if (command.action === 'zoomIn' || command.action === 'zoomOut') {
      const factor = command.action === 'zoomIn' ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
      // Respect the distance limits the model framing set for this asset.
      const distance = THREE.MathUtils.clamp(
        offset.length() * factor,
        orbit.minDistance ?? 0,
        orbit.maxDistance ?? Infinity,
      );
      offset.setLength(distance);
    } else {
      // Rotate about the vertical axis through the target.
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta += command.action === 'rotateLeft' ? -ROTATE_STEP : ROTATE_STEP;
      offset.setFromSpherical(spherical);
    }

    camera.position.copy(orbit.target).add(offset);
    orbit.update();
  }, [command, camera, controls, scene]);

  return null;
}

export default CameraCommands;
