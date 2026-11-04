"""Local reader API. GROBID parses papers; PDF.js renders the original PDF."""

import hashlib
import json
import math
import os
import re
import sqlite3
import asyncio
from contextlib import closing, contextmanager
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from lxml import etree
from pydantic import BaseModel, Field
from .layout import separate_illustrations
from .translation import (TranslationError, cache_namespace, default_provider, providers,
                         academic_model_config, configured_models, translate_segments,
                         read_model_settings, save_model_settings)

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
DATA_DIR = Path(os.getenv("READER_DATA_DIR", ROOT / ".reader-data"))
GROBID_URL = os.getenv("GROBID_URL", "http://127.0.0.1:8070").rstrip("/")
MAX_PDF_BYTES = 30 * 1024 * 1024
SCHEMA_VERSION = 3
NS = {"t": "http://www.tei-c.org/ns/1.0"}
app = FastAPI(title="PaperDuo", docs_url=None, redoc_url=None)
translation_slots = asyncio.Semaphore(2)


@contextmanager
def database():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(DATA_DIR / "reader.sqlite3", timeout=30)) as db, db:
        db.row_factory = sqlite3.Row
        db.execute("""CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, filename TEXT NOT NULL, pdf BLOB NOT NULL,
            tei BLOB NOT NULL, parsed TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
        db.execute("""CREATE TABLE IF NOT EXISTS translations (
            document_id TEXT NOT NULL, segment_id TEXT NOT NULL, text TEXT NOT NULL,
            PRIMARY KEY (document_id, segment_id))""")
        db.execute("""CREATE TABLE IF NOT EXISTS translation_cache (
            provider TEXT NOT NULL, source_hash TEXT NOT NULL, text TEXT NOT NULL,
            PRIMARY KEY (provider, source_hash))""")
        yield db


def text_of(node):
    return re.sub(r"\s+", " ", "".join(node.itertext())).strip()


def coordinates(value):
    """GROBID: semicolon-separated page,x,y,width,height, in top-left PDF units."""
    boxes = []
    for rectangle in (value or "").split(";"):
        try:
            page, x, y, width, height = map(float, rectangle.split(","))
        except ValueError:
            continue
        if not all(math.isfinite(v) for v in (page, x, y, width, height)):
            continue
        if page < 1 or not page.is_integer() or width <= 0 or height <= 0:
            continue
        boxes.append({"page": int(page), "x": x, "y": y, "width": width, "height": height})
    return boxes


def parse_tei(xml, pdf=None):
    """Retain TEI reading order, sentence bounds, sections and citation targets."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True, recover=False)
    root = etree.fromstring(xml, parser)
    if etree.QName(root).localname != "TEI":
        raise ValueError("解析服务未返回 TEI 论文结构")
    pages = []
    for surface in root.findall("t:facsimile/t:surface", NS):
        pages.append({"page": int(surface.get("n")),
                      "width": float(surface.get("lrx")) - float(surface.get("ulx", 0)),
                      "height": float(surface.get("lry")) - float(surface.get("uly", 0))})
    if not pages or any(not math.isfinite(p[k]) or p[k] <= 0 for p in pages for k in ("width", "height")):
        raise ValueError("解析结果缺少有效页面尺寸，无法可靠定位原文")
    valid_pages = {page["page"] for page in pages}
    segments = []
    outline = []

    def add(node, kind, section="", fallback_coords=None, paragraph_id=None):
        source = text_of(node)
        if not source:
            return
        boxes = coordinates(node.get("coords") or fallback_coords)
        boxes = [b for b in boxes if b["page"] in valid_pages]
        identity = json.dumps([kind, source, boxes, len(segments)], ensure_ascii=False, sort_keys=True)
        segment_id = "s-" + hashlib.sha256(identity.encode()).hexdigest()[:20]
        citations = []
        for ref in node.findall(".//t:ref", NS):
            if ref.get("type") == "bibr":
                citations.extend(target.lstrip("#") for target in ref.get("target", "").split())
        segments.append({"id": segment_id, "kind": kind, "source": source,
                         "section": section, "boxes": boxes, "citations": citations,
                         "paragraph_id": paragraph_id or segment_id})
        if kind == "heading" and boxes:
            outline.append({"id": segment_id, "title": source, "page": boxes[0]["page"]})

    def visit(node, section=""):
        tag = etree.QName(node).localname
        if tag == "div":
            head = node.find("t:head", NS)
            section = text_of(head) if head is not None else section
        if tag == "head":
            add(node, "heading", section)
        elif tag in ("p", "note", "item"):
            paragraph_id = "p-" + hashlib.sha256(json.dumps(
                [text_of(node), node.get("coords"), len(segments)], ensure_ascii=False
            ).encode()).hexdigest()[:20]
            sentences = node.findall(".//t:s", NS)
            if sentences:
                # Never assign the whole paragraph's rectangle to every sentence.
                for sentence in sentences:
                    add(sentence, "sentence", section, paragraph_id=paragraph_id)
            else:
                add(node, "paragraph" if tag != "note" else "note", section, paragraph_id=paragraph_id)
        elif tag == "formula":
            add(node, "formula", section)
        elif tag == "figure":
            caption = node.find("t:figDesc", NS)
            kind = "table" if node.get("type") == "table" else "figure"
            if caption is not None and text_of(caption):
                add(caption, kind, section, node.get("coords"))
            else:
                add(node, kind, section)
        elif tag == "listBibl":
            for reference in node.findall("t:biblStruct", NS):
                add(reference, "reference", "参考文献")
        else:
            for child in node:
                if isinstance(child.tag, str):
                    visit(child, section)

    titles = root.findall("t:teiHeader/t:fileDesc/t:titleStmt/t:title", NS)
    title = next((node for node in titles if node.get("type") == "main"), titles[0] if titles else None)
    if title is not None:
        add(title, "title")
    abstract = root.find("t:teiHeader/t:profileDesc/t:abstract", NS)
    if abstract is not None:
        visit(abstract, "摘要")
    body = root.find("t:text/t:body", NS)
    if body is not None:
        visit(body)
    back = root.find("t:text/t:back", NS)
    if back is not None:
        visit(back)
    if not segments:
        raise ValueError("未能识别论文正文；扫描件需要 OCR 解析器")
    authors = [text_of(author) for author in root.findall(
        "t:teiHeader/t:fileDesc/t:sourceDesc/t:biblStruct/t:analytic/t:author/t:persName", NS)]
    segments = separate_illustrations(segments, pdf)
    return {"schema_version": SCHEMA_VERSION, "parser": "grobid",
            "title": text_of(title) if title is not None else "",
            "authors": authors, "pages": pages, "segments": segments, "outline": outline,
            "unlocated_count": sum(not s["boxes"] for s in segments),
            "formula_mode": "original-pdf"}


def document_response(row, db, cached=True):
    result = json.loads(row["parsed"])
    if result.get("schema_version", 0) < SCHEMA_VERSION:
        result = parse_tei(row["tei"], row["pdf"])
        db.execute("UPDATE documents SET parsed = ? WHERE id = ?",
                   (json.dumps(result, ensure_ascii=False), row["id"]))
    result.update(id=row["id"], filename=row["filename"], cached=cached)
    valid_ids = {s["id"] for s in result["segments"]}
    result["translations"] = {r["segment_id"]: r["text"] for r in db.execute(
        "SELECT segment_id, text FROM translations WHERE document_id = ?", (row["id"],))
        if r["segment_id"] in valid_ids}
    return result


def get_document(db, document_id):
    row = db.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "论文不存在，请重新打开 PDF")
    return row


