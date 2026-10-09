"""Turning a diagnosis into the report the Node API stores.

The facts (root cause, confidence, alternatives, the evidence table, actions,
targets) are decided by code. A model may only word the headline, the
summary and the action steps, and its text is kept only if it passes a guard:
it names the root cause, cites only sources that were retrieved, and uses no
decimal number that is not in the facts it was given. Otherwise the template
text is used, so a report is always produced.
"""
from __future__ import annotations

import json
import re

from . import knowledge as K
from .diagnosis import Diagnosis, short_name
from .rag_bridge import Evidence, Knowledge

SENSOR_FAULTS = {"press": {"F12", "F13", "F14", "F15"}, "robot": {"F11", "F12"}}
REF_RE = re.compile(r"\[(S\d{1,2})\]")
# "[S1, S3]" or "[S1; S3]", which models write, becomes "[S1][S3]"
MULTI_REF_RE = re.compile(r"\[\s*(S\d{1,2}(?:\s*[,;]\s*S\d{1,2})+)\s*\]")


def split_refs(text: str) -> str:
    return MULTI_REF_RE.sub(lambda m: "".join(f"[{r.strip()}]" for r in re.split(r"[,;]", m.group(1))), text)
NUM_RE = re.compile(r"(?<![\w.])\d+\.\d+(?![\w.])")

SYSTEM = (
    "You write maintenance diagnostic reports for the digital twin of a car plant. "
    "Use only the facts given. Plain, specific sentences in sentence case. No em dashes, no emojis, "
    "no marketing words, no headings. Cite sources inline as [S1] using only the refs listed under sources. "
    "Never invent a number: copy numbers exactly as they appear in the facts. "
    "Answer with one JSON object and nothing else."
)


