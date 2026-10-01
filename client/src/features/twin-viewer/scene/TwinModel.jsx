/**
 * @file The loaded digital twin mesh: discovery, framing, raycasting, highlight.
 *
 * Runs INSIDE `<Canvas>`, on React Three Fiber's reconciler, yet uses ordinary
 * `useDispatch` / `useSelector`: React Context crosses the reconciler boundary,
 * so the `<Provider>` wrapping the app is visible in here too. That is the
 * whole mechanism behind click-a-mesh, update-the-sidebar.
 *
 * This component owns four responsibilities that all depend on having the
 * parsed scene in hand, and are therefore kept together rather than lifted
 * into a parent via callbacks:
 *   1. Traverse and publish the named meshes.
 *   2. Frame the camera on the model's bounds.
 *   3. Translate pointer events into Redux actions.
 *   4. Paint the winning highlight layer on each mesh (see the compositor).
 *
 * @module features/twin-viewer/scene/TwinModel
 */

import { useCallback, useEffect, useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { collectNamedMeshes, computeFramingForObject } from '../../../lib/three-helpers.js';
import { usePrefersReducedMotion } from '../../../lib/usePrefersReducedMotion.js';
import { selectAlarmTints, tintsEqual } from '../../telemetry/telemetrySlice.js';
import {
  clearDiscoveredMeshes,
  selectCameraResetNonce,
  selectHighlights,
  selectHoveredMeshName,
  selectMesh,
  selectSelectedMeshName,
  setDiscoveredMeshes,
  setHoveredMesh,
} from '../twinViewerSlice.js';
import { MaterialTinter, computeLayers, indexMeshesByName } from './highlightCompositor.js';

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
  const highlights = useAppSelector(selectHighlights);
  // Re-renders only when a tint actually changes, not on every 4 Hz batch.
  const alarmTints = useAppSelector(selectAlarmTints, tintsEqual);
  const reducedMotion = usePrefersReducedMotion();

  // Suspends until the GLB is parsed; the DOM overlay shows progress.
  const { scene } = useGLTF(url);

  /**
   * Some packs ship geometry with no vertex normals, which renders as flat
   * black under any lighting. Computing them once on load is cheap insurance
   * against a model that silently looks broken.
   */
  const preparedScene = useMemo(() => {
    scene.traverse((object) => {
      const mesh = /** @type {import('three').Mesh} */ (object);
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
   * This component is the sole owner of that list: it writes it here and
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
   * Not optional: these packs are authored at arbitrary scales (one asset is
   * a handful of units across, the next spans hundreds), so any fixed camera
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
      /** @type {import('three').PerspectiveCamera} */ (camera),
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

  /* ── Highlights ───────────────────────────────────────────────────────────
     Name to mesh, indexed once per model, so a lookup is O(1) rather than a
     scene-graph scan. One tinter per model owns every material swap. */
  const meshByName = useMemo(() => indexMeshesByName(preparedScene), [preparedScene]);
  const tinter = useMemo(() => new MaterialTinter(meshByName), [meshByName]);

  /** The single winning layer per mesh, recomputed only when an input changes. */
  const layers = useMemo(
    () => computeLayers({ selectedMeshName, hoveredMeshName, highlights, alarmTints }),
    [selectedMeshName, hoveredMeshName, highlights, alarmTints],
  );

  useEffect(() => {
    tinter.apply(layers);
  }, [tinter, layers]);

  // Restore every material and free every clone when the model goes away.
  useEffect(() => () => tinter.dispose(), [tinter]);

  // Drives the pulse. A no-op, every frame, when nothing is pulsing.
  useFrame(({ clock }) => tinter.tick(clock.elapsedTime, reducedMotion));

  /**
   * Click selects. R3F raycasts and bubbles the hit through this one
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

  useEffect(
    () => () => {
      // Unmounting mid-hover would otherwise strand the pointer as a hand.
      gl.domElement.style.cursor = 'auto';
    },
    [gl],
  );

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
