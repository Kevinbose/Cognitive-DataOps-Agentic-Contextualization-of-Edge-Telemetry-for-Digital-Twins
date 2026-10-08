"""Local PDF extraction: an ordered stream of headings, paragraphs and intact tables per document.

No API calls. Tables are detected with PyMuPDF and kept as row/column grids so that a threshold
never gets separated from the channel and level it belongs to.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf

HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\.?\s+\S")
CAPTION_RE = re.compile(r"^(Table|Figure)\s+(\d+)\.")
TOC_DOTS_RE = re.compile(r"(\s\.\s){5,}")
HEADER_Y = 45      # running header sits at y ~ 25
FOOTER_MARGIN = 45  # running footer sits ~ 33 pt above the page bottom


@dataclass
class Element:
    kind: str                 # heading | para | table
    text: str
    page: int
    level: int = 0            # heading level (1 or 2)
    number: str = ""          # heading number, e.g. "4.2"
    caption: str = ""         # table caption
    rows: list[list[str]] = field(default_factory=list)


# Identifiers that narrow table columns wrap mid-word ("MAIN_MOTOR_C" / "URRENT"). They are the
# retrieval keys of the whole corpus, so they are healed back into one token.
IDENTIFIERS = [
    "MAIN_MOTOR_CURRENT", "LUBE_OIL_PRESSURE", "BEARING_VIBRATION_RMS", "BEARING_SPECTRUM",
    "AXIS_4_SERVO_TORQUE", "TOOL_CENTER_POINT_DEVIATION", "WELD_GUN_TEMP",
    "CLOGGED_FILTER", "BEARING_WEAR", "GEARBOX_WEAR",
]
_HEAL = [(re.compile(r"\s?".join(map(re.escape, ident))), ident) for ident in IDENTIFIERS]
_HEAL += [(re.compile(r"\bmm /s\b"), "mm/s"), (re.compile(r"\bUni t\b"), "Unit"),
          (re.compile(r"\brati o\b"), "ratio")]


def _clean(s: str) -> str:
    s = re.sub(r"\s+", " ", s or "").strip()
    for pattern, fixed in _HEAL:
        s = pattern.sub(fixed, s)
    return s


def _page_items(page) -> tuple[list[dict], list]:
    """Text blocks outside tables, plus the tables, each with its top y."""
    tables = page.find_tables().tables
    boxes = [pymupdf.Rect(t.bbox) for t in tables]
    bottom = page.rect.height - FOOTER_MARGIN
    items = []
    for block in page.get_text("dict")["blocks"]:
        lines = []
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            x0, y0, x1, y1 = line["bbox"]
            if y0 < HEADER_Y or y0 > bottom:
                continue
            centre = pymupdf.Point((x0 + x1) / 2, (y0 + y1) / 2)
            if any(centre in b for b in boxes):
                continue
            lines.append({
                "y": y0,
                "text": _clean(" ".join(s["text"] for s in spans)),
                "size": round(spans[0]["size"], 1),
                "bold": "Bold" in spans[0]["font"],
            })
        # split a block wherever the style changes, so a heading never swallows body text
        group: list[dict] = []
        for ln in lines:
            if group and (ln["size"], ln["bold"]) != (group[-1]["size"], group[-1]["bold"]):
                items.append(_merge(group))
                group = []
            group.append(ln)
        if group:
            items.append(_merge(group))
    for t in tables:
        # clip-based cell text: Table.extract() scatters the underscores of identifiers
        rows = [[_clean(page.get_text("text", clip=c)) if c else "" for c in row.cells]
                for row in t.rows]
        rows = [r for r in rows if any(r)]
        if rows:
            items.append({"y": t.bbox[1], "table": rows})
    items.sort(key=lambda i: i["y"])
    return items, tables


def _merge(group: list[dict]) -> dict:
    return {
        "y": group[0]["y"],
        "text": _clean(" ".join(g["text"] for g in group)),
        "size": group[0]["size"],
        "bold": group[0]["bold"],
    }


def _is_heading(item: dict) -> re.Match | None:
    if "text" in item and item["bold"] and item["size"] >= 10.9:
        return HEADING_RE.match(item["text"])
    return None


def extract_pdf(path: Path) -> list[Element]:
    """Ordered elements of one document. The contents listing is dropped, the cover is kept."""
    doc = pymupdf.open(path)
    elements: list[Element] = []
    in_toc = False
    body_started = False
    pending_caption = ""
    for pno, page in enumerate(doc, start=1):
        items, _ = _page_items(page)
        first_on_page = True
        for item in items:
            text = item.get("text", "")
            if not body_started:
                if text == "Contents":
                    in_toc = True
                    continue
                m = _is_heading(item)
                if in_toc and not (m and item["size"] >= 13.5 and not TOC_DOTS_RE.search(text)):
                    continue  # still inside the contents listing
                if in_toc:
                    in_toc, body_started = False, True
            if "table" in item:
                rows = item["table"]
                prev = elements[-1] if elements else None
                if (first_on_page and not pending_caption and prev and prev.kind == "table"
                        and len(prev.rows[0]) == len(rows[0])):
                    # a table that continues from the previous page
                    prev.rows.extend(rows[1:] if rows[0] == prev.rows[0] else rows)
                else:
                    elements.append(Element("table", "", pno, caption=pending_caption, rows=rows))
                pending_caption = ""
            elif (m := _is_heading(item)):
                number = m.group(1)
                elements.append(Element("heading", text, pno, level=min(number.count(".") + 1, 2),
                                        number=number))
            elif item["bold"] and CAPTION_RE.match(text):
                pending_caption = text
            elif TOC_DOTS_RE.search(text):
                continue
            else:
                if pending_caption:  # caption that was not followed by a detected table
                    text, pending_caption = f"{pending_caption} {text}", ""
                elements.append(Element("para", text, pno))
            first_on_page = False
    return elements


def table_to_markdown(rows: list[list[str]], caption: str = "") -> str:
    """Pipe table with the header row first; the caption stays attached."""
    out = [caption] if caption else []
    for i, row in enumerate(rows):
        out.append("| " + " | ".join(c.replace("|", "/") for c in row) + " |")
        if i == 0 and len(rows) > 1:
            out.append("|" + "---|" * len(row))
    return "\n".join(out)
