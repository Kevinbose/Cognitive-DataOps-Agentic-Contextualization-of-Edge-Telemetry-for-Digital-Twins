/**
 * @file Agent text with its source references made clickable, and the list of
 * sources those references point to.
 *
 * The agent cites the machine manuals inline as `[S1]`. Each reference becomes
 * a link to the matching entry of the source list below the text, so a reader
 * can check every claim against the page it came from.
 *
 * @module features/agent/components/CitedText
 */

/**
 * @param {object} props
 * @param {string} props.text
 * @param {string} props.anchor - Prefix for the source ids, unique per message.
 * @returns {import('react').JSX.Element}
 */
export function CitedText({ text, anchor }) {
  const lines = String(text ?? '')
    // "[S1, S3]" from older stored answers reads as two links
    .replace(/\[\s*(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})+)\s*\]/g, (_m, refs) =>
      refs.split(/[,;]/).map((r) => `[${r.trim()}]`).join(''),
    )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // The model writes light markdown: source refs, **bold**, `identifiers`.
  /** @param {string} line */
  const withRefs = (line) =>
    line.split(/(\[S\d{1,2}\]|\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
      const ref = /^\[(S\d{1,2})\]$/.exec(part)?.[1];
      if (ref) {
        return (
          <a
            key={i}
            href={`#${anchor}-${ref}`}
            className="font-mono text-[12px] text-primary underline-offset-2 hover:underline"
            aria-label={`Source ${ref.slice(1)}`}
          >
            [{ref}]
          </a>
        );
      }
      const bold = /^\*\*([^*]+)\*\*$/.exec(part)?.[1];
      if (bold) return <strong key={i} className="font-semibold text-ink">{bold}</strong>;
      const code = /^`([^`]+)`$/.exec(part)?.[1];
      if (code) return <code key={i} className="font-mono text-[12px] text-ink">{code}</code>;
      return <span key={i}>{part}</span>;
    });

  const blocks = [];
  /** @type {{ordered: boolean, items: string[]}|null} */
  let list = null;
  const flush = () => {
    if (list?.items.length) {
      const Tag = list.ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag key={`l${blocks.length}`} className={`${list.ordered ? 'list-decimal' : 'list-disc'} space-y-1 pl-5`}>
          {list.items.map((item, i) => (
            <li key={i}>{withRefs(item)}</li>
          ))}
        </Tag>,
      );
    }
    list = null;
  };
  for (const line of lines) {
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    const numbered = /^\d{1,2}[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]);
      continue;
    }
    flush();
    blocks.push(<p key={`p${blocks.length}`}>{withRefs(line)}</p>);
  }
  flush();

  return <div className="space-y-2 break-words">{blocks}</div>;
}

/**
 * @param {object} props
 * @param {Array<{chunkId: string, ref?: string|null, document: string, section?: string|null, page?: number|null}>} props.citations
 * @param {string} props.anchor
 * @param {string} [props.title]
 * @returns {import('react').JSX.Element|null}
 */
export function CitationList({ citations, anchor, title = 'Sources' }) {
  if (!citations?.length) return null;
  return (
    <div>
      <h4 className="label-text">{title}</h4>
      <ol className="mt-1.5 space-y-1.5">
        {citations.map((c, i) => {
          const ref = c.ref ?? `S${i + 1}`;
          return (
            <li key={c.chunkId} id={`${anchor}-${ref}`} className="flex gap-2 text-[12px] leading-4 text-ink-secondary">
              <span className="font-mono text-ink">[{ref}]</span>
              <span className="min-w-0">
                <span className="text-ink">{c.document}</span>
                {c.section ? <>, {c.section.split(' > ').pop()}</> : null}
                {c.page ? <span className="font-mono">, page {c.page}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export default CitedText;
