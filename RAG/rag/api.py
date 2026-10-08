"""The interface a diagnostic agent calls. Two functions, plain dicts in and out.

    from rag.api import retrieve_evidence, diagnose

    retrieve_evidence(query, machine="press-stamp-01")
        -> evidence only. One cached query embedding, no generation request. Use this when the
           agent does its own reasoning and only needs grounded context.

    diagnose(query, machine="press-stamp-01", telemetry={"BEARING_VIBRATION_RMS": "3.0 mm/s"})
        -> evidence plus a grounded answer and confidence. One generation request, cached.

This module is the whole integration surface. It imports nothing from outside RAG/ and it never
receives the simulator's ground truth: the caller passes readings, not the active scenario.
"""
from __future__ import annotations

from . import config
from .generate import Answer, answer
from .retrieve import Hit, QueryAnalysis, default_retriever


def _evidence(hits: list[Hit], cited: list[int] | None = None) -> list[dict]:
    out = []
    for n, h in enumerate(hits, start=1):
        c = h.chunk
        out.append({
            "ref": f"S{n}",
            "cited": (n in cited) if cited is not None else None,
            "text": c["text"],
            "machine": c["machine"],
            "document": c["document"],
            "document_type": c["document_type"],
            "section": c["section"],
            "page": c["page"],
            "page_end": c["page_end"],
            "filename": c["filename"],
            "source": c["source"],
            "chunk_id": c["chunk_id"],
            "sensors": c["sensors"],
            "components": c["components"],
            "fault_codes": c["fault_codes"],
            "score": round(h.score, 4),
            "similarity": round(h.dense, 4),
        })
    return out


def _analysis(a: QueryAnalysis) -> dict:
    return {"machine": a.machine, "machine_source": a.machine_source, "sensors": a.sensors,
            "intents": a.intents, "fault_codes": a.fault_codes, "measurements": a.measurements,
            "diagnostic": a.diagnostic}


def _with_telemetry(query: str, telemetry: dict | None) -> str:
    if not telemetry:
        return query
    readings = "; ".join(f"{channel} = {value}" for channel, value in telemetry.items())
    return f"Telemetry: {readings}. {query}"


def retrieve_evidence(query: str, machine: str | None = None, telemetry: dict | None = None,
                      k: int | None = None) -> dict:
    """Ranked evidence with source metadata. No generation call."""
    question = _with_telemetry(query, telemetry)
    analysis, hits = default_retriever().retrieve(question, machine, k=k)
    return {"query": question, "machine": analysis.machine, "analysis": _analysis(analysis),
            "evidence": _evidence(hits)}


def diagnose(query: str, machine: str | None = None, telemetry: dict | None = None,
             k: int | None = None, use_cache: bool = True) -> dict:
    """Grounded answer, the evidence behind it, and confidence information."""
    question = _with_telemetry(query, telemetry)
    ans: Answer = answer(question, machine, use_cache=use_cache, k=k)
    return {
        "query": question,
        "machine": ans.machine,
        "answer": ans.text,
        "insufficient_information": ans.insufficient,
        "confidence": ans.confidence,
        "evidence": _evidence(ans.hits, ans.cited),
        "analysis": _analysis(ans.analysis),
        "model": config.GENERATION_MODEL,
        "prompt_version": config.PROMPT_VERSION,
        "cached": ans.cached,
    }
