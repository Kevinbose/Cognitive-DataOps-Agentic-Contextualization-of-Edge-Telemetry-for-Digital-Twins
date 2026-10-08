"""Retrieval and generation benchmarks.

Scoring is deterministic first (gold sections, required values, forbidden values, numbers traced
back to the evidence). A Gemini judge is an optional second opinion, batched to a handful of calls.
Every Gemini result is cached, so re-running a benchmark with unchanged inputs costs nothing.
"""
from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path

from . import config, gemini
from .generate import answer, is_insufficient
from .retrieve import Retriever

KS = (1, 3, 5, 10)
NOT_AVAILABLE_RE = re.compile(
    r"does not provide sufficient information|not specified|not documented|not defined|"
    r"does not (?:state|specify|define|provide|contain|include|mention|document|have|give)|"
    r"no (?:information|such|value|limit|threshold) |not (?:available|given|measured|stated)", re.I)


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


# --- term matching --------------------------------------------------------
def has(term: str, text: str) -> bool:
    """Case-insensitive match. Numbers must match as whole numbers (3.6 never matches 13.6 or 3.65);
    short words must match as whole words; longer terms may be prefixes ("escalat")."""
    esc = re.escape(term)
    if re.fullmatch(r"\d+(?:\.\d+)?", term):
        return float(term) in numbers_in(text)  # 30 matches 30.0, never 130 or 30.5
    if term[0].isdigit() and term[-1].isdigit():
        pattern = rf"(?<![\d.]){esc}(?!\d|\.\d)"
    elif len(term) <= 3:
        pattern = rf"(?<![A-Za-z0-9]){esc}(?![A-Za-z0-9])"
    else:
        pattern = rf"(?<![A-Za-z0-9]){esc}"
    return re.search(pattern, text, re.I) is not None


def numbers_in(text: str) -> set[float]:
    return {float(n) for n in re.findall(r"(?<![A-Za-z\d.])\d+(?:\.\d+)?", text)}


def unsupported_numbers(answer_text: str, evidence: str) -> list[float]:
    """Numbers stated in the answer that appear neither in the evidence nor in the question."""
    body = re.sub(r"\[S\d+(?:,\s*S\d+)*\]", " ", answer_text)        # citation tags
    body = re.sub(r"(?m)^\s*\d+[.)]\s", " ", body)                    # list numbering
    return sorted(numbers_in(body) - numbers_in(evidence))


# --- retrieval benchmark --------------------------------------------------
DIAGNOSTIC_HEADINGS = ["condition", "threshold interpretation", "possible fault", "recommended inspection",
                       "recommended action", "verification"]


def load_retrieval_questions() -> list[dict]:
    """A multi-step question lists gold sections per diagnostic stage; its gold is their union."""
    questions = load_jsonl(config.EVAL_QUESTIONS_DIR / "retrieval.jsonl")
    for q in questions:
        if "stages" in q:
            gold: dict[str, list[str]] = defaultdict(list)
            for sections in q["stages"].values():
                for doc, secs in sections.items():
                    gold[doc] += [s for s in secs if s not in gold[doc]]
            q["gold"] = dict(gold)
    return questions


def _in_sections(chunk: dict, machine: str, sections: dict[str, list[str]]) -> bool:
    if chunk["machine"] != machine or chunk["doc_no"] not in sections:
        return False
    return any(sec in chunk["section_numbers"] for sec in sections[chunk["doc_no"]])


def is_relevant(chunk: dict, q: dict) -> bool:
    return _in_sections(chunk, q["machine"], q["gold"])


def stage_coverage(q: dict, chunks: list[dict]) -> float | None:
    """Share of diagnostic stages (threshold, fault, action, ...) that have evidence among chunks."""
    if "stages" not in q:
        return None
    covered = [any(_in_sections(c, q["machine"], secs) for c in chunks) for secs in q["stages"].values()]
    return sum(covered) / len(covered)


