import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { rectangleForViewport, segmentsOnPage } from './alignment.mjs';
import { setupReaderLayout } from './reader-layout.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
const state = {
  pdf: null, document: null, page: 1, scale: 1.2, sentences: [], translations: {},
  generation: 0, renderVersion: 0, renderTask: null, controller: null,
  sourceNodes: new Map(), cards: new Map(), active: null, pendingFile: null,
  translating: false, translationRun: 0, models: [], model: null,
};
const $ = (selector) => document.querySelector(selector);
const el = {
  file: $('#file-input'), emptyFile: $('#empty-file-input'), empty: $('#empty-state'),
  scroll: $('#pdf-scroll'), canvas: $('#pdf-canvas'), page: $('#pdf-page'),
  textLayer: $('#text-layer'), name: $('#document-name'), pageIndicator: $('#page-indicator'),
  pageNumber: $('#page-number'), pageCount: $('#page-count'),
  zoomIndicator: $('#zoom-indicator'), previous: $('#previous-page'), next: $('#next-page'),
  zoomOut: $('#zoom-out'), zoomIn: $('#zoom-in'), status: $('#translation-status'),
  list: $('#translation-list'), edit: $('#edit-translations'), dialog: $('#translation-dialog'),
  editor: $('#translation-editor'), save: $('#save-translations'), retry: $('#retry-parse'),
  outline: $('#outline-select'), parser: $('#parser-status'), recent: $('#recent-documents'),
  editorError: $('#editor-error'), locate: $('#locate-active'),
  translate: $('#translate-page'), stopTranslation: $('#stop-translation'),
  modelDescription: $('#model-description'), model: $('#translation-model'),
};

const navigation = setupReaderLayout({ onPage: (page) => changePage(page - state.page), onSection: navigateSection });

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try { const body = await response.json(); if (typeof body.detail === 'string') message = body.detail; }
    catch { /* A proxy may return HTML instead of JSON. */ }
    throw new Error(message);
  }
  return response.json();
}

function setStatus(message, error = false) {
  el.status.textContent = message;
  el.status.classList.toggle('is-error', error);
}

function pageHasTranslations() {
  return !!state.document && state.sentences.some((s) =>
    !['formula', 'reference'].includes(s.kind) && state.translations[s.id]?.trim());
}

function updateControls() {
  el.previous.disabled = !state.pdf || state.page <= 1;
  el.next.disabled = !state.pdf || state.page >= state.pdf.numPages;
  el.zoomOut.disabled = !state.pdf || state.scale <= .6;
  el.zoomIn.disabled = !state.pdf || state.scale >= 2.4;
  el.zoomIndicator.disabled = !state.pdf;
  el.pageNumber.disabled = !state.pdf;
  el.pageNumber.value = state.pdf ? String(state.page) : '—';
  el.pageCount.textContent = state.pdf ? `/ ${state.pdf.numPages}` : '/ —';
  el.edit.disabled = !state.document || !state.sentences.length;
  el.outline.disabled = !state.document?.outline.length;
  el.locate.disabled = !state.active;
  el.translate.disabled = !state.document || !state.sentences.length || !state.model || state.translating;
  const translated = pageHasTranslations();
  el.translate.textContent = translated ? '重新翻译本页' : '翻译本页';
  el.translate.title = translated ? '重新生成本页译文，替换已有内容（包括手动编辑）' : '生成本页译文';
  el.model.disabled = !state.models.length || state.translating;
  $('#llm-settings').disabled = state.translating;
  el.stopTranslation.hidden = !state.translating;
  el.stopTranslation.disabled = false;
  el.pageIndicator.textContent = state.pdf ? `${state.page} / ${state.pdf.numPages}` : '- / -';
  el.zoomIndicator.textContent = `${Math.round(state.scale / 1.2 * 100)}%`;
  navigation.updateCurrent(state.page);
}

