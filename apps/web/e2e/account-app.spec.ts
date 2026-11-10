import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { ActivityItem } from '../app/dashboard/activity-view';
import type { Job, KeyScope } from '@media-router/contracts';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const evidenceDir = path.resolve(import.meta.dirname, '../../..', 'docs/evidence/account-app');

const adminScopes: KeyScope[] = [
  'read',
  'generate',
  'keys:write',
  'policies:write',
  'connections:write',
  'webhooks:write',
  'members:write',
];
const studioJobs: Record<string, Job> = {
  'studio-a': {
    id: '00000000-0000-4000-8000-000000000101',
    workspaceId: 'studio-a',
    status: 'succeeded',
    input: {
      modelId: 'alibaba/wan-3.0',
      operation: 'text-to-video',
      input: { prompt: 'A paper boat in the original studio.' },
    },
    routeId: 'alibaba/ap-southeast-1/wan-3.0',
    deploymentId: 'alibaba/ap-southeast-1',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-03T12:00:00Z',
    updatedAt: '2026-11-03T12:01:00Z',
    reservedMicros: 500000,
    settledMicros: 400000,
    attemptCount: 1,
  },
  'studio-b': {
    id: '00000000-0000-4000-8000-000000000102',
    workspaceId: 'studio-b',
    status: 'succeeded',
    input: {
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A red kite in the guest studio.' },
    },
    routeId: 'fal-undisclosed/fal-h3-max',
    deploymentId: 'fal-undisclosed',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-03T13:00:00Z',
    updatedAt: '2026-11-03T13:01:00Z',
    reservedMicros: 400000,
    settledMicros: 300000,
    attemptCount: 1,
  },
};

function compactActivity(job: Job): ActivityItem {
  return {
    id: job.id,
    modelId: job.input.modelId,
    operation: job.input.operation,
    providerId: job.workspaceId === 'studio-a' ? 'alibaba' : 'fal',
    endpointRegion: job.workspaceId === 'studio-a' ? 'ap-southeast-1' : 'undisclosed',
    routeId: job.routeId,
    deploymentId: job.deploymentId,
    status: job.status,
    deliveryStatus: job.deliveryStatus ?? 'failed',
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    reservedMicros: job.reservedMicros,
    ledgerReservedMicros: job.reservedMicros,
    settledMicros: job.settledMicros,
    heldMicros: job.settledMicros === null ? job.reservedMicros : 0,
    accountingState: 'reconciled',
    attribution: null,
    project: null,
  };
}

