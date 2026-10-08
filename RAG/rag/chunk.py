"""Structure-aware chunking: split on headings, keep every table whole with its caption.

A chunk never crosses a top-level section. Small subsections are packed together, a large table
is split by rows with its caption and header row repeated, and prose carries a short overlap.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from . import config
from .extract import IDENTIFIERS, Element, extract_pdf, table_to_markdown

COMPONENT_TERMS = [
    "main drive motor", "lube filter", "lubrication unit", "gear pump", "reservoir",
    "main bearing housing", "bearing", "relief valve", "flywheel", "clutch", "brake",
    "axis 4", "gearbox", "servo drive", "servo motor", "forearm", "weld gun", "dress pack",
    "encoder", "gateway", "ESP32",
]
CHANNELS = IDENTIFIERS[:7]
FAULT_CODE_RE = re.compile(r"\bF\d{2}\b")
CASE_RE = re.compile(r"\b(?:Case|CASE)[ -]?(\d{1,2})\b|\b(C\d{2})\b")
TABLE_NO_RE = re.compile(r"^Table\s+(\d+)\.")


def _unit_text(el: Element) -> str:
    return table_to_markdown(el.rows, el.caption) if el.kind == "table" else el.text


def _split_table(el: Element, limit: int) -> list[str]:
    """Row-wise split of an oversized table; caption and header row repeat in every part."""
    header, body = el.rows[0], el.rows[1:]
    parts, current, size = [], [], 0
    for row in body:
        row_len = sum(len(c) for c in row) + 3 * len(row)
        if current and size + row_len > limit:
            parts.append(current)
            current, size = [], 0
        current.append(row)
        size += row_len
    if current:
        parts.append(current)
    out = []
    for i, rows in enumerate(parts, start=1):
        caption = f"{el.caption} (part {i} of {len(parts)})" if el.caption else ""
        out.append(table_to_markdown([header] + rows, caption))
    return out


def _doc_meta(path: Path, machine: str) -> dict:
    doc_no = path.name[:2]
    title = re.sub(r"_(Press_Stamp|Sensor1)$", "", path.stem[3:]).replace("_", " ")
    return {
        "machine": machine,
        "machine_label": config.MACHINE_LABELS[machine],
        "document": title,
        "doc_no": doc_no,
        "document_type": config.DOC_TYPES.get(doc_no, "other"),
        "filename": path.name,
        "source": str(path.relative_to(config.RAG_ROOT)),
    }


def chunk_document(path: Path, machine: str) -> list[dict]:
    meta = _doc_meta(path, machine)
    elements = extract_pdf(path)
    chunks: list[dict] = []
    h1, h2 = "Cover and document control", ""
    h1_no, h2_no = "0", ""
    buf: list[tuple[str, int, str, str, str]] = []  # (text, page, kind, h2 title, h2 number)

    def flush(carry_overlap: bool = False):
        nonlocal buf
        if not buf:
            return
        body = "\n\n".join(u[0] for u in buf)
        subsections = list(dict.fromkeys(u[3] for u in buf if u[3]))
        section_numbers = [h1_no] + list(dict.fromkeys(u[4] for u in buf if u[4]))
        section = h1 if not subsections else f"{h1} > {'; '.join(subsections)}"
        header = (f"[Machine: {meta['machine']} ({meta['machine_label']}) | "
                  f"Document {meta['doc_no']}: {meta['document']} | Section: {section}]")
        tables = [m.group(1) for u in buf for m in [TABLE_NO_RE.match(u[0])] if m]
        chunk = dict(meta)
        chunk.update({
            "chunk_id": f"{meta['machine']}:{meta['doc_no']}:{len(chunks):03d}",
            "section": section,
            "section_numbers": section_numbers,
            "page": buf[0][1],
            "page_end": buf[-1][1],
            "tables": tables,
            "sensors": [c for c in CHANNELS if c in body],
            "components": [c for c in COMPONENT_TERMS if c.lower() in body.lower()],
            "fault_codes": sorted(set(FAULT_CODE_RE.findall(section + " " + body))),
            "text": body,
            "embed_text": f"{header}\n{body}",
        })
        chunk["content_hash"] = hashlib.sha256(chunk["embed_text"].encode()).hexdigest()
        chunks.append(chunk)
        last = buf[-1]
        keep = carry_overlap and last[2] == "para" and len(last[0]) <= config.CHUNK_OVERLAP_CHARS
        buf = [last] if keep else []

    def size() -> int:
        return sum(len(u[0]) for u in buf)

    for el in elements:
        if el.kind == "heading":
            if el.level == 1:
                flush()
                h1, h1_no, h2, h2_no = el.text, el.number, "", ""
            else:
                # a new subsection closes the chunk once it holds a useful amount of evidence
                if size() >= config.CHUNK_TARGET_CHARS // 2:
                    flush()
                h2, h2_no = el.text, el.number
            continue
        text = _unit_text(el)
        pieces = [text]
        if el.kind == "table" and len(text) > config.CHUNK_MAX_CHARS:
            pieces = _split_table(el, config.CHUNK_TARGET_CHARS)
        for piece in pieces:
            if buf and size() + len(piece) > config.CHUNK_MAX_CHARS:
                flush(carry_overlap=el.kind == "para")
            buf.append((piece, el.page, el.kind, h2, h2_no))
            if size() >= config.CHUNK_TARGET_CHARS:
                flush(carry_overlap=True)
                if buf and buf[0][0] == piece:  # the overlap must not re-emit the same unit alone
                    buf = []
    flush()
    return chunks


def build_chunks() -> list[dict]:
    """Chunk every PDF under the machine folders. Deterministic, local, no API calls."""
    chunks = []
    for machine, folder in config.MACHINE_DIRS.items():
        for path in sorted(folder.glob("*.pdf")):
            chunks.extend(chunk_document(path, machine))
    return chunks


def save_chunks(chunks: list[dict], path: Path = config.CHUNKS_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for c in chunks:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")


def load_chunks(path: Path = config.CHUNKS_PATH) -> list[dict]:
    with path.open() as f:
        return [json.loads(line) for line in f]
