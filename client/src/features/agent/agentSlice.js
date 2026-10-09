/**
 * @file Assistant and diagnosis state in the browser.
 *
 * Three things live here:
 *
 * - **Alerts** pushed by the API when the agent publishes a report
 *   (`agent:alert`), newest first, with the ones the operator dismissed.
 * - **The report panel**: which report the twin page is showing, and the part
 *   the agent last pointed at.
 * - **Chat threads**, one per scope (the plant, or one twin), each a list of
 *   messages that a streaming answer fills in event by event.
 *
 * Reports themselves are server data and are read through RTK Query
 * (`agentApiSlice`); only what the socket pushes and what the user typed is
 * kept here.
 *
 * @module features/agent/agentSlice
 */

import { createSlice } from '@reduxjs/toolkit';

import { selectMesh } from '../twin-viewer/twinViewerSlice.js';
import { readSse } from './sse.js';
import { getSessionId } from './session.js';

/**
 * One thing the agent did for an answer, streamed as it happens.
 *
 * @typedef {object} ChatStep
 * @property {string} id - Stable within one answer; a later event updates it.
 * @property {'context'|'model'|'tool'|'wait'|'fallback'|'answer'} kind
 * @property {string} label - What the agent is doing, in words.
 * @property {string|null} [detail] - What it looked at, or what came back.
 * @property {'start'|'done'|'error'} state
 * @property {Array<{ref?: string, document: string, section?: string, page?: number}>} [sources] - What it read.
 * @property {number} [ms] - How long it took, once finished.
 */

/**
 * @typedef {object} ChatMessage
 * @property {string} id
 * @property {'user'|'assistant'} role
 * @property {string} text
 * @property {'pending'|'streaming'|'done'|'error'} [status]
 * @property {string|null} [statusText] - The agent's latest progress line.
 * @property {ChatStep[]} [steps]
 * @property {Array<{chunkId: string, ref?: string, document: string, section?: string, page?: number, filename?: string}>} [citations]
 * @property {boolean} [degraded] - Answered without the language model.
 * @property {string|null} [model]
 * @property {string|null} [error]
 * @property {string|null} [scopeName] - On a user message: what was being asked about.
 * @property {string|null} [partLabel] - On a user message: the selected part, if any.
 */

/**
 * @typedef {object} Thread
 * @property {string} threadId
 * @property {ChatMessage[]} messages
 * @property {boolean} busy
 * @property {boolean} hydrated - The stored transcript was loaded (or there was none).
 */

const MAX_ALERTS = 20;

const initialState = {
  /** @type {string|null} The twin page currently open, so commands for other twins are ignored. */
  activeAssetId: null,
  /** @type {any[]} */
  alerts: [],
  /** @type {Record<string, true>} */
  dismissed: {},
  /** @type {string|null} */
  openReportId: null,
  /** @type {{meshName: string, label: string}|null} */
  pointer: null,
  chatOpen: false,
  /** @type {Record<string, Thread>} */
  threads: {},
};

/** @param {typeof initialState} state @param {string} key @param {string} threadId */
function ensureThread(state, key, threadId) {
  if (!state.threads[key] || state.threads[key].threadId !== threadId) {
    state.threads[key] = { threadId, messages: [], busy: false, hydrated: false };
  }
  return state.threads[key];
}

/** @param {Thread|undefined} thread @param {string} id */
function assistantMessage(thread, id) {
  return thread?.messages.find((m) => m.id === `${id}-a`);
}

