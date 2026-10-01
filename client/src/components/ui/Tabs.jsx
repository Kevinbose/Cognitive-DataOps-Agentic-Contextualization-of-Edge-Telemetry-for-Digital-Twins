/**
 * @file Tabs, following the WAI-ARIA authoring pattern.
 *
 * `role="tablist"` with `role="tab"` children, `aria-selected`, and roving
 * `tabindex` so the whole strip is ONE tab stop. Left and Right move between
 * tabs (and activate them), Home and End jump to the ends. The active tab is
 * marked by a 2 px brand underline and heavier text, not by a filled shape.
 *
 * The caller renders the panel and must give it `role="tabpanel"`,
 * `id={tabPanelId(id)}` and `aria-labelledby={tabId(id)}`.
 *
 * @module components/ui/Tabs
 */

import { useRef } from 'react';

/** @param {string} id @returns {string} DOM id of the tab button. */
export const tabId = (id) => `tab-${id}`;
/** @param {string} id @returns {string} DOM id of the tab's panel. */
export const tabPanelId = (id) => `tabpanel-${id}`;

/**
 * @param {object} props
 * @param {string} props.label - Accessible name of the tab list.
 * @param {Array<{id: string, label: string, count?: number|string}>} props.tabs
 * @param {string} props.value - The active tab id.
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Tabs({ label, tabs, value, onChange, className = '' }) {
  const refs = useRef(/** @type {Record<string, HTMLButtonElement|null>} */ ({}));

  /** @param {import('react').KeyboardEvent} event */
  function onKeyDown(event) {
    const index = tabs.findIndex((tab) => tab.id === value);
    let next = index;

    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;

    event.preventDefault();
    onChange(tabs[next].id);
    refs.current[tabs[next].id]?.focus();
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className={`flex ${className}`}>
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              refs.current[tab.id] = node;
            }}
            id={tabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={tabPanelId(tab.id)}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`-mb-px flex min-h-10 flex-1 items-center justify-center gap-2 border-b-2 px-3 text-[13px] font-medium ${
              selected
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-secondary hover:bg-sunken hover:text-ink'
            }`}
          >
            {tab.label}
            {tab.count !== undefined ? (
              <span className="data-readout text-xs text-ink-muted">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export default Tabs;