function centerInPane(container, target) {
  const bounds = target.getBoundingClientRect();
  const parent = container.getBoundingClientRect();
  const moveHorizontally = container !== el.scroll;
  if (bounds.top < parent.top + 20 || bounds.bottom > parent.bottom - 20 ||
      (moveHorizontally && (bounds.left < parent.left || bounds.right > parent.right))) {
    container.scrollTo({
      top: container.scrollTop + bounds.top - parent.top - container.clientHeight / 3,
      left: moveHorizontally ? Math.max(0, container.scrollLeft + bounds.left - parent.left - 24) : container.scrollLeft,
      behavior: 'smooth',
    });
  }
}

function setActive(id, origin) {
  if (state.active) {
    for (const node of state.sourceNodes.get(state.active) || []) node.classList.remove('is-active');
    state.cards.get(state.active)?.classList.remove('is-active');
  }
  state.active = id || null;
  if (id) {
    const nodes = state.sourceNodes.get(id) || [];
    for (const node of nodes) node.classList.add('is-active');
    const card = state.cards.get(id);
    card?.classList.add('is-active');
    if (origin === 'source' && card) {
      const details = card.closest('details');
      if (details) details.open = true;
      centerInPane($('.translation-pane'), card);
    }
    if (origin === 'translation' && nodes[0]) centerInPane(el.scroll, nodes[0]);
  }
  el.locate.disabled = !state.active;
}

function updatePageStatus() {
  if (!state.document) return;
  const count = state.sentences.filter((s) => s.kind === 'sentence').length;
  const translated = state.sentences.filter((s) => state.translations[s.id]?.trim()).length;
  setStatus(`第 ${state.page} 页 · ${count} 句正文 · 已填 ${translated}/${state.sentences.length} 段译文。悬停任一侧可定位原文。`);
}

const kindLabels = { title: '论文标题', heading: '章节', sentence: '', paragraph: '段落',
  formula: '公式 · 请核对原页', figure: '图注', 'figure-content': '图中文字', table: '表格 · 请核对原页',
  reference: '参考文献', note: '注释' };

function renderTranslations() {
  el.list.replaceChildren();
  state.cards.clear();
  if (!state.document) return;
  state.sentences = segmentsOnPage(state.document.segments, state.page);
  const fragment = document.createDocumentFragment();
  let paragraph = null;
  let previousGroup = null;
  let previousSection = null;
  state.sentences.forEach((sentence) => {
    const group = sentence.paragraph_id || sentence.id;
    if (group !== previousGroup) {
      if (sentence.section === '摘要' && previousSection !== '摘要') {
        const heading = document.createElement('h3');
        heading.className = 'reading-section';
        heading.textContent = '摘要';
        fragment.append(heading);
      }
      paragraph = document.createElement(sentence.kind === 'figure-content' ? 'details' : 'p');
      paragraph.className = `translation-paragraph paragraph-${sentence.kind}`;
      paragraph.dataset.paragraphId = group;
      if (sentence.kind === 'figure-content') {
        const summary = document.createElement('summary');
        summary.textContent = '图中文字';
        paragraph.append(summary);
      }
      if (state.sentences.some((s) => (s.paragraph_id || s.id) === group && !state.translations[s.id]?.trim())) {
        paragraph.dataset.pending = 'true';
      }
      fragment.append(paragraph);
      previousGroup = group;
    } else {
      paragraph.append(document.createTextNode(' '));
    }
    previousSection = sentence.section;
    const card = document.createElement('span');
    card.className = `translation-card kind-${sentence.kind}`;
    card.tabIndex = 0;
    card.dataset.translationId = sentence.id;
    if (kindLabels[sentence.kind]) {
      const label = document.createElement('span');
      label.className = 'segment-kind';
      label.textContent = kindLabels[sentence.kind];
      card.append(label);
    }
    const text = document.createElement('span');
    const value = state.translations[sentence.id]?.trim();
    text.textContent = value || sentence.source;
    card.append(text);
    card.classList.toggle('is-untranslated', !value);
    card.title = value ? sentence.source : '待译：当前显示原文';
    card.addEventListener('pointerenter', () => setActive(sentence.id, 'translation'));
    card.addEventListener('focus', () => setActive(sentence.id, 'translation'));
    card.addEventListener('click', () => setActive(sentence.id, 'translation'));
    state.cards.set(sentence.id, card);
    paragraph.append(card);
  });
  if (!state.sentences.length) {
    const note = document.createElement('p');
    note.className = 'translation-status';
    note.textContent = '本页没有带坐标的正文。可查看左侧图表原页，或通过章节菜单继续阅读。';
    fragment.append(note);
  }
  if (state.page === 1) {
    const unlocated = state.document.segments.filter((s) => !s.boxes.length);
    if (unlocated.length) {
      const details = document.createElement('details');
      details.className = 'unlocated';
      const summary = document.createElement('summary');
      summary.textContent = `${unlocated.length} 段内容缺少原页坐标`;
      details.append(summary);
      for (const segment of unlocated) {
        const p = document.createElement('p');
        p.textContent = segment.source;
        details.append(p);
      }
      fragment.append(details);
    }
  }
  el.list.append(fragment);
  updatePageStatus();
  updateControls();
}

