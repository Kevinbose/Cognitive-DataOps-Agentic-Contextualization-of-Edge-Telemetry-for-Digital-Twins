"""The converse lane: the chat widget's questions, in plant scope or twin scope.

One LangGraph node per turn, with a SQLite checkpointer holding each thread's
transcript. The node first packs the scope into context (the twin's machines,
live readings, open investigations, the selected part), then answers:

- with Gemini and a small tool set when a key is configured and quota is left;
- otherwise with a rule-based answerer over the same tools and the manuals.

Events go to the browser as server-sent events through the Node API: `step`
(one per thing the agent does: reading the twin, each model round, each tool
with what it read, quota waits, the fallback), `token`, `citations`, `meta`,
then `done` (or `error`). A step is sent when it starts and again when it
ends, with the same id, so the browser can show a live progress tracker.
Pointing at parts happens through the `emit_ui_command` MCP tool, which the
Node API sends to this browser session only.

In twin scope the twin's own machines (from the device registry) are the only
machines the answer may describe as on the twin; tools refuse the others.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import operator
import re
import time
from dataclasses import dataclass, field
from typing import Annotated, Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.config import get_stream_writer
from langgraph.graph import END, START, StateGraph

from . import knowledge as K
from .diagnosis import Diagnosis, short_name
from .investigate import analyse, gather
from .mcp_client import ToolError, ToolSession
from .rag_bridge import Evidence, Knowledge
from .report import clean_text, pct, split_refs

log = logging.getLogger("cdo_agent.chat")
HISTORY_TURNS = 8


class ChatState(TypedDict, total=False):
    messages: Annotated[list[dict], operator.add]
    request: dict


@dataclass
class Turn:
    """What one answer collected on its way."""
    text: str = ""
    citations: list[Evidence] = field(default_factory=list)
    degraded: bool = False
    model: str | None = None
    tools: list[str] = field(default_factory=list)
    labels: dict[str, str] = field(default_factory=dict)   # mesh name to part label, from find_meshes
    steps: list[dict] = field(default_factory=list)
    writer: Any = None

    def step(self, label: str, *, kind: str = "tool", detail: str | None = None, state: str = "start",
             sources: list[dict] | None = None, sid: str | None = None) -> str:
        """Start a step, or update the one with `sid`, and stream it."""
        s = next((x for x in self.steps if x["id"] == sid), None) if sid else None
        if s is None:
            s = {"id": f"s{len(self.steps) + 1}", "kind": kind, "label": label, "detail": detail,
                 "state": state, "sources": sources or [], "at": round(time.time(), 3)}
            self.steps.append(s)
        else:
            s.update(label=label, state=state)
            if detail is not None:
                s["detail"] = detail
            if sources is not None:
                s["sources"] = sources
            s["ms"] = int((time.time() - s["at"]) * 1000)
        if self.writer:
            self.writer({"event": "step", "data": dict(s)})
        return s["id"]

    def finish(self, sid: str, detail: str | None = None, *, state: str = "done",
               sources: list[dict] | None = None) -> None:
        s = next((x for x in self.steps if x["id"] == sid), None)
        if s:
            self.step(s["label"], sid=sid, detail=detail, state=state, sources=sources)

    def cite(self, items: list[Evidence]) -> list[Evidence]:
        """Add sources, renumbered after the ones already held, and return them."""
        out = []
        for e in items:
            known = next((c for c in self.citations if c.chunk_id == e.chunk_id), None)
            if known:
                out.append(known)
                continue
            e.ref = f"S{len(self.citations) + 1}"
            self.citations.append(e)
            out.append(e)
        return out


def _deps(config: RunnableConfig) -> tuple[ToolSession, Knowledge, int]:
    c = config["configurable"]
    return c["tools"], c["knowledge"], c.get("max_tool_rounds", 6)


# --- scope context -----------------------------------------------------------

def _machine_view(m: dict) -> dict:
    return {"machineId": m["machineId"], "label": m.get("label"), "machineType": m.get("machineType"),
            "state": m.get("state"), "channels": [c.get("key") for c in m.get("channels", [])]}


async def scope_snapshot(tools: ToolSession, ctx: dict) -> dict:
    """The facts every answer starts from, fetched once per turn.

    Machines come from the device registry: a machine is on a twin only when
    someone added it there. The rest of the plant's gateways are listed apart,
    so neither the model nor the rules can mistake them for the twin's.
    """
    catalog = await tools.call("get_device_catalog", {}) or []
    twins = await tools.call("list_twins", {})
    snap: dict[str, Any] = {"scope": ctx.get("scope", "plant")}
    if ctx.get("scope") == "twin":
        aid = ctx["assetId"]
        twin = next((t for t in twins or [] if t["assetId"] == aid), None)
        on_twin = [_machine_view(m) for m in catalog if m.get("assetId") == aid]
        snap["twin"] = {"assetId": aid, "name": ctx.get("assetName") or (twin or {}).get("name"),
                        "machines": on_twin, "machineCount": len(on_twin)}
        snap["availableToAdd"] = [_machine_view(m) for m in catalog if not m.get("assetId") and m.get("state") == "online"]
        readings = []
        for m in snap["twin"]["machines"]:
            for s in await tools.call("get_latest_telemetry", {"machineId": m["machineId"]}) or []:
                readings.append({k: s.get(k) for k in ("sensorId", "channelKey", "value", "unit", "status", "meshName", "ageMs")})
        snap["readings"] = readings
        snap["openInvestigations"] = await tools.call("get_active_anomalies", {"assetId": aid})
        snap["recentReports"] = await tools.call("list_reports", {"assetId": aid, "limit": 3})
        for key in ("selectedMesh", "hoveredMesh"):
            if ctx.get(key):
                try:
                    snap[key] = await tools.call("get_mesh_context", {"assetId": aid, "meshName": ctx[key]})
                except ToolError:
                    snap[key] = {"meshName": ctx[key], "exists": False}
    else:
        snap["twins"] = twins
        snap["machines"] = [{**_machine_view(m), "assetId": m.get("assetId")} for m in catalog]
        snap["openInvestigations"] = await tools.call("get_active_anomalies", {})
        snap["recentReports"] = await tools.call("list_reports", {"limit": 3})
    return snap


def machine_pool(snap: dict) -> list[dict]:
    """The machines a question in this scope may be about."""
    return snap["twin"]["machines"] if snap.get("twin") else snap.get("machines") or []


def machines_in_scope(snap: dict) -> list[str]:
    return [m["machineId"] for m in machine_pool(snap)]


def machine_named(snap: dict, machine_id: str | None) -> dict | None:
    return next((m for m in machine_pool(snap) if m["machineId"] == machine_id), None)


def pick_machine(message: str, snap: dict) -> str | None:
    """The machine a question is about: named (id or label), its type's words,
    the selected part's owner, the one under investigation, or the only one."""
    text = message.lower()
    pool = machine_pool(snap)
    for m in pool:
        if m["machineId"] in text:
            return m["machineId"]
    # words of the catalogue label, e.g. "stamping press 01"
    scored = []
    for m in pool:
        words = {w for w in re.findall(r"[a-z]+", (m.get("label") or "").lower()) if len(w) > 3}
        hits = sum(1 for w in words if w in text)
        if hits:
            scored.append((hits, m["machineId"]))
    scored.sort(reverse=True)
    if scored and (len(scored) == 1 or scored[0][0] > scored[1][0]):
        return scored[0][1]
    kind = K.type_from_words(message)
    of_kind = [m["machineId"] for m in pool if m.get("machineType") == kind]
    if len(of_kind) == 1:
        return of_kind[0]
    owner = ((snap.get("selectedMesh") or {}).get("machine") or {}).get("machineId")
    if owner in [m["machineId"] for m in pool]:
        return owner
    open_ = [i["machineId"] for i in snap.get("openInvestigations") or [] if i.get("machineId") in machines_in_scope(snap)]
    if open_:
        return open_[0]
    return pool[0]["machineId"] if len(pool) == 1 else None


