import { expect, it, vi } from 'vitest';
import type { Job } from '@media-router/contracts';
import { buildApp, type EngineLike } from '../apps/server/src/app.js';

it('preserves trusted source identities through native, compatibility and MCP-to-HTTP admission', async () => {
  const principal = {
    workspaceId: 'fixture',
    scopes: ['read', 'generate'] as ('read' | 'generate')[],
    keyId: 'stable-source',
    keyKind: 'oauth' as const,
    keySecretVersion: 2,
    membershipId: 'member',
    grantId: 'grant',
    clientId: 'client',
    oauthResource: 'https://example.test/mcp',
  };
  const input = {
    modelId: 'alibaba/wan-3.0',
    operation: 'text-to-video' as const,
    input: { prompt: 'Synthetic.', duration: 2, resolution: '720p' },
  };
  const job: Job = {
    id: '0171cd13-c992-4ac0-87d2-4f59092bca9d',
    workspaceId: 'fixture',
    status: 'queued',
    input,
    routeId: 'fixture/route',
    deploymentId: 'fixture/region',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    reservedMicros: 1,
    settledMicros: null,
    attemptCount: 0,
  };
  const submit = vi.fn(async (_args: Parameters<EngineLike['submit']>[0]) => job);
  const engine: EngineLike = {
    accounts: { authenticate: async () => principal } as unknown as EngineLike['accounts'],
    getExecutableRouteIds: () => [],
    submit,
    getJob: async () => job,
    listJobs: async () => [],
    cancel: async () => job,
    getBalance: async () => ({}),
    routeMetrics: async () => [],
  };
  const app = await buildApp({ engine });
  const headers = { authorization: 'Bearer fixture', 'idempotency-key': 'stable' };
  try {
    const native = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers,
      payload: { ...input, metadata: { project: 'Private project', tags: { feature: 'test' } } },
    });
    expect(native.statusCode).toBe(202);
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      principal,
      input: { metadata: { project: 'Private project' } },
    });
    const compat = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers,
      payload: { model: input.modelId, prompt: 'Synthetic.', seconds: '2', size: '1280x720' },
    });
    expect(compat.statusCode).toBe(202);
    expect(submit.mock.calls[1]?.[0]).toMatchObject({ principal });
    const mcp = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'call',
          arguments: { operationId: 'media.generate', idempotencyKey: 'mcp-stable', input },
        },
      },
    });
    expect(mcp.statusCode).toBe(200);
    expect(submit.mock.calls[2]?.[0]).toMatchObject({ principal, idempotencyKey: 'mcp-stable' });
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers,
      payload: { ...input, principal: { keyId: 'forged' } },
    });
    expect(forged.statusCode).toBe(400);
    expect(submit).toHaveBeenCalledTimes(3);
  } finally {
    await app.close();
  }
});
