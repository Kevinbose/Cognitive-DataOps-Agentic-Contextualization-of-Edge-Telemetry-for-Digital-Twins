/**
 * @file The sensor-binding form: pick a live channel, see it, bind it.
 *
 * ## How binding works (RTK Query, in one place)
 *
 * Saving is `useSaveSensorBindingMutation`, which is
 * `PUT /api/v1/assets/:assetId/mesh-nodes/by-name/:meshName/sensor-binding`.
 * It is addressed by mesh NAME because that is all the canvas knows at click
 * time, and it is idempotent: submitting the same sensor for the same mesh
 * twice leaves one state and reports `unchanged: true`.
 *
 * The mutation declares `invalidatesTags: [TwinScene(assetId), Asset(assetId)]`.
 * RTK Query therefore refetches the scene by itself, and that one refetch is
 * what updates the component list, the census, this form's "Update binding"
 * state and the scene's own data, with no manual cache patching. Other open
 * tabs learn of it through the socket's `twin:invalidate`.
 *
 * ## Why this form does not re-render with the data
 *
 * Live values are NOT read here. The preview is a small child that subscribes to
 * one channel, so the form (and whatever the operator is typing) is untouched by
 * the 4 Hz telemetry. The re-seed effect is keyed on the selection and the
 * persisted binding only; it never depends on live data or on the device list.
 *
 * ## Channel choice
 *
 * A `<select>` with one `<optgroup>` per device, fed by the channels the devices
 * declared in their `birth` messages, plus "Enter an ID manually" for a sensor
 * that is not a known channel. Choosing a channel fills the sensor type (still
 * editable), so a typo in an ID is impossible for the normal case.
 *
 * @module features/twin-viewer/components/SensorMappingForm
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import Button from '../../../components/ui/Button.jsx';
import { ErrorState } from '../../../components/ui/Feedback.jsx';
import { SelectField, TextField } from '../../../components/ui/Field.jsx';
import Icon from '../../../components/ui/Icon.jsx';
import { Warning } from '../../../components/ui/icons.js';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { formatAge, formatValue, STATUS_LABEL } from '../../../lib/format.js';
import { useNow } from '../../../lib/useNow.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useGetMetaQuery } from '../../telemetry/telemetryApiSlice.js';
import { useTwinMachines } from '../../telemetry/useTwinMachines.js';
import {
  announced,
  bindingDraftSet,
  selectBindingDraft,
  selectDeviceList,
  selectLatestMap,
} from '../../telemetry/telemetrySlice.js';
import { useDeleteSensorBindingMutation, useSaveSensorBindingMutation } from '../twinApiSlice.js';
import { flashMesh } from '../twinViewerSlice.js';

/** Sentinel `<option>` value for "type the ID yourself". Not a valid sensor ID. */
const MANUAL = '__manual__';

/** Used until `GET /meta` answers, so the form never renders an empty list. */
const FALLBACK_SENSOR_TYPES = [
  'temperature',
  'vibration',
  'rpm',
  'pressure',
  'current',
  'torque',
  'displacement',
  'generic',
];

/** @param {string} value @returns {string} `rpm` to `RPM`, `torque` to `Torque`. */
const typeLabel = (value) => (value === 'rpm' ? 'RPM' : value.charAt(0).toUpperCase() + value.slice(1));

/**
 * What the chosen channel is reading right now.
 *
 * A separate component on purpose: it alone subscribes to live data, so the
 * form above it does not re-render four times a second.
 *
 * @param {object} props
 * @param {string} props.sensorId
 * @returns {import('react').JSX.Element|null}
 */
