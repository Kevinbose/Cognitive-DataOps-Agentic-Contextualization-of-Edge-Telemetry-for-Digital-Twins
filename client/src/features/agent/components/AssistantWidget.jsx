/**
 * @file The assistant: a header button and a docked conversation panel.
 *
 * It has a scope, always shown under the typing field so it is clear what a
 * question is about:
 *
 * - **Twin**, on a twin's pages: the twin's name, plus the selected part on the
 *   viewer (which the operator can drop from the question). Answers can point
 *   at parts of the model.
 * - **Plant**, everywhere else: every twin, every machine, every open
 *   investigation.
 *
 * Each scope keeps its own conversation, restored after a reload. An answer
 * streams in: the agent's steps (collapsed into one live line, expandable into
 * a progress tracker), then the text, then the sources it cites.
 *
 * The launcher lives in the page header, not floating over the content: on the
 * viewer the panel docks inside the workspace beside the inspector; on the
 * console pages it hangs under the header.
 *
 * @module features/agent/components/AssistantWidget
 */

import { useEffect, useId, useRef, useState } from 'react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks.js';
import AssistantMark from '../../../components/ui/AssistantMark.jsx';
import Button from '../../../components/ui/Button.jsx';
import Icon from '../../../components/ui/Icon.jsx';
import { Copy, PaperPlaneRight, Plus, Stop, Warning, X } from '../../../components/ui/icons.js';
import { SkeletonText } from '../../../components/ui/Skeleton.jsx';
import { MarkerShape } from '../../../components/ui/StatusMarker.jsx';
import { useTwinMachines } from '../../telemetry/useTwinMachines.js';
import { selectDiscoveredMeshes, selectSelectedMeshName } from '../../twin-viewer/twinViewerSlice.js';
import { useGetAgentStatusQuery, useGetThreadQuery } from '../agentApiSlice.js';
import {
  askAssistant,
  chatToggled,
  selectChatOpen,
  selectThread,
  stopAssistant,
  threadHydrated,
  threadReset,
  threadSelected,
} from '../agentSlice.js';
import { newThreadId, scopeKeyOf, threadIdFor } from '../session.js';
import AgentSteps from './AgentSteps.jsx';
import { CitationList, CitedText } from './CitedText.jsx';

const TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** "gemini-3.5-flash-lite" to "Gemini 3.5 Flash Lite". */
function modelName(id) {
  return String(id ?? '')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * What answers to expect right now: the model, offline mode, or no service.
 *
 * @param {any} status
 * @returns {{marker: string, text: string, notice: string|null}}
 */
function modeOf(status) {
  const agent = status?.agent;
  if (!agent) return { marker: 'unknown', text: 'Checking the assistant', notice: null };
  if (!agent.reachable) {
    return {
      marker: 'alarm',
      text: 'Service not running',
      notice: 'The assistant service is not running. Start it with npm run agent.',
    };
  }
  if (agent.llm === 'degraded') {
    return {
      marker: 'warn',
      text: 'Model resting',
      notice: 'The language model hit its quota. Answers come from live data and the manuals for a few minutes.',
    };
  }
  if (agent.llm === 'no-key' || agent.llm === 'off') {
    return {
      marker: 'offline',
      text: 'Offline mode',
      notice: 'No language model key is set. Answers come from live data and the manuals.',
    };
  }
  const rpm = agent.limits?.rpm;
  return { marker: 'online', text: modelName(agent.llm) + (rpm ? `, ${rpm} requests a minute` : ''), notice: null };
}

/**
 * The header button that opens and closes the assistant.
 *
 * @param {{label?: string}} props
 * @returns {import('react').JSX.Element}
 */
export function AssistantButton({ label = 'Assistant' }) {
  const dispatch = useAppDispatch();
  const open = useAppSelector(selectChatOpen);
  return (
    <button
      type="button"
      onClick={() => dispatch(chatToggled())}
      aria-expanded={open}
      aria-controls="assistant-panel"
      className={[
        'inline-flex min-h-9 items-center gap-2 border px-3 text-[13px] font-medium',
        open
          ? 'border-ink bg-ink text-ink-inverse'
          : 'border-primary bg-primary text-ink-inverse hover:border-primary-hover hover:bg-primary-hover',
      ].join(' ')}
    >
      <AssistantMark size={18} on="dark" />
      {label}
    </button>
  );
}

/** @param {{text: string}} props */
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard refused: nothing to do */
        }
      }}
      className="inline-flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink"
    >
      <Icon icon={Copy} size={14} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/**
 * @param {{message: import('../agentSlice.js').ChatMessage & {at?: number}}} props
 */
