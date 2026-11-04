import { openSavedPaper } from './reader-helpers.mjs';
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
  const papers = await (await page.request.get(url + '/api/documents')).json();
  assert.ok(papers.length);
  await openSavedPaper(page, papers[0].id);
  await page.locator('.pdf-sentence').first().waitFor();
  const metrics = () => page.evaluate(() => {
    const rect = (selector) => {
      const b = document.querySelector(selector).getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    };
    return { canvas: rect('#pdf-canvas'), source: rect('.source-pane'), toolbar: rect('.toolbar'),
      translation: rect('.translation-pane'), font: getComputedStyle(document.querySelector('.translation-list')).fontSize,
      translationScroll: document.querySelector('.translation-pane').scrollTop,
      pageScale: window.visualViewport.scale, innerWidth: window.innerWidth,
      ratio: window.devicePixelRatio, box: rect('.pdf-sentence'),
      scroll: document.querySelector('#pdf-scroll').scrollTop };
  });
  const assertCentered = async () => {
    const { canvas, source } = await metrics();
    assert.ok(Math.abs(canvas.x + canvas.width / 2 - source.x - source.width / 2) < 1.5,
      `PDF must stay horizontally centered: PDF ${canvas.x + canvas.width / 2}, pane ${source.x + source.width / 2}`);
  };
  await assertCentered();
  await page.locator('#pdf-scroll').evaluate((node) => { node.scrollTop = 230; });
  await page.locator('.translation-pane').evaluate((node) => { node.scrollTop = 150; });
  const before = await metrics();
  // Hover in the page margin so the pointer does not trigger sentence locating.
  const pointer = { x: before.canvas.x + 15, y: before.source.y + 250 };
  await page.mouse.move(pointer.x, pointer.y);
  const client = await page.context().newCDPSession(page);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: pointer.x, y: pointer.y,
    deltaX: 0, deltaY: -100, modifiers: 2 });
  await page.waitForFunction((width) => document.querySelector('#pdf-canvas').getBoundingClientRect().width > width + 10,
    before.canvas.width);
  await page.waitForFunction((width) => document.querySelector('.pdf-sentence')?.getBoundingClientRect().width > width,
    before.box.width);
  const after = await metrics();
  await assertCentered();
  for (const key of ['source', 'toolbar', 'translation', 'font', 'translationScroll', 'pageScale', 'innerWidth', 'ratio']) {
    assert.deepEqual(after[key], before[key], `${key} must remain unchanged when zooming the PDF`);
  }
  const initialPoint = (pointer.y - before.canvas.y) / before.canvas.height;
  const finalPoint = (pointer.y - after.canvas.y) / after.canvas.height;
  assert.ok(Math.abs(initialPoint - finalPoint) < .003, 'vertical reading position stays under pointer');
  assert.ok(Math.abs(after.box.width / before.box.width - after.canvas.width / before.canvas.width) < .001,
    'sentence highlights scale with the canvas');
  // Pinch uses the same cancellable Ctrl+wheel event.
  const cancelled = await page.locator('#pdf-scroll').evaluate((node) => !node.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: -5000, clientX: 150, clientY: 300,
  })));
  assert.equal(cancelled, true);
  await page.waitForFunction((width) => document.querySelector('#pdf-canvas').getBoundingClientRect().width > width,
    after.canvas.width);
  await page.keyboard.press('Control+0');
  await page.waitForFunction((width) => Math.abs(document.querySelector('#pdf-canvas').getBoundingClientRect().width - width) < 1,
    before.canvas.width);
  await page.locator('.pdf-sentence').first().waitFor();
  await assertCentered();
  // Ordinary scrolling stays scrolling, and does not change the PDF scale.
  const originalWidth = (await metrics()).canvas.width;
  const originalScroll = (await metrics()).scroll;
  await page.mouse.wheel(0, 180);
  await page.waitForFunction((top) => document.querySelector('#pdf-scroll').scrollTop > top, originalScroll);
  assert.equal((await metrics()).canvas.width, originalWidth);
  const handled = await page.locator('.translation-pane').evaluate((node) => !node.dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100,
  })));
  assert.equal(handled, false, 'PDF zoom handler must stay inside the left pane');
  // Both toolbar and off-center gestures must stay centered when crossing
  // between a PDF narrower than the pane and one wider than the pane.
  const zoomButton = async (selector) => {
    const previous = (await metrics()).canvas.width;
    await page.locator(selector).click();
    await page.waitForFunction((width) => {
      const canvas = document.querySelector('#pdf-canvas');
      return Math.abs(canvas.getBoundingClientRect().width - width) > 1
        && document.querySelector('.pdf-sentence');
    }, previous);
    await assertCentered();
  };
  for (let i = 0; i < 8; i++) await zoomButton('#zoom-in');
  assert.ok((await metrics()).canvas.width > (await metrics()).source.width);
  // Sentence locating must not pull a magnified PDF to one side.
  await page.locator('.translation-card.kind-title').hover();
  await assertCentered();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.waitForFunction(() => {
    const pdf = document.querySelector('#pdf-canvas').getBoundingClientRect();
    const pane = document.querySelector('.source-pane').getBoundingClientRect();
    return Math.abs(pdf.x + pdf.width / 2 - pane.x - pane.width / 2) < 1.5;
  });
  for (let i = 0; i < 12; i++) await zoomButton('#zoom-out');
  assert.ok((await metrics()).canvas.width < (await metrics()).source.width);
  await assertCentered();
  await page.locator('#next-page').click();
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '2');
  await assertCentered();
  assert.deepEqual(errors, []);
  console.log('PDF stays centered across zoom levels, overflow, resize and navigation; local zoom, aligned highlights and ordinary scroll: passed');
} finally {
  await browser.close();
}
