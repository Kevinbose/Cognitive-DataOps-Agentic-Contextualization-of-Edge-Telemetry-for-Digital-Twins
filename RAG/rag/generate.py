"""Grounded answer generation: one Gemini call per question, over the retrieved evidence only."""
from __future__ import annotations

import re
from dataclasses import dataclass

from . import config, gemini
from .retrieve import Hit, QueryAnalysis, Retriever, default_retriever

SYSTEM_PROMPT = f"""You are a diagnostic assistant for industrial machines in a car plant. You answer \
strictly from the numbered SOURCES in the user message, which are excerpts of the technical \
documentation.

Grounding rules
1. Use only facts stated in the SOURCES. Never invent or estimate thresholds, sensor values, \
components, fault mappings, maintenance intervals or telemetry behaviour.
2. Copy every number exactly as written in the SOURCES, with its unit. Do not round or convert it.
3. Cite the source of every claim inline as [S1], [S2] and so on. Cite only sources you used.
4. The question is about the machine named under MACHINE. Do not use a fact about a different \
machine. If the SOURCES are about another machine or another sensor, they do not answer the question.
5. If the SOURCES do not contain the information needed, reply with exactly this sentence and \
nothing invented: "{config.INSUFFICIENT_PHRASE}" You may add one sentence naming what is missing. \
A partly answerable question gets the supported part, then that sentence for the rest.
6. When a reading is given, compare it explicitly against each relevant limit in the SOURCES and \
state the resulting level (normal, watch, warning, alarm, critical). Limits come in two kinds. A \
high limit reads "at or above X": a reading equal to or greater than X breaches it. A low limit \
reads "at or below X": a reading equal to or smaller than X breaches it, so a reading under a low \
warning limit and still over the low alarm limit is at warning level. The level of a channel is \
the most severe limit it breaches. When several channels are at different levels, the overall \
level is the most severe one, and the response the SOURCES prescribe for that most severe level \
governs the recommended action.
7. Reasoning that goes beyond what the SOURCES state must be on its own line starting with \
"Engineering inference:". Keep it short and never put a new number in it.
8. The documents tag values [P], [D], [E], [I]. Never present a value as a manufacturer or OEM value.

Format
- A factual question (a limit, a definition, a single step): answer directly in one to five sentences.
- A diagnostic question (an abnormal condition, a cause, what to inspect or do): use these headings, \
in this order, and leave out a heading the SOURCES give no evidence for:
  Condition / Observed evidence / Threshold interpretation / Possible faults / Fault differentiation / \
Recommended inspection / Recommended action / Verification
  A diagnostic answer covers the whole chain: when the SOURCES state the corrective action and the \
post-repair verification values for the fault you name, include them.
- Under "Threshold interpretation" name each limit you compared the reading with and the level \
that results. Under "Recommended action" state the response the SOURCES prescribe for that level \
(for example who acts, how fast, whether to stop) as well as the repair.
- Begin with one line "Direct answer:" that answers the question asked in a sentence or two \
(yes or no first when the question is a yes or no question; the fault name when it asks for the \
fault; the level when it asks for the level). Then give the headings.
- When the SOURCES contain an escalation table for the level reached, state who is notified and \
the time to act.
- Answer every part of the question. If the SOURCES cover some parts and not others, answer the \
covered parts and say which part is not covered.
- Never answer with a bare code. When you mention a task, rule, fault or case code (T4, R-20, F03, \
C07), say what it is using the words of the SOURCES; if the SOURCES do not explain the code, give \
the concrete checks or causes they do list.
- Plain text. No preamble, no closing remarks."""


@dataclass
class Answer:
    question: str
    machine: str | None
    text: str
    hits: list[Hit]
    cited: list[int]            # 1-based source numbers the answer cites
    insufficient: bool
    confidence: str
    cached: bool
    analysis: QueryAnalysis


def build_prompt(question: str, analysis: QueryAnalysis, hits: list[Hit]) -> str:
    blocks = []
    for n, h in enumerate(hits, start=1):
        c = h.chunk
        blocks.append(f"[S{n}] Machine: {c['machine']} | File: {c['filename']} | "
                      f"Section: {c['section']} | Page: {c['page']}\n{c['text']}")
    machine = analysis.machine or "not specified (use the machine the SOURCES and the question agree on)"
    kind = "diagnostic" if analysis.diagnostic else "factual unless the question clearly asks for a diagnosis"
    return (f"MACHINE: {machine}\nQUESTION TYPE: {kind}\n\nSOURCES\n=======\n" + "\n\n".join(blocks)
            + f"\n\nQUESTION: {question}")


def confidence_label(hits: list[Hit], insufficient: bool, cited: list[int]) -> str:
    """Local heuristic from retrieval agreement. It is not a calibrated probability."""
    if insufficient or not hits:
        return "Low (documentation does not cover the question)"
    top = hits[0]
    agree = top.dense_rank is not None and top.bm25_rank is not None and top.dense_rank < 5 and top.bm25_rank < 5
    if top.dense >= 0.70 and agree and cited:
        return f"High (top evidence similarity {top.dense:.2f}, dense and keyword search agree)"
    if top.dense >= 0.60 and cited:
        return f"Medium (top evidence similarity {top.dense:.2f})"
    return f"Low (top evidence similarity {top.dense:.2f})"


def answer(question: str, machine: str | None = None, *, retriever: Retriever | None = None,
           use_cache: bool = True, k: int | None = None) -> Answer:
    retriever = retriever or default_retriever()
    analysis, hits = retriever.retrieve(question, machine, k=k)
    prompt = build_prompt(question, analysis, hits)
    text, cached = gemini.generate(prompt, SYSTEM_PROMPT, use_cache=use_cache)
    text = text.strip()
    cited = cited_sources(text, len(hits))
    insufficient = is_insufficient(text)
    return Answer(question, analysis.machine, text, hits, cited, insufficient,
                  confidence_label(hits, insufficient, cited), cached, analysis)


def cited_sources(text: str, n_sources: int) -> list[int]:
    """Source numbers cited in the answer, from tags such as [S2] and [S3, S5]."""
    found = set()
    for group in re.findall(r"\[(S\d+(?:\s*,\s*S\d+)*)\]", text):
        found.update(int(n) for n in re.findall(r"\d+", group))
    return sorted(n for n in found if 1 <= n <= n_sources)


def is_insufficient(text: str) -> bool:
    """True when the answer is a refusal, not when it merely appends the sentence to real content."""
    marker = "does not provide sufficient information"
    if marker not in text:
        return False
    rest = text.replace(config.INSUFFICIENT_PHRASE, "")
    return len(re.findall(r"\[S\d+", rest)) == 0 or text.strip().startswith(config.INSUFFICIENT_PHRASE[:40])


def format_evidence(ans: Answer) -> str:
    lines = []
    if not ans.cited:
        lines.append("(no source answers the question; closest passages retrieved:)")
    for n in ans.cited or range(1, min(3, len(ans.hits)) + 1):
        c = ans.hits[n - 1].chunk
        lines.append(f"[S{n}] {c['filename']} | Section: {c['section']} | Page: {c['page']}")
    return "\n".join(lines)
