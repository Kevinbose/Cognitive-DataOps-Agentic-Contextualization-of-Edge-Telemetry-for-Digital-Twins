/**
 * @file Searchable list of meshes discovered in the loaded scene.
 *
 * Search is load-bearing, not polish: the real sample assets contain 800-1,200
 * nodes with machine-generated names. An unfiltered list is unusable, and
 * rendering every row at once would stall the main thread.
 *
 * @module features/twin-viewer/components/MeshListPicker
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { LoadingState } from '../../../components/ui/Feedback.jsx';
import { SearchField } from '../../../components/ui/Field.jsx';
import { usePrefersReducedMotion } from '../../../lib/usePrefersReducedMotion.js';
import {
  requestCameraCommand,
  selectDiscoveredMeshes,
  selectMesh,
  selectMeshFilter,
  selectSelectedMeshName,
  setMeshFilter,
} from '../twinViewerSlice.js';

/**
 * Cap on rendered rows.
 *
 * The guidelines call for virtualisation past ~50 items. A windowing library is
 * the heavier answer; capping the result set and saying so is the lighter one,
 * and it steers the operator toward search — which is how anyone actually finds
 * a part in an 800-node pack.
 */
const MAX_VISIBLE = 80;

/**
 * @param {object} props
 * @param {Map<string, import('../twinApiSlice.js').SceneMeshNode>} props.registeredByName
 * @returns {import('react').JSX.Element}
 */
export function MeshListPicker({ registeredByName }) {
  const dispatch = useAppDispatch();
  const meshes = useAppSelector(selectDiscoveredMeshes);
  const filter = useAppSelector(selectMeshFilter);
  const selectedMeshName = useAppSelector(selectSelectedMeshName);

  // Keeps typing responsive — filtering 1,200 strings on every keystroke would
  // otherwise block input on a mid-range laptop.
  const deferredFilter = useDeferredValue(filter);

  const { visible, totalMatches, start, pinned } = useMemo(() => {
    // Every word must appear in the name or the label, in any order, so
    // "lube filter" finds PRESS_LUBE_FILTER, "Lube oil filter bank".
    const words = deferredFilter.trim().toLowerCase().split(/[\s_]+/).filter(Boolean);
    const matches = words.length
      ? meshes.filter((mesh) => {
          const hay = `${mesh.name} ${mesh.label ?? ''}`.toLowerCase().replace(/_/g, ' ');
          return words.every((word) => hay.includes(word));
        })
      : meshes;
    // A part picked on the model may sit beyond the first rows: slide the window
    // to it, so the list can always show (and scroll to) the selection.
    const at = selectedMeshName ? matches.findIndex((mesh) => mesh.name === selectedMeshName) : -1;
    const start = at >= MAX_VISIBLE ? Math.max(0, Math.min(at - 20, matches.length - MAX_VISIBLE)) : 0;
    // Selected but filtered out: pinned above the list rather than lost.
    const pinned = selectedMeshName && at < 0 ? (meshes.find((mesh) => mesh.name === selectedMeshName) ?? null) : null;
    return { visible: matches.slice(start, start + MAX_VISIBLE), totalMatches: matches.length, start, pinned };
  }, [meshes, deferredFilter, selectedMeshName]);

  const listRef = useRef(/** @type {HTMLUListElement|null} */ (null));
  const reducedMotion = usePrefersReducedMotion();
  const [located, setLocated] = useState(/** @type {string|null} */ (null));

  // Picked on the model (or by the agent): bring the row into view and mark it once.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !selectedMeshName) return undefined;
    const row = /** @type {HTMLElement|null} */ (list.querySelector(`[data-mesh="${CSS.escape(selectedMeshName)}"]`));
    if (!row) return undefined;
    // The list is `relative`, so it is the row's offset parent: offsets are list-relative.
    const top = row.offsetTop;
    const hidden = top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight;
    if (!hidden) return undefined;
    list.scrollTo({
      top: Math.max(0, top - list.clientHeight / 2 + row.offsetHeight / 2),
      behavior: reducedMotion ? 'auto' : 'smooth',
    });
    setLocated(selectedMeshName);
    const timer = setTimeout(() => setLocated(null), 1300);
    return () => clearTimeout(timer);
  }, [selectedMeshName, visible, reducedMotion]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-3">
        <SearchField
          label="Filter components by name or label"
          value={filter}
          onValueChange={(value) => dispatch(setMeshFilter(value))}
          placeholder="Filter components…"
          name="componentFilter"
        />
        <p className="mt-2 text-xs text-ink-muted" aria-live="polite">
          {totalMatches.toLocaleString()} component{totalMatches === 1 ? '' : 's'}
          {totalMatches > MAX_VISIBLE ? `, showing ${start + 1} to ${Math.min(start + MAX_VISIBLE, totalMatches)}` : ''}
        </p>
      </div>

      {meshes.length === 0 ? (
        <LoadingState variant="list" label="Waiting for geometry…" />
      ) : (
        <ul ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {pinned ? (
            <li className="mb-1.5 border-b border-line pb-1.5">
              <p className="label-text px-3 pb-1">Selected on the model, outside this filter</p>
              {renderRow(pinned)}
            </li>
          ) : null}
          {visible.map((mesh) => (
            <li key={mesh.name}>{renderRow(mesh)}</li>
          ))}

          {visible.length === 0 ? (
            <li className="px-3 py-10 text-center">
              <p className="text-[13px] text-ink-muted">No component matches “{filter}”.</p>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );

  /** @param {import('../../../lib/three-helpers.js').DiscoveredMesh} mesh */
  function renderRow(mesh) {
    const registered = registeredByName.get(mesh.name);
    const isSelected = selectedMeshName === mesh.name;
    return (
                <button
                  type="button"
                  data-mesh={mesh.name}
                  onClick={() => {
                    // Pick it and fly to it: a part found by name is usually
                    // somewhere off screen in a plant this size.
                    dispatch(selectMesh(mesh.name));
                    dispatch(requestCameraCommand({ action: 'focus', meshName: mesh.name }));
                  }}
                  aria-current={isSelected ? 'true' : undefined}
                  title={`Select and zoom to ${mesh.label ?? mesh.name}`}
                  className={[
                    'block w-full px-3 py-2 text-left',
                    isSelected
                      ? 'bg-primary text-ink-inverse'
                      : 'text-ink-secondary hover:bg-sunken hover:text-ink',
                    located === mesh.name ? 'located-flash' : '',
                  ].join(' ')}
                >
                  <span className="block truncate font-mono text-xs">
                    {registered?.displayName || mesh.name}
                  </span>
                  {/* A bound component shows its sensor id on a second line.
                      The text IS the marker: no decorative dot. */}
                  {registered?.activeBinding ? (
                    <span
                      className={`mt-0.5 block truncate font-mono text-xs ${
                        isSelected ? 'text-ink-inverse' : 'text-ink'
                      }`}
                    >
                      {registered.activeBinding.sensorId}
                    </span>
                  ) : mesh.label ? (
                    <span
                      className={`mt-0.5 block truncate text-xs ${isSelected ? 'text-ink-inverse' : 'text-ink-muted'}`}
                    >
                      {mesh.label}
                    </span>
                  ) : null}
                </button>
    );
  }
}

export default MeshListPicker;
