/**
 * @file What the agent is pointing at, in the viewport's top-left corner.
 *
 * The red agent highlight on the model is a light, and a light alone never
 * carries meaning in this console: this says in words which part it is, and
 * offers to clear it.
 *
 * @module features/agent/components/AgentPointerChip
 */

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import Icon from '../../../components/ui/Icon.jsx';
import { Crosshair, X } from '../../../components/ui/icons.js';
import { selectPointer } from '../agentSlice.js';
import { clearAgentHighlights } from '../uiCommands.js';

/** @returns {import('react').JSX.Element|null} */
export function AgentPointerChip() {
  const dispatch = useAppDispatch();
  const pointer = useAppSelector(selectPointer);
  if (!pointer) return null;

  return (
    // Kept clear of the Scene census box (top right, 13 rem wide); wraps rather
    // than truncating, because the part name is the whole point of the chip.
    <div className="absolute left-4 top-4 z-20 flex w-max min-w-0 max-w-[min(28rem,calc(100%-16rem))] items-center gap-2 border border-danger bg-surface py-1.5 pl-3 pr-1 max-sm:max-w-[calc(100%-2rem)] max-sm:top-auto max-sm:bottom-24">
      <Icon icon={Crosshair} size={16} className="text-danger" />
      <p className="min-w-0 break-words text-[13px] leading-[18px] text-ink" aria-live="polite">
        <span className="text-ink-muted">Agent is pointing at </span>
        <span className="font-medium">{pointer.label}</span>
      </p>
      <button
        type="button"
        onClick={() => dispatch(clearAgentHighlights())}
        aria-label="Clear the agent's highlights"
        title="Clear"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-ink-secondary hover:bg-sunken hover:text-ink"
      >
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}

export default AgentPointerChip;
