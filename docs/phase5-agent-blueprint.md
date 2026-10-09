# Phase 5: the diagnosis agent

The agentic layer is built. It is a **Python service** (`services/agent/`, FastAPI on port 8100) that diagnoses machine faults and answers questions about the plant, and a **Node side** that gives it data and carries its results to the browser. This document describes what runs, why it is shaped this way, and how to check it.

## 1. What it does

- **Proactive diagnosis.** When a press or robot channel crosses a limit, or drifts away from its learned baseline while still inside the limits, an investigation opens. The agent reads the machine, scores the fault signatures the machine manuals define, retrieves the supporting manual pages, and publishes a cited report. The twin shows "Critical anomaly detected" (or "Anomaly detected"), and the report names and lights the failing parts on the 3D model.
- **Conversation.** A chat widget on every page. On a twin's pages it is scoped to that twin and its selected part, and can point at parts of the model. Everywhere else it covers the whole plant. Each scope keeps its own conversation.

## 2. Where everything runs

```
browser ── /api/v1, socket.io ──> Node API (5000) ──── MCP, bearer key ────> Python agent (8100)
                                    │  detector                                │ LangGraph lanes
                                    │  reports, investigations                 │ features and fault scoring
                                    │  chat relay (SSE)  <──── /v1/chat SSE ───│ RAG/ module (in process)
                                    │                    ──── /v1/investigations ──>
                                    └─ MongoDB, MQTT                            └─ Gemini (optional)
```

| Piece | Where | Job |
|---|---|---|
| Anomaly detector | `server/src/services/anomaly.service.js` | Threshold rule (10 s mean past a limit for `ANOMALY_HOLD_SEC`) and drift rule (60 s mean `ANOMALY_DRIFT_SIGMA` deviations from the learned baseline). One investigation per machine, escalation, cooldown, resolution after a healthy minute. No model. |
| MCP server | `server/src/mcp/` at `POST /mcp` | 16 read and point tools for the agent (catalogue, live values, raw windows, history, spectrum, bindings, part search, reports, `emit_ui_command`, `post_diagnostic_report`). Nothing that can act on a machine. |
| Reports and chat relay | `server/src/services/investigation.service.js`, `assistant.service.js` | Store reports, raise `agent:alert`, relay chat events to the browser. The browser never sees the agent or its key. |
| The agent | `services/agent/cdo_agent/` | Both lanes, below. |
| Knowledge | `RAG/` (the RAG module) | Hybrid retrieval (dense plus BM25, stage-aware context) over the five documents per machine. |
| Widget, banners, report panel | `client/src/features/agent/` | Scoped chat, anomaly notices, report in the inspector column, the agent pointing at parts. |

The service key is created by Node at start-up in `storage/.agent/service.key` (or set with `AGENT_SERVICE_KEY`); the agent reads the same file.

## 3. The diagnose lane

A LangGraph pipeline (`investigate.py`), every step guarded so a failure ends in a recorded `failed` investigation rather than silence:

1. **gather**: over MCP, the machine's catalogue entry, two minutes of raw samples per channel (`get_raw_window`; one-second buckets would average away the robot's 0.75 Hz ripple), learned baselines, data age, three spectrum frames, the twin's bindings.
2. **analyse**: the features exactly as the diagnostic procedures define them (`features.py`). Press: P60, V60, I60, Ipk, HB300, PMR300, the five defect lines, dI/dV, severity estimates. Robot: cycle mean and shift, A6 (sixth harmonic), 1X swing, same-phase noise, TCP shift and the three gearbox-wear consistency ratios. Then the documented discriminator tables become tests (`diagnosis.py`): each names the faults it supports and contradicts, and a fault is ranked only if an abnormal observation points to it. Faults the manuals mark as simulated carry a small prior.
3. **retrieve**: two queries to the RAG module, restricted to the machine: the root cause's signature and procedure, and its corrective action. Hybrid retrieval when a Gemini key is set, BM25 otherwise, so a report always has citations.
4. **ground**: the root cause's component becomes mesh names through the part tags in the twin's model (`lube_filter`, `main_bearing_housing`, `axis_4_motor`), then the operator's bindings. Node checks every name again before anything is drawn.
5. **write**: the root cause, confidence, alternatives, evidence table and actions are decided by code. Gemini may only word the headline, summary and steps, and its text is kept only if it names the root cause, cites only retrieved sources and introduces no number that is not in the facts. Otherwise template wording is used (`report.py`).
6. **publish**: `post_diagnostic_report`. Node stores it, closes the investigation's analysis and raises the alert.