# --- the shared actions (used by the model's tools and by the rules) ------

async def point_at(tools: ToolSession, ctx: dict, meshes: list[str], action: str = "highlight",
                   label: str | None = None) -> dict:
    if ctx.get("scope") != "twin":
        return {"accepted": [], "rejected": [{"reason": "open a twin to point at its parts"}]}
    cmds: list[dict] = []
    if action == "clear":
        cmds.append({"type": "clear_highlights"})
    for i, m in enumerate(meshes[:4]):
        if action in ("highlight", "focus"):
            cmd = {"type": "highlight", "meshName": m, "tone": "agent", "pulse": True, "durationMs": 20000}
            if label and i == 0:
                cmd["label"] = label[:80]
            cmds.append(cmd)
        if action == "focus" or (action == "highlight" and i == 0):
            cmds.append({"type": "camera_focus", "meshName": m})
        if action == "select":
            cmds.append({"type": "select_mesh", "meshName": m})
    if not cmds:
        return {"accepted": [], "rejected": []}
    args = {"assetId": ctx["assetId"], "commands": cmds[:6]}
    if ctx.get("sessionId"):
        args["sessionId"] = ctx["sessionId"]
    return await tools.call("emit_ui_command", args)


async def quick_diagnosis(tools: ToolSession, machine_id: str) -> Diagnosis | None:
    cfg = {"configurable": {"tools": tools}}
    state = await gather({"investigation": {"machineId": machine_id, "assetId": None}}, cfg)
    if state.get("error"):
        return None
    state = await analyse(state, cfg)
    return state.get("diagnosis")


def diagnosis_brief(d: Diagnosis) -> dict:
    root = d.root
    return {
        "machineId": d.machine_id, "machine": d.name, "level": d.level, "levelReasons": d.level_reasons,
        "rootCause": {"id": root.id, "code": root.code, "name": root.name, "confidence": root.confidence} if root else None,
        "alternatives": [{"id": h.id, "name": h.name, "confidence": h.confidence} for h in d.ranked[1:3]],
        "evidence": d.evidence_rows(6),
    }


def evidence_view(items: list[Evidence]) -> list[dict]:
    return [{"ref": e.ref, "document": e.document, "section": e.section, "page": e.page, "text": e.excerpt(600)}
            for e in items]


# --- the model path ----------------------------------------------------------

SYSTEM = """You are the plant assistant inside a digital twin of a car factory.
Scope: {scope}.
{machines_rule}
Answer from the context and the tools only. Live values come from tools, document facts from search_manuals.
Cite manual facts inline as [S1] with the refs search_manuals returned. Never invent a number, limit or part name.
Keep answers short: at most six sentences or a short list. Sentence case, units on every number. No em dashes, no emojis.
{pointing}
Fault reports come from the diagnosis pipeline; use diagnose_machine for a fresh assessment and say how confident it is.
If the data cannot answer the question, say what is missing."""

POINT_TWIN = ("To show a part, find it with find_meshes, then call point_at_parts with the exact mesh names. "
              "When the user says 'this', they mean the selected part in the context.")
POINT_PLANT = "No twin is open, so you cannot point at parts. Name the twin to open instead."


def machines_rule(snap: dict) -> str:
    """The one fact the model got wrong before: which machines are on this twin."""
    if not snap.get("twin"):
        return "Machines and the twin each belongs to are listed in the context under machines (assetId null: on no twin)."
    t = snap["twin"]
    if not t["machines"]:
        return ("This twin has NO machines added. Never say a machine is bound to it or running on it. "
                "Gateways in availableToAdd are online and could be added in the Machines tab.")
    names = ", ".join(f"{m.get('label') or m['machineId']} ({m['machineId']}, {m.get('state')})" for m in t["machines"])
    return (f"Machines on this twin: {names}. Only these belong to it; any other gateway is not on this twin. "
            "Machines in availableToAdd are online and could be added in the Machines tab.")


