import { setupProfile } from './profile.mjs';

// Personal space uses the same persisted papers as the bilingual reader.
export function setupPersonalSpace({ api, onOpen, onSettings, onUpload, onReader, beforeRefresh }) {
  setupProfile({ api });
  const $ = (selector) => document.querySelector(selector);
  let documents = [], collections = [], currentRoute = '', loaded = false, loadVersion = 0;
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const route = () => location.hash.slice(1) || 'home';
  const category = () => currentRoute.startsWith('collection/') ? decodeURIComponent(currentRoute.slice(11)) : null;
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function feedback(message = '', error = false) {
    $('#space-feedback').textContent = message;
    $('#space-feedback').hidden = !message;
    $('#space-feedback').classList.toggle('is-error', error);
  }
  const timestamp = (value) => value ? Date.parse(value.includes('T') ? value : value.replace(' ', 'T') + 'Z') : 0;
  function dateLabel(value) {
    if (!value) return '尚未阅读';
    const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function empty(target, title, description, upload = false) {
    const box = node('div', 'library-empty');
    box.append(node('span', 'library-empty-mark', '▤'), node('h3', '', title), node('p', '', description));
    if (upload) {
      const button = node('button', 'primary-button', '导入第一篇论文');
      button.addEventListener('click', onUpload);
      box.append(button);
    }
    target.append(box);
  }
  function openDocument(doc) {
    location.hash = 'reader';
    void onOpen(doc.id);
  }
  function card(doc, featured = false) {
    const article = node('article', featured ? 'paper-card continue-card' : 'paper-card');
    article.dataset.documentId = doc.id;
    const mark = node('div', 'paper-card-mark', 'PDF');
    const content = node('div', 'paper-card-content');
    const open = node('button', 'paper-title', doc.title || doc.filename);
    open.title = doc.title || doc.filename;
    open.addEventListener('click', () => openDocument(doc));
    const heading = node('h3');
    heading.append(open);
    content.append(heading, node('p', 'paper-authors', doc.authors?.join(' · ') || doc.filename));
    const metadata = node('p', 'paper-metadata', `${doc.page_count} 页 · ${doc.last_read_at ? `读至第 ${doc.last_page} 页 · ${dateLabel(doc.last_read_at)}` : '尚未阅读'}`);
    content.append(metadata);
    const actions = node('div', 'paper-card-actions');
    const select = node('select', 'paper-collection');
    select.setAttribute('aria-label', `分类：${doc.title || doc.filename}`);
    select.add(new Option('未分类', ''));
    for (const item of collections) select.add(new Option(item.name, item.id));
    select.value = doc.collection_id || '';
    select.addEventListener('change', async () => {
      const value = select.value || null;
      select.disabled = true;
      try {
        await api(`/api/documents/${doc.id}/collection`, json('PUT', { collection_id: value }));
        doc.collection_id = value;
        feedback('分类已更新');
        render();
      } catch (error) { select.value = doc.collection_id || ''; feedback(error.message, true); }
      finally { select.disabled = false; }
    });
    const read = node('button', featured ? 'primary-button' : 'text-button', doc.last_read_at ? '继续阅读 →' : '开始阅读 →');
    read.addEventListener('click', () => openDocument(doc));
    actions.append(select, read);
    article.append(mark, content, actions);
    return article;
  }
  function renderNavigation() {
    $('#library-count').textContent = documents.length;
    for (const link of document.querySelectorAll('[data-space-route]')) {
      const selected = link.dataset.spaceRoute === currentRoute;
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    const filter = $('#library-category');
    filter.replaceChildren(new Option('全部分类', ''), new Option('未分类', 'unfiled'));
    for (const item of collections) filter.add(new Option(item.name, item.id));
    filter.value = category() || '';
    filter.hidden = currentRoute === 'recent';
    const nav = $('#collection-navigation');
    nav.replaceChildren();
    for (const item of [{ id: 'unfiled', name: '未分类' }, ...collections]) {
      const link = node('a');
      link.href = `#collection/${encodeURIComponent(item.id)}`;
      link.append(node('span', 'collection-label', item.name), node('span', '', documents.filter((doc) => (doc.collection_id || 'unfiled') === item.id).length));
      if (category() === item.id) link.setAttribute('aria-current', 'page');
      nav.append(link);
    }
  }
  function render() {
    renderNavigation();
    $('#stat-documents').textContent = documents.length;
    $('#stat-collections').textContent = collections.length;
    const recent = documents.filter((doc) => doc.last_read_at).sort((a, b) => b.last_read_at.localeCompare(a.last_read_at));
    $('#stat-read').textContent = recent.length;
    const continuing = $('#continue-reading');
    continuing.replaceChildren();
    if (recent.length) continuing.append(card(recent[0], true));
    else empty(continuing, '从一篇论文开始', '阅读过的论文会出现在这里，随时从上次的页码继续。');
    const home = $('#home-documents');
    home.replaceChildren();
    for (const doc of documents.slice(0, 6)) home.append(card(doc));
    if (!documents.length) empty(home, '知识库还是空的', '导入 PDF 后，原文和译文会一起保存在知识库中。', true);
    const selectedCategory = category();
    const knownCategory = collections.find((item) => item.id === selectedCategory);
    const names = { home: ['个人主页', '把读过的论文，变成自己的知识。'], library: ['个人知识库', '所有论文与译文都在这里。可以分类，也可以随心阅读。'], recent: ['最近阅读', '按最近打开的时间排列，接着上次的进度继续。'], settings: ['个人设置', '管理你的翻译模型与服务连接。'] };
    const [title, description] = names[currentRoute] || [selectedCategory === 'unfiled' ? '未分类' : knownCategory?.name || '分类不存在', '按研究方向，积累自己的论文知识库。'];
    $('#space-title').textContent = title;
    $('#space-description').textContent = description;
    const query = $('#library-search').value.trim().toLocaleLowerCase();
    let filtered = currentRoute === 'recent' ? recent : documents;
    if (selectedCategory) filtered = filtered.filter((doc) => (doc.collection_id || 'unfiled') === selectedCategory);
    if (query) filtered = filtered.filter((doc) => [doc.title, doc.filename, ...doc.authors || []].join(' ').toLocaleLowerCase().includes(query));
    filtered = [...filtered];
    const sort = $('#library-sort').value;
    if (sort === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    else if (sort === 'created') filtered.sort((a, b) => timestamp(b.created_at) - timestamp(a.created_at));
    else filtered.sort((a, b) => timestamp(b.last_read_at || b.created_at) - timestamp(a.last_read_at || a.created_at));
    $('#library-results').textContent = `共 ${filtered.length} 篇论文`;
    $('#edit-current-collection').hidden = currentRoute === 'recent';
    const list = $('#library-documents');
    list.replaceChildren();
    for (const doc of filtered) list.append(card(doc));
    if (!filtered.length) empty(list, query ? '没有找到相关论文' : currentRoute === 'recent' ? '还没有阅读记录' : '这里还没有论文', query ? '试试其他标题、作者或文件名。' : currentRoute === 'recent' ? '从知识库打开论文后，会自动记录阅读进度。' : '导入论文，或在知识库中将论文移入这个分类。', !documents.length && !query);
  }
  async function refresh() {
    const version = ++loadVersion;
    if (!loaded) feedback('正在加载知识库…');
    try {
      await beforeRefresh?.();
      const [papers, folders] = await Promise.all([api('/api/documents'), api('/api/collections')]);
      if (version !== loadVersion) return;
      documents = papers; collections = folders; loaded = true;
      feedback(); render();
    } catch (error) { if (version === loadVersion) feedback(`${error.message}。请刷新页面重试。`, true); }
  }
  function navigate() {
    const next = route();
    const valid = ['home', 'library', 'recent', 'settings', 'reader', 'open'].includes(next) || /^collection\/[^/]+$/.test(next);
    currentRoute = valid ? next : 'home';
    const opening = currentRoute === 'open';
    const reader = currentRoute === 'reader' || opening;
    $('#personal-space').hidden = reader;
    $('#reader-workspace').hidden = !reader;
    document.body.classList.toggle('in-personal-space', !reader);
    document.body.classList.toggle('is-opening-document', opening);
    $('#upload-document').setAttribute('aria-pressed', String(opening));
    $('#home-panel').hidden = currentRoute !== 'home';
    $('#library-panel').hidden = !['library', 'recent'].includes(currentRoute) && !category();
    $('#settings-panel').hidden = currentRoute !== 'settings';
    $('#space-upload').hidden = currentRoute === 'settings';
    $('#library-search').value = '';
    $('#library-sort').value = 'recent';
    if (currentRoute !== 'settings') $('#llm-api-key').value = '';
    render();
    if (opening) $('#choose-document').focus({ preventScroll: true });
    else if (reader) onReader();
    else {
      void refresh();
      if (currentRoute === 'settings') void onSettings();
      $('#space-title').focus({ preventScroll: true });
      $('.space-main').scrollTop = 0;
    }
  }
  function renderManager() {
    const list = $('#collection-manager');
    list.replaceChildren();
    for (const item of collections) {
      const form = node('form', 'collection-edit');
      const input = node('input');
      input.value = item.name; input.required = true; input.maxLength = 60;
      input.setAttribute('aria-label', `分类名称：${item.name}`);
      const save = node('button', 'secondary-button', '重命名'); save.type = 'submit';
      const remove = node('button', 'text-button collection-delete', '删除'); remove.type = 'button';
      async function update(method) {
        save.disabled = remove.disabled = true;
        $('#collection-error').textContent = '';
        try {
          await api(`/api/collections/${item.id}`, method === 'DELETE' ? { method } : json(method, { name: input.value }));
          if (method === 'DELETE' && category() === item.id) location.hash = 'collection/unfiled';
          await refresh(); renderManager();
        } catch (error) { $('#collection-error').textContent = error.message; }
        finally { save.disabled = remove.disabled = false; }
      }
      form.addEventListener('submit', (event) => { event.preventDefault(); void update('PUT'); });
      remove.addEventListener('click', () => void update('DELETE'));
      form.append(input, save, remove); list.append(form);
    }
    if (!collections.length) list.append(node('p', 'settings-note', '还没有分类。你可以先创建一个，也可以直接阅读。'));
  }
  function manageCollections() {
    $('#collection-error').textContent = '';
    $('#collection-name').value = '';
    renderManager(); $('#collections-dialog').showModal();
  }
  $('#manage-collections').addEventListener('click', manageCollections);
  $('#edit-current-collection').addEventListener('click', manageCollections);
  $('#close-collections').addEventListener('click', () => $('#collections-dialog').close());
  $('#create-collection-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    $('#collection-error').textContent = '';
    try {
      await api('/api/collections', json('POST', { name: $('#collection-name').value }));
      $('#collection-name').value = ''; await refresh(); renderManager(); $('#collection-name').focus();
    } catch (error) { $('#collection-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#library-category').addEventListener('change', (event) => { location.hash = event.target.value ? `collection/${encodeURIComponent(event.target.value)}` : 'library'; });
  $('#library-search').addEventListener('input', render);
  $('#library-sort').addEventListener('change', render);
  $('#space-upload').addEventListener('click', onUpload);
  window.addEventListener('hashchange', navigate);
  // Defer until the reader has finished creating its controls and callbacks.
  queueMicrotask(navigate);
  return { refresh, showReader: () => { location.hash = 'reader'; }, showSettings: () => { location.hash = 'settings'; } };
}