@app.get("/api/health")
async def health():
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=4) as client:
            response = await client.get(f"{GROBID_URL}/api/isalive")
            alive = response.is_success and response.text.strip().lower() == "true"
    except httpx.HTTPError:
        alive = False
    return {"status": "ok", "grobid": alive}


@app.get("/api/documents")
def list_documents():
    with database() as db:
        rows = db.execute("SELECT id, filename, created_at FROM documents ORDER BY created_at DESC LIMIT 30")
        return [dict(row) for row in rows]


@app.post("/api/documents")
async def import_document(file: UploadFile = File(...)):
    try:
        data = await file.read(MAX_PDF_BYTES + 1)
    finally:
        await file.close()
    if len(data) > MAX_PDF_BYTES:
        raise HTTPException(413, "PDF 不能超过 30 MB")
    if not data.lstrip().startswith(b"%PDF-"):
        raise HTTPException(400, "请选择有效的 PDF 文件")
    document_id = hashlib.sha256(data).hexdigest()
    with database() as db:
        row = db.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        if row:
            return document_response(row, db)
    fields = [("segmentSentences", (None, "1")), ("generateIDs", (None, "1")),
              ("consolidateHeader", (None, "0")), ("consolidateCitations", (None, "0")),
              ("includeRawCitations", (None, "1"))]
    fields += [("teiCoordinates", (None, tag)) for tag in (
        "s", "p", "head", "title", "figure", "formula", "biblStruct", "note")]
    fields.append(("input", ("paper.pdf", data, "application/pdf")))
    try:
        async with httpx.AsyncClient(trust_env=False, timeout=httpx.Timeout(240, connect=5)) as client:
            response = await client.post(f"{GROBID_URL}/api/processFulltextDocument", files=fields)
        if response.status_code == 503:
            raise HTTPException(503, "论文解析器正忙，请稍后重试")
        response.raise_for_status()
        parsed = parse_tei(response.content, data)
    except httpx.ConnectError:
        raise HTTPException(503, "尚未连接论文解析器，请先启动 GROBID 后点击重试解析") from None
    except httpx.TimeoutException:
        raise HTTPException(504, "论文解析超时，请稍后重试，或拆分过长的 PDF") from None
    except httpx.HTTPError:
        raise HTTPException(502, "GROBID 解析失败；请确认 PDF 未加密且包含可提取的文字") from None
    except (etree.XMLSyntaxError, ValueError, TypeError):
        raise HTTPException(422, "未得到可定位的论文结构；扫描件或复杂版面需要 OCR 解析器") from None
    filename = Path(file.filename or "paper.pdf").name
    with database() as db:
        db.execute("INSERT OR IGNORE INTO documents (id, filename, pdf, tei, parsed) VALUES (?, ?, ?, ?, ?)",
                   (document_id, filename, data, response.content, json.dumps(parsed, ensure_ascii=False)))
        return document_response(get_document(db, document_id), db, cached=False)


