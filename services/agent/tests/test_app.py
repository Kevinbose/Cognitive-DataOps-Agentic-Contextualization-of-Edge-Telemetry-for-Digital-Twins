"""The HTTP surface: key checks, the 202 hand-off, the event stream and thread history."""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from cdo_agent.app import create_app
from cdo_agent.config import load_settings

from .conftest import ASSET, FakeTools

KEY = "k" * 40


class FakeNode:
    def __init__(self, tools: FakeTools):
        self.tools = tools

    @asynccontextmanager
    async def session(self):
        yield self.tools


@pytest.fixture
def client(knowledge, tmp_path):
    settings = replace(load_settings(), service_key=KEY, data_dir=tmp_path)
    tools = FakeTools({"press-stamp-01": "CLOGGED_FILTER_60"})
    app = create_app(settings, knowledge, FakeNode(tools))
    with TestClient(app) as c:
        c.tools = tools
        yield c


def auth():
    return {"authorization": f"Bearer {KEY}"}


def test_health_needs_no_key_and_says_how_it_will_answer(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["llm"] == "off" and body["rag"] == "bm25"
    assert body["serviceKey"] is True


def test_every_v1_route_needs_the_service_key(client):
    assert client.post("/v1/investigations", json={}).status_code == 401
    assert client.post("/v1/chat", json={}, headers={"authorization": "Bearer nope"}).status_code == 401
    assert client.get("/v1/threads/chat:abcdefgh").status_code == 401


def test_an_investigation_is_accepted_at_once_and_reported_in_the_background(client, investigation):
    res = client.post("/v1/investigations", json=investigation, headers=auth())
    assert res.status_code == 202 and res.json()["accepted"] is True
    for _ in range(100):
        if client.tools.posted:
            break
        asyncio.run(asyncio.sleep(0.02))
    assert client.tools.posted[0]["rootCause"]["id"] == "F01"
    bad = client.post("/v1/investigations", json={**investigation, "investigationId": "nope"}, headers=auth())
    assert bad.status_code == 422


def test_chat_streams_events_and_keeps_the_thread(client):
    body = {"message": "What is this?", "threadId": "chat:app-thread-1", "sessionId": "sess-0123456789",
            "context": {"scope": "twin", "assetId": ASSET, "assetName": "Car factory", "selectedMesh": "PRESS_LUBE_FILTER"}}
    with client.stream("POST", "/v1/chat", json=body, headers=auth()) as res:
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/event-stream")
        text = "".join(res.iter_text())
    events = [block.split("\n", 1) for block in text.strip().split("\n\n")]
    names = [e[0].removeprefix("event: ") for e in events]
    assert names[0] == "step" and names[-1] == "done" and "token" in names
    answer = "".join(json.loads(e[1].removeprefix("data: "))["text"] for e in events if e[0] == "event: token")
    assert answer.startswith("This is Lube oil filter bank") and "(PRESS_LUBE_FILTER)" in answer
    thread = client.get("/v1/threads/chat:app-thread-1", headers=auth()).json()
    assert [m["role"] for m in thread["messages"]] == ["user", "assistant"]
    assert thread["messages"][0]["scopeName"] == "Car factory"
    assert thread["messages"][1]["steps"][0]["label"] == "Reading the twin", "steps are kept with the answer"


def test_twin_scope_without_a_twin_is_refused(client):
    body = {"message": "hi", "threadId": "chat:app-thread-2", "context": {"scope": "twin"}}
    assert client.post("/v1/chat", json=body, headers=auth()).status_code == 422
