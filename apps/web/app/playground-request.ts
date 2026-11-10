import type { Catalog, GenerateInput, Model, Operation, Route } from '@media-router/contracts';
import {
  generationArgumentSchema,
  routingSchema,
  getGenerationDefinition,
  parseGenerationRequest,
  validateRouteInput,
} from '@media-router/contracts/generation';

export function initialPlaygroundRequest(
  model: Model,
  routes: Route[],
  initialRouteId?: string,
  initialOperation?: Operation,
  initialRegion?: string,
): GenerateInput {
  const pinned = routes.find((route) => route.id === initialRouteId);
  const operation = (initialOperation ??
    pinned?.operations[0] ??
    routes[0]?.operations[0] ??
    (model.modality === 'image' ? 'text-to-image' : 'text-to-video')) as Operation;
  const definition = getGenerationDefinition(model.id, operation);
  const input = { ...definition?.defaults };
  // Choose a documented initial configuration only before the user edits anything.
  if (pinned && input.resolution && !pinned.resolutions.includes(input.resolution))
    input.resolution = pinned.resolutions[0];
  if (pinned && typeof input.duration === 'number' && !pinned.durations.includes(input.duration))
    input.duration = pinned.durations[0];
  return {
    modelId: model.id,
    operation,
    input,
    ...(pinned ? { routeId: pinned.id } : {}),
    routing: {
      preference: 'cost',
      fallback: false,
      ...(initialRegion ? { endpointRegions: [initialRegion] } : {}),
      deploymentIds: [...new Set(routes.map((route) => route.deploymentId))],
    },
    billing: 'managed',
    maxCostMicros: 2_000_000,
  };
}

/** A new model changes its inputs, never the caller's routing restrictions. */
export function eligibleReuseRoutes(
  model: Catalog['models'][number],
  routes: Route[],
  deployments: Catalog['deployments'],
  draft: GenerateInput,
  operation: Operation,
): Route[] {
  const policy = draft.routing ?? {};
  const providers =
    policy.modelProviderExceptions?.find((item) => item.modelId === model.id)?.providerIds ??
    policy.providerIds;
  return routes.filter((route) => {
    const deployment = deployments.find(({ id }) => id === route.deploymentId);
    return (
      !!deployment &&
      route.operations.includes(operation) &&
      (!policy.modelIds || policy.modelIds.includes(model.id)) &&
      (!providers || providers.includes(deployment.providerId)) &&
      (!policy.authorOnly || model.authorProviderIds.includes(deployment.providerId)) &&
      (!policy.deploymentIds || policy.deploymentIds.includes(deployment.id)) &&
      (!policy.endpointRegions || policy.endpointRegions.includes(deployment.endpointRegion)) &&
      (!policy.processingRegions ||
        (!!deployment.processingRegions?.length &&
          deployment.processingRegions.every((region) =>
            policy.processingRegions!.includes(region),
          ))) &&
      (!policy.processingScopes || policy.processingScopes.includes(deployment.scope)) &&
      (policy.fidelity !== 'native' || route.fidelity === 'native')
    );
  });
}

/** Validation and export use exactly the same canonical parser as admission. */
export function validatePlaygroundRequest(
  value: unknown,
  catalog: Catalog,
  modelId: string,
): GenerateInput {
  const request = parseGenerationRequest(value);
  if (request.modelId !== modelId)
    throw new Error(
      'Choose that exact model in the model picker before applying its settings. Your current form is unchanged.',
    );
  if (
    request.billing !== 'byok' &&
    (!Number.isSafeInteger(request.maxCostMicros) || request.maxCostMicros! <= 0)
  )
    throw new Error('Enter a positive managed spending limit.');
  if (request.maxCostMicros !== undefined && request.maxCostMicros <= 0)
    throw new Error('Enter a positive spending limit or omit it for BYOK.');
  if (request.routeId) {
    const route = catalog.routes.find((item) => item.id === request.routeId);
    if (!route) throw new Error('The selected exact regional route is not in this catalog.');
    const issues = validateRouteInput(request, route);
    if (issues.length)
      throw new Error(issues.map((issue) => `${issue.field}: ${issue.message}`).join('; '));
    if (request.routing?.fallback)
      throw new Error('A pinned regional route cannot enable provider fallback.');
  }
  return request;
}

/** Drafts may be incomplete, but are never restored under another namespace. */
export function isPlaygroundDraft(value: unknown): value is GenerateInput {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GenerateInput>;
  const allowed = new Set([
    'modelId',
    'operation',
    'input',
    'routeId',
    'routing',
    'billing',
    'maxCostMicros',
    'previousJobId',
  ]);
  return (
    Object.keys(candidate).every((key) => allowed.has(key)) &&
    typeof candidate.modelId === 'string' &&
    [
      'text-to-image',
      'image-edit',
      'text-to-video',
      'image-to-video',
      'reference-to-video',
      'video-edit',
      'video-extend',
    ].includes(candidate.operation ?? '') &&
    generationArgumentSchema.safeParse(candidate.input).success &&
    (candidate.routing === undefined || routingSchema.safeParse(candidate.routing).success) &&
    (candidate.routeId === undefined || typeof candidate.routeId === 'string') &&
    (candidate.previousJobId === undefined || typeof candidate.previousJobId === 'string') &&
    (candidate.billing === undefined ||
      candidate.billing === 'byok' ||
      candidate.billing === 'managed') &&
    (candidate.maxCostMicros === undefined ||
      (Number.isSafeInteger(candidate.maxCostMicros) && candidate.maxCostMicros >= 0))
  );
}