@app.get("/api/documents/{document_id}")
def read_document(document_id: str):
    with database() as db:
        return document_response(get_document(db, document_id), db)


@app.get("/api/documents/{document_id}/pdf")
def read_pdf(document_id: str):
    with database() as db:
        data = get_document(db, document_id)["pdf"]
    return Response(data, media_type="application/pdf")


@app.get("/api/documents/{document_id}/tei")
def read_tei(document_id: str):
    with database() as db:
        data = get_document(db, document_id)["tei"]
    return Response(data, media_type="application/xml",
                    headers={"Content-Disposition": 'attachment; filename="paper.tei.xml"'})


class TranslationUpdate(BaseModel):
    translations: dict[str, str] = Field(max_length=2000)


@app.put("/api/documents/{document_id}/translations")
def save_translations(document_id: str, update: TranslationUpdate):
    with database() as db:
        row = get_document(db, document_id)
        valid_ids = {s["id"] for s in json.loads(row["parsed"])["segments"]}
        if any(key not in valid_ids or len(value) > 30000 for key, value in update.translations.items()):
            raise HTTPException(422, "译文包含无效的句子 ID 或内容过长")
        db.executemany("INSERT INTO translations (document_id, segment_id, text) VALUES (?, ?, ?) "
                       "ON CONFLICT(document_id, segment_id) DO UPDATE SET text=excluded.text",
                       [(document_id, key, value.strip()) for key, value in update.translations.items()])
    return {"saved": len(update.translations)}


class MachineTranslationRequest(BaseModel):
    provider: str | None = None
    model: str | None = None
    segment_ids: list[str] = Field(min_length=1, max_length=32)
    force: bool = False


@app.get("/api/translation/providers")
def translation_providers():
    return providers()


class ModelSettingsUpdate(BaseModel):
    base_url: str = Field(min_length=1, max_length=2000)
    model: str = Field(min_length=1, max_length=200)
    models: list[str] = Field(default_factory=list, max_length=100)
    api_key: str | None = Field(default=None, max_length=4000)


@app.get("/api/translation/settings")
def model_settings():
    settings = read_model_settings()
    return {key: value for key, value in settings.items() if key != "api_key"} | {
        "has_api_key": bool(settings["api_key"])}


@app.put("/api/translation/settings")
def update_model_settings(update: ModelSettingsUpdate):
    base_url = update.base_url.strip().rstrip("/")
    try:
        url = urlsplit(base_url)
        valid_url = (url.scheme in ("http", "https") and url.hostname and not url.username
                     and not url.password and not url.query and not url.fragment)
    except ValueError:
        valid_url = False
    if not valid_url:
        raise HTTPException(422, "请填写有效的 HTTP 或 HTTPS 服务地址")
    model = update.model.strip()
    if not model or any(not value.strip() or len(value) > 200 for value in update.models):
        raise HTTPException(422, "请填写有效的模型名称")
    previous = read_model_settings()
    try:
        save_model_settings({"base_url": base_url, "model": model,
                             "models": list(dict.fromkeys(value.strip() for value in update.models)),
                             "api_key": previous["api_key"] if update.api_key is None else update.api_key.strip()})
    except PermissionError:
        raise HTTPException(503, "无法保存配置：数据目录不可写，请检查阅读器运行用户的目录权限") from None
    except OSError:
        raise HTTPException(503, "无法保存配置：数据目录写入失败，请检查磁盘空间及挂载状态") from None
    return model_settings()


