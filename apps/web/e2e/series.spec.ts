import { expect, test } from '@playwright/test';
import { catalog } from '@media-router/catalog';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const evidenceDir = path.resolve(import.meta.dirname, '../../..', 'docs/evidence');
const variant = (page: import('@playwright/test').Page, id: string) =>
  page.locator(`[data-testid="series-variant"][data-model-id="${id}"]`);

test('company pages expose every owned variant through its canonical series', async ({ page }) => {
  await page.goto('/bytedance');
  await expect(
    page.getByRole('heading', { level: 1, name: 'ByteDance', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('series-card')).toHaveCount(3);
  for (const [name, href] of [
    ['Seedance 2.5', '/bytedance/seedance-2.5'],
    ['Seedance 2.0', '/bytedance/seedance-2.0'],
    ['Seedance 2.0 Fast', '/bytedance/seedance-2.0?variant=bytedance%2Fseedance-2.0-fast'],
    ['Seedance 2.0 Mini', '/bytedance/seedance-2.0?variant=bytedance%2Fseedance-2.0-mini'],
    ['Seedream 5.0 Pro', '/bytedance/seedream-5.0-pro'],
  ] as const) {
    const link = page.locator(`a[href="${href}"]`).filter({ hasText: name }).first();
    await expect(link).toBeVisible();
  }
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: path.join(evidenceDir, 'company-bytedance-desktop.png'),
    fullPage: true,
  });
  await page.locator('a[href="/bytedance/seedance-2.5"]').first().click();
  await expect(page).toHaveURL(/\/bytedance\/seedance-2\.5$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Seedance 2.5', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('series-variant')).toHaveCount(1);
  await expect(
    variant(page, 'bytedance/seedance-2.5').locator('.route-table tbody tr'),
  ).toHaveCount(
    catalog.routes.filter((route) => route.modelId === 'bytedance/seedance-2.5').length,
  );
  const prices = variant(page, 'bytedance/seedance-2.5');
  await expect(prices.getByRole('link', { name: 'BytePlus', exact: true })).toHaveCount(1);
  const byteplus = prices.locator(
    '[data-route-id="byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5"]',
  );
  await expect(byteplus.locator('.price-details summary')).toHaveText([
    /480p\s*≈\$0\.103\s*\/ sec/,
    /720p\s*≈\$0\.231\s*\/ sec/,
    /1080p\s*≈\$0\.569\s*\/ sec/,
  ]);
  await expect(
    prices.locator(
      '[data-route-id="fal-undisclosed/bytedance/seedance-2.5/text-to-video"] .price-details summary',
    ),
  ).toHaveText([/480p\s*≈\$0\.2205\s*\/ sec/, /720p\s*≈\$0\.473\s*\/ sec/, /1080p\s*—/]);
  await expect(
    prices.locator(
      '[data-route-id="fal-undisclosed/bytedance/seedance-2.5/image-to-video"] .price-details summary',
    ),
  ).toHaveText([/480p\s*—/, /720p\s*—/, /1080p\s*—/]);
  await expect(page.getByRole('link', { name: 'ByteDance', exact: true }).first()).toHaveAttribute(
    'href',
    '/bytedance',
  );
  await expect(page).toHaveTitle(/Seedance 2\.5/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/bytedance\/seedance-2\.5$/,
  );
});

test('MiniMax H3 groups one Max variant across providers and retains the other variants', async ({
  page,
}) => {
  await page.goto('/minimax/h3');
  await expect(
    page.getByRole('heading', { level: 1, name: 'MiniMax H3', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'MiniMax', exact: true }).first()).toHaveAttribute(
    'href',
    '/minimax',
  );
  await expect(page.getByTestId('series-variant')).toHaveCount(6);
  for (const id of [
    'minimax/h3',
    'minimax/h3-highspeed',
    'minimax/h3-lite',
    'minimax/h3-max',
    'fal/h3-max-turbo',
    'pika/h3-flex',
  ]) {
    await expect(variant(page, id)).toBeVisible();
    await expect(variant(page, id)).toContainText(id);
    await expect(variant(page, id).locator('.route-table tbody tr')).toHaveCount(
      catalog.routes.filter((route) => route.modelId === id).length,
    );
  }
  const max = variant(page, 'minimax/h3-max');
  await expect(max.locator('.route-table tbody tr')).toHaveCount(2);
  await expect(max).toContainText('MiniMax');
  await expect(max).toContainText('fal');
  await expect(max).toContainText('Listed as H3 Max');
  await expect(max.locator('.variant-attribution .official-tag')).toHaveText('Official');
  const nativeMax = max.locator('tr[data-route-id="minimax-undisclosed/minimax-h3-max"]');
  const falMax = max.locator('tr[data-route-id="fal-undisclosed/fal-h3-max"]');
  await expect(nativeMax.locator('.provider-name .official-tag')).toHaveText('Official');
  await expect(falMax.locator('.provider-name .official-tag')).toHaveCount(0);
  await expect(
    variant(page, 'fal/h3-max-turbo').locator('.provider-name .official-tag'),
  ).toHaveText('Official');
  await expect(variant(page, 'fal/h3-max')).toHaveCount(0);
  await expect(variant(page, 'pika/h3-flex')).toContainText('Pika');
  // Legacy provider-named links select the same canonical Max group.
  await page.goto('/minimax/h3?variant=fal%2Fh3-max');
  await expect(page).toHaveURL(/variant=minimax%2Fh3-max/);
  await expect(max).toHaveClass(/variant-highlighted/);
  await expect(page.getByTestId('series-variant')).toHaveCount(6);
  await expect(
    page.getByRole('heading', { level: 1, name: 'MiniMax H3', exact: true }),
  ).toBeVisible();
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, 'series-h3-desktop.png'), fullPage: true });
  await page.goto('/fal/h3-max');
  await expect(page).toHaveURL(/\/minimax\/h3\?variant=minimax%2Fh3-max/);
  const falTry = variant(page, 'minimax/h3-max').getByRole('link', { name: /Use fal .* route/ });
  await falTry.click();
  await expect(page.getByLabel('Choose generation model')).toHaveValue('minimax/h3-max');
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue(
    'fal-undisclosed/fal-h3-max',
  );
  await page.goto('/playground?model=fal%2Fh3-max&route=fal-undisclosed%2Ffal-h3-max');
  await expect(page).toHaveURL(/model=minimax%2Fh3-max/);
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue(
    'fal-undisclosed/fal-h3-max',
  );
});

