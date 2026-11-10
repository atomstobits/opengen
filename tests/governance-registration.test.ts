import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { governancePolicySchema, registerGovernance } from '../apps/server/src/governance';
import {
  callSchema,
  publicOperationIds,
  idempotentOperationIds,
} from '../apps/server/src/operations';
import { operationRequest, operationTargets } from '../packages/contracts/src/operations';
import { routingSchema } from '../apps/server/src/validation';

const id = '6cf649c6-d9dd-4b62-8bfb-7ebef864b095';
const actor = {
  workspaceId: 'owner',
  scopes: ['read', 'keys:write', 'policies:write'] as const,
  bootstrap: true,
};
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function fixture(missing = false) {
  const app = Fastify();
  apps.push(app);
  app.setErrorHandler((error, _request, reply) => {
    const value = error as { name?: string; statusCode?: number; code?: string };
    reply
      .code(value.name === 'ZodError' ? 400 : (value.statusCode ?? 500))
      .send({ error: { code: value.code ?? 'invalid_request' } });
  });
  const authenticate = vi.fn(async (_request, scope) => {
    if (!actor.scopes.includes(scope))
      throw Object.assign(new Error('Denied.'), { statusCode: 403 });
    return { ...actor, scopes: [...actor.scopes] };
  });
  const keys = {
    listKeys: vi.fn(async () => []),
    updateKey: vi.fn(async (_principal, keyId, patch) => ({ id: keyId, ...patch })),
    rotateKey: vi.fn(async (_principal, keyId, version) => ({
      id: keyId,
      token: 'synthetic-once',
      secretVersion: version + 1,
    })),
  };
  const policies = {
    list: vi.fn(async () => []),
    update: vi.fn(async (_principal, profileId, revision, patch) => ({
      id: profileId,
      revision: revision + 1,
      ...patch,
    })),
    archive: vi.fn(async (_principal, profileId, revision) => ({
      id: profileId,
      revision: revision + 1,
      archivedAt: '2026-11-04T00:00:00Z',
    })),
  };
  await registerGovernance(app, {
    authenticate,
    ...(missing ? {} : { keys, policies }),
  } as Parameters<typeof registerGovernance>[1]);
  return { app, authenticate, keys, policies };
}