function renderTextLayer(viewport) {
  el.textLayer.replaceChildren();
  state.sourceNodes.clear();
  if (!state.document) return;
  const page = state.document.pages.find((p) => p.page === state.page);
  const fragment = document.createDocumentFragment();
  for (const sentence of segmentsOnPage(state.document.segments, state.page)) {
    const nodes = [];
    for (const box of sentence.boxes.filter((b) => b.page === state.page)) {
      const rectangle = rectangleForViewport(box, page, viewport);
      if (!rectangle) continue;
      const target = document.createElement('span');
      target.className = 'pdf-sentence';
      target.dataset.sentenceId = sentence.id;
      Object.assign(target.style, Object.fromEntries(
        Object.entries(rectangle).map(([key, value]) => [key, `${value}px`])));
      target.addEventListener('pointerenter', () => setActive(sentence.id, 'source'));
      target.addEventListener('click', () => setActive(sentence.id, 'source'));
      fragment.append(target);
      nodes.push(target);
    }
    state.sourceNodes.set(sentence.id, nodes);
  }
  el.textLayer.append(fragment);
}

function centerPdf() {
  el.scroll.scrollLeft = Math.max(0, (el.scroll.scrollWidth - el.scroll.clientWidth) / 2);
}

new ResizeObserver(() => { if (state.pdf) centerPdf(); }).observe(el.scroll);

async function renderPage({ resetScroll = true, zoomAnchor = null, updateTranslations = true } = {}) {
  if (!state.pdf) return;
  const version = ++state.renderVersion;
  const pdf = state.pdf;
  const pageNumber = state.page;
  const scale = state.scale;
  const oldTask = state.renderTask;
  oldTask?.cancel();
  try {
    if (oldTask) await oldTask.promise.catch(() => {});
    const page = await pdf.getPage(pageNumber);
    if (version !== state.renderVersion || pdf !== state.pdf) return;
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = el.canvas;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    el.textLayer.style.width = `${viewport.width}px`;
    el.textLayer.style.height = `${viewport.height}px`;
    centerPdf();
    if (zoomAnchor) {
      const bounds = el.canvas.getBoundingClientRect();
      el.scroll.scrollTop += bounds.top + zoomAnchor.y * bounds.height - zoomAnchor.clientY;
    }
    setActive();
    el.textLayer.replaceChildren();
    state.renderTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    await state.renderTask.promise;
    if (version !== state.renderVersion) return;
    state.renderTask = null;
    renderTextLayer(viewport);
    if (updateTranslations) renderTranslations();
    updateControls();
    if (resetScroll) {
      centerPdf();
      el.scroll.scrollTop = 0;
      $('.translation-pane').scrollTo(0, 0);
    }
  } catch (error) {
    if (version === state.renderVersion && error.name !== 'RenderingCancelledException') {
      setStatus(`页面渲染失败：${error.message}`, true);
    }
  }
}