test('Wan keeps Standard and Prime in separate provider tables with all regional offerings', async ({
  page,
}) => {
  await page.goto('/alibaba/wan-3.0');
  const standard = variant(page, 'alibaba/wan-3.0');
  const prime = variant(page, 'alibaba/wan-3.0-prime');
  await expect(page.getByTestId('series-variant')).toHaveCount(2);
  for (const section of [standard, prime]) {
    await expect(section.locator('.route-table tbody tr')).toHaveCount(6);
    await expect(section.locator('.provider-name .official-tag')).toHaveCount(6);
    for (const location of [
      'Beijing, China',
      'Singapore',
      'Tokyo, Japan',
      'Frankfurt, Germany',
      'Virginia, US',
      'Hong Kong, China',
    ]) {
      await expect(section.locator('.route-table')).toContainText(location);
    }
  }
  await expect(standard).toContainText('$0.082513');
  await expect(prime).toContainText('$0.127199');
  const verified = standard.locator('[data-route-id="alibaba/ap-southeast-1/wan-3.0"]');
  await expect(verified.getByText('Verified', { exact: true })).toBeVisible();
  await expect(standard.getByText('Verified', { exact: true })).toHaveCount(1);
  await expect(prime.getByText('Verified', { exact: true })).toHaveCount(1);
  await verified.getByRole('link', { name: 'Alibaba Cloud', exact: true }).hover();
  await expect(verified.getByRole('tooltip')).toContainText(
    /text to video and image to video at 480p and 2s/i,
  );
  const primeVerified = prime.locator('[data-route-id="alibaba/ap-southeast-1/wan-3.0-prime"]');
  await primeVerified.getByRole('link', { name: 'Alibaba Cloud', exact: true }).hover();
  await expect(primeVerified.getByRole('tooltip')).toContainText(
    /text to video and image to video at 480p and 2s/i,
  );
  await expect(page.getByRole('columnheader', { name: 'Attempt completion' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Success rate' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Latency percentile' })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Uptime', exact: true })).toHaveCount(0);
});

test('provider region labels show only disclosed fields and explain missing details', async ({
  page,
}) => {
  await page.goto('/bytedance/seedance-2.5');
  const row = (route: string) => page.locator(`[data-route-id="${route}"] .provider-region`);
  const unknown = row('fal-undisclosed/bytedance/seedance-2.5/text-to-video');
  const provider = unknown.getByRole('link', { name: 'fal', exact: true });
  const tooltip = unknown.locator('[role="tooltip"]');
  await expect(unknown.locator('.region-line')).toHaveCount(0);
  await expect(unknown.getByText('Region details unavailable')).toHaveCount(0);
  await expect(unknown.locator('.route-state')).toHaveCount(0);
  await expect(tooltip).toBeHidden();
  await provider.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('Documented by the provider.');
  await expect(tooltip).toHaveText(/endpoint region.*inference scope.*not disclosed/i);
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await page.mouse.move(1, 1);
  await provider.hover();
  await expect(tooltip).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(tooltip).toBeHidden();
  await provider.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await expect(provider).toBeFocused();
  await page.keyboard.press('Tab');
  await provider.focus();
  await expect(tooltip).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(tooltip).toBeHidden();

  const endpointOnly = row('byteplus-modelark-ap-southeast-1/bytedance-seedance-2.5');
  await expect(endpointOnly.locator('.endpoint-region')).toHaveText('Endpoint: Singapore');
  await expect(endpointOnly.locator('svg')).toHaveCount(1);
  await expect(endpointOnly.locator('.scope-tag')).toHaveCount(0);

  await page.goto('/bytedance/seedance-2.0');
  const scopeOnly = row('fal-seedance-us-account-enabled/bytedance-seedance-2.0');
  await expect(scopeOnly.locator('.scope-tag')).toHaveText('Inference scope: Regional');
  await expect(scopeOnly.locator('svg, .endpoint-region')).toHaveCount(0);

  await page.goto('/alibaba/wan-3.0');
  const disclosed = row('alibaba/eu-central-1/wan-3.0');
  await expect(disclosed.locator('.endpoint-region')).toHaveText('Endpoint: Frankfurt, Germany');
  await expect(disclosed.locator('.scope-tag')).toHaveText('Inference scope: Global');
  await expect(disclosed.locator('svg')).toHaveCount(1);
  await expect(disclosed.locator('.route-state')).toHaveCount(0);
  const documented = disclosed.locator('[role="tooltip"]');
  await expect(documented).toBeHidden();
  await disclosed.getByRole('link', { name: 'Alibaba Cloud' }).hover();
  await expect(documented).toBeVisible();
  await expect(documented).toHaveText('Documented by the provider.');
  expect(await disclosed.getAttribute('tabindex')).toBeNull();
});

test('provider Try handoff preserves the exact model variant and regional route', async ({
  page,
}) => {
  await page.goto('/alibaba/wan-3.0');
  await variant(page, 'alibaba/wan-3.0-prime')
    .getByRole('link', { name: 'Use Alibaba Cloud Singapore route', exact: true })
    .click();
  await expect(page).toHaveURL(/model=alibaba%2Fwan-3\.0-prime/);
  await expect(page).toHaveURL(/route=alibaba%2Fap-southeast-1%2Fwan-3\.0-prime/);
  await expect(page.getByRole('heading', { name: 'Wan 3.0 Prime', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/playground\?/);
  await expect(
    page.getByRole('heading', { name: 'Bring your idea to life.', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Choose generation model')).toHaveValue('alibaba/wan-3.0-prime');
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue(
    'alibaba/ap-southeast-1/wan-3.0-prime',
  );
  await page.getByLabel('Prompt', { exact: true }).fill('A paper sailboat on still water.');
  const quoteRequest = page.waitForRequest(
    (request) => request.url().endsWith('/api/quotes') && request.method() === 'POST',
  );
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  const input = (await quoteRequest).postDataJSON();
  expect(input.modelId).toBe('alibaba/wan-3.0-prime');
  expect(input.routeId).toBe('alibaba/ap-southeast-1/wan-3.0-prime');
  await expect(page.getByText('Quote details · 1 route', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
});

test('unknown company and series URLs return a real 404', async ({ page }) => {
  const company = await page.goto('/not-a-company');
  expect(company?.status()).toBe(404);
  const series = await page.goto('/minimax/not-a-series');
  expect(series?.status()).toBe(404);
});

test('a new route choice overrides a legacy handoff and stays selected while editing inputs', async ({
  page,
}) => {
  await page.goto(
    '/?model=alibaba%2Fwan-3.0-prime&route=alibaba%2Fap-southeast-1%2Fwan-3.0-prime&view=playground#catalog',
  );
  await expect(page).toHaveURL(/\/playground\?/);
  const route = page.getByLabel('Provider route', { exact: true });
  await expect(route).toHaveValue('alibaba/ap-southeast-1/wan-3.0-prime');
  await route.selectOption('alibaba/eu-central-1/wan-3.0-prime');
  await page.getByLabel('Prompt', { exact: true }).fill('A slow tracking shot.');
  await page.getByRole('combobox', { name: 'Resolution', exact: true }).selectOption('1080p');
  await expect(route).toHaveValue('alibaba/eu-central-1/wan-3.0-prime');
  await page.getByLabel('Choose generation model').selectOption('bytedance/seedance-2.5');
  await expect(page.getByRole('heading', { name: 'Seedance 2.5', exact: true })).toBeVisible();
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue('auto');
});

test('provider metrics stay regional and the percentile picker reads the selected observation', async ({
  page,
}) => {
  let metricRequests = 0;
  await page.route('**/api/metrics', async (route) => {
    metricRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            routeId: 'alibaba/ap-southeast-1/wan-3.0',
            sampleCount: 20,
            succeeded: 18,
            failed: 2,
            unresolved: 0,
            unclassifiedFailures: 0,
            technicalSuccessRate: 0.9,
            p50CompletionMs: 1200,
            p75CompletionMs: 2000,
            p90CompletionMs: 3000,
            p95CompletionMs: 4000,
            p99CompletionMs: 9500,
            window: '7 days',
            benchmarkOrigin: 'controlled-test-fixture',
          },
        ],
      }),
    });
  });
  await page.goto('/alibaba/wan-3.0');
  const standard = variant(page, 'alibaba/wan-3.0');
  const singapore = standard.locator('.route-table tbody tr').filter({ hasText: 'Singapore' });
  const frankfurt = standard.locator('.route-table tbody tr').filter({ hasText: 'Frankfurt' });
  await expect(singapore).toContainText(/1\.2\s?s/);
  await expect(singapore).toContainText(/90(?:\.0+)?%/);
  await expect(frankfurt.locator('.metric-cell')).toHaveText(['', '']);
  await expect(standard).not.toContainText('No observations');
  await expect(standard).not.toContainText(/\b0 samples\b/);
  await page.getByRole('button', { name: 'P99', exact: true }).click();
  await expect(singapore).toContainText(/9\.5\s?s/);
  await expect(frankfurt.locator('.metric-cell')).toHaveText(['', '']);
  await expect(page.getByRole('columnheader', { name: 'Uptime', exact: true })).toHaveCount(0);
  expect(metricRequests).toBe(1);
});

test.describe('phone series pages', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('keeps grouped variants and regional tables inside the page width', async ({ page }) => {
    await page.goto('/minimax/h3');
    await expect(page.getByTestId('series-variant')).toHaveCount(6);
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(overflow.page).toBeLessThanOrEqual(overflow.viewport);
    await expect(variant(page, 'pika/h3-flex')).toBeVisible();
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, 'series-h3-mobile.png'), fullPage: true });
    await page.goto('/bytedance');
    await expect(page.getByTestId('series-card')).toHaveCount(3);
    const companyOverflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(companyOverflow.page).toBeLessThanOrEqual(companyOverflow.viewport);
    await page.screenshot({
      path: path.join(evidenceDir, 'company-bytedance-mobile.png'),
      fullPage: true,
    });
  });
});

