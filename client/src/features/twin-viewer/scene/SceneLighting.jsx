/**
 * @file Scene lighting rig.
 *
 * Deliberately built from explicit lights rather than drei's `<Environment>`.
 * `<Environment preset>` downloads an HDRI from a CDN on every cold load —
 * an external network dependency inside a plant-floor tool, and a blocking
 * one at that. A hand-built three-point rig is deterministic, offline-safe,
 * and instant.
 *
 * The rig is tuned for *technical legibility*, not cinematic drama: the
 * operator needs to distinguish adjacent grey machine parts, so the priority
 * is even coverage with enough directional bias to keep edges readable.
 *
 * @module features/twin-viewer/scene/SceneLighting
 */

/**
 * Three-point lighting plus a hemisphere fill.
 *
 * @returns {import('react').JSX.Element}
 */
export function SceneLighting() {
  return (
    <>
      {/*
        Hemisphere fill: paper-toned sky against a cooler ground bounce. This is
        what stops downward-facing surfaces going pure black in an asset pack
        that ships no lights of its own.
      */}
      <hemisphereLight args={['#ffffff', '#c8c8c0', 1.15]} />

      {/* Base ambient so no face is ever unlit. */}
      <ambientLight intensity={0.55} />

      {/* Key — establishes primary form and edge direction. */}
      <directionalLight position={[8, 12, 6]} intensity={1.5} color="#ffffff" />

      {/* Fill — softens the key's shadow side without flattening the form. */}
      <directionalLight position={[-7, 5, -4]} intensity={0.55} color="#f0f0ea" />

      {/* Rim — separates the model's silhouette from the pale canvas behind it. */}
      <directionalLight position={[0, -6, -9]} intensity={0.35} color="#ffffff" />
    </>
  );
}

export default SceneLighting;