Investigations run one at a time. Every minute the agent also picks up investigations opened while it was down.

## 4. The converse lane

One LangGraph node per chat turn (`chat.py`) with a SQLite checkpointer holding each thread:

1. Pack the scope: for a twin, its machines, live readings, open investigations, recent reports and the selected part; for the plant, every twin.
2. Answer with Gemini and a tool loop (at most `AGENT_MAX_TOOL_ROUNDS`): live values, history, features, reports, manual search, an on-demand diagnosis, part search and pointing. In twin scope the twin id and the browser session are injected, so the model cannot point at another twin or another person's screen.
3. Without a key, with the quota spent, or on any model error, a rule-based answerer uses the same tools: part descriptions, status, "show me", diagnosis, reports, and extractive answers from the manuals (table rows come back with their column headers).

Events stream as `step`, `token`, `citations`, `meta`, then `done` or `error`. A `step` is sent when the agent starts something and again, with the same id, when it ends: reading the twin, each Gemini round (and what it asked for), each tool with what it looked at and what came back, the manual pages it read, quota waits, the fallback to rules, and writing the answer. The widget shows them as a collapsed live line that opens into a progress tracker, and they are stored with the answer. When the model opens a stored report, the report's sources are renumbered into the answer's source list so its `[S1]` references stay valid.

In twin scope the machines on the twin come from the device registry, and the prompt states them explicitly (including "this twin has no machines"). Tools refuse a machine that is not on the twin, so the model cannot describe another twin's machines as bound here. Machines are matched by catalogue label and type, and fault knowledge is keyed by machine type, so a new machine of a known type needs no code change.

## 5. Gemini, quota and keys

- The key lives in `RAG/.env` (`GEMINI_API_KEY`), the RAG module's own file. Never commit it.
- The model is `gemini-3.5-flash-lite`; this project's key allows 5 requests and 250k tokens a minute. The agent sets those limits on the RAG module's shared limiter (`AGENT_GEMINI_RPM`, `AGENT_GEMINI_TPM`), and the RAG module's own defaults match. A chat turn that would wait for quota shows the wait as a step; past `AGENT_QUOTA_WAIT_SEC` (30 s) it answers from the rules instead. Tool rounds per turn: 4.
- Every request goes through the RAG module's rate limiter and usage log, so the agent and the RAG scripts share one quota. The agent never retries a 429 in a chat turn: it answers from the rules and marks the model degraded for a few minutes.
- `AGENT_LLM=off` forces the offline mode.

## 6. Ground truth

The simulator's active scenario (`diag.sim`) is not reachable through any MCP tool or agent endpoint. Tests assert that the agent's reads never ask for it and that nothing it publishes carries it.

## 7. Running it

```bash
npm run agent:setup     # once: services/agent/.venv and its requirements
npm run dev             # API and client
npm run agent           # the agent on 127.0.0.1:8100
npm run agent:test      # the agent's tests (pytest)
```

On Windows, `requirements.txt` pins `orjson` 3.11.9 and `faiss-cpu` 1.14.3: Smart App Control blocked newer builds of both as unknown native code. `tzdata` is required for the RAG module's time zone on Windows.

## 8. Verification

| Check | Result |
|---|---|
| Agent tests (`npm run agent:test`) | Features against windows generated by the simulator's own models, fault scoring at three severities per fault, the full pipeline against a fake Node and the real RAG index, chat lanes, HTTP surface |
| Server tests | MCP tools, auth, report publishing, detector rules |
| Client tests | Event-stream parser, thread reducer, the agent's commands reaching only their twin, camera move math |
| Live run | Clog injected with the simulator: report F01 CLOGGED_FILTER at 85 percent in 46 s, six manual citations, the lube filter and lubrication unit lit on the factory model; chat answered in both scopes with and without Gemini |