function resetDocument() {
  navigation.setPdf(null);
  state.translationRun++;
  state.translating = false;
  state.controller?.abort();
  state.controller = new AbortController();
  state.renderVersion++;
  state.renderTask?.cancel();
  state.document = null;
  state.sentences = [];
  state.translations = {};
  state.sourceNodes.clear();
  state.cards.clear();
  state.active = null;
  state.page = 1;
  el.list.replaceChildren();
  el.textLayer.replaceChildren();
  el.outline.replaceChildren(new Option('章节导航', ''));
  el.retry.hidden = true;
  el.parser.textContent = '正在解析论文…';
  updateControls();
}

function applyDocument(parsed) {
  state.document = parsed;
  state.translations = { ...parsed.translations };
  navigation.setOutline(parsed.outline);
  for (const section of parsed.outline) el.outline.add(new Option(section.title, section.id));
  el.parser.textContent = `GROBID · ${parsed.segments.filter((s) => s.kind === 'sentence').length} 句`;
  el.name.textContent = parsed.title || parsed.filename;
  el.name.title = parsed.title || parsed.filename;
  sessionStorage.setItem('paperduo-document', parsed.id);
  updateControls();
}

async function parseFile(file, generation) {
  const body = new FormData();
  body.append('file', file);
  setStatus('正在识别章节、正文与句子位置，首次解析可能需要几十秒…');
  try {
    const parsed = await api('/api/documents', { method: 'POST', body, signal: state.controller.signal });
    if (generation !== state.generation) return;
    applyDocument(parsed);
    el.retry.hidden = true;
    await renderPage();
    await loadRecent();
  } catch (error) {
    if (generation !== state.generation || error.name === 'AbortError') return;
    el.parser.textContent = '解析未完成';
    el.retry.hidden = false;
    setStatus(error.message, true);
  }
}

async function openPdf(file) {
  if (!file) return;
  const generation = ++state.generation;
  resetDocument();
  const previousPdf = state.pdf;
  state.pdf = null;
  state.pendingFile = file;
  sessionStorage.removeItem('paperduo-document');
  el.name.textContent = file.name;
  el.name.title = file.name;
  el.empty.hidden = true;
  el.scroll.hidden = false;
  setStatus('正在打开 PDF…');
  try {
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    if (generation !== state.generation) { await pdf.destroy(); return; }
    state.pdf = pdf;
    navigation.setPdf(pdf);
    previousPdf?.destroy();
    await renderPage();
    await parseFile(file, generation);
  } catch (error) {
    if (generation !== state.generation) return;
    el.parser.textContent = '未打开';
    setStatus(`无法打开该 PDF：${error.message}`, true);
    updateControls();
  }
}

async function reopen(documentId) {
  const generation = ++state.generation;
  resetDocument();
  const previousPdf = state.pdf;
  state.pdf = null;
  state.pendingFile = null;
  setStatus('正在读取已缓存的论文与译文…');
  try {
    const parsed = await api(`/api/documents/${documentId}`, { signal: state.controller.signal });
    if (generation !== state.generation) return;
    const pdf = await pdfjsLib.getDocument(`/api/documents/${documentId}/pdf`).promise;
    if (generation !== state.generation) { await pdf.destroy(); return; }
    state.pdf = pdf;
    navigation.setPdf(pdf);
    previousPdf?.destroy();
    applyDocument(parsed);
    el.empty.hidden = true;
    el.scroll.hidden = false;
    await renderPage();
  } catch (error) {
    if (generation === state.generation && error.name !== 'AbortError') {
      el.parser.textContent = '读取失败';
      setStatus(error.message, true);
      sessionStorage.removeItem('paperduo-document');
    }
  }
}

function changePage(delta) {
  const next = state.page + delta;
  if (!state.pdf || next < 1 || next > state.pdf.numPages) return;
  state.page = next;
  updateControls();
  void renderPage();
}

