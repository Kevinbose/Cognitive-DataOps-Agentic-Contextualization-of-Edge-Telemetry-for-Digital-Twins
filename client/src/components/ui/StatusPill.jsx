/**
 * @file Asset status and label chips.
 *
 * An asset moves along a one-way ratchet: `pending_conversion`, `converted`,
 * `mapped`. The status is drawn as exactly that: three segments, filled from
 * the left as far as the asset has got, followed by the plain-text name. Shape
 * and text carry the meaning; hue carries none of it, so it reads the same to
 * someone who cannot tell colours apart.
 *
 * (The filename is historical; the component is no longer a pill.)
 *
 * @module components/ui/StatusPill
 */

/**
 * @typedef {object} Presentation
 * @property {string} label
 * @property {number} filled - Segments filled, 0 to 3.
 * @property {boolean} [failed]
 */

/** @type {Record<string, Presentation>} */
const STATUS = {
  pending_conversion: { label: 'Pending conversion', filled: 1 },
  converted: { label: 'Converted', filled: 2 },
  mapped: { label: 'Instrumented', filled: 3 },
  failed: { label: 'Failed', filled: 0, failed: true },
};

/**
 * The three-segment ratchet glyph.
 *
 * @param {object} props
 * @param {number} props.filled - Segments filled, 0 to 3.
 * @param {boolean} [props.failed] - Draw the segments as a failure.
 * @returns {import('react').JSX.Element}
 */
export function RatchetGlyph({ filled, failed = false }) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
      {[0, 1, 2].map((index) => {
        const on = index < filled;
        return (
          <span
            key={index}
            className={`block h-2.5 w-3.5 border ${
              failed
                ? 'border-danger'
                : on
                  ? 'border-ink bg-ink'
                  : 'border-control bg-transparent'
            }`}
          />
        );
      })}
    </span>
  );
}

/**
 * @param {object} props
 * @param {'pending_conversion'|'converted'|'mapped'|'failed'} props.status
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function StatusPill({ status, className = '' }) {
  const presentation = STATUS[status] ?? {
    label: String(status).replace(/_/g, ' '),
    filled: 0,
  };

  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <RatchetGlyph filled={presentation.filled} failed={presentation.failed} />
      <span
        className={`text-[13px] font-medium ${presentation.failed ? 'text-danger' : 'text-ink'}`}
      >
        {presentation.label}
      </span>
    </span>
  );
}

/**
 * Neutral boxed label for non-status metadata (sensor type, source format).
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @param {boolean} [props.mono]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Tag({ children, mono = false, className = '' }) {
  return (
    <span
      className={`inline-flex items-center border border-line bg-raised px-2 py-0.5 text-xs text-ink-secondary ${
        mono ? 'font-mono' : 'font-sans font-medium'
      } ${className}`}
    >
      {children}
    </span>
  );
}

export default StatusPill;
