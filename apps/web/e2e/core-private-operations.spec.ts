import { createHash } from 'node:crypto';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import type { KeyScope, RoutingPolicy } from '@media-router/contracts';

const keyId = '10000000-0000-4000-8000-000000000001';
const profileId = '10000000-0000-4000-8000-000000000002';
const webhookId = '10000000-0000-4000-8000-000000000003';
const notificationId = '10000000-0000-4000-8000-000000000004';
const grantId = '10000000-0000-4000-8000-000000000005';
const createdAt = '2026-11-04T12:00:00.000Z';
const adminScopes: KeyScope[] = [
  'read',
  'generate',
  'keys:write',
  'policies:write',
  'connections:write',
  'members:write',
  'webhooks:write',
];
type Actor = 'owner' | 'other-workspace' | 'other-member' | 'other-admin';
type Preferences = { inApp: boolean; eventTypes: string[]; email: false; emailAvailable: false };
type Subscription = {
  id: string;
  name: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  created_at: string;
};
const regional: RoutingPolicy = {
  modelIds: ['alibaba/wan-3.0'],
  providerIds: ['alibaba'],
  modelProviderExceptions: [{ modelId: 'alibaba/wan-3.0', providerIds: ['alibaba'] }],
  deploymentIds: ['alibaba/ap-southeast-1'],
  endpointRegions: ['ap-southeast-1'],
  processingRegions: ['ap-southeast-1'],
  processingScopes: ['regional'],
  fidelity: 'native',
  preference: 'cost',
  fallback: false,
  authorOnly: false,
};
const keySecret = (attempt: number) => `og_sk_${['c', 'd', 'e'][attempt - 1]!.repeat(64)}`;
const webhookSecret = (attempt: number) => `synthetic-webhook-secret-${attempt}`;
function principal(actor: Actor) {
  const workspaceId =
    actor === 'other-workspace' || actor === 'other-admin' ? 'studio-b' : 'studio-a';
  const membershipId =
    actor === 'owner'
      ? '20000000-0000-4000-8000-000000000001'
      : actor === 'other-member'
        ? '20000000-0000-4000-8000-000000000002'
        : '20000000-0000-4000-8000-000000000003';
  const scopes: KeyScope[] =
    actor === 'owner' || actor === 'other-admin' ? [...adminScopes] : ['read', 'generate'];
  return {
    authenticated: true,
    workspaceId,
    membershipId,
    scopes,
    role: scopes.includes('keys:write') ? 'admin' : 'member',
    canSwitchWorkspace: true,
    oidcEnabled: true,
    identity: { issuer: 'https://identity.example', subject: `fixture-${actor}` },
    recoveryScope: createHash('sha256')
      .update(JSON.stringify([actor, workspaceId, membershipId, scopes]))
      .digest('hex'),
  };
}
async function fixture(page: Page) {
  const preferences = Object.fromEntries(
    (['owner', 'other-workspace', 'other-member', 'other-admin'] as Actor[]).map((actor) => [
      actor,
      {
        inApp: true,
        eventTypes: ['alert.triggered', 'alert.resolved'],
        email: false,
        emailAvailable: false,
      },
    ]),
  ) as Record<Actor, Preferences>;
  const state = {
    cookieActor: 'owner' as Actor,
    key: {
      id: keyId,
      name: 'Original render key',
      secretVersion: 1,
      policyId: profileId,
      monthlyCapMicros: 5_000_000,
      revokedAt: null,
      coverageStartedAt: '2026-11-04T00:00:00.000Z',
      admissionMonth: '2026-11-01',
      grossDebitMicros: 1_000_000,
      heldMicros: 250_000,
      legacyCoverage: 'since_cutover',
    },
    profile: {
      id: profileId,
      name: 'Regional production',
      policy: structuredClone(regional),
      maxCostMicros: 1_000_000,
      revision: 3,
      archivedAt: null as string | null,
    },
    webhooks: [] as Subscription[],
    preferences,
    readAt: {} as Partial<Record<Actor, string>>,
    rotations: [] as number[],
    webhookRotations: 0,
    writes: [] as { actor: Actor; method: string; path: string; body: unknown }[],
    requests: [] as {
      actor: Actor;
      method: string;
      path: string;
      workspace: string | undefined;
      scope: string | undefined;
    }[],
    rejected: [] as { actor: Actor; path: string; status: number }[],
    unexpected: [] as string[],
    holdPath: null as string | null,
    held: null as { request: Request; release: () => Promise<void> } | null,
  };
  const hold = async (route: Route, body: unknown) => {
    const request = route.request(),
      snapshot = structuredClone(body);
    let released = false;
    state.holdPath = null;
    state.held = {
      request,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await route.fulfill({ json: snapshot });
        } catch (error) {
          if (!request.failure() && !page.isClosed()) throw error;
        }
      },
    };
  };
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      method = request.method(),
      actor = state.cookieActor,
      p = principal(actor);
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const expected = request.headers();
    state.requests.push({
      actor,
      method,
      path,
      workspace: expected['x-opengen-workspace'],
      scope: expected['x-opengen-recovery-scope'],
    });
    if (path === '/api/session' && method === 'GET') {
      if (
        (expected['x-opengen-workspace'] !== undefined ||
          expected['x-opengen-recovery-scope'] !== undefined) &&
        (expected['x-opengen-workspace'] !== p.workspaceId ||
          expected['x-opengen-recovery-scope'] !== p.recoveryScope)
      )
        return json({ authenticated: false, oidcEnabled: true });
      return json(p);
    }
    if (path === '/api/catalog' && method === 'GET')
      return json({
        models: [{ id: 'alibaba/wan-3.0', name: 'Wan 3.0 Standard' }],
        providers: [{ id: 'alibaba', name: 'Alibaba' }],
      });
    const guarded =
      path.startsWith('/api/governance/') ||
      path.startsWith('/api/activity') ||
      path.startsWith('/api/webhooks') ||
      path === '/api/webhook-deliveries' ||
      path.startsWith('/api/alerts') ||
      path.startsWith('/api/notifications') ||
      path.startsWith('/api/keys') ||
      path.startsWith('/api/policies') ||
      path.startsWith('/api/connections') ||
      path.startsWith('/api/oauth/grants') ||
      path.startsWith('/api/members') ||
      path.startsWith('/api/workspaces') ||
      path === '/api/teams';
    if (guarded) {
      const headers = request.headers();
      if (
        headers['x-opengen-workspace'] !== p.workspaceId ||
        headers['x-opengen-recovery-scope'] !== p.recoveryScope
      ) {
        state.rejected.push({ actor, path, status: 409 });
        return json(
          {
            error: {
              code: 'browser_authority_changed',
              message:
                'Your authorized workspace or identity changed. Review the current request before submitting.',
            },
          },
          409,
        );
      }
    }
    const scope =
      path.startsWith('/api/governance/keys') || path.startsWith('/api/keys')
        ? 'keys:write'
        : path.startsWith('/api/policies/')
          ? 'policies:write'
          : path.startsWith('/api/webhooks') ||
              path === '/api/webhook-deliveries' ||
              path.startsWith('/api/alerts')
            ? 'webhooks:write'
            : path.startsWith('/api/connections')
              ? 'connections:write'
              : path.startsWith('/api/members') || path === '/api/teams'
                ? 'members:write'
                : 'read';
    if (!p.scopes.includes(scope as KeyScope)) {
      state.unexpected.push(`Forbidden ${method} ${path} for ${actor}`);
      return json({ error: { code: 'insufficient_scope', message: 'Permission required.' } }, 403);
    }
    if (method === 'GET') {
      if (path === '/api/keys')
        return json({
          data:
            actor === 'owner'
              ? [
                  {
                    id: keyId,
                    name: state.key.name,
                    scopes: ['read', 'generate'],
                    policy_id: profileId,
                    expires_at: null,
                    revoked_at: null,
                    created_at: createdAt,
                  },
                ]
              : [],
        });
      if (path === '/api/policies')
        return json({
          data:
            actor === 'owner' && !state.profile.archivedAt
              ? [
                  {
                    ...state.profile,
                    max_cost_micros: state.profile.maxCostMicros,
                    archived_at: state.profile.archivedAt,
                  },
                ]
              : [],
        });
      if (path === '/api/governance/keys') {
        const body = { data: actor === 'owner' ? [structuredClone(state.key)] : [] };
        if (state.holdPath === path) return hold(route, body);
        return json(body);
      }
      if (path === '/api/governance/policies') {
        expect([...url.searchParams.keys()]).toEqual(['includeArchived']);
        expect(['true', 'false']).toContain(url.searchParams.get('includeArchived'));
        return json({
          data:
            actor === 'owner' &&
            (!state.profile.archivedAt || url.searchParams.get('includeArchived') === 'true')
              ? [state.profile]
              : [],
        });
      }
      if (path === '/api/workspaces')
        return json({
          data: [{ id: p.workspaceId, name: p.workspaceId, role: p.role, accepted_at: createdAt }],
        });
      if (path === '/api/oauth/grants')
        return json({
          data:
            actor === 'owner'
              ? [
                  {
                    id: grantId,
                    client_name: 'Fixture editor',
                    scopes: ['read', 'generate'],
                    created_at: createdAt,
                    expires_at: '2030-01-01T00:00:00Z',
                    revoked_at: null,
                  },
                ]
              : [],
        });
      if (path === '/api/members' || path === '/api/connections') return json({ data: [] });
      if (path === '/api/activity') return json({ items: [], nextCursor: null });
      if (path === '/api/balance') return json({ availableMicros: 1_000_000, reservedMicros: 0 });
      if (path === '/api/ledger') return json({ data: [] });
      if (path === '/api/webhooks') {
        const body = { data: p.workspaceId === 'studio-a' ? structuredClone(state.webhooks) : [] };
        if (state.holdPath === path) return hold(route, body);
        return json(body);
      }
      if (path === '/api/webhook-deliveries' || path === '/api/alerts') return json({ data: [] });
      if (path === '/api/alerts/settings')
        return json({
          enabled: false,
          low_balance_micros: null,
          spending_limit_micros: null,
          key_expiry_hours: null,
          webhook_failures: false,
        });
      if (path === '/api/notifications/preferences') return json(state.preferences[actor]);
      if (path === '/api/notifications') {
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '25' });
        const prefs = state.preferences[actor];
        return json({
          items:
            p.workspaceId === 'studio-a' &&
            prefs.inApp &&
            prefs.eventTypes.includes('alert.triggered')
              ? [
                  {
                    id: notificationId,
                    type: 'alert.triggered',
                    createdAt,
                    readAt: state.readAt[actor] ?? null,
                    data: {
                      kind: 'low_balance',
                      alertKey: 'balance',
                      availableMicros: 125000,
                      thresholdMicros: 250000,
                    },
                  },
                ]
              : [],
          nextCursor: null,
        });
      }
    }
    const body = request.postData()
      ? (request.postDataJSON() as Record<string, unknown>)
      : undefined;
    if (body !== undefined) expect(request.headers()['content-type']).toContain('application/json');
    if (
      p.workspaceId !== 'studio-a' &&
      (path.startsWith('/api/keys/') ||
        path.startsWith('/api/policies/') ||
        path.startsWith('/api/webhooks/') ||
        path.endsWith('/read'))
    )
      return json({ error: { code: 'not_found', message: 'Owned resource not found.' } }, 404);
    if (method === 'PATCH' && path === `/api/keys/${keyId}`) {
      expect(body).toEqual({ name: 'Studio render pipeline', monthlyCapMicros: 2_500_001 });
      state.writes.push({ actor, method, path, body });
      state.key.name = body!.name as string;
      state.key.monthlyCapMicros = body!.monthlyCapMicros as number;
      return json({
        id: keyId,
        name: state.key.name,
        monthlyCapMicros: state.key.monthlyCapMicros,
      });
    }
    if (method === 'POST' && path === `/api/keys/${keyId}/rotate`) {
      expect(body).toEqual({ expectedSecretVersion: state.key.secretVersion });
      state.rotations.push(body!.expectedSecretVersion as number);
      state.key.secretVersion++;
      if (state.rotations.length === 2) return route.abort('failed');
      return json({
        id: keyId,
        token: keySecret(state.rotations.length),
        secretVersion: state.key.secretVersion,
      });
    }
    if (method === 'PATCH' && path === `/api/policies/${profileId}`) {
      expect(body).toEqual({
        expectedRevision: 3,
        name: 'Regional preview',
        policy: { ...regional, authorOnly: true },
        maxCostMicros: 1_250_001,
      });
      state.writes.push({ actor, method, path, body });
      state.profile = {
        ...state.profile,
        name: body!.name as string,
        policy: body!.policy as RoutingPolicy,
        maxCostMicros: body!.maxCostMicros as number,
        revision: state.profile.revision + 1,
      };
      return json(state.profile);
    }
    if (method === 'POST' && path === `/api/policies/${profileId}/archive`) {
      expect(body).toEqual({ expectedRevision: 4 });
      state.writes.push({ actor, method, path, body });
      state.profile = { ...state.profile, revision: 5, archivedAt: createdAt };
      return json(state.profile);
    }
    if (method === 'POST' && path === '/api/webhooks') {
      expect(body).toEqual({
        name: 'Private render events',
        url: 'https://receiver.example.com/opengen/events',
        eventTypes: ['generation.completed', 'billing.settled'],
      });
      state.writes.push({ actor, method, path, body });
      const subscription = {
        id: webhookId,
        name: body!.name as string,
        url: body!.url as string,
        event_types: body!.eventTypes as string[],
        enabled: true,
        created_at: createdAt,
      };
      state.webhooks.push(subscription);
      state.webhookRotations++;
      return json({ ...subscription, secret: webhookSecret(state.webhookRotations) }, 201);
    }
    if (method === 'POST' && path === `/api/webhooks/${webhookId}/rotate-secret`) {
      expect(body).toBeUndefined();
      state.writes.push({ actor, method, path, body });
      state.webhookRotations++;
      return json({ id: webhookId, secret: webhookSecret(state.webhookRotations) });
    }
    if (method === 'PATCH' && path === `/api/webhooks/${webhookId}`) {
      expect(body).toEqual({ enabled: false });
      state.writes.push({ actor, method, path, body });
      state.webhooks[0]!.enabled = false;
      return json({ id: webhookId, enabled: false });
    }
    if (method === 'POST' && path === `/api/notifications/${notificationId}/read`) {
      expect(body).toBeUndefined();
      state.writes.push({ actor, method, path, body });
      state.readAt[actor] ??= createdAt;
      return json({ id: notificationId, readAt: state.readAt[actor] });
    }
    if (method === 'PUT' && path === '/api/notifications/preferences') {
      expect(body).toEqual({ inApp: false, eventTypes: ['alert.triggered'], email: false });
      state.writes.push({ actor, method, path, body });
      state.preferences[actor] = {
        inApp: false,
        eventTypes: ['alert.triggered'],
        email: false,
        emailAvailable: false,
      };
      return json(state.preferences[actor]);
    }
    state.unexpected.push(`${method} ${path}`);
    return json(
      { error: { code: 'unexpected_fixture_route', message: 'Unexpected private operation.' } },
      405,
    );
  });
  return {
    state,
    async switchIdentity(actor: Actor) {
      state.cookieActor = actor;
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('opengen:session-changed', {
            detail: { source: 'fixture-cookie-change' },
          }),
        ),
      );
    },
    async releaseHeld() {
      const held = state.held;
      if (!held) return;
      const completed = held.request.response();
      await held.release();
      const response = await completed;
      if (response) await response.finished();
      state.held = null;
    },
  };
}
async function staleManagementWrite(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  action: () => Promise<unknown>,
  path: string,
  method: string,
) {
  const before = f.state.writes.length;
  f.state.cookieActor = 'other-admin';
  await action();
  await expect
    .poll(() =>
      f.state.rejected.some(
        (item) => item.actor === 'other-admin' && item.path === path && item.status === 409,
      ),
    )
    .toBe(true);
  const sent = f.state.requests
    .filter((item) => item.method === method && item.path === path)
    .at(-1)!;
  expect(sent.workspace).toBe('studio-a');
  expect(sent.scope).toBe(principal('owner').recoveryScope);
  expect(f.state.writes).toHaveLength(before);
  await expect(page.locator('.gateway-connected')).toContainText('studio-b');
  f.state.cookieActor = 'owner';
}
const noOverflow = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const noStoredSecret = async (page: Page, secret: string) =>
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage })),
  ).not.toContain(secret);