def declarations(scope: str, doc_machines: list[str] | None = None) -> list[dict]:
    S = lambda props, req=(): {"type": "object", "properties": props, "required": list(req)}  # noqa: E731
    d = [
        {"name": "get_latest_telemetry", "description": "Newest reading, status and bound mesh of each channel of a machine.",
         "parameters": S({"machineId": {"type": "string"}}, ["machineId"])},
        {"name": "get_historical_telemetry", "description": "Trend of one channel: mean, min, max, slope per minute over the last N minutes.",
         "parameters": S({"sensorId": {"type": "string"}, "minutes": {"type": "integer"}}, ["sensorId"])},
        {"name": "get_channel_features", "description": "Detector view of a channel: 10 s and 60 s means, learned baseline, z-score, limits.",
         "parameters": S({"sensorId": {"type": "string"}}, ["sensorId"])},
        {"name": "get_active_anomalies", "description": "Open investigations with trigger values and report ids.", "parameters": S({})},
        {"name": "list_reports", "description": "Recent diagnostic reports, newest first.",
         "parameters": S({"machineId": {"type": "string"}})},
        {"name": "get_diagnostic_report", "description": "One report in full: root cause, evidence, actions, citations.",
         "parameters": S({"reportId": {"type": "string"}}, ["reportId"])},
        {"name": "get_device_catalog", "description": "Machines with channels, units and limits.",
         "parameters": S({"machineId": {"type": "string"}})},
        {"name": "search_manuals", "description": "Search the machine manuals (limits, fault signatures, procedures, maintenance, cases). Returns excerpts with refs to cite. machineId is any machine; its type's manuals are searched.",
         "parameters": S({"query": {"type": "string"},
                          "machineId": {"type": "string", **({"description": "Manuals exist for: " + ", ".join(doc_machines)} if doc_machines else {})}},
                         ["query", "machineId"])},
        {"name": "diagnose_machine", "description": "Run the documented fault-signature diagnosis on a machine's live data now. Returns level, root cause with confidence, alternatives and evidence.",
         "parameters": S({"machineId": {"type": "string"}}, ["machineId"])},
    ]
    if scope == "twin":
        d += [
            {"name": "find_meshes", "description": "Find parts of the open twin by words, for example 'lube filter' or 'axis 4'. Returns real mesh names.",
             "parameters": S({"query": {"type": "string"}}, ["query"])},
            {"name": "get_mesh_context", "description": "What one part of the open twin is: label, bound sensor, latest reading, limits.",
             "parameters": S({"meshName": {"type": "string"}}, ["meshName"])},
            {"name": "get_mesh_bindings", "description": "Which sensor drives which mesh on the open twin.", "parameters": S({})},
            {"name": "point_at_parts", "description": "Highlight, focus the camera on, or select parts of the open twin, or clear highlights.",
             "parameters": S({"action": {"type": "string", "enum": ["highlight", "focus", "select", "clear"]},
                              "meshNames": {"type": "array", "items": {"type": "string"}},
                              "label": {"type": "string"}}, ["action"])},
            {"name": "open_report", "description": "Open a diagnostic report in the twin's report panel.",
             "parameters": S({"reportId": {"type": "string"}}, ["reportId"])},
        ]
    else:
        d.append({"name": "list_twins", "description": "Every twin with its machines and open investigations.", "parameters": S({})})
    return d


TOOL_LABELS = {
    "get_latest_telemetry": "Reading live values", "get_historical_telemetry": "Reading the trend",
    "get_channel_features": "Checking the baseline", "get_active_anomalies": "Checking open investigations",
    "list_reports": "Looking up reports", "get_diagnostic_report": "Opening the report",
    "get_device_catalog": "Reading the catalogue", "search_manuals": "Searching the manuals",
    "diagnose_machine": "Running the diagnosis", "find_meshes": "Finding the part",
    "get_mesh_context": "Reading the part", "get_mesh_bindings": "Reading the bindings",
    "point_at_parts": "Pointing at the twin", "open_report": "Opening the report", "list_twins": "Listing twins",
}


MACHINE_TOOLS = {"get_latest_telemetry", "get_device_catalog", "diagnose_machine", "list_reports"}
SENSOR_TOOLS = {"get_historical_telemetry", "get_channel_features"}


def _off_twin(name: str, args: dict, ctx: dict) -> str | None:
    """In twin scope, the machine a tool call names must be on the twin."""
    allowed = ctx.get("machinesOnTwin")
    if ctx.get("scope") != "twin" or allowed is None:
        return None
    mid = args.get("machineId")
    if name in SENSOR_TOOLS and args.get("sensorId"):
        mid = str(args["sensorId"]).split(".")[0].lower()
    if (name in MACHINE_TOOLS or name in SENSOR_TOOLS) and mid and mid not in allowed:
        on = ", ".join(sorted(allowed)) or "none"
        return f"{mid} is not on this twin. Machines on this twin: {on}."
    return None


