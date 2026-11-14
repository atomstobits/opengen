import { expect, test } from '@playwright/test';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const evidenceDir = path.resolve(import.meta.dirname, '../../..', 'docs/evidence');
const cards = (page: import('@playwright/test').Page) => page.locator('.model-directory-card');
const card = (page: import('@playwright/test').Page, modelId: string) =>
  page.locator(`.model-directory-card[data-model-id="${modelId}"]`);

test('the model catalog filters discovery while model pages preserve every regional offering', async ({
  page,
}) => {
  await page.goto('/models');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Find your next model.' }),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(35);
  await expect(page.locator('.hero')).toHaveCount(0);
  await expect(page.locator('.playground-view')).toHaveCount(0);
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({ path: path.join(evidenceDir, 'catalog-desktop.png') });
  await page.getByLabel('Search models, providers or regions').fill('Wan 3.0');
  await expect(cards(page)).toHaveCount(2);
  await page.getByLabel('Filter endpoint region').selectOption('ap-southeast-1');
  await expect(card(page, 'alibaba/wan-3.0')).toBeVisible();
  await expect(card(page, 'alibaba/wan-3.0-prime')).toBeVisible();
  await card(page, 'alibaba/wan-3.0').getByRole('link', { name: 'Wan 3.0', exact: true }).click();
  await expect(page).toHaveURL(/\/alibaba\/wan-3\.0$/);
  const standard = page.locator('[data-testid="series-variant"][data-model-id="alibaba/wan-3.0"]');
  await expect(standard.locator('.route-table tbody tr')).toHaveCount(9);
  for (const region of [
    'Beijing, China',
    'Singapore',
    'Tokyo, Japan',
    'Frankfurt, Germany',
    'Virginia, US',
    'Hong Kong, China',
  ])
    await expect(standard.locator('.route-table')).toContainText(region);
  await expect(standard.locator('.route-table')).toContainText('$0.082513');
  await expect(standard.locator('.route-table')).toContainText('$0.10');
});

test('catalog search and image filtering preserve the exact variant when opening its model page', async ({
  page,
}) => {
  await page.goto('/models');
  await page.getByLabel('Search models, providers or regions').fill('Seedance 2.0');
  await expect(cards(page)).toHaveCount(3);
  const mini = card(page, 'bytedance/seedance-2.0-mini');
  await expect(mini.getByRole('link', { name: 'Seedance 2.0 Mini', exact: true })).toHaveAttribute(
    'href',
    '/bytedance/seedance-2.0?variant=bytedance%2Fseedance-2.0-mini',
  );
  await mini.getByRole('link', { name: 'Seedance 2.0 Mini', exact: true }).click();
  await expect(page).toHaveURL(
    /\/bytedance\/seedance-2\.0\?variant=bytedance%2Fseedance-2\.0-mini$/,
  );
  await expect(page.locator('.variant-highlighted')).toHaveAttribute(
    'data-model-id',
    'bytedance/seedance-2.0-mini',
  );
  await page.goto('/models');
  await page.getByRole('button', { name: 'Image', exact: true }).click();
  await expect(cards(page).filter({ hasText: 'Seedance' })).toHaveCount(0);
  await page.getByLabel('Search models, providers or regions').fill('Sunburst');
  await expect(cards(page)).toHaveCount(1);
  const sunburst = card(page, 'openai/gpt-image-2.5-sunburst');
  await expect(sunburst.getByRole('heading', { level: 2 })).toHaveText('GPT Image 2.5 Sunburst');
  await expect(
    sunburst.getByRole('link', { name: 'Compare providers', exact: true }),
  ).toHaveAttribute('href', '/openai/gpt-image-2.5');
});

test('the separate playground quotes comparison-only routes and preserves a selected regional pin', async ({
  page,
}) => {
  const inputs: GenerateInput[] = [];
  const generationPosts: string[] = [];
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { authenticated: false, oidcEnabled: false } }),
  );
  await page.route('**/api/quotes', async (route) => {
    const input = route.request().postDataJSON() as GenerateInput;
    inputs.push(input);
    // Read-only catalog logic with execution disabled; no provider request or credential.
    await route.fulfill({ json: quote(input, { executableRouteIds: [] }) });
  });
  await page.route('**/api/generations', async (route) => {
    if (route.request().method() === 'POST') generationPosts.push(route.request().method());
    await route.fulfill({
      status: 503,
      json: { error: 'Generation is disabled in this browser fixture.' },
    });
  });
  await page.goto('/playground');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Bring your idea to life.' }),
  ).toBeVisible();
  await expect(page.getByLabel('Choose generation model')).toHaveValue('alibaba/wan-3.0');
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByRole('tablist', { name: 'Model view' })).toHaveCount(0);
  await page
    .getByLabel('Prompt', { exact: true })
    .fill('A quiet coastal road at sunrise, filmed in a slow tracking shot.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  const pricing = page.getByRole('region', { name: 'Wan 3.0 pricing' });
  await expect(pricing.getByText('Quote details · 9 routes')).toBeVisible();
  await expect(pricing).toContainText(
    'No qualified adapter and regional credentials are configured.',
  );
  await expect(page.getByRole('button', { name: 'Generate', exact: true })).toBeDisabled();
  await page
    .getByLabel('Provider route', { exact: true })
    .selectOption('alibaba/ap-southeast-1/wan-3.0');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect(pricing.getByText('Quote details · 1 route')).toBeVisible();
  await expect(pricing).toContainText('Singapore');
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toMatchObject({
    modelId: 'alibaba/wan-3.0',
    routeId: 'alibaba/ap-southeast-1/wan-3.0',
  });
  expect(generationPosts).toEqual([]);
  await page.getByLabel('Choose generation model').selectOption('openai/gpt-image-2.5-sunburst');
  await expect(
    page.getByRole('heading', { level: 2, name: 'GPT Image 2.5 Sunburst', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Prompt', { exact: true })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Model view' })).toHaveCount(0);
});

