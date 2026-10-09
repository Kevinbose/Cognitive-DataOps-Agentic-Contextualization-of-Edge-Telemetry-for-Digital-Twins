/**
 * @file What the agent did for one answer, as a progress tracker.
 *
 * Every step the agent streams (reading the twin, each model round, each tool
 * with what it looked at and what came back, the manual pages it read, quota
 * waits, a fallback) is appended as it happens. The tracker is collapsed by
 * default: its summary line names the step running now, or how many steps the
 * answer took. Opening it shows the whole sequence on a vertical rule.
 *
 * State is shape plus text, as everywhere: a spinner while running, a dot when
 * done, a square on failure, a ring for a wait. No checkmarks.
 *
 * @module features/agent/components/AgentSteps
 */

import { useId, useState } from 'react';

import Icon from '../../../components/ui/Icon.jsx';
import { CaretDown } from '../../../components/ui/icons.js';

/** @param {{step: import('../agentSlice.js').ChatStep}} props */
function Marker({ step }) {
  if (step.state === 'start') {
    return (
      <span
        aria-hidden="true"
        className="block h-3 w-3 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent"
      />
    );
  }
  if (step.state === 'error') return <span aria-hidden="true" className="block h-2.5 w-2.5 bg-danger" />;
  if (step.kind === 'wait' || step.kind === 'fallback') {
    return <span aria-hidden="true" className="block h-2.5 w-2.5 rounded-full border-[1.5px] border-ink-muted" />;
  }
  return <span aria-hidden="true" className="block h-2.5 w-2.5 rounded-full bg-ink-secondary" />;
}

const STATE_WORD = { start: 'running', done: 'done', error: 'failed' };

/** @param {number|undefined} ms */
function duration(ms) {
  if (typeof ms !== 'number') return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/**
 * @param {object} props
 * @param {import('../agentSlice.js').ChatStep[]} props.steps
 * @param {boolean} props.live - The answer is still being worked on.
 * @returns {import('react').JSX.Element|null}
 */
export function AgentSteps({ steps, live }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!steps?.length) return null;

  const current = live ? [...steps].reverse().find((s) => s.state === 'start') : null;
  const failed = steps.filter((s) => s.state === 'error').length;
  const sources = steps.reduce((n, s) => n + (s.sources?.length ?? 0), 0);
  const total = steps.reduce((t, s) => t + (s.ms ?? 0), 0);

  let summary;
  if (current) summary = current.label;
  else if (live) summary = steps[steps.length - 1].label;
  else
    summary =
      `${steps.length} step${steps.length === 1 ? '' : 's'}` +
      (sources ? `, ${sources} source${sources === 1 ? '' : 's'} read` : '') +
      (failed ? `, ${failed} failed` : '');

  return (
    <div className="border border-line bg-raised">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-sunken"
      >
        <Icon icon={CaretDown} size={14} className={`text-ink-secondary ${open ? '' : '-rotate-90'}`} />
        {live ? (
          <span
            aria-hidden="true"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-primary border-t-transparent"
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 text-ink-secondary">
          {live ? summary : `Agent steps: ${summary}`}
        </span>
        {!live && total > 0 ? <span className="data-readout shrink-0 text-[12px] text-ink-muted">{duration(total)}</span> : null}
      </button>

      {open ? (
        <ol id={listId} className="border-t border-line px-2.5 py-2" aria-label="Agent steps">
          {steps.map((step, i) => (
            <li key={step.id} className="relative flex gap-2.5 pb-2.5 last:pb-0">
              {/* the rail joining one step to the next */}
              {i < steps.length - 1 ? (
                <span aria-hidden="true" className="absolute bottom-0 left-[5px] top-4 w-px bg-line" />
              ) : null}
              <span className="relative mt-[3px] flex h-3 w-3 shrink-0 items-center justify-center">
                <Marker step={step} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[12px] font-medium leading-4 text-ink">
                    {step.label}
                    <span className="sr-only">, {STATE_WORD[step.state] ?? step.state}</span>
                  </p>
                  {duration(step.ms) ? (
                    <span className="data-readout shrink-0 text-[12px] leading-4 text-ink-muted">{duration(step.ms)}</span>
                  ) : null}
                </div>
                {step.detail ? (
                  <p className={`mt-0.5 break-words text-[12px] leading-4 ${step.state === 'error' ? 'text-danger' : 'text-ink-muted'}`}>
                    {step.detail}
                  </p>
                ) : null}
                {step.sources?.length ? (
                  <ul className="mt-1 space-y-0.5" aria-label="Sources read">
                    {step.sources.map((s, j) => (
                      <li key={`${s.ref ?? j}-${s.page}`} className="flex gap-1.5 text-[12px] leading-4 text-ink-secondary">
                        {s.ref ? <span className="font-mono text-ink">[{s.ref}]</span> : null}
                        <span className="min-w-0">
                          {s.document}
                          {s.section ? `, ${s.section}` : ''}
                          {s.page ? <span className="font-mono">, p. {s.page}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export default AgentSteps;
