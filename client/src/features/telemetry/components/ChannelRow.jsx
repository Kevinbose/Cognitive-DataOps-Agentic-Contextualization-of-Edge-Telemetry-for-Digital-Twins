/**
 * @file One telemetry channel: name, live value, state and binding.
 *
 * The value is Plex Mono with the channel's own decimals, and is NOT an
 * `aria-live` region: it changes twice a second. A change of CONDITION is
 * announced separately by `LiveAnnouncer`.
 *
 * State is a shape plus a word, never colour alone. A bound channel offers
 * "select in viewport"; an unbound one offers "Bind".
 *
 * @module features/telemetry/components/ChannelRow
 */

import Button from '../../../components/ui/Button.jsx';
import StatusMarker from '../../../components/ui/StatusMarker.jsx';
import { formatValue, STATUS_LABEL } from '../../../lib/format.js';
import Sparkline from './Sparkline.jsx';

/**
 * The marker state and word for a channel, given what is known about its device.
 *
 * A reading from a device that has gone quiet is not "normal" any more, however
 * normal its last value was, so the device state takes precedence.
 *
 * @param {string} deviceState - `online`, `stale`, `offline` or `unknown`.
 * @param {{status: string}|undefined} sample
 * @returns {{state: string, label: string}}
 */
function presentState(deviceState, sample) {
  if (deviceState === 'offline') return { state: 'offline', label: 'Offline' };
  if (deviceState === 'stale') return { state: 'stale', label: 'Stale' };
  if (!sample) return { state: 'unknown', label: 'No data' };
  return { state: sample.status, label: STATUS_LABEL[sample.status] ?? sample.status };
}

/**
 * @param {object} props
 * @param {any} props.channel - Channel declaration from the device's birth.
 * @param {string} props.deviceState
 * @param {import('../telemetrySlice.js').Sample|undefined} props.sample
 * @param {number[]} props.series
 * @param {string|null} props.meshLabel - Label of the bound mesh, or `null` if unbound.
 * @param {() => void} props.onSelectMesh
 * @param {() => void} props.onBind
 * @param {boolean} [props.drafted] - This channel is the one picked for the next bind.
 * @returns {import('react').JSX.Element}
 */
export function ChannelRow({
  channel,
  deviceState,
  sample,
  series,
  meshLabel,
  onSelectMesh,
  onBind,
  drafted = false,
}) {
  const { state, label } = presentState(deviceState, sample);
  const dimmed = deviceState === 'offline' || deviceState === 'stale';

  return (
    <li className="border-b border-line px-4 py-3 last:border-b-0">
      {/* What it is and what it reads. */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-[13px] font-medium text-ink">{channel.label}</span>
        <span className={`shrink-0 font-mono ${dimmed ? 'text-ink-muted' : 'text-ink'}`}>
          <span className="text-[15px] font-medium tabular-nums">
            {formatValue(sample?.value, channel.decimals)}
          </span>
          {sample ? (
            // A non-breaking space keeps the figure and its unit together, and
            // reads and copies as "4.50 bar", not "4.50bar".
            <span className="text-xs text-ink-muted">{` ${channel.unit}`}</span>
          ) : null}
        </span>
      </div>

      {/* Its condition, and the recent trend. */}
      <div className="mt-1 flex items-center justify-between gap-3">
        <StatusMarker state={state} label={label} className="text-xs" />
        <Sparkline values={series} min={channel.min} max={channel.max} />
      </div>

      {/* The identifier, in full: it is what a binding refers to, so it is never truncated. */}
      <p className="mt-1.5 break-all font-mono text-xs text-ink-muted" translate="no">
        {channel.sensorId}
      </p>

      {/* What it drives. */}
      <div className="mt-2">
        {meshLabel ? (
          <button
            type="button"
            onClick={onSelectMesh}
            aria-label={`Select ${meshLabel} in the viewport`}
            className="max-w-full truncate text-left font-mono text-xs text-primary underline underline-offset-4 hover:text-primary-hover"
          >
            Bound to {meshLabel}
          </button>
        ) : (
          <Button
            size="sm"
            variant={drafted ? 'primary' : 'secondary'}
            onClick={onBind}
            aria-label={`Bind ${channel.label} to a component`}
            aria-pressed={drafted}
          >
            {drafted ? 'Picked to bind' : 'Bind'}
          </Button>
        )}
      </div>
    </li>
  );
}

export default ChannelRow;