test('published token tariffs render as crawlable information without claiming a full quote', async ({
  page,
}) => {
  const route = catalog.routes.find(
    (route) =>
      route.modelId === 'openai/gpt-image-2.5-flare' && route.deploymentId === 'openai-undisclosed',
  )!;
  const raw = await page.request.get('/openai/gpt-image-2.5');
  expect(raw.status()).toBe(200);
  expect(await raw.text()).toContain('class="published-tariff"');
  await page.goto('/openai/gpt-image-2.5');
  const row = variant(page, route.modelId).locator(`[data-route-id="${route.id}"]`);
  const price = row.locator('.price-details summary').filter({ hasText: /^1K/ });
  await expect(price).toHaveText(/1K\s*—/);
  await expect(price).toHaveAttribute('title', /per 1M tokens/i);
  await expect(row.locator('.published-tariff').filter({ visible: true })).toHaveCount(0);
  await price.click();
  await expect(row).toContainText(/per 1M tokens/i);
  await expect(row).toContainText('Published tariff');
  await expect(row).toContainText('request quote unqualified');
  await expect(row).toContainText(`Checked ${route.publishedPricing!.source.checkedAt}`);
  await expect(row).toContainText('actual token consumption');
  await expect(row.getByRole('link', { name: 'Price source' })).toHaveAttribute(
    'href',
    route.publishedPricing!.source.url,
  );
  await page.goto('/bytedance/seedream-5.0-pro');
  await expect(
    page.locator(
      '[data-route-id="replicate-undisclosed/bytedance-seedream-5.0-pro"] .price-details summary',
    ),
  ).toHaveText([/1K\s*\$0\.045\s*\/ image/, /1\.5K\s*—/, /2K\s*\$0\.09\s*\/ image/]);
});
