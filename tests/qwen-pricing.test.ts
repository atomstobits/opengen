import { describe, expect, it } from 'vitest';
import { catalog, quote } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import { catalogSmokeCases } from '../scripts/live-smoke.js';

const regionalModels = [
  ['qwen/image-2.1-turbo', [16_000, 16_000], [14_133, 14_133]],
  ['alibaba/qwen-image-2.1-pro', [40_000, 40_000], [35_333, 35_333]],
  ['alibaba/qwen-image-3.0-pro', [40_000, 75_000], [34_380, 68_761]],
] as const;

const nonSingaporeDeployments = [
  'alibaba-model-studio-cn-beijing',
  'alibaba-model-studio-ap-northeast-1',
  'alibaba-model-studio-eu-central-1',
  'alibaba-model-studio-us-east-1',
  'alibaba-model-studio-cn-hongkong',
] as const;

describe('Alibaba Model Studio regional Qwen text-only public list estimates', () => {
  it.each(regionalModels)(
    'quotes the exact %s variant across all 6 Alibaba regions with regional credentials and a budget',
    (modelId, singaporePrices, otherRegionPrices) => {
      const deployments = [
        ['alibaba-model-studio-ap-southeast-1', singaporePrices],
        ...nonSingaporeDeployments.map((id) => [id, otherRegionPrices] as const),
      ] as const;

      for (const [deploymentId, prices] of deployments) {
        const route = catalog.routes.find(
          (entry) => entry.modelId === modelId && entry.deploymentId === deploymentId,
        )!;
        expect(route).toBeDefined();
        for (const [index, resolution] of ['1K', '2K'].entries()) {
          const request: GenerateInput = {
            modelId,
            routeId: route.id,
            operation: 'text-to-image',
            input: { prompt: 'A ceramic cup beside a folded blue cloth.', resolution, count: 1 },
            billing: 'managed',
            routing: { fallback: false },
          };
          const options = { executableRouteIds: [route.id] };
          const result = quote(request, options);
          expect(result.selectedRouteId).toBe(route.id);
          expect(result.reservationMicros).toBe(prices[index]);
          expect(result.candidates[0]!.source).toMatchObject({
            url: 'https://www.alibabacloud.com/help/en/model-studio/billing-for-model-studio',
            checkedAt: '2026-11-13',
          });
          expect(quote(request).selectedRouteId).toBeNull();
          expect(
            quote({ ...request, maxCostMicros: prices[index]! - 1 }, options).selectedRouteId,
          ).toBeNull();
        }
        expect(route.status).toBe('documented');
        expect(
          catalogSmokeCases(catalog).find((entry) => entry.routeId === route.id),
        ).toMatchObject({
          state: 'ready',
          estimateMicros: prices[0],
          reserveMicros: prices[0] * 2,
          input: { operation: 'text-to-image', input: { resolution: '1K' } },
        });
      }
    },
  );

  it.each(regionalModels)(
    'keeps %s edits, thinking and exact-size estimates unqualified across all 6 regions',
    (modelId) => {
      const routes = catalog.routes.filter(
        (entry) => entry.modelId === modelId && entry.adapter === 'alibaba',
      );
      expect(routes).toHaveLength(6);
      for (const route of routes) {
        const request: GenerateInput = {
          modelId,
          routeId: route.id,
          operation: 'text-to-image',
          input: { prompt: 'A ceramic cup beside a folded blue cloth.', resolution: '1K' },
          billing: 'managed',
        };
        const requests: GenerateInput[] = [
          {
            ...request,
            operation: 'image-edit',
            input: {
              ...request.input,
              references: [
                { type: 'image', asset: { url: 'https://media.example.com/reference.png' } },
              ],
            },
          },
          { ...request, input: { ...request.input, thinking: true, promptExtend: true } },
          {
            ...request,
            input: { ...request.input, resolution: undefined, size: { width: 1024, height: 1024 } },
          },
        ];
        for (const input of requests) {
          const result = quote(input, { executableRouteIds: [route.id] });
          expect(result.selectedRouteId).toBeNull();
          expect(result.candidates[0]!.estimatedCostMicros).toBeNull();
        }
        expect(route.rates.every((rate) => rate.operation === 'text-to-image')).toBe(true);
      }
    },
  );

  it('retains the extra 3.0 Pro image-input charge in source evidence', () => {
    const route = catalog.routes.find(
      (entry) =>
        entry.modelId === 'alibaba/qwen-image-3.0-pro' &&
        entry.deploymentId === 'alibaba-model-studio-ap-southeast-1',
    )!;
    expect(route.pricingSource.note).toContain('additional USD 0.003 each');
  });
});
