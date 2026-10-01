/**
 * @file Searchable list of meshes discovered in the loaded scene.
 *
 * Search is load-bearing, not polish: the real sample assets contain 800-1,200
 * nodes with machine-generated names. An unfiltered list is unusable, and
 * rendering every row at once would stall the main thread.
 *
 * @module features/twin-viewer/components/MeshListPicker
 */

import { useDeferredValue, useMemo } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { LoadingState } from '../../../components/ui/Feedback.jsx';
import { SearchField } from '../../../components/ui/Field.jsx';
import {
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

  const { visible, totalMatches } = useMemo(() => {
    const needle = deferredFilter.trim().toLowerCase();
    const matches = needle
      ? meshes.filter((mesh) => mesh.name.toLowerCase().includes(needle))
      : meshes;
    return { visible: matches.slice(0, MAX_VISIBLE), totalMatches: matches.length };
  }, [meshes, deferredFilter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-3">
        <SearchField
          label="Filter components by name"
          value={filter}
          onValueChange={(value) => dispatch(setMeshFilter(value))}
          placeholder="Filter components…"
          name="componentFilter"
        />
        <p className="mt-2 text-xs text-ink-muted" aria-live="polite">
          {totalMatches.toLocaleString()} component{totalMatches === 1 ? '' : 's'}
          {totalMatches > MAX_VISIBLE ? `, showing ${MAX_VISIBLE}` : ''}
        </p>
      </div>

      {meshes.length === 0 ? (
        <LoadingState variant="list" label="Waiting for geometry…" />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {visible.map((mesh) => {
            const registered = registeredByName.get(mesh.name);
            const isSelected = selectedMeshName === mesh.name;

            return (
              <li key={mesh.name}>
                <button
                  type="button"
                  onClick={() => dispatch(selectMesh(mesh.name))}
                  aria-current={isSelected ? 'true' : undefined}
                  className={[
                    'block w-full px-3 py-2 text-left',
                    isSelected
                      ? 'bg-primary text-ink-inverse'
                      : 'text-ink-secondary hover:bg-sunken hover:text-ink',
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
                  ) : null}
                </button>
              </li>
            );
          })}

          {visible.length === 0 ? (
            <li className="px-3 py-10 text-center">
              <p className="text-[13px] text-ink-muted">No component matches “{filter}”.</p>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

export default MeshListPicker;
