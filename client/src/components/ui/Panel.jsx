/**
 * @file Panel, the console's fundamental container.
 *
 * A flat surface with a 1 px ruled edge. Hierarchy comes from the tone step
 * between canvas and surface and from the ruled header, not from shadow. There
 * is deliberately no `overflow-hidden` here: it would clip the focus ring of
 * any control sitting near the edge.
 *
 * @module components/ui/Panel
 */

/**
 * @param {object} props
 * @param {string} [props.title]
 * @param {string} [props.description] - Optional sub-line under the title.
 * @param {import('react').ReactNode} [props.actions] - Right-aligned controls.
 * @param {import('react').ReactNode} props.children
 * @param {boolean} [props.flush] - Remove body padding, for edge-to-edge tables.
 * @param {'default'|'danger'} [props.tone] - `danger` draws the whole border in alarm.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Panel({
  title,
  description,
  actions,
  children,
  flush = false,
  tone = 'default',
  className = '',
}) {
  return (
    <section
      // `min-w-0`: a Panel is often a grid item, and a grid item defaults to
      // `min-width: auto`, which would stop it shrinking below the intrinsic
      // width of a table inside it and push the whole page wider than the screen.
      className={`min-w-0 border bg-surface ${tone === 'danger' ? 'border-danger' : 'border-line'} ${className}`}
    >
      {title || actions ? (
        <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            {title ? <h2 className="display-section truncate">{title}</h2> : null}
            {description ? <p className="label-text mt-0.5 truncate">{description}</p> : null}
          </div>

          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}

      <div className={flush ? '' : 'p-5'}>{children}</div>
    </section>
  );
}

export default Panel;