describe('private governance protocol registration', () => {
  it('registers only private fixed targets and forwards path/version arguments exactly', () => {
    const expected = {
      'keys.governance': ['GET', '/v1/governance/keys'],
      'keys.update': ['PATCH', `/v1/keys/${id}`],
      'keys.rotate': ['POST', `/v1/keys/${id}/rotate`],
      'policies.governance': ['GET', '/v1/governance/policies?includeArchived=true'],
      'policies.update': ['PATCH', `/v1/policies/${id}`],
      'policies.archive': ['POST', `/v1/policies/${id}/archive`],
    };
    const inputs = {
      'keys.governance': {},
      'keys.update': { id, monthlyCapMicros: 0 },
      'keys.rotate': { id, expectedSecretVersion: 3 },
      'policies.governance': { includeArchived: true },
      'policies.update': { id, expectedRevision: 2, policy: { modelIds: [] } },
      'policies.archive': { id, expectedRevision: 2 },
    };
    for (const operationId of Object.keys(inputs) as (keyof typeof inputs)[]) {
      const parsed = callSchema.parse({ operationId, input: inputs[operationId] });
      const request = operationRequest(operationId, parsed.input);
      expect([request.method, request.path]).toEqual(expected[operationId]);
      expect(request.payload ?? {}).not.toHaveProperty('id');
      expect(publicOperationIds.has(operationId)).toBe(false);
      expect(idempotentOperationIds.has(operationId)).toBe(false);
      expect(operationTargets[operationId]).toBeDefined();
    }
    expect(
      callSchema.safeParse({
        operationId: 'keys.rotate',
        input: { id, expectedSecretVersion: 1, workspaceId: 'foreign' },
      }).success,
    ).toBe(false);
    expect(
      callSchema.safeParse({
        operationId: 'keys.create',
        input: { name: 'Agent', scopes: ['read'], monthlyCapMicros: 0 },
      }).success,
    ).toBe(true);
    expect(
      callSchema.safeParse({
        operationId: 'policies.create',
        input: { name: 'Deny', policy: { modelIds: [] } },
      }).success,
    ).toBe(true);
  });

  it('permits explicit admin denial while retaining canonical route restrictions and bounds', () => {
    const profile = {
      modelIds: [],
      modelProviderExceptions: [{ modelId: 'minimax/h3-max', providerIds: [] }],
      providerIds: [],
      deploymentIds: ['exact-region'],
      endpointRegions: ['eu'],
      processingRegions: [],
      processingScopes: ['regional'],
      fidelity: 'native',
      fallback: false,
    };
    expect(governancePolicySchema.parse(profile)).toEqual(profile);
    expect(routingSchema.safeParse({ modelIds: [] }).success).toBe(false);
    for (const policy of [
      { providerIds: Array.from({ length: 101 }, (_, n) => `provider${n}`) },
      { arbitrary: 'anything' },
      { modelProviderExceptions: [{ modelId: 'm', providerIds: [], actor: 'foreign' }] },
    ])
      expect(governancePolicySchema.safeParse(policy).success).toBe(false);
  });

  it('keeps missing installations authenticated, private and fail-closed', async () => {
    const { app, authenticate } = await fixture(true);
    for (const url of ['/v1/governance/keys', '/v1/governance/policies']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({ error: { code: 'database_not_configured' } });
    }
    expect(authenticate.mock.calls.map((call) => call[1])).toEqual(['keys:write', 'read']);
  });

  it('lists active or explicitly archived profiles using trusted actors and strict queries', async () => {
    const { app, policies, authenticate } = await fixture();
    expect((await app.inject('/v1/governance/policies')).statusCode).toBe(200);
    expect((await app.inject('/v1/governance/policies?includeArchived=true')).statusCode).toBe(200);
    expect(policies.list.mock.calls.map((call) => call[1])).toEqual([false, true]);
    expect(policies.list.mock.calls[0]?.[0]).toMatchObject({ workspaceId: 'owner' });
    for (const url of [
      '/v1/governance/policies?includeArchived=1',
      '/v1/governance/policies?workspaceId=foreign',
    ])
      expect((await app.inject(url)).statusCode).toBe(400);
    expect((await app.inject('/v1/governance/keys?workspaceId=foreign')).statusCode).toBe(400);
    expect(policies.list).toHaveBeenCalledTimes(2);
    expect(authenticate.mock.calls.slice(0, 4).every((call) => call[1] === 'read')).toBe(true);
  });

  it('preserves zero/null caps and refuses empty or authority-bearing updates before mutation', async () => {
    const { app, keys } = await fixture();
    for (const monthlyCapMicros of [0, null]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/keys/${id}`,
        payload: { monthlyCapMicros },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(keys.updateKey.mock.calls.at(-1)?.[2]).toEqual({ monthlyCapMicros });
    }
    for (const payload of [
      {},
      { name: 'New', workspaceId: 'foreign' },
      { monthlyCapMicros: 1.1 },
      { monthlyCapMicros: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(
        (await app.inject({ method: 'PATCH', url: `/v1/keys/${id}`, payload })).statusCode,
      ).toBe(400);
    expect(keys.updateKey).toHaveBeenCalledTimes(2);
  });

  it('forwards one versioned rotation and rejects malformed versions without a second mutation', async () => {
    const { app, keys } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/keys/${id}/rotate`,
      payload: { expectedSecretVersion: 4 },
    });
    expect(response.json()).toEqual({ id, token: 'synthetic-once', secretVersion: 5 });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(keys.rotateKey.mock.calls[0]).toEqual([
      expect.objectContaining({ workspaceId: 'owner' }),
      id,
      4,
    ]);
    for (const payload of [
      {},
      { expectedSecretVersion: 0 },
      { expectedSecretVersion: 1, token: 'forged' },
    ])
      expect(
        (await app.inject({ method: 'POST', url: `/v1/keys/${id}/rotate`, payload })).statusCode,
      ).toBe(400);
    expect(keys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('passes complete routing edits and revisions to the transactional store without widening', async () => {
    const { app, policies, authenticate } = await fixture();
    const policy = {
      modelIds: [],
      deploymentIds: ['exact-region'],
      processingScopes: ['regional'],
      authorOnly: true,
      fallback: false,
    };
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/policies/${id}`,
      payload: { expectedRevision: 7, policy, maxCostMicros: 0 },
    });
    expect(updated.statusCode).toBe(200);
    expect(policies.update.mock.calls[0]).toEqual([
      expect.objectContaining({ workspaceId: 'owner' }),
      id,
      7,
      { policy, maxCostMicros: 0 },
    ]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v1/policies/${id}/archive`,
          payload: { expectedRevision: 8 },
        })
      ).statusCode,
    ).toBe(200);
    expect(policies.archive.mock.calls[0]?.slice(1)).toEqual([id, 8]);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/v1/policies/${id}`,
          payload: { expectedRevision: 8 },
        })
      ).statusCode,
    ).toBe(400);
    expect(policies.update).toHaveBeenCalledTimes(1);
    expect(authenticate.mock.calls.every((call) => call[1] === 'policies:write')).toBe(true);
  });
});
