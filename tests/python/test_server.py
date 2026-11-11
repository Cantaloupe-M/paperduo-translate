import base64
import json
import math
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient

from paperduo import server
from paperduo import translation
from test_layout import BOXES, DIAGRAM, SOURCE, WORDS

TEI = b'''<TEI xmlns="http://www.tei-c.org/ns/1.0">
<teiHeader><fileDesc><titleStmt><title type="main" coords="1,50,40,450,20">A CS Paper</title></titleStmt>
<sourceDesc><biblStruct><analytic><author><persName>Ada Example</persName></author></analytic></biblStruct></sourceDesc>
</fileDesc><profileDesc><abstract><p><s coords="1,50,100,220,12">A structured abstract.</s></p></abstract></profileDesc></teiHeader>
<facsimile><surface n="1" lrx="612" lry="792"/><surface n="2" lrx="612" lry="792"/></facsimile>
<text><body><div><head coords="1,50,200,200,14">1 Introduction</head>
<p coords="1,50,220,500,100"><s xml:id="random-id" coords="1,50,220,200,12;1,50,234,100,12">See <ref type="bibr" target="#b0">[1]</ref> for the method.</s>
<s coords="1,330,700,200,12;2,50,50,200,12">A sentence across pages.</s>
<s>A sentence without coordinates.</s></p>
<formula coords="2,50,90,200,20">x = y + 1</formula>
<figure coords="2,50,120,200,80"><figDesc>Figure 1. Architecture.</figDesc></figure>
</div></body><back><div><listBibl><biblStruct xml:id="b0" coords="2,50,500,200,30">Reference One</biblStruct></listBibl></div></back></text></TEI>'''

ARXIV_FEED = b'''<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/2401.12345v2</id><updated>2024-02-01T00:00:00Z</updated>
<title>A Cached Arxiv Paper</title><summary>Abstract.</summary>
<author><name>Ada Example</name></author>
<link title="pdf" href="https://arxiv.org/pdf/2401.12345v2" />
</entry></feed>'''
ARXIV_LATEST_FEED = ARXIV_FEED.replace(b"/abs/2401.12345v2", b"/abs/2401.12345").replace(
    b"https://arxiv.org/pdf/2401.12345v2", b"https://arxiv.org/pdf/2401.12345v3")


class ParsingTests(unittest.TestCase):
    def test_arxiv_identifiers_and_feed_metadata(self):
        self.assertEqual(server.normalize_arxiv_identifier("https://arxiv.org/abs/2401.12345v2"),
                         ("2401.12345", 2))
        self.assertEqual(server.normalize_arxiv_identifier("arXiv:hep-th/9901001"),
                         ("hep-th/9901001", None))
        metadata = server.parse_arxiv_feed(ARXIV_FEED, "2401.12345", None)
        self.assertEqual(metadata["arxiv_id"], "2401.12345")
        self.assertEqual(metadata["version"], 2)
        self.assertEqual(metadata["authors"], ["Ada Example"])
        self.assertEqual(server.parse_arxiv_feed(ARXIV_LATEST_FEED, "2401.12345", None)["version"], 3)

    def test_multiline_cross_page_and_reading_order(self):
        result = server.parse_tei(TEI)
        self.assertEqual(result["title"], "A CS Paper")
        self.assertEqual(result["authors"], ["Ada Example"])
        sentences = [s for s in result["segments"] if s["kind"] == "sentence"]
        self.assertEqual(len(sentences[1]["boxes"]), 2)
        self.assertEqual(sentences[1]["citations"], ["b0"])
        self.assertEqual([b["page"] for b in sentences[2]["boxes"]], [1, 2])
        self.assertEqual(sentences[3]["boxes"], [])
        self.assertEqual(result["unlocated_count"], 1)
        self.assertEqual(result["outline"][0]["title"], "1 Introduction")
        self.assertEqual(sentences[1]["section"], "1 Introduction")
        self.assertEqual(sentences[1]["paragraph_id"], sentences[2]["paragraph_id"])
        self.assertNotEqual(sentences[0]["paragraph_id"], sentences[1]["paragraph_id"])
        figure = next(s for s in result["segments"] if s["kind"] == "figure")
        self.assertEqual(figure["boxes"][0]["y"], 120)

    def test_ids_ignore_random_grobid_ids(self):
        first = server.parse_tei(TEI)
        second = server.parse_tei(TEI.replace(b'random-id', b'another-id'))
        self.assertEqual([s["id"] for s in first["segments"]], [s["id"] for s in second["segments"]])

    def test_bad_coordinates_never_become_overlays(self):
        for value in ("garbage", "1,nan,0,20,20", "1,0,0,inf,20", "0,0,0,20,20",
                      "1.5,0,0,20,20", "1,0,0,-2,20", "1,0,0,20,0"):
            with self.subTest(value=value):
                self.assertEqual(server.coordinates(value), [])
        self.assertTrue(all(math.isfinite(v) for v in server.coordinates("1,2,3,4,5")[0].values()))

    def test_missing_geometry_and_invalid_xml_are_rejected(self):
        for xml in (b"not xml", TEI.replace(b'lrx="612"', b'lrx="0"'),
                    TEI.replace(b'coords="1,50,40,450,20"', b'coords="1,nan,40,450,20"').replace(
                        b'lrx="612"', b'lrx="nan"')):
            with self.subTest(xml=xml[:30]):
                with self.assertRaises((ValueError, server.etree.XMLSyntaxError)):
                    server.parse_tei(xml)


