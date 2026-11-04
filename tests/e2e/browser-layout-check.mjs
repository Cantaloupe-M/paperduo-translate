// Run against a reader containing the paper that exposed merged diagram labels.
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
  const response = await page.request.get(url + '/api/documents');
  const documents = await response.json();
  const document = documents.find((d) => d.filename === (process.env.LAYOUT_PDF || '2604.17308v1.pdf'));
  assert.ok(document, 'the reported paper must already be imported');
  await page.locator(`#recent-documents option[value="${document.id}"]`).waitFor({ state: 'attached' });
  await page.locator('#recent-documents').selectOption(document.id);
  await page.locator('.translation-card.kind-title').waitFor();
  for (let number = 2; number <= 4; number++) {
    await page.locator('#next-page').click();
    await page.waitForFunction((n) => document.querySelector('#page-indicator').textContent.startsWith(`${n} /`), number);
    await page.waitForFunction((n) => {
      const cards = document.querySelectorAll('.translation-card');
      return cards.length && document.querySelector('#page-indicator').textContent.startsWith(`${n} /`)
        && !document.querySelector('#next-page').disabled;
    }, number);
  }
  const parsed = await (await page.request.get(url + '/api/documents/' + document.id)).json();
  const definition = parsed.segments.find((s) => s.source.startsWith('where V is a set of executable'));
  assert.ok(definition);
  assert.equal(definition.boxes.length, 3);
  const card = page.locator(`[data-translation-id="${definition.id}"]`);
  await card.waitFor();
  assert.equal(await card.locator('xpath=ancestor::details').count(), 0);
  const diagram = page.locator('details.paragraph-figure-content');
  assert.equal(await diagram.count(), 2);
  assert.equal(await diagram.locator('[open]').count(), 0);
  assert.equal(await diagram.evaluateAll((nodes) => nodes.some((node) => node.open)), false);
  await card.hover();
  const active = page.locator('.pdf-sentence.is-active');
  assert.equal(await active.count(), 3);
  assert.deepEqual(await active.evaluateAll((nodes) => [...new Set(nodes.map((node) => node.dataset.sentenceId))]), [definition.id]);
  await active.first().hover();
  assert.ok((await card.getAttribute('class')).includes('is-active'));
  await diagram.first().locator('summary').click();
  assert.equal(await diagram.first().evaluate((node) => node.open), true);
  assert.ok(await diagram.first().locator('.translation-card').isVisible());
  await diagram.first().locator('summary').click();
  assert.deepEqual(errors, []);
  if (process.env.LAYOUT_SCREENSHOT) await page.screenshot({ path: process.env.LAYOUT_SCREENSHOT });
  console.log('reported PDF: three body highlights, separate caption, collapsed diagram text, bidirectional hover: passed');
} finally {
  await browser.close();
}