def validate_gold(questions: list[dict], chunks: list[dict]) -> list[str]:
    """Every gold section must exist, and the stated answer must be inside a gold chunk."""
    problems = []
    for q in questions:
        gold_chunks = [c for c in chunks if is_relevant(c, q)]
        for doc, secs in q["gold"].items():
            for sec in secs:
                if not any(c["machine"] == q["machine"] and c["doc_no"] == doc and sec in c["section_numbers"]
                           for c in chunks):
                    problems.append(f"{q['id']}: gold section {doc}:{sec} matches no chunk")
        terms = q.get("answer_terms")
        if terms and not any(all(has(t, c["text"]) for t in terms) for c in gold_chunks):
            problems.append(f"{q['id']}: answer terms {terms} not found together in any gold chunk")
    return problems


def run_retrieval(retriever: Retriever, mode: str = "hybrid") -> dict:
    questions = load_retrieval_questions()
    if mode != "bm25":
        gemini.embed([q["query"] for q in questions], "query")  # one batched, cached pass
    rows = []
    for q in questions:
        machine_arg = q["machine"] if q.get("machine_arg") else None
        analysis, ranked = retriever.rank(q["query"], machine_arg, mode=mode)
        hits = ranked[:max(KS)]
        _, context = retriever.retrieve(q["query"], machine_arg, mode=mode)  # what the model would get
        rel = [is_relevant(h.chunk, q) for h in hits]
        first = next((i + 1 for i, r in enumerate(rel) if r), None)
        top5 = hits[:5]
        terms = q.get("answer_terms")
        rows.append({
            "id": q["id"], "machine": q["machine"], "category": q["category"], "query": q["query"],
            "detected_machine": analysis.machine, "machine_source": analysis.machine_source,
            "first_relevant_rank": first,
            "top": [{"chunk_id": h.chunk["chunk_id"], "section": h.chunk["section"], "page": h.chunk["page"],
                     "score": round(h.score, 4), "relevant": r} for h, r in zip(hits, rel)],
            "top5_same_machine": all(h.chunk["machine"] == q["machine"] for h in top5),
            "stage_coverage": stage_coverage(q, [h.chunk for h in context]),
            "context_size": len(context), "treated_as_diagnostic": analysis.diagnostic,
            "context_has_gold": any(is_relevant(h.chunk, q) for h in context),
            "context_same_machine": all(h.chunk["machine"] == q["machine"] for h in context),
            "answer_terms_in_top5": (any(h.chunk["machine"] == q["machine"]
                                         and all(has(t, h.chunk["text"]) for t in terms) for h in top5)
                                     if terms else None),
        })
    n = len(rows)
    summary = {f"recall@{k}": sum(1 for r in rows if r["first_relevant_rank"] and r["first_relevant_rank"] <= k) / n
               for k in KS}
    summary["mrr@10"] = sum(1 / r["first_relevant_rank"] for r in rows if r["first_relevant_rank"]) / n
    with_terms = [r for r in rows if r["answer_terms_in_top5"] is not None]
    summary["answer_terms@5"] = sum(r["answer_terms_in_top5"] for r in with_terms) / max(len(with_terms), 1)
    summary["answer_terms_n"] = len(with_terms)
    summary["machine_isolation@5"] = sum(r["top5_same_machine"] for r in rows) / n
    summary["context_hit_rate"] = sum(r["context_has_gold"] for r in rows) / n
    summary["context_isolation"] = sum(r["context_same_machine"] for r in rows) / n
    staged = [r["stage_coverage"] for r in rows if r["stage_coverage"] is not None]
    summary["multi_step_n"] = len(staged)
    summary["multi_step_stage_coverage"] = sum(staged) / len(staged) if staged else None
    summary["multi_step_full_coverage"] = sum(c == 1.0 for c in staged) / len(staged) if staged else None
    summary["n"] = n
    by = defaultdict(list)
    for r in rows:
        by[r["machine"]].append(r)
        by[r["category"]].append(r)
    summary["recall@5_by_group"] = {
        g: {"n": len(rs), "recall@5": sum(1 for r in rs if r["first_relevant_rank"] and r["first_relevant_rank"] <= 5) / len(rs)}
        for g, rs in sorted(by.items())}
    return {"mode": mode, "summary": summary, "rows": rows}


