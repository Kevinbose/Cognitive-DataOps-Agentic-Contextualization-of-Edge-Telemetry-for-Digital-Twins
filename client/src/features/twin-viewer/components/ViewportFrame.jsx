/**
 * @file Viewport HUD: floating readouts over the 3D canvas.
 *
 * Plain DOM, absolutely positioned as a sibling of the canvas, not drei's
 * `<Html>`, which would reproject this through the 3D camera every frame for no
 * benefit. Screen-fixed chrome belongs in the DOM.
 *
 * Every panel is opaque: no blur, no translucency, no shadow. The stage behind
 * them is a plain flat colour, so there is nothing for a frosted panel to do
 * except cost GPU time.
 *
 * @module features/twin-viewer/components/ViewportFrame
 */

import { useAppSelector } from '../../../app/hooks.js';
import {
  selectDiscoveredMeshes,
  selectHoveredMeshName,
  selectSelectedMeshName,
} from '../twinViewerSlice.js';

/**
 * One figure in the census panel.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {number} props.value
 * @returns {import('react').JSX.Element}
 */
function Stat({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="data-readout font-medium text-ink">{value}</dd>
    </div>
  );
}

/**
 * @param {object} props
 * @param {number} props.registeredCount
 * @param {number} props.mappedCount
 * @param {number} [props.rightInset] - Pixels covered on the right by the inspector.
 * @param {boolean} [props.quiet] - The assistant is open over the viewport: hide the census and the legend.
 * @returns {import('react').JSX.Element}
 */
export function ViewportFrame({ registeredCount, mappedCount, rightInset = 0, quiet = false }) {
  const discovered = useAppSelector(selectDiscoveredMeshes);
  const hoveredMeshName = useAppSelector(selectHoveredMeshName);
  const selectedMeshName = useAppSelector(selectSelectedMeshName);

  return (
    // `pointer-events-none` on the layer: chrome must never intercept an orbit
    // drag or a mesh click. Individual children re-enable it if interactive.
    // The right edge moves left while the inspector covers it.
    <div className="pointer-events-none absolute inset-y-0 left-0 z-10" style={{ right: rightInset }}>
      {/* ── Scene census ────────────────────────────────────────────────── */}
      <div className={`absolute right-4 top-4 w-52 border border-line bg-surface p-4 ${quiet ? 'hidden' : 'fade-in'}`}>
        <p className="label-text mb-2.5 text-ink-secondary">Scene census</p>
        <dl className="space-y-1.5">
          <Stat label="Mesh nodes" value={discovered.length} />
          <Stat label="Registered" value={registeredCount} />
          <Stat label="Instrumented" value={mappedCount} />
        </dl>
      </div>

      {/* ── Bottom row: pointer readout and interaction legend ─────────────
          One flex row, so a long mesh name and the legend can never overlap. */}
      <div className="absolute inset-x-4 bottom-4 flex items-end justify-between gap-4">
        <div className="min-w-0 max-w-[30rem] flex-1 border border-line bg-surface px-4 py-2.5">
          <p className="label-text mb-1 text-ink-secondary">
            {selectedMeshName ? 'Selected' : hoveredMeshName ? 'Hover' : 'Viewport'}
          </p>
          {/* `aria-live` so a screen-reader user is told what is under the
              pointer; otherwise this readout does not exist for them. */}
          <p className="min-w-0 break-all font-mono text-xs text-ink" aria-live="polite">
            {selectedMeshName ? (
              <span className="font-medium text-primary">{selectedMeshName}</span>
            ) : hoveredMeshName ? (
              <span className="text-ink-secondary">{hoveredMeshName}</span>
            ) : (
              <span className="font-sans text-xs text-ink-muted">
                Click a component to bind a sensor
              </span>
            )}
          </p>
        </div>

        <p className={`hidden shrink-0 border border-line bg-surface px-3 py-1.5 text-xs text-ink-muted ${quiet ? '' : 'fade-in xl:block'}`}>
          Drag to orbit, scroll to zoom, right-drag to pan
        </p>
      </div>
    </div>
  );
}

export default ViewportFrame;
