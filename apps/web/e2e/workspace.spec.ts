import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

function session(workspaceId = 'test', scopes = ['read', 'generate', 'keys:write']) {
  const membershipId =
    workspaceId === 'team-b'
      ? '30000000-0000-4000-8000-000000000002'
      : '30000000-0000-4000-8000-000000000001';
  return {
    authenticated: true,
    workspaceId,
    scopes,
    membershipId,
    recoveryScope: createHash('sha256')
      .update(JSON.stringify([workspaceId, membershipId, [...scopes].sort()]))
      .digest('hex'),
    role: scopes.includes('keys:write') ? 'admin' : 'member',
    canSwitchWorkspace: false,
    oidcEnabled: false,
  };
}
async function emptyActivity(page: Page) {
  await page.route(/\/api\/activity(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/api/generations', (route) =>
    route.fulfill({
      status: 405,
      json: { error: 'Activity uses compact rows; details require explicit selection.' },
    }),
  );
}

test('a playground draft survives reload without persisting gateway credentials', async ({
  page,
}) => {
  let connected = false;
  await page.route('**/api/session', async (route) => {
    if (route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toEqual({ token: 'not-a-real-key' });
      connected = true;
    }
    if (route.request().method() === 'DELETE') connected = false;
    await route.fulfill({
      json: connected
        ? session('test', ['read', 'generate'])
        : { authenticated: false, oidcEnabled: false },
    });
  });
  await page.goto('/playground?model=alibaba%2Fwan-3.0');
  await page
    .getByText('Self-hosted access with an existing workspace key', { exact: true })
    .click();
  await page.getByLabel('Workspace API key', { exact: true }).fill('not-a-real-key');
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click();
  await expect(page.locator('.gateway-connected')).toContainText('test');
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A paper crane drifting over a quiet lake.');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue(
    'A paper crane drifting over a quiet lake.',
  );
  await expect(page.locator('.recovery-notice')).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain('not-a-real-key');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page
    .getByText('Self-hosted access with an existing workspace key', { exact: true })
    .click();
  await expect(page.getByLabel('Workspace API key', { exact: true })).toHaveValue('');
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain('not-a-real-key');
});