function changeZoom(delta, pointer = null) {
  if (!state.pdf) return;
  const scale = Math.min(2.4, Math.max(.6, Math.round((state.scale + delta) * 100) / 100));
  if (scale === state.scale) return;
  const pane = el.scroll.getBoundingClientRect();
  const canvas = el.canvas.getBoundingClientRect();
  const clientY = pointer?.y ?? pane.top + el.scroll.clientHeight / 2;
  const zoomAnchor = canvas.width && canvas.height ? {
    y: (clientY - canvas.top) / canvas.height, clientY,
  } : null;
  state.scale = scale;
  updateControls();
  void renderPage({ resetScroll: false, zoomAnchor, updateTranslations: false });
}

let wheelZoom = null;
$('.source-pane').addEventListener('wheel', (event) => {
  // Trackpad pinch is exposed as Ctrl+wheel in Chromium and Firefox.
  if (!state.pdf || !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.scroll.clientHeight : 1;
  const delta = event.deltaY * unit;
  if (!wheelZoom) {
    wheelZoom = { delta: 0, pointer: null };
    requestAnimationFrame(() => {
      const zoom = wheelZoom;
      wheelZoom = null;
      changeZoom(state.scale * (Math.exp(-Math.max(-200, Math.min(200, zoom.delta)) * .002) - 1), zoom.pointer);
    });
  }
  wheelZoom.delta += delta;
  wheelZoom.pointer = { x: event.clientX, y: event.clientY };
}, { passive: false });

function openEditor() {
  if (!state.document || !state.sentences.length) return;
  el.editor.replaceChildren();
  el.editorError.textContent = '';
  for (const sentence of state.sentences) {
    const label = document.createElement('label');
    label.className = 'editor-row';
    const source = document.createElement('span');
    source.textContent = sentence.source;
    const input = document.createElement('textarea');
    input.dataset.segmentId = sentence.id;
    input.value = state.translations[sentence.id] || '';
    input.placeholder = '填写该句译文';
    input.rows = 2;
    label.append(source, input);
    el.editor.append(label);
  }
  el.dialog.dataset.documentId = state.document.id;
  el.dialog.showModal();
}

async function saveTranslations(event) {
  event.preventDefault();
  const documentId = el.dialog.dataset.documentId;
  const translations = Object.fromEntries([...el.editor.querySelectorAll('textarea')]
    .map((input) => [input.dataset.segmentId, input.value]));
  el.save.disabled = true;
  el.editorError.textContent = '';
  try {
    await api(`/api/documents/${documentId}/translations`, { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ translations }) });
    if (state.document?.id === documentId) {
      Object.assign(state.translations, translations);
      renderTranslations();
    }
    el.dialog.close();
  } catch (error) { el.editorError.textContent = error.message; }
  finally { el.save.disabled = false; }
}

async function loadRecent() {
  try {
    const documents = await api('/api/documents');
    el.recent.replaceChildren(new Option('最近阅读', ''));
    for (const doc of documents) el.recent.add(new Option(doc.filename, doc.id));
    el.recent.disabled = !documents.length;
  } catch { /* Health check below reports backend connectivity. */ }
}

async function loadModels() {
  try {
    const config = await api('/api/translation/models');
    state.models = config.models;
    state.model = config.default_model || state.models[0] || null;
    el.model.replaceChildren();
    for (const model of state.models) el.model.add(new Option(model, model));
    if (!state.models.length) el.model.add(new Option('尚未配置模型', ''));
    el.model.value = state.model || '';
    el.modelDescription.textContent = state.model
      ? '按段落上下文翻译，保持术语与引文一致。' : '点击「LLM 设置」配置翻译模型。';
  } catch {
    state.models = [];
    state.model = null;
    el.model.replaceChildren(new Option('模型配置未连接', ''));
    el.modelDescription.textContent = '无法读取翻译模型配置。';
  }
  updateControls();
}