async def run_tool(name: str, args: dict, *, tools: ToolSession, knowledge: Knowledge, ctx: dict, turn: Turn) -> Any:
    aid = ctx.get("assetId")
    refused = _off_twin(name, args, ctx)
    if refused:
        return {"error": refused}
    if name == "search_manuals":
        mid = args.get("machineId")
        kind = (ctx.get("machineTypes") or {}).get(mid) or K.type_from_words(f"{mid} {args.get('query', '')}")
        hits, _ = await asyncio.to_thread(knowledge.retrieve, str(args.get("query", ""))[:300],
                                          knowledge.doc_machine(mid, kind), None, 4)
        return {"results": evidence_view(turn.cite(hits))}
    if name == "diagnose_machine":
        d = await quick_diagnosis(tools, str(args.get("machineId", "")))
        return diagnosis_brief(d) if d else {"error": "not enough live data to diagnose this machine"}
    if name == "get_device_catalog" and ctx.get("scope") == "twin" and not args.get("machineId"):
        everything = await tools.call(name, args) or []
        allowed = ctx.get("machinesOnTwin") or set()
        return {"onThisTwin": [m for m in everything if m.get("machineId") in allowed],
                "note": "Only the machines under onThisTwin are on this twin."}
    if name == "point_at_parts":
        meshes = [str(m) for m in args.get("meshNames") or []]
        # The twin says in words what is lit; fall back to the part's own label.
        label = args.get("label") or (turn.labels.get(meshes[0], meshes[0]) if meshes else None)
        return await point_at(tools, ctx, meshes, str(args.get("action", "highlight")), label)
    if name == "open_report":
        if ctx.get("scope") != "twin":
            return {"error": "open a twin first"}
        cmd = {"assetId": aid, "commands": [{"type": "open_report", "reportId": str(args.get("reportId"))}]}
        if ctx.get("sessionId"):
            cmd["sessionId"] = ctx["sessionId"]
        return await tools.call("emit_ui_command", cmd)
    if name in ("find_meshes", "get_mesh_context", "get_mesh_bindings"):
        if ctx.get("scope") != "twin":
            return {"error": "open a twin first"}
        args = {**args, "assetId": aid}
    if name == "list_reports" and aid:
        args = {**args, "assetId": aid}
    if name == "get_active_anomalies" and aid:
        args = {"assetId": aid}
    result = await tools.call(name, args)
    if name == "find_meshes":
        turn.labels.update({r["meshName"]: r["label"] for r in result or [] if r.get("label")})
    if name == "get_diagnostic_report" and isinstance(result, dict) and result.get("citations"):
        result = adopt_report_sources(result, turn)
    return result


def adopt_report_sources(report: dict, turn: Turn) -> dict:
    """Make a stored report's sources this answer's sources.

    The report cites its own [S1]..[Sn]; the model copies those references. They
    are renumbered into the turn's list (so they cannot collide with manual
    searches) and rewritten in the summary the model reads.
    """
    olds, evidence = [], []
    for c in report["citations"]:
        olds.append(c.get("ref"))
        evidence.append(Evidence(c.get("ref") or "", c["chunkId"], report.get("machineId") or "", c.get("document") or "",
                                 "", c.get("section") or "", c.get("page"), c.get("filename") or "", "", [], 0.0))
    mapping = {old: e.ref for old, e in zip(olds, turn.cite(evidence)) if old}
    return {
        **report,
        "citations": [{**c, "ref": mapping.get(c.get("ref"), c.get("ref"))} for c in report["citations"]],
        "summary": re.sub(r"\[(S\d{1,2})\]", lambda m: f"[{mapping.get(m.group(1), m.group(1))}]", report.get("summary") or ""),
    }


def _source_view(e: dict | Evidence) -> dict:
    c = e.citation() if isinstance(e, Evidence) else e
    return {"ref": c.get("ref"), "document": c.get("document"), "section": (c.get("section") or "").split(" > ")[-1],
            "page": c.get("page")}


def tool_detail(name: str, args: dict) -> str | None:
    """What a tool is about to look at, for the step line."""
    for key in ("query", "meshName", "sensorId", "machineId", "reportId"):
        if args.get(key):
            return str(args[key])[:120]
    if name == "point_at_parts" and args.get("meshNames"):
        return ", ".join(map(str, args["meshNames"]))[:120]
    return None


def tool_outcome(name: str, result: Any, turn: Turn) -> tuple[str, str, list[dict] | None]:
    """(state, detail, sources) for a finished tool step."""
    if isinstance(result, dict) and result.get("error"):
        return "error", str(result["error"])[:160], None
    try:
        if name == "search_manuals":
            items = result.get("results") or []
            return "done", f"read {len(items)} passage{'s' if len(items) != 1 else ''}", [
                _source_view(next(e for e in turn.citations if e.ref == r["ref"])) for r in items]
        if name == "get_diagnostic_report":
            return "done", (result.get("headline") or "")[:140], [_source_view(c) for c in result.get("citations") or []]
        if name == "diagnose_machine":
            rc = result.get("rootCause")
            return "done", (f"{result.get('machine')}: {rc['id']} {rc['name']} at {pct(rc['confidence'])}" if rc
                            else f"{result.get('machine')}: level {result.get('level')}, no fault signature fits"), None
        if name == "find_meshes":
            labels = [r.get("label") or r["meshName"] for r in (result or [])[:3]]
            return "done", ", ".join(labels) if labels else "no matching part", None
        if name in ("point_at_parts", "open_report"):
            n = len((result or {}).get("accepted") or [])
            return ("done" if n else "error"), (f"{n} command{'s' if n != 1 else ''} sent to the twin" if n
                                                else "the twin refused the parts"), None
        if isinstance(result, list):
            return "done", f"{len(result)} item{'s' if len(result) != 1 else ''}", None
        if isinstance(result, dict) and "onThisTwin" in result:
            return "done", f"{len(result['onThisTwin'])} machine(s) on this twin", None
        if name == "get_historical_telemetry":
            s = (result or {}).get("summary") or {}
            return "done", f"mean {s.get('mean')} {s.get('unit', '')}, slope {s.get('slopePerMin')} a minute".strip(), None
    except Exception:  # a summary must never break an answer
        pass
    return "done", None, None


