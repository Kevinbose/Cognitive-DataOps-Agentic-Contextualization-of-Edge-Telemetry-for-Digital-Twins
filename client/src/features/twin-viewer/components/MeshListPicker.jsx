/**
 * @file Searchable list of meshes discovered in the loaded scene.
 *
 * Search is load-bearing, not polish: the real sample assets contain 800–1,200
 * nodes with machine-generated names. An unfiltered list is unusable, and
 * rendering every row at once would stall the main thread.
 *
 * @module features/twin-viewer/components/MeshListPicker
 */

import { useDeferredValue, useMemo } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
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
    <div className="flex min-h-0 flex-col">
      <div className="border-b border-line p-3">
        <label htmlFor="mesh-filter" className="sr-only">
          Filter components by name
        </label>
        <input
          id="mesh-filter"
          type="search"
          value={filter}
          onChange={(event) => dispatch(setMeshFilter(event.target.value))}
          placeholder="Filter components…"
          spellCheck={false}
          className="min-h-9 w-full rounded-md border border-line bg-sunken px-3 font-sans text-[12.5px] text-ink placeholder:text-ink-subtle transition-[background-color,border-color,box-shadow] duration-150 focus:border-primary focus:bg-surface focus:shadow-focus focus:outline-none"
        />
        <p className="mt-2 font-sans text-[11px] text-ink-muted" aria-live="polite">
          {totalMatches.toLocaleString()} component{totalMatches === 1 ? '' : 's'}
          {totalMatches > MAX_VISIBLE ? ` · showing ${MAX_VISIBLE}` : ''}
        </p>
      </div>

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
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left',
                  'transition-[background-color,color] duration-150',
                  isSelected
                    ? 'bg-signal-soft text-signal'
                    : 'text-ink-secondary hover:bg-sunken hover:text-ink',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    registered?.isMapped
                      ? 'bg-success'
                      : isSelected
                        ? 'bg-signal'
                        : 'bg-line-strong',
                  ].join(' ')}
                />

                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[11.5px]">
                    {registered?.displayName || mesh.name}
                  </span>
                  {registered?.activeBinding ? (
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-success">
                      {registered.activeBinding.sensorId}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}

        {meshes.length > 0 && visible.length === 0 ? (
          <li className="px-3 py-10 text-center">
            <p className="font-sans text-[12.5px] text-ink-muted">
              No component matches “{filter}”.
            </p>
          </li>
        ) : null}

        {meshes.length === 0 ? (
          <li className="px-3 py-10 text-center">
            <p className="font-sans text-[12.5px] text-ink-muted">Waiting for geometry…</p>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export default MeshListPicker;
