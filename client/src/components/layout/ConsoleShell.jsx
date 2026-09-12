/**
 * @file Application chrome — brand rail, primary navigation, content frame.
 *
 * A sticky translucent header over the tinted canvas. The nav is a segmented
 * control rather than plain links, so the current section is unambiguous at a
 * glance in a tool people keep open all day.
 *
 * @module components/layout/ConsoleShell
 */

import { NavLink } from 'react-router-dom';

/** @type {Array<{to: string, label: string, end?: boolean}>} */
const NAV_ITEMS = [
  { to: '/assets', label: 'Registry', end: true },
  { to: '/assets/new', label: 'Ingest' },
];

/**
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @returns {import('react').JSX.Element}
 */
export function ConsoleShell({ children }) {
  return (
    <div className="min-h-screen">
      {/* First tabbable element on every page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink-inverse"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between gap-6 px-6">
          {/* ── Brand ──────────────────────────────────────────────────────── */}
          <NavLink to="/assets" className="flex shrink-0 items-center gap-3">
            {/* Mark: concentric squares — a physical asset and its digital
                shadow. Inline SVG so it inherits the palette and never
                round-trips to the network. */}
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-signal shadow-sm"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <rect x="2" y="2" width="9" height="9" rx="1.5" stroke="white" strokeWidth="1.6" />
                <rect
                  x="7"
                  y="7"
                  width="9"
                  height="9"
                  rx="1.5"
                  stroke="white"
                  strokeWidth="1.6"
                  opacity="0.65"
                />
              </svg>
            </span>

            <span className="hidden sm:block">
              <span className="block font-sans text-[15px] font-semibold leading-tight tracking-[-0.02em] text-ink">
                Cognitive DataOps
              </span>
              <span className="block font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">
                Industrial Twin Console
              </span>
            </span>
          </NavLink>

          {/* ── Primary nav ────────────────────────────────────────────────── */}
          <nav aria-label="Primary" className="flex items-center gap-1 rounded-lg bg-sunken p-1">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'rounded-md px-3.5 py-1.5 font-sans text-[13px] font-medium',
                    'transition-[background-color,color,box-shadow] duration-150',
                    isActive
                      ? 'bg-surface text-ink shadow-xs'
                      : 'text-ink-muted hover:text-ink',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* ── Environment badge ──────────────────────────────────────────── */}
          <div className="hidden items-center gap-2 md:flex">
            <span className="flex items-center gap-1.5 rounded-full border border-success-border bg-success-soft px-2.5 py-1">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-success"
              />
              <span className="font-mono text-[10.5px] font-medium uppercase tracking-[0.06em] text-success">
                Local
              </span>
            </span>
            <span
              className="font-mono text-[10.5px] tracking-[0.04em] text-ink-subtle"
              translate="no"
            >
              v0.1
            </span>
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-[1600px] px-6 py-8">
        {children}
      </main>
    </div>
  );
}

export default ConsoleShell;