test('home keeps the agent-first hero and curated discovery while company pages remain reachable without a Companies tab', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const hero = page.locator('.hero');
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
    'Image & video models.One open gateway.',
  );
  const canonical = await page.locator('link[rel=canonical]').getAttribute('href');
  const setup = hero.getByRole('region', { name: 'Give this to your agent' });
  const prompt = `Set up OpenGen - ${new URL('/llms.txt', canonical ?? page.url()).href}`;
  await expect(setup.locator('code')).toHaveText(prompt);
  await expect(setup.getByRole('link')).toHaveCount(6);
  await expect(setup.getByRole('link', { name: 'Codex setup guide' })).toHaveAttribute(
    'href',
    '/agents/codex',
  );
  await setup.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
  await expect(hero.getByRole('link', { name: 'CLI setup' })).toHaveAttribute(
    'href',
    '/agents/cli',
  );
  await expect(hero.getByRole('link', { name: 'API docs' })).toHaveAttribute(
    'href',
    '/docs#http-examples',
  );
  const pricing = page.getByRole('region', { name: '0% markup on direct routes.' });
  await expect(pricing).toContainText('provider estimate + $0.000 OpenGen markup = your quote');
  await expect(page.getByRole('button', { name: /pause/i })).toHaveCount(0);
  await expect(hero.getByRole('link', { name: 'Create in browser' })).toHaveAttribute(
    'href',
    '/playground',
  );
  await expect(nav.getByRole('link', { name: 'Models', exact: true })).toHaveAttribute(
    'href',
    '/models',
  );
  await expect(nav.getByRole('link', { name: 'Playground', exact: true }).first()).toHaveAttribute(
    'href',
    '/playground',
  );
  await expect(nav.getByRole('link', { name: 'Companies', exact: true })).toHaveCount(0);
  await expect(page.locator('.home-discovery').getByTestId('series-card')).toHaveCount(3);
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByLabel('Prompt', { exact: true })).toHaveCount(0);
  await mkdir(evidenceDir, { recursive: true });
  await hero.screenshot({ path: path.join(evidenceDir, 'hero-desktop.png') });
  await nav.getByRole('link', { name: 'Models', exact: true }).click();
  await card(page, 'bytedance/seedance-2.5')
    .getByRole('link', { name: 'ByteDance', exact: true })
    .click();
  await expect(page).toHaveURL(/\/bytedance$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'ByteDance', exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Companies', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect an agent', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'One catalog. Every interface.' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close setup', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test.describe('phone model discovery', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('keeps the hero and dedicated model catalog inside the viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.hero').getByRole('heading', { level: 1 })).toHaveText(
      'Image & video models.One open gateway.',
    );
    const setup = page.getByRole('region', { name: 'Give this to your agent' });
    await expect(setup.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
    expect(await setup.evaluate((panel) => panel.scrollWidth)).toBeLessThanOrEqual(
      (await setup.boundingBox())!.width,
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.locator('.hero').screenshot({ path: path.join(evidenceDir, 'hero-mobile.png') });
    await page.locator('.hero').getByRole('link', { name: 'Explore models', exact: true }).click();
    await expect(page).toHaveURL(/\/models$/);
    await expect(cards(page)).toHaveCount(35);
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
    await page.screenshot({ path: path.join(evidenceDir, 'catalog-mobile.png') });
    await page.getByLabel('Filter endpoint region').selectOption('us-east-1');
    await expect(card(page, 'alibaba/wan-3.0')).toBeVisible();
    await expect(card(page, 'alibaba/wan-3.0-prime')).toBeVisible();
  });
});

test('catalog HTML is crawlable and legacy playground links preserve intent while invalid pins return 404', async ({
  page,
}) => {
  const response = await page.request.get('/models');
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(
    new Set([...html.matchAll(/data-model-id="([^"]+)"/g)].map((match) => match[1])).size,
  ).toBe(catalog.models.length);
  expect(html).toContain('href="/bytedance/seedance-2.5"');
  expect(html).toContain('href="/minimax/h3?variant=minimax%2Fh3-max"');
  await page.goto('/models');
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', /\/models$/);
  await expect(page.locator('meta[name=robots]')).not.toHaveAttribute('content', /noindex/);
  await page.goto(
    '/?model=alibaba%2Fwan-3.0-prime&route=alibaba%2Fap-southeast-1%2Fwan-3.0-prime&view=playground#catalog',
  );
  const current = new URL(page.url());
  expect(current.pathname).toBe('/playground');
  expect(current.searchParams.get('model')).toBe('alibaba/wan-3.0-prime');
  expect(current.searchParams.get('route')).toBe('alibaba/ap-southeast-1/wan-3.0-prime');
  expect(current.searchParams.has('view')).toBe(false);
  await expect(page.getByLabel('Choose generation model')).toHaveValue('alibaba/wan-3.0-prime');
  await expect(page.getByLabel('Provider route', { exact: true })).toHaveValue(
    'alibaba/ap-southeast-1/wan-3.0-prime',
  );
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', /\/playground$/);
  for (const target of [
    '/playground?model=missing%2Fmodel',
    '/playground?route=missing%2Froute',
    '/playground?model=bytedance%2Fseedance-2.5&route=alibaba%2Fap-southeast-1%2Fwan-3.0-prime',
  ]) {
    const invalid = await page.goto(target);
    expect(invalid?.status()).toBe(404);
    await expect(page.getByLabel('Choose generation model')).toHaveCount(0);
  }
});
