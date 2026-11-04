// Reader layout preferences are optional when browser storage is unavailable.
const readPreference = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const savePreference = (key, value) => { try { localStorage.setItem(key, value); } catch { /* Optional. */ } };

export function setupReaderLayout({ onPage, onSection }) {
  const $ = (selector) => document.querySelector(selector);
  const split = $('.split-reader');
  const divider = $('#pane-divider');
  const sidebar = $('#document-navigation');
  const toggle = $('#toggle-navigation');
  const pages = $('#pages-panel');
  const outline = $('#outline-panel');
  const tabs = [$('#pages-tab'), $('#outline-tab')];
  const defaultRatio = 1.6 / 2.6;
  const savedRatio = Number(readPreference('paperduo-split'));
  let ratio = savedRatio >= .25 && savedRatio <= .75 ? savedRatio : defaultRatio;
  let drag = null;
  let pdf = null;
  let currentPage = 1;
  let sections = [];
  let thumbnailTask = null;
  let renderingThumbnail = false;
  const visibleThumbnails = new Set();

  function setRatio(value, persist = false) {
    ratio = Math.max(.25, Math.min(.75, value));
    split.style.gridTemplateColumns = `minmax(0, ${ratio}fr) 9px minmax(0, ${1 - ratio}fr)`;
    divider.setAttribute('aria-valuenow', Math.round(ratio * 100));
    divider.setAttribute('aria-valuetext', `原文 ${Math.round(ratio * 100)}%，译文 ${Math.round((1 - ratio) * 100)}%`);
    if (persist) savePreference('paperduo-split', ratio);
  }
  setRatio(ratio);
  divider.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    divider.focus();
    drag = { id: event.pointerId, offset: event.clientX - divider.getBoundingClientRect().left };
    divider.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
  });
  divider.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const bounds = split.getBoundingClientRect();
    setRatio((event.clientX - bounds.left - drag.offset) / (bounds.width - divider.offsetWidth));
  });
  const stopDrag = () => {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    document.body.classList.remove('is-resizing');
    if (divider.hasPointerCapture(id)) divider.releasePointerCapture(id);
    savePreference('paperduo-split', ratio);
  };
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) divider.addEventListener(event, stopDrag);
  window.addEventListener('blur', stopDrag);
  divider.addEventListener('dblclick', () => setRatio(defaultRatio, true));
  divider.addEventListener('keydown', (event) => {
    const values = { ArrowLeft: ratio - .02, ArrowRight: ratio + .02, Home: .25, End: .75, Enter: defaultRatio };
    if (!(event.key in values)) return;
    event.preventDefault();
    event.stopPropagation();
    setRatio(values[event.key], true);
  });

  function revealCurrent() {
    if (sidebar.hidden) return;
    const panel = pages.hidden ? outline : pages;
    const active = panel.querySelector('[aria-current]');
    if (!active) return;
    const bounds = active.getBoundingClientRect();
    const parent = panel.getBoundingClientRect();
    if (bounds.top < parent.top || bounds.bottom > parent.bottom) {
      panel.scrollTop += bounds.top - parent.top - (panel.clientHeight - bounds.height) / 2;
    }
  }
  function setOpen(open, persist = true) {
    sidebar.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? '收起页面 / 大纲' : '展开页面 / 大纲';
    toggle.setAttribute('aria-label', toggle.title);
    if (persist) savePreference('paperduo-navigation', open);
    if (open) requestAnimationFrame(revealCurrent);
  }
  toggle.addEventListener('click', () => setOpen(sidebar.hidden));
  $('#close-navigation').addEventListener('click', () => { setOpen(false); toggle.focus(); });
  sidebar.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { setOpen(false); toggle.focus(); }
    // Navigation keys inside the sidebar must not also flip the main PDF.
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) event.stopPropagation();
  });
  function selectTab(index, persist = true) {
    tabs.forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
    pages.hidden = index !== 0;
    outline.hidden = index !== 1;
    if (persist) savePreference('paperduo-navigation-tab', index);
    requestAnimationFrame(revealCurrent);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(index));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;
      selectTab(next);
      tabs[next].focus();
    });
  });
  selectTab(readPreference('paperduo-navigation-tab') === '1' ? 1 : 0, false);
  setOpen(readPreference('paperduo-navigation') === 'true', false);

  // Render only visible thumbnails, one at a time, independently of the main canvas.
  async function renderThumbnails() {
    if (renderingThumbnail) return;
    renderingThumbnail = true;
    try {
      for (const button of visibleThumbnails) {
        visibleThumbnails.delete(button);
        if (sidebar.hidden || pages.hidden || !button.isConnected || button.dataset.rendered) continue;
        const documentPdf = pdf;
        try {
          const page = await documentPdf.getPage(Number(button.dataset.page));
          if (pdf !== documentPdf || !button.isConnected) continue;
          const preview = button.querySelector('.thumbnail-preview');
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: 132 / base.width * Math.min(window.devicePixelRatio || 1, 2) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          preview.style.aspectRatio = `${base.width} / ${base.height}`;
          thumbnailTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport });
          await thumbnailTask.promise;
          if (pdf !== documentPdf || !button.isConnected) continue;
          preview.replaceChildren(canvas);
          button.dataset.rendered = 'true';
          observer.unobserve(button);
        } catch (error) {
          if (error.name !== 'RenderingCancelledException' && button.isConnected) {
            button.querySelector('.thumbnail-preview').textContent = '预览不可用';
          }
        } finally { thumbnailTask = null; }
      }
    } finally { renderingThumbnail = false; }
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visibleThumbnails.add(entry.target);
      else visibleThumbnails.delete(entry.target);
    }
    void renderThumbnails();
  }, { root: pages, rootMargin: '100px' });

  function updateCurrent(pageNumber, sectionId = null) {
    const changedPage = currentPage !== pageNumber;
    currentPage = pageNumber;
    const activeSection = sections.find((section) => section.id === sectionId)
      || sections.filter((section) => section.page <= pageNumber).at(-1);
    for (const button of pages.querySelectorAll('[data-page]')) {
      if (Number(button.dataset.page) === pageNumber) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    for (const button of outline.querySelectorAll('[data-section]')) {
      if (button.dataset.section === activeSection?.id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
    if (changedPage || sectionId) revealCurrent();
  }
  function setOutline(items, message = '本文暂无可用大纲，可通过页面导航。') {
    sections = items;
    outline.replaceChildren();
    if (!items.length) {
      const note = document.createElement('p');
      note.className = 'navigation-empty';
      note.textContent = message;
      outline.append(note);
    }
    for (const section of items) {
      const button = document.createElement('button');
      button.className = 'outline-entry';
      button.dataset.section = section.id;
      const title = document.createElement('span');
      title.textContent = section.title;
      const page = document.createElement('small');
      page.textContent = section.page;
      button.append(title, page);
      button.addEventListener('click', () => onSection(section.id));
      outline.append(button);
    }
    updateCurrent(currentPage);
  }
  function setPdf(documentPdf) {
    observer.disconnect();
    visibleThumbnails.clear();
    thumbnailTask?.cancel();
    pdf = documentPdf;
    pages.replaceChildren();
    if (!pdf) {
      const note = document.createElement('p');
      note.className = 'navigation-empty';
      note.textContent = '打开 PDF 后显示页面缩略图。';
      pages.append(note);
      setOutline([], '打开并解析 PDF 后显示大纲。');
      return;
    }
    for (let number = 1; number <= pdf.numPages; number++) {
      const button = document.createElement('button');
      button.className = 'page-thumbnail';
      button.dataset.page = number;
      button.setAttribute('aria-label', `跳转到第 ${number} 页`);
      const preview = document.createElement('span');
      preview.className = 'thumbnail-preview';
      preview.textContent = number;
      preview.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = `第 ${number} 页`;
      button.append(preview, label);
      button.addEventListener('click', () => onPage(number));
      pages.append(button);
      observer.observe(button);
    }
    updateCurrent(currentPage);
  }
  return { setPdf, setOutline, updateCurrent };
}