for (const width of [1440, 390]) {
  test(`${width}px: mounted governance keeps exact caps, revisions, one-time secrets and private authority`, async ({
    page,
  }) => {
    const f = await fixture(page);
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/app#keys');
      const legacy = page.locator('section.workspace-settings').filter({
        has: page.getByRole('heading', {
          name: 'Keys for your applications and agents.',
          exact: true,
        }),
      });
      await expect(legacy.getByText('Original render key', { exact: true })).toBeVisible();
      await legacy.getByLabel('Key name', { exact: true }).fill('Must stay in studio-a');
      await staleManagementWrite(
        page,
        f,
        () => legacy.getByRole('button', { name: 'Create API key', exact: true }).click(),
        '/api/keys',
        'POST',
      );
      await expect(legacy.getByLabel('Key name', { exact: true })).toHaveValue('');
      await page.goto('/dashboard#settings');
      await page.getByRole('button', { name: 'Provider connections', exact: true }).click();
      const provider = page.locator('section.workspace-settings').filter({
        has: page.getByRole('heading', {
          name: 'Your providers. Your regional connections.',
          exact: true,
        }),
      });
      await expect(
        provider.getByText('No workspace provider connections saved.', { exact: true }),
      ).toBeVisible();
      await provider
        .getByRole('combobox', { name: 'Regional provider deployment', exact: true })
        .selectOption('alibaba-model-studio-ap-southeast-1');
      await provider
        .getByLabel('Provider API key', { exact: true })
        .fill('synthetic-provider-key-never-sent');
      await provider
        .getByLabel('Alibaba regional workspace ID', { exact: true })
        .fill('fixture-region-workspace');
      await staleManagementWrite(
        page,
        f,
        () =>
          provider.getByRole('button', { name: 'Save provider connection', exact: true }).click(),
        '/api/connections/alibaba-model-studio-ap-southeast-1',
        'PUT',
      );
      await expect(page.getByLabel('Provider API key', { exact: true })).toHaveCount(0);
      await noStoredSecret(page, 'synthetic-provider-key-never-sent');
      await page.goto('/app#apps');
      const apps = page.getByRole('region', { name: 'Connected apps', exact: true });
      await expect(apps.getByText('Fixture editor', { exact: true })).toBeVisible();
      await staleManagementWrite(
        page,
        f,
        () => apps.getByRole('button', { name: 'Revoke Fixture editor', exact: true }).click(),
        `/api/oauth/grants/${grantId}`,
        'DELETE',
      );
      await expect(apps.getByText('Fixture editor', { exact: true })).toHaveCount(0);
      await page.goto('/app#keys');
      const governance = page.getByRole('region', {
        name: 'Spending and routing governance',
        exact: true,
      });
      const key = governance.getByRole('region', { name: /^Manage key / });
      await expect(key.getByLabel('Key name', { exact: true })).toHaveValue('Original render key');
      await expect(key).toContainText('Earlier unattributed use is unknown');
      await key.getByLabel('Key name', { exact: true }).fill('Studio render pipeline');
      await key.getByLabel('Monthly managed cap, USD', { exact: true }).fill('2.500001');
      await key.getByRole('button', { name: 'Save key settings', exact: true }).click();
      await expect.poll(() => f.state.key.monthlyCapMicros).toBe(2_500_001);
      await expect(
        key.getByRole('button', { name: 'Save key settings', exact: true }),
      ).toBeEnabled();
      const profile = governance.getByRole('region', { name: /^Manage routing profile / });
      await profile.getByLabel('Profile name', { exact: true }).fill('Regional preview');
      await profile.getByLabel('Maximum per generation, USD', { exact: true }).fill('1.250001');
      await profile.getByLabel('Use author-operated providers only', { exact: true }).check();
      await profile.getByRole('button', { name: 'Save routing profile', exact: true }).click();
      await expect.poll(() => f.state.profile.revision).toBe(4);
      await expect(profile.getByLabel('Profile name', { exact: true })).toHaveValue(
        'Regional preview',
      );
      expect(f.state.profile.policy).toEqual({ ...regional, authorOnly: true });
      await governance.getByLabel('Include archived routing profiles', { exact: true }).check();
      await expect(
        governance.getByRole('button', { name: 'Refresh settings', exact: true }),
      ).toBeEnabled();
      await profile.getByRole('button', { name: 'Archive routing profile', exact: true }).click();
      await expect(
        governance.getByRole('button', { name: 'Profile archived', exact: true }),
      ).toBeDisabled();
      expect(f.state.profile.revision).toBe(5);
      expect(f.state.key.policyId).toBe(profileId);
      const rotate = key.getByRole('button', {
        name: 'Rotate secret and revoke sourced apps',
        exact: true,
      });
      await rotate.click();
      await expect(key.getByLabel('New key secret', { exact: true })).toHaveValue(keySecret(1));
      await expect(rotate).toBeDisabled();
      await noStoredSecret(page, keySecret(1));
      await key.getByRole('button', { name: 'I’ve saved this secret', exact: true }).click();
      await expect(key.getByLabel('New key secret', { exact: true })).toHaveCount(0);
      await rotate.click();
      await expect(key.getByRole('alert')).toContainText('will not retry automatically');
      await expect(rotate).toBeDisabled();
      expect(f.state.rotations).toEqual([1, 2]);
      await page.reload();
      await expect(rotate).toBeEnabled();
      await expect(key.getByLabel('New key secret', { exact: true })).toHaveCount(0);
      expect(f.state.rotations).toEqual([1, 2]);
      await rotate.click();
      await expect(key.getByLabel('New key secret', { exact: true })).toHaveValue(keySecret(3));
      await noOverflow(page);
      f.state.holdPath = '/api/governance/keys';
      await governance.getByRole('button', { name: 'Refresh settings', exact: true }).click();
      await expect.poll(() => Boolean(f.state.held)).toBe(true);
      await f.switchIdentity('other-workspace');
      await expect(page.locator('.gateway-connected')).toContainText('studio-b');
      await expect(page.getByLabel('New key secret', { exact: true })).toHaveCount(0);
      await expect(governance).toHaveCount(0);
      await f.releaseHeld();
      await expect(page.getByLabel('New key secret', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Studio render pipeline', { exact: true })).toHaveCount(0);
      await noStoredSecret(page, keySecret(3));
      expect(f.state.rotations).toEqual([1, 2, 3]);
      expect(f.state.unexpected).toEqual([]);
    } finally {
      await f.releaseHeld();
    }
  });

  test(`${width}px: mounted webhooks and personal notifications fence cookie changes and late secrets`, async ({
    page,
  }) => {
    const f = await fixture(page);
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/app#team');
      await page
        .getByLabel('Identity subject', { exact: true })
        .fill('must-not-invite-in-another-workspace');
      await staleManagementWrite(
        page,
        f,
        () => page.getByRole('button', { name: 'Invite teammate', exact: true }).click(),
        '/api/members',
        'POST',
      );
      await expect(page.getByLabel('Identity subject', { exact: true })).toHaveValue('');
      // The identical fragment URL may preserve the document. Restore verified
      // owner authority before beginning the next independent operation.
      await f.switchIdentity('owner');
      await expect(page.locator('.gateway-connected')).toContainText('studio-a');
      await page.goto('/app#team');
      const operations = page.getByRole('region', { name: 'Workspace operations', exact: true });
      await operations.getByLabel('Name', { exact: true }).fill('Private render events');
      await operations
        .getByLabel('Public endpoint URL', { exact: true })
        .fill('https://receiver.example.com/opengen/events');
      await operations.getByRole('button', { name: 'Create webhook', exact: true }).click();
      const secret = operations.getByRole('complementary', {
        name: 'One-time webhook secret',
        exact: true,
      });
      await expect(secret.locator('code')).toHaveText(webhookSecret(1));
      await noStoredSecret(page, webhookSecret(1));
      await noOverflow(page);
      await secret.getByRole('button', { name: 'I’ve saved this secret', exact: true }).click();
      const endpoint = operations.locator('article').filter({ hasText: 'Private render events' });
      await endpoint.getByRole('button', { name: 'Rotate secret', exact: true }).click();
      await expect(secret.locator('code')).toHaveText(webhookSecret(2));
      await secret.getByRole('button', { name: 'I’ve saved this secret', exact: true }).click();
      await endpoint.getByRole('button', { name: 'Disable', exact: true }).click();
      await expect(endpoint.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
      await operations.getByRole('button', { name: 'Your notifications', exact: true }).click();
      await operations.getByRole('button', { name: 'Mark read', exact: true }).click();
      await expect(operations.getByRole('button', { name: 'Mark read', exact: true })).toHaveCount(
        0,
      );
      await operations.getByLabel('Show in-app notifications', { exact: true }).uncheck();
      await operations.getByLabel('Resolved alert conditions', { exact: true }).uncheck();
      await operations.getByRole('button', { name: 'Save preferences', exact: true }).click();
      await expect.poll(() => f.state.preferences.owner.inApp).toBe(false);
      await expect(
        operations.getByRole('button', { name: 'Save preferences', exact: true }),
      ).toBeEnabled();
      expect(f.state.preferences['other-member'].inApp).toBe(true);
      await operations.getByRole('button', { name: 'Webhooks', exact: true }).click();
      await expect(endpoint.getByRole('button', { name: 'Enable', exact: true })).toBeVisible();
      // Cookie changed before any liveness signal: the old DOM's mutation must
      // carry its old expectation and receive409, never execute in studio-b.
      f.state.cookieActor = 'other-admin';
      await endpoint.getByRole('button', { name: 'Enable', exact: true }).click();
      await expect(operations.getByRole('alert')).toContainText('workspace or identity changed');
      expect(f.state.webhooks[0]!.enabled).toBe(false);
      expect(f.state.rejected).toContainEqual({
        actor: 'other-admin',
        path: `/api/webhooks/${webhookId}`,
        status: 409,
      });
      f.state.cookieActor = 'owner';
      await page.reload();
      await expect(
        endpoint.getByRole('button', { name: 'Rotate secret', exact: true }),
      ).toBeEnabled();
      f.state.holdPath = '/api/webhooks';
      await endpoint.getByRole('button', { name: 'Rotate secret', exact: true }).click();
      await expect(secret.locator('code')).toHaveText(webhookSecret(3));
      await expect.poll(() => Boolean(f.state.held)).toBe(true);
      await f.switchIdentity('other-member');
      await expect(
        operations.getByRole('heading', { name: 'Your workspace notifications.', exact: true }),
      ).toBeVisible();
      await expect(secret).toHaveCount(0);
      await f.releaseHeld();
      await expect(operations.getByRole('button', { name: 'Webhooks', exact: true })).toHaveCount(
        0,
      );
      await expect(page.getByText('Private render events', { exact: true })).toHaveCount(0);
      await expect(
        operations.getByLabel('Show in-app notifications', { exact: true }),
      ).toBeChecked();
      await expect(
        operations.getByLabel('Resolved alert conditions', { exact: true }),
      ).toBeChecked();
      await expect(
        operations.getByRole('button', { name: 'Mark read', exact: true }),
      ).toBeVisible();
      await operations.getByRole('button', { name: 'Mark read', exact: true }).click();
      await expect(operations.getByRole('button', { name: 'Mark read', exact: true })).toHaveCount(
        0,
      );
      expect(f.state.readAt.owner).toBe(createdAt);
      expect(f.state.readAt['other-member']).toBe(createdAt);
      expect(f.state.preferences.owner).toEqual({
        inApp: false,
        eventTypes: ['alert.triggered'],
        email: false,
        emailAvailable: false,
      });
      expect(f.state.preferences['other-member']).toEqual({
        inApp: true,
        eventTypes: ['alert.triggered', 'alert.resolved'],
        email: false,
        emailAvailable: false,
      });
      expect(f.state.webhookRotations).toBe(3);
      await noStoredSecret(page, webhookSecret(3));
      await noOverflow(page);
      expect(f.state.unexpected).toEqual([]);
    } finally {
      await f.releaseHeld();
    }
  });
}
