/**
 * @file Inspector sidebar: the DOM half of the click-to-bind loop.
 *
 * Reads `selectedMeshName` from Redux, which was written by a raycast handler
 * running inside `<Canvas>`. This component and that handler share no props and
 * no parent below the store; the slice is the entire connection between them.
 *
 * The binding form itself lives in `SensorMappingForm`; this component is the
 * frame around it: the empty state, the selection header and the provenance.
 *
 * @module features/twin-viewer/components/MeshInspectorPanel
 */

import Button from '../../../components/ui/Button.jsx';
import { Crosshair, X } from '../../../components/ui/icons.js';
import { Tag } from '../../../components/ui/StatusPill.jsx';
import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { bindingDraftSet, selectBindingDraft } from '../../telemetry/telemetrySlice.js';
import {
  clearSelection,
  requestCameraCommand,
  selectDiscoveredMeshes,
  selectSelectedMeshName,
} from '../twinViewerSlice.js';
import SensorMappingForm from './SensorMappingForm.jsx';

/**
 * @param {object} props
 * @param {string} props.assetId
 * @param {Map<string, import('../twinApiSlice.js').SceneMeshNode>} props.registeredByName
 * @returns {import('react').JSX.Element}
 */
export function MeshInspectorPanel({ assetId, registeredByName }) {
  const dispatch = useAppDispatch();
  const selectedMeshName = useAppSelector(selectSelectedMeshName);
  const draft = useAppSelector(selectBindingDraft);

  const discovered = useAppSelector(selectDiscoveredMeshes);
  const registered = selectedMeshName ? registeredByName.get(selectedMeshName) : null;
  const label =
    registered?.displayName || discovered.find((mesh) => mesh.name === selectedMeshName)?.label || null;
  const activeBinding = registered?.activeBinding ?? null;

  /* ── Nothing selected ─────────────────────────────────────────────────── */
  if (!selectedMeshName) {
    return (
      <div className="relative px-5 py-8">
        <Button
          variant="ghost"
          size="icon"
          icon={X}
          onClick={() => dispatch(bindingDraftSet(null))}
          aria-label="Close the inspector"
          title="Close"
          className="absolute right-3 top-3"
        />
        <h3 className="display-section">No component selected</h3>
        {draft ? (
          // The operator picked a channel with "Bind" and now needs a target.
          <p className="mt-1.5 max-w-[17rem] text-[14px] text-ink-secondary">
            Binding <span className="data-readout break-all text-ink" translate="no">{draft}</span>.
            Click a component in the viewport, or pick one from the component list.
          </p>
        ) : (
          <p className="mt-1.5 max-w-[17rem] text-[14px] text-ink-muted">
            Click a part in the viewport, or pick one from the component list, to bind a sensor to
            it.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Selection header ────────────────────────────────────────────── */}
      <header className="border-b border-line px-4 py-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="label-text mb-1">Selected component</p>
            {label ? <p className="text-[15px] font-semibold leading-5 text-ink">{label}</p> : null}
            {/* `break-all`: glTF names are long, unbroken, slash-laden strings. */}
            <p className="mt-0.5 break-all font-mono text-xs leading-relaxed text-ink-secondary">
              {selectedMeshName}
            </p>
          </div>
          <div className="flex shrink-0">
            <Button
              variant="ghost"
              size="icon"
              icon={Crosshair}
              onClick={() =>
                dispatch(requestCameraCommand({ action: 'focus', meshName: selectedMeshName }))
              }
              aria-label="Locate in viewport"
              title="Locate in viewport"
            />
            <Button
              variant="ghost"
              size="icon"
              icon={X}
              onClick={() => dispatch(clearSelection())}
              aria-label="Close the inspector"
              title="Close"
            />
          </div>
        </div>

        {activeBinding ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Tag mono>{activeBinding.sensorId}</Tag>
            <Tag>{activeBinding.sensorType}</Tag>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-ink-muted">Not instrumented. No sensor bound.</p>
        )}
      </header>

      {/* ── Binding form ────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <SensorMappingForm
          assetId={assetId}
          meshName={selectedMeshName}
          registered={registered}
        />

        {/* ── Provenance ───────────────────────────────────────────────── */}
        {activeBinding ? (
          <dl className="mt-6 space-y-2 border border-line bg-raised p-3.5">
            <div className="flex justify-between gap-3">
              <dt className="text-xs text-ink-muted">Bound at</dt>
              <dd className="data-readout text-xs text-ink-secondary">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(activeBinding.boundAt))}
              </dd>
            </div>
            {activeBinding.boundBy ? (
              <div className="flex justify-between gap-3">
                <dt className="text-xs text-ink-muted">Bound by</dt>
                <dd className="text-xs text-ink-secondary">{activeBinding.boundBy}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

export default MeshInspectorPanel;