# --- generation benchmark -------------------------------------------------
def score_answer(q: dict, text: str, evidence: str, cited: list[int]) -> dict:
    missing = [t for t in q.get("must_all", []) if not has(t, text)]
    missing += [" | ".join(g) for g in q.get("must_any", []) if not any(has(t, text) for t in g)]
    forbidden = [t for t in q.get("must_not", []) if has(t, text)]
    refused = is_insufficient(text)
    if q.get("expect_insufficient"):
        declined = bool(NOT_AVAILABLE_RE.search(text))
        correct = declined and not forbidden
    else:
        declined = refused
        correct = not missing and not forbidden and not refused
    bad_numbers = unsupported_numbers(text, evidence + " " + q["question"])
    structure = None
    if q["category"] == "diagnostic":
        structure = sum(h in text.lower() for h in DIAGNOSTIC_HEADINGS) / len(DIAGNOSTIC_HEADINGS)
    return {
        "structure_coverage": structure,
        "correct": correct, "missing": missing, "forbidden_found": forbidden, "declined": declined,
        "unsupported_numbers": bad_numbers,
        "cites_evidence": bool(cited) or declined,
        "grounded": not bad_numbers and (bool(cited) or declined),
    }


def run_generation(retriever: Retriever, limit: int | None = None) -> dict:
    """One generation call per question the cache has not seen. Safe to interrupt and resume."""
    questions = load_jsonl(config.EVAL_QUESTIONS_DIR / "generation.jsonl")[:limit]
    rows, fresh_calls, stopped = [], 0, None
    for q in questions:
        try:
            ans = answer(q["question"], q["machine"] if q.get("machine_arg") else None, retriever=retriever)
        except gemini.QuotaExceeded as err:
            stopped = str(err)
            break
        fresh_calls += not ans.cached
        evidence = "\n".join(h.chunk["text"] + " " + h.chunk["section"] for h in ans.hits)
        row = {
            "id": q["id"], "machine": q["machine"], "category": q["category"], "question": q["question"],
            "reference": q["reference"], "expect_insufficient": bool(q.get("expect_insufficient")),
            "answer": ans.text, "cited": ans.cited, "confidence": ans.confidence, "cached": ans.cached,
            "detected_machine": ans.machine,
            "context": [{"chunk_id": h.chunk["chunk_id"], "machine": h.chunk["machine"],
                         "filename": h.chunk["filename"], "section": h.chunk["section"],
                         "page": h.chunk["page"]} for h in ans.hits],
            "context_same_machine": all(h.chunk["machine"] == q["machine"] for h in ans.hits),
        }
        row.update(score_answer(q, ans.text, evidence, ans.cited))
        rows.append(row)
        print(f"  {q['id']} {'ok ' if row['correct'] else 'FAIL'} {'(cached)' if ans.cached else ''}", flush=True)
    return {"rows": rows, "fresh_calls": fresh_calls, "stopped": stopped,
            "model": config.GENERATION_MODEL, "prompt_version": config.PROMPT_VERSION,
            "summary": summarise_generation(rows)}


def _rate(rows: list[dict], key: str) -> float | None:
    return sum(bool(r[key]) for r in rows) / len(rows) if rows else None


