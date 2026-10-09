"""Settings, read once from the environment. Every value has a working local default."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_ROOT.parent.parent


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    node_url: str
    key_file: Path
    service_key: str | None
    rag_root: Path
    llm_mode: str            # auto: use Gemini when a key is present; off: never
    data_dir: Path
    max_tool_rounds: int
    gemini_rpm: int          # requests a minute the key allows for the generation model
    gemini_tpm: int          # tokens a minute
    quota_wait_sec: int      # longest a chat turn waits for quota before answering without the model

    @property
    def mcp_url(self) -> str:
        return f"{self.node_url}/mcp"


def load_settings() -> Settings:
    data_dir = Path(os.environ.get("AGENT_DATA_DIR", AGENT_ROOT / ".data"))
    return Settings(
        host=os.environ.get("AGENT_HOST", "127.0.0.1"),
        port=_int("AGENT_PORT", 8100),
        node_url=os.environ.get("AGENT_NODE_URL", "http://127.0.0.1:5000").rstrip("/"),
        key_file=Path(os.environ.get("AGENT_KEY_FILE", REPO_ROOT / "storage" / ".agent" / "service.key")),
        service_key=os.environ.get("AGENT_SERVICE_KEY") or None,
        rag_root=Path(os.environ.get("AGENT_RAG_ROOT", REPO_ROOT / "RAG")),
        llm_mode=os.environ.get("AGENT_LLM", "auto").strip().lower(),
        data_dir=data_dir,
        max_tool_rounds=_int("AGENT_MAX_TOOL_ROUNDS", 4),
        # gemini-3.5-flash-lite on this project's key: 5 requests and 250k tokens a minute
        gemini_rpm=_int("AGENT_GEMINI_RPM", 5),
        gemini_tpm=_int("AGENT_GEMINI_TPM", 250_000),
        quota_wait_sec=_int("AGENT_QUOTA_WAIT_SEC", 30),
    )


def read_service_key(settings: Settings) -> str | None:
    """The key shared with the Node API: the variable, or the file Node creates at start-up.

    Read on every call until it exists, so the agent can start before the API.
    """
    if settings.service_key:
        return settings.service_key
    try:
        key = settings.key_file.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return key if len(key) >= 32 else None
