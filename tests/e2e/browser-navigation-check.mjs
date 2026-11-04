import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1580, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const url = process.env.READER_URL || 'http://127.0.0.1:4174';
  await page.goto(url);
  await page.locator('#toggle-navigation').click();
  assert.ok((await page.locator('#pages-panel').textContent()).includes('打开 PDF'));
  const papers = await (await page.request.get(url + '/api/documents')).json();
  assert.ok(papers.length);
  await page.locator(`#recent-documents option[value="${papers[0].id}"]`).waitFor({ state: 'attached' });
  await page.locator('#recent-documents').selectOption(papers[0].id);
  await page.locator('.pdf-sentence').first().waitFor();
  await page.locator('.thumbnail-preview canvas').first().waitFor();
  const dimensions = () => page.evaluate(() => ({
    source: document.querySelector('.source-pane').clientWidth,
    translation: document.querySelector('.translation-pane').clientWidth,
    canvas: document.querySelector('#pdf-canvas').width,
    top: document.querySelector('#pdf-scroll').scrollTop,
  }));
  await page.locator('#pdf-scroll').evaluate((node) => { node.scrollTop = 170; });
  const before = await dimensions();
  const divider = page.locator('#pane-divider');
  async function dragBy(delta) {
    const bounds = await divider.boundingBox();
    await page.mouse.move(bounds.x + 4, bounds.y + 200);
    await page.mouse.down();
    await page.mouse.move(bounds.x + 4 + delta, bounds.y + 200, { steps: 12 });
    await page.mouse.up();
  }
  await dragBy(-180);
  const after = await dimensions();
  assert.ok(after.source < before.source - 150);
  assert.ok(after.translation > before.translation + 150);
  assert.equal(after.canvas, before.canvas);
  assert.equal(after.top, before.top);
  await dragBy(100);
  assert.ok((await dimensions()).source > after.source + 80);
  const current = await page.locator('#page-indicator').textContent();
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#page-indicator').textContent(), current);
  const savedWidth = (await dimensions()).source;
  await page.reload();
  await page.locator('.pdf-sentence').first().waitFor();
  assert.equal(await page.locator('#toggle-navigation').getAttribute('aria-expanded'), 'true');
  assert.ok(Math.abs((await dimensions()).source - savedWidth) < 2);
  await page.locator('.page-thumbnail[data-page="2"]').click();
  await page.waitForFunction(() => document.querySelector('#translation-status').textContent.startsWith('第 2 页'));
  assert.equal(await page.locator('.page-thumbnail[data-page="2"]').getAttribute('aria-current'), 'page');
  await page.locator('#outline-tab').click();
  const data = await (await page.request.get(url + '/api/documents/' + papers[0].id)).json();
  const section = data.outline.find((item) => item.page > 2);
  assert.ok(section);
  await page.locator(`.outline-entry[data-section="${section.id}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-translation-id="${id}"]`)?.classList.contains('is-active'), section.id);
  assert.equal(await page.locator(`.outline-entry[data-section="${section.id}"]`).getAttribute('aria-current'), 'location');
  await page.locator('#close-navigation').click();
  assert.ok(await page.locator('#document-navigation').isHidden());
  assert.ok((await dimensions()).source > savedWidth);
  await page.reload();
  await page.locator('.pdf-sentence').first().waitFor();
  assert.ok(await page.locator('#document-navigation').isHidden());
  await page.locator('#toggle-navigation').click();
  assert.equal(await page.locator('#outline-tab').getAttribute('aria-selected'), 'true');
  await page.locator('#pages-tab').click();
  await page.locator('.thumbnail-preview canvas').first().waitFor();
  await divider.focus();
  await page.keyboard.press('Home');
  assert.equal(await divider.getAttribute('aria-valuenow'), '25');
  await page.keyboard.press('End');
  assert.equal(await divider.getAttribute('aria-valuenow'), '75');
  await divider.dblclick();
  assert.equal(await divider.getAttribute('aria-valuenow'), '62');
  if (process.env.NAVIGATION_SCREENSHOT) await page.screenshot({ path: process.env.NAVIGATION_SCREENSHOT });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await divider.isHidden());
  await page.locator('#close-navigation').click();
  assert.ok(await page.locator('#document-navigation').isHidden());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  console.log('Resizable panes, persisted layout, lazy thumbnails, page/outline navigation, collapse and mobile layout: passed');
} finally { await browser.close(); }
