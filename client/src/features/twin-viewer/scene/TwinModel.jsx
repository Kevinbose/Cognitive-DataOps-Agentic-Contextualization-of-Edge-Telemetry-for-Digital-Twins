/**
 * @file The loaded digital twin mesh — discovery, framing, raycasting, highlight.
 *
 * Runs INSIDE `<Canvas>`, on React Three Fiber's reconciler, yet uses ordinary
 * `useDispatch` / `useSelector`: React Context crosses the reconciler boundary,
 * so the `<Provider>` wrapping the app is visible in here too. That is the
 * whole mechanism behind click-a-mesh → update-the-sidebar.
 *
 * This component owns three responsibilities that all depend on having the
 * parsed scene in hand, and are therefore kept together rather than lifted
 * into a parent via callbacks:
 *   1. Traverse and publish the named meshes.
 *   2. Frame the camera on the model's bounds.
 *   3. Translate pointer events into Redux actions.
 *
 * @module features/twin-viewer/scene/TwinModel
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { collectNamedMeshes, computeFramingForObject } from '../../../lib/three-helpers.js';
import {
  clearDiscoveredMeshes,
  selectCameraResetNonce,
  selectHoveredMeshName,
  selectMesh,
  selectSelectedMeshName,
  setDiscoveredMeshes,
  setHoveredMesh,
} from '../twinViewerSlice.js';

/** Cyan "signal" — the selected component. Matches `--color-signal`. */
const SELECT_COLOR = new THREE.Color('#0e7490');
/** Indigo — hover. Distinct from selection, and never mistaken for a fault. */
const HOVER_COLOR = new THREE.Color('#3538cd');

/**
 * @param {object} props
 * @param {string} props.url - Cache-busted `.glb` URL from the scene payload.
 * @returns {import('react').JSX.Element}
 */
