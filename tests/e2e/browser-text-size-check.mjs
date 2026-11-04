import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  const url = process.env.READER_URL || 'http://127.0.0.1:4174';
  await page.goto(url);
  const size = () => page.locator('#translation-list').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  assert.equal(await size(), 16);
  await page.locator('#text-larger').click();
  await page.locator('#text-larger').click();
  assert.equal(await size(), 18);
  await page.reload();
  assert.equal(await size(), 18, 'font size survives a reload');
  await page.locator('#text-smaller').click();
  assert.equal(await size(), 17);
  await page.locator('#text-size-value').click();
  assert.equal(await size(), 16);
  assert.deepEqual(errors, []);
  console.log('text size ok');
} finally { await browser.close(); }
