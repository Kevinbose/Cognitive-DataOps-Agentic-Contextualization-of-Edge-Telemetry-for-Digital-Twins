/**
 * @file Segmented controls.
 *
 * One bordered group with 1 px dividers between the segments. The active
 * segment is an inverted ink fill (light text on dark), which reads at a
 * glance without relying on hue. Used for the registry filter, the viewer
 * toggles and the panel switch.
 *
 * Every segment is a real `<button aria-pressed>`; the group is labelled.
 *
 * @module components/ui/Segmented
 */

import Icon from './Icon.jsx';

/**
 * @param {object} props
 * @param {string} props.label - Accessible name of the group.
 * @param {import('react').ReactNode} props.children - `SegmentedButton`s.
 * @param {boolean} [props.fill] - Span the container, sharing its width equally.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function SegmentedGroup({ label, children, fill = false, className = '' }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`border border-control bg-raised ${
        fill ? 'flex w-full [&>button]:flex-1 [&>button]:justify-center' : 'inline-flex'
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * One segment. Independent toggles and exclusive choices both use this: the
 * caller decides what `pressed` means.
 *
 * @param {object} props
 * @param {boolean} props.pressed
 * @param {() => void} props.onClick
 * @param {import('react').ReactNode} props.children
 * @param {import('react').ElementType} [props.icon]
 * @param {string|number} [props.count] - A figure shown in mono after the label.
 * @param {string} [props.ariaLabel] - Needed when the segment is icon-only.
 * @returns {import('react').JSX.Element}
 */
export function SegmentedButton({ pressed, onClick, children, icon, count, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      className={`inline-flex min-h-9 items-center gap-2 border-l border-control px-2 py-1 text-center sm:px-3 text-[13px] font-medium first:border-l-0 ${
        pressed
          ? 'bg-ink text-ink-inverse'
          : 'bg-transparent text-ink-secondary hover:bg-sunken hover:text-ink'
      }`}
    >
      {icon ? <Icon icon={icon} size={16} /> : null}
      {children}
      {count !== undefined ? <span className="data-readout text-xs">{count}</span> : null}
    </button>
  );
}

/**
 * Convenience wrapper for an exclusive choice among `options`.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {Array<{value: string, label: string, count?: string|number}>} props.options
 * @param {string} props.value
 * @param {(value: string) => void} props.onChange
 * @returns {import('react').JSX.Element}
 */
export function Segmented({ label, options, value, onChange }) {
  return (
    <SegmentedGroup label={label}>
      {options.map((option) => (
        <SegmentedButton
          key={option.value || 'all'}
          pressed={value === option.value}
          onClick={() => onChange(option.value)}
          count={option.count}
        >
          {option.label}
        </SegmentedButton>
      ))}
    </SegmentedGroup>
  );
}

export default Segmented;