async function openModelSettings() {
  const dialog = $('#llm-settings-dialog');
  $('#llm-settings-error').textContent = '';
  $('#llm-api-key').value = '';
  $('#llm-clear-key').checked = false;
  $('#save-llm-settings').disabled = true;
  dialog.showModal();
  try {
    const settings = await api('/api/translation/settings');
    $('#llm-base-url').value = settings.base_url;
    $('#llm-default-model').value = settings.model;
    $('#llm-models').value = settings.models.join('\n');
    $('#llm-api-key').placeholder = settings.has_api_key ? '已保存；留空保留原密钥' : '填写 API Key；本地服务可留空';
    $('#llm-clear-key').disabled = !settings.has_api_key;
    $('#save-llm-settings').disabled = false;
  } catch (error) { $('#llm-settings-error').textContent = error.message; }
}

async function saveModelSettings(event) {
  event.preventDefault();
  const key = $('#llm-api-key').value.trim();
  const settings = {
    base_url: $('#llm-base-url').value.trim(),
    model: $('#llm-default-model').value.trim(),
    models: $('#llm-models').value.split(/[,，\n]/).map((value) => value.trim()).filter(Boolean),
  };
  if ($('#llm-clear-key').checked) settings.api_key = '';
  else if (key) settings.api_key = key;
  $('#save-llm-settings').disabled = true;
  $('#llm-settings-error').textContent = '';
  try {
    await api('/api/translation/settings', { method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
    await loadModels();
    $('#llm-api-key').value = '';
    $('#llm-settings-dialog').close();
    setStatus('LLM 配置已保存，可以选择模型并翻译。');
  } catch (error) { $('#llm-settings-error').textContent = error.message; }
  finally { $('#save-llm-settings').disabled = false; }
}

$('#llm-settings').addEventListener('click', () => void openModelSettings());
$('#llm-settings-form').addEventListener('submit', saveModelSettings);
for (const id of ['#close-llm-settings', '#cancel-llm-settings']) {
  $(id).addEventListener('click', () => $('#llm-settings-dialog').close());
}
$('#llm-settings-dialog').addEventListener('close', () => { $('#llm-api-key').value = ''; });

async function translatePage(force = false) {
  if (!state.document || state.translating) return;
  const documentId = state.document.id;
  const generation = state.generation;
  const run = ++state.translationRun;
  const targetPage = state.page;
  const ids = state.sentences.filter((s) => !['formula', 'reference'].includes(s.kind)
    && (force || !state.translations[s.id]?.trim())).map((s) => s.id);
  const action = force ? '重新翻译' : '翻译';
  if (!state.model) { setStatus('请先配置 LLM 翻译模型。', true); return; }
  if (!ids.length) { setStatus('本页已有译文，公式与参考文献保留原文。'); return; }
  state.translating = true;
  updateControls();
  let completed = 0;
  try {
    for (let index = 0; index < ids.length; index += 24) {
      if (run !== state.translationRun || generation !== state.generation) break;
      setStatus(`正在${action}第 ${targetPage} 页：${completed}/${ids.length}，译文会逐批保存…`);
      const result = await api(`/api/documents/${documentId}/translate`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.model, segment_ids: ids.slice(index, index + 24), force }) });
      if (generation !== state.generation) return;
      Object.assign(state.translations, result.translations);
      completed += Object.keys(result.translations).length;
      renderTranslations();
      if (Object.keys(result.errors).length) throw new Error(Object.values(result.errors)[0]);
    }
    if (generation === state.generation) {
      setStatus(run === state.translationRun
        ? `第 ${targetPage} 页${action}完成，已保存 ${completed} 条译文。`
        : `已停止，已完成的 ${completed} 条译文已保存。`);
    }
  } catch (error) {
    if (generation === state.generation) setStatus(`${error.message}。本次已保存 ${completed} 条译文。`, true);
  } finally {
    if (generation === state.generation) { state.translating = false; updateControls(); }
  }
}

