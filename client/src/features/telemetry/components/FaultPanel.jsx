/**
 * @file Fault-injection panel for the demo.
 *
 * Switches a simulated machine into a fault scenario with no cable: the command
 * goes through the API to the broker to the device, which acknowledges and
 * starts ramping the fault. The panel shows what was commanded, whether the
 * device acknowledged, and what the device reports it is actually running.
 *
 * It exists only when the server has `ENABLE_DEVICE_COMMANDS=true`.
 *
 * The "device reports" line reads the simulator's ground truth. That is fine
 * HERE (this is the operator's demo control) and is exactly what the diagnosis
 * agent must never be able to read.
 *
 * @module features/telemetry/components/FaultPanel
 */

import { useState } from 'react';

import { useAppSelector } from '../../../app/hooks.js';
import { EmptyState, ErrorState } from '../../../components/ui/Feedback.jsx';
import { SelectField } from '../../../components/ui/Field.jsx';
import { SegmentedButton, SegmentedGroup } from '../../../components/ui/Segmented.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { humanizeScenario } from '../../../lib/format.js';
import { getErrorMessage } from '../../../services/apiSlice.js';
import { useGetSimStateQuery, useSendDeviceCommandMutation } from '../telemetryApiSlice.js';
import { selectAcks } from '../telemetrySlice.js';
import { useTwinMachines } from '../useTwinMachines.js';

/** Ramp lengths on offer, in seconds. */
const RAMP_OPTIONS = [
  { value: '30', label: '30 seconds' },
  { value: '60', label: '1 minute' },
  { value: '120', label: '2 minutes' },
  { value: '300', label: '5 minutes' },
];

/**
 * @param {object} props
 * @param {any} props.device
 * @returns {import('react').JSX.Element}
 */
function DeviceFaults({ device }) {
  const acks = useAppSelector(selectAcks);
  const [rampSec, setRampSec] = useState('120');
  const [error, setError] = useState('');
  const [send, sendState] = useSendDeviceCommandMutation();
  const { data: sim } = useGetSimStateQuery(device.machineId, {
    skip: device.state === 'offline',
    pollingInterval: 5000,
  });

  const online = device.state === 'online';
  const lastAck = acks.find((ack) => ack.machineId === device.machineId);

  async function inject(scenario) {
    setError('');
    try {
      await send({
        machineId: device.machineId,
        name: 'scenario',
        args: { scenario, rampSec: Number(rampSec) },
      }).unwrap();
    } catch (caught) {
      setError(getErrorMessage(caught));
    }
  }

  return (
    <section
      aria-labelledby={`faults-${device.machineId}`}
      className="space-y-4 border-b border-line px-4 py-4 last:border-b-0"
    >
      <header className="flex items-center justify-between gap-3">
        <h3 id={`faults-${device.machineId}`} className="text-[13px] font-semibold text-ink">
          {device.label}
        </h3>
        <StatusMarker state={device.state} className="text-xs" />
      </header>

      <div>
        <p className="label-text mb-1.5 text-ink-secondary">Scenario</p>
        <SegmentedGroup label={`Fault scenario for ${device.label}`} fill>
          {device.scenarios.map((scenario) => (
            <SegmentedButton
              key={scenario}
              pressed={sim?.scenario === scenario}
              onClick={() => inject(scenario)}
            >
              {humanizeScenario(scenario)}
            </SegmentedButton>
          ))}
        </SegmentedGroup>
        {!online ? (
          <p className="mt-1.5 text-xs text-ink-muted">
            The device is {device.state}. Commands are only sent to online devices.
          </p>
        ) : null}
      </div>

      <SelectField
        label="Ramp length"
        name="rampSec"
        autoComplete="off"
        options={RAMP_OPTIONS}
        value={rampSec}
        onChange={(event) => setRampSec(event.target.value)}
        hint="How long the fault takes to build from 0 to full strength."
      />

      {sendState.isLoading ? <p className="text-xs text-ink-muted">Sending command…</p> : null}
      {error ? <ErrorState title="Command not sent" message={error} /> : null}

      <dl className="space-y-1.5 border border-line bg-raised p-3 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Device reports</dt>
          <dd className="text-right text-ink">
            {sim?.scenario ? (
              <>
                {humanizeScenario(sim.scenario)}
                {sim.scenario !== 'NORMAL' && typeof sim.ramp === 'number' ? (
                  <span className="data-readout text-ink-muted">
                    {' '}
                    {Math.round(sim.ramp * 100)}&nbsp;%
                  </span>
                ) : null}
              </>
            ) : (
              'Not yet reported'
            )}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-ink-muted">Last command</dt>
          <dd className="text-right text-ink">
            {lastAck
              ? lastAck.ok
                ? `Acknowledged${typeof lastAck.rttMs === 'number' ? ` in ${lastAck.rttMs} ms` : ''}`
                : lastAck.timedOut
                  ? 'No acknowledgement within 5 s'
                  : `Rejected: ${lastAck.detail}`
              : 'None sent'}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * @param {object} props
 * @param {string} props.assetId - The twin being viewed; only its machines are controlled.
 * @returns {import('react').JSX.Element}
 */
export function FaultPanel({ assetId }) {
  const { attached } = useTwinMachines(assetId);
  const devices = attached.filter((device) => device.scenarios?.length > 1);

  if (devices.length === 0) {
    return (
      <EmptyState
        title="No machine to control"
        description="Fault scenarios appear here once a simulated machine has been added to this twin."
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {devices.map((device) => (
        <DeviceFaults key={device.machineId} device={device} />
      ))}
    </div>
  );
}

export default FaultPanel;
