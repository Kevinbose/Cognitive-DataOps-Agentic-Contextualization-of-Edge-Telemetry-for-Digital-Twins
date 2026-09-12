/**
 * @file Form field primitives.
 *
 * Every control is label-bound via `htmlFor`/`id`, so clicking the label
 * focuses the input. Errors render inline and are wired through
 * `aria-describedby` + `aria-invalid`, so the failure is announced rather than
 * signalled by red text alone.
 *
 * @module components/ui/Field
 */

import { useId } from 'react';

/**
 * Shared control chrome: a sunken field that lifts to white on focus, with an
 * indigo ring. The lift is the affordance — the field looks *active*, not just
 * outlined.
 * @type {string}
 */
const CONTROL = [
  'w-full min-h-10 rounded-md border border-line bg-sunken px-3 py-2',
  'font-sans text-[13px] text-ink',
  'placeholder:text-ink-subtle',
  'transition-[background-color,border-color,box-shadow] duration-150',
  'focus:border-primary focus:bg-surface focus:outline-none focus:shadow-focus',
  'disabled:cursor-not-allowed disabled:opacity-55',
  'aria-[invalid=true]:border-danger aria-[invalid=true]:bg-danger-soft',
].join(' ');

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
      <label
        htmlFor={id}
        className="mb-1.5 block font-sans text-[12px] font-medium text-ink-secondary"
      >
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <input
        id={id}
        className={`${CONTROL} ${mono ? 'font-mono tracking-[-0.01em]' : ''}`}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...rest}
      />

      {hint && !error ? (
        <p id={hintId} className="mt-1.5 font-sans text-[11.5px] leading-relaxed text-ink-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 font-sans text-[11.5px] text-danger"
        >
          <span aria-hidden="true">⚠</span>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.label
 * @param {Array<{value: string, label: string}>} props.options
 * @param {string} [props.hint]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function SelectField({ label, options, hint, className = '', ...rest }) {
  const id = useId();
  const hintId = `${id}-hint`;

  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 block font-sans text-[12px] font-medium text-ink-secondary"
      >
        {label}
      </label>

      <div className="relative">
        {/*
          Explicit background and text colour: a native <select> that inherits
          the OS palette renders unreadable under Windows dark mode.
        */}
        <select
          id={id}
          className={`${CONTROL} cursor-pointer appearance-none pr-9`}
          aria-describedby={hint ? hintId : undefined}
          {...rest}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-ink-muted"
        >
          ▼
        </span>
      </div>

      {hint ? (
        <p id={hintId} className="mt-1.5 font-sans text-[11.5px] text-ink-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * File picker.
 *
 * The native input is visually hidden but stays in the accessibility tree and
 * focus order; a styled `<label>` fronts it. Full keyboard operation survives,
 * which a `<div>`-based dropzone would destroy.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.accept
 * @param {File|null} [props.file]
 * @param {(file: File|null) => void} props.onFileChange
 * @param {string} [props.hint]
 * @param {string} [props.error]
 * @param {string} [props.className]
 * @returns {import('react').JSX.Element}
 */
export function FileField({ label, accept, file, onFileChange, hint, error, className = '' }) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className={className}>
      <span className="mb-1.5 block font-sans text-[12px] font-medium text-ink-secondary">
        {label}
      </span>

      <div
        className={`flex items-stretch overflow-hidden rounded-md border transition-colors duration-150 ${
          error ? 'border-danger bg-danger-soft' : 'border-line bg-sunken'
        }`}
      >
        <label
          htmlFor={id}
          className="flex min-h-10 cursor-pointer items-center gap-2 border-r border-line bg-surface px-4 font-sans text-[12px] font-medium text-ink transition-colors duration-150 hover:bg-primary-soft hover:text-primary"
        >
          <span aria-hidden="true">↑</span>
          Choose File
        </label>

        <input
          id={id}
          type="file"
          accept={accept}
          onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          // `sr-only` keeps it focusable and announced; `display:none` would not.
          className="sr-only"
        />

        {/* `min-w-0` on the flex child is what allows `truncate` to engage —
            long CAD filenames must not blow out the container. */}
        <span className="flex min-w-0 flex-1 items-center px-3">
          <span
            className={`truncate font-mono text-[12px] ${
              file ? 'text-ink' : 'text-ink-subtle'
            }`}
          >
            {file ? file.name : 'No file selected'}
          </span>
        </span>
      </div>

      {hint && !error ? (
        <p className="mt-1.5 font-sans text-[11.5px] leading-relaxed text-ink-muted">{hint}</p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 flex items-start gap-1.5 font-sans text-[11.5px] text-danger"
        >
          <span aria-hidden="true">⚠</span>
          {error}
        </p>
      ) : null}
    </div>
  );
}
