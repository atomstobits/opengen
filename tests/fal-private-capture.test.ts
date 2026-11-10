import { expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import { createFalAdapter } from '../packages/engine/src/fal.js';

it('opts out of fal payload history and checkpoints terminal output without enabling private ACL or returning a raw URL', async () => {
  const route = catalog.routes.find(
    (value) => value.adapter === 'fal' && value.upstreamModelId === 'minimax/h3-max/text-to-video',
  )!;
  const deployment = catalog.deployments.find((value) => value.id === route.deploymentId)!;
  const capture = vi.fn().mockResolvedValue([]);
  const calls: { url: string; init?: RequestInit }[] = [];
  const adapter = createFalAdapter({
    env: { FAL_KEY: 'fixture-not-live' } as NodeJS.ProcessEnv,
    captureOutputs: capture,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init?.method === 'POST') return Response.json({ request_id: 'original-task' });
      if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
      return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/output.mp4' } });
    },
  });
  const context = {
    jobId: '6bb043ce-0878-4a94-93e6-4e27a3e55d39',
    workspaceId: 'owner',
    attempt: 1,
    providerConnectionId: 'managed:' + 'a'.repeat(64),
    route,
    deployment,
    input: {
      modelId: route.modelId,
      operation: 'text-to-video' as const,
      input: { prompt: 'Synthetic fixture.', duration: 5, resolution: '768p', aspectRatio: '16:9' },
    },
  };
  await expect(adapter.submit(context)).resolves.toEqual({ upstreamId: 'original-task' });
  const result = await adapter.poll({ ...context, upstreamId: 'original-task' });
  expect(new Headers(calls[0]!.init?.headers).get('X-Fal-Store-IO')).toBe('0');
  expect(new Headers(calls[0]!.init?.headers).has('X-Fal-Object-Lifecycle-Preference')).toBe(false);
  expect(capture).toHaveBeenCalledWith(
    expect.objectContaining({
      upstreamId: 'original-task',
      attempt: 1,
      providerConnectionId: context.providerConnectionId,
    }),
    [
      {
        kind: 'url',
        url: 'https://v3b.fal.media/files/b/fixture/output.mp4',
        mediaType: 'video/mp4',
        refreshable: true,
      },
    ],
  );
  expect(result).toMatchObject({ status: 'succeeded', outputs: [], billedCostMicros: null });
  expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('fal.media');
});
