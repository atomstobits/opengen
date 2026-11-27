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
  const quoteText = await page.evaluate(() => navigator.clipboard.readText());
  expect(quoteText).not.toContain('/v1/generations');
  expect(quoteText).toContain('OPENGEN_API_KEY');
  expect(quoteText).not.toContain('OPENGEN_TOKEN');
  await page.getByRole('button', { name: 'Copy paid submit', exact: true }).click();
  const submit = await page.evaluate(() => navigator.clipboard.readText());
  expect(submit).toContain('/v1/generations');
  expect(submit).toContain('Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY');
  expect(submit).toContain('OPENGEN_API_KEY');
  expect(submit).not.toContain('/v1/quotes');
  await page.getByRole('button', { name: 'Copy status', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('/v1/generations/$OPENGEN_JOB_ID/status');
  await page.getByRole('button', { name: 'Copy recover request', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    '--data-urlencode "idempotencyKey=$OPENGEN_IDEMPOTENCY_KEY"',
  );
  await page.getByRole('button', { name: 'Copy page as Markdown', exact: true }).click();
  const markdown = await page.evaluate(() => navigator.clipboard.readText());
  expect(markdown).toContain('# OpenGen API, MCP & Self-Hosting Documentation');
  expect(markdown).toContain('/llms.txt');
  expect(markdown).toContain('/openapi.json');
  expect(markdown).toContain('OPENGEN_API_KEY');
  expect(writes).toEqual([]);
  await expect(
    page.locator('#api-reference').getByRole('link', {
      name: 'Open the OpenAPI 3.1 specification',
    }),
  ).toHaveAttribute('href', '/openapi.json');
  await expect(
    page.locator('#api-reference').getByRole('link', {
      name: 'OpenGen interactive API explorer',
    }),
  ).toHaveAttribute('href', '/docs/api');
  await expect(page.locator('#workspace').getByRole('link', { name: 'workspace' })).toHaveAttribute(
    'href',
    '/app#start',
  );
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

test('interactive OpenAPI explorer filters live spec endpoints and stays inside 390px viewport', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: baseURL!,
  });
  await page.route('**/openapi.json', (route) =>
    route.fulfill({
      json: {
        openapi: '3.1.0',
        info: { title: 'OpenGen API', version: '0.1.1' },
        paths: {
          '/v1/quotes': {
            post: {
              operationId: 'quotes.single',
              summary: 'Quote one canonical request',
              tags: ['quotes'],
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: { modelId: { type: 'string' } },
                    },
                  },
                },
              },
              responses: { 200: { description: 'Quote estimate' } },
            },
          },
          '/v1/generations': {
            post: {
              operationId: 'media.generate',
              summary: 'Submit one generation',
              tags: ['generations'],
              parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
              responses: { 202: { description: 'Job accepted' } },
            },
          },
        },
        components: {
          parameters: {
            IdempotencyKey: {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              description: 'Persist this key before submission.',
              schema: { type: 'string' },
            },
          },
        },
      },
    }),
  );

  await page.goto('/docs/api');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Interactive API reference.' }),
  ).toBeVisible();
  await expect(page.getByTestId('openapi-status')).toContainText('OpenAPI 3.1.0');
  await expect(page.getByTestId('openapi-endpoint')).toHaveCount(2);

  await page.getByLabel('Filter endpoints').fill('generations');
  await expect(page.getByTestId('openapi-endpoint')).toHaveCount(1);
  const card = page.getByTestId('openapi-endpoint').first();
  await card.locator('summary').click();
  await expect(card).toContainText('Idempotency-Key');
  await card.getByRole('button', { name: 'Copy cURL', exact: true }).click();
  const curl = await page.evaluate(() => navigator.clipboard.readText());
  expect(curl).toContain('OPENGEN_API_URL');
  expect(curl).toContain('OPENGEN_API_KEY');
  expect(curl).toContain('Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY');

  await card.getByRole('tab', { name: 'MCP call', exact: true }).click();
  await card.getByRole('button', { name: 'Copy MCP JSON', exact: true }).click();
  const mcp = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(mcp.operationId).toBe('media.generate');

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('agent setup pages avoid 390px overflow, expose first-prompt copy, billing links and per-model agent copy', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: baseURL!,
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/agents');
  await expect(page.locator('main')).not.toContainText(
    'a guide is not a claim that the public service is ready',
  );
  await expect(page.getByRole('link', { name: 'Add workspace credit ↗' }).first()).toHaveAttribute(
    'href',
    '/billing',
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  for (const slug of ['cli', 'codex', 'cursor', 'claude-code', 'pi']) {
    await page.goto(`/agents/${slug}`);
    await expect(page.getByTestId('first-prompt')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Add workspace credit ↗' }).first(),
    ).toHaveAttribute('href', '/billing');
    await expect(page.locator('main')).not.toContainText('/absolute/private/opengen-client');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
      `/agents/${slug} mobile overflow`,
    ).toBeLessThanOrEqual(390);
  }

  await page.goto('/agents/cli');
  await expect(page.locator('main')).toContainText('OPENGEN_API_URL');
  await expect(page.locator('main')).toContainText('opengen quote --input request.json');
  await expect(page.locator('main')).toContainText('opengen generate --input request.json');
  await page.getByRole('button', { name: 'Copy first prompt', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('openai/gpt-image-2');

  await page.goto('/bytedance/seedance-2.5');
  const variantSection = page.locator(
    '[data-testid="series-variant"][data-model-id="bytedance/seedance-2.5"]',
  );
  await variantSection.getByRole('button', { name: 'Copy for your agent', exact: true }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('/llms.txt');
  expect(copied).toContain('bytedance/seedance-2.5');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
