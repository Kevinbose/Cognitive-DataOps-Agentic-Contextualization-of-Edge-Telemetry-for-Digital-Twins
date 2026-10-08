"""Ask the diagnostic knowledge base a question.

    python query.py --machine press-stamp-01 "The bearing vibration has exceeded the warning threshold. What could be causing this and what should I inspect?"
    python query.py "What is the alarm limit for axis 4 servo torque on robot-weld-01?"
    python query.py --retrieve-only "..."     # show the evidence, make no generation call
    python query.py --json "..."              # the dict a diagnostic agent receives (rag.api.diagnose)
    python query.py                           # interactive

One question costs one query embedding and one generation request. Both are cached, so asking
the same question again costs nothing (use --no-cache to force a fresh answer).
"""
from __future__ import annotations

import argparse
import json
import sys

from rag import config, gemini
from rag.generate import answer, format_evidence
from rag.retrieve import default_retriever


def show(question: str, machine: str | None, args) -> None:
    if args.json:
        from rag import api
        call = api.retrieve_evidence if args.retrieve_only else api.diagnose
        print(json.dumps(call(question, machine, k=args.top_k), indent=2, ensure_ascii=False))
        return
    if args.retrieve_only:
        analysis, hits = default_retriever().retrieve(question, machine, k=args.top_k)
        print(f"\nMachine: {analysis.machine or 'not determined'} ({analysis.machine_source})")
        print(f"Sensors: {', '.join(analysis.sensors) or '-'} | Intents: {', '.join(analysis.intents) or '-'}")
        for n, h in enumerate(hits, start=1):
            c = h.chunk
            print(f"{n:2d}. {h.score:.3f} cos={h.dense:.3f}  {c['filename']} | {c['section']} | Page {c['page']}")
        return
    ans = answer(question, machine, use_cache=not args.no_cache, k=args.top_k)
    print(f"\nAnswer:\n{ans.text}\n")
    print(f"Evidence:\n{format_evidence(ans)}\n")
    print(f"Machine:\n{ans.machine or 'not determined'} ({ans.analysis.machine_source})\n")
    print(f"Confidence:\n{ans.confidence}")
    if ans.cached:
        print("\n(answer served from the local cache, no API request made)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("question", nargs="?", help="omit for an interactive session")
    ap.add_argument("--machine", choices=sorted(config.MACHINE_DIRS), help="restrict retrieval to one machine")
    ap.add_argument("--top-k", type=int, help="chunks passed to the model (default 6, or 8 for a diagnostic question)")
    ap.add_argument("--retrieve-only", action="store_true", help="show retrieved evidence, do not generate")
    ap.add_argument("--json", action="store_true", help="print the agent-facing dict as JSON")
    ap.add_argument("--no-cache", action="store_true", help="ignore the answer cache")
    args = ap.parse_args()

    try:
        if args.question:
            show(args.question, args.machine, args)
            return 0
        machine = args.machine or input("Machine (press-stamp-01 / robot-weld-01 / blank): ").strip() or None
        while True:
            question = input("\nQuery (blank to quit): ").strip()
            if not question:
                return 0
            show(question, machine, args)
    except gemini.QuotaExceeded as err:
        print(f"Quota guard: {err}")
        return 2
    except (EOFError, KeyboardInterrupt):
        return 0


if __name__ == "__main__":
    sys.exit(main())
