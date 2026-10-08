"""Persistent FAISS vector store with metadata filtering.

The index is an exact inner-product index over unit vectors (cosine similarity). At this corpus
size exact search is instant, so nothing is approximated. Row i of the index is chunk i of the
metadata file, and a machine filter is applied inside the search with an ID selector.
"""
from __future__ import annotations

import json
from pathlib import Path

import faiss
import numpy as np

from . import config

INDEX_FILE = "index.faiss"
META_FILE = "chunks.json"


class VectorStore:
    def __init__(self, index: faiss.Index, chunks: list[dict]):
        self.index = index
        self.chunks = chunks

    @classmethod
    def build(cls, vectors: np.ndarray, chunks: list[dict]) -> "VectorStore":
        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(np.ascontiguousarray(vectors, dtype=np.float32))
        return cls(index, chunks)

    def save(self, folder: Path = config.STORE_DIR) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        faiss.write_index(self.index, str(folder / INDEX_FILE))
        manifest = {"embedding_model": config.EMBEDDING_MODEL, "dim": self.index.d, "chunks": self.chunks}
        (folder / META_FILE).write_text(json.dumps(manifest, ensure_ascii=False))

    @classmethod
    def load(cls, folder: Path = config.STORE_DIR) -> "VectorStore":
        if not (folder / INDEX_FILE).exists():
            raise FileNotFoundError("No vector store found. Run `python ingest.py` first.")
        manifest = json.loads((folder / META_FILE).read_text())
        if manifest["embedding_model"] != config.EMBEDDING_MODEL:
            raise RuntimeError(
                f"The store was built with {manifest['embedding_model']} but the configured model is "
                f"{config.EMBEDDING_MODEL}. Run `python ingest.py` to re-embed.")
        return cls(faiss.read_index(str(folder / INDEX_FILE)), manifest["chunks"])

    def ids_where(self, **equals) -> list[int]:
        """Row ids whose metadata matches every key=value given (None values are ignored)."""
        wanted = {k: v for k, v in equals.items() if v is not None}
        return [i for i, c in enumerate(self.chunks) if all(c.get(k) == v for k, v in wanted.items())]

    def search(self, query_vec: np.ndarray, k: int, ids: list[int] | None = None) -> list[tuple[int, float]]:
        """Top-k (row id, cosine similarity), restricted to ids when given."""
        q = np.ascontiguousarray(query_vec.reshape(1, -1), dtype=np.float32)
        if ids is None:
            scores, rows = self.index.search(q, k)
        else:
            if not ids:
                return []
            selector = faiss.IDSelectorBatch(np.asarray(ids, dtype=np.int64))
            scores, rows = self.index.search(q, min(k, len(ids)), params=faiss.SearchParameters(sel=selector))
        return [(int(r), float(s)) for r, s in zip(rows[0], scores[0]) if r >= 0]
