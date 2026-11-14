import { expect, test } from '@playwright/test';
import type { ComparisonJob, ComparisonRun, ComparisonSummary } from '@media-router/contracts';

const ids = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.5',
] as const;
const privatePrompt = 'A miniature stone sculpture in the sun.';
const runId = 'e1bf67ee-603e-423f-8b37-e5dbb70df276';
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function comparisonQuote(id = runId, prompt = privatePrompt, lifetimeMs = 600_000): ComparisonRun {
  const child = (
    routeId: (typeof ids)[number],
    index: number,
  ): ComparisonRun['children'][number] => ({
    input: {
      modelId: index === 0 ? 'xai/grok-imagine-image-2.0' : 'bytedance/seedream-5.5',
      operation: 'text-to-image',
      routeId,
      billing: 'managed',
      input: { prompt, count: 1, resolution: index === 0 ? '1K' : '2K' },
    },
    estimatedMicros: index === 0 ? 40_000 : 45_000,
    ceilingMicros: index === 0 ? 40_000 : 45_000,
    endpointRegion: index === 0 ? 'undisclosed' : 'ap-southeast-1',
    providerId: index === 0 ? 'xai' : 'byteplus',
    notices: [],
  });
  return {
    id,
    admittedAt: null,
    expiresAt: new Date(Date.now() + lifetimeMs).toISOString(),
    estimatedMicros: 85_000,
    ceilingMicros: 85_000,
    children: [child(ids[0], 0), child(ids[1], 1)],
    jobs: [],
  };
}

