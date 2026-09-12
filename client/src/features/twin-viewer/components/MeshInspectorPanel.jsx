/**
 * @file Inspector sidebar — the DOM half of the click-to-bind loop.
 *
 * Reads `selectedMeshName` from Redux, which was written by a raycast handler
 * running inside `<Canvas>`. This component and that handler share no props and
 * no parent below the store; the slice is the entire connection between them.
 *
 * @module features/twin-viewer/components/MeshInspectorPanel
 */

import { useEffect, useState } from 'react';

import Button from '../../../components/ui/Button.jsx';
import { ErrorState } from '../../../components/ui/Feedback.jsx';
import { SelectField, TextField } from '../../../components/ui/Field.jsx';
import { Tag } from '../../../components/ui/StatusPill.jsx';
import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { clearSelection, selectSelectedMeshName } from '../twinViewerSlice.js';
import { useDeleteSensorBindingMutation, useSaveSensorBindingMutation } from '../twinApiSlice.js';

/** Mirrors the backend's `sensorType` enum. */
const SENSOR_TYPES = [
  { value: 'temperature', label: 'Temperature' },
  { value: 'vibration', label: 'Vibration' },
  { value: 'rpm', label: 'RPM' },
  { value: 'pressure', label: 'Pressure' },
  { value: 'current', label: 'Current' },
  { value: 'generic', label: 'Generic' },
];

/**
 * @param {object} props
 * @param {string} props.assetId
 * @param {Map<string, import('../twinApiSlice.js').SceneMeshNode>} props.registeredByName
 * @returns {import('react').JSX.Element}
 */
