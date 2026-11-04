import subprocess
import unittest
from unittest.mock import patch

from paperduo import layout


SOURCE = "where V is a set of executable sub-goals or operations, E ⊆ V × V is a set of dependency edges."
DIAGRAM = "Production Capacity Planning Inventory & Finance Integration SkillFlow Taxonomy"
BOXES = [{"page": 1, "x": 320 + i * 4, "y": 100 + i * 3, "width": 20, "height": 3}
         for i in range(8)] + [
    {"page": 1, "x": 100, "y": 300, "width": 400, "height": 10},
    {"page": 1, "x": 100, "y": 312, "width": 400, "height": 10},
]
WORDS = [(105 + i * 14, 301, 115 + i * 14, 309, word) for i, word in enumerate(SOURCE.split())]


def mixed_segment():
    return {"id": "old-mixed-id", "kind": "sentence", "source": DIAGRAM + " " + SOURCE,
            "boxes": BOXES, "paragraph_id": "mixed-paragraph", "section": "Method", "citations": []}


class IllustrationTests(unittest.TestCase):
    def test_pdf_verified_definition_has_only_body_coordinates(self):
        mixed = mixed_segment()
        following = dict(mixed, id="following-id", source="A DAEF is an abstract workflow.",
                         boxes=[dict(BOXES[-1], y=340)], paragraph_id="following-paragraph")
        with patch.object(layout, "page_words", return_value=WORDS):
            diagram, body, untouched = layout.separate_illustrations([mixed, following], b"pdf")
        self.assertEqual(diagram["source"], DIAGRAM)
        self.assertEqual(diagram["kind"], "figure-content")
        self.assertEqual(diagram["boxes"], BOXES[:8])
        self.assertEqual(body["source"], SOURCE)
        self.assertEqual(body["boxes"], BOXES[8:])
        self.assertNotEqual(body["id"], mixed["id"])
        self.assertNotEqual(body["paragraph_id"], diagram["paragraph_id"])
        self.assertEqual(untouched, following)
        self.assertEqual(mixed, mixed_segment(), "original cached structure must remain intact")

    def test_geometry_without_matching_pdf_text_never_removes_words(self):
        mixed = mixed_segment()
        for words in ([], [(100, 300, 200, 310, "A different paragraph in the PDF text layer.")]):
            with self.subTest(words=words), patch.object(layout, "page_words", return_value=words):
                self.assertEqual(layout.separate_illustrations([mixed], b"pdf"), [mixed])
        with patch.object(layout, "page_words", side_effect=subprocess.TimeoutExpired("pdftotext", 20)):
            self.assertEqual(layout.separate_illustrations([mixed], b"pdf"), [mixed])

    def test_regular_multiline_and_cross_page_sentences_are_unchanged(self):
        regular = [dict(BOXES[-1], y=100 + i * 12) for i in range(12)]
        cross_page = BOXES[:8] + [dict(b, page=2) for b in BOXES[8:]]
        for boxes in (regular, cross_page):
            segment = dict(mixed_segment(), boxes=boxes)
            with patch.object(layout, "page_words", side_effect=AssertionError("no diagram")):
                self.assertEqual(layout.separate_illustrations([segment], b"pdf"), [segment])

    def test_caption_continuation_is_separate_from_body(self):
        caption = "Figure 3: Correspondence of workflows across domains."
        segment = dict(mixed_segment(), source=DIAGRAM + " " + caption)
        continuation = dict(segment, id="caption-next", source="Distinct tasks share a workflow.",
                            boxes=[dict(BOXES[-1], y=326)])
        body = dict(mixed_segment(), id="body-next", boxes=BOXES[:8] +
                    [dict(BOXES[-1], y=360), dict(BOXES[-1], y=372)])
        caption_words = [(101, 301, 490, 309, caption)]
        with patch.object(layout, "page_words", return_value=caption_words + [(101, 361, 490, 369, SOURCE)]):
            # Use a single-line caption and retain the actual body's two lines.
            segment["boxes"] = BOXES[:8] + [dict(BOXES[0], x=400), BOXES[8]]
            result = layout.separate_illustrations([segment, continuation, body], b"pdf")
        self.assertEqual(result[1]["kind"], "figure")
        self.assertEqual(result[2]["kind"], "figure")
        self.assertEqual(result[1]["paragraph_id"], result[2]["paragraph_id"])
        self.assertEqual(result[-1]["kind"], "sentence")