async function accountFixture(page: Page) {
  const state = {
    authenticated: true,
    workspaceId: 'studio-a',
    scopes: undefined as KeyScope[] | undefined,
    accepted: false,
    requests: [] as { method: string; path: string; workspaceId: string }[],
    switches: [] as string[],
    unexpected: [] as string[],
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname,
      method = request.method(),
      workspaceId = state.workspaceId;
    state.requests.push({ method, path, workspaceId });
    const scopes =
      state.scopes ?? (workspaceId === 'studio-a' ? adminScopes : ['read', 'generate']);
    const membershipId =
      workspaceId === 'studio-a'
        ? '00000000-0000-4000-8000-000000000201'
        : '00000000-0000-4000-8000-000000000202';
    const recoveryScope = createHash('sha256')
      .update(JSON.stringify([workspaceId, membershipId, [...scopes].sort()]))
      .digest('hex');
    if (path === '/api/session') {
      if (method === 'DELETE') state.authenticated = false;
      else if (method !== 'GET') {
        state.unexpected.push(`${method} ${path}`);
        await route.fulfill({ status: 405, json: { error: 'Unexpected session mutation.' } });
        return;
      }
      await route.fulfill({
        json: state.authenticated
          ? {
              authenticated: true,
              workspaceId,
              scopes,
              membershipId,
              recoveryScope,
              oidcEnabled: true,
              canSwitchWorkspace: true,
              role: workspaceId === 'studio-a' ? 'admin' : 'member',
              identity: { issuer: 'https://identity.example', subject: 'fixture-owner' },
            }
          : { authenticated: false, oidcEnabled: true },
      });
      return;
    }
    if (!state.authenticated) {
      await route.fulfill({ status: 401, json: { error: 'Sign-in required.' } });
      return;
    }
    if (method === 'GET' && path === '/api/workspaces') {
      await route.fulfill({
        json: {
          data: [
            {
              id: 'studio-a',
              name: 'Original studio',
              role: 'admin',
              accepted_at: '2026-11-03T00:00:00Z',
            },
            {
              id: 'studio-b',
              name: 'Guest studio',
              role: 'member',
              accepted_at: state.accepted ? '2026-11-03T00:00:00Z' : null,
            },
          ],
        },
      });
      return;
    }
    if (method === 'POST' && path === '/api/workspaces/studio-b/accept-invite') {
      expect(request.postDataJSON()).toEqual({});
      state.accepted = true;
      await route.fulfill({ json: {} });
      return;
    }
    if (method === 'POST' && path === '/api/session/workspace') {
      expect(request.postDataJSON()).toEqual({ workspaceId: 'studio-b' });
      expect(state.accepted).toBe(true);
      state.workspaceId = 'studio-b';
      state.switches.push(state.workspaceId);
      await route.fulfill({
        json: {
          authenticated: true,
          workspaceId: state.workspaceId,
          scopes: ['read', 'generate'],
          membershipId: '00000000-0000-4000-8000-000000000202',
          recoveryScope: createHash('sha256')
            .update(
              JSON.stringify([
                state.workspaceId,
                '00000000-0000-4000-8000-000000000202',
                ['generate', 'read'],
              ]),
            )
            .digest('hex'),
        },
      });
      return;
    }
    if (method === 'GET' && ['/api/activity', '/api/balance', '/api/ledger'].includes(path)) {
      if (!scopes.includes('read')) {
        await route.fulfill({ status: 403, json: { error: 'Read permission required.' } });
        return;
      }
      const job = studioJobs[workspaceId]!;
      if (path === '/api/activity') {
        const row = compactActivity(job);
        expect(JSON.stringify(row)).not.toContain(job.input.input.prompt!);
        await route.fulfill({ json: { items: [row], nextCursor: null } });
      } else
        await route.fulfill({
          json: {
            data:
              path === '/api/balance'
                ? {
                    availableMicros: workspaceId === 'studio-a' ? 9600000 : 1700000,
                    reservedMicros: 0,
                  }
                : [
                    {
                      id: 'fixture-ledger-' + workspaceId,
                      job_id: job.id,
                      kind: 'settle',
                      amount_micros: String(job.settledMicros),
                      created_at: job.updatedAt,
                    },
                  ],
          },
        });
      return;
    }
    if (method === 'GET' && path.startsWith('/api/generations/')) {
      if (!scopes.includes('read')) {
        await route.fulfill({ status: 403, json: { error: 'Read permission required.' } });
        return;
      }
      const job = studioJobs[workspaceId]!;
      await route.fulfill(
        path === `/api/generations/${job.id}`
          ? { json: job }
          : { status: 404, json: { error: 'Generation not found.' } },
      );
      return;
    }
    if (
      method === 'GET' &&
      ['/api/webhooks', '/api/webhook-deliveries', '/api/alerts', '/api/alerts/settings'].includes(
        path,
      )
    ) {
      if (!scopes.includes('webhooks:write')) {
        state.unexpected.push(`${method} ${path} in ${workspaceId}`);
        await route.fulfill({
          status: 403,
          json: { error: 'Administration permission required.' },
        });
      } else
        await route.fulfill({
          json:
            path === '/api/alerts/settings'
              ? {
                  enabled: false,
                  low_balance_micros: null,
                  spending_limit_micros: null,
                  key_expiry_hours: null,
                  webhook_failures: false,
                }
              : { data: [] },
        });
      return;
    }
    if (
      method === 'GET' &&
      ['/api/notifications', '/api/notifications/preferences'].includes(path)
    ) {
      if (!scopes.includes('read')) {
        await route.fulfill({ status: 403, json: { error: 'Read permission required.' } });
        return;
      }
      await route.fulfill({
        json:
          path === '/api/notifications'
            ? { items: [], nextCursor: null }
            : {
                inApp: true,
                eventTypes: ['alert.triggered', 'alert.resolved'],
                email: false,
                emailAvailable: false,
              },
      });
      return;
    }
    if (
      method === 'GET' &&
      [
        '/api/members',
        '/api/keys',
        '/api/policies',
        '/api/connections',
        '/api/oauth/grants',
      ].includes(path)
    ) {
      const permission =
        path === '/api/members' ? 'members:write' : path === '/api/keys' ? 'keys:write' : 'read';
      if (!scopes.includes(permission)) {
        state.unexpected.push(`${method} ${path} in ${workspaceId}`);
        await route.fulfill({ status: 403, json: { error: 'Permission required.' } });
      } else await route.fulfill({ json: { data: [] } });
      return;
    }
    state.unexpected.push(`${method} ${path}`);
    await route.fulfill({
      status: 405,
      json: { error: 'Unexpected API request in account-page fixture.' },
    });
  });
  return state;
}

