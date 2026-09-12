/**
 * @file Status and label chips.
 *
 * Each status carries a tinted background, a matching border, a saturated dot,
 * AND a text label. Four redundant channels, so the state is legible to someone
 * who cannot distinguish the hues — colour is never the sole carrier of meaning.
 *
 * @module components/ui/StatusPill
 */

/**
 * @typedef {object} Presentation
 * @property {string} label
 * @property {string} classes - Background, border, and text colour.
 * @property {string} dot - Indicator colour.
 */

/** @type {Record<string, Presentation>} */
const STATUS = {
  pending_conversion: {
    label: 'Pending Conversion',
    classes: 'bg-sunken border-line text-ink-secondary',
    dot: 'bg-ink-subtle',
  },
  converted: {
    label: 'Converted',
    classes: 'bg-signal-soft border-signal-border text-signal',
    dot: 'bg-signal',
  },
  mapped: {
    label: 'Instrumented',
    classes: 'bg-success-soft border-success-border text-success',
    dot: 'bg-success',
  },
  failed: {
    label: 'Failed',
    classes: 'bg-danger-soft border-danger-border text-danger',
    dot: 'bg-danger',
  },
};

/**
 * @param {object} props
 * @param {'pending_conversion'|'converted'|'mapped'|'failed'} props.status
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function StatusPill({ status, className = '' }) {
  const presentation = STATUS[status] ?? {
    label: String(status).replace(/_/g, ' '),
    classes: 'bg-sunken border-line text-ink-secondary',
    dot: 'bg-ink-subtle',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${presentation.classes} ${className}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${presentation.dot}`} aria-hidden="true" />
      <span className="font-sans text-[11px] font-medium tracking-[-0.005em]">
        {presentation.label}
      </span>
    </span>
  );
}

/**
 * Neutral chip for non-status metadata (sensor type, source format, counts).
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @param {'neutral'|'primary'|'signal'} [props.tone]
 * @param {boolean} [props.mono]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Tag({ children, tone = 'neutral', mono = false, className = '' }) {
  /** @type {Record<string, string>} */
  const tones = {
    neutral: 'bg-sunken border-line text-ink-secondary',
    primary: 'bg-primary-soft border-primary-border text-primary',
    signal: 'bg-signal-soft border-signal-border text-signal',
  };

  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${
        mono ? 'font-mono tracking-[-0.01em]' : 'font-sans'
      } ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export default StatusPill;
