"""Ingest the PDFs: extract, chunk, embed what is new, rebuild the FAISS index.

    python ingest.py             # incremental: only chunks never embedded before call the API
    python ingest.py --dry-run   # show what would be embedded, call nothing
    python ingest.py --rebuild   # rebuild the index from cached embeddings only, call nothing

Extraction and chunking are local and deterministic. Embeddings are cached permanently by content
hash, so a second run sends zero requests.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from collections import Counter

from rag import config, gemini
from rag.chunk import build_chunks, save_chunks
from rag.store import VectorStore


def cached_keys() -> set[str]:
    if not config.EMBED_CACHE_PATH.exists():
        return set()
    con = sqlite3.connect(config.EMBED_CACHE_PATH)
    keys = {r[0] for r in con.execute("SELECT k FROM kv")}
    con.close()
    return keys


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="report what would be embedded, call nothing")
    ap.add_argument("--rebuild", action="store_true", help="rebuild the index from the cache, call nothing")
    args = ap.parse_args()

    chunks = build_chunks()
    per_doc = Counter((c["machine"], c["filename"]) for c in chunks)
    print(f"Extracted {len(per_doc)} PDFs into {len(chunks)} chunks")
    for (machine, name), n in sorted(per_doc.items()):
        print(f"  {machine:15s} {n:3d} chunks  {name}")

    have = cached_keys()
    texts = [c["embed_text"] for c in chunks]
    new = [t for t in texts if gemini._embed_key(t, "document") not in have]
    print(f"Embeddings: {len(texts) - len(new)} cached, {len(new)} new "
          f"(about {sum(len(t) for t in new) // 4:,} tokens to send)")
    print(f"Embedding requests logged today: {gemini.requests_today(config.EMBEDDING_MODEL)} "
          f"of a {config.EMBEDDING_RPD_LIMIT} budget")
    if args.dry_run:
        return 0
    if args.rebuild and new:
        print("--rebuild needs every chunk in the cache; run without it to embed the new ones.")
        return 1

    vectors, sent = gemini.embed(texts, "document", progress=True)
    save_chunks(chunks)
    VectorStore.build(vectors, chunks).save()
    print(f"Sent {sent} texts to the embedding API. Index saved to {config.STORE_DIR} "
          f"({len(chunks)} vectors, dim {vectors.shape[1]}).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
