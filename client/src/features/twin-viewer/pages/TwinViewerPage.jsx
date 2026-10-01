/**
 * @file The digital twin workspace.
 *
 * Full-bleed, three-column: component list, 3D viewport, inspector. This page
 * straddles the two React reconcilers: `<TwinCanvas>` renders into WebGL,
 * everything beside it is ordinary DOM, and Redux is the only wire between them.
 *
 * @module features/twin-viewer/pages/TwinViewerPage
 */

import { useEffect, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';

import Button from '../../../components/ui/Button.jsx';
import Icon from '../../../components/ui/Icon.jsx';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowsClockwise,
  CubeFocus,
  GridFour,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from '../../../components/ui/icons.js';
import { SegmentedButton, SegmentedGroup } from '../../../components/ui/Segmented.jsx';
import StatusPill from '../../../components/ui/StatusPill.jsx';
import { Tabs, tabId, tabPanelId } from '../../../components/ui/Tabs.jsx';
import { ErrorState, LoadingState } from '../../../components/ui/Feedback.jsx';
import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { usePageTitle } from '../../../lib/usePageTitle.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import ConnectionChip from '../../telemetry/components/ConnectionChip.jsx';
import DeviceStrip from '../../telemetry/components/DeviceStrip.jsx';
import FaultPanel from '../../telemetry/components/FaultPanel.jsx';
import LiveChannelsPanel from '../../telemetry/components/LiveChannelsPanel.jsx';
import MachinesPanel from '../../telemetry/components/MachinesPanel.jsx';
import { useAssetRoom } from '../../telemetry/realtime/socketClient.js';
import { useGetMetaQuery } from '../../telemetry/telemetryApiSlice.js';
import { useTwinMachines } from '../../telemetry/useTwinMachines.js';
import MeshInspectorPanel from '../components/MeshInspectorPanel.jsx';
import MeshListPicker from '../components/MeshListPicker.jsx';
import ViewportFrame from '../components/ViewportFrame.jsx';
import TwinCanvas from '../scene/TwinCanvas.jsx';
import { useGetTwinSceneQuery } from '../twinApiSlice.js';
import {
  clearSelection,
  requestCameraCommand,
  requestCameraReset,
  resetViewer,
  selectAutoRotate,
  selectShowBlueprintGrid,
  toggleAutoRotate,
  toggleBlueprintGrid,
} from '../twinViewerSlice.js';

/**
 * One icon-only button in the camera group. The `aria-label` is its name; the
 * `title` is the hover tooltip for sighted mouse users.
 *
 * @param {object} props
 * @param {import('react').ElementType} props.icon
 * @param {string} props.label
 * @param {() => void} props.onClick
 * @returns {import('react').JSX.Element}
 */
function CameraButton({ icon, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center border-l border-control text-ink-secondary first:border-l-0 hover:bg-sunken hover:text-ink"
    >
      <Icon icon={icon} size={20} />
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
  const { attached: machines } = useTwinMachines(assetId);
  const { data: meta } = useGetMetaQuery();

  // Another tab (or, later, the agent) changing this asset's bindings refreshes
  // this one through the socket.
  useAssetRoom(assetId);

  /**
   * The left panel's tab lives in the URL (`?panel=telemetry`), so a view can be
   * bookmarked or sent to a colleague. With no tab in the URL, a twin that has no
   * machine yet opens on Machines (the first step of connecting it), and one that
   * has opens on Components.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const faultsAvailable = Boolean(meta?.features?.deviceCommands);
  const requestedPanel = searchParams.get('panel');
  const validPanels = ['machines', 'components', 'telemetry', ...(faultsAvailable ? ['faults'] : [])];
  const panel = validPanels.includes(requestedPanel ?? '')
    ? /** @type {string} */ (requestedPanel)
    : machines.length === 0
      ? 'machines'
      : 'components';

  /** @param {string} next */
  const setPanel = (next) => {
    const params = new URLSearchParams(searchParams);
    params.set('panel', next);
    setSearchParams(params, { replace: true });
  };

  /** @type {Array<{id: string, label: string, count?: number}>} */
  const panelTabs = [
    { id: 'machines', label: 'Machines', count: machines.length },
    { id: 'components', label: 'Components' },
    { id: 'telemetry', label: 'Telemetry' },
    ...(faultsAvailable ? [{ id: 'faults', label: 'Faults' }] : []),
  ];

  usePageTitle(scene?.asset?.name ? `${scene.asset.name}, digital twin` : 'Digital twin');

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
      <main id="main-content" className="mx-auto max-w-5xl px-6 py-12">
        <h1 className="sr-only">Digital twin</h1>
        <LoadingState variant="page" label="Loading twin scene…" />
      </main>
    );
  }

  if (isError) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="sr-only">Digital twin</h1>
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
      </main>
    );
  }

  if (!scene?.modelUrl) {
    return (
      <main id="main-content" className="mx-auto max-w-2xl px-6 py-20">
        <h1 className="sr-only">Digital twin</h1>
        <ErrorState
          title="No mesh available"
          message={`“${scene?.asset?.name ?? 'This asset'}” has no converted .glb yet, so there is nothing to render. Upload one from the asset record to enable the viewer.`}
          action={
            <Button size="sm" variant="primary" to={`/assets/${assetId}`}>
              Open asset record
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      {/* First tabbable element: jump past the toolbar and the component list. */}
      <a
        href="#viewport"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-primary focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink-inverse"
      >
        Skip to viewport
      </a>

      {/* ── Command bar ──────────────────────────────────────────────────── */}
      <header className="z-20 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            to={`/assets/${assetId}`}
            variant="ghost"
            size="icon"
            icon={ArrowLeft}
            aria-label="Back to asset record"
          />

          <div className="min-w-0">
            <h1 className="display-section truncate">{scene.asset.name}</h1>
            <p className="font-mono text-xs text-ink-muted">{assetId}</p>
          </div>

          <StatusPill status={scene.asset.status} className="ml-2 hidden sm:inline-flex" />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ConnectionChip className="mr-2" />

          <SegmentedGroup label="Viewport options">
            <SegmentedButton
              pressed={showGrid}
              onClick={() => dispatch(toggleBlueprintGrid())}
              icon={GridFour}
            >
              Grid
            </SegmentedButton>
            <SegmentedButton
              pressed={autoRotate}
              onClick={() => dispatch(toggleAutoRotate())}
              icon={ArrowsClockwise}
            >
              Orbit
            </SegmentedButton>
          </SegmentedGroup>

          {/* Click alternatives to the mouse gestures: zoom and rotate. */}
          <div
            role="group"
            aria-label="Camera controls"
            className="inline-flex border border-control bg-raised"
          >
            <CameraButton
              icon={MagnifyingGlassMinus}
              label="Zoom out"
              onClick={() => dispatch(requestCameraCommand('zoomOut'))}
            />
            <CameraButton
              icon={MagnifyingGlassPlus}
              label="Zoom in"
              onClick={() => dispatch(requestCameraCommand('zoomIn'))}
            />
            <CameraButton
              icon={ArrowCounterClockwise}
              label="Rotate left"
              onClick={() => dispatch(requestCameraCommand('rotateLeft'))}
            />
            <CameraButton
              icon={ArrowClockwise}
              label="Rotate right"
              onClick={() => dispatch(requestCameraCommand('rotateRight'))}
            />
          </div>

          <Button size="sm" icon={CubeFocus} onClick={() => dispatch(requestCameraReset())}>
            Reset view
          </Button>
          <Button size="sm" to={`/assets/${assetId}/mapping`}>
            Mappings
          </Button>
        </div>
      </header>

      <DeviceStrip assetId={assetId} />

      {/* ── Workspace ────────────────────────────────────────────────────────
          Three columns from `lg`. Below that they stack: the panel above the
          viewport, the inspector below it, and the page scrolls. */}
      <main
        id="main-content"
        className="grid flex-1 grid-cols-1 lg:min-h-0 lg:grid-cols-[288px_1fr_360px]"
      >
        {/* Scene panel: components, live telemetry and (in demo mode) faults. */}
        <aside
          aria-label="Scene panel"
          className="flex max-h-[45dvh] min-h-0 flex-col border-b border-line bg-surface lg:max-h-none lg:border-b-0 lg:border-r"
        >
          <Tabs
            label="Scene panel"
            tabs={panelTabs}
            value={panel}
            onChange={setPanel}
            className="shrink-0 border-b border-line"
          />

          <div
            role="tabpanel"
            id={tabPanelId(panel)}
            aria-labelledby={tabId(panel)}
            className="flex min-h-0 flex-1 flex-col"
          >
            {panel === 'machines' ? (
              <>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="display-section">Machines</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">Gateways connected to this twin</p>
                </div>
                <MachinesPanel
                  assetId={assetId}
                  onShowTelemetry={() => setPanel('telemetry')}
                  onKeepOpen={() => setPanel('machines')}
                />
              </>
            ) : null}

            {panel === 'components' ? (
              <>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="display-section">Components</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">Discovered in the scene graph</p>
                </div>
                <MeshListPicker registeredByName={registeredByName} />
              </>
            ) : null}

            {panel === 'telemetry' ? (
              <>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="display-section">Telemetry</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">Live from the edge gateways</p>
                </div>
                <LiveChannelsPanel
                  assetId={assetId}
                  registeredByName={registeredByName}
                  onOpenMachines={() => setPanel('machines')}
                />
              </>
            ) : null}

            {panel === 'faults' ? (
              <>
                <div className="border-b border-line px-4 py-3">
                  <h2 className="display-section">Fault injection</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">Demo controls, no cable needed</p>
                </div>
                <FaultPanel assetId={assetId} />
              </>
            ) : null}
          </div>
        </aside>

        {/* 3D viewport */}
        <div id="viewport" className="stage relative h-[60dvh] lg:h-auto lg:min-h-0">
          <TwinCanvas modelUrl={scene.modelUrl} />
          <ViewportFrame
            registeredCount={scene.stats.registeredNodes}
            mappedCount={scene.stats.mappedNodes}
          />
        </div>

        {/* Inspector */}
        <aside
          aria-label="Component inspector"
          className="min-h-0 border-t border-line bg-surface lg:overflow-y-auto lg:border-l lg:border-t-0"
        >
          <h2 className="sr-only">Component inspector</h2>
          <MeshInspectorPanel assetId={assetId} registeredByName={registeredByName} />
        </aside>
      </main>
    </div>
  );
}

export default TwinViewerPage;
