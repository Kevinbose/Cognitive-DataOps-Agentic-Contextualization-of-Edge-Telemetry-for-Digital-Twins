"""Paths, model names and quota settings. Everything is overridable from the environment."""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

RAG_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(RAG_ROOT / ".env")


def _int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


# --- knowledge base -------------------------------------------------------
MACHINE_DIRS = {
    "press-stamp-01": RAG_ROOT / "PRESS_STAMP",
    "robot-weld-01": RAG_ROOT / "ROBOT_WELD",
}
MACHINE_LABELS = {
    "press-stamp-01": "Stamping press 01",
    "robot-weld-01": "Robot Weld 01",
}
DOC_TYPES = {
    "01": "operating_conditions",
    "02": "failure_modes",
    "03": "diagnostic_procedures",
    "04": "maintenance",
    "05": "case_history",
}

# --- persistent artefacts -------------------------------------------------
DATA_DIR = RAG_ROOT / "data"
CHUNKS_PATH = DATA_DIR / "chunks" / "chunks.jsonl"
EMBED_CACHE_PATH = DATA_DIR / "embeddings" / "embedding_cache.sqlite"
STORE_DIR = DATA_DIR / "vector_store"
LOG_DIR = RAG_ROOT / "logs"
USAGE_LOG = LOG_DIR / "api_usage.jsonl"
EVAL_DIR = RAG_ROOT / "evaluation"
EVAL_CACHE_PATH = EVAL_DIR / "cache" / "generation_cache.sqlite"
EVAL_RESULTS_DIR = EVAL_DIR / "results"
EVAL_QUESTIONS_DIR = EVAL_DIR / "questions"

# --- models ---------------------------------------------------------------
GENERATION_MODEL = os.environ.get("GEMINI_GENERATION_MODEL", "gemini-3.5-flash-lite")
EMBEDDING_MODEL = os.environ.get("GEMINI_EMBEDDING_MODEL", "gemini-embedding-2")
EMBEDDING_DIM = _int("GEMINI_EMBEDDING_DIM", 3072)

# --- quota ceilings (kept below the real limits on purpose) ---------------
GENERATION_RPM_LIMIT = _int("GEMINI_GENERATION_RPM_LIMIT", 5)        # gemini-3.5-flash-lite key: 5 RPM
GENERATION_RPD_LIMIT = _int("GEMINI_GENERATION_RPD_LIMIT", 350)      # real: 500
GENERATION_TPM_LIMIT = _int("GEMINI_GENERATION_TPM_LIMIT", 250_000)  # gemini-3.5-flash-lite key: 250k TPM
EMBEDDING_RPM_LIMIT = _int("GEMINI_EMBEDDING_RPM_LIMIT", 80)         # real: 100
EMBEDDING_RPD_LIMIT = _int("GEMINI_EMBEDDING_RPD_LIMIT", 800)        # real: 1000
EMBEDDING_TPM_LIMIT = _int("GEMINI_EMBEDDING_TPM_LIMIT", 24_000)     # real: 30k
EMBEDDING_BATCH_SIZE = _int("GEMINI_EMBEDDING_BATCH_SIZE", 8)
MAX_RETRIES = _int("GEMINI_MAX_RETRIES", 4)

# --- chunking -------------------------------------------------------------
CHUNK_TARGET_CHARS = _int("RAG_CHUNK_TARGET_CHARS", 3000)   # about 750 tokens
CHUNK_MAX_CHARS = _int("RAG_CHUNK_MAX_CHARS", 4200)         # about 1000 tokens
CHUNK_OVERLAP_CHARS = _int("RAG_CHUNK_OVERLAP_CHARS", 500)

# --- retrieval / generation ----------------------------------------------
RETRIEVE_CANDIDATES = _int("RAG_RETRIEVE_CANDIDATES", 40)
CONTEXT_TOP_K = _int("RAG_CONTEXT_TOP_K", 6)
CONTEXT_TOP_K_DIAGNOSTIC = _int("RAG_CONTEXT_TOP_K_DIAGNOSTIC", 8)  # a diagnosis needs every stage
PROMPT_VERSION = "v3"
INSUFFICIENT_PHRASE = (
    "The available technical documentation does not provide sufficient information to determine this."
)
