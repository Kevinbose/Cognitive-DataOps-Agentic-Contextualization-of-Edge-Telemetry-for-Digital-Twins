/**
 * @file Device strip: one line per edge gateway under the viewer's command bar.
 *
 * Connection state, signal strength and "last seen" for each machine, in the
 * manner of an instrument rail. "Last seen" ticks once a second, which is why
 * it uses `useNow` (only this strip re-renders each second).
 *
 * @module features/telemetry/components/DeviceStrip
 */

import { useAppSelector } from '../../../app/hooks.js';
import StatusMarker, { MarkerShape } from '../../../components/ui/StatusMarker.jsx';
import { formatAge } from '../../../lib/format.js';
import { useNow } from '../../../lib/useNow.js';
import { selectLatestMap } from '../telemetrySlice.js';
import { useTwinMachines } from '../useTwinMachines.js';

/**
 * @param {object} props
 * @param {string} props.assetId - The twin being viewed; only its machines are shown.
 * @returns {import('react').JSX.Element}
 */
export function DeviceStrip({ assetId }) {
  const { attached: devices } = useTwinMachines(assetId);
  const latest = useAppSelector(selectLatestMap);
  const now = useNow();

  /**
   * The server broadcasts a device only when its state or diagnostics change,
   * so `lastSeenAt` on the device is up to fifteen seconds old by design. The
   * freshest evidence of life is the newest sample of any of its channels.
   */
  const lastHeardFrom = (device) =>
    device.channels.reduce(
      (newest, channel) => Math.max(newest, latest[channel.sensorId]?.rx ?? 0),
      device.lastSeenAt ?? 0,
    );

  return (
    <div className="border-b border-line bg-surface px-5 py-2">
      {devices.length === 0 ? (
        <p className="text-xs text-ink-muted">
          No machines have been added to this twin yet. Open the Machines tab to add one.
        </p>
      ) : (
        <ul aria-label="Machines on this twin" className="flex flex-wrap gap-x-8 gap-y-1">
          {devices.map((device) => (
            <li key={device.machineId} className="flex flex-wrap items-center gap-x-3 text-xs">
              <StatusMarker state={device.state} className="text-xs" />
              <span className="font-medium text-ink">{device.label}</span>
              <span className="data-readout text-xs text-ink-muted" translate="no">
                {device.machineId}
              </span>
              {typeof device.diag?.rssi === 'number' ? (
                <span className="text-ink-muted">Signal {device.diag.rssi}&nbsp;dBm</span>
              ) : null}
              <span className="text-ink-muted">Seen {formatAge(lastHeardFrom(device), now)}</span>
              {device.identityConflict ? (
                <span className="inline-flex items-center gap-1.5 text-warning">
                  <MarkerShape state="warn" />
                  Two boards share this machine ID
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DeviceStrip;
