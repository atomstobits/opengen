import { describe, expect, it } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput, RoutingPolicy } from '@media-router/contracts';
import { eligibleReuseRoutes } from '../apps/web/app/playground-request';

const model = catalog.models.find((item) => item.id === 'alibaba/wan-3.0')!;
const routes = catalog.routes.filter((item) => item.modelId === model.id);
const singaporeId = 'alibaba-model-studio-ap-southeast-1';
const request = (routing: RoutingPolicy): GenerateInput => ({
  modelId: 'openai/gpt-image-2',
  operation: 'text-to-image',
  input: { prompt: 'A private still life.' },
  routing,
});
const eligible = (routing: RoutingPolicy) =>
  eligibleReuseRoutes(model, routes, catalog.deployments, request(routing), 'image-to-video');

describe('owned reuse routing restrictions', () => {
  it('allows a compatible cross-model destination without broadening the selected region or scope', () => {
    const policy: RoutingPolicy = {
      modelIds: [model.id],
      providerIds: ['alibaba'],
      deploymentIds: [singaporeId],
      endpointRegions: ['ap-southeast-1'],
      processingScopes: ['international'],
      fidelity: 'any',
      authorOnly: true,
    };
    expect(eligible(policy).map((route) => route.id)).toEqual(['alibaba/ap-southeast-1/wan-3.0']);
  });

  it.each<RoutingPolicy>([
    { modelIds: ['openai/gpt-image-2'] },
    { providerIds: ['openai'] },
    { deploymentIds: ['openai-undisclosed'] },
    { endpointRegions: ['eu-west-1'] },
    { endpointRegions: ['undisclosed'], authorOnly: true },
    { processingScopes: ['regional'] },
    { processingRegions: ['ap-southeast-1'] },
    { fidelity: 'native' },
  ])('keeps an incompatible cross-model policy closed: %j', (policy) => {
    expect(eligible(policy)).toEqual([]);
  });

  it('applies model-specific provider exceptions together with the author constraint', () => {
    expect(
      eligible({
        providerIds: ['openai'],
        modelProviderExceptions: [{ modelId: model.id, providerIds: ['alibaba'] }],
        authorOnly: true,
        deploymentIds: [singaporeId],
      }),
    ).toHaveLength(1);
    expect(
      eligible({
        providerIds: ['alibaba'],
        modelProviderExceptions: [{ modelId: model.id, providerIds: ['openai'] }],
      }),
    ).toEqual([]);
  });

  it('does not treat a partially disclosed processing region as satisfying a restriction', () => {
    const deployments = catalog.deployments.map((deployment) =>
      deployment.id === singaporeId
        ? { ...deployment, processingRegions: ['ap-southeast-1', 'us-east-1'] }
        : deployment,
    );
    const draft = request({ deploymentIds: [singaporeId], processingRegions: ['ap-southeast-1'] });
    expect(eligibleReuseRoutes(model, routes, deployments, draft, 'image-to-video')).toEqual([]);
    draft.routing!.processingRegions!.push('us-east-1');
    expect(eligibleReuseRoutes(model, routes, deployments, draft, 'image-to-video')).toHaveLength(
      1,
    );
  });
});