def clean_text(text: str, limit: int) -> str:
    t = str(text or "").replace("—", ", ").replace("–", "-").replace("…", "...")
    t = re.sub(r"[\U0001F300-\U0001FAFF☀-➿]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t if len(t) <= limit else t[: limit - 3].rsplit(" ", 1)[0] + "..."


def pct(x: float) -> str:
    return f"{round(100 * x)} percent"


def machine_label(machine_id: str, catalog_label: str | None = None) -> str:
    return catalog_label or machine_id


def key_readings(d: Diagnosis) -> dict:
    f = d.features
    if d.machine_type == "press":
        keys = [("P60", "bar"), ("V60", "mm/s"), ("I60", "A"), ("HB300", "mm/s"), ("PMR300", "")]
    else:
        keys = [("M", "Nm"), ("A6", "Nm"), ("TCP", "mm"), ("kN", "")]
    return {k: f"{f[k]}{(' ' + u) if u else ''}" for k, u in keys if f.get(k) is not None}


def select_citations(d: Diagnosis, evidence: list[Evidence], limit: int = 6) -> list[Evidence]:
    """The sources worth showing: those naming the root fault first, then one per stage."""
    root = d.root
    code = root.id if root else None
    chosen: list[Evidence] = []
    for e in evidence:
        if code and code in e.fault_codes and e not in chosen:
            chosen.append(e)
    for stage in ("operating_conditions", "failure_modes", "diagnostic_procedures", "maintenance", "case_history"):
        if not any(e.document_type == stage for e in chosen):
            e = next((x for x in evidence if x.document_type == stage), None)
            if e:
                chosen.append(e)
    for e in evidence:
        if e not in chosen:
            chosen.append(e)
    chosen = chosen[:limit]
    order = {e.chunk_id: i for i, e in enumerate(evidence)}
    return sorted(chosen, key=lambda e: order[e.chunk_id])


def template_text(d: Diagnosis, label: str, cited: list[Evidence], trigger: dict | None) -> tuple[str, str]:
    root = d.root
    refs = {e.document_type: e.ref for e in cited}
    sig_ref = next((e.ref for e in cited if root and root.id in e.fault_codes), refs.get("failure_modes"))
    if not root:
        headline = f"{label}: deviation without a documented fault signature"
        summary = (f"The detector saw {describe_trigger(trigger)}, but no fault signature in the documentation "
                   f"matches the current data. Level: {d.level}. Inspect the machine and verify the sensors before acting.")
        return clean_text(headline, 160), clean_text(summary, 2000)
    fault = K.faults_for(d.machine_type).get(root.id)
    name = root.name[0].lower() + root.name[1:]
    headline = f"{label}: {name} likely ({root.id}{' ' + root.code if root.code else ''}), {pct(root.confidence)} confidence"
    supporting = [t for t in d.tests if t.verdict_for(root.id) == "supports"][:3]
    against = [t for t in d.tests if t.verdict_for(root.id) == "contradicts"][:1]
    parts = [f"The detector saw {describe_trigger(trigger)}; the machine is at level {d.level}."]
    if supporting:
        found = ", ".join(f"{short_name(t)} {t.observed}" for t in supporting)
        parts.append(f"The data matches the documented {root.label} signature: {found}" + (f" [{sig_ref}]." if sig_ref else "."))
    if against:
        parts.append(f"One test does not fit: {short_name(against[0])} {against[0].observed}.")
    alts = [a for a in d.ranked[1:3] if a.confidence >= 0.1]
    if alts:
        parts.append("Alternatives considered: " + ", ".join(f"{a.id} {a.name.lower()} ({pct(a.confidence)})" for a in alts) + ".")
    if fault:
        ref = refs.get("maintenance")
        parts.append(f"Next: {fault.actions[0][0][0].lower()}{fault.actions[0][0][1:].rstrip('.')}" + (f" [{ref}]." if ref else "."))
    return clean_text(headline, 160), clean_text(" ".join(parts), 2000)


LIMIT_WORDS = {"warnLow": ("below", "warning"), "alarmLow": ("below", "alarm"),
               "warnHigh": ("above", "warning"), "alarmHigh": ("above", "alarm")}


def describe_trigger(trigger: dict | None) -> str:
    if not trigger:
        return "a deviation"
    t = trigger.get("trigger") or {}
    ch = (trigger.get("channelKey") or "a channel").replace("_", " ").lower()
    unit = f" {t['unit']}" if t.get("unit") else ""
    if trigger.get("kind") == "drift":
        return f"{ch} drifting from its learned baseline of {t.get('baseline')}{unit} to {t.get('mean60')}{unit}, still inside its limits"
    side, level = LIMIT_WORDS.get(t.get("limitName") or "", ("past", "set"))
    return f"{ch} at {t.get('mean10', t.get('value'))}{unit}, {side} its {t.get('limit')}{unit} {level} limit"


def llm_text(knowledge: Knowledge, d: Diagnosis, label: str, cited: list[Evidence], trigger: dict | None,
             actions: list[dict]) -> dict | None:
    root = d.root
    if not root or not knowledge.llm_ready:
        return None
    facts = {
        "machine": label, "trigger": describe_trigger(trigger), "level": d.level, "levelReasons": d.level_reasons,
        "readings": key_readings(d),
        "rootCause": {"id": root.id, "code": root.code, "name": root.name, "confidence": pct(root.confidence)},
        "alternatives": [{"id": a.id, "name": a.name, "confidence": pct(a.confidence)} for a in d.ranked[1:3]],
        "evidence": d.evidence_rows(8),
        "actions": actions,
    }
    sources = "\n\n".join(f"[{e.ref}] {e.document}, {e.section}, page {e.page}\n{e.excerpt(700)}" for e in cited)
    facts_text = json.dumps(facts, ensure_ascii=False)
    prompt = (
        f"Facts:\n{facts_text}\n\nSources:\n{sources}\n\n"
        "Write the report as JSON with keys: headline (one line, at most 110 characters, names the likely fault), "
        "summary (3 to 5 sentences: what was seen, why it points to the root cause, what was ruled out, what to do; "
        "cite sources as [S1]), actions (list of {step, caveat}; at most 4, rephrase the given actions, caveat may be null), "
        "cited (list of the refs you used)."
    )
    out = knowledge.generate_json(prompt, SYSTEM)
    if not out:
        return None
    return guard(out, d, cited, facts_text + sources)


def guard(out: dict, d: Diagnosis, cited: list[Evidence], facts: str) -> dict | None:
    root = d.root
    headline = clean_text(out.get("headline", ""), 160)
    summary = clean_text(out.get("summary", ""), 2000)
    if len(headline) < 10 or len(summary) < 40:
        return None
    names = [root.id, root.code or "", root.name.lower()]
    text = f"{headline} {summary}".lower()
    if not any(n and n.lower() in text for n in names):
        return None
    allowed = {e.ref for e in cited}
    summary = REF_RE.sub(lambda m: m.group(0) if m.group(1) in allowed else "", split_refs(summary)).replace(" .", ".")
    unknown = [n for n in NUM_RE.findall(f"{headline} {summary}") if n not in facts]
    if unknown:
        return None
    actions = []
    for a in out.get("actions") or []:
        if isinstance(a, dict) and a.get("step"):
            actions.append({"step": clean_text(a["step"], 400),
                            "caveat": clean_text(a["caveat"], 300) if a.get("caveat") else None})
    return {"headline": headline, "summary": summary.strip(), "actions": actions[:6] or None}


def build_report(*, knowledge: Knowledge, d: Diagnosis, investigation: dict, label: str,
                 evidence: list[Evidence], targets: list[dict], needs_binding: list[str]) -> dict:
    root = d.root
    fault = K.faults_for(d.machine_type).get(root.id) if root else None
    cited = select_citations(d, evidence)
    actions = [{"step": s, "caveat": c} for s, c in fault.actions] if fault else [
        {"step": "Inspect the machine at the next stop and verify the sensors against reference instruments.", "caveat": None}]
    if fault:
        actions.append({"step": f"Verify after the work: {fault.verify}.", "caveat": None})

    headline, summary = template_text(d, label, cited, investigation)
    written = llm_text(knowledge, d, label, cited, investigation, actions)
    if written:
        headline, summary = written["headline"], written["summary"]
        actions = written["actions"] or actions

    sev = investigation.get("severity") or "warn"
    if d.level in ("alarm", "critical"):
        sev = "alarm"
    sensor_suspect = bool(root and root.id in SENSOR_FAULTS.get(d.machine_type, set()))
    return {
        "investigationId": investigation.get("investigationId"),
        "assetId": investigation.get("assetId"),
        "machineId": d.machine_id,
        "severity": sev,
        "level": d.level,
        "headline": headline,
        "summary": summary,
        "rootCause": ({"id": root.id, "name": root.name[:160], "confidence": root.confidence, "faultCode": root.code}
                      if root else {"id": "UNEXPLAINED", "name": "Deviation without a documented signature", "confidence": 0.2}),
        "alternatives": [{"id": a.id, "name": a.name[:160], "confidence": a.confidence, "faultCode": a.code}
                         for a in d.ranked[1:4]],
        "evidence": [{**row, "observed": row["observed"][:80], "expected": row["expected"][:120], "test": row["test"][:200]}
                     for row in d.evidence_rows(12)],
        "actions": actions[:10],
        "citations": [e.citation() for e in cited],
        "targets": targets[:6],
        "needsBinding": needs_binding[:10],
        "degraded": not written,
        "needsReview": (not root) or root.confidence < 0.55 or sensor_suspect,
        "generatedBy": "agent" if written else "template",
        "model": knowledge.model if written else None,
    }
