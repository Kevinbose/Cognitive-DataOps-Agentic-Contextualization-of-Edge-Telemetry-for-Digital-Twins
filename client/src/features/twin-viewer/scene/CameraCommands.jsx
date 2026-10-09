/**
 * @file Applies camera commands (focus, zoom, rotate) to the orbit controls.
 *
 * Runs INSIDE `<Canvas>` because that is where the camera and controls live,
 * and renders nothing. The toolbar, the component list and the diagnosis agent
 * are ordinary DOM outside the canvas; they are connected only by the
 * `cameraCommand` counter in the viewer slice, the same pattern as the reset.
 *
 * `focus` frames a single named mesh: how an operator finds one part among
 * thousands (click it in the component list), and how the agent points at the
 * component it blames.
 *
 * Every command is a move, not a jump: the orbit pivot and the camera glide
 * together, eased in and out, over a time that grows with the distance
 * travelled. A move is functional motion, the one kind DESIGN.md allows: it
 * keeps the operator oriented in a large plant where a cut would lose them.
 * Under `prefers-reduced-motion` the camera jumps straight to the end. Grabbing
 * the view mid-move cancels it, so the camera never fights the hand.
 *
 * @module features/twin-viewer/scene/CameraCommands
 */

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useAppSelector } from '../../../app/hooks.js';
import { easeInOutCubic, focusSubject, moveDurationMs, planFocus } from '../../../lib/three-helpers.js';
import { usePrefersReducedMotion } from '../../../lib/usePrefersReducedMotion.js';
import { selectCameraCommand } from '../twinViewerSlice.js';

/** One zoom step moves the camera this fraction of the way to (or from) the target. */
const ZOOM_IN_FACTOR = 0.8;
const ZOOM_OUT_FACTOR = 1.25;
/** One rotate step, in radians (15 degrees). */
const ROTATE_STEP = Math.PI / 12;
/** Toolbar nudges are short moves. */
const NUDGE_MS = 280;

/**
 * @typedef {object} Move
 * @property {THREE.Vector3} fromPosition
 * @property {THREE.Vector3} toPosition
 * @property {THREE.Vector3} fromTarget
 * @property {THREE.Vector3} toTarget
 * @property {number} start - performance.now() at the first frame.
 * @property {number} duration - Milliseconds.
 * @property {boolean} orbitPath - Swing around the pivot (rotate) instead of a straight line.
 */

/**
 * @returns {null}
 */
export function CameraCommands() {
  const { camera, controls, scene, size, invalidate } = useThree();
  const command = useAppSelector(selectCameraCommand);
  const reducedMotion = usePrefersReducedMotion();
  const handled = useRef(command.nonce);
  const move = useRef(/** @type {Move|null} */ (null));

  // A hand on the view always wins over a move in progress.
  useEffect(() => {
    const orbit = /** @type {any} */ (controls);
    if (!orbit?.addEventListener) return undefined;
    const cancel = () => {
      move.current = null;
    };
    orbit.addEventListener('start', cancel);
    return () => orbit.removeEventListener('start', cancel);
  }, [controls]);

  useEffect(() => {
    // Only act on a NEW command, never on mount or a re-render.
    if (command.nonce === handled.current) return;
    handled.current = command.nonce;

    const orbit = /** @type {any} */ (controls);
    if (!orbit?.target || !command.action) return;

    const fromPosition = camera.position.clone();
    const fromTarget = orbit.target.clone();
    const offset = fromPosition.clone().sub(fromTarget);
    let toPosition;
    let toTarget = fromTarget.clone();
    let duration = NUDGE_MS;
    let orbitPath = false;

    if (command.action === 'focus') {
      const subject = focusSubject(command.meshName ? scene.getObjectByName(command.meshName) : undefined);
      if (!subject) return;
      const sphere = new THREE.Box3().setFromObject(subject).getBoundingSphere(new THREE.Sphere());
      const plan = planFocus({
        cameraPosition: fromPosition,
        orbitTarget: fromTarget,
        sphere,
        fovDeg: /** @type {THREE.PerspectiveCamera} */ (camera).fov ?? 45,
        aspect: size.width / Math.max(size.height, 1),
        minDistance: orbit.minDistance ?? 0,
        maxDistance: orbit.maxDistance ?? Infinity,
      });
      toPosition = plan.position;
      toTarget = plan.target;
      duration = moveDurationMs(fromPosition.distanceTo(toPosition), offset.length());
    } else if (command.action === 'zoomIn' || command.action === 'zoomOut') {
      const factor = command.action === 'zoomIn' ? ZOOM_IN_FACTOR : ZOOM_OUT_FACTOR;
      // Respect the distance limits the model framing set for this asset.
      const distance = THREE.MathUtils.clamp(
        offset.length() * factor,
        orbit.minDistance ?? 0,
        orbit.maxDistance ?? Infinity,
      );
      toPosition = fromTarget.clone().add(offset.setLength(distance));
    } else {
      // Rotate about the vertical axis through the target.
      const spherical = new THREE.Spherical().setFromVector3(offset);
      spherical.theta += command.action === 'rotateLeft' ? -ROTATE_STEP : ROTATE_STEP;
      toPosition = fromTarget.clone().add(new THREE.Vector3().setFromSpherical(spherical));
      orbitPath = true;
    }

    if (reducedMotion) {
      move.current = null;
      orbit.target.copy(toTarget);
      camera.position.copy(toPosition);
      orbit.update();
      invalidate();
      return;
    }

    move.current = { fromPosition, toPosition, fromTarget, toTarget, start: -1, duration, orbitPath };
    invalidate();
  }, [command, camera, controls, scene, size, reducedMotion, invalidate]);

  useFrame(() => {
    const m = move.current;
    const orbit = /** @type {any} */ (controls);
    if (!m || !orbit?.target) return;
    const now = performance.now();
    if (m.start < 0) m.start = now;
    const t = Math.min(1, (now - m.start) / m.duration);
    const k = easeInOutCubic(t);

    orbit.target.lerpVectors(m.fromTarget, m.toTarget, k);
    if (m.orbitPath) {
      // Keep the distance while swinging round, so a rotate does not dip inward.
      const a = new THREE.Spherical().setFromVector3(m.fromPosition.clone().sub(m.fromTarget));
      const b = new THREE.Spherical().setFromVector3(m.toPosition.clone().sub(m.toTarget));
      const s = new THREE.Spherical(
        THREE.MathUtils.lerp(a.radius, b.radius, k),
        THREE.MathUtils.lerp(a.phi, b.phi, k),
        THREE.MathUtils.lerp(a.theta, b.theta, k),
      );
      camera.position.copy(orbit.target).add(new THREE.Vector3().setFromSpherical(s));
    } else {
      camera.position.lerpVectors(m.fromPosition, m.toPosition, k);
    }
    orbit.update();
    invalidate();
    if (t >= 1) move.current = null;
  });

  return null;
}

export default CameraCommands;
