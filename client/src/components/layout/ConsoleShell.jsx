/**
 * @file Application chrome: brand rail, primary navigation, content frame, footer.
 *
 * An opaque header ruled along its bottom edge. The active section is marked by
 * a 2 px brand underline rather than a filled pill, which keeps the chrome flat
 * and leaves all the colour to the content it frames.
 *
 * @module components/layout/ConsoleShell
 */

import { NavLink, useParams } from 'react-router-dom';

import { PlantAlertBanner } from '../../features/agent/components/AgentAlertBanner.jsx';
import AssistantWidget, { AssistantButton } from '../../features/agent/components/AssistantWidget.jsx';
import { useGetAssetByIdQuery } from '../../features/assets/assetsApiSlice.js';
import ConnectionChip from '../../features/telemetry/components/ConnectionChip.jsx';

/** @type {Array<{to: string, label: string, end?: boolean}>} */
const NAV_ITEMS = [
  { to: '/assets', label: 'Registry', end: true },
  { to: '/assets/new', label: 'Ingest' },
];

/**
 * The brand mark: an outlined square (the physical asset) and a solid square
 * offset from it (its digital shadow). Flat and two-tone, inline so it inherits
 * the palette and never round-trips to the network.
 *
 * @returns {import('react').JSX.Element}
 */
export function BrandMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="3" width="15" height="15" className="stroke-ink" strokeWidth="2" />
      <rect x="10" y="10" width="15" height="15" className="fill-primary" />
    </svg>
  );
}

/**
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @returns {import('react').JSX.Element}
 */
export function ConsoleShell({ children }) {
  // On an asset's own pages the assistant talks about that twin; elsewhere, the plant.
  const { assetId } = useParams();
  const { data: asset } = useGetAssetByIdQuery(assetId, { skip: !assetId });

  return (
    <div className="flex min-h-dvh flex-col">
      {/* First tabbable element on every page. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-primary focus:px-4 focus:py-2 focus:text-[13px] focus:font-medium focus:text-ink-inverse"
      >
        Skip to main content
      </a>

      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-[1600px] items-stretch justify-between gap-6 px-6">
          {/* ── Brand ──────────────────────────────────────────────────────── */}
          <NavLink to="/assets" className="flex shrink-0 items-center gap-3" translate="no">
            <BrandMark />
            <span className="hidden sm:block">
              <span className="block font-display text-[17px] font-semibold leading-5 text-ink [font-stretch:112.5%]">
                Cognitive DataOps
              </span>
              <span className="label-text block">Industrial twin console</span>
            </span>
          </NavLink>

          {/* ── Primary nav ────────────────────────────────────────────────── */}
          <nav aria-label="Primary" className="flex items-stretch">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'flex items-center border-b-2 px-4 text-[13px] font-medium',
                    isActive
                      ? 'border-primary text-ink'
                      : 'border-transparent text-ink-secondary hover:bg-sunken hover:text-ink',
                  ].join(' ')
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* ── Live connection and the assistant ──────────────────────────── */}
          <div className="flex items-center gap-5">
            <span className="hidden md:inline-flex">
              <ConnectionChip />
            </span>
            <AssistantButton label={assetId ? 'Ask about this twin' : 'Assistant'} />
          </div>
        </div>
      </header>

      <PlantAlertBanner />

      <main id="main-content" className="mx-auto w-full max-w-[1600px] flex-1 px-6 py-8">
        {children}
      </main>

      {assetId ? (
        <AssistantWidget scope="twin" assetId={assetId} assetName={asset?.name ?? null} />
      ) : (
        <AssistantWidget scope="plant" />
      )}

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-ink-muted">
            Capstone prototype. Built for research and demonstration, not for production use.
          </p>
          <nav aria-label="Legal" className="flex gap-5">
            <NavLink
              to="/terms"
              className="text-xs font-medium text-ink-secondary underline underline-offset-4 hover:text-ink"
            >
              Terms
            </NavLink>
            <NavLink
              to="/privacy"
              className="text-xs font-medium text-ink-secondary underline underline-offset-4 hover:text-ink"
            >
              Privacy
            </NavLink>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export default ConsoleShell;