$('#upload-document').addEventListener('click', () => el.file.click());
$('#choose-document').addEventListener('click', () => el.emptyFile.click());
for (const input of [el.file, el.emptyFile]) input.addEventListener('change', (event) => {
  void openPdf(event.target.files[0]);
  event.target.value = '';
});
el.previous.addEventListener('click', () => changePage(-1));
el.next.addEventListener('click', () => changePage(1));
el.pageNumber.addEventListener('focus', () => el.pageNumber.select());
el.pageNumber.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    const value = el.pageNumber.value.trim();
    const page = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(page) && state.pdf) {
      changePage(Math.min(state.pdf.numPages, Math.max(1, page)) - state.page);
    }
    el.pageNumber.value = state.pdf ? String(state.page) : '—';
    el.pageNumber.blur();
  } else if (event.key === 'Escape') {
    el.pageNumber.value = state.pdf ? String(state.page) : '—';
    el.pageNumber.blur();
  }
});
el.pageNumber.addEventListener('blur', () => {
  el.pageNumber.value = state.pdf ? String(state.page) : '—';
});
el.zoomOut.addEventListener('click', () => changeZoom(-.15));
el.zoomIn.addEventListener('click', () => changeZoom(.15));
el.zoomIndicator.addEventListener('click', () => changeZoom(1.2 - state.scale));
el.edit.addEventListener('click', openEditor);
el.save.addEventListener('click', saveTranslations);
el.translate.addEventListener('click', () => void translatePage(pageHasTranslations()));
el.model.addEventListener('change', () => {
  state.model = el.model.value || null;
  updateControls();
});
el.stopTranslation.addEventListener('click', () => { state.translationRun++; el.stopTranslation.disabled = true;
  setStatus('正在结束当前批次，已完成的译文会保留…'); });
el.retry.addEventListener('click', () => {
  if (!state.pendingFile) return;
  el.retry.hidden = true;
  void parseFile(state.pendingFile, state.generation);
});
el.recent.addEventListener('change', () => {
  const documentId = el.recent.value;
  el.recent.value = '';
  if (documentId) void reopen(documentId);
});
async function navigateSection(id) {
  const section = state.document?.outline.find((item) => item.id === id);
  if (!section) return;
  const generation = state.generation;
  state.page = section.page;
  updateControls();
  await renderPage();
  if (generation !== state.generation || state.page !== section.page) return;
  setActive(section.id, 'source');
  const source = state.sourceNodes.get(section.id)?.[0];
  if (source) centerInPane(el.scroll, source);
  el.outline.value = section.id;
  navigation.updateCurrent(state.page, section.id);
}
el.outline.addEventListener('change', () => void navigateSection(el.outline.value));
el.locate.addEventListener('click', () => { if (state.active) setActive(state.active, 'translation'); });
el.textLayer.addEventListener('pointerleave', () => setActive());
el.list.addEventListener('pointerleave', () => setActive());
document.addEventListener('keydown', (event) => {
  if (event.target.closest('textarea, input, select, dialog')) return;
  if ((event.ctrlKey || event.metaKey) && state.pdf && $('.source-pane').matches(':hover')) {
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      changeZoom(event.key === '0' ? 1.2 - state.scale : event.key === '-' ? -.15 : .15);
      return;
    }
  }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowLeft') { event.preventDefault(); changePage(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); changePage(1); }
});

updateControls();
void loadRecent();
void loadModels();
void api('/api/health').then((health) => {
  if (!state.document && !state.pendingFile) {
    el.parser.textContent = health.grobid ? '论文解析器就绪' : '解析器未连接';
    if (!health.grobid) setStatus('论文解析器尚未启动。可先打开 PDF 预览，启动后重试解析。');
  }
}).catch(() => { el.parser.textContent = '请通过后端服务打开'; });
const lastDocument = sessionStorage.getItem('paperduo-document');
if (lastDocument) void reopen(lastDocument);