@app.get("/api/translation/models")
def translation_models():
    config = academic_model_config()
    return {"models": configured_models() if config else [],
            "default_model": config["model"] if config else None}


@app.post("/api/documents/{document_id}/translate")
async def machine_translate(document_id: str, request: MachineTranslationRequest):
    with database() as db:
        document = document_response(get_document(db, document_id), db)
    segments = {s["id"]: s for s in document["segments"]}
    ids = list(dict.fromkeys(request.segment_ids))
    if any(segment_id not in segments for segment_id in ids):
        raise HTTPException(422, "翻译请求包含无效的句子 ID")
    provider = request.provider or default_provider()
    supported = {item["id"] for item in providers()}
    if provider not in supported:
        raise HTTPException(422, "不支持该翻译服务")
    try:
        config = academic_model_config(request.model)
    except TranslationError as error:
        raise HTTPException(422, str(error)) from None
    if not config:
        raise HTTPException(503, "尚未配置 LLM 翻译模型")
    model = config["model"]
    results = {}
    cache_provider = cache_namespace(provider, model)
    skipped = []
    errors = {}
    async with translation_slots:
        pending = []
        for segment_id in ids:
            segment = segments[segment_id]
            if not request.force and document["translations"].get(segment_id, "").strip():
                results[segment_id] = document["translations"][segment_id]
                continue
            if segment["kind"] in ("formula", "reference"):
                skipped.append(segment_id)
                continue
            source = segment["source"]
            if len(source) > 10000:
                errors[segment_id] = "原文片段过长，请手动拆分或编辑译文"
                continue
            source_hash = hashlib.sha256(("en|zh|" + source).encode()).hexdigest()
            cached = None
            if not request.force:
                with database() as db:
                    cached = db.execute("SELECT text FROM translation_cache WHERE provider=? AND source_hash=?",
                                        (cache_provider, source_hash)).fetchone()
            if cached:
                results[segment_id] = cached["text"]
                pending.append((segment_id, source_hash, cached["text"]))
            else:
                pending.append((segment_id, source_hash, None))
        uncached = [item for item in pending if item[2] is None]
        if uncached:
            values = {}
            try:
                values = await translate_segments(provider, [
                    {"id": segment_id, "source": segments[segment_id]["source"]}
                    for segment_id, _, _ in uncached
                ], model=model)
            except TranslationError as error:
                for segment_id, _, _ in uncached:
                    errors[segment_id] = str(error)
            for segment_id, source_hash, _ in uncached:
                value = values.get(segment_id, "")
                if not isinstance(value, str) or not value.strip():
                    continue
                with database() as db:
                    db.execute("INSERT OR REPLACE INTO translation_cache VALUES (?, ?, ?)",
                               (cache_provider, source_hash, value.strip()))
                pending = [(item_id, item_hash, value.strip() if item_id == segment_id else old_value)
                           for item_id, item_hash, old_value in pending]
        for segment_id, _, value in pending:
            if not value:
                continue
            with database() as db:
                # Regeneration replaces only the value seen at request start.
                # An edit saved while the provider was running still wins.
                db.execute("INSERT INTO translations VALUES (?, ?, ?) ON CONFLICT(document_id, segment_id) "
                           "DO UPDATE SET text=excluded.text WHERE translations.text='' "
                           "OR (? AND translations.text=?)",
                           (document_id, segment_id, value.strip(), request.force,
                            document["translations"].get(segment_id, "")))
                saved = db.execute("SELECT text FROM translations WHERE document_id=? AND segment_id=?",
                                   (document_id, segment_id)).fetchone()
                results[segment_id] = saved["text"]
    return {"translations": results, "skipped": skipped, "errors": errors, "provider": provider, "model": model}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/{asset_path:path}")
def asset(asset_path: str):
    # Only files under web/ are public: never expose the database, PDFs or source files.
    target = (WEB_DIR / asset_path).resolve()
    if not target.is_relative_to(WEB_DIR.resolve()) or not target.is_file():
        raise HTTPException(404)
    return FileResponse(target)
