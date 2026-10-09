"""The diagnose lane end to end against the fake Node API and the real RAG index."""
from __future__ import annotations

import json

import pytest

from cdo_agent.diagnosis import diagnose
from cdo_agent.features import press_features
from cdo_agent.investigate import run_investigation
from cdo_agent.report import guard

from .conftest import ASSET, REPO_ROOT, WINDOWS, FakeTools

CHUNK_IDS = {json.loads(line)["chunk_id"] for line in (REPO_ROOT / "RAG" / "data" / "chunks" / "chunks.jsonl").open(encoding="utf-8")}


async def test_a_clogged_filter_is_reported_with_citations_and_the_filter_highlighted(knowledge, investigation):
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_60"})
    state = await run_investigation(investigation, tools, knowledge)
    assert "error" not in state, state.get("error")
    assert len(tools.posted) == 1
    r = tools.posted[0]
    assert r["investigationId"] == investigation["investigationId"]
    assert r["assetId"] == ASSET
    assert r["rootCause"]["id"] == "F01" and r["rootCause"]["faultCode"] == "CLOGGED_FILTER"
    assert r["level"] == "warning"
    assert r["citations"], "every report cites the manuals"
    assert all(c["chunkId"] in CHUNK_IDS for c in r["citations"]), "citations are real chunks"
    assert any("F01" in (c["section"] or "") or "filter" in (c["section"] or "").lower() for c in r["citations"])
    names = [t["meshName"] for t in r["targets"]]
    assert "PRESS_LUBE_FILTER" in names
    assert r["generatedBy"] == "template" and r["degraded"] is True
    assert "—" not in r["headline"] + r["summary"]
    assert any(e["verdict"] == "supports" for e in r["evidence"])
    assert r["actions"][0]["step"].startswith("Replace the lube filter cartridge")


async def test_bearing_wear_is_reported_below_the_alarm(knowledge, investigation):
    tools = FakeTools({"press-stamp-01": "BEARING_WEAR_100"})
    inv = {**investigation, "sensorId": "PRESS-STAMP-01.BEARING_VIBRATION_RMS", "channelKey": "BEARING_VIBRATION_RMS", "kind": "drift"}
    await run_investigation(inv, tools, knowledge)
    r = tools.posted[0]
    assert r["rootCause"]["id"] == "F02"
    assert r["severity"] == "warn"
    assert "PRESS_MAIN_BEARING" in [t["meshName"] for t in r["targets"]]


async def test_robot_gearbox_wear_points_at_axis_4(knowledge, investigation):
    tools = FakeTools({"robot-weld-01": "GEARBOX_WEAR_60"})
    inv = {**investigation, "machineId": "robot-weld-01", "sensorId": "ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION",
           "channelKey": "TOOL_CENTER_POINT_DEVIATION"}
    await run_investigation(inv, tools, knowledge)
    r = tools.posted[0]
    assert r["rootCause"]["faultCode"] == "GEARBOX_WEAR"
    assert r["targets"][0]["meshName"] in ("ROBOT_A4_SERVO_MOTOR", "ROBOT_A4_FOREARM")
    assert "ROBOT-WELD-01.TOOL_CENTER_POINT_DEVIATION" in r["needsBinding"]


async def test_the_agent_never_asks_for_simulator_ground_truth(knowledge, investigation):
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_30"})
    await run_investigation(investigation, tools, knowledge)
    reads = json.dumps([c for c in tools.calls if c[0] != "post_diagnostic_report"]).lower()
    assert "scenario" not in reads and '"sim"' not in reads
    assert '"sim"' not in json.dumps(tools.posted)
    assert {name for name, _ in tools.calls} <= {
        "get_device_catalog", "get_raw_window", "get_channel_features", "get_latest_telemetry", "get_spectrum",
        "get_mesh_bindings", "find_meshes", "post_diagnostic_report"}


async def test_a_machine_that_never_announced_itself_fails_cleanly(knowledge, investigation):
    tools = FakeTools(machines=("robot-weld-01",))
    state = await run_investigation(investigation, tools, knowledge)
    assert tools.posted == []
    assert len(tools.failures) == 1
    assert "has not announced itself" in tools.failures[0]["reason"]
    assert state["result"]["failed"]


async def test_a_tool_error_mid_way_is_recorded_as_a_failure(knowledge, investigation):
    def boom(_args):
        raise RuntimeError("socket hang up")
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_60"}, overrides={"get_spectrum": boom})
    await run_investigation(investigation, tools, knowledge)
    assert tools.posted == []
    assert "gather" in tools.failures[0]["reason"]


def _clog_diagnosis():
    w = WINDOWS["press-stamp-01"]["CLOGGED_FILTER_60"]
    return diagnose("press-stamp-01", press_features(w["channels"], w["spectra"]), machine_type="press")


def test_the_guard_keeps_honest_model_text_and_drops_the_rest(knowledge):
    d = _clog_diagnosis()
    cited, _ = knowledge.retrieve("F01 clogged filter signature", "press-stamp-01", k=3)
    facts = "P60 3.285 bar, HB300 0.5208"
    ok = guard({"headline": "Stamping press 01 — clogged lube filter (F01)",
                "summary": "Pressure fell to 3.285 bar and the floor rose to 0.5208 mm/s [S1], which is the clog signature [S9].",
                "actions": [{"step": "Replace the cartridge.", "caveat": None}]}, d, cited, facts)
    assert ok and "—" not in ok["headline"]
    assert "[S9]" not in ok["summary"] and "[S1]" in ok["summary"]

    invented = guard({"headline": "Clogged filter on the press", "summary": "Pressure is 2.91 bar, a clogged filter F01 for sure."},
                     d, cited, facts)
    assert invented is None, "a number that is not in the facts is rejected"

    wrong = guard({"headline": "Bearing wear on the press", "summary": "The main bearing is worn and must be replaced soon."},
                  d, cited, facts)
    assert wrong is None, "text that does not name the root cause is rejected"


@pytest.mark.parametrize("scenario", ["NORMAL"])
async def test_a_deviation_without_a_signature_still_gets_an_honest_report(knowledge, investigation, scenario):
    tools = FakeTools({"press-stamp-01": scenario})
    await run_investigation(investigation, tools, knowledge)
    r = tools.posted[0]
    assert r["rootCause"]["id"] == "UNEXPLAINED"
    assert r["needsReview"] is True


def test_combined_source_references_are_split():
    from cdo_agent.report import split_refs

    assert split_refs("supports the clog [S1, S3] and [S2; S4]. Fine [S5].") == "supports the clog [S1][S3] and [S2][S4]. Fine [S5]."
