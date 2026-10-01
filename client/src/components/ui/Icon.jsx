/**
 * @file Icon wrapper.
 *
 * One rule for every glyph in the console: regular weight, `currentColor`, no
 * container tile, and hidden from assistive technology unless it stands alone
 * (an icon-only button carries the `aria-label`, not the icon inside it).
 *
 * @module components/ui/Icon
 */

/**
 * @param {object} props
 * @param {import('react').ElementType} props.icon - A component from `./icons.js`.
 * @param {number} [props.size] - Pixels. 16 inline, 20 in toolbars.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function Icon({ icon: Glyph, size = 16, className = '' }) {
  return (
    <Glyph
      size={size}
      weight="regular"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    />
  );
}

export default Icon;