test('workspace uses a session and displays job history, costs and ledger', async ({ page }) => {
  const job = {
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'test',
    status: 'succeeded',
    input: {
      modelId: 'alibaba/wan-3.0',
      operation: 'text-to-video',
      input: { prompt: 'An origami boat on still water.' },
    },
    routeId: 'alibaba/ap-southeast-1/wan-3.0',
    deploymentId: 'alibaba/ap-southeast-1',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-02T12:00:00Z',
    updatedAt: '2026-11-02T12:01:00Z',
    reservedMicros: 500000,
    settledMicros: 400000,
    attemptCount: 1,
  };
  await page.route('**/api/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(session('test', ['read', 'generate'])),
    }),
  );
  let listReads = 0,
    detailReads = 0;
  const compact = {
    id: job.id,
    modelId: job.input.modelId,
    operation: job.input.operation,
    routeId: job.routeId,
    deploymentId: job.deploymentId,
    providerId: 'alibaba',
    endpointRegion: 'ap-southeast-1',
    status: job.status,
    deliveryStatus: 'failed',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    reservedMicros: job.reservedMicros,
    ledgerReservedMicros: job.reservedMicros,
    settledMicros: job.settledMicros,
    heldMicros: 0,
    accountingState: 'reconciled',
    attribution: null,
    project: null,
  };
  await page.route('**/api/generations', (route) => {
    listReads++;
    return route.fulfill({ status: 405, json: { error: 'Full jobs are not Activity.' } });
  });
  await page.route(/\/api\/activity(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [compact], nextCursor: null } }),
  );
  await page.route(`**/api/generations/${job.id}`, (route) => {
    detailReads++;
    return route.fulfill({ json: job });
  });
  await page.route('**/api/balance', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { availableMicros: 9600000, reservedMicros: 0 } }),
    }),
  );
  await page.route('**/api/ledger', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'entry-1',
            job_id: job.id,
            kind: 'settle',
            amount_micros: '400000',
            created_at: job.updatedAt,
          },
        ],
      }),
    }),
  );
  await page.goto('/dashboard');
  await expect(page.locator('.workspace-stats')).toContainText('$9.60');
  await expect(
    page.getByRole('region', { name: 'Private activity', exact: true }).getByRole('table'),
  ).toContainText('alibaba/wan-3.0');
  expect(listReads).toBe(0);
  expect(detailReads).toBe(0);
  expect(JSON.stringify(compact)).not.toContain(job.input.input.prompt);
  await page.getByRole('button', { name: `View generation ${job.id}` }).click();
  await expect(page.locator('.workspace-job-detail')).toContainText(job.routeId);
  await expect(page.locator('.workspace-job-detail')).toContainText(job.input.input.prompt);
  expect(detailReads).toBe(1);
  expect(listReads).toBe(0);
  await page.getByRole('tab', { name: 'Usage ledger' }).click();
  await expect(page.locator('.workspace-table')).toContainText('settle');
  await expect(page.locator('.workspace-table')).toContainText('$0.40');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('workspace creates a scoped key and keeps the one-time token out of browser storage', async ({
  page,
}) => {
  const token = `og_sk_${'a'.repeat(64)}`;
  let input: Record<string, unknown> | undefined;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(session()),
    }),
  );
  await emptyActivity(page);
  await page.route('**/api/balance', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { availableMicros: 0, reservedMicros: 0 } }),
    }),
  );
  await page.route('**/api/ledger', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/policies', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.route('**/api/keys', async (route) => {
    if (route.request().method() === 'POST') {
      input = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        status: 201,
        body: JSON.stringify({ id: 'key-1', name: 'Test agent', token }),
      });
    } else
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) });
  });
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Key name', { exact: true }).fill('Test agent');
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  await expect(page.locator('.new-key-notice')).toContainText(token);
  expect(input).toMatchObject({ name: 'Test agent', scopes: ['read', 'generate'] });
  expect(Date.parse(String(input?.expiresAt))).toBeGreaterThan(Date.now() + 29 * 86400000);
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
  expect(storage).not.toContain(token);
  await page.getByRole('button', { name: 'I’ve saved this key', exact: true }).click();
  await expect(page.locator('.new-key-notice')).toHaveCount(0);
});

