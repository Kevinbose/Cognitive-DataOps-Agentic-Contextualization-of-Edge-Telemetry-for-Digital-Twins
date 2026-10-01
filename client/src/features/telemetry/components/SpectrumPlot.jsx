/**
 * @file Vibration spectrum as inline SVG bars, no chart library.
 *
 * This is where the operator sees the evidence the diagnosis rests on: a
 * CLOGGED filter raises a flat broadband floor above 300 Hz, while a worn
 * BEARING shows discrete peaks at multiples of the shaft frequency. Both raise
 * the single RMS number; only the spectrum shape tells them apart.
 *
 * Bars are neutral; the dominant peak and the shaft-harmonic ticks use the brand
 * colour. Colour here means "look at this", not state, which the markers carry.
 *
 * The drawing is laid out in a 256 unit wide viewBox so its 12 unit labels are
 * 12 px at the inspector column's width (the minimum text size in this system).
 *
 * @module features/telemetry/components/SpectrumPlot
 */

import { useId } from 'react';

const WIDTH = 256;
const HEIGHT = 136;
const PAD = { left: 34, right: 6, top: 18, bottom: 22 };

/** Vertical scale steps. Stepped, not continuous, so the bars do not breathe. */
const SCALE_STEPS = [1.5, 3, 6, 12];

/** Harmonics of the fundamental to mark. */
const HARMONICS = [1, 2, 3, 4, 5];

/**
 * @param {number} peak - Largest amplitude in the frame.
 * @returns {number} Smallest step that holds the peak with a little headroom.
 */
function pickScale(peak) {
  return SCALE_STEPS.find((step) => peak <= step * 0.92) ?? SCALE_STEPS[SCALE_STEPS.length - 1];
}

/**
 * @param {object} props
 * @param {{key: string, label: string, unit: string, startHz: number, stepHz: number, count: number, fundamentalHz?: number}} props.layout
 *   Bin layout from the device's birth message.
 * @param {{ts: number, amp: number[]}|undefined} props.frame - Newest frame, if any.
 * @returns {import('react').JSX.Element}
 */
export function SpectrumPlot({ layout, frame }) {
  const titleId = useId();
  const innerWidth = WIDTH - PAD.left - PAD.right;
  const innerHeight = HEIGHT - PAD.top - PAD.bottom;
  const endHz = layout.startHz + layout.stepHz * layout.count;

  if (!frame || frame.amp.length !== layout.count) {
    return (
      <p className="px-4 py-3 text-xs text-ink-muted">
        Waiting for the first {layout.label.toLowerCase()} frame…
      </p>
    );
  }

  const peak = Math.max(...frame.amp);
  const peakIndex = frame.amp.indexOf(peak);
  const peakHz = layout.startHz + peakIndex * layout.stepHz;
  const yMax = pickScale(peak);
  const barWidth = innerWidth / layout.count;
  const xOfHz = (hz) => PAD.left + ((hz - layout.startHz) / (endHz - layout.startHz)) * innerWidth;

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    Math.round(layout.startHz + fraction * (endHz - layout.startHz)),
  );

  return (
    <figure className="px-4 py-3">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={titleId}
        className="block w-full"
      >
        <title id={titleId}>
          {`${layout.label}: dominant peak ${peakHz.toFixed(0)} Hz at ${peak.toFixed(2)} ${layout.unit}`}
        </title>

        {/* Axes */}
        <line
          x1={PAD.left}
          y1={PAD.top + innerHeight}
          x2={PAD.left + innerWidth}
          y2={PAD.top + innerHeight}
          className="stroke-control"
        />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + innerHeight} className="stroke-control" />

        {/* Y labels: zero and the current scale maximum. */}
        <text x={PAD.left - 5} y={PAD.top + innerHeight} textAnchor="end" dominantBaseline="middle" className="fill-ink-muted font-mono text-[12px]">
          0
        </text>
        <text x={PAD.left - 5} y={PAD.top + 4} textAnchor="end" dominantBaseline="middle" className="fill-ink-muted font-mono text-[12px]">
          {yMax}
        </text>

        {/* Bars */}
        {frame.amp.map((amplitude, index) => {
          const height = Math.min(1, amplitude / yMax) * innerHeight;
          return (
            <rect
              key={index}
              x={PAD.left + index * barWidth + 0.4}
              y={PAD.top + innerHeight - height}
              width={Math.max(barWidth - 0.8, 0.5)}
              height={height}
              className={index === peakIndex ? 'fill-primary' : 'fill-ink-secondary'}
            />
          );
        })}

        {/* Shaft-frequency harmonics, when the device declares its fundamental. */}
        {layout.fundamentalHz
          ? HARMONICS.filter((order) => order * layout.fundamentalHz < endHz).map((order) => {
              const x = xOfHz(order * layout.fundamentalHz);
              return (
                <g key={order}>
                  <path d={`M${x - 3} ${PAD.top - 11} L${x + 3} ${PAD.top - 11} L${x} ${PAD.top - 5} Z`} className="fill-primary" />
                  {order <= 2 ? (
                    <text x={x} y={PAD.top - 13} textAnchor="middle" className="fill-primary font-mono text-[12px]">
                      {order}X
                    </text>
                  ) : null}
                </g>
              );
            })
          : null}

        {/* X ticks and labels (Hz) */}
        {xTicks.map((hz) => (
          <g key={hz}>
            <line x1={xOfHz(hz)} y1={PAD.top + innerHeight} x2={xOfHz(hz)} y2={PAD.top + innerHeight + 3} className="stroke-control" />
            <text
              x={xOfHz(hz)}
              y={HEIGHT - 5}
              textAnchor={hz === xTicks[0] ? 'start' : hz === xTicks[xTicks.length - 1] ? 'end' : 'middle'}
              className="fill-ink-muted font-mono text-[12px]"
            >
              {hz}
            </text>
          </g>
        ))}
      </svg>

      <figcaption className="mt-1 flex items-baseline justify-between gap-3 text-xs text-ink-muted">
        <span>
          Peak <span className="data-readout text-ink">{peakHz.toFixed(0)}&nbsp;Hz</span> at{' '}
          <span className="data-readout text-ink">
            {peak.toFixed(2)}&nbsp;{layout.unit}
          </span>
        </span>
        <span>Hz</span>
      </figcaption>
    </figure>
  );
}

export default SpectrumPlot;
