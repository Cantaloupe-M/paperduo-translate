// Run against a real local GROBID + reader, using a public CS paper.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1580, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(process.env.READER_URL || 'http://127.0.0.1:4174');
  // A missing parser must leave the original readable and allow an explicit retry.
  await page.route('**/api/documents', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ detail: '测试：解析器暂不可用' }) })
    : route.continue());
  await page.locator('#empty-file-input').setInputFiles(process.env.TEST_PDF || '/tmp/tracemonkey.pdf');
  await page.locator('#retry-parse').waitFor({ state: 'visible' });
  assert.ok((await page.locator('#translation-status').textContent()).includes('解析器暂不可用'));
  assert.equal(await page.locator('.translation-card').count(), 0);
  assert.ok(await page.locator('#pdf-canvas').evaluate((canvas) => canvas.width > 0));
  await page.unroute('**/api/documents');
  await page.locator('#retry-parse').click();
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '1', { timeout: 240000 });
  await page.locator('.translation-card.kind-sentence').first().waitFor();
  const card = page.locator('.translation-card.kind-sentence').first();
  const id = await card.getAttribute('data-translation-id');
  const source = page.locator(`[data-sentence-id="${id}"]`);
  assert.ok(await source.count() >= 2, 'real wrapped sentence should have multiple boxes');
  await card.hover();
  await page.waitForFunction((sentenceId) => {
    const boxes = [...document.querySelectorAll(`[data-sentence-id="${sentenceId}"]`)];
    return boxes.length > 1 && boxes.every((b) => b.classList.contains('is-active'));
  }, id);
  await source.first().hover();
  assert.ok((await card.getAttribute('class')).includes('is-active'), 'source hover highlights translation');
  const boxWidth = await source.first().evaluate((node) => node.getBoundingClientRect().width);
  await page.locator('#edit-translations').click();
  const input = page.locator(`textarea[data-segment-id="${id}"]`);
  const oldTranslation = await input.inputValue();
  const translation = '测试译文：JavaScript 等动态语言比静态类型语言更难编译。\n此行验证换行保存。';
  await input.fill(translation);
  await page.locator('#save-translations').click();
  await page.locator('#translation-dialog').waitFor({ state: 'hidden' });
  assert.ok((await card.textContent()).includes(translation));
  await page.locator('#zoom-in').click();
  await page.waitForFunction((sentenceId) => {
    const el = document.querySelector(`[data-sentence-id="${sentenceId}"]`);
    return el && parseFloat(el.style.width) > 290;
  }, id);
  assert.ok(await source.first().evaluate((node) => node.getBoundingClientRect().width) > boxWidth);
  assert.ok((await card.textContent()).includes(translation));
  await page.locator('#next-page').click();
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '2');
  await page.locator('#previous-page').click();
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '1');
  assert.ok((await card.textContent()).includes(translation));
  // Stress cancellation with overlapping render requests, then verify the final page.
  await page.locator('#next-page').evaluate((node) => { for (let i = 0; i < 3; i++) node.click(); });
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '4');
  const option = await page.locator('#outline-select option').nth(2).getAttribute('value');
  await page.locator('#outline-select').selectOption(option);
  await page.waitForFunction((heading) => document.querySelector(`[data-translation-id="${heading}"]`)?.classList.contains('is-active'), option);
  await page.reload();
  await page.locator(`[data-translation-id="${id}"]`).waitFor();
  assert.ok((await card.textContent()).includes(translation), 'refresh restores saved translation');
  // Capture a readable bilingual example, then restore any existing user translation.
  await page.locator('#edit-translations').click();
  await input.fill('JavaScript 等动态语言比静态类型语言更难编译。');
  await page.locator('#save-translations').click();
  await page.locator('#translation-dialog').waitFor({ state: 'hidden' });
  await card.hover();
  await page.screenshot({ path: '/tmp/paperduo-reader.png' });
  await page.locator('#edit-translations').click();
  await input.fill(oldTranslation);
  await page.locator('#save-translations').click();
  await page.locator('#translation-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, [], 'no unhandled browser errors');
  const report = { passed: true, checks: ['parser-failure-and-retry', 'real-pdf-upload', 'multiline-hover-both-directions',
    'translation-newlines', 'zoom-preserves-alignment', 'page-navigation-preserves-translation',
    'concurrent-render-cancellation', 'outline-navigation', 'refresh-restores-translation'], errors };
  await writeFile('/tmp/paperduo-browser-result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await browser.close(); }
