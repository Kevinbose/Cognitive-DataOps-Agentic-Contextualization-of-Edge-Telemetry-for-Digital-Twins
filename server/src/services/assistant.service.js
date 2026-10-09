/**
 * @file The browser's assistant chat, proxied to the agent as a stream.
 *
 * The browser posts to this API; this service checks the twin, adds what the
 * server knows (the twin's real name), adds the service key, and relays the
 * agent's server-sent events unchanged. The agent's address and key never
 * reach the browser. A per-session limit stops a stuck key from burning the
 * model quota. When the agent is down, the stream ends with one readable
 * `error` event instead of a hung request.
 *
 * @module services/assistant.service
 */

import { Asset } from '../models/Asset.model.js';
import { agentHealth, getThread, openChatStream } from './agentClient.service.js';
import { getAnomalyStats } from './anomaly.service.js';

const MESSAGES_PER_MINUTE = 12;
/** @type {Map<string, number[]>} */
const recent = new Map();

/**
 * @typedef {object} SseSink
 * @property {(status: number) => void} open - Send status and SSE headers.
 * @property {(text: string) => void} write - Write raw SSE text.
 * @property {() => void} close - End the response.
 * @property {AbortSignal} signal - Aborted when the browser goes away.
 */

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function allowed(sessionId) {
  const now = Date.now();
  const list = (recent.get(sessionId) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= MESSAGES_PER_MINUTE) {
    recent.set(sessionId, list);
    return false;
  }
  list.push(now);
  recent.set(sessionId, list);
  return true;
}

/**
 * Relay one chat turn.
 *
 * @param {{message: string, threadId: string, sessionId: string, context: object}} request
 * @param {SseSink} sink
 * @returns {Promise<void>}
 */
export async function streamChat(request, sink) {
  if (!allowed(request.sessionId)) {
    sink.open(200);
    sink.write(sse('error', { message: `Slow down: at most ${MESSAGES_PER_MINUTE} questions a minute.` }));
    sink.close();
    return;
  }

  const context = { ...request.context };
  if (context.scope === 'twin') {
    const asset = await Asset.findOne({ _id: context.assetId, isDeleted: false }).select('name').lean();
    if (!asset) {
      sink.open(200);
      sink.write(sse('error', { message: 'This twin no longer exists.' }));
      sink.close();
      return;
    }
    context.assetName = asset.name;
  }

  let upstream;
  try {
    upstream = await openChatStream({ ...request, context }, sink.signal);
  } catch (error) {
    sink.open(200);
    sink.write(sse('error', {
      message: 'The assistant service is not running. Start it with: npm run agent',
      detail: error.message,
    }));
    sink.close();
    return;
  }

  if (!upstream.ok || !upstream.body) {
    sink.open(200);
    sink.write(sse('error', { message: `The assistant service answered ${upstream.status}.` }));
    sink.close();
    return;
  }

  sink.open(200);
  const decoder = new TextDecoder();
  try {
    for await (const chunk of upstream.body) {
      sink.write(decoder.decode(chunk, { stream: true }));
    }
  } catch (error) {
    if (!sink.signal.aborted) sink.write(sse('error', { message: 'The assistant stream was interrupted.', detail: error.message }));
  }
  sink.close();
}

/**
 * Stored conversation for a thread (display copy for the widget after reload).
 *
 * @param {string} threadId
 */
export async function getConversation(threadId) {
  try {
    return (await getThread(threadId)) ?? { threadId, messages: [] };
  } catch {
    return { threadId, messages: [] };
  }
}

/** Agent reachability plus detector counters, for the widget's status line. */
export async function getAgentStatus() {
  const health = await agentHealth();
  return { agent: health, detector: getAnomalyStats() };
}

export function resetAssistantForTests() {
  recent.clear();
}

export default { streamChat, getConversation, getAgentStatus, resetAssistantForTests };
