"""HTTP surface of the agent. Only the Node API calls it; the browser never does.

    GET  /health                 reachability, model and retrieval mode (no key needed)
    POST /v1/investigations      202; the diagnosis runs in the background, one at a time
    POST /v1/chat                server-sent events for one chat turn
    GET  /v1/threads/{threadId}  a thread's transcript, for the widget after a reload

Every /v1 route needs the shared service key as a bearer token.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator

from . import __version__
from .config import Settings, load_settings, read_service_key
from .investigate import run_investigation
from .mcp_client import NodeTools, ToolError
from .rag_bridge import Knowledge

log = logging.getLogger("cdo_agent")

HEX24 = r"^[0-9a-fA-F]{24}$"
CATCH_UP_SEC = 60


class InvestigationIn(BaseModel):
    investigationId: str = Field(pattern=HEX24)
    machineId: str = Field(min_length=1, max_length=64)
    assetId: str | None = Field(default=None, pattern=HEX24)
    sensorId: str | None = Field(default=None, max_length=128)
    channelKey: str | None = Field(default=None, max_length=64)
    kind: Literal["threshold", "drift"] = "threshold"
    severity: Literal["warn", "alarm"] = "warn"
    openedAt: str | None = None
    trigger: dict = Field(default_factory=dict)


class ChatContext(BaseModel):
    scope: Literal["plant", "twin"] = "plant"
    assetId: str | None = Field(default=None, pattern=HEX24)
    assetName: str | None = Field(default=None, max_length=200)
    selectedMesh: str | None = Field(default=None, max_length=512)
    hoveredMesh: str | None = Field(default=None, max_length=512)
    activePanel: str | None = Field(default=None, max_length=64)
    reportId: str | None = Field(default=None, pattern=HEX24)

    @model_validator(mode="after")
    def twin_needs_asset(self):
        if self.scope == "twin" and not self.assetId:
            raise ValueError("twin scope needs an assetId")
        return self


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    threadId: str = Field(pattern=r"^[A-Za-z0-9:_-]{8,96}$")
    sessionId: str | None = Field(default=None, pattern=r"^[A-Za-z0-9_-]{8,64}$")
    context: ChatContext = Field(default_factory=ChatContext)


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


class Runtime:
    """Everything the routes share, created in the lifespan."""

    def __init__(self, settings: Settings, knowledge: Knowledge, tools: NodeTools):
        self.settings = settings
        self.knowledge = knowledge
        self.tools = tools
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.pending: set[str] = set()
        self.chat_graph = None
        self.done = 0
        self.failed = 0

    def enqueue(self, inv: dict) -> bool:
        iid = inv["investigationId"]
        if iid in self.pending:
            return False
        self.pending.add(iid)
        self.queue.put_nowait(inv)
        return True

    async def worker(self) -> None:
        while True:
            inv = await self.queue.get()
            try:
                for attempt in range(2):
                    try:
                        async with self.tools.session() as tools:
                            state = await run_investigation(inv, tools, self.knowledge)
                        result = state.get("result") or {}
                        if "failed" in result:
                            self.failed += 1
                            log.warning("investigation %s failed: %s", inv["investigationId"], result["failed"])
                        else:
                            self.done += 1
                            log.info("investigation %s reported: %s", inv["investigationId"], result)
                        break
                    except Exception as err:   # Node unreachable: try once more, then leave it for catch-up
                        log.warning("investigation %s attempt %d: %s", inv["investigationId"], attempt + 1, err)
                        await asyncio.sleep(5)
            finally:
                self.pending.discard(inv["investigationId"])
                self.queue.task_done()

    async def catch_up(self) -> None:
        """Pick up investigations opened while the agent was down or busy elsewhere."""
        await asyncio.sleep(3)
        while True:
            try:
                async with self.tools.session() as tools:
                    open_ = await tools.call("get_active_anomalies", {})
                for i in open_ or []:
                    if not i.get("reportId") and i.get("status") in ("agent_unavailable", "analysing"):
                        if self.enqueue({"investigationId": i["id"], "machineId": i["machineId"], "assetId": i.get("assetId"),
                                         "sensorId": i.get("sensorId"), "channelKey": i.get("channelKey"),
                                         "kind": i.get("kind", "threshold"), "severity": i.get("severity", "warn"),
                                         "openedAt": str(i.get("openedAt")), "trigger": i.get("trigger") or {}}):
                            log.info("catching up on investigation %s", i["id"])
            except Exception as err:
                log.debug("catch-up skipped: %s", err)
            await asyncio.sleep(CATCH_UP_SEC)


def create_app(settings: Settings | None = None, knowledge: Knowledge | None = None,
               tools: NodeTools | None = None, *, background: bool = True) -> FastAPI:
    settings = settings or load_settings()
    knowledge = knowledge or Knowledge(settings.rag_root, settings.llm_mode, settings.data_dir,
                                       rpm=settings.gemini_rpm, tpm=settings.gemini_tpm)
    rt = Runtime(settings, knowledge, tools or NodeTools(settings))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

        from .chat import build_chat_graph

        settings.data_dir.mkdir(parents=True, exist_ok=True)
        tasks = []
        async with AsyncSqliteSaver.from_conn_string(str(settings.data_dir / "threads.sqlite")) as saver:
            rt.chat_graph = build_chat_graph(saver)
            if background:
                tasks = [asyncio.create_task(rt.worker()), asyncio.create_task(rt.catch_up()),
                         asyncio.create_task(asyncio.to_thread(lambda: knowledge.available))]
            yield
            for t in tasks:
                t.cancel()

    app = FastAPI(title="Cognitive DataOps agent", version=__version__, lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runtime = rt

    def require_key(authorization: str | None = Header(default=None)) -> None:
        key = read_service_key(settings)
        if not key:
            raise HTTPException(503, "no service key yet: start the Node API once")
        presented = authorization[7:].strip() if authorization and authorization.startswith("Bearer ") else ""
        if not hmac.compare_digest(presented.encode(), key.encode()):
            raise HTTPException(401, "invalid service key")

    @app.get("/health")
    async def health():
        return {"status": "ok", "version": __version__, **knowledge.status(),
                "serviceKey": read_service_key(settings) is not None,
                "queue": rt.queue.qsize(), "reported": rt.done, "failed": rt.failed}

    @app.post("/v1/investigations", status_code=202, dependencies=[Depends(require_key)])
    async def investigations(body: InvestigationIn):
        queued = rt.enqueue(body.model_dump())
        return {"accepted": True, "queued": queued, "position": rt.queue.qsize()}

    @app.post("/v1/chat", dependencies=[Depends(require_key)])
    async def chat(body: ChatIn):
        async def stream():
            try:
                async with rt.tools.session() as tools:
                    cfg = {"configurable": {"thread_id": body.threadId, "tools": tools, "knowledge": knowledge,
                                            "max_tool_rounds": settings.max_tool_rounds,
                                            "quota_wait_sec": settings.quota_wait_sec}}
                    async for chunk in rt.chat_graph.astream({"request": body.model_dump()}, cfg, stream_mode="custom"):
                        yield sse(chunk["event"], chunk["data"])
                yield sse("done", {"threadId": body.threadId, "scope": body.context.scope})
            except ToolError as err:
                yield sse("error", {"message": str(err)})
            except Exception as err:
                log.exception("chat turn failed")
                yield sse("error", {"message": "The assistant could not answer that.", "detail": f"{type(err).__name__}: {err}"[:300]})

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    @app.get("/v1/threads/{thread_id}", dependencies=[Depends(require_key)])
    async def thread(thread_id: str):
        if not (8 <= len(thread_id) <= 96) or not all(c.isalnum() or c in ":_-" for c in thread_id):
            raise HTTPException(422, "invalid thread id")
        state = await rt.chat_graph.aget_state({"configurable": {"thread_id": thread_id}})
        return {"threadId": thread_id, "messages": (state.values or {}).get("messages", [])}

    return app
