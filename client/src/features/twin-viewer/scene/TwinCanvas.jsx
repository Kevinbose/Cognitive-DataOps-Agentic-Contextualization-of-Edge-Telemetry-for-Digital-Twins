/**
 * @file The WebGL canvas host.
 *
 * Owns `<Canvas>` and everything inside it. Everything *outside* — HUD chrome,
 * inspector, picker — lives in `../components/` as ordinary DOM siblings.
 * Keeping that split visible in the folder layout is what stops a plain `<div>`
 * from being rendered into the three.js reconciler by mistake.
 *
 * @module features/twin-viewer/scene/TwinCanvas
 */

import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls, useProgress } from '@react-three/drei';
import * as THREE from 'three';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import {
  clearSelection,
  selectAutoRotate,
  selectShowBlueprintGrid,
} from '../twinViewerSlice.js';
import CameraCommands from './CameraCommands.jsx';
import SceneLighting from './SceneLighting.jsx';
import TwinModel from './TwinModel.jsx';

/**
 * Determinate load progress, rendered in the DOM.
 *
 * Outside the canvas rather than through drei's `<Html>`, because an overlay
 * that must be visible *while the scene is suspended* cannot itself live inside
 * the suspended tree. Opaque, with no blur: the stage behind it is plain.
 *
 * @returns {import('react').JSX.Element|null}
 */
function LoadProgressOverlay() {
  const { active, progress } = useProgress();
  if (!active) return null;

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-stage"
      role="status"
      aria-live="polite"
    >
      <div className="w-80 max-w-[calc(100%-2rem)] border border-line bg-surface p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <p className="label-text text-ink-secondary">Loading geometry</p>
          <p className="data-readout font-medium text-ink">{Math.round(progress)}%</p>
        </div>

        {/* Determinate, not a spinner: a multi-megabyte pack genuinely takes
            seconds, and hiding that reads as a hang. */}
        <div
          className="h-2 w-full bg-sunken"
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Model loading progress"
        >
          {/* Scaled, not resized: transform is compositor-friendly, width is not. */}
          <div
            className="h-full w-full origin-left bg-primary transition-transform duration-200 ease-out"
            style={{ transform: `scaleX(${Math.max(progress, 4) / 100})` }}
          />
        </div>

        <p className="mt-3 text-xs text-ink-muted">Decoding the mesh and building the scene graph…</p>
      </div>
    </div>
  );
}

/**
 * The 3D viewport.
 *
 * @param {object} props
 * @param {string} props.modelUrl - Cache-busted `.glb` URL.
 * @returns {import('react').JSX.Element}
 */
export function TwinCanvas({ modelUrl }) {
  const dispatch = useAppDispatch();
  const showGrid = useAppSelector(selectShowBlueprintGrid);
  const autoRotate = useAppSelector(selectAutoRotate);

  return (
    <div className="relative h-full w-full">
      <Canvas
        // A placeholder; `TwinModel` replaces this with a bounding-sphere fit
        // as soon as the geometry is known.
        camera={{ position: [8, 6, 8], fov: 45, near: 0.1, far: 10000 }}
        // Clamp DPR: uncapped, a 3x display renders nine times the pixels —
        // enough to stall an 800-mesh scene.
        dpr={[1, 2]}
        gl={{
          antialias: true,
          // Flat, accurate colour. ACES filmic (R3F's default) lifts blacks and
          // desaturates — cinematic, and wrong where a part's actual colour is
          // information the operator reads.
          toneMapping: THREE.NoToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
          powerPreference: 'high-performance',
        }}
        // Clicking empty space clears the selection — the standard CAD gesture.
        onPointerMissed={() => dispatch(clearSelection())}
        // Transparent so the flat `stage` backdrop behind shows through.
        style={{ background: 'transparent' }}
      >
        <SceneLighting />

        <Suspense fallback={null}>
          <TwinModel url={modelUrl} />
        </Suspense>

        {showGrid ? (
          <Grid
            infiniteGrid
            cellSize={1}
            cellThickness={0.5}
            // Neutral measuring lines on the stage colour (#d4d7d1). The grid is
            // a spatial aid, not decoration, so it stays.
            cellColor="#bcc1b8"
            sectionSize={10}
            sectionThickness={1}
            sectionColor="#9aa096"
            fadeDistance={140}
            fadeStrength={1.5}
            followCamera={false}
            // Never let the grid intercept a raycast meant for the model.
            raycast={() => null}
          />
        ) : null}

        {/*
          `makeDefault` registers these controls on the R3F store, which is how
          `TwinModel` and `CameraCommands` reach them without prop-drilling a
          ref between siblings.
        */}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          // Stop just short of the poles: passing through vertical flips the
          // up-vector and disorients the operator.
          minPolarAngle={0.05}
          maxPolarAngle={Math.PI - 0.05}
          autoRotate={autoRotate}
          autoRotateSpeed={0.5}
          // Matches the zoom behaviour of every CAD tool the user already knows.
          zoomToCursor
        />

        <CameraCommands />
      </Canvas>

      <LoadProgressOverlay />
    </div>
  );
}

export default TwinCanvas;
