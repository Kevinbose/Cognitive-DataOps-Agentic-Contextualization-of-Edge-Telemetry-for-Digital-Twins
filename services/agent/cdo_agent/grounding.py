"""From a fault's component to real meshes on the twin.

Two sources, in order: the part tags the twin's model carries (the factory GLB
tags every machine part, for example `lube_filter` or `axis_4_motor`), then
the operator's bindings (the mesh a channel is bound to). Only names the twin
returned are used; the Node API checks them again before anything is drawn.
"""
from __future__ import annotations

from .knowledge import Fault
from .mcp_client import ToolError, ToolSession


async def ground_fault(tools: ToolSession, asset_id: str | None, machine_id: str, fault: Fault | None,
                       trigger_sensor: str | None, bindings: list[dict]) -> list[dict]:
    if not asset_id:
        return []
    targets: list[dict] = []
    seen: set[str] = set()

    def add(mesh: str, label: str | None, tag: str | None, sensor: str | None) -> None:
        if mesh and mesh not in seen and len(targets) < 4:
            seen.add(mesh)
            targets.append({"meshName": mesh, "label": (label or mesh)[:120], "tag": tag, "sensorId": sensor})

    if fault and fault.tags:
        for words in fault.words or (fault.tags[0].replace("_", " "),):
            try:
                found = await tools.call("find_meshes", {"assetId": asset_id, "query": words, "limit": 10})
            except ToolError:
                continue
            for item in found or []:
                tags = set(item.get("tags") or [])
                owner = item.get("machineId")
                if owner and owner != machine_id:
                    continue
                hit = next((t for t in fault.tags if t in tags), None)
                if hit:
                    add(item["meshName"], item.get("label"), hit, item.get("sensorId"))
                if sum(1 for t in targets if t["tag"]) >= 2:
                    break

    for b in bindings:
        if trigger_sensor and b.get("sensorId") == trigger_sensor and b.get("meshName"):
            add(b["meshName"], b.get("displayName"), None, b["sensorId"])
    return targets


def unbound_channels(machine: dict, bindings: list[dict]) -> list[str]:
    bound = {b.get("sensorId") for b in bindings if b.get("meshName")}
    return [c["sensorId"] for c in machine.get("channels", []) if c.get("sensorId") not in bound]
