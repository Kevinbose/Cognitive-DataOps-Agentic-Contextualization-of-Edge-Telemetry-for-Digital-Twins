/**
 * @file Viewport HUD — floating readouts over the 3D canvas.
 *
 * Plain DOM, absolutely positioned as a sibling of the canvas — not drei's
 * `<Html>`, which would reproject this through the 3D camera every frame for no
 * benefit. Screen-fixed chrome belongs in the DOM.
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
 * One figure in the census card.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {number} props.value
 * @param {string} [props.tone]
 * @returns {import('react').JSX.Element}
 */
function Stat({ label, value, tone = 'text-ink' }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt className="font-sans text-[11.5px] text-ink-muted">{label}</dt>
      <dd className={`data-readout text-[13px] font-medium ${tone}`}>{value}</dd>
    </div>
  );
}

/**
 * @param {object} props
 * @param {number} props.registeredCount
 * @param {number} props.mappedCount
 * @returns {import('react').JSX.Element}
 */
export function ViewportFrame({ registeredCount, mappedCount }) {
  const discovered = useAppSelector(selectDiscoveredMeshes);
  const hoveredMeshName = useAppSelector(selectHoveredMeshName);
  const selectedMeshName = useAppSelector(selectSelectedMeshName);

  return (
    // `pointer-events-none` on the layer: chrome must never intercept an orbit
    // drag or a mesh click. Individual children re-enable it if interactive.
    <div className="pointer-events-none absolute inset-0 z-10">
      {/* ── Scene census ────────────────────────────────────────────────── */}
      <div className="absolute right-4 top-4 w-52 rounded-lg border border-line bg-surface/90 p-3.5 shadow-md backdrop-blur-sm">
        <p className="label-micro mb-2.5">Scene Census</p>
        <dl className="space-y-1.5">
          <Stat label="Mesh nodes" value={discovered.length} />
          <Stat label="Registered" value={registeredCount} />
          <Stat
            label="Instrumented"
            value={mappedCount}
            tone={mappedCount > 0 ? 'text-success' : 'text-ink'}
          />
        </dl>
      </div>

      {/* ── Pointer readout ─────────────────────────────────────────────── */}
      <div className="absolute bottom-4 left-4 max-w-[min(30rem,60%)]">
        <div className="rounded-lg border border-line bg-surface/90 px-3.5 py-2.5 shadow-md backdrop-blur-sm">
          {/* `aria-live` so a screen-reader user is told what is under the
              pointer — otherwise this readout does not exist for them. */}
          <p className="label-micro mb-1">
            {selectedMeshName ? 'Selected' : hoveredMeshName ? 'Hover' : 'Viewport'}
          </p>
          <p className="min-w-0 break-all font-mono text-[12px] text-ink" aria-live="polite">
            {selectedMeshName ? (
              <span className="text-signal">{selectedMeshName}</span>
            ) : hoveredMeshName ? (
              <span className="text-ink-secondary">{hoveredMeshName}</span>
            ) : (
              <span className="font-sans text-[12px] text-ink-muted">
                Click a component to bind a sensor
              </span>
            )}
          </p>
        </div>
      </div>

      {/* ── Interaction legend ──────────────────────────────────────────── */}
      <div className="absolute bottom-4 right-4 hidden md:block">
        <p className="rounded-md border border-line bg-surface/80 px-2.5 py-1.5 font-sans text-[11px] text-ink-muted backdrop-blur-sm">
          Drag orbit
          <span aria-hidden="true" className="mx-1.5 text-ink-subtle">
            ·
          </span>
          Scroll zoom
          <span aria-hidden="true" className="mx-1.5 text-ink-subtle">
            ·
          </span>
          Right-drag pan
        </p>
      </div>
    </div>
  );
}

export default ViewportFrame;
