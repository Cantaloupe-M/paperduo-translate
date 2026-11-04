import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1580, height: 1000 } });
const url = process.env.READER_URL || 'http://127.0.0.1:4174';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.route('**/api/translation/models', (route) => route.fulfill({ json: {
    models: ['model-a', 'model-b'], default_model: 'model-a',
  } }));
  await page.goto(url);
  const documents = await (await page.request.get(url + '/api/documents')).json();
  assert.ok(documents.length);
  // Start with an untranslated view regardless of the user's saved progress.
  // Only the browser response changes; saved translations remain intact.
  await page.route('**/api/documents/' + documents[0].id, async (route) => {
    const response = await route.fetch();
    const document = await response.json();
    await route.fulfill({ response, json: { ...document, translations: {} } });
  });
  await page.locator('#recent-documents').selectOption(documents[0].id);
  await page.locator('.translation-card.kind-sentence').first().waitFor();
  assert.ok(await page.locator('.translation-paragraph .translation-card + .translation-card').count() > 0,
    'sentences share paragraphs instead of separate cards');
  // Deterministic UI test: no cloud quota consumed and no artificial results persisted.
  assert.equal(await page.locator('#translation-model').inputValue(), 'model-a');
  assert.deepEqual(await page.locator('#translation-model option').allTextContents(), ['model-a', 'model-b']);
  await page.locator('#translation-model').selectOption('model-b');
  let requests = 0;
  await page.route('**/api/documents/*/translate', async (route) => {
    requests++;
    const request = route.request().postDataJSON();
    assert.equal(request.model, 'model-b');
    assert.equal(request.force, false);
    const translations = Object.fromEntries(request.segment_ids.map((id) => [id, '这是按原论文段落连续呈现的中文译文。']));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ translations, errors: {}, skipped: [] }) });
  });
  assert.equal(await page.locator('#translate-page').textContent(), '翻译本页');
  assert.equal(await page.locator('#retranslate-page').count(), 0);
  await page.locator('#translate-page').click();
  await page.waitForFunction(() => !document.querySelector('#translate-page').disabled && document.querySelector('#translation-feedback').hidden);
  assert.ok(requests > 0);
  assert.equal(await page.locator('.translation-card.is-untranslated:not(.kind-formula):not(.kind-reference)').count(), 0);
  const sentence = page.locator('.translation-card.kind-sentence').first();
  await sentence.hover();
  assert.ok(await page.locator('.pdf-sentence.is-active').count() > 0);
  assert.equal(await sentence.evaluate((node) => getComputedStyle(node).display), 'inline');
  assert.equal(await page.locator('#translate-page').textContent(), '重新翻译本页');
  const firstPassRequests = requests;
  const firstPassIds = await page.locator('.translation-card:not(.kind-formula):not(.kind-reference)')
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.translationId));
  await page.unroute('**/api/documents/*/translate');
  const regeneratedIds = [];
  await page.route('**/api/documents/*/translate', async (route) => {
    requests++;
    const request = route.request().postDataJSON();
    assert.equal(request.model, 'model-b');
    assert.equal(request.force, true, 'regeneration must bypass existing translations and cache');
    regeneratedIds.push(...request.segment_ids);
    const translations = Object.fromEntries(request.segment_ids.map((id) => [id, '这是重新生成的中文译文。']));
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ translations, errors: {}, skipped: [] }) });
  });
  await page.locator('#translate-page').click();
  await page.waitForFunction(() => !document.querySelector('#translate-page').disabled && document.querySelector('#translation-feedback').hidden);
  assert.ok(requests > firstPassRequests);
  assert.deepEqual(regeneratedIds, firstPassIds, 'regeneration must include every translatable segment');
  assert.match(await sentence.textContent(), /重新生成/);
  await page.route('**/api/translation/models', (route) => route.fulfill({ json: {
    models: [], default_model: null,
  } }));
  await page.reload();
  await page.locator('#recent-documents').selectOption(documents[0].id);
  await page.locator('.translation-card.kind-sentence').first().waitFor();
  await page.waitForFunction(() => document.querySelector('#translation-model').textContent.includes('尚未配置模型'));
  assert.ok(await page.locator('#translation-model').isDisabled());
  assert.ok(await page.locator('#translate-page').isDisabled());
  let savedSettings = { base_url: '', model: '', models: [], has_api_key: false };
  await page.route('**/api/translation/settings', async (route) => {
    if (route.request().method() === 'PUT') {
      const request = route.request().postDataJSON();
      assert.equal(request.api_key, 'test-key');
      const { api_key, ...publicSettings } = request;
      savedSettings = { ...publicSettings, has_api_key: true };
    }
    await route.fulfill({ json: savedSettings });
  });
  await page.route('**/api/translation/models', (route) => route.fulfill({ json: {
    models: savedSettings.model ? [savedSettings.model, ...savedSettings.models] : [],
    default_model: savedSettings.model || null,
  } }));
  await page.locator('#llm-settings').click();
  await page.locator('#save-llm-settings').waitFor();
  await page.waitForFunction(() => !document.querySelector('#save-llm-settings').disabled);
  await page.locator('#llm-base-url').fill('http://models.test/v1');
  await page.locator('#llm-api-key').fill('test-key');
  await page.locator('#llm-default-model').fill('configured-model');
  await page.locator('#llm-models').fill('second-model, third-model');
  await page.locator('#save-llm-settings').click();
  await page.locator('#llm-settings-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#translation-model').inputValue(), 'configured-model');
  assert.deepEqual(await page.locator('#translation-model option').allTextContents(),
    ['configured-model', 'second-model', 'third-model']);
  assert.ok(await page.locator('#translate-page').isEnabled());
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#translation-model').value === 'configured-model');
  await page.locator('#llm-settings').click();
  await page.waitForFunction(() => !document.querySelector('#save-llm-settings').disabled);
  assert.equal(await page.locator('#llm-base-url').inputValue(), 'http://models.test/v1');
  assert.equal(await page.locator('#llm-api-key').inputValue(), '');
  assert.match(await page.locator('#llm-api-key').getAttribute('placeholder'), /已保存/);
  await page.locator('#cancel-llm-settings').click();
  assert.deepEqual(errors, []);
  console.log('model settings save and reload, model selection, missing-model controls, page translation and regeneration: passed');
} finally { await browser.close(); }
