/**
 * @file The digital twin workspace.
 *
 * Full-bleed, three-column: component list · 3D viewport · inspector. This page
 * straddles the two React reconcilers — `<TwinCanvas>` renders into WebGL,
 * everything beside it is ordinary DOM, and Redux is the only wire between them.
 *
 * @module features/twin-viewer/pages/TwinViewerPage
 */

import { useEffect, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import StatusPill from '../../../components/ui/StatusPill.jsx';
import { ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import MeshInspectorPanel from '../components/MeshInspectorPanel.jsx';
import MeshListPicker from '../components/MeshListPicker.jsx';
import ViewportFrame from '../components/ViewportFrame.jsx';
import TwinCanvas from '../scene/TwinCanvas.jsx';
import { useGetTwinSceneQuery } from '../twinApiSlice.js';
import {
  clearSelection,
  requestCameraReset,
  resetViewer,
  selectAutoRotate,
  selectShowBlueprintGrid,
  toggleAutoRotate,
  toggleBlueprintGrid,
} from '../twinViewerSlice.js';

/**
 * A segmented toolbar toggle.
 *
 * @param {object} props
 * @param {boolean} props.active
 * @param {() => void} props.onClick
 * @param {import('react').ReactNode} props.children
 * @returns {import('react').JSX.Element}
 */
function ToolbarToggle({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'rounded-md px-3 py-1.5 font-sans text-[12.5px] font-medium',
        'transition-[background-color,color,box-shadow] duration-150',
        active ? 'bg-surface text-primary shadow-xs' : 'text-ink-muted hover:text-ink',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

/**
 * @returns {import('react').JSX.Element}
 */
export function TwinViewerPage() {
  const { assetId } = useParams();
  const dispatch = useAppDispatch();

  const { data: scene, isLoading, isError, error, refetch } = useGetTwinSceneQuery(assetId);

  const showGrid = useAppSelector(selectShowBlueprintGrid);
  const autoRotate = useAppSelector(selectAutoRotate);

  /** Clear viewer state when switching assets, so no selection leaks across. */
  useEffect(() => {
    dispatch(resetViewer());
  }, [assetId, dispatch]);

  /** Escape clears the selection — the expected gesture in any CAD tool. */
  useEffect(() => {
    /** @param {KeyboardEvent} event */
    const onKeyDown = (event) => {
      if (event.key === 'Escape') dispatch(clearSelection());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dispatch]);

  /**
   * Name → persisted node, so the inspector and picker do O(1) lookups rather
   * than scanning an array on every render.
   */
  const registeredByName = useMemo(() => {
    const map = new Map();
    for (const node of scene?.meshNodes ?? []) map.set(node.meshName, node);
    return map;
  }, [scene?.meshNodes]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Loading twin scene…" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20">
        <ErrorState
          title="Twin scene unavailable"
          message={getErrorMessage(error)}
          action={
            <div className="flex gap-2">
              <Button size="sm" onClick={refetch}>
                Retry request
              </Button>
              <Button size="sm" to="/assets">
                Back to registry
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  if (!scene?.modelUrl) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-20">
        <ErrorState
          title="No mesh available"
          message={`"${scene?.asset?.name ?? 'This asset'}" has no converted .glb yet, so there is nothing to render. Upload one from the asset record to enable the viewer.`}
          action={
            <Button size="sm" variant="primary" to={`/assets/${assetId}`}>
              Open asset record
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── Command bar ──────────────────────────────────────────────────── */}
      <header className="z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2.5 shadow-xs">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={`/assets/${assetId}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            aria-label="Back to asset record"
          >
            <span aria-hidden="true">←</span>
          </Link>

          <div className="min-w-0">
            <h1 className="truncate font-sans text-[14px] font-semibold tracking-[-0.015em] text-ink">
              {scene.asset.name}
            </h1>
            <p className="font-mono text-[10.5px] text-ink-subtle">{assetId}</p>
          </div>

          <StatusPill status={scene.asset.status} className="ml-1 hidden sm:inline-flex" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center gap-0.5 rounded-lg bg-sunken p-0.5"
            role="group"
            aria-label="Viewport options"
          >
            <ToolbarToggle active={showGrid} onClick={() => dispatch(toggleBlueprintGrid())}>
              Grid
            </ToolbarToggle>
            <ToolbarToggle active={autoRotate} onClick={() => dispatch(toggleAutoRotate())}>
              Orbit
            </ToolbarToggle>
          </div>

          <Button size="sm" onClick={() => dispatch(requestCameraReset())}>
            Reset View
          </Button>
          <Button size="sm" to={`/assets/${assetId}/mapping`}>
            Mappings
          </Button>
        </div>
      </header>

      {/* ── Workspace ────────────────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[270px_1fr_340px]">
        {/* Component list — hidden below `lg`, where the viewport deserves the
            full width. */}
        <aside
          aria-label="Scene components"
          className="hidden min-h-0 flex-col border-r border-line bg-surface lg:flex"
        >
          <div className="border-b border-line px-4 py-3">
            <h2 className="display-section">Components</h2>
            <p className="mt-0.5 font-sans text-[11.5px] text-ink-muted">
              Discovered in the scene graph
            </p>
          </div>
          <MeshListPicker registeredByName={registeredByName} />
        </aside>

        {/* 3D viewport */}
        <div className="relative min-h-0 blueprint-grid">
          <TwinCanvas modelUrl={scene.modelUrl} />
          <ViewportFrame
            registeredCount={scene.stats.registeredNodes}
            mappedCount={scene.stats.mappedNodes}
          />
        </div>

        {/* Inspector */}
        <aside
          aria-label="Component inspector"
          className="min-h-0 border-t border-line bg-surface lg:border-l lg:border-t-0"
        >
          <MeshInspectorPanel assetId={assetId} registeredByName={registeredByName} />
        </aside>
      </div>
    </div>
  );
}

export default TwinViewerPage;