function ChannelPreview({ sensorId }) {
  const sample = useAppSelector((state) => selectLatestMap(state)[sensorId]);
  const device = useAppSelector((state) =>
    selectDeviceList(state).find((candidate) => candidate.machineId === sample?.machineId),
  );
  const now = useNow();

  if (!sensorId) return null;

  if (!sample) {
    return (
      <p className="border border-line bg-raised px-3 py-2.5 text-xs text-ink-muted">
        No live data for this ID yet. You can still bind it; values appear when a device publishes it.
      </p>
    );
  }

  const state = device && device.state !== 'online' ? device.state : sample.status;
  const label = device && device.state !== 'online' ? undefined : STATUS_LABEL[sample.status];

  return (
    <div className="border border-line bg-raised px-3 py-2.5">
      <p className="label-text text-ink-secondary">Live preview</p>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="data-readout text-[15px] font-medium text-ink">
          {formatValue(sample.value, sample.decimals)}
          {` ${sample.unit}`}
        </span>
        <StatusMarker state={state} label={label} className="text-xs" />
      </div>
      <p className="mt-0.5 text-xs text-ink-muted">Updated {formatAge(sample.rx, now)}</p>
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.assetId
 * @param {string} props.meshName - Raw glTF name of the selected component.
 * @param {import('../twinApiSlice.js').SceneMeshNode|null|undefined} props.registered
 *   The persisted mesh node, if the component has ever been bound.
 * @returns {import('react').JSX.Element}
 */
export function SensorMappingForm({ assetId, meshName, registered }) {
  const dispatch = useAppDispatch();
  const formRef = useRef(/** @type {HTMLFormElement|null} */ (null));

  const { data: meta } = useGetMetaQuery();
  // Only the machines added to this twin offer channels to bind.
  const { attached: devices } = useTwinMachines(assetId);
  const draft = useAppSelector(selectBindingDraft);

  const [saveBinding, saveState] = useSaveSensorBindingMutation();
  const [deleteBinding, deleteState] = useDeleteSensorBindingMutation();

  const activeBinding = registered?.activeBinding ?? null;

  // The form re-seeds from these PRIMITIVES, never from the `registered` or
  // `activeBinding` objects themselves. A background refetch (the window regaining
  // focus, another tab's change over the socket, even the refetch that follows a
  // REJECTED save, because RTK Query invalidates on failure too) hands back
  // brand-new objects with identical contents; keying on identity would re-seed
  // the form and wipe what the operator was typing, or a conflict card they were
  // reading.
  const boundId = activeBinding?._id ?? null;
  const boundSensor = activeBinding?.sensorId ?? '';
  const boundType = activeBinding?.sensorType ?? 'generic';
  const nodeLabel = registered?.displayName ?? '';

  const [choice, setChoice] = useState('');
  const [manualId, setManualId] = useState('');
  const [sensorType, setSensorType] = useState('generic');
  const [displayName, setDisplayName] = useState('');
  const [formError, setFormError] = useState('');
  const [conflict, setConflict] = useState('');

  /** Every declared channel by sensor id, for type auto-fill and "is this known?". */
  const channelsById = useMemo(() => {
    const map = new Map();
    for (const device of devices) {
      for (const channel of device.channels) map.set(channel.sensorId, channel);
    }
    return map;
  }, [devices]);

  // The re-seed effect must not depend on `devices` (they change every diag
  // interval and would wipe the operator's typing), so it reads them through a
  // ref. This effect is declared before the others so the ref is current when
  // they run in the same commit.
  const channelsRef = useRef(channelsById);
  // The persisted label is read the same way: it is an INPUT to a re-seed, not a
  // reason for one. A label that changes while the operator is mid-edit (a failed
  // save on a standalone database still registers the mesh node with the typed
  // label, say) must not reset the fields.
  const labelRef = useRef(nodeLabel);
  useEffect(() => {
    channelsRef.current = channelsById;
    labelRef.current = nodeLabel;
  }, [channelsById, nodeLabel]);

  const groups = useMemo(
    () => [
      ...devices.map((device) => ({
        label: device.label,
        options: device.channels.map((channel) => ({
          value: channel.sensorId,
          label: `${channel.label} (${channel.unit})`,
        })),
      })),
      { label: 'Other', options: [{ value: MANUAL, label: 'Enter an ID manually' }] },
    ],
    [devices],
  );

  const sensorTypes = (meta?.sensorTypes ?? FALLBACK_SENSOR_TYPES).map((value) => ({
    value,
    label: typeLabel(value),
  }));

  const sensorId = choice === MANUAL ? manualId.trim() : choice;

  /**
   * Re-seed the form whenever the selection or its persisted binding changes.
   *
   * Without this, moving from an instrumented part to a bare one would leave
   * the previous sensor ID in the field: one careless Save from binding the
   * wrong sensor. Deliberately NOT keyed on live data or on the device list.
   */
  useEffect(() => {
    const known = channelsRef.current.has(boundSensor);

    setChoice(boundSensor ? (known ? boundSensor : MANUAL) : '');
    setManualId(boundSensor && !known ? boundSensor : '');
    setSensorType(boundType);
    setDisplayName(labelRef.current);
    setFormError('');
    setConflict('');
  }, [meshName, boundId, boundSensor, boundType]);

  /**
   * A channel picked with "Bind" in the telemetry list pre-selects here, but
   * only for a component that has no binding of its own to lose.
   */
  useEffect(() => {
    if (!draft || boundId) return;
    setChoice(draft);
    setManualId('');
    const channel = channelsRef.current.get(draft);
    if (channel) setSensorType(channel.sensorType);
  }, [draft, boundId]);

  /** After a failed submit, move focus to the field that needs attention. */
  useEffect(() => {
    if (formError) formRef.current?.querySelector('[aria-invalid="true"]')?.focus();
  }, [formError]);

  /** @param {import('react').ChangeEvent<HTMLSelectElement>} event */
  function onChannelChange(event) {
    const next = event.target.value;
    setChoice(next);
    setFormError('');
    setConflict('');

    // Picking a known channel fills its sensor type; the operator can still override it.
    const channel = channelsById.get(next);
    if (channel) setSensorType(channel.sensorType);
  }

  /** @param {boolean} reassign - Retry with permission to move the sensor. */
  async function submit(reassign = false) {
    setFormError('');
    setConflict('');

    if (!sensorId) {
      setFormError(choice === MANUAL ? 'Enter a sensor ID.' : 'Choose a channel to bind.');
      return;
    }

    try {
      const result = await saveBinding({
        assetId,
        meshName,
        sensorId,
        sensorType,
        displayName: displayName.trim() || null,
        reassign,
      }).unwrap();

      dispatch(bindingDraftSet(null));

      if (result.unchanged) {
        dispatch(announced(`${sensorId} was already bound to this component`));
      } else {
        // Confirmation in three channels: the mesh flashes green, the speech
        // queue announces it, and the scene refetch updates every panel.
        dispatch(flashMesh(meshName));
        dispatch(announced(`Bound ${sensorId} to ${displayName.trim() || meshName}`));
      }
    } catch (error) {
      // 409: the sensor is live on another mesh. Show the server's ACTIONABLE
      // message (not the terse field error) beside the explicit reassign path.
      if (error?.status === 409) {
        setConflict(error?.data?.message ?? getErrorMessage(error));
        return;
      }
      setFormError(getErrorMessage(error));
    }
  }

  async function handleUnbind() {
    setFormError('');
    try {
      await deleteBinding({ assetId, bindingId: activeBinding._id }).unwrap();
      dispatch(announced(`Unbound ${activeBinding.sensorId}`));
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  }

  const choiceError = formError && !sensorId && choice !== MANUAL ? formError : undefined;
  const manualError = formError && !sensorId && choice === MANUAL ? formError : undefined;
  const otherError = formError && sensorId ? formError : undefined;

  return (
    <form
      ref={formRef}
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
      noValidate
      className="space-y-4"
    >
      <SelectField
        label="Channel"
        required
        name="channel"
        autoComplete="off"
        placeholder="Choose a channel"
        groups={groups}
        value={choice}
        onChange={onChannelChange}
        error={choiceError}
        hint={
          devices.length === 0
            ? 'No machines are on this twin. Add one in the Machines tab, or choose "Enter an ID manually" to bind a sensor that is not live yet.'
            : 'The channels of the machines added to this twin.'
        }
      />

      {choice === MANUAL ? (
        <TextField
          label="Sensor ID"
          required
          mono
          value={manualId}
          onChange={(event) => setManualId(event.target.value)}
          placeholder="MOTOR_01_TEMP"
          hint="Letters, digits, underscore, hyphen, dot. Upper-cased on save."
          error={manualError}
          spellCheck={false}
          autoComplete="off"
          name="sensorId"
        />
      ) : null}

      <ChannelPreview sensorId={sensorId} />

      <SelectField
        label="Sensor type"
        name="sensorType"
        autoComplete="off"
        options={sensorTypes}
        value={sensorType}
        onChange={(event) => setSensorType(event.target.value)}
      />

      <TextField
        label="Display label"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder="Main drive motor…"
        hint="Optional. Shown instead of the raw glTF name."
        autoComplete="off"
        name="displayName"
      />

      {conflict ? (
        <div role="alert" className="flex gap-3 border border-warning bg-raised px-4 py-3.5">
          <Icon icon={Warning} size={20} className="mt-0.5 text-warning" />
          <div className="min-w-0 flex-1">
            <h3 className="text-[14px] font-semibold text-warning">Sensor already bound</h3>
            <p className="mt-1 text-[14px] text-ink-secondary">{conflict}</p>
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
        </div>
      ) : null}

      {otherError ? <ErrorState title="Save failed" message={otherError} /> : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button type="submit" variant="primary" loading={saveState.isLoading}>
          {activeBinding ? 'Update binding' : 'Bind sensor'}
        </Button>
        {activeBinding ? (
          <Button variant="subtle" onClick={handleUnbind} loading={deleteState.isLoading}>
            Unbind
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export default SensorMappingForm;
