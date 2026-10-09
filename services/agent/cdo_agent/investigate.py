"""The diagnose lane: a LangGraph pipeline from an open investigation to a posted report.

    gather -> analyse -> retrieve -> ground -> write -> publish
                 any step that fails -> fail (report_investigation_failure)

Reads go through MCP tools only, so the agent sees exactly what an operator
could see and never the simulator's ground truth. The pipeline is
deterministic up to the wording of the report; see report.py for the guard.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, TypedDict

from langchain_core.runnables import RunnableConfig
from langgraph.graph import END, START, StateGraph

from . import knowledge as K
from .diagnosis import Diagnosis, diagnose
from .features import press_features, robot_features
from .grounding import ground_fault, unbound_channels
from .mcp_client import ToolError, ToolSession
from .rag_bridge import Evidence, Knowledge
from .report import build_report, key_readings, machine_label

log = logging.getLogger("cdo_agent.investigate")
STALE_MS = 5000


class InvState(TypedDict, total=False):
    investigation: dict
    machine: dict
    windows: dict
    spectra: list
    baselines: dict
    stale: list
    bindings: list
    diagnosis: Any
    evidence: list
    rag_mode: str
    targets: list
    needs_binding: list
    report: dict
    result: dict
    error: str
    failed_at: str


def _deps(config: RunnableConfig) -> tuple[ToolSession, Knowledge | None]:
    c = config["configurable"]
    return c["tools"], c.get("knowledge")


def _ms(iso: str) -> float:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000


async def gather(state: InvState, config: RunnableConfig) -> InvState:
    tools, _ = _deps(config)
    inv = state["investigation"]
    mid = inv["machineId"]
    catalog = await tools.call("get_device_catalog", {"machineId": mid})
    if not catalog:
        return {"error": f"machine {mid} has not announced itself", "failed_at": "gather"}
    machine = catalog[0]
    windows, baselines = {}, {}
    for ch in machine.get("channels", []):
        raw = await tools.call("get_raw_window", {"sensorId": ch["sensorId"], "seconds": 120})
        start = _ms(raw["startedAt"]) if raw and raw.get("startedAt") else 0
        windows[ch["key"]] = [(start + dt, v) for dt, v in (raw or {}).get("samples", [])]
        feat = await tools.call("get_channel_features", {"sensorId": ch["sensorId"]})
        if feat and feat.get("baseline"):
            baselines[ch["key"]] = feat["baseline"]
    latest = await tools.call("get_latest_telemetry", {"machineId": mid})
    stale = [s["channelKey"] for s in latest or [] if (s.get("ageMs") or 0) > STALE_MS]
    spectra = []
    if machine.get("spectrum"):
        spec = await tools.call("get_spectrum", {"machineId": mid, "frames": 3})
        spectra = [f["amp"] for f in (spec or {}).get("frames", [])]
    bindings = await tools.call("get_mesh_bindings", {"assetId": inv["assetId"]}) if inv.get("assetId") else []
    if not any(len(w) >= 20 for w in windows.values()):
        return {"error": "too little data in the last two minutes to diagnose", "failed_at": "gather"}
    return {"machine": machine, "windows": windows, "baselines": baselines, "stale": stale,
            "spectra": spectra, "bindings": bindings or []}


async def analyse(state: InvState, config: RunnableConfig) -> InvState:
    machine = state["machine"]
    mtype = machine.get("machineType")
    if mtype == "press":
        f = press_features(state["windows"], state.get("spectra"), state.get("baselines"))
    elif mtype == "robot":
        f = robot_features(state["windows"], state.get("baselines"))
    else:
        return {"error": f"no fault library for machine type {mtype}", "failed_at": "analyse"}
    return {"diagnosis": diagnose(machine["machineId"], f, state.get("stale"),
                                  machine_type=mtype, label=machine.get("label"))}


async def retrieve(state: InvState, config: RunnableConfig) -> InvState:
    _, knowledge = _deps(config)
    d: Diagnosis = state["diagnosis"]
    # the manuals of this machine, or of the reference machine of its type
    mid = knowledge.doc_machine(d.machine_id, d.machine_type)
    root = d.root
    readings = key_readings(d)
    if root:
        q1 = f"{root.label} {root.name}: fault signature, diagnosis and inspection"
        q2 = f"{root.label} {root.name}: corrective maintenance action, fault-to-action matrix, replacement criteria and priorities"
    else:
        q1 = "abnormal reading without a matching fault signature: alternative explanations and inspection"
        q2 = "sensor validation and verification against a reference instrument"
    first, mode = knowledge.retrieve(q1, mid, telemetry=readings, k=8)
    second, mode2 = knowledge.retrieve(q2, mid, k=4)
    merged: list[Evidence] = []
    seen: set[str] = set()
    for e in first + second:
        if e.chunk_id not in seen:
            seen.add(e.chunk_id)
            merged.append(e)
    for n, e in enumerate(merged[:10], start=1):
        e.ref = f"S{n}"
    return {"evidence": merged[:10], "rag_mode": mode if mode == mode2 else "bm25"}


async def ground(state: InvState, config: RunnableConfig) -> InvState:
    tools, _ = _deps(config)
    inv, d = state["investigation"], state["diagnosis"]
    fault = K.faults_for(d.machine_type).get(d.root.id) if d.root else None
    targets = await ground_fault(tools, inv.get("assetId"), d.machine_id, fault, inv.get("sensorId"), state.get("bindings", []))
    return {"targets": targets, "needs_binding": unbound_channels(state["machine"], state.get("bindings", []))}


async def write(state: InvState, config: RunnableConfig) -> InvState:
    _, knowledge = _deps(config)
    d: Diagnosis = state["diagnosis"]
    label = machine_label(d.machine_id, state["machine"].get("label"))
    report = build_report(knowledge=knowledge, d=d, investigation=state["investigation"], label=label,
                          evidence=state.get("evidence", []), targets=state.get("targets", []),
                          needs_binding=state.get("needs_binding", []))
    return {"report": report}


async def publish(state: InvState, config: RunnableConfig) -> InvState:
    tools, _ = _deps(config)
    report = {k: v for k, v in state["report"].items() if v is not None or k in ("model",)}
    result = await tools.call("post_diagnostic_report", report)
    return {"result": result}


async def fail(state: InvState, config: RunnableConfig) -> InvState:
    tools, _ = _deps(config)
    reason = f"{state.get('failed_at', 'agent')}: {state.get('error', 'unknown error')}"[:300]
    try:
        await tools.call("report_investigation_failure",
                         {"investigationId": state["investigation"]["investigationId"], "reason": reason})
    except ToolError as err:
        log.error("could not mark the investigation failed: %s", err)
    return {"result": {"failed": reason}}


def _guarded(name: str, fn):
    async def run(state: InvState, config: RunnableConfig) -> InvState:
        try:
            return await fn(state, config)
        except Exception as err:   # a broken step must end in a recorded failure, never silence
            log.exception("investigation step %s failed", name)
            return {"error": f"{type(err).__name__}: {err}"[:240], "failed_at": name}
    return run


def build_graph():
    g = StateGraph(InvState)
    steps = [("gather", gather), ("analyse", analyse), ("retrieve", retrieve),
             ("ground", ground), ("write", write), ("publish", publish)]
    for name, fn in steps:
        g.add_node(name, _guarded(name, fn))
    g.add_node("fail", fail)
    g.add_edge(START, "gather")
    for (name, _), nxt in zip(steps, [s[0] for s in steps[1:]] + [END]):
        g.add_conditional_edges(name, lambda s, nxt=nxt: "fail" if s.get("error") else nxt, [nxt, "fail"])
    g.add_edge("fail", END)
    return g.compile()


GRAPH = build_graph()


async def run_investigation(investigation: dict, tools: ToolSession, knowledge: Knowledge) -> InvState:
    return await GRAPH.ainvoke({"investigation": investigation},
                               config={"configurable": {"tools": tools, "knowledge": knowledge}})
