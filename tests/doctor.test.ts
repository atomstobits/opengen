import { describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { Principal } from '@media-router/engine';
import { buildApp, type EngineLike } from '../apps/server/src/app';

const route = catalog.routes.find((route) => route.id === 'alibaba/ap-southeast-1/wan-3.0')!;
const principal: Principal = {
  workspaceId: 'studio-a',
  scopes: ['read', 'generate'],
  identity: { issuer: 'https://identity.example', subject: 'account-fixture' },
};
function engine(
  actor: Principal = principal,
  options: { hold?: boolean; balance?: number } = {},
): EngineLike {
  return {
    accounts: {
      authenticate: async (token: string) => (token === 'valid-fixture' ? actor : null),
      listWorkspaces: async () => [{ id: actor.workspaceId, name: 'Studio A' }],
    } as unknown as EngineLike['accounts'],
    getExecutableRouteIds: () => [route.id],
    workspaceReadiness: async () => ({
      balance: { availableMicros: options.balance ?? 10_000, reservedMicros: 400, currency: 'USD' },
      billingHold: options.hold ?? false,
      configuredRoutes: { managed: [route.id], byok: [] },
    }),
    getBalance: async () => ({
      availableMicros: options.balance ?? 10_000,
      reservedMicros: 400,
      currency: 'USD',
    }),
    submit: async () => {
      throw new Error('Diagnosis must not submit.');
    },
    getJob: async () => {
      throw new Error('Diagnosis must not read jobs.');
    },
    listJobs: async () => [],
    cancel: async () => {
      throw new Error('Diagnosis must not cancel.');
    },
    routeMetrics: async () => [],
    lookupJob: async (workspace, key) =>
      workspace === 'studio-a' && key === 'saved-key'
        ? ({ id: 'job-a', workspaceId: workspace } as never)
        : null,
  };
}

describe('authenticated read-only installation diagnosis', () => {
  it('reports the authenticated account, explicit payer, scoped configured routes and balance without implying a live test', async () => {
    const app = await buildApp({ engine: engine() });
    try {
      const response = await app.inject({
        url: '/v1/doctor',
        headers: { authorization: 'Bearer valid-fixture' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        authenticated: true,
        authorized: true,
        account: principal.identity,
        payingWorkspace: { id: 'studio-a', name: 'Studio A' },
        scopes: ['read', 'generate'],
        balance: { availableMicros: 10_000, reservedMicros: 400 },
        executableRoutes: {
          managed: [route.id],
          byok: [],
          evidence: 'configuration-only',
          requestQuoteRequired: true,
        },
        nextBlocker: null,
      });
      expect(JSON.stringify(response.json())).not.toContain('valid-fixture');
      expect(response.json()).not.toHaveProperty('executionScope');
      expect(
        (await app.inject({ url: '/v1/doctor', headers: { authorization: 'Bearer rejected' } }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('reports a global transition block without foreign queue details or fixture identity', async () => {
    const configured = engine();
    configured.workspaceReadiness = async () => ({
      balance: { availableMicros: 10_000, reservedMicros: 400, currency: 'USD' },
      billingHold: false,
      configuredRoutes: { managed: [route.id], byok: [] },
      executionScope: {
        profile: 'qualification-sg-v1',
        queuedConflicts: 0,
        transitionBlocked: true,
        foreignQueuedConflicts: 7,
        foreignWorkspaces: ['private-foreign-workspace'],
        firstFrameSha256: 'a'.repeat(64),
        privateAssetKey: 'private-fixture-key',
      },
    });
    const app = await buildApp({ engine: configured });
    try {
      const response = await app.inject({
        url: '/v1/doctor',
        headers: { authorization: 'Bearer valid-fixture' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        executionScope: {
          profile: 'qualification-sg-v1',
          queuedConflicts: 0,
          transitionBlocked: true,
        },
        nextBlocker: { code: 'execution_scope_transition_required' },
      });
      expect(Object.keys(response.json().executionScope).sort()).toEqual([
        'profile',
        'queuedConflicts',
        'transitionBlocked',
      ]);
      expect(response.body).not.toMatch(
        /private-foreign-workspace|foreignQueuedConflicts|foreignWorkspaces|private-fixture-key|firstFrameSha256/,
      );
      expect(response.body).not.toContain('a'.repeat(64));
    } finally {
      await app.close();
    }
  });

  it('uses the transition flag rather than the owner queue count as its blocking state', async () => {
    const configured = engine();
    configured.workspaceReadiness = async () => ({
      balance: { availableMicros: 10_000, reservedMicros: 400, currency: 'USD' },
      billingHold: false,
      configuredRoutes: { managed: [route.id], byok: [] },
      executionScope: {
        profile: 'qualification-sg-v1',
        queuedConflicts: 7,
        transitionBlocked: false,
      },
    });
    const app = await buildApp({ engine: configured });
    try {
      const response = await app.inject({
        url: '/v1/doctor',
        headers: { authorization: 'Bearer valid-fixture' },
      });
      expect(response.json().nextBlocker).toBeNull();
      expect(response.json().executionScope.queuedConflicts).toBe(7);
      expect(response.json().executionScope.transitionBlocked).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('keeps authenticated read-only access separate from generation authorization', async () => {
    const app = await buildApp({ engine: engine({ ...principal, scopes: ['read'] }) });
    try {
      const response = await app.inject({
        url: '/v1/doctor',
        headers: { authorization: 'Bearer valid-fixture' },
      });
      expect(response.json()).toMatchObject({
        authenticated: true,
        authorized: false,
        nextBlocker: { code: 'insufficient_scope', nextCommand: 'opengen login' },
      });
    } finally {
      await app.close();
    }
  });

  it('surfaces billing holds and policy-filtered route blockers without a submission', async () => {
    for (const [actor, options, expected] of [
      [principal, { hold: true }, 'billing_hold'],
      [
        { ...principal, policy: { endpointRegions: ['unavailable-region'] } },
        {},
        'no_executable_route',
      ],
      [principal, { balance: 0 }, 'insufficient_balance'],
    ] as const) {
      const app = await buildApp({ engine: engine(actor, options) });
      try {
        const response = await app.inject({
          url: '/v1/doctor',
          headers: { authorization: 'Bearer valid-fixture' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().nextBlocker.code).toBe(expected);
        if (expected === 'no_executable_route')
          expect(response.json().executableRoutes.managed).toEqual([]);
      } finally {
        await app.close();
      }
    }
  });

  it('looks up a persisted key only within the authenticated paying workspace and keeps missing acceptance unknown', async () => {
    const app = await buildApp({ engine: engine() });
    const other = await buildApp({ engine: engine({ ...principal, workspaceId: 'studio-b' }) });
    try {
      const request = {
        url: '/v1/generations/lookup?idempotencyKey=saved-key',
        headers: { authorization: 'Bearer valid-fixture' },
      };
      const found = await app.inject(request);
      expect(found.json()).toMatchObject({ id: 'job-a', workspaceId: 'studio-a' });
      expect(found.headers['cache-control']).toBe('no-store');
      const missing = await other.inject(request);
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error.code).toBe('submission_not_found');
      expect(missing.json().error.message).toContain('Acceptance remains unknown');
    } finally {
      await app.close();
      await other.close();
    }
  });
});
