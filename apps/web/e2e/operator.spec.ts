import { test, expect } from '@playwright/test';

test('operator inspects a generation before submitting a referenced reconciliation', async ({
  page,
}) => {
  const id = 'ac516caa-cc3c-494b-a76b-a61427b46bfb';
  const job = {
    id,
    workspaceId: 'customer-a',
    status: 'submission-unknown',
    input: {
      modelId: 'fixture/video',
      operation: 'text-to-video',
      input: { prompt: 'Synthetic verification.', resolution: '720p', duration: 5 },
    },
    routeId: 'fixture/region/video',
    deploymentId: 'fixture-region',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-02T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    reservedMicros: 100000,
    settledMicros: null,
    attemptCount: 1,
  };
  await page.route('**/api/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        authenticated: true,
        workspaceId: 'local',
        scopes: ['read', 'keys:write'],
        isOperator: true,
        oidcEnabled: false,
      }),
    }),
  );
  await page.route(`**/api/workspaces/customer-a/generations/${id}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(job) }),
  );
  let payload: Record<string, unknown> | undefined;
  await page.route(`**/api/workspaces/customer-a/generations/${id}/reconcile`, async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ ...job, status: 'running', upstreamId: 'provider-task-1' }),
    });
  });
  await page.goto('/operator');
  await page.getByRole('textbox', { name: 'Workspace ID', exact: true }).fill('customer-a');
  await page.getByRole('textbox', { name: 'Generation ID', exact: true }).fill(id);
  await page.getByRole('button', { name: 'Inspect generation' }).click();
  await expect(page.getByText('submission-unknown', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply reconciliation' })).toBeDisabled();
  await page.getByRole('textbox', { name: 'Original upstream task ID' }).fill('provider-task-1');
  await page.getByRole('textbox', { name: 'Stable evidence reference' }).fill('case-001');
  await page
    .getByRole('textbox', { name: 'Provider evidence URL' })
    .fill('https://provider.example/tasks/1');
  await page
    .getByRole('textbox', { name: 'Verification notes' })
    .fill('Verified original provider account task and regional deployment.');
  await page
    .getByRole('checkbox', {
      name: 'I verified the original provider record and the action above.',
    })
    .check();
  await page.getByRole('button', { name: 'Apply reconciliation' }).click();
  await expect(page.getByText('running', { exact: true })).toBeVisible();
  expect(payload).toMatchObject({
    action: 'resume',
    reference: 'case-001',
    upstreamId: 'provider-task-1',
  });
  expect(payload).not.toHaveProperty('billedCostMicros');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
});
