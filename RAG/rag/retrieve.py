"""Machine-aware hybrid retrieval.

    query -> local analysis -> machine filter -> dense (Gemini embedding) + BM25 -> RRF fusion
          -> local rerank on metadata -> top-k context

Only the query embedding touches the API, and it is cached. Everything else is local.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from functools import lru_cache

from rank_bm25 import BM25Okapi

from . import config, gemini
from .store import VectorStore

# --- query analysis -------------------------------------------------------
MACHINE_ID_RE = {
    "press-stamp-01": re.compile(r"press[-_ ]?stamp[-_ ]?0?1|stamping press|PS01", re.I),
    "robot-weld-01": re.compile(r"robot[-_ ]?weld[-_ ]?0?1|welding robot|RW01", re.I),
}
# Weaker cues: a term that only one machine's documentation is about.
MACHINE_CUES = {
    "press-stamp-01": [
        "press", "stamp", "lube", "lubrication circuit", "oil pressure", "bearing vibration",
        "motor current", "main motor", "main drive", "clogged filter", "clogged_filter",
        "bearing_wear", "bearing wear", "stroke", "mm/s", " bar", "spectrum", "lube filter",
        "main_motor_current", "lube_oil_pressure", "bearing_vibration_rms", "bearing_spectrum",
    ],
    "robot-weld-01": [
        "robot", "weld", "axis 4", "axis-4", "axis four", "servo", "torque", "gearbox", "forearm",
        " nm", "gearbox_wear", "axis_4_servo_torque", "tool center point", "tcp", "weld gun",
        "ripple", "backlash", "brake drag", "sensor 1", "sixth-harmonic", " a6 ", "per-cycle",
        "cycle mean", "weld cycle",
    ],
}
SENSOR_CUES = {
    "MAIN_MOTOR_CURRENT": ["main_motor_current", "motor current", "main motor", "drive current", "amps", " a "],
    "LUBE_OIL_PRESSURE": ["lube_oil_pressure", "oil pressure", "lube pressure", "lubrication pressure", " bar"],
    "BEARING_VIBRATION_RMS": ["bearing_vibration_rms", "vibration", "mm/s"],
    "BEARING_SPECTRUM": ["bearing_spectrum", "spectrum", "spectral", "broadband", "discrete line"],
    "AXIS_4_SERVO_TORQUE": ["axis_4_servo_torque", "servo torque", "axis 4", "torque", " nm"],
    "TOOL_CENTER_POINT_DEVIATION": ["tool_center_point_deviation", "tcp deviation", "tool center point"],
    "WELD_GUN_TEMP": ["weld_gun_temp", "weld gun temp", "gun temperature"],
}
# intent -> document types that normally hold the answer
INTENT_CUES = {
    "threshold": (["threshold", "limit", "warning", "alarm", "critical", "normal range", "within",
                   "minimum", "maximum", "baseline", "operating range", "hysteresis", "watch level"],
                  ["operating_conditions"]),
    "fault": (["fault", "failure mode", "signature", "cause", "causing", "why", "symptom",
               "differentiat", "distinguish", "confus", "versus", " vs "],
              ["failure_modes", "diagnostic_procedures"]),
    "procedure": (["procedure", "step", "decision", "diagnos", "rule", "logic", "confidence",
                   "escalat", "workflow", "how do i", "how should"],
                  ["diagnostic_procedures"]),
    "maintenance": (["inspect", "maintenance", "repair", "replace", "corrective", "troubleshoot",
                     "verify", "verification", "interval", "spare", "tool", "safety", "lockout",
                     "work order", "relubricat", "post-repair", "acceptance"],
                    ["maintenance"]),
    "case": (["case", "scenario", "history", "example", "happened", "previous", "similar", "evidence"],
             ["case_history"]),
}
DIAGNOSTIC_RE = re.compile(
    r"what (?:could|might|can|would) be caus|what is causing|likely (?:fault|cause)|diagnos|classify|"
    r"what should (?:i|be) (?:inspect|check|do)|has exceeded|is rising|is falling|has (?:dropped|fallen|crept)|"
    r"keeps? (?:rising|falling)|which fault|(?:which|what) level|who (?:is|must be) (?:notified|told)|what (?:is the )?fault|should a .*fault be|is this a (?:real )?(?:fault|lubrication)",
    re.I)
# the diagnostic chain, as the document types that carry each stage
# sections of the operating-conditions document that hold the limits a reading is classified against
LIMITS_SECTION_RE = re.compile(r"Threshold System|Detailed Standards|Normal Operating Range|Alert Escalation", re.I)
STAGE_DOC_TYPES = ["operating_conditions", "failure_modes", "diagnostic_procedures", "maintenance", "case_history"]
TOKEN_RE = re.compile(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*")
STOP = set("a an the of to in on for and or is are was be at by with from as it this that what which how "
           "do does i my me should would could can if when than then there their its not no".split())


@dataclass
class QueryAnalysis:
    query: str
    machine: str | None = None          # machine the retrieval is restricted to
    machine_source: str = "none"        # explicit | argument | inferred | none
    sensors: list[str] = field(default_factory=list)
    intents: list[str] = field(default_factory=list)
    fault_codes: list[str] = field(default_factory=list)
    tables: list[str] = field(default_factory=list)
    measurements: list[str] = field(default_factory=list)
    diagnostic: bool = False


def analyse(query: str, machine: str | None = None) -> QueryAnalysis:
    """Deterministic query processing. No API call."""
    q = f" {query.lower()} "
    a = QueryAnalysis(query=query)
    explicit = [m for m, rx in MACHINE_ID_RE.items() if rx.search(query)]
    if machine:
        a.machine, a.machine_source = machine, "argument"
    elif len(explicit) == 1:
        a.machine, a.machine_source = explicit[0], "explicit"
    elif not explicit:
        hits = {m: sum(cue in q for cue in cues) for m, cues in MACHINE_CUES.items()}
        ranked = sorted(hits.items(), key=lambda kv: -kv[1])
        if ranked[0][1] > 0 and ranked[1][1] == 0:
            a.machine, a.machine_source = ranked[0][0], "inferred"
    a.sensors = [s for s, cues in SENSOR_CUES.items() if any(c in q for c in cues)]
    a.intents = [i for i, (cues, _) in INTENT_CUES.items() if any(c in q for c in cues)]
    a.fault_codes = sorted(set(re.findall(r"\bF\d{2}\b", query)))
    a.tables = re.findall(r"\btable\s+(\d+)\b", q)
    a.measurements = re.findall(r"\d+(?:\.\d+)?\s?(?:mm/s|bar|nm|a|hz|s|percent|%)\b", q)
    # a diagnosis: an explicit ask, or a reading combined with a request for cause or action
    a.diagnostic = bool(DIAGNOSTIC_RE.search(query)) or (
        bool(a.measurements) and bool({"fault", "maintenance"} & set(a.intents)))
    return a


# --- retrieval ------------------------------------------------------------
def tokenize(text: str) -> list[str]:
    out = []
    for tok in TOKEN_RE.findall(text.lower().replace("_", " ")):
        if tok not in STOP:
            out.append(tok)
    return out


# Weight of the lexical list in the fusion, relative to the dense list. The ablation in the
# evaluation showed a light lexical vote helps the top rank and a heavy one hurts it.
BM25_WEIGHT = 0.15
STAGE_POOL = 25     # a stage's best chunk must rank at least this high to be pulled into the context


@dataclass
class Hit:
    chunk: dict
    score: float
    dense: float
    dense_rank: int | None
    bm25_rank: int | None


class Retriever:
    def __init__(self, store: VectorStore | None = None):
        self.store = store or VectorStore.load()
        self.bm25 = BM25Okapi([tokenize(c["embed_text"]) for c in self.store.chunks])

    def rank(self, query: str, machine: str | None = None, mode: str = "hybrid") -> tuple[QueryAnalysis, list[Hit]]:
        """All candidates, best first. mode: hybrid (default) | dense | bm25 (ablations for the evaluation)."""
        a = analyse(query, machine)
        ids = self.store.ids_where(machine=a.machine) if a.machine else list(range(len(self.store.chunks)))
        n = min(config.RETRIEVE_CANDIDATES, len(ids))

        dense: list[tuple[int, float]] = []
        if mode != "bm25":
            qvec, _ = gemini.embed([query], "query")
            dense = self.store.search(qvec[0], n, ids if a.machine else None)
        dense_rank = {i: r for r, (i, _) in enumerate(dense)}
        dense_score = dict(dense)

        bm25_rank: dict[int, int] = {}
        if mode != "dense":
            scores = self.bm25.get_scores(tokenize(query))
            ranked = sorted(ids, key=lambda i: -scores[i])[:n]
            bm25_rank = {i: r for r, i in enumerate(ranked) if scores[i] > 0}

        hits = []
        for i in set(dense_rank) | set(bm25_rank):
            # reciprocal rank fusion; the dense list carries more weight than the lexical one
            rrf = 0.0
            if i in dense_rank:
                rrf += 1.0 / (60 + dense_rank[i])
            if i in bm25_rank:
                rrf += BM25_WEIGHT / (60 + bm25_rank[i])
            score = rrf * 60  # about 1.0 for a chunk ranked first by the dense list
            if mode == "hybrid":
                score += self._boost(a, self.store.chunks[i])
            hits.append(Hit(self.store.chunks[i], score, dense_score.get(i, 0.0),
                            dense_rank.get(i), bm25_rank.get(i)))
        hits.sort(key=lambda h: -h.score)
        return a, hits

    def retrieve(self, query: str, machine: str | None = None, k: int | None = None,
                 mode: str = "hybrid") -> tuple[QueryAnalysis, list[Hit]]:
        """The context passed to the model.

        A factual question gets the k best chunks. A diagnostic question needs evidence for every
        stage of the chain (limits, fault signature, decision logic, maintenance, cases), and the
        best chunks tend to come from one document, so the best chunk of each document type is
        taken first and the rest is filled by score.
        """
        a, ranked = self.rank(query, machine, mode)
        if not a.diagnostic:
            return a, ranked[:k or config.CONTEXT_TOP_K]
        k = k or config.CONTEXT_TOP_K_DIAGNOSTIC
        chosen: list[Hit] = []
        if a.measurements:
            # a reading can only be interpreted against the limits, so the limits table goes in first
            limits = next((h for h in ranked[:STAGE_POOL] if h.chunk["document_type"] == "operating_conditions"
                           and LIMITS_SECTION_RE.search(h.chunk["section"])), None)
            if limits:
                chosen.append(limits)
        for doc_type in STAGE_DOC_TYPES:
            if any(h.chunk["document_type"] == doc_type for h in chosen):
                continue
            best = next((h for h in ranked[:STAGE_POOL] if h.chunk["document_type"] == doc_type), None)
            if best and len(chosen) < k:
                chosen.append(best)
        chosen += [h for h in ranked if h not in chosen][:k - len(chosen)]
        chosen.sort(key=lambda h: -h.score)
        return a, chosen

    @staticmethod
    def _boost(a: QueryAnalysis, chunk: dict) -> float:
        """Local rerank on exact identifiers only (fault code, table number).

        A prior on the document type guessed from the query intent was tried and removed: it cost
        about 18 points of Recall@1 on the benchmark, because the same fact lives in several
        document types.
        """
        b = 0.0
        if a.fault_codes and set(a.fault_codes) & set(chunk["fault_codes"]):
            b += 0.15
            if any(code in chunk["section"] for code in a.fault_codes):
                b += 0.25
        if a.tables and set(a.tables) & set(chunk["tables"]):
            b += 0.30
        if chunk["section"].startswith("Cover"):
            b -= 0.30  # the cover repeats every identifier and rarely holds the answer
        return b


@lru_cache(maxsize=1)
def default_retriever() -> Retriever:
    return Retriever()
