"""Quota-aware Gemini access: one place for rate limits, backoff, the usage log and both caches.

Every network call in this module is sequential. Nothing here retries in parallel, and a daily
budget read back from the usage log refuses work before the real quota is reached.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import time
from collections import deque
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np

from . import config

_QUOTA_TZ = ZoneInfo("America/Los_Angeles")  # Gemini daily quotas reset at midnight Pacific
_client = None


class QuotaExceeded(RuntimeError):
    """Raised before a call that would cross a configured daily budget."""


def client():
    global _client
    if _client is None:
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY is not set. Copy RAG/.env.example to RAG/.env and fill it in.")
        from google import genai
        from google.genai import types
        # the SDK's own retry loop is switched off: backoff is handled in _call, one try at a time
        _client = genai.Client(api_key=key, http_options=types.HttpOptions(
            retry_options=types.HttpRetryOptions(attempts=1)))
    return _client


# --- usage log ------------------------------------------------------------
def _quota_day(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), _QUOTA_TZ).strftime("%Y-%m-%d")


def log_usage(**record) -> None:
    config.LOG_DIR.mkdir(parents=True, exist_ok=True)
    record = {"timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
              "quota_day": _quota_day(), **record}
    with config.USAGE_LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")


def requests_today(model: str) -> int:
    """Requests already sent to a model in the current quota day, counted from the log."""
    if not config.USAGE_LOG.exists():
        return 0
    today, total = _quota_day(), 0
    with config.USAGE_LOG.open() as f:
        for line in f:
            r = json.loads(line)
            if r.get("model") == model and r.get("quota_day") == today:
                total += r.get("requests", 1)
    return total


# --- rate limiting --------------------------------------------------------
class RateLimiter:
    """Sliding 60 s window on requests and tokens, plus a daily request budget."""

    def __init__(self, model: str, rpm: int, tpm: int, rpd: int):
        self.model, self.rpm, self.tpm, self.rpd = model, rpm, tpm, rpd
        self.events: deque[tuple[float, int, int]] = deque()  # (time, requests, tokens)

    def acquire(self, requests: int, tokens: int) -> None:
        used = requests_today(self.model)
        if used + requests > self.rpd:
            raise QuotaExceeded(
                f"{self.model}: {used} requests logged today, the configured daily budget is {self.rpd}.")
        while True:
            now = time.monotonic()
            while self.events and now - self.events[0][0] >= 60:
                self.events.popleft()
            req = sum(e[1] for e in self.events)
            tok = sum(e[2] for e in self.events)
            if not self.events or (req + requests <= self.rpm and tok + tokens <= self.tpm):
                break
            time.sleep(max(0.5, 60 - (now - self.events[0][0]) + 0.2))
        self.events.append((time.monotonic(), requests, tokens))


_gen_limiter = RateLimiter(config.GENERATION_MODEL, config.GENERATION_RPM_LIMIT,
                           config.GENERATION_TPM_LIMIT, config.GENERATION_RPD_LIMIT)
_emb_limiter = RateLimiter(config.EMBEDDING_MODEL, config.EMBEDDING_RPM_LIMIT,
                           config.EMBEDDING_TPM_LIMIT, config.EMBEDDING_RPD_LIMIT)


def _status_of(err: Exception) -> int | None:
    code = getattr(err, "code", None) or getattr(err, "status_code", None)
    return code if isinstance(code, int) else None


def _retry_delay(err: Exception, attempt: int) -> float:
    """Server-suggested delay when present, otherwise exponential backoff from 20 s."""
    m = re.search(r"retry(?:Delay)?['\"]?\s*[:=]?\s*['\"]?(\d+(?:\.\d+)?)s", str(err), re.I)
    suggested = float(m.group(1)) + 2 if m else 0
    return min(max(suggested, 20 * 2 ** attempt), 300)


def _call(operation: str, model: str, limiter: RateLimiter, requests: int, est_tokens: int, fn):
    """Run one API call under the limiter. 429 and 5xx back off; anything else is raised."""
    for attempt in range(config.MAX_RETRIES + 1):
        limiter.acquire(requests, est_tokens)
        try:
            result, usage = fn()
            log_usage(model=model, operation=operation, requests=requests, success=True,
                      http_status=200, retry_count=attempt, est_tokens=est_tokens, **usage)
            return result
        except Exception as err:  # the SDK raises errors.APIError subclasses
            status = _status_of(err)
            log_usage(model=model, operation=operation, requests=requests, success=False,
                      http_status=status, retry_count=attempt, error=str(err)[:300])
            if status not in (429, 500, 503) or attempt == config.MAX_RETRIES:
                raise
            delay = _retry_delay(err, attempt)
            print(f"[gemini] HTTP {status} on {operation}; backing off {delay:.0f} s "
                  f"(retry {attempt + 1}/{config.MAX_RETRIES})")
            time.sleep(delay)


# --- embeddings with a permanent cache -----------------------------------
def _db(path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v BLOB, meta TEXT)")
    return con


def _embed_key(text: str, task: str) -> str:
    raw = f"{config.EMBEDDING_MODEL}|{config.EMBEDDING_DIM}|{task}|{text}"
    return hashlib.sha256(raw.encode()).hexdigest()


def _format_for_embedding(text: str, task: str) -> str:
    # gemini-embedding-2 takes the task as an instruction in the text itself
    if task == "query":
        return f"task: search result | query: {text}"
    return f"title: none | text: {text}"


def embed(texts: list[str], task: str, progress: bool = False) -> tuple[np.ndarray, int]:
    """Unit-normalised embeddings for texts. Returns (vectors, number of texts sent to the API).

    task is "document" or "query". A text that was embedded before is read from the cache and
    costs nothing, so re-running ingestion or an evaluation makes no embedding calls.
    """
    from google.genai import types

    con = _db(config.EMBED_CACHE_PATH)
    keys = [_embed_key(t, task) for t in texts]
    vectors: dict[str, np.ndarray] = {}
    for k in set(keys):
        row = con.execute("SELECT v FROM kv WHERE k = ?", (k,)).fetchone()
        if row:
            vectors[k] = np.frombuffer(row[0], dtype=np.float32)
    missing = [(k, t) for k, t in dict(zip(keys, texts)).items() if k not in vectors]
    sent = len(missing)
    batch: list[tuple[str, str]] = []

    def run(batch):
        payload = [_format_for_embedding(t, task) for _, t in batch]
        est = sum(len(p) for p in payload) // 3 + 1

        def fn():
            resp = client().models.embed_content(
                model=config.EMBEDDING_MODEL,
                contents=[types.Content(parts=[types.Part(text=p)]) for p in payload],
                config=types.EmbedContentConfig(output_dimensionality=config.EMBEDDING_DIM),
            )
            if len(resp.embeddings) != len(payload):
                raise RuntimeError(f"expected {len(payload)} embeddings, got {len(resp.embeddings)}")
            return resp, {}

        resp = _call(f"embed_{task}", config.EMBEDDING_MODEL, _emb_limiter, len(batch), est, fn)
        for (k, _), e in zip(batch, resp.embeddings):
            v = np.asarray(e.values, dtype=np.float32)
            v /= np.linalg.norm(v) or 1.0
            vectors[k] = v
            con.execute("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)",
                        (k, v.tobytes(), json.dumps({"task": task, "model": config.EMBEDDING_MODEL})))
        con.commit()  # persisted per batch: an interrupted run resumes where it stopped

    done = 0
    for item in missing:
        batch.append(item)
        if len(batch) >= config.EMBEDDING_BATCH_SIZE or sum(len(t) for _, t in batch) > 18_000:
            run(batch)
            done += len(batch)
            batch = []
            if progress:
                print(f"  embedded {done}/{sent}", flush=True)
    if batch:
        run(batch)
    con.close()
    return np.vstack([vectors[k] for k in keys]) if keys else np.zeros((0, config.EMBEDDING_DIM), np.float32), sent


# --- generation with a cache ---------------------------------------------
def generate(prompt: str, system: str, *, operation: str = "generate", use_cache: bool = True,
             temperature: float = 0.0, max_output_tokens: int = 1500,
             json_output: bool = False) -> tuple[str, bool]:
    """Answer text and whether it came from the cache.

    The cache key covers the model, the prompt version, the system prompt and the full prompt
    (which contains the retrieved context), so any change to those makes a fresh call.
    """
    from google.genai import types

    raw = f"{config.GENERATION_MODEL}|{config.PROMPT_VERSION}|{temperature}|{system}|{prompt}"
    key = hashlib.sha256(raw.encode()).hexdigest()
    con = _db(config.EVAL_CACHE_PATH)
    if use_cache:
        row = con.execute("SELECT v FROM kv WHERE k = ?", (key,)).fetchone()
        if row:
            con.close()
            return row[0], True

    def fn():
        resp = client().models.generate_content(
            model=config.GENERATION_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system, temperature=temperature,
                max_output_tokens=max_output_tokens,
                response_mime_type="application/json" if json_output else None,
            ),
        )
        um = resp.usage_metadata
        usage = {"prompt_tokens": getattr(um, "prompt_token_count", None),
                 "output_tokens": getattr(um, "candidates_token_count", None),
                 "thinking_tokens": getattr(um, "thoughts_token_count", None)}
        return resp.text or "", usage

    text = _call(operation, config.GENERATION_MODEL, _gen_limiter, 1, len(raw) // 3, fn)
    con.execute("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)",
                (key, text, json.dumps({"model": config.GENERATION_MODEL,
                                        "prompt_version": config.PROMPT_VERSION,
                                        "operation": operation})))
    con.commit()
    con.close()
    return text, False