const agentSlice = createSlice({
  name: 'agent',
  initialState,
  reducers: {
    twinOpened(state, action) {
      state.activeAssetId = action.payload;
      state.openReportId = null;
      state.pointer = null;
    },
    twinClosed(state) {
      state.activeAssetId = null;
      state.openReportId = null;
      state.pointer = null;
    },

    alertReceived(state, action) {
      const alert = action.payload;
      if (!alert?.reportId || state.alerts.some((a) => a.reportId === alert.reportId)) return;
      state.alerts.unshift(alert);
      state.alerts.length = Math.min(state.alerts.length, MAX_ALERTS);
    },
    alertDismissed(state, action) {
      state.dismissed[action.payload] = true;
    },

    reportOpened(state, action) {
      state.openReportId = action.payload;
    },
    reportClosed(state) {
      state.openReportId = null;
    },
    pointerSet(state, action) {
      state.pointer = action.payload;
    },
    pointerCleared(state) {
      state.pointer = null;
    },

    chatToggled(state, action) {
      state.chatOpen = typeof action.payload === 'boolean' ? action.payload : !state.chatOpen;
    },
    threadSelected(state, action) {
      ensureThread(state, action.payload.key, action.payload.threadId);
    },
    /** The stored transcript arrived; it never replaces messages typed meanwhile. */
    threadHydrated(state, action) {
      const { key, threadId, messages } = action.payload;
      const thread = ensureThread(state, key, threadId);
      if (!thread.messages.length && Array.isArray(messages)) {
        thread.messages = messages.map((m, i) => ({
          id: `h${i}`,
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.text ?? '',
          status: 'done',
          citations: m.citations ?? [],
          degraded: Boolean(m.degraded),
          model: m.model ?? null,
          scopeName: m.scopeName ?? null,
          partLabel: m.selectedMesh ?? null,
          steps: Array.isArray(m.steps) ? m.steps : [],
          at: typeof m.ts === 'number' ? m.ts * 1000 : null,
        }));
      }
      thread.hydrated = true;
    },
    threadReset(state, action) {
      const { key, threadId } = action.payload;
      state.threads[key] = { threadId, messages: [], busy: false, hydrated: true };
    },

    userAsked(state, action) {
      const { key, threadId, id, text, scopeName, partLabel } = action.payload;
      const thread = ensureThread(state, key, threadId);
      thread.hydrated = true;
      thread.busy = true;
      const at = Date.now();
      thread.messages.push({ id, role: 'user', text, scopeName, partLabel, at });
      thread.messages.push({
        id: `${id}-a`, role: 'assistant', text: '', status: 'pending', statusText: null,
        steps: [], citations: [], degraded: false, model: null, error: null, at,
      });
    },
    streamEvent(state, action) {
      const { key, id, event, data } = action.payload;
      const msg = assistantMessage(state.threads[key], id);
      if (!msg) return;
      switch (event) {
        case 'token':
          msg.text += data?.text ?? '';
          if (msg.status === 'pending') msg.status = 'streaming';
          break;
        case 'status':
          msg.statusText = data?.text ?? null;
          break;
        case 'step': {
          if (!data?.id) break;
          const step = msg.steps.find((s) => s.id === data.id);
          if (step) Object.assign(step, data);
          else msg.steps.push({ ...data });
          if (data.state === 'start') msg.statusText = data.label;
          break;
        }
        case 'citations':
          msg.citations = Array.isArray(data?.items) ? data.items : [];
          break;
        case 'meta':
          msg.degraded = Boolean(data?.degraded);
          msg.model = data?.model ?? null;
          break;
        case 'error':
          msg.status = 'error';
          msg.error = data?.message ?? 'The assistant could not answer.';
          break;
        case 'done':
          if (msg.status !== 'error') msg.status = 'done';
          break;
        default:
          break;
      }
    },
    streamEnded(state, action) {
      const { key, id, stopped = false } = action.payload;
      const thread = state.threads[key];
      if (!thread) return;
      thread.busy = false;
      const msg = assistantMessage(thread, id);
      if (!msg) return;
      if (msg.status === 'pending' || msg.status === 'streaming') {
        if (msg.text && !stopped) msg.status = 'done';
        else {
          msg.status = 'error';
          msg.error = stopped ? 'Stopped.' : 'The answer was cut off. Try again.';
        }
      }
      msg.statusText = null;
      for (const step of msg.steps) {
        if (step.state !== 'start') continue;
        if (stopped) {
          step.state = 'done';
          step.detail = 'stopped';
        } else step.state = msg.status === 'error' ? 'error' : 'done';
      }
    },
  },
  extraReducers: (builder) => {
    // Picking a part on the model asks for the inspector, which the report covers.
    builder.addCase(selectMesh, (state) => {
      state.openReportId = null;
    });
  },
});

export const {
  twinOpened,
  twinClosed,
  alertReceived,
  alertDismissed,
  reportOpened,
  reportClosed,
  pointerSet,
  pointerCleared,
  chatToggled,
  threadSelected,
  threadHydrated,
  threadReset,
  userAsked,
  streamEvent,
  streamEnded,
} = agentSlice.actions;

let nextId = 1;
/** The answer streaming in each scope, so Stop can cancel it. */
const running = new Map();

/** Stop the answer being written in a scope. @param {string} key */
export function stopAssistant(key) {
  running.get(key)?.abort();
}

/**
 * Ask the assistant one question and stream the answer into the thread.
 *
 * @param {object} args
 * @param {string} args.key - Scope key (`plant` or `twin-<assetId>`).
 * @param {string} args.threadId
 * @param {string} args.message
 * @param {object} args.context - Scope, asset, selected part, open panel.
 * @param {string|null} args.scopeName - Shown with the question.
 * @param {string|null} args.partLabel - Shown with the question.
 */
export const askAssistant =
  ({ key, threadId, message, context, scopeName, partLabel }) =>
  async (dispatch) => {
    const id = `m${Date.now().toString(36)}${nextId}`;
    nextId += 1;
    dispatch(userAsked({ key, threadId, id, text: message, scopeName, partLabel }));
    const controller = new AbortController();
    running.set(key, controller);
    try {
      const res = await fetch('/api/v1/assistant/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ message, threadId, sessionId: getSessionId(), context }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        dispatch(streamEvent({ key, id, event: 'error', data: { message: body.message ?? `The API answered ${res.status}.` } }));
      } else {
        await readSse(res, (e) => dispatch(streamEvent({ key, id, event: e.event, data: e.data })));
      }
    } catch {
      if (!controller.signal.aborted) {
        dispatch(streamEvent({ key, id, event: 'error', data: { message: 'Cannot reach the API. Is the server running?' } }));
      }
    } finally {
      if (running.get(key) === controller) running.delete(key);
      dispatch(streamEnded({ key, id, stopped: controller.signal.aborted }));
    }
  };

/* ── Selectors ───────────────────────────────────────────────────────────── */

/** @param {{agent: typeof initialState}} state */
export const selectAgent = (state) => state.agent;
/** @param {{agent: typeof initialState}} state */
export const selectChatOpen = (state) => state.agent.chatOpen;
/** @param {{agent: typeof initialState}} state */
export const selectOpenReportId = (state) => state.agent.openReportId;
/** @param {{agent: typeof initialState}} state */
export const selectPointer = (state) => state.agent.pointer;
/** @param {{agent: typeof initialState}} state @param {string} key */
export const selectThread = (state, key) => state.agent.threads[key];

export default agentSlice.reducer;
