"""python -m cdo_agent: run the agent on AGENT_HOST:AGENT_PORT (127.0.0.1:8100)."""
from __future__ import annotations

import logging

import uvicorn

from .app import create_app
from .config import load_settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[agent] %(levelname)s %(name)s: %(message)s")
    settings = load_settings()
    app = create_app(settings)
    status = app.state.runtime.knowledge.status()
    logging.getLogger("cdo_agent").info(
        "listening on http://%s:%s, Node at %s, model %s, retrieval %s",
        settings.host, settings.port, settings.node_url, status["llm"], status["rag"])
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
