/**
 * @file Empty, loading, and error states.
 *
 * Called out explicitly by the web interface guidelines: never render broken UI
 * for an empty array, and an error message must carry a next step rather than
 * only naming the problem.
 *
 * @module components/ui/Feedback
 */

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.description - Should say how to populate this view.
 * @param {import('react').ReactNode} [props.icon]
 * @param {import('react').ReactNode} [props.action]
 * @returns {import('react').JSX.Element}
 */
export function EmptyState({ title, description, icon = '◇', action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div
        aria-hidden="true"
        className="mb-5 flex h-14 w-14 items-center justify-center rounded-xl border border-line bg-gradient-to-b from-surface to-sunken text-xl text-ink-subtle shadow-xs"
      >
        {icon}
      </div>

      <h3 className="mb-1.5 font-sans text-[15px] font-semibold tracking-[-0.015em] text-ink">
        {title}
      </h3>
      <p className="mb-6 max-w-sm font-sans text-[13px] leading-relaxed text-ink-muted">
        {description}
      </p>
      {action}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} [props.label]
 * @param {boolean} [props.compact]
 * @returns {import('react').JSX.Element}
 */
export function LoadingState({ label = 'Loading…', compact = false }) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 ${compact ? 'py-8' : 'py-16'}`}
      role="status"
      aria-live="polite"
    >
      {/* Indeterminate track. Suppressed under `prefers-reduced-motion` by the
          global rule in index.css. */}
      <span
        aria-hidden="true"
        className="relative block h-1 w-28 overflow-hidden rounded-full bg-sunken"
      >
        <span className="absolute inset-y-0 left-0 w-1/3 animate-[track_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
      </span>
      <span className="font-sans text-[12.5px] text-ink-muted">{label}</span>

      <style>{`
        @keyframes track {
          0%   { transform: translateX(-110%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.message
 * @param {import('react').ReactNode} [props.action]
 * @returns {import('react').JSX.Element}
 */
export function ErrorState({ title, message, action }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-lg border border-danger-border bg-danger-soft px-4 py-3.5"
    >
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-danger text-[12px] font-bold text-ink-inverse"
      >
        !
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-sans text-[13px] font-semibold text-danger">{title}</h3>
        <p className="mt-1 font-sans text-[12.5px] leading-relaxed break-words text-ink-secondary">
          {message}
        </p>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Informational callout, for guidance rather than failure.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {import('react').ReactNode} props.children
 * @returns {import('react').JSX.Element}
 */
export function InfoNote({ title, children }) {
  return (
    <div className="flex gap-3 rounded-lg border border-signal-border bg-signal-soft px-4 py-3.5">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-signal text-[12px] font-bold text-ink-inverse"
      >
        i
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="font-sans text-[13px] font-semibold text-signal">{title}</h3>
        <div className="mt-1 font-sans text-[12.5px] leading-relaxed text-ink-secondary">
          {children}
        </div>
      </div>
    </div>
  );
}
