"""The Node API's MCP endpoint, through the official MCP Python client.

One session per unit of work (an investigation, a chat turn). The server is
stateless Streamable HTTP, so a session costs one initialise round trip.
Tool results are JSON text; they are parsed here, and a tool error becomes a
`ToolError` with the server's message.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

from .config import Settings, read_service_key


class ToolError(RuntimeError):
    """The tool ran and refused (bad input, unknown mesh) or failed."""


class ToolSession(Protocol):
    async def call(self, name: str, args: dict | None = None) -> Any: ...


class McpToolSession:
    def __init__(self, session: ClientSession):
        self._session = session
        self.calls: list[dict] = []

    async def call(self, name: str, args: dict | None = None) -> Any:
        result = await self._session.call_tool(name, args or {})
        text = "".join(getattr(c, "text", "") for c in result.content or [])
        self.calls.append({"name": name, "ok": not result.isError})
        if result.isError:
            raise ToolError(text or f"{name} failed")
        try:
            return json.loads(text) if text else None
        except json.JSONDecodeError:
            return text

    async def list_tools(self) -> list[dict]:
        listed = await self._session.list_tools()
        return [{"name": t.name, "description": t.description or "", "inputSchema": t.inputSchema or {}}
                for t in listed.tools]


class NodeTools:
    def __init__(self, settings: Settings):
        self.settings = settings

    @asynccontextmanager
    async def session(self) -> AsyncIterator[McpToolSession]:
        key = read_service_key(self.settings)
        if not key:
            raise ToolError("no service key yet: start the Node API once so it creates storage/.agent/service.key")
        async with streamablehttp_client(self.settings.mcp_url, headers={"Authorization": f"Bearer {key}"},
                                         timeout=15, sse_read_timeout=60) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield McpToolSession(session)