def summarise_generation(rows: list[dict]) -> dict:
    answerable = [r for r in rows if not r["expect_insufficient"]]
    unanswerable = [r for r in rows if r["expect_insufficient"]]
    by_cat = defaultdict(list)
    for r in rows:
        by_cat[r["category"]].append(r)
    return {
        "n": len(rows),
        "answer_correctness": _rate(rows, "correct"),
        "answerable_correctness": _rate(answerable, "correct"),
        "diagnostic_correctness": _rate(by_cat.get("diagnostic", []), "correct"),
        "diagnostic_n": len(by_cat.get("diagnostic", [])),
        "diagnostic_structure_coverage": (sum(r["structure_coverage"] for r in by_cat["diagnostic"])
                                          / len(by_cat["diagnostic"]) if by_cat.get("diagnostic") else None),
        "threshold_accuracy": _rate(by_cat.get("threshold", []), "correct"),
        "threshold_n": len(by_cat.get("threshold", [])),
        "insufficient_accuracy": _rate(unanswerable, "correct"),
        "insufficient_n": len(unanswerable),
        "false_refusal_rate": _rate(answerable, "declined"),
        "groundedness": _rate(rows, "grounded"),
        "unsupported_claim_rate": sum(bool(r["unsupported_numbers"]) for r in rows) / len(rows) if rows else None,
        "citation_rate": _rate(rows, "cites_evidence"),
        "machine_context_accuracy": _rate(rows, "context_same_machine"),
        "cross_machine_leak_rate": sum(bool(r["forbidden_found"]) for r in rows) / len(rows) if rows else None,
        "correctness_by_category": {c: {"n": len(rs), "correct": _rate(rs, "correct")} for c, rs in sorted(by_cat.items())},
        "correctness_by_machine": {m: _rate([r for r in rows if r["machine"] == m], "correct")
                                   for m in sorted({r["machine"] for r in rows})},
    }


# --- optional LLM judge ---------------------------------------------------
JUDGE_SYSTEM = """You grade answers of a retrieval-augmented diagnostic assistant. For each item you get \
the QUESTION, a REFERENCE answer written from the documentation, the EVIDENCE the assistant was given \
and its ANSWER. Judge strictly and only from what is written.
- "correct": "yes" if the ANSWER agrees with the REFERENCE on the fault, component, values and action \
that the question asks for (extra correct detail is fine); "partial" if it is right but misses a \
requested element; "no" if it contradicts the REFERENCE or answers something else. When the REFERENCE \
says the information is not available, "yes" requires that the ANSWER declines and invents no value.
- "unsupported": true if the ANSWER states a fact or number that is neither in the EVIDENCE nor a \
direct comparison or restatement of the question, otherwise false.
Return only a JSON array: [{"id": "...", "correct": "yes|partial|no", "unsupported": true|false, "note": "max 15 words"}]"""


def run_judge(generation: dict, chunks_by_id: dict[str, dict], batch_size: int = 9) -> dict:
    rows = generation["rows"]
    verdicts: dict[str, dict] = {}
    calls = 0
    for i in range(0, len(rows), batch_size):
        items = []
        for r in rows[i:i + batch_size]:
            evidence = "\n".join(f"[S{n}] {chunks_by_id[c['chunk_id']]['text']}" for n, c in enumerate(r["context"], 1))
            items.append(f"### ITEM id={r['id']}\nQUESTION: {r['question']}\nREFERENCE: {r['reference']}\n"
                         f"EVIDENCE:\n{evidence}\nANSWER:\n{r['answer']}")
        try:
            text, cached = gemini.generate("\n\n".join(items), JUDGE_SYSTEM, operation="judge",
                                           max_output_tokens=3000, json_output=True)
        except gemini.QuotaExceeded as err:
            print(f"  judge stopped: {err}")
            break
        calls += not cached
        try:
            for v in json.loads(text):
                verdicts[v["id"]] = v
        except (json.JSONDecodeError, KeyError, TypeError):
            print(f"  judge batch {i // batch_size + 1}: unparseable reply, skipped")
    judged = [verdicts[r["id"]] for r in rows if r["id"] in verdicts]
    n = len(judged) or 1
    return {
        "verdicts": verdicts, "fresh_calls": calls, "n": len(judged),
        "summary": {
            "judge_correct": sum(v["correct"] == "yes" for v in judged) / n,
            "judge_correct_or_partial": sum(v["correct"] in ("yes", "partial") for v in judged) / n,
            "judge_unsupported_rate": sum(bool(v["unsupported"]) for v in judged) / n,
        },
    }
