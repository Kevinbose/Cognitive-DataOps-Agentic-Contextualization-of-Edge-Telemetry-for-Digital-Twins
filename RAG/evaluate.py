"""Run the benchmarks and write the evaluation report.

    python evaluate.py retrieval     # Recall@k, MRR, isolation; hybrid plus dense-only and BM25-only ablations
    python evaluate.py generation    # one cached generation call per question, deterministic scoring
    python evaluate.py judge         # optional Gemini second opinion, about 6 batched calls, cached
    python evaluate.py report        # rebuild the report from saved results, no API call
    python evaluate.py all           # retrieval + generation + report (the judge stays opt-in)
    python evaluate.py validate      # check the gold labels against the current chunks, no API call

Results land in evaluation/results/. Generation and judge calls are cached in evaluation/cache/,
keyed on model, prompt version and the full prompt including the retrieved context.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime

from rag import config, gemini
from rag import evaluation as ev
from rag.retrieve import Retriever

RESULTS = config.EVAL_RESULTS_DIR
TARGETS = {"recall@5": 0.90, "answer_correctness": 0.90, "diagnostic_correctness": 0.90, "threshold_accuracy": 0.90,
           "insufficient_accuracy": 0.90, "groundedness": 0.90, "machine_isolation": 0.95}


def save(name: str, data: dict) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / name).write_text(json.dumps(data, indent=2, ensure_ascii=False))


def load(name: str) -> dict | None:
    path = RESULTS / name
    return json.loads(path.read_text()) if path.exists() else None


def pct(x: float | None) -> str:
    return "n/a" if x is None else f"{100 * x:.1f}%"


def cmd_validate(retriever: Retriever) -> int:
    questions = ev.load_retrieval_questions()
    problems = ev.validate_gold(questions, retriever.store.chunks)
    print(f"{len(questions)} retrieval questions checked, {len(problems)} gold-label problems")
    for p in problems:
        print("  " + p)
    return 1 if problems else 0


def cmd_retrieval(retriever: Retriever) -> None:
    for mode in ("hybrid", "dense", "bm25"):
        result = ev.run_retrieval(retriever, mode)
        save(f"retrieval_{mode}.json", result)
        s = result["summary"]
        print(f"[{mode:6s}] R@1 {pct(s['recall@1'])}  R@3 {pct(s['recall@3'])}  R@5 {pct(s['recall@5'])}  "
              f"R@10 {pct(s['recall@10'])}  MRR {s['mrr@10']:.3f}  isolation@5 {pct(s['machine_isolation@5'])}")
    misses = [r for r in load("retrieval_hybrid.json")["rows"]
              if not r["first_relevant_rank"] or r["first_relevant_rank"] > 5]
    for r in misses:
        print(f"  miss@5 {r['id']} (first relevant rank {r['first_relevant_rank']}): {r['query']}")


def cmd_generation(retriever: Retriever, limit: int | None) -> None:
    before = gemini.requests_today(config.GENERATION_MODEL)
    print(f"Generation requests logged today: {before} of a {config.GENERATION_RPD_LIMIT} budget")
    result = ev.run_generation(retriever, limit)
    save("generation.json", result)
    s = result["summary"]
    print(f"Fresh API calls: {result['fresh_calls']}  |  correctness {pct(s['answer_correctness'])}  "
          f"thresholds {pct(s['threshold_accuracy'])}  insufficient {pct(s['insufficient_accuracy'])}  "
          f"grounded {pct(s['groundedness'])}")
    if result["stopped"]:
        print(f"Stopped early by the quota guard: {result['stopped']}")
    for r in result["rows"]:
        if not r["correct"]:
            print(f"  FAIL {r['id']}: missing={r['missing']} forbidden={r['forbidden_found']} declined={r['declined']}")


def cmd_judge(retriever: Retriever) -> None:
    generation = load("generation.json")
    if not generation:
        print("Run `python evaluate.py generation` first.")
        return
    result = ev.run_judge(generation, {c["chunk_id"]: c for c in retriever.store.chunks})
    save("judge.json", result)
    s = result["summary"]
    print(f"Judge ({result['n']} answers, {result['fresh_calls']} fresh calls): correct {pct(s['judge_correct'])}, "
          f"correct or partial {pct(s['judge_correct_or_partial'])}, unsupported {pct(s['judge_unsupported_rate'])}")


def cmd_report(retriever: Retriever) -> None:
    hybrid, dense, bm25 = (load(f"retrieval_{m}.json") for m in ("hybrid", "dense", "bm25"))
    generation, judge = load("generation.json"), load("judge.json")
    chunks = retriever.store.chunks
    docs = Counter(c["machine"] for c in {(c["machine"], c["filename"]): c for c in chunks}.values())
    per_machine = Counter(c["machine"] for c in chunks)
    L = ["RAG Evaluation", "==============", f"Generated: {datetime.now().isoformat(timespec='seconds')}",
         f"Generation model: {config.GENERATION_MODEL}   Embedding model: {config.EMBEDDING_MODEL}   "
         f"Prompt version: {config.PROMPT_VERSION}", "",
         "Documents", "---------",
         f"Press Stamp: {docs['press-stamp-01']}", f"Robot Weld: {docs['robot-weld-01']}", "",
         "Chunks", "------", f"Total: {len(chunks)}",
         f"Press Stamp: {per_machine['press-stamp-01']}   Robot Weld: {per_machine['robot-weld-01']}", ""]
    checks: dict[str, float | None] = {}

    if hybrid:
        s = hybrid["summary"]
        checks["recall@5"] = s["recall@5"]
        L += [f"Retrieval ({s['n']} queries, hit = a chunk from a gold section in the top k)", "---------"]
        L += [f"Recall@{k}:".ljust(11) + pct(s[f"recall@{k}"]) for k in ev.KS]
        L += [f"MRR@10:    {s['mrr@10']:.3f}",
              f"Answer values present in top 5: {pct(s['answer_terms@5'])} ({s['answer_terms_n']} queries with a checked value)", "",
              f"Multi-step diagnostic queries ({s['multi_step_n']}): evidence for the stages threshold / fault / action",
              f"  Mean stage coverage in the context given to the model:  {pct(s['multi_step_stage_coverage'])}",
              f"  All stages covered in the context:                      {pct(s['multi_step_full_coverage'])}",
              f"Gold section present in the context given to the model (all queries): {pct(s['context_hit_rate'])}", "",
              "Recall@5 by group:"]
        L += [f"  {g:28s} {pct(v['recall@5']):>6s}  (n={v['n']})" for g, v in s["recall@5_by_group"].items()]
        L += ["", "Ablation (same queries):"]
        for name, res in (("hybrid + rerank", hybrid), ("dense only", dense), ("BM25 only", bm25)):
            if res:
                a = res["summary"]
                L.append(f"  {name:16s} R@1 {pct(a['recall@1']):>6s}  R@3 {pct(a['recall@3']):>6s}  "
                         f"R@5 {pct(a['recall@5']):>6s}  R@10 {pct(a['recall@10']):>6s}  MRR {a['mrr@10']:.3f}")
        misses = [r for r in hybrid["rows"] if not r["first_relevant_rank"] or r["first_relevant_rank"] > 5]
        L += ["", f"Queries missed at k=5: {len(misses)}"]
        L += [f"  {r['id']} (first relevant rank {r['first_relevant_rank']}): {r['query']}" for r in misses]
        L.append("")

    if generation:
        s = generation["summary"]
        checks.update({"answer_correctness": s["answer_correctness"], "threshold_accuracy": s["threshold_accuracy"],
                       "diagnostic_correctness": s["diagnostic_correctness"],
                       "insufficient_accuracy": s["insufficient_accuracy"], "groundedness": s["groundedness"]})
        L += [f"Generation ({s['n']} questions, deterministic checks)", "----------",
              f"Answer Correctness:        {pct(s['answer_correctness'])}",
              f"  answerable questions:    {pct(s['answerable_correctness'])}",
              f"Multi-step diagnostic:     {pct(s['diagnostic_correctness'])}  (n={s['diagnostic_n']}; every step of the chain must be right)",
              f"  diagnostic headings used: {pct(s['diagnostic_structure_coverage'])}",
              f"Groundedness:              {pct(s['groundedness'])}  (every number traceable to the evidence, and a citation)",
              f"Unsupported Claims:        {pct(s['unsupported_claim_rate'])}  (answers with a number not in the evidence)",
              f"Citation rate:             {pct(s['citation_rate'])}",
              f"False refusals:            {pct(s['false_refusal_rate'])}", "",
              "Correctness by category:"]
        L += [f"  {c:14s} {pct(v['correct']):>6s}  (n={v['n']})" for c, v in s["correctness_by_category"].items()]
        L += ["Correctness by machine:"]
        L += [f"  {m:14s} {pct(v):>6s}" for m, v in s["correctness_by_machine"].items()]
        if generation.get("stopped"):
            L.append(f"NOTE: the run stopped early on the quota guard: {generation['stopped']}")
        if judge:
            j = judge["summary"]
            L += ["", f"Gemini judge, second opinion ({judge['n']} answers):",
                  f"  Correct:            {pct(j['judge_correct'])}",
                  f"  Correct or partial: {pct(j['judge_correct_or_partial'])}",
                  f"  Unsupported claims: {pct(j['judge_unsupported_rate'])}"]
        L += ["", f"Threshold Accuracy ({s['threshold_n']} numeric questions)", "------------------",
              pct(s["threshold_accuracy"]), "",
              f"Hallucination Tests ({s['insufficient_n']} questions with no answer in the documents)", "-------------------",
              f"Insufficient-information accuracy: {pct(s['insufficient_accuracy'])}", ""]
        failed = [r for r in generation["rows"] if not r["correct"]]
        L += [f"Failed generation questions: {len(failed)}"]
        L += [f"  {r['id']}: missing={r['missing']} forbidden={r['forbidden_found']} declined={r['declined']}" for r in failed]
        L.append("")

    if hybrid and generation:
        r_rows, g_rows = hybrid["rows"], generation["rows"]
        pure = sum(r["top5_same_machine"] and r["context_same_machine"] for r in r_rows) + sum(r["context_same_machine"] for r in g_rows)
        isolation = pure / (len(r_rows) + len(g_rows))
        checks["machine_isolation"] = isolation
        L += [f"Machine Isolation ({len(r_rows) + len(g_rows)} queries: every retrieved chunk from the asked machine)",
              "-----------------", pct(isolation),
              f"Answers containing a value of the other machine: {pct(generation['summary']['cross_machine_leak_rate'])}", ""]

    L += ["Overall", "-------"]
    ok = True
    for key, target in TARGETS.items():
        value = checks.get(key)
        passed = value is not None and value >= target
        ok &= passed
        L.append(f"{key:24s} target {pct(target):>6s}   result {pct(value):>6s}   {'PASS' if passed else 'FAIL' if value is not None else 'NOT RUN'}")
    L += ["", f"Result: {'PASS' if ok else 'FAIL'}"]
    gen_used, emb_used = gemini.requests_today(config.GENERATION_MODEL), gemini.requests_today(config.EMBEDDING_MODEL)
    L += ["", "API usage logged today", "----------------------",
          f"{config.GENERATION_MODEL}: {gen_used} requests (budget {config.GENERATION_RPD_LIMIT}, hard limit 500)",
          f"{config.EMBEDDING_MODEL}: {emb_used} requests (budget {config.EMBEDDING_RPD_LIMIT}, hard limit 1000)"]
    report = "\n".join(L) + "\n"
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / "evaluation_report.txt").write_text(report)
    print(report)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["retrieval", "generation", "judge", "report", "all", "validate"])
    ap.add_argument("--limit", type=int, help="generation: only the first N questions (for a cheap trial)")
    args = ap.parse_args()
    retriever = Retriever()
    if args.command == "validate":
        return cmd_validate(retriever)
    if args.command in ("retrieval", "all"):
        cmd_retrieval(retriever)
    if args.command in ("generation", "all"):
        cmd_generation(retriever, args.limit)
    if args.command == "judge":
        cmd_judge(retriever)
    if args.command in ("report", "all", "judge"):
        cmd_report(retriever)
    return 0


if __name__ == "__main__":
    sys.exit(main())
