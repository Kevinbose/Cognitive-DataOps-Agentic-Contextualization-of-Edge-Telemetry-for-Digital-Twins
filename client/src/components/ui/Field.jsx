/**
 * @file Form field primitives.
 *
 * Every control is label-bound via `htmlFor`/`id`, so clicking the label
 * focuses the input. Errors render inline and are wired through
 * `aria-describedby` and `aria-invalid`, so a failure is announced rather than
 * signalled by colour alone. The error line also carries an icon and text, so
 * it survives without hue.
 *
 * Controls are flat: a raised fill, a 1 px `control` border (3:1 against every
 * surface), square corners. Focus is the global 2 px brand outline.
 *
 * @module components/ui/Field
 */

import { useId } from 'react';

import Icon from './Icon.jsx';
import { CaretDown, MagnifyingGlass, UploadSimple, Warning } from './icons.js';

/**
 * Shared control chrome.
 * @type {string}
 */
const CONTROL = [
  'w-full min-h-10 border border-control bg-raised px-3 py-2',
  'font-sans text-[14px] text-ink',
  'placeholder:text-ink-muted',
  'focus:border-primary',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'aria-[invalid=true]:border-danger',
].join(' ');

/**
 * @param {object} props
 * @param {string} props.id
 * @param {string} props.children
 * @param {boolean} [props.required]
 * @returns {import('react').JSX.Element}
 */
function FieldLabel({ id, children, required = false }) {
  return (
    <label htmlFor={id} className="label-text mb-1.5 block text-ink-secondary">
      {children}
      {required ? (
        <span className="ml-1 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

/**
 * @param {object} props
 * @param {string} props.id
 * @param {string} props.children
 * @returns {import('react').JSX.Element}
 */
function FieldError({ id, children }) {
  return (
    <p id={id} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs text-danger">
      <Icon icon={Warning} size={14} className="mt-px" />
      <span>{children}</span>
    </p>
  );
}

/**
 * @param {object} props
 * @param {string} props.label
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {boolean} [props.required]
 * @param {boolean} [props.mono] - Monospace input, for identifiers.
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function TextField({
  label,
  hint,
  error,
  required = false,
  mono = false,
  className = '',
  ...rest
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <FieldLabel id={id} required={required}>
        {label}
      </FieldLabel>

      <input
        id={id}
        className={`${CONTROL} ${mono ? 'font-mono text-[13px]' : ''}`}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      />

      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.label
 * @param {Array<{value: string, label: string}>} [props.options] - Flat options.
 * @param {Array<{label: string, options: Array<{value: string, label: string}>}>} [props.groups]
 *   Grouped options, rendered as `<optgroup>`. Use either `options` or `groups`.
 * @param {string} [props.placeholder] - Text of a leading empty option, when no choice is made yet.
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {boolean} [props.required]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function SelectField({
  label,
  options = [],
  groups,
  placeholder,
  hint,
  error,
  required = false,
  className = '',
  ...rest
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <FieldLabel id={id} required={required}>
        {label}
      </FieldLabel>

      <div className="relative">
        {/*
          Explicit background and text colour: a native <select> that inherits
          the OS palette renders unreadable under Windows dark mode.
        */}
        <select
          id={id}
          className={`${CONTROL} cursor-pointer appearance-none pr-10`}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : hint ? hintId : undefined}
          {...rest}
        >
          {placeholder ? <option value="">{placeholder}</option> : null}
          {groups
            ? groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))
            : options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
        </select>
        <Icon
          icon={CaretDown}
          size={14}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-secondary"
        />
      </div>

      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * File picker.
 *
 * The native input is visually hidden but stays in the accessibility tree and
 * focus order; a styled `<label>` fronts it. Full keyboard operation survives,
 * which a `<div>`-based dropzone would destroy. The group shows the focus ring
 * when the hidden input is focused from the keyboard.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.accept
 * @param {File|null} [props.file]
 * @param {(file: File|null) => void} props.onFileChange
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {string} [props.className]
 * @param {string} [props.name] - Form field name of the native input.
 * @returns {import('react').JSX.Element}
 */
export function FileField({ label, accept, file, onFileChange, hint, error, className = '', name }) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <span className="label-text mb-1.5 block text-ink-secondary">{label}</span>

      <div
        className={`flex items-stretch border bg-raised has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary ${
          error ? 'border-danger' : 'border-control'
        }`}
      >
        <label
          htmlFor={id}
          className={`flex min-h-10 cursor-pointer items-center gap-2 border-r bg-surface px-4 text-[13px] font-medium text-ink hover:bg-sunken ${
            error ? 'border-danger' : 'border-control'
          }`}
        >
          <Icon icon={UploadSimple} size={16} />
          Choose file
        </label>

        <input
          id={id}
          name={name}
          type="file"
          accept={accept}
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          // `sr-only` keeps it focusable and announced; `display:none` would not.
          className="sr-only"
        />

        {/* `min-w-0` on the flex child is what allows `truncate` to engage:
            long CAD filenames must not blow out the container. */}
        <span className="flex min-w-0 flex-1 items-center px-3">
          <span className={`truncate font-mono text-xs ${file ? 'text-ink' : 'text-ink-muted'}`}>
            {file ? file.name : 'No file selected'}
          </span>
        </span>
      </div>

      {hint && !error ? <p className="mt-1.5 text-xs text-ink-muted">{hint}</p> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * A search box: an icon, a screen-reader label and a `type="search"` input.
 *
 * The label is visually hidden because the magnifier and the placeholder say
 * what the box is for, but it is still the control's accessible name.
 *
 * @param {object} props
 * @param {string} props.label - Accessible name (not displayed).
 * @param {string} props.value
 * @param {(value: string) => void} props.onValueChange
 * @param {string} [props.placeholder]
 * @param {string} [props.className]
 * @param {string} [props.name]
 * @returns {import('react').JSX.Element}
 */
export function SearchField({
  label,
  value,
  onValueChange,
  placeholder = 'Search…',
  className = '',
  name = 'search',
}) {
  const id = useId();

  return (
    <div className={`relative ${className}`}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Icon
        icon={MagnifyingGlass}
        size={16}
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-secondary"
      />
      <input
        id={id}
        name={name}
        type="search"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="min-h-9 w-full border border-control bg-raised py-1.5 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-muted focus:border-primary"
      />
    </div>
  );
}
