/**
 * @file Calls from this API to the diagnosis agent (services/agent).
 *
 * The browser never talks to the agent: Node adds the service key and
 * forwards. A small circuit breaker stops hammering an agent that is down,
 * so the detector degrades to "analysis unavailable" instantly instead of
 * waiting on a timeout for every anomaly.
 *
 * @module services/agentClient.service
 */

import { config } from '../config/env.config.js';
import { getServiceKey } from './agentKey.service.js';

const breaker = { failures: 0, openUntil: 0 };
/** Starts from configuration; tests point it at a fake agent. */
let baseUrl = config.agent.url;
const FAILURES_TO_OPEN = 3;
const OPEN_MS = 30_000;

function headers() {
  return { 'content-type': 'application/json', authorization: `Bearer ${getServiceKey()}` };
}

function noteFailure() {
  breaker.failures += 1;
  if (breaker.failures >= FAILURES_TO_OPEN) breaker.openUntil = Date.now() + OPEN_MS;
}

function noteSuccess() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

/** Whether calls are currently being attempted. */
export function agentAvailable() {
  return config.agent.enabled && Date.now() >= breaker.openUntil;
}

/**
 * Hand an investigation to the agent. Resolves true when it was accepted.
 *
 * @param {object} investigation - Public investigation view.
 * @returns {Promise<{accepted: boolean, error?: string}>}
 */
export async function requestInvestigation(investigation) {
  if (!config.agent.enabled) return { accepted: false, error: 'agent disabled (AGENT_ENABLED=false)' };
  if (!agentAvailable()) return { accepted: false, error: 'agent unreachable (circuit open)' };
  try {
    const res = await fetch(`${baseUrl}/v1/investigations`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        investigationId: investigation.id,
        machineId: investigation.machineId,
        assetId: investigation.assetId,
        sensorId: investigation.sensorId,
        channelKey: investigation.channelKey,
        kind: investigation.kind,
        severity: investigation.severity,
        openedAt: investigation.openedAt,
        trigger: investigation.trigger,
      }),
      signal: AbortSignal.timeout(config.agent.requestTimeoutMs),
    });
    if (res.status === 202 || res.ok) {
      noteSuccess();
      return { accepted: true };
    }
    noteFailure();
    return { accepted: false, error: `agent answered ${res.status}` };
  } catch (error) {
    noteFailure();
    return { accepted: false, error: `agent unreachable: ${error.message}` };
  }
}

/**
 * Agent health, for /health and the assistant's status line.
 *
 * @returns {Promise<{reachable: boolean, llm?: string, rag?: string, error?: string}>}
 */
export async function agentHealth() {
  if (!config.agent.enabled) return { reachable: false, error: 'disabled' };
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
    const body = await res.json();
    noteSuccess();
    return { reachable: true, ...body };
  } catch (error) {
    return { reachable: false, error: error.message };
  }
}

/**
 * Open the agent's streaming chat endpoint. The caller pipes the body.
 *
 * @param {object} body - Chat request (message, thread, ui context).
 * @param {AbortSignal} signal - Aborted when the browser disconnects.
 * @returns {Promise<Response>}
 */
export async function openChatStream(body, signal) {
  const res = await fetch(`${baseUrl}/v1/chat`, {
    method: 'POST',
    headers: { ...headers(), accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (res.ok) noteSuccess();
  else noteFailure();
  return res;
}

/**
 * Fetch a stored conversation from the agent's checkpointer.
 *
 * @param {string} threadId
 */
export async function getThread(threadId) {
  const res = await fetch(`${baseUrl}/v1/threads/${encodeURIComponent(threadId)}`, {
    headers: headers(),
    signal: AbortSignal.timeout(config.agent.requestTimeoutMs),
  });
  if (!res.ok) return null;
  return res.json();
}

export function setAgentUrlForTests(url) {
  baseUrl = url.replace(/\/+$/, '');
}

export function resetAgentClientForTests() {
  breaker.failures = 0;
  breaker.openUntil = 0;
}

export default { requestInvestigation, agentHealth, openChatStream, getThread, agentAvailable, resetAgentClientForTests };
