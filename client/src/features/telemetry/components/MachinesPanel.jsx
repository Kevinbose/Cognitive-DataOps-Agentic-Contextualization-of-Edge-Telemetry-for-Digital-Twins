/**
 * @file The Machines tab: connect gateways to this twin.
 *
 * A gateway (an ESP32 in the lab, a plant gateway in real life) announces itself
 * over MQTT and shows up here as AVAILABLE. Adding it to the twin is the
 * deliberate step that makes its live data appear and its channels bindable.
 * Removing it retires the bindings of its channels.
 *
 * The lists are not fetched. They are derived from the device registry the
 * socket keeps current, and the server's broadcast after an add or a remove is
 * what moves a machine between them.
 *
 * @module features/telemetry/components/MachinesPanel
 */

import { useState } from 'react';

import { useAppSelector } from '../../../app/hooks.js';
import Button from '../../../components/ui/Button.jsx';
import { EmptyState, ErrorState } from '../../../components/ui/Feedback.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useAddMachineMutation, useGetMetaQuery, useRemoveMachineMutation } from '../telemetryApiSlice.js';
import { selectLatestMap } from '../telemetrySlice.js';
import { useTwinMachines } from '../useTwinMachines.js';

/**
 * @param {object} props
 * @param {any} props.device
 * @param {import('react').ReactNode} props.action
 * @param {import('react').ReactNode} [props.detail] - Extra line under the machine.
 * @returns {import('react').JSX.Element}
 */