function Message({ message }) {
  const when = message.at ? TIME.format(new Date(message.at)) : null;

  if (message.role === 'user') {
    const about = [message.scopeName, message.partLabel].filter(Boolean).join(', ');
    return (
      <li className="ml-10 flex flex-col items-end">
        <div className="max-w-full whitespace-pre-wrap break-words border border-line bg-sunken px-3 py-2 text-[14px] leading-5 text-ink">
          {message.text}
        </div>
        <p className="label-text mt-1 text-right">
          {about ? `About ${about}` : 'You'}
          {when ? <span className="font-mono">, {when}</span> : null}
        </p>
      </li>
    );
  }

  const anchor = `msg-${message.id}`;
  const live = message.status === 'pending' || message.status === 'streaming';
  const waiting = message.status === 'pending' && !message.text;
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center bg-primary">
        <AssistantMark size={17} on="dark" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="label-text">
          Assistant{when ? <span className="font-mono">, {when}</span> : null}
        </p>
        <div className="mt-1.5">
          <AgentSteps steps={message.steps ?? []} live={live} />
        </div>
        <div className="mt-2 text-[14px] leading-[22px] text-ink">
          {waiting ? <SkeletonText lines={2} /> : <CitedText text={message.text} anchor={anchor} />}
          {message.status === 'error' ? (
            <p className="mt-2 flex items-start gap-2 text-[13px] text-danger">
              <Icon icon={Warning} size={16} className="mt-0.5" />
              <span>{message.error}</span>
            </p>
          ) : null}
        </div>
        {message.citations?.length ? (
          <div className="mt-2.5 border-t border-line pt-2">
            <CitationList citations={message.citations} anchor={anchor} />
          </div>
        ) : null}
        {message.status === 'done' ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <CopyButton text={message.text} />
            {message.degraded ? (
              <span className="text-[12px] text-ink-muted">Answered without the language model</span>
            ) : message.model ? (
              <span className="text-[12px] text-ink-muted">{modelName(message.model)}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Questions worth asking here, from what this scope really holds.
 *
 * @param {'plant'|'twin'} scope
 * @param {any[]} machines - Machines on the twin.
 * @param {string|null} partLabel
 */
function suggestionsFor(scope, machines, partLabel) {
  if (scope === 'plant') {
    return [
      'How is the plant doing?',
      'Are there open investigations?',
      'What did the latest report find?',
      'Which machines are offline?',
    ];
  }
  const out = [];
  if (partLabel) out.push('What is this part?');
  if (!machines.length) {
    out.push('Which machines can I add to this twin?', 'How is this twin running?');
    return out;
  }
  out.push('How is this twin running?');
  for (const m of machines.slice(0, 2)) out.push(`Is anything wrong with ${m.label}?`);
  out.push('What did the latest report find?');
  return out.slice(0, 4);
}

/**
 * @param {object} props
 * @param {'plant'|'twin'} props.scope
 * @param {string|null} [props.assetId]
 * @param {string|null} [props.assetName]
 * @param {boolean} [props.withSelection] - Offer the viewer's selected part as context.
 * @param {string|null} [props.activePanel] - The viewer's open left panel.
 * @param {'page'|'workspace'} [props.placement] - Under the console header, or inside the viewer's workspace.
 * @param {boolean} [props.besideInspector] - The viewer's inspector is open on the right.
 * @returns {import('react').JSX.Element|null}
 */
export function AssistantWidget({
  scope,
  assetId = null,
  assetName = null,
  withSelection = false,
  activePanel = null,
  placement = 'page',
  besideInspector = false,
}) {
  const dispatch = useAppDispatch();
  const open = useAppSelector(selectChatOpen);
  const key = scopeKeyOf(scope, assetId);
  const [threadId, setThreadId] = useState(() => threadIdFor(key));
  const thread = useAppSelector((state) => selectThread(state, key));
  const [draft, setDraft] = useState('');
  const [includePart, setIncludePart] = useState(true);
  const { attached } = useTwinMachines(assetId);

  const inputId = useId();
  const hintId = useId();
  const inputRef = useRef(/** @type {HTMLTextAreaElement|null} */ (null));
  const logRef = useRef(/** @type {HTMLDivElement|null} */ (null));

  // A different scope is a different conversation.
  useEffect(() => {
    setThreadId(threadIdFor(key));
  }, [key]);
  useEffect(() => {
    dispatch(threadSelected({ key, threadId }));
  }, [dispatch, key, threadId]);

  // Restore the stored transcript the first time the panel opens on this thread.
  const needsHistory = open && Boolean(thread) && !thread?.hydrated && thread?.threadId === threadId;
  const history = useGetThreadQuery(threadId, { skip: !needsHistory });
  useEffect(() => {
    if (needsHistory && (history.isSuccess || history.isError)) {
      dispatch(threadHydrated({ key, threadId, messages: history.data?.messages ?? [] }));
    }
  }, [dispatch, needsHistory, history.isSuccess, history.isError, history.data, key, threadId]);

  const { data: status } = useGetAgentStatusQuery(undefined, { skip: !open, pollingInterval: open ? 30_000 : 0 });
  const mode = modeOf(status);

  const selectedMesh = useAppSelector(selectSelectedMeshName);
  const discovered = useAppSelector(selectDiscoveredMeshes);
  const part = withSelection && selectedMesh ? selectedMesh : null;
  const partLabel = part ? (discovered.find((d) => d.name === part)?.label ?? part) : null;
  useEffect(() => setIncludePart(true), [part]);

  const scopeName = scope === 'twin' ? (assetName ?? 'this twin') : 'the whole plant';
  const busy = Boolean(thread?.busy);
  const messages = thread?.messages ?? [];
  const last = messages[messages.length - 1];
  const progress = `${last?.text?.length ?? 0}-${last?.steps?.length ?? 0}-${last?.status ?? ''}`;

  useEffect(() => {
    // preventScroll: focusing a field that is still sliding in would make the
    // browser scroll the clipped workspace to reveal it, jerking the whole view.
    if (open) inputRef.current?.focus({ preventScroll: true });
  }, [open]);

  // Follow the answer as it grows, unless the reader has scrolled up to read.
  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages.length, progress, open]);

  // The typing field grows with the question, up to six lines.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [draft, open]);

  if (!open) return null;

  const close = () => dispatch(chatToggled(false));

  /** @param {string} text */
  const send = (text) => {
    const message = text.trim();
    if (!message || busy) return;
    /** @type {Record<string, any>} */
    const context = { scope };
    if (scope === 'twin') {
      context.assetId = assetId;
      if (part && includePart) context.selectedMesh = part;
      if (activePanel) context.activePanel = activePanel;
    }
    dispatch(askAssistant({ key, threadId, message, context, scopeName, partLabel: part && includePart ? partLabel : null }));
    setDraft('');
  };

  const startOver = () => {
    stopAssistant(key);
    const id = newThreadId(key);
    setThreadId(id);
    dispatch(threadReset({ key, threadId: id }));
    inputRef.current?.focus({ preventScroll: true });
  };

  const position =
    placement === 'workspace'
      ? `absolute bottom-3 top-3 z-30 w-[420px] ${
          besideInspector ? 'right-3 max-w-[calc(100%-1.5rem)] lg:right-[372px] lg:max-w-[calc(100%-384px)]' : 'right-3 max-w-[calc(100%-1.5rem)]'
        }`
      : 'fixed bottom-4 right-4 top-[76px] z-40 w-[440px] max-w-[calc(100vw-2rem)]';

  return (
    <section
      id="assistant-panel"
      aria-label="Assistant"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
      className={`rule-ink panel-in flex flex-col border-x border-b border-control bg-surface ${position}`}
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-primary">
          <AssistantMark size={22} on="dark" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="display-section leading-5">Assistant</h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 text-ink-muted">
            <MarkerShape state={mode.marker} />
            <span className="truncate">{mode.text}</span>
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button variant="ghost" size="icon" icon={Plus} onClick={startOver} aria-label="New conversation" title="New conversation" />
          <Button variant="ghost" size="icon" icon={X} onClick={close} aria-label="Close the assistant" title="Close" />
        </div>
      </header>

      {mode.notice ? (
        <p className="flex items-start gap-2 border-b border-line bg-raised px-4 py-2 text-[12px] leading-4 text-ink-secondary">
          <Icon icon={Warning} size={16} className="text-warning" />
          <span>{mode.notice}</span>
        </p>
      ) : null}

      <div
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {needsHistory ? (
          <div aria-hidden="true" className="space-y-5">
            <SkeletonText lines={2} />
            <SkeletonText lines={3} />
          </div>
        ) : messages.length === 0 ? (
          <div>
            <p className="text-[14px] leading-[22px] text-ink">
              Ask about{' '}
              {scope === 'twin' ? <strong className="font-semibold">{scopeName}</strong> : scopeName}: machines, live
              readings, open investigations, reports{scope === 'twin' ? ', where a part is' : ''}, or what the manuals
              say. Each answer shows the steps the agent took and the pages it read.
            </p>
            <h3 className="label-text mt-5">Try</h3>
            <ul className="mt-1.5 divide-y divide-line border-y border-line">
              {suggestionsFor(scope, attached, part ? partLabel : null).map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => send(s)}
                    className="w-full px-2 py-2 text-left text-[13px] text-ink-secondary hover:bg-sunken hover:text-ink"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="space-y-6">
            {messages.map((m) => (
              <Message key={m.id} message={m} />
            ))}
          </ol>
        )}
      </div>

      <form
        className="shrink-0 border-t border-line bg-surface px-4 pb-3 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Question for the assistant
        </label>
        <div className="flex items-end border border-control bg-raised focus-within:border-primary">
          <textarea
            id={inputId}
            ref={inputRef}
            rows={1}
            maxLength={2000}
            value={draft}
            aria-describedby={hintId}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(draft);
              }
            }}
            placeholder={scope === 'twin' ? 'Ask about this twin' : 'Ask about the plant'}
            className="min-h-[44px] flex-1 resize-none bg-transparent px-3 py-2.5 text-[14px] leading-5 text-ink placeholder:text-ink-muted"
          />
          {busy ? (
            <Button
              type="button"
              variant="secondary"
              size="icon"
              icon={Stop}
              onClick={() => stopAssistant(key)}
              aria-label="Stop the answer"
              title="Stop"
              className="m-1 !h-9 !w-9"
            />
          ) : (
            <Button
              type="submit"
              variant="primary"
              size="icon"
              icon={PaperPlaneRight}
              disabled={!draft.trim()}
              aria-label="Send question"
              title="Send"
              className="m-1 !h-9 !w-9"
            />
          )}
        </div>

        {/* What the question is about: always visible, under the typing field. */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Question scope">
          <span className="label-text">Asking about</span>
          <span className="inline-flex max-w-full items-center border border-control bg-raised px-2 py-0.5 text-[12px] leading-4 text-ink">
            <span className="mr-1 text-ink-muted">{scope === 'twin' ? 'Twin' : 'Plant'}</span>
            <span className="truncate font-medium">{scope === 'twin' ? scopeName : 'all twins'}</span>
          </span>
          {part && includePart ? (
            <span className="inline-flex max-w-full items-center border border-control bg-raised text-[12px] leading-4 text-ink">
              <span className="truncate py-0.5 pl-2">
                <span className="mr-1 text-ink-muted">Part</span>
                <span className="font-medium">{partLabel}</span>
              </span>
              <button
                type="button"
                onClick={() => setIncludePart(false)}
                aria-label={`Do not ask about ${partLabel}`}
                title="Leave the part out"
                className="ml-1 inline-flex h-5 w-5 items-center justify-center text-ink-secondary hover:bg-sunken hover:text-ink"
              >
                <Icon icon={X} size={12} />
              </button>
            </span>
          ) : null}
        </div>
        <p id={hintId} className="label-text mt-1.5">
          Enter sends, Shift and Enter starts a new line
        </p>
      </form>
    </section>
  );
}

export default AssistantWidget;
