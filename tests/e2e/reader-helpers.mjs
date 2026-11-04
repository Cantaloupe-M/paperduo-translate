export async function openSavedPaper(page, id) {
  await page.evaluate(() => { location.hash = 'library'; });
  await page.locator(`#library-documents [data-document-id="${id}"] .paper-title`).click();
  await page.waitForFunction(() => !document.querySelector('#page-number').disabled);
  // Reader checks start at page one even when a previous run saved another page.
  await page.locator('#page-number').fill('1');
  await page.locator('#page-number').press('Enter');
  await page.waitForFunction(() => document.querySelector('#translation-list').dataset.page === '1');
}
