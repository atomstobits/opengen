import { describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { createXaiAdapter } from '../packages/engine/src/xai.js';

const examples = [
  ['image', 'xai/grok-imagine-image-2.0', 'text-to-image'],
  ['video', 'xai/grok-imagine-video-1.5', 'text-to-video'],
] as const;

function fixture(
  modelId: (typeof examples)[number][1],
  operation: (typeof examples)[number][2],
  body: Record<string, unknown>,
) {
  const route = catalog.routes.find(
    (entry) => entry.modelId === modelId && entry.adapter === 'xai',
  )!;
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId)!;
  const input: GenerateInput = {
    modelId,
    operation,
    input: { prompt: 'A paper boat.', resolution: operation === 'text-to-image' ? '1K' : '480p' },
  };
  const adapter = createXaiAdapter({
    env: { XAI_API_KEY: 'fixture' },
    fetch: async () => Response.json(body),
  });
  return () =>
    adapter.poll({ jobId: 'fixture-job', upstreamId: 'fixture-task', route, deployment, input });
}

const output = {
  url: 'https://media.example.com/result.jpg',
  mime_type: 'image/jpeg',
  respect_moderation: true,
};
const completed = { status: 'done', data: [output], video: output };

describe.each(examples)('xAI %s reported charge', (_kind, modelId, operation) => {
  it.each([
    [0, 0],
    [1, 1],
    [9_999, 1],
    [10_000, 1],
    [10_001, 2],
    [400_000_000, 40_000],
    [5_000_000_000, 500_000],
    [Number.MAX_SAFE_INTEGER, 900_719_925_475],
  ])('converts %s ticks to %s micro-USD without a quote', async (ticks, cost) => {
    const result = await fixture(modelId, operation, {
      ...completed,
      usage: { cost_in_usd_ticks: ticks },
    })();
    expect(result).toMatchObject({ status: 'succeeded', billedCostMicros: cost });
  });

  it.each(
    [undefined, null, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, '400000000', true, [], {}].map(
      (ticks) => [ticks] as const,
    ),
  )('leaves invalid ticks %j unresolved', async (ticks) => {
    expect(
      await fixture(modelId, operation, {
        ...completed,
        usage: { cost_in_usd_ticks: ticks, total_tokens: 100, output_seconds: 5 },
      })(),
    ).toMatchObject({ status: 'succeeded', billedCostMicros: null });
  });

  it.each(
    [undefined, null, false, 'usage', [], { cost_in_usd: 0.04 }].map((usage) => [usage] as const),
  )('does not infer a charge from missing or malformed usage %j', async (usage) => {
    expect(
      await fixture(modelId, operation, {
        ...completed,
        usage,
        cost_in_usd_ticks: 400_000_000,
        cost: 0.04,
      })(),
    ).toMatchObject({ status: 'succeeded', billedCostMicros: null });
  });

  it('preserves a valid provider charge on explicit generation failure', async () => {
    expect(
      await fixture(modelId, operation, {
        status: 'failed',
        usage: { cost_in_usd_ticks: 400_000_000 },
      })(),
    ).toMatchObject({ status: 'failed', billedCostMicros: 40_000 });
    expect(await fixture(modelId, operation, { status: 'failed' })()).toMatchObject({
      status: 'failed',
      billedCostMicros: null,
    });
  });

  it('preserves a valid provider charge when moderation withholds output', async () => {
    expect(
      await fixture(modelId, operation, {
        ...completed,
        respect_moderation: false,
        usage: { cost_in_usd_ticks: 400_000_000 },
      })(),
    ).toMatchObject({ status: 'failed', failureCategory: 'policy', billedCostMicros: 40_000 });
  });

  it.each(['pending', 'expired'])('does not settle a %s response', async (status) => {
    const result = await fixture(modelId, operation, {
      status,
      usage: { cost_in_usd_ticks: 400_000_000 },
    })();
    expect(result.status).toBe(status === 'pending' ? 'running' : 'unknown');
    expect(result.billedCostMicros).toBeUndefined();
  });
});
