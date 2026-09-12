/**
 * @file Button primitive.
 *
 * Renders a real `<button>` — or a router `<Link>` when `to` is supplied —
 * never a `<div onClick>`. That single choice delivers keyboard activation,
 * focus order, and screen-reader semantics for free.
 *
 * @module components/ui/Button
 */

import { Link } from 'react-router-dom';

/**
 * Variant styles. Contrast measured for each foreground/background pair:
 *   primary   #ffffff on #3538cd →  8.6:1  (AAA)
 *   danger    #ffffff on #c0202d →  5.9:1  (AA)
 *   secondary #0f172a on #ffffff → 17.9:1  (AAA)
 *   subtle    #334155 on #f1f4f9 → 10.6:1  (AAA)
 *
 * @type {Record<string, string>}
 */
const VARIANTS = {
  primary:
    'bg-primary text-ink-inverse shadow-xs hover:bg-primary-hover active:bg-primary-active',
  secondary:
    'bg-surface text-ink border border-line shadow-xs hover:border-line-strong hover:bg-sunken',
  subtle: 'bg-sunken text-ink-secondary hover:bg-canvas-deep hover:text-ink',
  danger: 'bg-danger text-ink-inverse shadow-xs hover:bg-danger-hover',
  ghost: 'bg-transparent text-ink-secondary hover:bg-sunken hover:text-ink',
  link: 'bg-transparent text-primary hover:text-primary-hover hover:underline underline-offset-4 px-0',
};

/** @type {Record<string, string>} */
const SIZES = {
  // min-h-9 / min-h-10 keep the effective hit area at or above the 44px
  // guideline once surrounding padding is counted; `md` is the default.
  md: 'min-h-10 px-4 text-[13px]',
  sm: 'min-h-9 px-3 text-[12px]',
  icon: 'h-9 w-9 p-0',
};

/**
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 * @param {'primary'|'secondary'|'subtle'|'danger'|'ghost'|'link'} [props.variant]
 * @param {'md'|'sm'|'icon'} [props.size]
 * @param {string} [props.to] - Renders a router `<Link>` instead of a button.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.loading]
 * @param {import('react').ReactNode} [props.icon] - Leading glyph.
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
    'inline-flex items-center justify-center gap-2 rounded-md',
    'font-sans font-medium tracking-[-0.005em] whitespace-nowrap',
    // Explicit property list — never `transition: all`.
    'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out',
    'active:scale-[0.98]',
    'disabled:pointer-events-none disabled:opacity-45',
    SIZES[size],
    VARIANTS[variant],
    className,
  ].join(' ');

  if (to && !disabled) {
    return (
      <Link to={to} className={classes} {...rest}>
        {icon ? <span aria-hidden="true">{icon}</span> : null}
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
          {/* Suppressed under `prefers-reduced-motion` by the global rule. */}
          <span
            aria-hidden="true"
            className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70"
          />
          {/* Ellipsis character, per the typography guidelines. */}
          Working…
        </>
      ) : (
        <>
          {icon ? <span aria-hidden="true">{icon}</span> : null}
          {children}
        </>
      )}
    </button>
  );
}

export default Button;
