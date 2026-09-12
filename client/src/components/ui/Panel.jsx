/**
 * @file Panel — the console's fundamental container.
 *
 * A white card on the tinted canvas, lifted by a hairline border and a
 * slate-tinted shadow rather than a heavy drop shadow. Depth comes from
 * surface contrast, which keeps a dense page calm.
 *
 * @module components/ui/Panel
 */

/**
 * @param {object} props
 * @param {string} [props.title]
 * @param {string} [props.description] - Optional sub-line under the title.
 * @param {import('react').ReactNode} [props.icon] - Small leading glyph.
 * @param {import('react').ReactNode} [props.actions] - Right-aligned controls.
 * @param {import('react').ReactNode} props.children
 * @param {boolean} [props.flush] - Remove body padding, for edge-to-edge tables.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Panel({
  title,
  description,
  icon,
  actions,
  children,
  flush = false,
  className = '',
}) {
  return (
    <section
      className={`overflow-hidden rounded-lg border border-line bg-surface shadow-sm ${className}`}
    >
      {title || actions ? (
        <header className="flex min-h-[52px] flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon ? (
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary"
              >
                {icon}
              </span>
            ) : null}
            <div className="min-w-0">
              {title ? <h2 className="display-section truncate">{title}</h2> : null}
              {description ? (
                <p className="mt-0.5 truncate font-sans text-[12px] text-ink-muted">
                  {description}
                </p>
              ) : null}
            </div>
          </div>

          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}

      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

export default Panel;
