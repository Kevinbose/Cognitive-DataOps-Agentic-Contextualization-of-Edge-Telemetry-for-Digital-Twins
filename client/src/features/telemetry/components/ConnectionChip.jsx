/**
 * @file Connection chip for the page header: is live data flowing?
 *
 * Shape and word for the socket state, plus how many devices are online. It
 * replaces the static "Local" badge the header used to carry, which reported
 * nothing.
 *
 * @module features/telemetry/components/ConnectionChip
 */

import { useAppSelector } from '../../../app/hooks.js';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { selectConnection, selectDeviceSummary } from '../telemetrySlice.js';

/** Socket state to marker state and word. */
const PRESENTATION = {
  live: { state: 'online', label: 'Live data' },
  connecting: { state: 'unknown', label: 'Connecting' },
  reconnecting: { state: 'stale', label: 'Reconnecting' },
  offline: { state: 'offline', label: 'Offline' },
};

/**
 * @param {object} props
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function ConnectionChip({ className = '' }) {
  const connection = useAppSelector(selectConnection);
  const { online, total } = useAppSelector(selectDeviceSummary);
  const { state, label } = PRESENTATION[connection] ?? PRESENTATION.offline;

  return (
    <span className={`inline-flex items-center gap-3 ${className}`}>
      <StatusMarker state={state} label={label} className="text-xs" />
      {connection === 'live' && total > 0 ? (
        <span className="data-readout text-xs text-ink-muted">
          {online}/{total}&nbsp;devices
        </span>
      ) : null}
    </span>
  );
}

export default ConnectionChip;