export function TwinModel({ url }) {
  const dispatch = useAppDispatch();
  const { camera, controls, gl } = useThree();

  const selectedMeshName = useAppSelector(selectSelectedMeshName);
  const hoveredMeshName = useAppSelector(selectHoveredMeshName);
  const cameraResetNonce = useAppSelector(selectCameraResetNonce);

  // Suspends until the GLB is parsed; the DOM overlay shows progress.
  const { scene } = useGLTF(url);

  /**
   * Original material per highlighted mesh, keyed by UUID.
   *
   * Highlighting must never mutate a material in place. These asset packs
   * share a dozen materials across hundreds of meshes — `car_factory.glb` has
   * 12 materials for 429 meshes — so tinting one would light up every part
   * that happens to share it. Each highlight gets a private clone; this map
   * remembers what to restore.
   *
   * @type {import('react').RefObject<Map<string, THREE.Material|THREE.Material[]>>}
   */
  const originalMaterials = useRef(new Map());

  /**
   * Some packs ship geometry with no vertex normals, which renders as flat
   * black under any lighting. Computing them once on load is cheap insurance
   * against a model that silently looks broken.
   */
  const preparedScene = useMemo(() => {
    scene.traverse((object) => {
      const mesh = /** @type {THREE.Mesh} */ (object);
      if (!mesh.isMesh) return;

      mesh.frustumCulled = true;
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals();
      }
    });
    return scene;
  }, [scene]);

  /**
   * Publish discovered meshes to the store, and clear them on unmount.
   *
   * Straight to Redux rather than up through a callback prop: the picker that
   * consumes this lives outside `<Canvas>`, so it is cross-boundary state by
   * definition.
   *
   * This component is the sole owner of that list — it writes it here and
   * clears it in the cleanup below. Nothing else may blank it. An earlier
   * version had the page's "reset on asset change" effect clear it too, which
   * raced: React runs child effects before parent effects, so on a navigation
   * where drei served a cached model, this effect published the list and the
   * parent's reset promptly wiped it. Single ownership removes the ordering
   * question entirely.
   */
  useEffect(() => {
    dispatch(setDiscoveredMeshes(collectNamedMeshes(preparedScene)));
    return () => {
      dispatch(clearDiscoveredMeshes());
    };
  }, [preparedScene, dispatch]);

  /**
   * Frame the camera on the model.
   *
   * Not optional: these packs are authored at arbitrary scales — one asset is
   * a handful of units across, the next spans hundreds — so any fixed camera
   * position renders either a distant speck or the inside of a wall. Framing
   * is derived from the model's own bounding sphere.
   *
   * `controls` comes from `useThree()` because `OrbitControls` is mounted with
   * `makeDefault`, which registers it on the R3F store. That avoids passing a
   * ref back and forth between siblings.
   */
  useEffect(() => {
    if (!preparedScene) return;

    const framing = computeFramingForObject(
      preparedScene,
      /** @type {THREE.PerspectiveCamera} */ (camera),
    );

    camera.position.copy(framing.position);
    camera.near = framing.near;
    camera.far = framing.far;
    camera.updateProjectionMatrix();
    camera.lookAt(framing.target);

    const orbit = /** @type {any} */ (controls);
    if (orbit?.target) {
      orbit.target.copy(framing.target);
      // Scale interaction speed to the subject: a zoom step that feels right
      // on a small pump is imperceptible on a factory floor.
      const span = framing.position.distanceTo(framing.target);
      orbit.minDistance = span * 0.02;
      orbit.maxDistance = span * 8;
      orbit.update();
    }
  }, [preparedScene, camera, controls, cameraResetNonce]);

  /**
   * Apply a tint to one mesh, preserving whatever material it had.
   *
   * @param {string|null} meshName - Mesh to tint, or `null` to clear.
   * @param {THREE.Color} color - Emissive tint.
   * @param {number} intensity - Emissive strength.
   * @returns {() => void} Restores the original material.
   */
  const applyTint = useCallback(
    (meshName, color, intensity) => {
      if (!meshName) return () => {};

      const mesh = /** @type {THREE.Mesh} */ (preparedScene.getObjectByName(meshName));
      if (!mesh?.isMesh) return () => {};

      const key = mesh.uuid;
      if (!originalMaterials.current.has(key)) {
        originalMaterials.current.set(key, mesh.material);
      }

      const source = originalMaterials.current.get(key);
      const base = Array.isArray(source) ? source[0] : source;
      const highlight = base.clone();

      // `emissive` renders independently of scene lighting, so a component
      // buried inside an assembly still reads as selected.
      if ('emissive' in highlight) {
        /** @type {THREE.MeshStandardMaterial} */ (highlight).emissive = color;
        /** @type {THREE.MeshStandardMaterial} */ (highlight).emissiveIntensity = intensity;
      } else {
        /** @type {THREE.MeshBasicMaterial} */ (highlight).color = color;
      }
      mesh.material = highlight;

      return () => {
        const original = originalMaterials.current.get(key);
        if (original) mesh.material = original;
        // Release the clone's GPU allocation — without this, sweeping the
        // cursor across a large model steadily leaks VRAM.
        highlight.dispose();
      };
    },
    [preparedScene],
  );

  useEffect(
    () => applyTint(selectedMeshName, SELECT_COLOR, 1.0),
    [selectedMeshName, applyTint],
  );

  useEffect(() => {
    if (!hoveredMeshName || hoveredMeshName === selectedMeshName) return undefined;
    return applyTint(hoveredMeshName, HOVER_COLOR, 0.45);
  }, [hoveredMeshName, selectedMeshName, applyTint]);

  /**
   * Click → select. R3F raycasts and bubbles the hit through this one
   * delegated handler rather than 800 individual listeners.
   *
   * @param {import('@react-three/fiber').ThreeEvent<MouseEvent>} event
   */
  const handleClick = useCallback(
    (event) => {
      event.stopPropagation();
      if (event.object?.name) dispatch(selectMesh(event.object.name));
    },
    [dispatch],
  );

  /** @param {import('@react-three/fiber').ThreeEvent<PointerEvent>} event */
  const handlePointerOver = useCallback(
    (event) => {
      event.stopPropagation();
      const name = event.object?.name;
      // Guarded on an actual change: pointer-move fires every frame, and
      // dispatching each one would flood the store for no consumer's benefit.
      if (!name || name === hoveredMeshName) return;
      dispatch(setHoveredMesh(name));
      gl.domElement.style.cursor = 'pointer';
    },
    [dispatch, hoveredMeshName, gl],
  );

  /** @param {import('@react-three/fiber').ThreeEvent<PointerEvent>} event */
  const handlePointerOut = useCallback(
    (event) => {
      event.stopPropagation();
      dispatch(setHoveredMesh(null));
      gl.domElement.style.cursor = 'auto';
    },
    [dispatch, gl],
  );

  useEffect(() => {
    const materials = originalMaterials.current;
    return () => {
      materials.clear();
      // Unmounting mid-hover would otherwise strand the pointer as a hand.
      gl.domElement.style.cursor = 'auto';
    };
  }, [gl]);

  return (
    <primitive
      object={preparedScene}
      onClick={handleClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    />
  );
}

export default TwinModel;
