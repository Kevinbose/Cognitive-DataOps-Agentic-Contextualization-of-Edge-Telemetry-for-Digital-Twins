/**
 * @file A tiny trend line, inline SVG, no chart library.
 *
 * Scaled to the channel's own declared range rather than to the visible
 * window. Auto-scaling would stretch a steady 4.50 bar reading's noise into a
 * dramatic zig-zag; the honest scale shows noise as the small thing it is and a
 * real fault, such as pressure falling to 2.4 bar, as the large move it is.
 *
 * Decorative: the current value and state are in the text beside it.
 *
 * @module features/telemetry/components/Sparkline
 */

/** Most points drawn, the newest ones (1 minute at 2 Hz). */
const MAX_POINTS = 120;

/**
 * @param {object} props
 * @param {number[]} props.values - Newest last.
 * @param {number} props.min - Channel range minimum.
 * @param {number} props.max - Channel range maximum.
 * @param {number} [props.width]
 * @param {number} [props.height]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Sparkline({ values, min, max, width = 96, height = 24, className = '' }) {
  const shown = values.slice(-MAX_POINTS);
  const span = max - min || 1;

  let points = '';
  if (shown.length >= 2) {
    points = shown
      .map((value, index) => {
        const x = (index / (MAX_POINTS - 1)) * width + (MAX_POINTS - shown.length) * (width / (MAX_POINTS - 1));
        const clamped = Math.min(max, Math.max(min, value));
        const y = height - 1 - ((clamped - min) / span) * (height - 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 overflow-visible text-ink-secondary ${className}`}
    >
      {/* Baseline, so an empty sparkline still occupies its slot. */}
      <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} className="stroke-line" />
      {points ? (
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

export default Sparkline;
