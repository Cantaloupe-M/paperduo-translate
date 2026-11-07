"""Separate illustration labels accidentally merged into TEI body sentences.

GROBID sometimes puts dozens of tiny/rotated diagram boxes before a normal
paragraph. Use the PDF text layer to verify the boundary; geometry alone must
never be used to guess how many words to remove.
"""
import hashlib
import json
import re
import subprocess
import unicodedata

from lxml import etree


def compact(text):
    return "".join(c.casefold() for c in unicodedata.normalize("NFKC", text) if c.isalnum())


def page_words(pdf, page):
    result = subprocess.run(
        ["pdftotext", "-f", str(page), "-l", str(page), "-bbox-layout", "-", "-"],
        input=pdf, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=True,
    )
    root = etree.fromstring(result.stdout, etree.XMLParser(resolve_entities=False, no_network=True))
    return [(float(w.get("xMin")), float(w.get("yMin")),
             float(w.get("xMax")), float(w.get("yMax")), "".join(w.itertext()))
            for w in root.xpath('//*[local-name()="word"]')]


def paragraph_starts(sentence_boxes):
    """Indices of sentences that begin a new paragraph inside one TEI <p>.

    GROBID sometimes merges consecutive paragraphs (typically one that opens with a
    run-in bold heading). Justified text fills every line except a paragraph's last,
    so a sentence that starts at the left edge of a new line right after a clearly
    short line is a paragraph start. Only same-page, same-column pairs are compared.
    """
    starts = set()
    for index in range(1, len(sentence_boxes)):
        before, after = sentence_boxes[index - 1], sentence_boxes[index]
        if not before or not after or before[-1]["page"] != after[0]["page"]:
            continue
        last, first = before[-1], after[0]
        lines = [b for boxes in sentence_boxes for b in boxes if b["page"] == last["page"]]
        widest = max(b["width"] for b in lines)
        # Full-width lines at this sentence's left edge define the column's right edge.
        column = [b for b in lines if b["width"] >= 0.9 * widest and abs(b["x"] - first["x"]) <= 4]
        if widest < 100 or not column or last["x"] < first["x"] - 4:
            continue
        edge = max(b["x"] + b["width"] for b in column)
        if first["y"] >= last["y"] + 0.5 * last["height"] and last["x"] + last["width"] < edge - 12:
            starts.add(index)
    return starts


def illustration_boundary(boxes):
    """Return a conservative diagram-prefix / horizontal-text-suffix boundary."""
    if len(boxes) < 10 or len({b["page"] for b in boxes}) != 1:
        return None
    # A readable suffix consists of regular, wide horizontal text lines.
    start = len(boxes)
    while start and boxes[start - 1]["width"] >= 80 and boxes[start - 1]["height"] >= 6:
        start -= 1
    prefix, tail = boxes[:start], boxes[start:]
    if len(prefix) < 8 or not tail:
        return None
    if sum(b["height"] < 5 or b["height"] > b["width"] for b in prefix) < len(prefix) / 2:
        return None
    top = tail[0]["y"]
    if max(b["y"] + b["height"] for b in prefix) + 12 > top:
        return None
    if any(b["y"] < a["y"] or b["y"] - a["y"] > 2.5 * max(a["height"], b["height"])
           for a, b in zip(tail, tail[1:])):
        return None
    return start


def suffix_offset(source, boxes, words):
    lines = []
    for box in boxes:
        selected = [w for w in words
                    if box["x"] - 1 <= (w[0] + w[2]) / 2 <= box["x"] + box["width"] + 1
                    and box["y"] - 1 <= (w[1] + w[3]) / 2 <= box["y"] + box["height"] + 1]
        lines.append(" ".join(w[4] for w in sorted(selected, key=lambda w: w[0])))
    expected = compact(" ".join(lines))
    actual = compact(source)
    if len(expected) < 30 or not actual.endswith(expected) or actual == expected:
        return None
    # Map the normalized boundary back to the original TEI text, preserving
    # its equations, punctuation, citations and spelling exactly.
    remaining = len(actual) - len(expected)
    for offset, char in enumerate(source):
        length = len(compact(char))
        if remaining == 0 and length:
            return offset
        remaining -= length
    return None


def separate_illustrations(segments, pdf):
    if not pdf:
        return segments
    pages = {}
    output = []
    caption_paragraphs = {}
    for segment in segments:
        boundary = illustration_boundary(segment["boxes"]) if segment["kind"] in ("sentence", "paragraph") else None
        offset = None
        if boundary is not None:
            page = segment["boxes"][0]["page"]
            if page not in pages:
                try:
                    pages[page] = page_words(pdf, page)
                except (OSError, subprocess.SubprocessError, etree.XMLSyntaxError, ValueError):
                    pages[page] = []
            offset = suffix_offset(segment["source"], segment["boxes"][boundary:], pages[page])
        if offset is None:
            if segment["paragraph_id"] in caption_paragraphs:
                segment = dict(segment, kind="figure", paragraph_id=caption_paragraphs[segment["paragraph_id"]])
            output.append(segment)
            continue
        group = segment["paragraph_id"]
        for source, boxes, kind in (
            (segment["source"][:offset].strip(), segment["boxes"][:boundary], "figure-content"),
            (segment["source"][offset:].strip(), segment["boxes"][boundary:], segment["kind"]),
        ):
            if kind != "figure-content" and re.match(r"^(?:Figure|Fig\.|Table)\s*\d", source):
                kind = "figure"
            identity = json.dumps([segment["id"], source, boxes, kind], ensure_ascii=False, sort_keys=True)
            segment_id = "s-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
            output.append(dict(segment, id=segment_id, kind=kind, source=source, boxes=boxes,
                               paragraph_id=segment_id))
            if kind == "figure":
                caption_paragraphs[group] = segment_id
            elif kind != "figure-content":
                # A body paragraph after a figure starts its own group.
                caption_paragraphs.pop(group, None)
    return output