export function MeshInspectorPanel({ assetId, registeredByName }) {
  const dispatch = useAppDispatch();
  const selectedMeshName = useAppSelector(selectSelectedMeshName);

  const [saveBinding, saveState] = useSaveSensorBindingMutation();
  const [deleteBinding, deleteState] = useDeleteSensorBindingMutation();

  const registered = selectedMeshName ? registeredByName.get(selectedMeshName) : null;
  const activeBinding = registered?.activeBinding ?? null;

  const [sensorId, setSensorId] = useState('');
  const [sensorType, setSensorType] = useState('generic');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState('');
  const [conflict, setConflict] = useState(null);

  /**
   * Re-seed the form whenever the selection changes.
   *
   * Without this, moving from an instrumented part to a bare one would leave
   * the previous sensor ID in the field — one careless Save from binding the
   * wrong sensor.
   */
  useEffect(() => {
    setSensorId(activeBinding?.sensorId ?? '');
    setSensorType(activeBinding?.sensorType ?? 'generic');
    setDisplayName(registered?.displayName ?? '');
    setFormError('');
    setConflict(null);
  }, [selectedMeshName, activeBinding, registered]);

  /** @param {boolean} reassign - Retry with permission to move the sensor. */
  async function submit(reassign = false) {
    setFormError('');
    setConflict(null);

    if (!sensorId.trim()) {
      setFormError('Sensor ID is required.');
      return;
    }

    try {
      await saveBinding({
        assetId,
        meshName: selectedMeshName,
        sensorId: sensorId.trim(),
        sensorType,
        displayName: displayName.trim() || null,
        reassign,
      }).unwrap();
    } catch (error) {
      // 409 means the sensor is live on another mesh. Surface the explicit
      // reassign path rather than dead-ending.
      if (error?.status === 409) {
        setConflict(getErrorMessage(error));
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  async function handleUnbind() {
    setFormError('');
    try {
      await deleteBinding({ assetId, bindingId: activeBinding._id }).unwrap();
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  }

  /* ── Nothing selected ─────────────────────────────────────────────────── */
  if (!selectedMeshName) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
        <div
          aria-hidden="true"
          className="mb-4 flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-gradient-to-b from-surface to-sunken text-xl text-ink-subtle shadow-xs"
        >
          ◈
        </div>
        <h3 className="mb-1.5 font-sans text-[14px] font-semibold tracking-[-0.015em] text-ink">
          No component selected
        </h3>
        <p className="max-w-[17rem] font-sans text-[12.5px] leading-relaxed text-ink-muted">
          Click a part in the viewport, or pick one from the component list, to bind a sensor to it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── Selection header ────────────────────────────────────────────── */}
      <header className="border-b border-line px-4 py-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="label-micro mb-1.5">Selected Component</p>
            {/* `break-all`: glTF names are long, unbroken, slash-laden strings. */}
            <p className="break-all font-mono text-[12px] leading-relaxed text-ink">
              {selectedMeshName}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dispatch(clearSelection())}
            aria-label="Clear selection"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-muted transition-colors duration-150 hover:bg-sunken hover:text-danger"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        {activeBinding ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-success-border bg-success-soft px-2.5 py-1">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
              <span className="font-mono text-[11px] font-medium text-success">
                {activeBinding.sensorId}
              </span>
            </span>
            <Tag>{activeBinding.sensorType}</Tag>
          </div>
        ) : (
          <p className="mt-3 font-sans text-[12px] text-ink-muted">
            Not instrumented — no sensor bound.
          </p>
        )}
      </header>

      {/* ── Binding form ────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(false);
          }}
          noValidate
          className="space-y-4"
        >
          <TextField
            label="Sensor ID"
            required
            mono
            value={sensorId}
            onChange={(event) => setSensorId(event.target.value)}
            placeholder="MOTOR_01_TEMP"
            hint="Letters, digits, underscore, hyphen, dot. Upper-cased on save."
            error={formError && !sensorId.trim() ? formError : undefined}
            spellCheck={false}
            autoComplete="off"
            name="sensorId"
          />

          <SelectField
            label="Sensor Type"
            options={SENSOR_TYPES}
            value={sensorType}
            onChange={(event) => setSensorType(event.target.value)}
          />

          <TextField
            label="Display Label"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Main Drive Motor"
            hint="Optional. Shown instead of the raw glTF name."
            autoComplete="off"
            name="displayName"
          />

          {conflict ? (
            <div
              role="alert"
              className="rounded-lg border border-warning-border bg-warning-soft px-4 py-3.5"
            >
              <h3 className="font-sans text-[13px] font-semibold text-warning">
                Sensor already bound
              </h3>
              <p className="mt-1 font-sans text-[12.5px] leading-relaxed text-ink-secondary">
                {conflict}
              </p>
              <Button
                size="sm"
                variant="danger"
                className="mt-3"
                onClick={() => submit(true)}
                loading={saveState.isLoading}
              >
                Reassign sensor
              </Button>
            </div>
          ) : null}

          {formError && sensorId.trim() ? (
            <ErrorState title="Save failed" message={formError} />
          ) : null}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button type="submit" variant="primary" loading={saveState.isLoading}>
              {activeBinding ? 'Update Binding' : 'Bind Sensor'}
            </Button>
            {activeBinding ? (
              <Button variant="subtle" onClick={handleUnbind} loading={deleteState.isLoading}>
                Unbind
              </Button>
            ) : null}
          </div>
        </form>

        {/* ── Provenance ───────────────────────────────────────────────── */}
        {activeBinding ? (
          <dl className="mt-6 space-y-2 rounded-lg border border-line bg-sunken/60 p-3.5">
            <div className="flex justify-between gap-3">
              <dt className="font-sans text-[11.5px] text-ink-muted">Bound at</dt>
              <dd className="data-readout text-[11.5px] text-ink-secondary">
                {new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(activeBinding.boundAt))}
              </dd>
            </div>
            {activeBinding.boundBy ? (
              <div className="flex justify-between gap-3">
                <dt className="font-sans text-[11.5px] text-ink-muted">Bound by</dt>
                <dd className="font-sans text-[11.5px] text-ink-secondary">
                  {activeBinding.boundBy}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

export default MeshInspectorPanel;
