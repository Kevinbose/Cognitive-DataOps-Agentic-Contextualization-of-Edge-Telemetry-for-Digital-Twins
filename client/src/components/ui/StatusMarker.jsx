/**
 * @file State markers: shape plus text, never colour alone.
 *
 * Alarm and warn differ only in hue for someone with deuteranopia, so each state
 * has its own SHAPE and its own WORD:
 *
 * | state            | shape    | colour        |
 * |------------------|----------|---------------|
 * | normal, online   | dot      | green         |
 * | warn             | triangle | amber         |
 * | alarm            | square   | red           |
 * | offline, unknown | ring     | muted grey    |
 * | stale            | ring     | amber         |
 *
 * The marker is decorative (`aria-hidden`); the adjacent label is what assistive
 * technology reads. This is the only place in the interface that uses colour to
 * mean state, and it is the only use of colour besides the brand hue.
 *
 * @module components/ui/StatusMarker
 */

/** @type {Record<string, {shape: 'dot'|'triangle'|'square'|'ring', tone: string, label: string}>} */
const STATES = {
  normal: { shape: 'dot', tone: 'text-success-shape', label: 'Normal' },
  online: { shape: 'dot', tone: 'text-success-shape', label: 'Online' },
  warn: { shape: 'triangle', tone: 'text-warning', label: 'Warning' },
  alarm: { shape: 'square', tone: 'text-danger', label: 'Alarm' },
  stale: { shape: 'ring', tone: 'text-warning', label: 'Stale' },
  offline: { shape: 'ring', tone: 'text-ink-muted', label: 'Offline' },
  unknown: { shape: 'ring', tone: 'text-ink-muted', label: 'Unknown' },
};

/**
 * The bare shape, 12 px.
 *
 * @param {object} props
 * @param {string} props.state - A key of the state table.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function MarkerShape({ state, className = '' }) {
  const { shape, tone } = STATES[state] ?? STATES.unknown;

  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${tone} ${className}`}
    >
      {shape === 'dot' ? <circle cx="6" cy="6" r="4.5" fill="currentColor" /> : null}
      {shape === 'ring' ? (
        <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.75" />
      ) : null}
      {shape === 'square' ? <rect x="1.5" y="1.5" width="9" height="9" fill="currentColor" /> : null}
      {shape === 'triangle' ? <path d="M6 1 L11.25 10.5 H0.75 Z" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * Marker and word together.
 *
 * @param {object} props
 * @param {string} props.state - `normal`, `online`, `warn`, `alarm`, `stale`, `offline` or `unknown`.
 * @param {string} [props.label] - Override the default word.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function StatusMarker({ state, label, className = '' }) {
  const presentation = STATES[state] ?? STATES.unknown;

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <MarkerShape state={state} />
      <span className="text-[13px] text-ink">{label ?? presentation.label}</span>
    </span>
  );
}

export default StatusMarker;
