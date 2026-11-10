import { expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { createBytePlusAdapter } from '../packages/engine/src/byteplus.js';

it.each([
  ['text-to-image', 45_000],
  ['image-edit', null],
] as const)('keeps %s billing within its qualified tariff', async (operation, cost) => {
  const route = catalog.routes.find(
    (value) =>
      value.adapter === 'byteplus' && value.upstreamModelId === 'dola-seedream-5-0-pro-260628',
  )!;
  const deployment = catalog.deployments.find((value) => value.id === route.deploymentId)!;
  const input: GenerateInput = {
    modelId: route.modelId,
    operation,
    input: {
      prompt: 'A ceramic cup in soft daylight.',
      resolution: '1K',
      ...(operation === 'image-edit'
        ? {
            references: [
              { type: 'image' as const, asset: { url: 'https://media.example.com/source.png' } },
            ],
          }
        : {}),
    },
  };
  const adapter = createBytePlusAdapter({
    env: { BYTEPLUS_API_KEY: 'fixture' },
    fetch: async () =>
      Response.json({
        data: [{ url: 'https://media.example.com/output.png', size: '1024x1024' }],
        usage: { generated_images: 1 },
      }),
  });
  const result = await adapter.submit({ jobId: 'fixture-job', route, deployment, input });
  expect(result.immediateResult).toMatchObject({
    status: 'succeeded',
    billedCostMicros: cost,
  });
});