function MachineRow({ device, action, detail }) {
  const channels = device.channels?.length ?? 0;

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{device.label}</p>
          <p className="break-all font-mono text-xs text-ink-muted" translate="no">
            {device.machineId}
          </p>
        </div>
        <StatusMarker state={device.state} className="shrink-0 text-xs" />
      </div>

      <p className="mt-1 text-xs text-ink-muted">
        {channels} {channels === 1 ? 'channel' : 'channels'}
        {device.fw ? `, firmware ${device.fw}` : ''}
      </p>

      {detail}
      <div className="mt-2">{action}</div>
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.assetId - The twin being viewed.
 * @param {() => void} props.onShowTelemetry - Switch to the Telemetry tab.
 * @param {() => void} [props.onKeepOpen] - Called before an add, so the page pins this
 *   tab in the URL. Without it, a twin whose default tab depends on having no machines
 *   would jump to Components the moment the first machine arrived.
 * @returns {import('react').JSX.Element}
 */
export function MachinesPanel({ assetId, onShowTelemetry, onKeepOpen }) {
  const { attached, available, elsewhere } = useTwinMachines(assetId);
  const latest = useAppSelector(selectLatestMap);
  const { data: meta } = useGetMetaQuery();

  const [addMachine] = useAddMachineMutation();
  const [removeMachine] = useRemoveMachineMutation();

  /** The machine a request is in flight for. */
  const [busy, setBusy] = useState(/** @type {string|null} */ (null));
  /** The machine awaiting a "yes, remove it" answer. */
  const [confirming, setConfirming] = useState(/** @type {string|null} */ (null));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /** How many of a machine's channels are currently bound to a component. */
  const boundCount = (device) =>
    device.channels.filter((channel) => latest[channel.sensorId]?.meshName).length;

  /** @param {any} device */
  async function handleAdd(device) {
    onKeepOpen?.();
    setBusy(device.machineId);
    setError('');
    setNotice('');
    try {
      await addMachine({ assetId, machineId: device.machineId }).unwrap();
      setNotice(`${device.label} was added. Open Telemetry to bind its channels.`);
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  /** @param {any} device */
  async function handleRemove(device) {
    setBusy(device.machineId);
    setError('');
    setNotice('');
    try {
      const result = await removeMachine({ assetId, machineId: device.machineId }).unwrap();
      setConfirming(null);
      setNotice(
        `${device.label} was removed` +
          (result.bindingsRetired > 0
            ? `, and ${result.bindingsRetired} ${result.bindingsRetired === 1 ? 'binding was' : 'bindings were'} retired.`
            : '.'),
      );
    } catch (caught) {
      setError(getErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const nothingAnywhere = attached.length === 0 && available.length === 0 && elsewhere.length === 0;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <p className="border-b border-line px-4 py-3 text-xs text-ink-muted">
        A gateway announces itself and appears under Available. Add it to this twin to see its live
        data and bind its channels to components.
      </p>

      {notice ? (
        <p role="status" className="border-b border-line px-4 py-3 text-[13px] text-ink">
          {notice}{' '}
          {attached.length > 0 ? (
            <button
              type="button"
              onClick={onShowTelemetry}
              className="text-primary underline underline-offset-4 hover:text-primary-hover"
            >
              Open Telemetry
            </button>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <div className="border-b border-line p-4">
          <ErrorState title="Not done" message={error} />
        </div>
      ) : null}

      {/* ── On this twin ───────────────────────────────────────────────── */}
      <section aria-labelledby="machines-attached">
        <h3
          id="machines-attached"
          className="sticky top-0 z-10 border-b border-line bg-sunken px-4 py-2 text-[13px] font-semibold text-ink"
        >
          On this twin ({attached.length})
        </h3>

        {attached.length === 0 ? (
          <p className="border-b border-line px-4 py-3 text-xs text-ink-muted">
            No machines yet. Nothing here has live data or channels to bind.
          </p>
        ) : (
          <ul>
            {attached.map((device) => {
              const bound = boundCount(device);
              const asking = confirming === device.machineId;

              return (
                <MachineRow
                  key={device.machineId}
                  device={device}
                  detail={
                    asking ? (
                      <p role="alert" className="mt-2 text-xs text-ink">
                        {bound > 0
                          ? `Removing it retires ${bound} ${bound === 1 ? 'binding' : 'bindings'} on this twin.`
                          : 'It has no bindings on this twin.'}
                      </p>
                    ) : null
                  }
                  action={
                    asking ? (
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="danger"
                          loading={busy === device.machineId}
                          onClick={() => handleRemove(device)}
                        >
                          Remove from twin
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setNotice('');
                          setConfirming(device.machineId);
                        }}
                        aria-label={`Remove ${device.label} from this twin`}
                      >
                        Remove
                      </Button>
                    )
                  }
                />
              );
            })}
          </ul>
        )}
      </section>

      {/* ── Available ──────────────────────────────────────────────────── */}
      <section aria-labelledby="machines-available">
        <h3
          id="machines-available"
          className="sticky top-0 z-10 border-y border-line bg-sunken px-4 py-2 text-[13px] font-semibold text-ink"
        >
          Available to add ({available.length})
        </h3>

        {available.length > 0 ? (
          <ul>
            {available.map((device) => (
              <MachineRow
                key={device.machineId}
                device={device}
                action={
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy === device.machineId}
                    onClick={() => handleAdd(device)}
                    aria-label={`Add ${device.label} to this twin`}
                  >
                    Add to this twin
                  </Button>
                }
              />
            ))}
          </ul>
        ) : nothingAnywhere ? (
          <EmptyState
            title="No machines found"
            description={
              meta && !meta.features?.ingestion
                ? 'Telemetry ingestion is off. Set MQTT_URL in server/.env and restart the API.'
                : 'Power on a gateway, or start the simulator. A machine appears here as soon as it announces itself.'
            }
          />
        ) : (
          <p className="border-b border-line px-4 py-3 text-xs text-ink-muted">
            No other machines have announced themselves.
          </p>
        )}
      </section>

      {/* ── On another twin ────────────────────────────────────────────── */}
      {elsewhere.length > 0 ? (
        <section aria-labelledby="machines-elsewhere">
          <h3
            id="machines-elsewhere"
            className="sticky top-0 z-10 border-y border-line bg-sunken px-4 py-2 text-[13px] font-semibold text-ink"
          >
            On another twin ({elsewhere.length})
          </h3>
          <ul>
            {elsewhere.map((device) => (
              <MachineRow
                key={device.machineId}
                device={device}
                action={<p className="text-xs text-ink-muted">Remove it from that twin to add it here.</p>}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default MachinesPanel;