async def model_answer(message: str, history: list[dict], snap: dict, ctx: dict, *, tools: ToolSession,
                       knowledge: Knowledge, rounds: int, turn: Turn, quota_wait_sec: int = 30) -> str | None:
    from google.genai import types

    scope = (f"twin '{snap['twin']['name']}' (asset {snap['twin']['assetId']})" if snap.get("twin")
             else "the whole plant (no twin is open)")
    system = SYSTEM.format(scope=scope, machines_rule=machines_rule(snap),
                           pointing=POINT_TWIN if ctx.get("scope") == "twin" else POINT_PLANT)
    system += "\n\nContext (live, fetched for this question):\n" + json.dumps(snap, default=str)[:12000]
    contents = []
    for m in history[-HISTORY_TURNS:]:
        contents.append(types.Content(role="user" if m["role"] == "user" else "model", parts=[types.Part(text=m["text"][:2000])]))
    contents.append(types.Content(role="user", parts=[types.Part(text=message)]))
    decls = declarations(ctx.get("scope", "plant"), knowledge.doc_machines)
    # "gemini-3.5-flash-lite" reads as "Gemini 3.5 Flash Lite" in the step list
    model = " ".join(w[:1].upper() + w[1:] for w in (knowledge.model or "the model").split("-"))

    for round_no in range(1, rounds + 1):
        wait = knowledge.quota_wait_seconds()
        if wait > quota_wait_sec:
            turn.step("Model quota is busy", kind="wait", state="error",
                      detail=f"next request in {round(wait)} s, the key allows {knowledge.limits.get('rpm')} a minute")
            return None
        if wait > 0.5:
            wid = turn.step("Waiting for the model quota", kind="wait",
                            detail=f"{round(wait)} s, the key allows {knowledge.limits.get('rpm')} requests a minute")
            await asyncio.sleep(wait)
            turn.finish(wid)
        mid = turn.step(f"Asking {model}", kind="model", detail=f"round {round_no}")
        resp = await asyncio.to_thread(knowledge.chat_step, contents, system, decls)
        cand = (resp.candidates or [None])[0]
        parts = (cand.content.parts if cand and cand.content else None) or []
        calls = [p.function_call for p in parts if getattr(p, "function_call", None)]
        if not calls:
            turn.finish(mid, "wrote the answer")
            return "".join(p.text or "" for p in parts if getattr(p, "text", None) and not getattr(p, "thought", False)).strip()
        turn.finish(mid, "asked for " + ", ".join(TOOL_LABELS.get(c.name, c.name).lower() for c in calls))
        contents.append(cand.content)
        replies = []
        for call in calls:
            name, args = call.name, dict(call.args or {})
            sid = turn.step(TOOL_LABELS.get(name, name), kind="tool", detail=tool_detail(name, args))
            try:
                result = await run_tool(name, args, tools=tools, knowledge=knowledge, ctx=ctx, turn=turn)
            except ToolError as err:
                result = {"error": str(err)[:300]}
            state, detail, sources = tool_outcome(name, result, turn)
            turn.finish(sid, detail, state=state, sources=sources)
            turn.tools.append(name)
            replies.append(types.Part.from_function_response(name=name, response={"result": json.loads(json.dumps(result, default=str))}))
        contents.append(types.Content(role="user", parts=replies))
    return "I gathered the data but ran out of steps before answering. Ask a narrower question."


# --- the rule-based path -----------------------------------------------------

STOP = set("a an the of to in on for and or is are was be at by with from as it this that what which how do does "
           "i my me should would could can if when than then there their its not no show where me please part".split())
R_SHOW = re.compile(r"\b(show|highlight|where|locate|point|focus|zoom|find)\b", re.I)
R_CLEAR = re.compile(r"\b(clear|reset|remove) (the )?(highlights?|markers?)\b", re.I)
R_THIS = re.compile(r"\b(what is this|what's this|this part|selected|what am i looking at|this one)\b", re.I)
R_DIAG = re.compile(r"\b(why|diagnos\w*|root cause|wrong|fault|problem|issue|anomal\w*|cause)\b", re.I)
R_REPORT = re.compile(r"\breports?\b", re.I)
R_STATUS = re.compile(r"\b(how is|how's|how are|status|running|health|overview|summary|doing)\b", re.I)


R_LIMIT = re.compile(r"\b(limit|limits|threshold|thresholds|alarm|warn\w*|critical|level)\b", re.I)
R_MACHINES = re.compile(r"\b(machines?|gateways?|devices?|offline|online)\b", re.I)
# a measured value: a decimal, or a number with a unit (not a section or table number)
R_VALUE = re.compile(r"\b\d+\.\d+\b|\b\d+\s?(?:Nm|bar|mm/s|mm|A|Hz|degC|percent|%)(?![\w])")


def _terms(text: str) -> list[str]:
    """Words for matching: camelCase split (alarmHigh), plurals folded (limits)."""
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text).lower()
    out = []
    for t in re.findall(r"[a-z0-9]+", text):
        if t in STOP or len(t) < 2:
            continue
        out.append(t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith("ss") else t)
    return out


NAME_WORDS = set(_terms(
    "axis servo torque tool center centre point deviation weld gun temp temperature main motor current "
    "lube oil pressure bearing vibration rms robot press stamp stamping welding sensor machine channel"))