test('private uploads submit stable owned asset keys and restore them after reload', async ({
  page,
}) => {
  const key = 'inputs/test/00000000-0000-4000-8000-000000000001.png';
  const file = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDUYAAAAASUVORK5CYII=',
    'base64',
  );
  let input: Record<string, unknown> | undefined;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(session('test', ['read', 'generate'])),
    }),
  );
  await page.route('**/api/assets', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        uploadUrl: 'https://upload.example.test/reference',
        headers: { 'Content-Type': 'image/png', 'If-None-Match': '*' },
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      }),
    }),
  );
  await page.route('https://upload.example.test/reference', (route) => {
    expect(route.request().headers()['authorization']).toBeUndefined();
    expect(route.request().headers()['x-opengen-recovery-scope']).toBeUndefined();
    if (route.request().method() === 'PUT') expect(route.request().postDataBuffer()).toEqual(file);
    return route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'PUT,OPTIONS',
        'access-control-allow-headers': 'Content-Type,If-None-Match',
      },
      body: '',
    });
  });
  await page.route('**/api/assets/complete', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        assetKey: key,
        state: 'ready',
        mediaType: 'image/png',
        byteLength: file.length,
        sha256: createHash('sha256').update(file).digest('hex'),
        expiresAt: null,
        deletionPending: false,
      }),
    }),
  );
  await page.route('**/api/quotes', (route) => {
    input = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ candidates: [], notices: [] }),
    });
  });
  await page.goto('/playground?model=alibaba%2Fwan-3.0');
  await expect(page.locator('.gateway-connected')).toContainText('test');
  await page
    .getByRole('combobox', { name: 'Operation', exact: true })
    .selectOption('image-to-video');
  await expect(page.getByLabel('Upload first frame image', { exact: true })).toBeEnabled();
  await page.getByLabel('Upload first frame image', { exact: true }).setInputFiles({
    name: 'boat.png',
    mimeType: 'image/png',
    buffer: file,
  });
  await expect(page.getByLabel('First frame owned input key', { exact: true })).toHaveValue(key);
  await page
    .getByRole('textbox', { name: 'Prompt', exact: true })
    .fill('A paper boat floating slowly.');
  await page.getByRole('button', { name: 'Get a quote', exact: true }).click();
  await expect
    .poll(() => (input?.input as Record<string, unknown> | undefined)?.firstFrame)
    .toEqual({ assetKey: key });
  expect(input?.referenceAssetKeys).toBeUndefined();
  expect(input?.referenceUrls).toBeUndefined();
  await page.reload();
  await expect(page.locator('.gateway-connected')).toContainText('test');
  await page
    .getByRole('combobox', { name: 'Operation', exact: true })
    .selectOption('image-to-video');
  await expect(page.getByLabel('First frame owned input key', { exact: true })).toHaveValue(key);
  const storage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(storage).toContain(key);
  expect(storage).not.toContain('private-preview');
  expect(storage).not.toContain('https://upload.example.test/reference');
});

test('a signed-in teammate accepts an invitation and selects its workspace without exposing admin controls', async ({
  page,
}) => {
  let current = 'team-a',
    accepted = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...session(
          current,
          current === 'team-a'
            ? [
                'read',
                'generate',
                'keys:write',
                'policies:write',
                'connections:write',
                'webhooks:write',
                'members:write',
              ]
            : ['read', 'generate'],
        ),
        scopes:
          current === 'team-a'
            ? [
                'read',
                'generate',
                'keys:write',
                'policies:write',
                'connections:write',
                'webhooks:write',
                'members:write',
              ]
            : ['read', 'generate'],
        identity: { issuer: 'https://identity.example', subject: 'owner-subject' },
        canSwitchWorkspace: true,
        role: current === 'team-a' ? 'admin' : 'member',
        oidcEnabled: true,
      }),
    }),
  );
  await page.route('**/api/session/workspace', async (route) => {
    const input = route.request().postDataJSON();
    expect(input).toEqual({ workspaceId: 'team-b' });
    current = input.workspaceId;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        ...session(current, ['read', 'generate']),
        canSwitchWorkspace: true,
        oidcEnabled: true,
      }),
    });
  });
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: 'team-a',
            name: 'Original studio',
            role: 'admin',
            accepted_at: '2026-11-02T00:00:00Z',
          },
          {
            id: 'team-b',
            name: 'Guest studio',
            role: 'member',
            accepted_at: accepted ? '2026-11-02T00:00:00Z' : null,
          },
        ],
      }),
    }),
  );
  await page.route('**/api/workspaces/team-b/accept-invite', async (route) => {
    accepted = true;
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await emptyActivity(page);
  for (const path of ['ledger', 'keys', 'policies', 'members'])
    await page.route(`**/api/${path}`, (route) =>
      route.fulfill({ contentType: 'application/json', body: '{"data":[]}' }),
    );
  await page.route('**/api/balance', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: '{"availableMicros":0,"reservedMicros":0}',
    }),
  );
  await page.goto('/dashboard');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Invitation to Guest studio', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(
    page.getByText('Invitation accepted. Select the workspace above to continue.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Selected workspace', exact: true })
    .selectOption('team-b');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expect(page.locator('.gateway-connected')).toContainText('team-b');
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByText(
      'Your workspace administrator manages keys, routing profiles and provider connections.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite teammate', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(0);
});