class ArxivNetworkTests(unittest.IsolatedAsyncioTestCase):
    async def test_metadata_and_pdf_share_proxy_with_environment_fallback(self):
        for settings, expected in (
            ({"ARXIV_HTTP_PROXY": "http://arxiv-proxy.test:8080",
              "HTTPS_PROXY": "http://host-proxy.test:8080"}, "http://arxiv-proxy.test:8080"),
            ({"HTTPS_PROXY": "http://host-proxy.test:8080"}, "http://host-proxy.test:8080"),
            ({"https_proxy": "http://lower-proxy.test:8080"}, "http://lower-proxy.test:8080"),
            ({}, None),
        ):
            with self.subTest(settings=settings):
                remote = AsyncMock()
                remote.get.side_effect = [
                    httpx.Response(200, content=ARXIV_FEED,
                                   request=httpx.Request("GET", server.ARXIV_API_URL)),
                    httpx.Response(200, content=b"%PDF-1.4 test",
                                   request=httpx.Request("GET", "https://arxiv.org/pdf/2401.12345v2")),
                ]
                environment = {"ARXIV_HTTP_PROXY": "", "HTTPS_PROXY": "", "https_proxy": "", **settings}
                with patch.dict(os.environ, environment), patch.object(server.httpx, "AsyncClient") as factory:
                    factory.return_value.__aenter__ = AsyncMock(return_value=remote)
                    factory.return_value.__aexit__ = AsyncMock(return_value=False)
                    metadata = await server.fetch_arxiv_metadata("2401.12345")
                    data = await server.download_arxiv_pdf(metadata)
                self.assertEqual(metadata["version"], 2)
                self.assertEqual(data, b"%PDF-1.4 test")
                self.assertEqual(factory.call_count, 2)
                for call in factory.call_args_list:
                    self.assertEqual(call.kwargs["proxy"], expected)
                    self.assertFalse(call.kwargs["trust_env"])


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path_patch = patch.object(server, "DATA_DIR", Path(self.directory.name))
        self.path_patch.start()
        self.settings_patch = patch.object(translation, "settings_path", return_value=Path(self.directory.name) / "llm-settings.json")
        self.settings_patch.start()
        self.env_patch = patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "http://model.test/v1",
                                                  "TRANSLATION_LLM_MODEL": "model-a",
                                                  "TRANSLATION_LLM_MODELS": "model-b"})
        self.env_patch.start()
        self.client = TestClient(server.app)

    def tearDown(self):
        self.client.close()
        self.env_patch.stop()
        self.settings_patch.stop()
        self.path_patch.stop()
        self.directory.cleanup()

    def import_paper(self):
        response = httpx.Response(200, content=TEI, request=httpx.Request("POST", "http://grobid.test"))
        remote = AsyncMock()
        remote.post.return_value = response
        with patch.object(server.httpx, "AsyncClient") as factory:
            factory.return_value.__aenter__ = AsyncMock(return_value=remote)
            factory.return_value.__aexit__ = AsyncMock(return_value=False)
            result = self.client.post("/api/documents", files={"file": ("paper.pdf", b"%PDF-1.4 test", "application/pdf")})
        self.assertEqual(result.status_code, 200, result.text)
        sent = remote.post.call_args.kwargs["files"]
        self.assertIn(("segmentSentences", (None, "1")), sent)
        self.assertIn(("teiCoordinates", (None, "s")), sent)
        return result.json()

    def test_profile_persists_and_avatar_can_be_removed(self):
        self.assertEqual(self.client.get('/api/profile').json(), {"username": "我的空间", "avatar": None})
        avatar = ('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwC'
                  'AAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=')
        saved = self.client.put('/api/profile', json={"username": "  小林  ", "avatar": avatar})
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json(), {"username": "小林", "avatar": avatar})
        with TestClient(server.app) as another_client:
            self.assertEqual(another_client.get('/api/profile').json(), saved.json())
        removed = self.client.put('/api/profile', json={"username": "新用户名", "avatar": None})
        self.assertEqual(removed.status_code, 200)
        self.assertEqual(self.client.get('/api/profile').json(), {"username": "新用户名", "avatar": None})

    def test_arxiv_metadata_timeout_returns_retryable_error(self):
        remote = AsyncMock()
        remote.get.side_effect = httpx.ConnectTimeout("offline")
        with patch.object(server.httpx, "AsyncClient") as factory:
            factory.return_value.__aenter__ = AsyncMock(return_value=remote)
            factory.return_value.__aexit__ = AsyncMock(return_value=False)
            result = self.client.post("/api/arxiv", json={"identifier": "2401.12345"})
        self.assertEqual(result.status_code, 503)
        self.assertIn("连接 arXiv 超时", result.json()["detail"])
        self.assertIn("代理", result.json()["detail"])
        self.assertEqual(self.client.get("/api/documents").json(), [])

    def test_invalid_profile_updates_preserve_saved_profile(self):
        original = {"username": "保留资料", "avatar": None}
        self.client.put('/api/profile', json=original)
        for update in ({"username": "   "}, {"username": "名" * 33},
                       {"username": "名字", "avatar": "https://example.test/image.png"},
                       {"username": "名字", "avatar": "data:image/svg+xml;base64,PHN2Zz4="},
                       {"username": "名字", "avatar": "data:image/png;base64,!!!!"},
                       {"username": "名字", "avatar": "data:image/png;base64,YQ=="},
                       {"username": "名字", "avatar": "data:image/png;base64,A"}):
            with self.subTest(update=update):
                self.assertEqual(self.client.put('/api/profile', json=update).status_code, 422)
                self.assertEqual(self.client.get('/api/profile').json(), original)
        oversized = 'data:image/png;base64,' + base64.b64encode(
            b'\x89PNG\r\n\x1a\n' + b'x' * server.MAX_AVATAR_BYTES).decode()
        self.assertIn(self.client.put('/api/profile', json={"username": "名字", "avatar": oversized}).status_code,
                      (413, 422))
        self.assertEqual(self.client.get('/api/profile').json(), original)

    def test_import_cache_and_persistent_translations(self):
        document = self.import_paper()
        segment = document["segments"][0]["id"]
        self.assertFalse(document["cached"])
        path = f'/api/documents/{document["id"]}'
        saved = self.client.put(path + "/translations", json={"translations": {segment: "译文\n第二行"}})
        self.assertEqual(saved.status_code, 200)
        loaded = self.client.get(path).json()
        self.assertEqual(loaded["translations"][segment], "译文\n第二行")
        with patch.object(server.httpx, "AsyncClient", side_effect=AssertionError("cache must not call parser")):
            cached = self.client.post("/api/documents", files={"file": ("paper.pdf", b"%PDF-1.4 test")})
        self.assertTrue(cached.json()["cached"])
        self.assertEqual(cached.json()["translations"][segment], "译文\n第二行")
        self.assertEqual(self.client.get(path + "/pdf").content, b"%PDF-1.4 test")
        self.assertEqual(self.client.get(path + "/tei").content, TEI)

    def test_invalid_translation_id_does_not_overwrite_other_papers(self):
        document = self.import_paper()
        path = f'/api/documents/{document["id"]}/translations'
        self.assertEqual(self.client.put(path, json={"translations": {"made-up": "wrong"}}).status_code, 422)

    def test_library_classification_preserves_papers_translations_and_progress(self):
        document = self.import_paper()
        path = f'/api/documents/{document["id"]}'
        segment = document["segments"][0]["id"]
        self.client.put(path + "/translations", json={"translations": {segment: "保留译文"}})
        created = self.client.post("/api/collections", json={"name": " 强化学习 "})
        self.assertEqual(created.status_code, 201)
        collection = created.json()
        self.assertEqual(collection["name"], "强化学习")
        self.assertEqual(self.client.put(path + "/collection", json={"collection_id": collection["id"]}).status_code, 200)
        self.client.put(path + "/reading", json={"page": 2})
        renamed = self.client.put(f'/api/collections/{collection["id"]}', json={"name": "对齐研究"})
        self.assertEqual(renamed.json()["name"], "对齐研究")
        self.assertEqual(self.client.get("/api/collections").json(), [renamed.json()])
        paper = self.client.get("/api/documents").json()[0]
        self.assertEqual(paper["collection_id"], collection["id"])
        self.assertEqual(paper["title"], "A CS Paper")
        self.assertEqual(paper["authors"], ["Ada Example"])
        self.assertEqual(paper["page_count"], 2)
        self.assertEqual(paper["last_page"], 2)
        self.client.delete(f'/api/collections/{collection["id"]}')
        restored = self.client.get(path).json()
        self.assertIsNone(restored["collection_id"])
        self.assertEqual(restored["last_page"], 2)
        self.assertEqual(restored["last_read_at"], paper["last_read_at"])
        self.assertEqual(restored["translations"][segment], "保留译文")
        self.assertEqual(self.client.get(path + "/pdf").content, b"%PDF-1.4 test")

    def test_recent_reading_uses_explicit_read_activity_and_library_has_no_thirty_paper_limit(self):
        document = self.import_paper()
        with server.database() as db:
            row = server.get_document(db, document["id"])
            for index in range(35):
                db.execute("INSERT INTO documents (id, filename, pdf, tei, parsed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                           (f"paper-{index}", f"paper-{index}.pdf", row["pdf"], row["tei"], row["parsed"], "2020-01-01 00:00:00"))
        self.assertEqual(len(self.client.get("/api/documents").json()), 36)
        # Fetching metadata and previews does not count as reading a paper.
        self.assertIsNone(self.client.get("/api/documents/paper-0").json()["last_read_at"])
        self.client.get("/api/documents/paper-0/pdf")
        self.assertIsNone(next(d for d in self.client.get("/api/documents").json() if d["id"] == "paper-0")["last_read_at"])
        self.client.put("/api/documents/paper-0/reading", json={"page": 2})
        papers = self.client.get("/api/documents").json()
        self.assertEqual(papers[0]["id"], "paper-0")
        self.assertEqual(papers[0]["last_page"], 2)
        self.client.put(f'/api/documents/{document["id"]}/reading', json={"page": 1})
        self.assertEqual(self.client.get("/api/documents").json()[0]["id"], document["id"])

    def test_library_rejects_invalid_changes_and_supports_unfiled(self):
        document = self.import_paper()
        path = f'/api/documents/{document["id"]}'
        for name in (" ", "x" * 61):
            self.assertEqual(self.client.post("/api/collections", json={"name": name}).status_code, 422)
        collection = self.client.post("/api/collections", json={"name": "论文"}).json()
        self.assertEqual(self.client.post("/api/collections", json={"name": "论文"}).status_code, 409)
        other = self.client.post("/api/collections", json={"name": "其他"}).json()
        self.assertEqual(self.client.put(f'/api/collections/{other["id"]}', json={"name": "论文"}).status_code, 409)
        self.assertEqual(self.client.put(path + "/collection", json={"collection_id": "missing"}).status_code, 404)
        self.client.put(path + "/collection", json={"collection_id": collection["id"]})
        self.client.put(path + "/collection", json={"collection_id": None})
        self.assertIsNone(self.client.get(path).json()["collection_id"])
        for page in (0, 3):
            self.assertEqual(self.client.put(path + "/reading", json={"page": page}).status_code, 422)
        for suffix, body in (("reading", {"page": 1}), ("collection", {"collection_id": None})):
            self.assertEqual(self.client.put(f"/api/documents/missing/{suffix}", json=body).status_code, 404)
        self.assertEqual(self.client.delete("/api/collections/missing").status_code, 404)

    def test_cached_tei_upgrade_preserves_translation_ids(self):
        document = self.import_paper()
        with server.database() as db:
            old = dict(document, schema_version=1)
            for segment in old["segments"]:
                segment.pop("paragraph_id", None)
            db.execute("UPDATE documents SET parsed=? WHERE id=?", (json.dumps(old), document["id"]))
        migrated = self.client.get(f'/api/documents/{document["id"]}').json()
        self.assertEqual(migrated["schema_version"], server.SCHEMA_VERSION)
        self.assertEqual([s["id"] for s in migrated["segments"]], [s["id"] for s in document["segments"]])
        self.assertTrue(all(s["paragraph_id"] for s in migrated["segments"]))

    def test_machine_translation_cached_and_never_overwrites_manual(self):
        document = self.import_paper()
        segment = document["segments"][0]["id"]
        path = f'/api/documents/{document["id"]}'
        with patch.object(server, "translate_segments", new=AsyncMock(return_value={segment: "计算机论文"})) as remote:
            first = self.client.post(path + "/translate", json={"segment_ids": [segment]})
            second = self.client.post(path + "/translate", json={"segment_ids": [segment]})
            self.assertEqual(first.json()["translations"][segment], "计算机论文")
            self.assertEqual(second.json()["translations"][segment], "计算机论文")
            self.assertEqual(remote.await_count, 1)
        self.client.put(path + "/translations", json={"translations": {segment: "人工修订"}})
        with patch.object(server, "translate_segments", side_effect=AssertionError("manual must win")):
            result = self.client.post(path + "/translate", json={"segment_ids": [segment]})
        self.assertEqual(result.json()["translations"][segment], "人工修订")

    def test_layout_upgrade_keeps_other_edits_and_rejects_old_mixed_translation(self):
        document = self.import_paper()
        root = server.etree.fromstring(TEI)
        sentence = root.find("t:text/t:body/t:div/t:p/t:s", server.NS)
        for child in list(sentence):
            sentence.remove(child)
        sentence.text = DIAGRAM + " " + SOURCE
        sentence.set("coords", ";".join(
            ",".join(str(box[key]) for key in ("page", "x", "y", "width", "height"))
            for box in BOXES))
        xml = server.etree.tostring(root)
        old = server.parse_tei(xml)
        old["schema_version"] = 2
        mixed = next(s for s in old["segments"] if s["source"].startswith(DIAGRAM))
        title = old["segments"][0]["id"]
        with server.database() as db:
            db.execute("UPDATE documents SET tei=?, parsed=? WHERE id=?",
                       (xml, json.dumps(old), document["id"]))
            db.executemany("INSERT INTO translations VALUES (?, ?, ?)", [
                (document["id"], title, "标题人工修订"),
                (document["id"], mixed["id"], "错误混合译文"),
            ])
        path = f'/api/documents/{document["id"]}'
        with patch("paperduo.layout.page_words", return_value=WORDS):
            upgraded = self.client.get(path).json()
        definition = next(s for s in upgraded["segments"] if s["source"] == SOURCE)
        self.assertEqual(definition["boxes"], BOXES[8:])
        self.assertNotIn(mixed["id"], upgraded["translations"])
        self.assertNotIn(definition["id"], upgraded["translations"])
        self.assertEqual(upgraded["translations"][title], "标题人工修订")
        with server.database() as db:
            self.assertIsNotNone(db.execute("SELECT text FROM translations WHERE segment_id=?",
                                           (mixed["id"],)).fetchone())
        reloaded = self.client.get(path).json()
        self.assertEqual(reloaded["segments"], upgraded["segments"])
        saved = self.client.put(path + "/translations", json={"translations": {definition["id"]: "新定义译文"}})
        self.assertEqual(saved.status_code, 200)

    def test_regeneration_bypasses_saved_translation_and_provider_cache(self):
        document = self.import_paper()
        segment = document["segments"][0]["id"]
        path = f'/api/documents/{document["id"]}'
        with patch.object(server, "translate_segments", new=AsyncMock(return_value={segment: "旧机器译文"})):
            self.client.post(path + "/translate", json={"provider": "academic-llm", "segment_ids": [segment]})
        self.client.put(path + "/translations", json={"translations": {segment: "人工修改"}})
        with patch.object(server, "translate_segments", new=AsyncMock(return_value={segment: "重新生成的译文"})) as remote:
            result = self.client.post(path + "/translate", json={
                "provider": "academic-llm", "segment_ids": [segment], "force": True})
        self.assertEqual(result.json()["translations"][segment], "重新生成的译文")
        remote.assert_awaited_once()
        self.assertEqual(self.client.get(path).json()["translations"][segment], "重新生成的译文")
        # Clearing the document value now reuses the refreshed provider cache.
        self.client.put(path + "/translations", json={"translations": {segment: ""}})
        with patch.object(server, "translate_segments", side_effect=AssertionError("fresh cache should be reused")):
            result = self.client.post(path + "/translate", json={
                "provider": "academic-llm", "segment_ids": [segment]})
        self.assertEqual(result.json()["translations"][segment], "重新生成的译文")

    def test_regeneration_preserves_failed_segments_and_skips_formulas(self):
        document = self.import_paper()
        ids = [s["id"] for s in document["segments"] if s["kind"] == "sentence"][:2]
        formula = next(s["id"] for s in document["segments"] if s["kind"] == "formula")
        path = f'/api/documents/{document["id"]}'
        self.client.put(path + "/translations", json={"translations": {key: "原译文" for key in ids}})
        with patch.object(server, "translate_segments", new=AsyncMock(side_effect=server.TranslationError("服务繁忙"))):
            result = self.client.post(path + "/translate", json={
                "segment_ids": [formula, *ids], "force": True}).json()
        self.assertIn(formula, result["skipped"])
        self.assertEqual(set(result["errors"]), set(ids))
        saved = self.client.get(path).json()["translations"]
        self.assertEqual(saved[ids[0]], "原译文")
        self.assertEqual(saved[ids[1]], "原译文")

    def test_academic_regeneration_preserves_edits_saved_while_provider_runs(self):
        document = self.import_paper()
        ids = [s["id"] for s in document["segments"] if s["kind"] == "sentence"][:2]
        path = f'/api/documents/{document["id"]}'
        self.client.put(path + "/translations", json={"translations": {key: "旧译文" for key in ids}})

        async def translate(provider, segments, model=None):
            self.assertEqual(provider, "academic-llm")
            self.assertEqual([s["id"] for s in segments], ids)
            with server.database() as db:
                db.execute("UPDATE translations SET text=? WHERE document_id=? AND segment_id=?",
                           ("生成期间的人工编辑", document["id"], ids[0]))
            return {key: "学术模型新译文" for key in ids}

        with patch.object(server, "translate_segments", new=translate):
            result = self.client.post(path + "/translate", json={
                "provider": "academic-llm", "segment_ids": ids, "force": True}).json()
        self.assertEqual(result["translations"][ids[0]], "生成期间的人工编辑")
        self.assertEqual(result["translations"][ids[1]], "学术模型新译文")

    def test_model_selection_and_cache_are_used_end_to_end(self):
        document = self.import_paper()
        segment = document["segments"][0]["id"]
        path = f'/api/documents/{document["id"]}'
        self.assertEqual(self.client.get("/api/translation/models").json(),
                         {"models": ["model-a", "model-b"], "default_model": "model-a"})
        for model in ("model-a", "model-b"):
            with patch.object(server, "translate_segments", new=AsyncMock(return_value={segment: model})) as remote:
                result = self.client.post(path + "/translate", json={"model": model, "segment_ids": [segment]})
            self.assertEqual(result.json()["translations"][segment], model)
            self.assertEqual(remote.call_args.kwargs["model"], model)
            self.client.put(path + "/translations", json={"translations": {segment: ""}})
        with patch.object(server, "translate_segments", side_effect=AssertionError("cache should be reused")):
            result = self.client.post(path + "/translate", json={"model": "model-a", "segment_ids": [segment]})
        self.assertEqual(result.json()["translations"][segment], "model-a")
        for payload in ({"provider": "libretranslate"}, {"provider": "mymemory"}, {"model": "unknown"}):
            self.assertEqual(self.client.post(path + "/translate", json={**payload, "segment_ids": [segment]}).status_code, 422)

    def test_web_settings_persist_and_keep_api_key_private(self):
        payload = {"base_url": "http://model.test/v1/", "model": "web-model",
                   "models": ["second-model", "second-model"], "api_key": "private-test-key"}
        saved = self.client.put("/api/translation/settings", json=payload)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotIn("private-test-key", saved.text)
        self.assertNotIn("api_key", saved.json())
        self.assertTrue(saved.json()["has_api_key"])
        self.assertEqual(self.client.get("/api/translation/models").json(),
                         {"models": ["web-model", "second-model"], "default_model": "web-model"})
        self.assertEqual(translation.academic_model_config("second-model")["api_key"], "private-test-key")
        self.assertEqual(translation.settings_path().stat().st_mode & 0o777, 0o600)
        del payload["api_key"]
        payload["model"] = "updated-model"
        self.client.put("/api/translation/settings", json=payload)
        # A fresh settings read uses the persisted model and retains the key.
        self.assertEqual(translation.academic_model_config()["model"], "updated-model")
        self.assertEqual(translation.academic_model_config()["api_key"], "private-test-key")
        fetched = self.client.get("/api/translation/settings")
        self.assertNotIn("private-test-key", fetched.text)
        self.assertEqual(self.client.get("/.reader-data/llm-settings.json").status_code, 404)
        payload["api_key"] = ""
        self.assertFalse(self.client.put("/api/translation/settings", json=payload).json()["has_api_key"])
        for value in ("file:///tmp/private", "https://user:secret@example.test/v1", " "):
            payload["base_url"] = value
            self.assertEqual(self.client.put("/api/translation/settings", json=payload).status_code, 422)
        self.assertEqual(translation.academic_model_config()["base_url"], "http://model.test/v1")

    def test_settings_storage_failure_reports_actionable_error(self):
        before = self.client.get("/api/translation/settings").json()
        for error, message in ((PermissionError("denied"), "目录权限"),
                               (OSError("disk full"), "磁盘空间")):
            with patch.object(server, "save_model_settings", side_effect=error):
                result = self.client.put("/api/translation/settings", json={
                    "base_url": "http://model.test/v1", "model": "model-a", "api_key": "private-key"})
            self.assertEqual(result.status_code, 503)
            self.assertIn(message, result.json()["detail"])
            self.assertNotIn("private-key", result.text)
            self.assertEqual(self.client.get("/api/translation/settings").json(), before)

    def test_missing_llm_disables_models_without_argos_fallback(self):
        document = self.import_paper()
        with patch.dict(os.environ, {"TRANSLATION_LLM_BASE_URL": "", "LIBRETRANSLATE_URL": "http://offline.test"}):
            self.assertEqual(self.client.get("/api/translation/models").json(), {"models": [], "default_model": None})
            result = self.client.post(f'/api/documents/{document["id"]}/translate',
                                      json={"segment_ids": [document["segments"][0]["id"]]})
        self.assertEqual(result.status_code, 503)

    def test_unavailable_parser_and_invalid_upload(self):
        remote = AsyncMock()
        remote.post.side_effect = httpx.ConnectError("offline")
        with patch.object(server.httpx, "AsyncClient") as factory:
            factory.return_value.__aenter__ = AsyncMock(return_value=remote)
            factory.return_value.__aexit__ = AsyncMock(return_value=False)
            result = self.client.post("/api/documents", files={"file": ("paper.pdf", b"%PDF-1.4 test")})
        self.assertEqual(result.status_code, 503)
        self.assertEqual(self.client.post("/api/documents", files={"file": ("x.pdf", b"not pdf")}).status_code, 400)

    def test_private_files_are_not_served(self):
        for path in ("/paperduo/server.py", "/server.py", "/.reader-data/reader.sqlite3", "/README.md", "/../README.md", "/%2e%2e/README.md"):
            self.assertEqual(self.client.get(path).status_code, 404)


if __name__ == "__main__":
    unittest.main()