def _cells(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def _table_header(lines: list[str], i: int) -> list[str] | None:
    """The header of the markdown table that line i belongs to."""
    j = i
    while j > 0 and lines[j - 1].strip().startswith("|"):
        j -= 1
    if j + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|?$", lines[j + 1].strip()):
        return _cells(lines[j])
    return None


def best_passage(hits: list[Evidence], query: str) -> tuple[Evidence, str] | None:
    """The single line of the manuals that best answers a question, without a model.

    Lines are scored by the question's words they contain, each weighted by how
    rare it is among the candidate lines (the sensor name is everywhere, "alarm"
    is not), a little extra when they hold a number, and less the lower their
    chunk ranked. A table row is returned with its column headers, so "at or
    above 2.5" says what it is.
    """
    terms = set(_terms(query))
    candidates: list[tuple[int, Evidence, str]] = []
    for rank, h in enumerate(hits):
        lines = h.text.split("\n")
        for i, line in enumerate(lines):
            line = line.strip()
            if len(line) < 20 or re.match(r"^\|[\s:|-]+\|?$", line):
                continue
            if line.startswith("|"):
                header = _table_header(lines, i)
                if header and _cells(line) == header:
                    continue
                text = "; ".join(f"{hd}: {c}" if hd else c for hd, c in zip(header or [""] * 99, _cells(line)) if c)
                pieces = [text]
            else:
                pieces = [s for s in re.split(r"(?<=[.!?])\s+", line) if len(s) > 20]
            candidates += [(rank, h, piece) for piece in pieces]
    if not candidates:
        return None
    words = [set(_terms(piece)) for _, _, piece in candidates]
    n = len(candidates)
    # the machine and channel words already chose the documents; the rest of the
    # question ("alarm limit", "replace") says which line answers it
    weight = {t: math.log(1 + n / (1 + sum(t in w for w in words))) * (0.6 if t in NAME_WORDS else 1.0)
              for t in terms}
    value_bonus = 1.0 if R_LIMIT.search(query) else 0.5
    best: tuple[float, Evidence, str] | None = None
    for (rank, h, piece), w in zip(candidates, words):
        s = sum(weight[t] for t in terms & w) + (value_bonus if R_VALUE.search(piece) else 0) - 0.15 * rank
        if best is None or s > best[0]:
            best = (s, h, piece)
    return best[1], clean_text(best[2], 420)


def _reading_line(r: dict) -> str:
    label = (r.get("channelKey") or "").replace("_", " ").lower()
    return f"{label} {r.get('value')} {r.get('unit') or ''} ({r.get('status')})".replace("  ", " ")


async def rule_answer(message: str, snap: dict, ctx: dict, *, tools: ToolSession, knowledge: Knowledge,
                      turn: Turn) -> str:
    twin = snap.get("twin")
    if twin and R_CLEAR.search(message):
        await point_at(tools, ctx, [], "clear")
        return "Cleared the highlights."

    if R_THIS.search(message) and snap.get("selectedMesh"):
        return describe_part(snap["selectedMesh"])

    if R_SHOW.search(message) and not R_DIAG.search(message):
        if not twin:
            return "Open a twin from the registry first; then I can point at its parts."
        query = " ".join(_terms(R_SHOW.sub(" ", message))) or message
        sid = turn.step(TOOL_LABELS["find_meshes"], detail=query[:120])
        found = await tools.call("find_meshes", {"assetId": twin["assetId"], "query": query[:120], "limit": 6})
        turn.finish(sid, *tool_outcome("find_meshes", found, turn)[1:2])
        if not found:
            return f"I could not find a part matching \"{query}\" on {twin['name']}."
        top = found[0]
        same = [f["meshName"] for f in found if f["score"] >= top["score"] - 0.5][:3]
        pid = turn.step(TOOL_LABELS["point_at_parts"], detail=", ".join(same))
        result = await point_at(tools, ctx, same, "highlight", top.get("label") or top["meshName"])
        state, detail, _ = tool_outcome("point_at_parts", result, turn)
        turn.finish(pid, detail, state=state)
        names = ", ".join(f"{f.get('label') or f['meshName']} ({f['meshName']})" for f in found if f["meshName"] in same)
        return f"Highlighted {names} on {twin['name']}."

    if R_DIAG.search(message):
        if twin and not twin["machines"]:
            return (f"{twin['name']} has no machines added, so there is nothing to diagnose. "
                    "Add a machine in the Machines tab first.")
        mid = pick_machine(message, snap)
        if not mid:
            names = ", ".join(_machine_name(m) for m in machine_pool(snap))
            return f"Which machine? {names}." if names else "There are no machines to diagnose yet."
        name = _machine_name(machine_named(snap, mid) or {"machineId": mid})
        sid = turn.step(TOOL_LABELS["diagnose_machine"], detail=name)
        d = await quick_diagnosis(tools, mid)
        if not d:
            turn.finish(sid, "not enough live data", state="error")
            return f"There is not enough live data from {name} to diagnose it right now."
        turn.finish(sid, tool_outcome("diagnose_machine", diagnosis_brief(d), turn)[1])
        return await explain_diagnosis(d, tools=tools, knowledge=knowledge, ctx=ctx, turn=turn)

    if R_REPORT.search(message):
        reports = snap.get("recentReports") or []
        if not reports:
            return "There are no diagnostic reports yet" + (f" for {twin['name']}." if twin else ".")
        r = reports[0]
        if twin:
            cmd = {"assetId": twin["assetId"], "commands": [{"type": "open_report", "reportId": r["reportId"]}]}
            if ctx.get("sessionId"):
                cmd["sessionId"] = ctx["sessionId"]
            await tools.call("emit_ui_command", cmd)
        rc = r.get("rootCause") or {}
        who = _machine_name(machine_named(snap, r.get("machineId")) or {"machineId": r.get("machineId")})
        return (f"Latest report, {who}: {r.get('headline')}. Root cause {rc.get('id')} {rc.get('name', '').lower()} "
                f"at {pct(rc.get('confidence') or 0)} confidence, level {r.get('level')}." + (" I opened it in the report panel." if twin else ""))

    if R_STATUS.search(message) or not _terms(message) or (R_MACHINES.search(message) and not R_LIMIT.search(message)):
        return status_text(snap)

    # whose manuals: the machine the question names, else the type its words point to, else all of them
    mid = pick_machine(message, snap)
    kind = (machine_named(snap, mid) or {}).get("machineType") or K.type_from_words(message)
    doc = knowledge.doc_machine(mid, kind)
    query = message[:300]
    if R_LIMIT.search(message):
        # word overlap alone drifts to whatever repeats the sensor name; steer to the level tables
        query += " threshold system, level model, master limits"
    sid = turn.step(TOOL_LABELS["search_manuals"], detail=message[:120])
    hits, _ = await asyncio.to_thread(knowledge.retrieve, query, doc, None, 4)
    found = best_passage(hits, message)
    if not found:
        turn.finish(sid, "nothing relevant", state="error")
        return "The manuals are not available right now, and the question is not about live data I can read."
    h, passage = found
    h = turn.cite([h])[0]
    turn.finish(sid, f"read {len(hits)} passages, quoting one", sources=[_source_view(h)])
    return f"From {h.document}, {h.section.split(' > ')[-1]} (page {h.page}) [{h.ref}]: {passage}"


def limits_text(lim: dict, unit: str | None) -> str:
    u = f" {unit}" if unit else ""
    words = {"warnLow": "warning below", "alarmLow": "alarm below", "warnHigh": "warning above", "alarmHigh": "alarm above"}
    return "Limits: " + ", ".join(f"{words.get(k, k)} {v}{u}" for k, v in lim.items()) + "."


def describe_part(c: dict) -> str:
    if c.get("exists") is False:
        return f"{c.get('meshName')} is not a part of this twin."
    name = c.get("label") or c.get("meshName")
    parts = [f"This is {name} ({c.get('meshName')})" + (f" in the {c['zone']}" if c.get("zone") else "") + "."]
    m = c.get("machine") or {}
    if m:
        parts.append(f"It belongs to {m.get('label') or m.get('machineId')}.")
    if c.get("bound") and c.get("binding"):
        b = c["binding"]
        lt = c.get("latest") or {}
        parts.append(f"It is bound to {b.get('sensorId')}: {lt.get('value')} {lt.get('unit') or ''}, {lt.get('status', 'no reading')}.".replace(" ,", ","))
        f = c.get("features") or {}
        if f.get("mean60") is not None and f.get("baseline"):
            parts.append(f"The 60 s mean is {f['mean60']} against a learned baseline of {f['baseline']['mean']}.")
        lim = c.get("limits") or {}
        if lim:
            parts.append(limits_text(lim, (c.get("latest") or {}).get("unit")))
    elif c.get("suggestedChannel"):
        parts.append(f"No sensor is bound yet; the model suggests {c['suggestedChannel']}.")
    else:
        parts.append("No sensor is bound to it.")
    return " ".join(parts)


def _machine_name(m: dict) -> str:
    return m.get("label") or m.get("machineId") or "a machine"


def _investigation_line(i: dict, with_status: bool = False) -> str:
    kind = "drifting" if i.get("kind") == "drift" else i.get("severity", "warn")
    status = {"analysing": "being analysed", "reported": "reported", "agent_unavailable": "no agent",
              "failed": "diagnosis failed"}.get(i.get("status"), i.get("status"))
    return (f"{_machine_name(i)} {i['channelKey'].replace('_', ' ').lower()} ({kind}"
            + (f", {status}" if with_status and status else "") + ")")


def status_text(snap: dict) -> str:
    if snap.get("twin"):
        t = snap["twin"]
        if not t["machines"]:
            free = ", ".join(_machine_name(m) for m in snap.get("availableToAdd") or [])
            return (f"{t['name']} has no machines added yet, so it has no live data. "
                    + (f"Online and free to add in the Machines tab: {free}." if free
                       else "No gateway is online and free right now; start one, then add it in the Machines tab."))
        out = [f"{t['name']}:"]
        for m in t["machines"]:
            rs = [r for r in snap.get("readings", []) if (r.get("sensorId") or "").lower().startswith(m["machineId"])]
            out.append(f"{_machine_name(m)} is {m.get('state', 'unknown')}" +
                       (": " + "; ".join(_reading_line(r) for r in rs) if rs else "") + ".")
        inv = snap.get("openInvestigations") or []
        out.append(f"{len(inv)} open investigation{'s' if len(inv) != 1 else ''}" +
                   (": " + "; ".join(_investigation_line(i, True) for i in inv) if inv else "") + ".")
        return " ".join(out)
    twins = snap.get("twins") or []
    if not twins:
        return "There are no twins in the registry yet."
    inv = snap.get("openInvestigations") or []
    lines = [f"{len(twins)} twin{'s' if len(twins) != 1 else ''} in the plant."]
    for t in twins:
        ms = ", ".join(f"{_machine_name(m)} ({m.get('state', 'unknown')})" for m in t.get("machines", [])) or "no machines"
        n = t.get("openInvestigations", 0)
        lines.append(f"{t['name']}: {ms}; {n} open investigation{'s' if n != 1 else ''}.")
    if inv:
        lines.append("Open: " + "; ".join(_investigation_line(i, True) for i in inv) + ".")
    return " ".join(lines)


async def explain_diagnosis(d: Diagnosis, *, tools: ToolSession, knowledge: Knowledge, ctx: dict, turn: Turn) -> str:
    label = d.name
    root = d.root
    if not root:
        return f"{label} is at level {d.level}. No documented fault signature fits the live data" + \
            (f" ({'; '.join(d.level_reasons)})." if d.level_reasons else ".")
    fault = K.faults_for(d.machine_type).get(root.id)
    sid = turn.step(TOOL_LABELS["search_manuals"], detail=f"{root.label} signature")
    hits, _ = await asyncio.to_thread(knowledge.retrieve, f"{root.label} {root.name}: fault signature and diagnosis",
                                      knowledge.doc_machine(d.machine_id, d.machine_type), None, 2)
    cited = turn.cite(hits)
    turn.finish(sid, f"read {len(hits)} passages", sources=[_source_view(e) for e in cited])
    ref = f" [{cited[0].ref}]" if cited else ""
    supports = [t for t in d.tests if t.verdict_for(root.id) == "supports"][:3]
    text = (f"{label} is at level {d.level}. Most likely {root.id}{' ' + root.code if root.code else ''}, "
            f"{root.name.lower()}, at {pct(root.confidence)} confidence{ref}. ")
    if supports:
        text += "Evidence: " + ", ".join(f"{short_name(t)} {t.observed}" for t in supports) + ". "
    if d.ranked[1:2]:
        a = d.ranked[1]
        text += f"Next most likely: {a.id} {a.name.lower()} ({pct(a.confidence)}). "
    if fault:
        text += f"Action: {fault.actions[0][0]}"
        if ctx.get("scope") == "twin":
            from .grounding import ground_fault
            targets = await ground_fault(tools, ctx["assetId"], d.machine_id, fault, None, [])
            if targets:
                pid = turn.step(TOOL_LABELS["point_at_parts"], detail=targets[0]["label"])
                result = await point_at(tools, ctx, [t["meshName"] for t in targets], "highlight", targets[0]["label"])
                state, detail, _ = tool_outcome("point_at_parts", result, turn)
                turn.finish(pid, detail, state=state)
                text += f" I highlighted {targets[0]['label']}."
    return text.strip()


# --- the graph ---------------------------------------------------------------

def _chunks(text: str, size: int = 4) -> list[str]:
    words = re.split(r"(\s+)", text)
    out, buf = [], ""
    count = 0
    for w in words:
        buf += w
        if w.strip():
            count += 1
        if count >= size:
            out.append(buf)
            buf, count = "", 0
    if buf:
        out.append(buf)
    return out


async def respond(state: ChatState, config: RunnableConfig) -> ChatState:
    writer = get_stream_writer()
    tools, knowledge, rounds = _deps(config)
    req = state["request"]
    ctx = {**req.get("context", {}), "sessionId": req.get("sessionId")}
    message = req["message"]
    history = state.get("messages", [])
    turn = Turn(writer=writer)
    quota_wait_sec = config["configurable"].get("quota_wait_sec", 30)

    twin_scope = ctx.get("scope") == "twin"
    cid = turn.step("Reading the twin" if twin_scope else "Reading the plant", kind="context")
    snap = await scope_snapshot(tools, ctx)
    if twin_scope:
        t = snap["twin"]
        ctx["machinesOnTwin"] = {m["machineId"] for m in t["machines"]}
        parts = [f"{len(t['machines'])} machine{'s' if len(t['machines']) != 1 else ''} on this twin",
                 f"{len(snap.get('openInvestigations') or [])} open investigations"]
        if snap.get("selectedMesh"):
            parts.append(f"selected: {snap['selectedMesh'].get('label') or ctx.get('selectedMesh')}")
        turn.finish(cid, ", ".join(parts))
    else:
        turn.finish(cid, f"{len(snap.get('twins') or [])} twins, {len(snap.get('machines') or [])} machines")
    ctx["machineTypes"] = {m["machineId"]: m.get("machineType") for m in (snap.get("machines") or machine_pool(snap))}

    text = None
    reason = None
    if knowledge.llm_ready:
        try:
            text = await model_answer(message, history, snap, ctx, tools=tools, knowledge=knowledge,
                                      rounds=rounds, turn=turn, quota_wait_sec=quota_wait_sec)
            turn.model = knowledge.model
            reason = None if text else "the model quota is busy"
        except Exception as err:   # quota, network, a refused request: answer from the rules instead
            log.warning("model answer failed, using rules: %s", err)
            reason = f"the model failed ({type(err).__name__})"
            text = None
    else:
        reason = {"no-key": "no Gemini key is set", "off": "the model is switched off",
                  "degraded": "the model is resting after a quota error"}.get(knowledge.status().get("llm"), "the model is unavailable")
    if not text:
        turn.degraded = True
        turn.model = None
        turn.finish(turn.step("Answering without the language model", kind="fallback"),
                    f"{reason}; using live data and the manuals")
        text = await rule_answer(message, snap, ctx, tools=tools, knowledge=knowledge, turn=turn)

    text = split_refs(clean_text(text, 4000))
    used = {m for m in re.findall(r"\[(S\d+)\]", text)}
    cites = [e.citation() for e in turn.citations if e.ref in used] or [e.citation() for e in turn.citations[:3]]
    turn.finish(turn.step("Writing the answer", kind="answer"),
                f"{len(text.split())} words" + (f", {len(cites)} source{'s' if len(cites) != 1 else ''}" if cites else ""))
    for piece in _chunks(text):
        writer({"event": "token", "data": {"text": piece}})
        await asyncio.sleep(0.008)
    if cites:
        writer({"event": "citations", "data": {"items": cites}})
    writer({"event": "meta", "data": {"degraded": turn.degraded, "model": turn.model, "tools": turn.tools}})

    now = time.time()
    scope_name = (snap.get("twin") or {}).get("name") if ctx.get("scope") == "twin" else "Plant"
    return {"messages": [
        {"role": "user", "text": message, "ts": now, "scope": ctx.get("scope"), "scopeName": scope_name,
         "selectedMesh": ctx.get("selectedMesh")},
        {"role": "assistant", "text": text, "ts": time.time(), "citations": cites, "degraded": turn.degraded,
         "model": turn.model, "steps": turn.steps},
    ]}


def build_chat_graph(checkpointer=None):
    g = StateGraph(ChatState)
    g.add_node("respond", respond)
    g.add_edge(START, "respond")
    g.add_edge("respond", END)
    return g.compile(checkpointer=checkpointer)
