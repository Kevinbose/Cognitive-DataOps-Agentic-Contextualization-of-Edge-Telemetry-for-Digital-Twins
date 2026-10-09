/**
 * @file The assistant's mark.
 *
 * Drawn from the brand mark's idea (an outlined square for the physical asset,
 * a solid square offset from it for its digital twin): here the outline is a
 * square speech bubble, and the solid square sits in its corner, the twin that
 * answers. Flat, two-tone, square corners, inline so it takes the palette.
 *
 * @module components/ui/AssistantMark
 */

/**
 * @param {object} props
 * @param {number} [props.size]
 * @param {'light'|'dark'} [props.on] - The surface it sits on: `dark` for a petrol or ink fill.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function AssistantMark({ size = 20, on = 'light', className = '' }) {
  const line = on === 'dark' ? 'stroke-ink-inverse' : 'stroke-ink';
  const fill = on === 'dark' ? 'fill-ink-inverse' : 'fill-primary';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {/* the bubble: a square with a square tail, mitred like everything else */}
      <path d="M2.5 2.5 H17.5 V14.5 H8.5 L4.5 18.5 V14.5 H2.5 Z" className={line} strokeWidth="1.75" strokeLinejoin="miter" />
      {/* the twin answering, offset into the corner */}
      <rect x="12" y="10" width="9.5" height="9.5" className={fill} />
      {/* two short lines of text inside the bubble */}
      <path d="M6 6.5 H14 M6 10 H10" className={line} strokeWidth="1.5" />
    </svg>
  );
}

export default AssistantMark;
