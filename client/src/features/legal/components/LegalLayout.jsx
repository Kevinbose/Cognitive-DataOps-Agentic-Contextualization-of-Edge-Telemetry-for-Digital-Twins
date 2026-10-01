/**
 * @file Shared frame for the terms and privacy pages.
 *
 * Two columns: a sticky "On this page" index, and the article. Paragraphs and
 * lists keep a reading measure of about 65 characters (see `.legal-prose`);
 * tables use the full column so a four-column table is not cramped. Below `lg`
 * the index sits above the article.
 *
 * @module features/legal/components/LegalLayout
 */

import PageHeader from '../../../components/ui/PageHeader.jsx';

/**
 * @param {object} props
 * @param {string} props.title - The page's H1.
 * @param {string} props.updated - Human-readable date of the last revision.
 * @param {Array<{id: string, title: string}>} props.sections - Index entries, in order.
 * @param {import('react').ReactNode} props.children - The sections themselves.
 * @returns {import('react').JSX.Element}
 */
export function LegalLayout({ title, updated, sections, children }) {
  return (
    <div className="space-y-8">
      <PageHeader title={title}>
        <p className="text-xs text-ink-muted">Last updated {updated}</p>
      </PageHeader>

      <div className="grid gap-10 lg:grid-cols-[220px_minmax(0,56rem)]">
        <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
          <p className="label-text mb-3 text-ink-secondary">On this page</p>
          <ol className="border-l border-line">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block py-1.5 pl-3 text-[13px] text-ink-secondary underline-offset-4 hover:text-ink hover:underline"
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="legal-prose min-w-0 pb-8">{children}</article>
      </div>
    </div>
  );
}

export default LegalLayout;
