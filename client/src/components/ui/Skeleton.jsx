/**
 * @file Skeleton placeholders.
 *
 * A skeleton is a stand-in the exact size of the content it replaces, so the
 * layout does not jump when the data lands. Bars are static `sunken` blocks
 * that only change opacity (see `.skeleton` in `index.css`): no shimmer
 * gradient, and stilled entirely under `prefers-reduced-motion`.
 *
 * Every skeleton group is hidden from assistive technology; the loading state
 * that wraps it announces "Loading ..." once, in a live region.
 *
 * @module components/ui/Skeleton
 */

/**
 * One placeholder bar.
 *
 * @param {object} props
 * @param {string} [props.className] - Size it like the real content, e.g. `h-4 w-40`.
 * @returns {import('react').JSX.Element}
 */
export function Skeleton({ className = 'h-4 w-full' }) {
  return <span aria-hidden="true" className={`skeleton ${className}`} />;
}

/**
 * Rows of a table or list.
 *
 * @param {object} props
 * @param {number} [props.rows]
 * @param {number} [props.columns]
 * @returns {import('react').JSX.Element}
 */
export function SkeletonRows({ rows = 4, columns = 4 }) {
  return (
    <div aria-hidden="true" className="divide-y divide-line">
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="grid items-center gap-6 px-5 py-4"
          style={{ gridTemplateColumns: `2fr repeat(${columns - 1}, 1fr)` }}
        >
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton
              key={column}
              className={column === 0 ? 'h-5 w-3/4' : 'h-4 w-2/3'}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A stack of text lines, the last one shorter, like a paragraph.
 *
 * @param {object} props
 * @param {number} [props.lines]
 * @returns {import('react').JSX.Element}
 */
export function SkeletonText({ lines = 3 }) {
  return (
    <div aria-hidden="true" className="space-y-2.5">
      {Array.from({ length: lines }, (_, line) => (
        <Skeleton key={line} className={`h-4 ${line === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}

export default Skeleton;
