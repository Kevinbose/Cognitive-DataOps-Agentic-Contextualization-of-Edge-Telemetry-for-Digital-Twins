"""The RAG module in RAG/, used in-process, and the one door to Gemini.

Retrieval is the RAG module's own hybrid retriever (dense plus BM25, stage-aware
context for diagnostic questions). When no Gemini key is configured, the daily
budget is spent or the embedding call fails, it falls back to the same
retriever's BM25 mode, which needs no network, so citations never disappear.

Every Gemini request goes through the RAG module's rate limiter and usage log,
so the agent and the RAG scripts share one quota and one record. Calls are
serialised with a lock, as the RAG module expects, and are never retried here:
a chat turn that meets a 429 answers from the rule-based path instead of
waiting minutes.
"""
from __future__ import annotations

import importlib
import json
import logging
import os
import re
import shutil
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("cdo_agent.rag")

DEGRADE_SECONDS = 300


@dataclass
class Evidence:
    ref: str
    chunk_id: str
    machine: str
    document: str
    document_type: str
    section: str
    page: int | None
    filename: str
    text: str
    fault_codes: list[str]
    score: float

    def citation(self) -> dict:
        return {"chunkId": self.chunk_id, "ref": self.ref, "document": self.document[:200],
                "section": (self.section or "")[:300] or None, "page": self.page, "filename": self.filename[:200]}

    def excerpt(self, chars: int = 900) -> str:
        text = re.sub(r"\s+", " ", self.text).strip()
        return text if len(text) <= chars else text[:chars].rsplit(" ", 1)[0] + " ..."


