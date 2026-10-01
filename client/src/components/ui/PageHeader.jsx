/**
 * @file Page header: the H1 and the page's actions on one ruled line.
 *
 * Every routed page has exactly one `<h1>`; this is where it lives, so the rule
 * is structural rather than a convention to remember.
 *
 * @module components/ui/PageHeader
 */

/**
 * @param {object} props
 * @param {string} props.title - The page's H1.
 * @param {import('react').ReactNode} [props.actions] - Buttons, right-aligned.
 * @param {import('react').ReactNode} [props.children] - Content under the title (status, id).
 * @returns {import('react').JSX.Element}
 */
export function PageHeader({ title, actions, children }) {
  return (
    <div className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <h1 className="display-page break-words">{title}</h1>
        {children ? <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">{children}</div> : null}
      </div>

      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export default PageHeader;
