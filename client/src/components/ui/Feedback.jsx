/**
 * @file Empty, loading and error states.
 *
 * Called out explicitly by the web interface guidelines: never render broken UI
 * for an empty array, and an error message must carry a next step rather than
 * only naming the problem.
 *
 * None of these use a filled or tinted box, an icon tile or a coloured stripe.
 * An empty state is a ruled row, an error is a fully bordered notice with an
 * icon and text, and loading is a skeleton of the real layout.
 *
 * @module components/ui/Feedback
 */

import Icon from './Icon.jsx';
import { Info, WarningOctagon } from './icons.js';
import { Skeleton, SkeletonRows, SkeletonText } from './Skeleton.jsx';

/**
 * An empty view: a ruled row that says what is missing and how to fix it.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.description - Should say how to populate this view.
 * @param {import('react').ReactNode} [props.action]
 * @param {import('react').ReactNode} [props.children] - Extra content under the text.
 * @returns {import('react').JSX.Element}
 */
export function EmptyState({ title, description, action, children }) {
  return (
    <div className="border-t border-line px-5 py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-prose">
          <h3 className="display-section">{title}</h3>
          <p className="mt-1 text-[14px] text-ink-muted">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * Loading placeholder shaped like the view that is loading.
 *
 * @param {object} props
 * @param {string} [props.label] - Announced to screen readers; not shown.
 * @param {'panel'|'rows'|'page'|'inspector'|'list'} [props.variant]
 * @param {boolean} [props.compact]
 * @returns {import('react').JSX.Element}
 */
export function LoadingState({ label = 'Loading…', variant = 'panel', compact = false }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className={variant === 'rows' || variant === 'list' ? '' : compact ? 'p-5' : 'p-5 sm:p-8'}
    >
      <span className="sr-only">{label}</span>

      {variant === 'rows' ? <SkeletonRows rows={compact ? 3 : 5} columns={5} /> : null}

      {variant === 'list' ? (
        <div aria-hidden="true" className="space-y-1 p-3">
          {Array.from({ length: 10 }, (_, row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </div>
      ) : null}

      {variant === 'inspector' ? (
        <div aria-hidden="true" className="space-y-5">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-6 w-4/5" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-36" />
        </div>
      ) : null}

      {variant === 'page' ? (
        <div aria-hidden="true" className="space-y-8">
          <div className="space-y-3">
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <div className="grid gap-px border-t-2 border-ink bg-line sm:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="space-y-3 bg-surface p-5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-10 w-16" />
              </div>
            ))}
          </div>
          <SkeletonRows rows={3} columns={5} />
        </div>
      ) : null}

      {variant === 'panel' ? (
        <div aria-hidden="true" className="space-y-5">
          <Skeleton className="h-5 w-40" />
          <SkeletonText lines={3} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A failure with its reason and, ideally, a next step.
 *
 * Fully bordered in the alarm colour with a leading icon and text. No tinted
 * fill and no coloured side stripe.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {string} props.message
 * @param {import('react').ReactNode} [props.action]
 * @returns {import('react').JSX.Element}
 */
export function ErrorState({ title, message, action }) {
  return (
    <div role="alert" className="flex gap-3 border border-danger bg-raised px-4 py-3.5">
      <Icon icon={WarningOctagon} size={20} className="mt-0.5 text-danger" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold text-danger">{title}</h3>
        <p className="mt-1 break-words text-[14px] text-ink-secondary">{message}</p>
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

/**
 * Guidance rather than failure.
 *
 * @param {object} props
 * @param {string} props.title
 * @param {import('react').ReactNode} props.children
 * @returns {import('react').JSX.Element}
 */
export function InfoNote({ title, children }) {
  return (
    <div className="flex gap-3 border border-control bg-raised px-4 py-3.5">
      <Icon icon={Info} size={20} className="mt-0.5 text-ink-secondary" />
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
        <div className="mt-1 text-[14px] text-ink-secondary">{children}</div>
      </div>
    </div>
  );
}
