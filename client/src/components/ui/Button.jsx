/**
 * @file Button primitive.
 *
 * Renders a real `<button>`, or a router `<Link>` when `to` is supplied, never
 * a `<div onClick>`. That single choice delivers keyboard activation, focus
 * order and screen-reader semantics for free.
 *
 * Flat by rule: square corners, no shadow, no gradient. Hover and press change
 * colour instantly (no transition, no transform); focus is the global 2 px
 * brand outline.
 *
 * @module components/ui/Button
 */

import { Link } from 'react-router-dom';

import Icon from './Icon.jsx';

/**
 * Variant styles. Every fill keeps a 1 px border of its own colour, so the
 * sizes of the variants match exactly and a button never shifts when hovered.
 * Contrast (verified by `scripts/check-contrast.mjs`):
 *   primary   text #f9faf8 on #135e66  7.11:1
 *   danger    text #f9faf8 on #b3261e  6.24:1
 *   secondary text #151d1c on #f9faf8 16.38:1
 *
 * @type {Record<string, string>}
 */
const VARIANTS = {
  primary:
    'border-primary bg-primary text-ink-inverse hover:border-primary-hover hover:bg-primary-hover active:border-primary-active active:bg-primary-active',
  secondary: 'border-control bg-raised text-ink hover:bg-sunken active:bg-line',
  subtle: 'border-transparent bg-sunken text-ink-secondary hover:bg-line hover:text-ink',
  danger:
    'border-danger bg-danger text-ink-inverse hover:border-danger-hover hover:bg-danger-hover',
  ghost: 'border-transparent bg-transparent text-ink-secondary hover:bg-sunken hover:text-ink',
  link: 'border-transparent bg-transparent px-0 text-primary underline underline-offset-4 hover:text-primary-hover',
};

/** @type {Record<string, string>} */
const SIZES = {
  md: 'min-h-10 px-4 text-[13px]',
  sm: 'min-h-9 px-3 text-xs',
  icon: 'h-10 w-10 p-0',
};

/**
 * @param {object} props
 * @param {import('react').ReactNode} [props.children]
 * @param {'primary'|'secondary'|'subtle'|'danger'|'ghost'|'link'} [props.variant]
 * @param {'md'|'sm'|'icon'} [props.size]
 * @param {string} [props.to] - Renders a router `<Link>` instead of a button.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.loading]
 * @param {import('react').ElementType} [props.icon] - Leading glyph from `./icons.js`.
 * @param {string} [props.className]
 * @param {'button'|'submit'} [props.type]
 * @returns {import('react').JSX.Element}
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  to,
  disabled = false,
  loading = false,
  icon,
  className = '',
  type = 'button',
  ...rest
}) {
  const classes = [
    'inline-flex items-center justify-center gap-2 border',
    'font-sans font-medium whitespace-nowrap',
    'disabled:pointer-events-none disabled:opacity-50',
    SIZES[size],
    VARIANTS[variant],
    className,
  ].join(' ');

  const glyph = icon ? <Icon icon={icon} size={size === 'icon' ? 20 : 16} /> : null;

  if (to && !disabled) {
    return (
      <Link to={to} className={classes} {...rest}>
        {glyph}
        {children}
      </Link>
    );
  }

  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <>
          {/* Functional motion only. Stilled by the global reduced-motion rule. */}
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          />
          Working…
        </>
      ) : (
        <>
          {glyph}
          {children}
        </>
      )}
    </button>
  );
}

export default Button;
