import { expect, test } from '@playwright/test';

test('API quickstart copies quote, paid submission and job reads independently', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: baseURL!,
  });
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/v1/'))
      writes.push(request.url());
  });
  await page.goto('/docs#http-examples');
  await expect(page.getByRole('heading', { name: '2. Quote your request.' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy quote', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/\/v1\/quotes/);
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(
    '/v1/generations',
  );
  await page.getByRole('button', { name: 'Copy paid submit', exact: true }).click();
  const submit = await page.evaluate(() => navigator.clipboard.readText());
  expect(submit).toContain('/v1/generations');
  expect(submit).toContain('Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY');
  expect(submit).not.toContain('/v1/quotes');
  await page.getByRole('button', { name: 'Copy status', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('/v1/generations/$OPENGEN_JOB_ID/status');
  await page.getByRole('button', { name: 'Copy recover request', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    '--data-urlencode "idempotencyKey=$OPENGEN_IDEMPOTENCY_KEY"',
  );
  expect(writes).toEqual([]);
  await expect(
    page.locator('#api-reference').getByRole('link', {
      name: 'Open the OpenAPI 3.1 specification',
    }),
  ).toHaveAttribute('href', '/openapi.json');
  await expect(page.locator('#api-reference')).toContainText('GET /v1/generations/{id}/status');
  await expect(page.locator('#self-host')).toBeAttached();
  const specification = await page.request.get('/openapi.json');
  expect(specification.ok()).toBe(true);
  const schema = await specification.json();
  expect(schema.openapi).toBe('3.1.0');
  expect(schema.paths['/v1/images/edits'].post.requestBody.content).toHaveProperty(
    'multipart/form-data',
  );
});

test('docs and the image-to-video guide remain readable on a phone without JavaScript', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await page.goto('/docs');
    await expect(page.locator('#http-examples pre').first()).toContainText('maxCostMicros');
    await expect(page.getByRole('navigation', { name: 'Choose your workflow' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.getByRole('link', { name: 'image-to-video walkthrough', exact: true }).click();
    await expect(page).toHaveURL(/\/guides\/image-to-video$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Image to video');
    await expect(page.locator('main')).toContainText('media.generate');
    await expect(page.locator('main')).toContainText('jobs.lookup');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      /\/guides\/image-to-video$/,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  } finally {
    await context.close();
  }
});