test('account entry gates avoid private reads before sign-in or without read permission', async ({
  page,
}) => {
  const state = await accountFixture(page);
  state.authenticated = false;
  for (const hash of ['activity', 'team']) {
    await page.goto('/app#' + hash);
    await expect(
      page.getByRole('link', { name: 'Sign in or create account', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /View generation/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite teammate', exact: true })).toHaveCount(0);
  }
  expect(state.requests.filter(({ path }) => path !== '/api/session')).toEqual([]);

  state.authenticated = true;
  state.scopes = ['keys:write'];
  await page.goto('/app#activity');
  // A hash-only navigation preserves the guest document; reload after changing fixture identity.
  await page.reload();
  await expect(
    page.getByText(/Your workspace permissions do not include activity access/),
  ).toBeVisible();
  expect(
    state.requests.filter(({ path }) =>
      ['/api/activity', '/api/generations', '/api/balance', '/api/ledger'].includes(path),
    ),
  ).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`account navigation preserves routes, workspace and activity at ${width}px`, async ({
    page,
  }) => {
    const state = await accountFixture(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/app');
    const navigation = page.getByRole('navigation', { name: 'Account navigation', exact: true });
    await expect(navigation).toBeVisible();
    for (const [name, hash] of [
      ['Start', 'start'],
      ['Activity', 'activity'],
      ['Team', 'team'],
    ])
      await expect(navigation.getByRole('link', { name, exact: true })).toHaveAttribute(
        'href',
        '/app#' + hash,
      );
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.workspace-stats')).toContainText('$9.60');
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, `start-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });

    await navigation.getByRole('link', { name: 'Activity', exact: true }).click();
    await expect(page).toHaveURL(/\/app#activity$/);
    await expect(
      page.getByRole('region', { name: 'Private activity', exact: true }).getByRole('table'),
    ).toContainText('alibaba/wan-3.0');
    await expect(page.locator('.workspace-job-detail')).toHaveCount(0);
    await page.screenshot({
      path: path.join(evidenceDir, `activity-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    expect(
      state.requests.filter(
        ({ path }) => path === '/api/generations' || path.startsWith('/api/generations/'),
      ),
    ).toEqual([]);
    await page
      .getByRole('button', { name: `View generation ${studioJobs['studio-a']!.id}`, exact: true })
      .click();
    await expect(page.locator('.workspace-job-detail')).toContainText(
      studioJobs['studio-a']!.routeId,
    );
    await expect(page.locator('.workspace-job-detail')).toContainText(
      studioJobs['studio-a']!.input.input.prompt!,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.reload();
    await expect(page).toHaveURL(/\/app#activity$/);
    await expect(
      page.getByRole('region', { name: 'Private activity', exact: true }).getByRole('table'),
    ).toContainText('alibaba/wan-3.0');

    await navigation.getByRole('link', { name: 'Team', exact: true }).click();
    await expect(page).toHaveURL(/\/app#team$/);
    await expect(page.getByRole('heading', { name: 'Workspaces', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Invite teammate', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.screenshot({
      path: path.join(evidenceDir, `team-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await navigation.getByRole('link', { name: 'Start', exact: true }).click();
    await expect(page).toHaveURL(/\/app#start$/);
    await expect(page.locator('main').getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(state.requests.filter(({ path }) => path === '/api/generations')).toEqual([]);
    expect(state.workspaceId).toBe('studio-a');
    expect(state.switches).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

test('team invitation acceptance and switching clear the previous workspace and admin controls', async ({
  page,
}) => {
  const state = await accountFixture(page);
  await page.goto('/app#activity');
  await expect(
    page.getByRole('button', {
      name: `View generation ${studioJobs['studio-a']!.id}`,
      exact: true,
    }),
  ).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Account navigation', exact: true });
  await navigation.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page.getByText('Invitation to Guest studio', { exact: true })).toBeVisible();
  const workspace = page.getByRole('combobox', { name: 'Selected workspace', exact: true });
  await expect(workspace).toHaveValue('studio-a');
  await expect(workspace.locator('option[value="studio-b"]')).toHaveCount(0);
  expect(state.accepted).toBe(false);
  expect(state.switches).toEqual([]);

  await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
  await expect(workspace.locator('option[value="studio-b"]')).toHaveCount(1);
  expect(state.accepted).toBe(true);
  expect(state.switches).toEqual([]);
  await workspace.selectOption('studio-b');
  await page.getByRole('button', { name: 'Switch workspace', exact: true }).click();
  await expect(page).toHaveURL(/\/app#team$/);
  await expect(page.locator('.gateway-connected')).toContainText('studio-b');
  await expect(page.getByRole('button', { name: 'Invite teammate', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create API key', exact: true })).toHaveCount(0);
  await navigation.getByRole('link', { name: 'Activity', exact: true }).click();
  await expect(
    page.getByRole('button', {
      name: `View generation ${studioJobs['studio-b']!.id}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: `View generation ${studioJobs['studio-a']!.id}`,
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Private activity', exact: true }).getByRole('table'),
  ).not.toContainText('alibaba/wan-3.0');
  await expect(page.locator('.workspace-stats')).toContainText('$1.70');
  expect(state.switches).toEqual(['studio-b']);
  expect(
    state.requests.filter(
      ({ workspaceId, path }) =>
        workspaceId === 'studio-b' &&
        ['/api/members', '/api/keys', '/api/policies', '/api/connections'].includes(path),
    ),
  ).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