for (const width of [1440, 390]) {
  test(`reviews aggregate spend and resumes private children at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    const quote = comparisonQuote();
    const admittedAt = new Date().toISOString();
    const jobs: ComparisonJob[] = quote.children.map((child, index) => ({
      id:
        index === 0
          ? 'e2708cbb-2ae9-4365-b1a8-c8878a2d0137'
          : '3a70d69b-48b7-4f94-aa88-d89a73e7ba4c',
      workspaceId: 'private-test',
      status: index === 0 ? 'succeeded' : 'failed',
      routeId: child.input.routeId!,
      deploymentId: child.input.routeId!.split('/')[0]!,
      upstreamId: null,
      deliveryStatus: index === 0 ? 'available' : 'failed',
      outputs: index === 0 ? [{ url: png, mediaType: 'image/png', fidelity: 'unverified' }] : [],
      reservedMicros: child.ceilingMicros,
      settledMicros: index === 0 ? 33_000 : 0,
      createdAt: admittedAt,
      updatedAt: admittedAt,
      error: null,
      attemptCount: 1,
      input: child.input,
      executionTiming: { durationMs: 4123, source: 'gateway' },
    }));
    let approvals = 0;
    let reads = 0;
    await page.route('**/api/session', (route) =>
      route.fulfill({
        json: {
          authenticated: true,
          workspaceId: 'private-test',
          recoveryScope: 'fixture-authority',
          scopes: ['read', 'generate'],
        },
      }),
    );
    await page.route('**/v1/comparisons/quote', async (route) => {
      expect(route.request().headers()['x-opengen-recovery-scope']).toBe('fixture-authority');
      expect(route.request().postDataJSON()).toEqual({ prompt: privatePrompt, routeIds: ids });
      await route.fulfill({ status: 201, json: quote });
    });
    await page.route(`**/v1/comparisons/${runId}/approve`, (route) => {
      approvals += 1;
      expect(route.request().postData()).toBeNull();
      return route.fulfill({
        status: 503,
        json: { error: 'Lost response after fixture admission.' },
      });
    });
    await page.route(`**/v1/comparisons/${runId}`, (route) => {
      reads += 1;
      return route.fulfill({ json: approvals ? { ...quote, admittedAt, jobs } : quote });
    });
    await page.route('**/v1/comparisons', (route) => {
      const recent: ComparisonSummary[] = approvals
        ? [{ id: runId, admittedAt, routeIds: [...ids] }]
        : [];
      return route.fulfill({ json: { data: recent } });
    });

    await page.goto('/playground/compare');
    const prompt = page.getByRole('textbox', { name: 'Shared prompt' });
    await prompt.fill(privatePrompt);
    await page.getByRole('button', { name: 'Get comparison quote' }).click();
    await expect(page.getByText('Combined estimate')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Quote by model' })).toBeVisible();
    expect(approvals).toBe(0);
    const approve = page.getByRole('button', { name: 'Approve up to $0.085 and run' });
    await approve.click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Approval could not be confirmed' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Check this comparison' }).click();
    await expect(page.getByRole('heading', { name: 'One comparison run' })).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Image from Grok Imagine Image 2.0' }),
    ).toBeVisible();
    await expect(page.getByText('failed · delivery failed')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'One comparison run' })).toBeVisible();
    await page.getByRole('button', { name: 'Check same job' }).last().click();
    await expect(page.getByText('Existing job status: failed.')).toBeVisible();
    expect(approvals).toBe(1);
    expect(reads).toBe(3);
    expect(page.url()).not.toContain(encodeURIComponent(privatePrompt));
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(privatePrompt);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );

    await page.getByRole('button', { name: 'Copy comparison settings' }).click();
    await expect(prompt).toBeFocused();
    await expect(prompt).toHaveValue(privatePrompt);
    await expect(page.getByRole('button', { name: 'Get comparison quote' })).toBeEnabled();
    await expect(approve).toHaveCount(0);
    expect(approvals).toBe(1);

    const firstJob = jobs[0]!;
    await page.route(`**/api/generations/${firstJob.id}`, (route) => {
      expect(route.request().headers()['x-opengen-recovery-scope']).toBe('fixture-authority');
      return route.fulfill({ json: firstJob });
    });
    await page.getByText('Recent comparisons', { exact: true }).click();
    await page.getByRole('button', { name: /Grok Imagine Image 2.0.*Seedream 5\.5/ }).click();
    await page.getByRole('button', { name: 'Open in Playground' }).first().click();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/playground' &&
        url.searchParams.get('route') === ids[0] &&
        url.searchParams.get('operation') === 'text-to-image' &&
        !url.search.includes(firstJob.id),
    );
    await expect(page.locator('.job-id').filter({ hasText: firstJob.id })).toBeAttached();
    await expect(page.getByRole('button', { name: 'Copy settings to form' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Prepare a new attempt' })).toHaveCount(0);
    expect(approvals).toBe(1);
  });
}

test('an uncertain approval survives edits, expiry, missing reads and reload without a replacement pair', async ({
  page,
}) => {
  await page.clock.install();
  const quote = comparisonQuote(runId, privatePrompt, 60_000);
  let quotes = 0;
  let approvals = 0;
  let recovery: 'unadmitted' | 'missing' | 'admitted' = 'unadmitted';
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        workspaceId: 'private-test',
        recoveryScope: 'fixture-authority',
        scopes: ['read', 'generate'],
      },
    }),
  );
  await page.route('**/v1/comparisons', (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/v1/comparisons/quote', (route) => {
    quotes++;
    return route.fulfill({ status: 201, json: quote });
  });
  await page.route(`**/v1/comparisons/${runId}/approve`, (route) => {
    approvals++;
    return route.fulfill({
      status: approvals === 1 ? 503 : 409,
      json: { error: approvals === 1 ? 'Lost approval response.' : 'Quote expired.' },
    });
  });
  await page.route(`**/v1/comparisons/${runId}`, (route) =>
    recovery === 'missing'
      ? route.fulfill({ status: 404, json: { error: 'Comparison not found.' } })
      : route.fulfill({
          json:
            recovery === 'admitted' ? { ...quote, admittedAt: new Date().toISOString() } : quote,
        }),
  );

  await page.goto('/playground/compare');
  const prompt = page.getByRole('textbox', { name: 'Shared prompt' });
  const getQuote = page.getByRole('button', { name: 'Get comparison quote' });
  await prompt.fill(privatePrompt);
  await getQuote.click();
  await page.getByRole('button', { name: 'Approve up to $0.085 and run' }).click();
  await expect(page.locator('.error-notice[role="alert"]')).toContainText(
    'Approval could not be confirmed',
  );
  await prompt.fill('A different draft.');
  await prompt.fill(privatePrompt);
  await expect(getQuote).toBeDisabled();
  await page.clock.fastForward(60_001);
  await expect(
    page.getByText('Quote expired while approval is unresolved.', { exact: false }),
  ).toBeVisible();
  await expect(getQuote).toBeDisabled();
  const recover = page.getByRole('button', { name: 'Recover original approval' });
  await recover.click();
  await expect(page.getByRole('button', { name: 'Retry original approval' })).toBeEnabled();
  await expect(getQuote).toBeDisabled();
  await page.getByRole('button', { name: 'Retry original approval' }).click();
  await expect(page.locator('.error-notice[role="alert"]')).toContainText(
    'Approval could not be confirmed',
  );
  await expect(getQuote).toBeDisabled();

  recovery = 'missing';
  await recover.click();
  await expect(page.locator('.error-notice[role="alert"]')).toContainText('Comparison not found');
  await page.reload();
  await expect(recover).toBeVisible();
  await prompt.fill(privatePrompt);
  await expect(getQuote).toBeDisabled();
  expect(quotes).toBe(1);
  expect(approvals).toBe(2);

  recovery = 'admitted';
  await recover.click();
  await expect(page.getByRole('heading', { name: 'One comparison run' })).toBeVisible();
  await expect(recover).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy comparison settings' }).click();
  await expect(getQuote).toBeEnabled();
  expect(quotes).toBe(1);
  expect(approvals).toBe(2);
});

test('another preopened tab cannot erase an uncertain approval in this tab', async ({
  page,
  context,
}) => {
  const secondId = '83f775e6-e4a5-48ed-abd1-f53d04f62242';
  const first = comparisonQuote(runId, 'Private comparison in tab A.');
  const second = comparisonQuote(secondId, 'Private comparison in tab B.');
  const approvals: string[] = [];
  const quotes: string[] = [];
  const reads: string[] = [];
  let firstAdmitted = false;
  await context.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        workspaceId: 'private-test',
        recoveryScope: 'fixture-authority',
        scopes: ['read', 'generate'],
      },
    }),
  );
  await context.route('**/v1/comparisons', (route) => route.fulfill({ json: { data: [] } }));
  await context.route('**/v1/comparisons/quote', (route) => {
    const prompt = route.request().postDataJSON().prompt;
    quotes.push(prompt);
    return route.fulfill({
      status: 201,
      json: prompt === first.children[0].input.input.prompt ? first : second,
    });
  });
  await context.route('**/v1/comparisons/*/approve', (route) => {
    const id = route.request().url().split('/').at(-2)!;
    approvals.push(id);
    return id === runId
      ? route.fulfill({ status: 503, json: { error: 'Lost tab A approval response.' } })
      : route.fulfill({ status: 202, json: { ...second, admittedAt: new Date().toISOString() } });
  });
  await context.route('**/v1/comparisons/*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const id = route.request().url().split('/').at(-1)!;
    reads.push(id);
    const run = id === runId ? first : second;
    return route.fulfill({
      json: {
        ...run,
        admittedAt: id === runId && !firstAdmitted ? null : new Date().toISOString(),
      },
    });
  });
  const other = await context.newPage();
  // Both tabs restore before A saves its unknown paid intent.
  await Promise.all([page.goto('/playground/compare'), other.goto('/playground/compare')]);
  for (const [tab, quote] of [
    [page, first],
    [other, second],
  ] as const) {
    await tab
      .getByRole('textbox', { name: 'Shared prompt' })
      .fill(quote.children[0].input.input.prompt!);
    await tab.getByRole('button', { name: 'Get comparison quote' }).click();
    await expect(tab.getByRole('button', { name: 'Approve up to $0.085 and run' })).toBeEnabled();
  }
  await page.getByRole('button', { name: 'Approve up to $0.085 and run' }).click();
  await expect(page.locator('.error-notice[role="alert"]')).toContainText(
    'Approval could not be confirmed',
  );
  await other.getByRole('button', { name: 'Approve up to $0.085 and run' }).click();
  await expect(other.getByRole('heading', { name: 'One comparison run' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'Recover original approval' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Recover original approval' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Shared prompt' })).toHaveValue(
    first.children[0].input.input.prompt!,
  );
  await expect(page.getByRole('button', { name: 'Get comparison quote' })).toBeDisabled();
  expect(reads.at(-1)).toBe(runId);
  expect(quotes).toEqual([
    first.children[0].input.input.prompt,
    second.children[0].input.input.prompt,
  ]);
  expect(approvals).toEqual([runId, secondId]);
  firstAdmitted = true;
  await page.getByRole('button', { name: 'Recover original approval' }).click();
  await expect(page.getByRole('heading', { name: 'One comparison run' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy comparison settings' }).click();
  await expect(page.getByRole('button', { name: 'Get comparison quote' })).toBeEnabled();
  expect(approvals).toEqual([runId, secondId]);
  await other.close();
});