class Knowledge:
    """Lazy wrapper: importing faiss and loading the index happens on first use."""

    def __init__(self, rag_root: Path, llm_mode: str = "auto", cache_dir: Path | None = None,
                 rpm: int | None = None, tpm: int | None = None):
        self.rag_root = Path(rag_root)
        self.llm_mode = llm_mode
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.rpm = rpm
        self.tpm = tpm
        self._lock = threading.Lock()
        self._mods: dict[str, Any] | None = None
        self._load_error: str | None = None
        self._degraded_until = 0.0
        self._degraded_reason: str | None = None

    # --- loading ---------------------------------------------------------
    def _modules(self) -> dict[str, Any] | None:
        if self._mods is not None or self._load_error:
            return self._mods
        try:
            if str(self.rag_root) not in sys.path:
                sys.path.insert(0, str(self.rag_root))
            mods = {name: importlib.import_module(f"rag.{name}") for name in ("config", "gemini", "retrieve")}
            if self.cache_dir:
                # New query embeddings go to the agent's own copy of the cache: the
                # one in RAG/data is a tracked file and stays as the RAG author left it.
                own = self.cache_dir / "embedding_cache.sqlite"
                if not own.exists() and mods["config"].EMBED_CACHE_PATH.exists():
                    own.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(mods["config"].EMBED_CACHE_PATH, own)
                mods["config"].EMBED_CACHE_PATH = own
            # The account's real per-minute limits for the generation model. The
            # shared limiter object is adjusted in place, so the RAG scripts that
            # run in this process obey the same ceiling.
            lim = mods["gemini"]._gen_limiter
            if self.rpm:
                lim.rpm = self.rpm
            if self.tpm:
                lim.tpm = self.tpm
            mods["retriever"] = mods["retrieve"].default_retriever()
            self._mods = mods
        except Exception as err:  # missing index, missing package: degrade, do not crash
            self._load_error = f"{type(err).__name__}: {err}"
            log.warning("RAG module unavailable: %s", self._load_error)
        return self._mods

    @property
    def available(self) -> bool:
        return self._modules() is not None

    @property
    def model(self) -> str | None:
        m = self._modules()
        return m["config"].GENERATION_MODEL if m else None

    @property
    def doc_machines(self) -> list[str]:
        """The machines the manuals were written for (the RAG module's own list)."""
        m = self._modules()
        return sorted(m["config"].MACHINE_DIRS) if m else []

    def doc_machine(self, machine_id: str | None, machine_type: str | None = None) -> str | None:
        """Whose manuals answer for a machine: its own, else its type's reference machine."""
        if machine_id in self.doc_machines:
            return machine_id
        from .knowledge import REFERENCE_MACHINE
        ref = REFERENCE_MACHINE.get(machine_type or "")
        return ref if ref in self.doc_machines else None

    @property
    def limits(self) -> dict:
        m = self._modules()
        if not m:
            return {}
        lim = m["gemini"]._gen_limiter
        return {"rpm": lim.rpm, "tpm": lim.tpm, "rpd": lim.rpd}

    def has_key(self) -> bool:
        self._modules()   # rag.config loads RAG/.env
        return bool(os.environ.get("GEMINI_API_KEY"))

    @property
    def llm_ready(self) -> bool:
        return (self.llm_mode != "off" and self.available and self.has_key()
                and time.time() >= self._degraded_until)

    def degrade(self, reason: str, seconds: int = DEGRADE_SECONDS) -> None:
        self._degraded_until = time.time() + seconds
        self._degraded_reason = reason
        log.warning("Gemini degraded for %ss: %s", seconds, reason)

    def status(self) -> dict:
        if not self.available:
            return {"rag": "unavailable", "llm": "off", "detail": self._load_error}
        if self.llm_mode == "off":
            llm = "off"
        elif not self.has_key():
            llm = "no-key"
        elif time.time() < self._degraded_until:
            llm = "degraded"
        else:
            llm = self.model
        return {"rag": "hybrid" if llm == self.model else "bm25", "llm": llm,
                "detail": self._degraded_reason if llm == "degraded" else None, "limits": self.limits}

    # --- retrieval -------------------------------------------------------
    def retrieve(self, query: str, machine: str | None, telemetry: dict | None = None,
                 k: int = 6) -> tuple[list[Evidence], str]:
        """Evidence for a query, restricted to one machine. Returns (evidence, mode)."""
        m = self._modules()
        if not m:
            return [], "unavailable"
        question = query
        if telemetry:
            question = "Telemetry: " + "; ".join(f"{c} = {v}" for c, v in telemetry.items()) + ". " + query
        mode = "hybrid" if self.llm_ready else "bm25"
        # BM25 alone lets the cover pages win (every cover repeats the sensor names),
        # and only the hybrid mode applies the RAG module's cover penalty. Ask for
        # more and drop covers so both modes return content.
        want = k + 6 if mode == "bm25" else k
        with self._lock:
            try:
                _, hits = m["retriever"].retrieve(question, machine, k=want, mode=mode)
            except Exception as err:
                if mode == "bm25":
                    raise
                self.degrade(f"embedding failed: {str(err)[:160]}")
                mode = "bm25"
                _, hits = m["retriever"].retrieve(question, machine, k=k + 6, mode=mode)
        content = [h for h in hits if not str(h.chunk.get("section") or "").startswith("Cover")]
        hits = (content or hits)[:k]
        out = []
        for n, h in enumerate(hits, start=1):
            c = h.chunk
            out.append(Evidence(f"S{n}", c["chunk_id"], c["machine"], c["document"], c["document_type"],
                                c.get("section") or "", c.get("page"), c.get("filename") or "", c["text"],
                                list(c.get("fault_codes") or []), round(float(h.score), 4)))
        return out, mode

    # --- generation ------------------------------------------------------
    def quota_wait_seconds(self) -> float:
        """How long the next generation request would wait in the shared limiter."""
        m = self._modules()
        if not m:
            return 0.0
        lim = m["gemini"]._gen_limiter
        now = time.monotonic()
        recent = [e for e in lim.events if now - e[0] < 60]
        if sum(e[1] for e in recent) + 1 <= lim.rpm:
            return 0.0
        return max(0.0, 60 - (now - recent[0][0]))

    def _call_once(self, operation: str, est_tokens: int, fn):
        """One generation request under the shared limiter and usage log, no retries."""
        m = self._modules()
        g, cfg = m["gemini"], m["config"]
        with self._lock:
            g._gen_limiter.acquire(1, est_tokens)
            try:
                result, usage = fn()
            except Exception as err:
                status = g._status_of(err)
                g.log_usage(model=cfg.GENERATION_MODEL, operation=operation, requests=1, success=False,
                            http_status=status, retry_count=0, error=str(err)[:300])
                if status in (429, 500, 503) or isinstance(err, g.QuotaExceeded):
                    self.degrade(f"HTTP {status}" if status else str(err)[:160], 120 if status != 429 else DEGRADE_SECONDS)
                raise
            g.log_usage(model=cfg.GENERATION_MODEL, operation=operation, requests=1, success=True,
                        http_status=200, retry_count=0, est_tokens=est_tokens, **usage)
            return result

    def generate_json(self, prompt: str, system: str, operation: str = "agent_report",
                      max_output_tokens: int = 2048) -> dict | None:
        """A JSON object from Gemini, or None (no key, quota, error, unparseable)."""
        if not self.llm_ready:
            return None
        m = self._modules()
        from google.genai import types

        def fn():
            resp = m["gemini"].client().models.generate_content(
                model=m["config"].GENERATION_MODEL, contents=prompt,
                config=types.GenerateContentConfig(system_instruction=system, temperature=0.2,
                                                   max_output_tokens=max_output_tokens,
                                                   response_mime_type="application/json"))
            return resp.text or "", _usage(resp)

        try:
            text = self._call_once(operation, (len(prompt) + len(system)) // 3, fn)
        except Exception as err:
            log.warning("report generation failed: %s", err)
            return None
        try:
            data = json.loads(_strip_fences(text))
            return data if isinstance(data, dict) else None
        except json.JSONDecodeError:
            log.warning("report generation returned non-JSON text")
            return None

    def chat_step(self, contents: list, system: str, declarations: list[dict], operation: str = "agent_chat"):
        """One model turn with tools. Returns the raw response; the caller runs the tools."""
        m = self._modules()
        from google.genai import types

        tools = [types.Tool(function_declarations=[
            types.FunctionDeclaration(name=d["name"], description=d["description"],
                                      parameters_json_schema=d["parameters"]) for d in declarations])] if declarations else None

        def fn():
            resp = m["gemini"].client().models.generate_content(
                model=m["config"].GENERATION_MODEL, contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=system, temperature=0.3, max_output_tokens=1500, tools=tools,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True)))
            return resp, _usage(resp)

        est = sum(len(str(c)) for c in contents) // 3 + len(system) // 3 + 500
        return self._call_once(operation, est, fn)


def _usage(resp) -> dict:
    um = getattr(resp, "usage_metadata", None)
    return {"prompt_tokens": getattr(um, "prompt_token_count", None),
            "output_tokens": getattr(um, "candidates_token_count", None),
            "thinking_tokens": getattr(um, "thoughts_token_count", None)}


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t
