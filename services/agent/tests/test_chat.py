"""The converse lane without a model: scope, pointing, diagnosis on demand, manuals, memory."""
from __future__ import annotations

from langgraph.checkpoint.memory import InMemorySaver

from cdo_agent.chat import build_chat_graph

from .conftest import ASSET, FakeTools

SESSION = "sess-0123456789"


async def ask(graph, tools, knowledge, message, *, thread="chat:test-thread", **context):
    ctx = {"scope": "plant", **context}
    if ctx["scope"] == "twin":
        ctx.setdefault("assetId", ASSET)
        ctx.setdefault("assetName", "Car factory")
    cfg = {"configurable": {"thread_id": thread, "tools": tools, "knowledge": knowledge}}
    events = []
    async for chunk in graph.astream({"request": {"message": message, "threadId": thread, "sessionId": SESSION, "context": ctx}},
                                     cfg, stream_mode="custom"):
        events.append(chunk)
    text = "".join(e["data"]["text"] for e in events if e["event"] == "token")
    return text, events


def graph():
    return build_chat_graph(InMemorySaver())


async def test_twin_scope_explains_the_selected_part(knowledge):
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_60"})
    text, events = await ask(graph(), tools, knowledge, "What is this?", scope="twin", selectedMesh="PRESS_LUBE_FILTER")
    assert "Lube oil filter bank" in text
    assert "PRESS-STAMP-01.LUBE_OIL_PRESSURE" in text
    assert events[0]["event"] == "step" and events[0]["data"]["label"] == "Reading the twin"
    steps = {e["data"]["id"]: e["data"] for e in events if e["event"] == "step"}
    assert steps["s1"]["state"] == "done" and steps["s1"]["detail"].startswith("2 machines on this twin")
    assert any(s["kind"] == "fallback" for s in steps.values()), "the offline answer says so"
    assert events[-1]["event"] == "meta" and events[-1]["data"]["degraded"] is True


async def test_show_me_highlights_real_meshes_for_this_session_only(knowledge):
    tools = FakeTools()
    text, _ = await ask(graph(), tools, knowledge, "Show me the lube filter", scope="twin")
    assert "PRESS_LUBE_FILTER" in text
    cmd = tools.ui[-1]
    assert cmd["assetId"] == ASSET and cmd["sessionId"] == SESSION
    kinds = [c["type"] for c in cmd["commands"]]
    assert kinds[:2] == ["highlight", "camera_focus"]
    assert cmd["commands"][0]["meshName"] == "PRESS_LUBE_FILTER"


async def test_why_runs_the_diagnosis_and_points_at_the_component(knowledge):
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_60"})
    text, events = await ask(graph(), tools, knowledge, "Why is the press pressure low?", scope="twin")
    assert "F01 CLOGGED_FILTER" in text and "percent confidence" in text
    assert "P60" in text and "HB300" in text
    diag = [e["data"] for e in events if e["event"] == "step" and e["data"]["label"] == "Running the diagnosis"]
    assert diag[-1]["state"] == "done" and "F01" in diag[-1]["detail"]
    manual = [e["data"] for e in events if e["event"] == "step" and e["data"]["label"] == "Searching the manuals"][-1]
    assert manual["sources"] and manual["sources"][0]["document"], "the step shows what it read"
    assert any(c["meshName"] == "PRESS_LUBE_FILTER" for u in tools.ui for c in u["commands"] if "meshName" in c)
    cites = next(e for e in events if e["event"] == "citations")["data"]["items"]
    assert cites and cites[0]["chunkId"].startswith("press-stamp-01:")


async def test_plant_scope_summarises_every_twin_and_cannot_point(knowledge):
    tools = FakeTools()
    text, _ = await ask(graph(), tools, knowledge, "How is the plant doing?")
    assert "Car factory" in text and "Stamping press 01" in text
    text, _ = await ask(graph(), tools, knowledge, "Show me the weld gun")
    assert "Open a twin" in text
    assert tools.ui == []


async def test_a_manual_question_is_answered_with_a_citation(knowledge):
    tools = FakeTools()
    text, events = await ask(graph(), tools, knowledge, "What is the alarm limit for axis 4 servo torque on the robot?", scope="twin")
    assert "[S1]" in text
    assert "30 Nm" in text, "the documented alarmHigh, found without a model"
    text, _ = await ask(graph(), tools, knowledge, "What is the warning threshold for bearing vibration on the press?", scope="twin")
    assert "Warning [P]: at or above 2.5" in text
    cites = next(e for e in events if e["event"] == "citations")["data"]["items"]
    assert cites[0]["chunkId"].startswith("robot-weld-01:")


async def test_a_thread_remembers_its_turns(knowledge):
    g = graph()
    tools = FakeTools()
    await ask(g, tools, knowledge, "How is the plant doing?", thread="chat:memory-1")
    await ask(g, tools, knowledge, "Any reports?", thread="chat:memory-1")
    state = await g.aget_state({"configurable": {"thread_id": "chat:memory-1"}})
    msgs = state.values["messages"]
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"]
    assert msgs[2]["text"] == "Any reports?"
    other = await g.aget_state({"configurable": {"thread_id": "chat:memory-2"}})
    assert not (other.values or {}).get("messages")


