import { expect, test } from '@playwright/test';
const session = {
  authenticated: true,
  workspaceId: 'studio-a',
  scopes: ['read', 'feedback:write'],
  role: 'admin',
};

test('reviews only exact sanitized fields and sends once after explicit consent', async ({
  page,
}, info) => {
  const writes: unknown[] = [];
  await page.route('**/api/session', (route) => route.fulfill({ json: session }));
  await page.route('**/v1/feedback', (route) => {
    writes.push(route.request().postDataJSON());
    return route.fulfill({
      status: 201,
      json: { id: '11111111-1111-4111-8111-111111111111', status: 'received' },
    });
  });
  await page.goto('/feedback');
  await expect(page.getByRole('heading', { name: 'Tell us what got in your way.' })).toBeVisible();
  await page
    .getByLabel('Sanitized summary')
    .fill('The upload instructions should explain when the file is ready.');
  expect(writes).toEqual([]);
  await page.getByRole('button', { name: 'Review report', exact: true }).click();
  const exact = {
    kind: 'feedback',
    category: 'setup',
    summary: 'The upload instructions should explain when the file is ready.',
    reviewedForPrivacy: true,
  };
  expect(JSON.parse(await page.getByLabel('Exact report JSON').innerText())).toEqual(exact);
  expect(writes).toEqual([]);
  await expect(
    page.getByRole('button', { name: 'Send private report', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('I reviewed these exact fields and removed private information.').check();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: info.outputPath('feedback.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Send private report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Report received' })).toBeVisible();
  expect(writes).toEqual([exact]);
  await expect(page.getByRole('button', { name: 'Send private report' })).toHaveCount(0);
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain(exact.summary);
});

test('blocks private pastes and invalidates review after edits', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/session', (route) => route.fulfill({ json: session }));
  await page.route('**/v1/feedback', (route) => {
    writes++;
    return route.abort();
  });
  await page.goto('/feedback');
  const summary = page.getByLabel('Sanitized summary');
  await summary.fill('My source link is https://private.example/secret');
  await page.getByRole('button', { name: 'Review report', exact: true }).click();
  await expect(page.locator('.error-notice[role=alert]')).toContainText('Remove URLs');
  await expect(page.getByLabel('Exact report JSON')).toHaveCount(0);
  await summary.fill('The regional route labels need clearer descriptions.');
  await page.getByRole('button', { name: 'Review report', exact: true }).click();
  await page.getByLabel('I reviewed these exact fields and removed private information.').check();
  await summary.fill('The regional route labels need more examples.');
  await expect(page.getByLabel('Exact report JSON')).toHaveCount(0);
  expect(writes).toBe(0);
});

test('read-only agent access cannot submit feedback and denied sends are visible', async ({
  page,
}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { ...session, scopes: ['read', 'generate'] } }),
  );
  await page.goto('/feedback');
  await expect(
    page.getByText('Your current access can read reports.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review report', exact: true })).toBeDisabled();
  await page.route('**/api/session', (route) => route.fulfill({ json: session }));
  await page.route('**/v1/feedback', (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: 'feedback_not_configured',
          message: 'Private report storage is not configured.',
        },
      },
    }),
  );
  await page.reload();
  await page.getByLabel('Sanitized summary').fill('The upload instructions need more detail.');
  await page.getByRole('button', { name: 'Review report', exact: true }).click();
  await page.getByLabel('I reviewed these exact fields and removed private information.').check();
  await page.getByRole('button', { name: 'Send private report', exact: true }).click();
  await expect(page.locator('.error-notice[role=alert]')).toHaveText(
    'Private report storage is not configured.',
  );
});

test('catalog requests link explicit owned IDs only', async ({ page }) => {
  let body: unknown;
  await page.route('**/api/session', (route) => route.fulfill({ json: session }));
  await page.route('**/v1/catalog/requests', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { id: '11111111-1111-4111-8111-111111111111' } });
  });
  await page.goto('/feedback');
  await page.getByLabel('Report type').selectOption('catalog-request');
  await page.getByRole('combobox', { name: 'Category', exact: true }).selectOption('missing-route');
  await page
    .getByLabel('Sanitized summary')
    .fill('Please document whether this model has a Frankfurt route.');
  await page.getByText('Link existing model, route or job IDs (optional)', { exact: true }).click();
  await page.getByLabel('Model ID', { exact: true }).fill('minimax/h3-max');
  await page.getByRole('button', { name: 'Review report', exact: true }).click();
  await page.getByLabel('I reviewed these exact fields and removed private information.').check();
  await page.getByRole('button', { name: 'Send private report', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Report received' })).toBeVisible();
  expect(body).toEqual({
    kind: 'catalog-request',
    category: 'missing-route',
    summary: 'Please document whether this model has a Frankfurt route.',
    modelId: 'minimax/h3-max',
    reviewedForPrivacy: true,
  });
});

test('home onboarding uses the configured public origin and the setup dialog keeps CLI and API commands', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.getByRole('region', { name: 'Give this to your agent' });
  const origin = new URL(
    process.env.OPENGEN_PUBLIC_URL ?? process.env.MEDIA_ROUTER_PUBLIC_URL ?? 'https://opengen.dev',
  ).origin;
  await expect(card.locator('code')).toHaveText(`Set up OpenGen - ${origin}/llms.txt`);
  // The home overlay intentionally hides its desktop setup button beside the hero card.
  // An ordinary page exposes the shared compact dialog on both viewports.
  await page.goto('/agents');
  const setupOrigin = new URL((await page.locator('link[rel=canonical]').getAttribute('href'))!)
    .origin;
  if (
    !(await page
      .getByRole('button', { name: /Connect an agent/ })
      .filter({ visible: true })
      .count())
  )
    await page.locator('.mobile-nav summary').click();
  await page
    .getByRole('button', { name: /Connect an agent/ })
    .filter({ visible: true })
    .first()
    .click();
  const setup = page.getByRole('dialog');
  await expect(setup.locator('code')).toHaveText(`${setupOrigin}/llms.txt`);
  await setup.getByRole('tab', { name: 'API', exact: true }).click();
  await expect(setup.locator('code')).toHaveText(`curl ${setupOrigin}/v1/models`);
  await setup.getByRole('button', { name: 'Close setup' }).click();
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Private feedback', exact: true }),
  ).toHaveAttribute('href', '/feedback');
  const guide = await page.request.get('/guides/image-to-video.md');
  expect(guide.status()).toBe(200);
  expect(guide.headers()['content-type']).toContain('text/markdown');
  const text = await guide.text();
  for (const term of [
    'assets.prepare',
    'assets.complete',
    'models.schema',
    'quote',
    'maxCostMicros',
    'resume',
  ])
    expect(text).toContain(term);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
