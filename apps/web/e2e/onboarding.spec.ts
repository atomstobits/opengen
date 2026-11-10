import { expect, test, type Page, type Request } from '@playwright/test';

const session = {
  authenticated: true,
  workspaceId: 'studio-a',
  membershipId: '00000000-0000-4000-8000-000000000201',
  recoveryScope: 'a'.repeat(64),
  scopes: ['read', 'generate', 'keys:write'],
  canSwitchWorkspace: true,
  role: 'admin',
  oidcEnabled: true,
};
async function fixture(page: Page, current: Record<string, unknown> = session) {
  await page.route('**/api/session', (route) => route.fulfill({ json: current }));
  await page.route(/\/api\/activity(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await page.route('**/api/generations', (route) =>
    route.fulfill({
      status: 405,
      json: { error: 'Use compact activity and explicit job detail.' },
    }),
  );
  for (const path of [
    'ledger',
    'policies',
    'keys',
    'workspaces',
    'governance/keys',
    'governance/policies',
  ])
    await page.route(`**/api/${path}`, (route) => route.fulfill({ json: { data: [] } }));
  await page.route('**/api/governance/policies?*', (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  await page.route('**/api/catalog', (route) =>
    route.fulfill({ json: { models: [], providers: [] } }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 0, reservedMicros: 0 } }),
  );
}

test('sign-in creates an account through configured identity, with self-hosted access collapsed', async ({
  page,
}) => {
  await fixture(page, { authenticated: false, oidcEnabled: true });
  await page.goto('/start');
  await expect(
    page.getByRole('link', { name: 'Sign in or create account', exact: true }),
  ).toHaveAttribute('href', '/auth/login');
  await expect(page.getByText(/First sign-in creates your account/)).toBeVisible();
  await expect(page.getByLabel('Workspace API key', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('link', { name: 'Create in browser ↗', exact: true })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('unconfigured identity is honest and gateway outage offers recovery', async ({ page }) => {
  await fixture(page, { authenticated: false, oidcEnabled: false });
  await page.goto('/start');
  await expect(page.getByText(/Account sign-in is not configured/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in or create account' })).toHaveCount(0);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'OpenGen account' }).getByRole('alert'),
  ).toContainText('Sign-in is temporarily unavailable');
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { authenticated: false, oidcEnabled: true } }),
  );
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in or create account' })).toBeVisible();
});

test('first use exposes agent, CLI/API, browser, selected workspace and honest zero credit', async ({
  page,
}) => {
  await fixture(page);
  await page.goto('/dashboard');
  const steps = page.getByRole('region', { name: 'Make yourself at home.' });
  await expect(steps).toContainText('Selected workspace: studio-a');
  await expect(steps.getByRole('link', { name: /Connect your agent/ })).toHaveAttribute(
    'href',
    '/agents',
  );
  await expect(steps.getByRole('link', { name: /Build your workflow/ })).toHaveAttribute(
    'href',
    '/agents/cli',
  );
  await expect(steps.getByRole('link', { name: /Create in browser/ })).toHaveAttribute(
    'href',
    '/playground',
  );
  await expect(steps).toContainText('$0 managed credit');
  await expect(steps.getByRole('link', { name: /Credit & billing/ })).toHaveAttribute(
    'href',
    '/billing',
  );
});

test('scoped keys expire explicitly, appear once, revoke and stay out of browser storage', async ({
  page,
}) => {
  await fixture(page);
  const token = `og_sk_${'f'.repeat(64)}`;
  let input: Record<string, unknown> | undefined,
    revoked = false,
    created = false;
  await page.route('**/api/keys', async (route) => {
    if (route.request().method() === 'POST') {
      input = route.request().postDataJSON();
      created = true;
      await route.fulfill({ status: 201, json: { id: 'key-1', name: 'Studio agent', token } });
    } else
      await route.fulfill({
        json: {
          data: created
            ? [
                {
                  id: 'key-1',
                  name: 'Studio agent',
                  scopes: ['read', 'generate'],
                  expires_at: input?.expiresAt,
                  revoked_at: revoked ? new Date().toISOString() : null,
                },
              ]
            : [],
        },
      });
  });
  await page.route('**/api/keys/key-1', async (route) => {
    revoked = true;
    await route.fulfill({ json: {} });
  });
  await page.goto('/dashboard#keys');
  await expect(page.getByRole('tab', { name: 'API keys', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('combobox', { name: 'Key expiry', exact: true })).toHaveValue('30');
  await page.getByLabel('Key name', { exact: true }).fill('Studio agent');
  const before = Date.now();
  await page.getByRole('button', { name: 'Create API key', exact: true }).click();
  await expect(page.locator('.new-key-notice')).toContainText(token);
  await expect(page.locator('.new-key-notice')).toContainText('studio-a');
  await page.getByRole('button', { name: 'API keys', exact: true }).click();
  await expect(page.locator('.new-key-notice')).toContainText(token);
  expect(input?.scopes).toEqual(['read', 'generate']);
  expect(Date.parse(String(input?.expiresAt))).toBeGreaterThan(before + 29 * 86400000);
  expect(
    await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage })),
  ).not.toContain(token);
  await page.getByRole('button', { name: 'I’ve saved this key', exact: true }).click();
  await expect(page.locator('.new-key-notice')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(token)).toHaveCount(0);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Key revoked' })).toBeVisible();
  expect(revoked).toBe(true);
});

test('member gets no key administration and signout removes private workspace UI', async ({
  page,
}) => {
  await fixture(page, { ...session, role: 'member', scopes: ['read', 'generate'] });
  await page.goto('/dashboard#keys');
  await expect(page.getByText(/Your workspace administrator manages API keys/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(0);
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: { authenticated: false, oidcEnabled: true } }),
  );
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in or create account' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'API keys', exact: true })).toHaveCount(0);
});

test('connected app authorizations can be reviewed and revoked independently of keys', async ({
  page,
}) => {
  await fixture(page);
  let revoked = false;
  await page.route('**/api/oauth/grants', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'grant-1',
            client_name: 'Studio desktop',
            scopes: ['read', 'generate'],
            created_at: new Date().toISOString(),
            expires_at: '2026-12-03T00:00:00Z',
            revoked_at: revoked ? new Date().toISOString() : null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/oauth/grants/grant-1', async (route) => {
    expect(route.request().method()).toBe('DELETE');
    revoked = true;
    await route.fulfill({ json: {} });
  });
  await page.goto('/dashboard#apps');
  await expect(page.getByRole('region', { name: 'Connected apps' })).toContainText(
    'Studio desktop',
  );
  await page.getByRole('button', { name: 'Revoke Studio desktop', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'App authorization revoked' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Revoke Studio desktop', exact: true }),
  ).toHaveCount(0);
});

test('consent can be denied without approving billable permissions', async ({ page, baseURL }) => {
  const callbackOrigin = new URL(baseURL!).origin;
  const requestId = `og_req_${'r'.repeat(43)}`;
  let decision: Record<string, unknown> | undefined;
  await page.route('**/api/oauth/consent**', async (route) => {
    if (route.request().method() === 'POST') {
      decision = route.request().postDataJSON();
      await route.fulfill({
        json: { redirectTo: `${callbackOrigin}/agents?error=access_denied` },
      });
    } else
      await route.fulfill({
        json: {
          client: {
            id: 'fixture',
            name: 'Fixture client',
            redirectOrigin: callbackOrigin,
          },
          requestedScopes: ['read', 'generate'],
          availableScopes: ['read', 'generate'],
          workspaces: [{ id: 'studio-a', name: 'Studio A', role: 'admin' }],
          resource: 'https://opengen.example/mcp',
        },
      });
  });
  await page.goto(`/oauth/consent?request=${requestId}`);
  await expect(page.getByRole('button', { name: 'Authorize client', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await expect.poll(() => decision?.approve).toBe(false);
  expect(decision?.workspaceId).toBe('studio-a');
  await expect(page).toHaveURL(/error=access_denied/);
});

test('dedicated agent setup and evidence remain usable on this viewport', async ({
  page,
}, testInfo) => {
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Where do you want to create?' })).toBeVisible();
  await expect(page.getByRole('table')).toContainText('None recorded');
  await page.goto('/agents/cli');
  await expect(page.getByRole('heading', { name: 'Create with CLI & API.' })).toBeVisible();
  await expect(
    page.getByText('No deployed identity-provider test.', { exact: false }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('agent-setup.png'), fullPage: true });
  await page.goto('/agents/cursor');
  await page.getByText('Preview a project configuration change', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Copy preview command', exact: true }),
  ).toBeVisible();
  const previewCommand = await page.locator('details pre').textContent();
  expect(previewCommand).toContain('opengen bind preview --client cursor');
  expect(previewCommand).not.toContain(String.fromCharCode(92) + 'n');
});

test('accepted invitations switch the selected workspace and preserve member boundaries', async ({
  page,
}) => {
  await fixture(page);
  let current = 'studio-a',
    accepted = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        ...session,
        workspaceId: current,
        membershipId:
          current === 'studio-a'
            ? '00000000-0000-4000-8000-000000000201'
            : '00000000-0000-4000-8000-000000000202',
        recoveryScope: (current === 'studio-a' ? 'a' : 'b').repeat(64),
        scopes: current === 'studio-a' ? session.scopes : ['read', 'generate'],
        role: current === 'studio-a' ? 'admin' : 'member',
      },
    }),
  );
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'studio-a',
            name: 'Personal studio',
            role: 'admin',
            accepted_at: '2026-11-03T00:00:00Z',
          },
          {
            id: 'studio-b',
            name: 'Guest studio',
            role: 'member',
            accepted_at: accepted ? '2026-11-03T00:00:00Z' : null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/workspaces/studio-b/accept-invite', async (route) => {
    accepted = true;
    await route.fulfill({ json: {} });
  });
  await page.route('**/api/session/workspace', async (route) => {
    const input = route.request().postDataJSON();
    expect(input).toEqual({ workspaceId: 'studio-b' });
    current = input.workspaceId;
    await route.fulfill({
      json: {
        authenticated: true,
        workspaceId: current,
        membershipId: '00000000-0000-4000-8000-000000000202',
        recoveryScope: 'b'.repeat(64),
        scopes: ['read', 'generate'],
        role: 'member',
        oidcEnabled: true,
        canSwitchWorkspace: true,
      },
    });
  });
  await page.goto('/dashboard#settings');
  await expect(page.getByText('Invitation to Guest studio', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(
    page.getByText('Invitation accepted. Select the workspace above to continue.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Selected workspace', exact: true })
    .selectOption('studio-b');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expect(page.locator('.gateway-connected')).toContainText('studio-b');
  await expect(
    page.getByText(
      'Your workspace administrator manages keys, routing profiles and provider connections.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('returning users see canonical generation history and can resume review', async ({ page }) => {
  await fixture(page);
  const id = '00000000-0000-4000-8000-000000000301';
  const job = {
    id,
    workspaceId: session.workspaceId,
    status: 'succeeded',
    input: {
      modelId: 'studio/model',
      operation: 'text-to-video',
      input: { prompt: 'An origami boat on still water.' },
    },
    routeId: 'studio/route',
    deploymentId: 'studio/deployment',
    upstreamId: null,
    error: null,
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:01:00Z',
    reservedMicros: 100000,
    settledMicros: 100000,
    attemptCount: 1,
    outputs: [],
    deliveryStatus: 'failed',
  };
  const compact = {
    id,
    modelId: job.input.modelId,
    operation: job.input.operation,
    routeId: job.routeId,
    deploymentId: job.deploymentId,
    providerId: 'studio',
    endpointRegion: 'fixture-region',
    status: job.status,
    deliveryStatus: job.deliveryStatus,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    reservedMicros: 100000,
    ledgerReservedMicros: 100000,
    settledMicros: 100000,
    heldMicros: 0,
    accountingState: 'reconciled',
    attribution: null,
    project: null,
  };
  let listReads = 0,
    detailReads = 0;
  await page.route('**/api/generations', (route) => {
    listReads++;
    return route.fulfill({ status: 405, json: { error: 'Full job lists are not Activity.' } });
  });
  await page.route(/\/api\/activity(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [compact], nextCursor: null } }),
  );
  await page.route(`**/api/generations/${id}`, (route) => {
    detailReads++;
    return route.fulfill({ json: job });
  });
  await page.goto('/dashboard');
  const activity = page.getByRole('region', { name: 'Private activity', exact: true });
  await expect(activity.getByRole('table')).toContainText('studio/model');
  await expect(page.getByRole('region', { name: 'Make yourself at home.' })).toHaveCount(0);
  expect(JSON.stringify(compact)).not.toContain(job.input.input.prompt);
  expect(listReads).toBe(0);
  expect(detailReads).toBe(0);
  await page.getByRole('button', { name: `View generation ${id}`, exact: true }).click();
  await expect(page.locator('.workspace-job-detail')).toContainText(job.input.input.prompt);
  expect(detailReads).toBe(1);
  expect(listReads).toBe(0);
});

test('a key administrator without read permission can still list and revoke keys', async ({
  page,
}) => {
  await fixture(page, { ...session, scopes: ['keys:write'] });
  let revoked = false;
  await page.route('**/api/policies', (route) =>
    route.fulfill({ status: 403, json: { error: 'read required' } }),
  );
  await page.route('**/api/keys', (route) =>
    route.fulfill({
      json: {
        data: [
          {
            id: 'existing-key',
            name: 'Existing automation',
            scopes: ['read'],
            expires_at: '2026-12-01T00:00:00Z',
            revoked_at: revoked ? new Date().toISOString() : null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/keys/existing-key', async (route) => {
    revoked = true;
    await route.fulfill({ json: {} });
  });
  await page.goto('/dashboard#keys');
  await expect(page.getByText('Existing automation', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect.poll(() => revoked).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Key revoked' })).toBeVisible();
});

test('a stale session retry cannot reconnect after successful sign-out', async ({ page }) => {
  await fixture(page);
  let deletes = 0,
    holdGet = false,
    authenticated = true;
  let heldRequest: Request | undefined;
  let release: (() => Promise<void>) | undefined;
  await page.route('**/api/session', async (route) => {
    if (route.request().method() === 'DELETE') {
      deletes++;
      if (deletes > 1) authenticated = false;
      await route.fulfill({
        status: deletes === 1 ? 503 : 200,
        json: deletes === 1 ? { error: 'retry' } : { authenticated: false, oidcEnabled: true },
      });
      return;
    }
    const snapshot = authenticated ? session : { authenticated: false, oidcEnabled: true };
    if (holdGet && authenticated && !release) {
      heldRequest = route.request();
      let released = false;
      release = async () => {
        if (released) return;
        released = true;
        try {
          await route.fulfill({ json: snapshot });
        } catch (error) {
          if (!heldRequest?.failure() && !page.isClosed()) throw error;
        }
      };
    } else await route.fulfill({ json: snapshot });
  });
  try {
    await page.goto('/dashboard');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('region', { name: 'OpenGen account' })).toContainText(
      'Sign-out could not be completed',
    );
    holdGet = true;
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await expect.poll(() => Boolean(release)).toBe(true);
    // Signing out must remain possible while an authority check is delayed.
    const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
    await expect(signOut).toBeEnabled();
    const retried = heldRequest!.response();
    await signOut.click();
    await expect(
      page.getByRole('link', { name: 'Sign in or create account', exact: true }),
    ).toBeVisible();
    await release!();
    const response = await retried;
    if (response) await response.finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    expect(deletes).toBe(2);
    await expect(page.locator('.gateway-connected')).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Sign in or create account', exact: true }),
    ).toBeVisible();
  } finally {
    await release?.();
  }
});
