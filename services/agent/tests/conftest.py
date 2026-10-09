"""A fake Node API behind the MCP tool names, fed by the simulator's own models.

The fake answers exactly the tools the agent uses, from the fixture windows in
fixtures/sim_windows.json and the factory's mesh registry, and records every
call so a test can assert what the agent asked for and what it published.
Retrieval uses the real RAG index in BM25 mode (no key, no network).
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from cdo_agent.config import REPO_ROOT
from cdo_agent.mcp_client import ToolError
from cdo_agent.rag_bridge import Knowledge

HERE = Path(__file__).parent
WINDOWS = json.loads((HERE / "fixtures" / "sim_windows.json").read_text())
CATALOG = json.loads((REPO_ROOT / "firmware" / "catalog.json").read_text(encoding="utf-8"))
REGISTRY_PATH = REPO_ROOT / "blender" / "out" / "car_factory_updated.registry.json"
ASSET = "65f0c0ffee0000000000abcd"
T0_ISO = "2026-10-09T08:00:00.000Z"
STOP = {"the", "a", "an", "of", "on", "in", "to", "me", "show", "where", "is", "which", "what", "part", "and", "for", "this", "that", "its", "it"}


def registry_nodes() -> list[dict]:
    if REGISTRY_PATH.exists():
        data = json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
        nodes = data.get("meshes") or data.get("nodes") or []
        return [n for n in nodes if n.get("machineId") in ("press-stamp-01", "robot-weld-01")]
    return [
        {"meshName": "PRESS_LUBE_FILTER", "label": "Lube oil filter bank (duplex)", "machineId": "press-stamp-01", "tags": ["lube_filter", "filter"]},
        {"meshName": "PRESS_LUBE_UNIT", "label": "Central lubrication unit (oil reservoir)", "machineId": "press-stamp-01", "tags": ["lube_unit", "lube_reservoir"]},
        {"meshName": "PRESS_MAIN_BEARING", "label": "Main bearing, drive end", "machineId": "press-stamp-01", "tags": ["main_bearing_housing", "bearing"]},
        {"meshName": "PRESS_MAIN_MOTOR", "label": "Main drive motor, 250 kW", "machineId": "press-stamp-01", "tags": ["main_motor", "motor"]},
        {"meshName": "ROBOT_A4_SERVO_MOTOR", "label": "Axis 4 servo motor (wrist roll)", "machineId": "robot-weld-01", "tags": ["axis_4_motor", "servo"]},
        {"meshName": "ROBOT_A4_FOREARM", "label": "Axis 4 forearm", "machineId": "robot-weld-01", "tags": ["axis_4"]},
    ]


def _tokens(text: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9]+", " ", str(text).lower()).split() if len(t) > 1 and t not in STOP]


def catalog_entry(mid: str, asset: str | None = ASSET, state: str = "online") -> dict:
    m = CATALOG["machines"][mid]
    return {"machineId": mid, "label": m["label"], "machineType": m["machineType"], "state": state,
            "assetId": asset, "intervalMs": m["intervalMs"], "spectrum": m.get("spectrum"),
            "channels": [{"key": c["key"], "sensorId": f"{mid.upper()}.{c['key']}", "label": c["label"], "unit": c["unit"],
                          "limits": c.get("limits", {}), "decimals": c["decimals"]} for c in m["channels"]]}


class FakeTools:
    """MCP tool session double. `scenario` picks a fixture window per machine."""

    def __init__(self, scenarios: dict[str, str] | None = None, *, bindings: list[dict] | None = None,
                 machines: tuple[str, ...] = ("press-stamp-01", "robot-weld-01"), stale: tuple[str, ...] = (),
                 overrides: dict | None = None, assigned: dict[str, str | None] | None = None,
                 states: dict[str, str] | None = None):
        self.scenarios = {"press-stamp-01": "NORMAL", "robot-weld-01": "NORMAL", **(scenarios or {})}
        self.bindings = bindings if bindings is not None else [
            {"sensorId": "PRESS-STAMP-01.LUBE_OIL_PRESSURE", "meshName": "PRESS_LUBE_FILTER", "displayName": "Lube filter", "machineId": "press-stamp-01"},
            {"sensorId": "ROBOT-WELD-01.AXIS_4_SERVO_TORQUE", "meshName": "ROBOT_A4_SERVO_MOTOR", "displayName": "Axis 4 motor", "machineId": "robot-weld-01"},
        ]
        self.machines = machines
        # which twin each machine was added to (default: all on ASSET) and its state
        self.assigned = {m: ASSET for m in machines} if assigned is None else assigned
        self.states = states or {}
        self.stale = set(stale)
        self.overrides = overrides or {}
        self.calls: list[tuple[str, dict]] = []
        self.posted: list[dict] = []
        self.failures: list[dict] = []
        self.ui: list[dict] = []
        self.nodes = registry_nodes()

    def window(self, mid: str) -> dict:
        return WINDOWS[mid][self.scenarios[mid]]

    async def call(self, name: str, args: dict | None = None):
        args = args or {}
        self.calls.append((name, args))
        if name in self.overrides:
            return self.overrides[name](args)
        handler = getattr(self, f"t_{name}", None)
        if not handler:
            raise ToolError(f"unknown tool {name}")
        return handler(args)

    # --- tools -------------------------------------------------------------
    def t_get_device_catalog(self, a):
        mids = [a["machineId"]] if a.get("machineId") else list(self.machines)
        return [catalog_entry(m, self.assigned.get(m), self.states.get(m, "online")) for m in mids if m in self.machines]

    def t_get_raw_window(self, a):
        mid, key = a["sensorId"].lower().split(".")
        samples = self.window(mid)["channels"][key.upper()]
        t_last = samples[-1][0]
        keep = [s for s in samples if s[0] > t_last - a.get("seconds", 60) * 1000]
        return {"sensorId": a["sensorId"], "seconds": a.get("seconds", 60), "source": "detector", "startedAt": T0_ISO,
                "samples": [[s[0] - keep[0][0], s[1]] for s in keep]}

    def t_get_channel_features(self, a):
        return {"sensorId": a["sensorId"], "baseline": None, "mean10": None, "mean60": None}

    def t_get_latest_telemetry(self, a):
        out = []
        for mid in ([a["machineId"]] if a.get("machineId") else self.machines):
            for c in catalog_entry(mid)["channels"]:
                v = self.window(mid)["channels"][c["key"]][-1][1]
                bound = next((b["meshName"] for b in self.bindings if b["sensorId"] == c["sensorId"]), None)
                out.append({"sensorId": c["sensorId"], "machineId": mid, "channelKey": c["key"], "value": v, "unit": c["unit"],
                            "status": "normal", "ageMs": 99_000 if c["key"] in self.stale else 400, "meshName": bound, "assetId": ASSET})
        return out

    def t_get_spectrum(self, a):
        frames = self.window(a["machineId"]).get("spectra") or []
        return {"machineId": a["machineId"], "layout": catalog_entry(a["machineId"])["spectrum"],
                "frames": [{"ts": T0_ISO, "amp": f} for f in frames[-a.get("frames", 1):]]}

    def t_get_mesh_bindings(self, a):
        return list(self.bindings)

    def t_find_meshes(self, a):
        q = _tokens(a["query"])
        scored = []
        for n in self.nodes:
            hay = set(_tokens(f"{n['meshName'].replace('_', ' ')} {n.get('label') or ''} {' '.join(n.get('tags') or [])}"))
            score = sum(2 if t in hay else 1 if any(h.startswith(t) or t.startswith(h) for h in hay) else 0 for t in q)
            if score:
                sensor = next((b["sensorId"] for b in self.bindings if b["meshName"] == n["meshName"]), None)
                scored.append({"meshName": n["meshName"], "label": n.get("label"), "tags": n.get("tags") or [],
                               "machineId": n.get("machineId"), "sensorId": sensor, "score": score + (0.5 if sensor else 0) + 0.25})
        scored.sort(key=lambda x: (-x["score"], x["meshName"]))
        return scored[: a.get("limit", 6)]

    def t_get_mesh_context(self, a):
        n = next((x for x in self.nodes if x["meshName"] == a["meshName"]), None)
        b = next((x for x in self.bindings if x["meshName"] == a["meshName"]), None)
        out = {"meshName": a["meshName"], "exists": n is not None, "label": (n or {}).get("label"), "tags": (n or {}).get("tags", []),
               "bound": bool(b), "zone": "Press shop" if a["meshName"].startswith("PRESS") else "Body shop"}
        if n and n.get("machineId"):
            out["machine"] = {"machineId": n["machineId"], "label": CATALOG["machines"][n["machineId"]]["label"], "onThisTwin": True}
        if b:
            out["binding"] = b
            mid, key = b["sensorId"].lower().split(".")
            out["latest"] = {"value": self.window(mid)["channels"][key.upper()][-1][1], "unit": "bar", "status": "normal", "ageMs": 300}
            out["limits"] = next(c["limits"] for c in catalog_entry(mid)["channels"] if c["sensorId"] == b["sensorId"])
        return out

    def t_list_twins(self, a):
        return [{"assetId": ASSET, "name": "Car factory", "status": "ready", "hasModel": True,
                 "machines": [{"machineId": m, "label": CATALOG["machines"][m]["label"], "state": self.states.get(m, "online")}
                              for m in self.machines if self.assigned.get(m) == ASSET],
                 "openInvestigations": 0}]

    def t_get_active_anomalies(self, a):
        return []

    def t_list_reports(self, a):
        return []

    def t_emit_ui_command(self, a):
        names = {n["meshName"] for n in self.nodes}
        accepted = [c for c in a["commands"] if "meshName" not in c or c["meshName"] in names]
        self.ui.append(a)
        return {"accepted": accepted, "rejected": []}

    def t_post_diagnostic_report(self, a):
        self.posted.append(a)
        return {"reportId": "65f0c0ffee00000000000001", "alerted": True, "droppedTargets": []}

    def t_report_investigation_failure(self, a):
        self.failures.append(a)
        return {"investigationId": a["investigationId"], "status": "failed"}


@pytest.fixture(scope="session")
def knowledge() -> Knowledge:
    k = Knowledge(REPO_ROOT / "RAG", llm_mode="off")
    assert k.available, "the RAG index in RAG/data must load"
    return k


@pytest.fixture
def investigation() -> dict:
    return {"investigationId": "65f0c0ffee0000000000beef", "machineId": "press-stamp-01", "assetId": ASSET,
            "sensorId": "PRESS-STAMP-01.LUBE_OIL_PRESSURE", "channelKey": "LUBE_OIL_PRESSURE", "kind": "threshold",
            "severity": "warn", "openedAt": T0_ISO,
            "trigger": {"value": 3.3, "mean10": 3.31, "limit": 3.6, "limitName": "warnLow", "unit": "bar"}}
