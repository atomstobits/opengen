import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerOwnedAssetRoutes } from '../apps/server/src/owned-assets.js';
it('binds all asset operations to authenticated workspace/scopes and marks private responses no-store', async () => {
  const methods = [
    'get',
    'prepareUpload',
    'completeUpload',
    'delete',
    'reuse',
    'importAsset',
    'prepareMultipart',
    'signMultipartPart',
    'resumeMultipart',
    'completeMultipart',
    'abortMultipart',
  ];
  const assets = Object.fromEntries(
    methods.map((name) => [name, vi.fn(async () => ({ state: 'ready' }))]),
  );
  const authenticate = vi.fn(async (_request, scope) => ({
    workspaceId: 'trusted',
    scopes: [scope],
  }));
  const app = Fastify();
  app.setErrorHandler((error: { name?: string; statusCode?: number }, _request, reply) =>
    reply.code(error.name === 'ZodError' ? 400 : (error.statusCode ?? 500)).send({ error: 'safe' }),
  );
  await app.register(async (child) => {
    registerOwnedAssetRoutes(child, { assets: assets as never, authenticate });
  });
  const routes = [
    {
      method: 'POST',
      url: '/v1/assets',
      payload: { mediaType: 'image/png', size: 100 },
      fn: 'prepareUpload',
    },
    { method: 'GET', url: '/v1/assets?key=inputs%2Ftrusted%2Ffixture.png', fn: 'get' },
    {
      method: 'POST',
      url: '/v1/assets/complete',
      payload: { key: 'inputs/trusted/fixture.png' },
      fn: 'completeUpload',
    },
    {
      method: 'DELETE',
      url: '/v1/assets',
      payload: { key: 'inputs/trusted/fixture.png' },
      fn: 'delete',
    },
    {
      method: 'POST',
      url: '/v1/assets/import',
      payload: { url: 'https://public.example/media', type: 'audio' },
      fn: 'importAsset',
    },
    {
      method: 'POST',
      url: '/v1/assets/reuse',
      payload: { sourceJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outputIndex: 0 },
      fn: 'reuse',
    },
    {
      method: 'POST',
      url: '/v1/assets/multipart',
      payload: { mediaType: 'video/webm', size: 100 },
      fn: 'prepareMultipart',
    },
    {
      method: 'POST',
      url: '/v1/assets/multipart/part',
      payload: { key: 'inputs/trusted/fixture.webm', partNumber: 1 },
      fn: 'signMultipartPart',
    },
    {
      method: 'GET',
      url: '/v1/assets/multipart?key=inputs%2Ftrusted%2Ffixture.webm',
      fn: 'resumeMultipart',
    },
    {
      method: 'POST',
      url: '/v1/assets/multipart/complete',
      payload: { key: 'inputs/trusted/fixture.webm', parts: [{ partNumber: 1, etag: 'etag' }] },
      fn: 'completeMultipart',
    },
    {
      method: 'POST',
      url: '/v1/assets/multipart/abort',
      payload: { key: 'inputs/trusted/fixture.webm' },
      fn: 'abortMultipart',
    },
  ] as const;
  try {
    for (const route of routes) {
      const response = await app.inject({
        ...route,
        headers: { 'idempotency-key': 'stable' },
      } as never);
      expect(response.statusCode, route.url).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(assets[route.fn]).toHaveBeenCalledWith(
        'trusted',
        ...assets[route.fn]!.mock.calls[0]!.slice(1),
      );
    }
    expect(authenticate.mock.calls.map((args) => args[1])).toEqual([
      'generate',
      'read',
      'generate',
      'generate',
      'generate',
      'generate',
      'generate',
      'generate',
      'generate',
      'generate',
      'generate',
    ]);
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/assets/reuse',
      payload: {
        workspaceId: 'foreign',
        sourceJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        outputIndex: 0,
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(assets.reuse).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
it('refuses unauthenticated requests before service access', async () => {
  const app = Fastify();
  app.setErrorHandler((error: { name?: string; statusCode?: number }, _request, reply) =>
    reply.code(error.name === 'ZodError' ? 400 : (error.statusCode ?? 500)).send({ error: 'safe' }),
  );
  const get = vi.fn();
  await app.register(async (child) => {
    registerOwnedAssetRoutes(child, {
      assets: { get } as never,
      authenticate: async () => {
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      },
    });
  });
  try {
    expect((await app.inject('/v1/assets?key=anything')).statusCode).toBe(401);
    expect(get).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
