// Run against an isolated reader; restores the original profile on completion.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const url = process.env.READER_URL || 'http://127.0.0.1:4174';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let original;
const openEditor = async () => {
  await page.locator('#edit-profile').click();
  await page.waitForFunction(() => !document.querySelector('#save-profile').disabled);
};
const saveProfile = async () => {
  await page.locator('#save-profile').click();
  await page.locator('#profile-dialog').waitFor({ state: 'hidden' });
};
try {
  const response = await page.request.get(url + '/api/profile');
  assert.ok(response.ok());
  original = await response.json();
  await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok', grobid: false } }));
  await page.goto(url);
  await openEditor();
  await page.locator('#profile-username').fill('  论文读者  ');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#23867e'; ctx.fillRect(0, 0, 96, 64);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  await page.locator('#avatar-input').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.locator('#profile-avatar-preview img').waitFor();
  await saveProfile();
  assert.equal(await page.locator('.home-profile [data-profile-name]').textContent(), '论文读者');
  assert.equal(await page.locator('.space-profile [data-profile-name]').textContent(), '论文读者');
  assert.equal(await page.locator('.profile-avatar img').count(), 4);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.home-profile [data-profile-name]').textContent === '论文读者');
  await page.waitForFunction(() => document.querySelector('.home-profile .profile-avatar img')?.naturalWidth === 256);
  const persisted = await (await page.request.get(url + '/api/profile')).json();
  assert.equal(persisted.username, '论文读者');
  assert.ok(persisted.avatar.startsWith('data:image/png;base64,'));

  await openEditor();
  await page.locator('#profile-username').fill('取消的用户名');
  await page.locator('#remove-avatar').click();
  await page.locator('#cancel-profile').click();
  assert.deepEqual(await (await page.request.get(url + '/api/profile')).json(), persisted);
  await openEditor();
  assert.equal(await page.locator('#profile-username').inputValue(), persisted.username);
  assert.ok(await page.locator('#profile-avatar-preview img').isVisible());
  await page.locator('#profile-username').fill('   ');
  await page.locator('#save-profile').click();
  assert.match(await page.locator('#profile-error').textContent(), /请输入用户名/);
  await page.locator('#profile-username').fill('更新后的名字');
  await page.locator('#avatar-input').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('invalid image') });
  await page.waitForFunction(() => document.querySelector('#profile-error').textContent.includes('无法读取'));
  await page.locator('#avatar-input').setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  assert.match(await page.locator('#profile-error').textContent(), /不能超过 2 MB/);
  assert.ok(await page.locator('#profile-avatar-preview img').isVisible(), 'invalid uploads preserve draft avatar');
  await page.route('**/api/profile', (route) => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { detail: '保存失败，请重试' } }) : route.continue());
  await page.locator('#save-profile').click();
  await page.waitForFunction(() => document.querySelector('#profile-error').textContent.includes('保存失败'));
  assert.equal(await page.locator('#profile-username').inputValue(), '更新后的名字');
  assert.equal(await page.locator('.home-profile [data-profile-name]').textContent(), persisted.username);
  await page.unroute('**/api/profile');
  await page.locator('#remove-avatar').click();
  await saveProfile();
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.home-profile [data-profile-name]').textContent === '更新后的名字');
  assert.equal(await page.locator('.home-profile .profile-avatar').textContent(), '更');
  assert.equal((await (await page.request.get(url + '/api/profile')).json()).avatar, null);

  await page.setViewportSize({ width: 390, height: 844 });
  await openEditor();
  assert.ok(await page.locator('#profile-username').isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.locator('#profile-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth));
  await page.locator('#profile-username').fill('名'.repeat(32));
  await saveProfile();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/paperduo-profile-mobile.png', fullPage: true });

  await page.route('**/api/profile', (route) => route.fulfill({ status: 503, json: { detail: '暂时不可用' } }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#profile-status').textContent.includes('加载失败'));
  await page.locator('#edit-profile').click();
  await page.waitForFunction(() => document.querySelector('#profile-error').textContent.includes('无法加载'));
  assert.ok(await page.locator('#save-profile').isDisabled());
  await page.locator('#cancel-profile').click();
  await page.unroute('**/api/profile');
  await openEditor();
  await page.locator('#cancel-profile').click();
  assert.deepEqual(errors, []);
  console.log('profile: username, avatar upload/crop/removal, persistence, cancellation, validation, save/load failure recovery, mobile passed');
} finally {
  if (original) await page.request.put(url + '/api/profile', { data: original });
  await browser.close();
}