async def test_a_model_pointing_without_a_label_still_names_the_part(knowledge):
    from cdo_agent.chat import Turn, run_tool

    tools, turn = FakeTools(), Turn()
    ctx = {"scope": "twin", "assetId": ASSET, "sessionId": SESSION}
    await run_tool("find_meshes", {"query": "main bearing"}, tools=tools, knowledge=knowledge, ctx=ctx, turn=turn)
    await run_tool("point_at_parts", {"action": "highlight", "meshNames": ["PRESS_MAIN_BEARING"]},
                   tools=tools, knowledge=knowledge, ctx=ctx, turn=turn)
    first = tools.ui[-1]["commands"][0]
    assert first["meshName"] == "PRESS_MAIN_BEARING"
    assert first["label"] == "Main bearing, drive end"


def test_a_reports_sources_become_the_answers_sources():
    from cdo_agent.chat import Turn, adopt_report_sources
    from cdo_agent.rag_bridge import Evidence

    turn = Turn()
    turn.cite([Evidence("S1", "robot-weld-01:01:010", "robot-weld-01", "Operating conditions", "", "6.1", 8, "f.pdf", "", [], 0.0)])
    report = {"machineId": "press-stamp-01", "summary": "Clogged filter [S1]. Replace the cartridge [S2].",
              "citations": [{"chunkId": "press-stamp-01:02:005", "ref": "S1", "document": "Failure modes", "page": 6},
                            {"chunkId": "press-stamp-01:04:030", "ref": "S2", "document": "Maintenance", "page": 13}]}
    out = adopt_report_sources(report, turn)
    assert out["summary"] == "Clogged filter [S2]. Replace the cartridge [S3]."
    assert [c["ref"] for c in out["citations"]] == ["S2", "S3"]
    assert [e.chunk_id for e in turn.citations] == ["robot-weld-01:01:010", "press-stamp-01:02:005", "press-stamp-01:04:030"]



async def test_a_twin_with_no_machines_never_claims_any(knowledge):
    # both gateways exist in the plant, neither is on this twin (the bug in the screenshot)
    tools = FakeTools(assigned={"press-stamp-01": None, "robot-weld-01": "ffffffffffffffffffffffff"},
                      states={"press-stamp-01": "online", "robot-weld-01": "offline"})
    g = graph()
    text, events = await ask(g, tools, knowledge, "What machines are on this twin and is it running?", scope="twin")
    assert "no machines added" in text
    assert "free to add in the Machines tab: Stamping press 01" in text, "the online, unclaimed gateway"
    assert "Welding robot 01" not in text, "offline and on another twin: not offered"
    text, _ = await ask(g, tools, knowledge, "Is anything wrong with the press?", scope="twin")
    assert "no machines added" in text and "Stamping press 01 is" not in text
    first = next(e["data"] for e in events if e["event"] == "step" and e["data"]["state"] == "done")
    assert first["detail"].startswith("0 machines on this twin")


async def test_tools_refuse_machines_that_are_not_on_the_twin(knowledge):
    from cdo_agent.chat import Turn, run_tool

    tools = FakeTools(assigned={"press-stamp-01": ASSET, "robot-weld-01": None})
    ctx = {"scope": "twin", "assetId": ASSET, "machinesOnTwin": {"press-stamp-01"}}
    out = await run_tool("get_latest_telemetry", {"machineId": "robot-weld-01"}, tools=tools, knowledge=knowledge, ctx=ctx, turn=Turn())
    assert "not on this twin" in out["error"] and "press-stamp-01" in out["error"]
    out = await run_tool("get_channel_features", {"sensorId": "ROBOT-WELD-01.AXIS_4_SERVO_TORQUE"}, tools=tools,
                         knowledge=knowledge, ctx=ctx, turn=Turn())
    assert "not on this twin" in out["error"]
    out = await run_tool("get_device_catalog", {}, tools=tools, knowledge=knowledge, ctx=ctx, turn=Turn())
    assert [m["machineId"] for m in out["onThisTwin"]] == ["press-stamp-01"]


def test_machines_are_matched_by_label_and_type_not_by_hardcoded_ids():
    from cdo_agent.chat import pick_machine

    snap = {"twin": {"machines": [
        {"machineId": "press-line-7", "label": "Transfer press 7", "machineType": "press"},
        {"machineId": "cell-3-arm", "label": "Spot welder cell 3", "machineType": "robot"}]}}
    assert pick_machine("is the transfer press ok?", snap) == "press-line-7"
    assert pick_machine("why is axis 4 torque high", snap) == "cell-3-arm"
    assert pick_machine("check the lube pressure", snap) == "press-line-7"
