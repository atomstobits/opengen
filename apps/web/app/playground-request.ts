import { groupRoutesByProvider } from '@media-router/catalog';
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

export interface OperationRouteSwitch {
  routeId?: string;
  outcome: 'kept' | 'switched-sibling' | 'ambiguous-sibling' | 'cleared-unsupported' | 'none';
  switchedRoute?: Route;
}

/**
 * When changing operation while pinned to a feature-split route, preserve the deployment pin only
 * when a single unambiguous sibling route on that exact deployment supports the new operation.
 */
export function resolveOperationRouteSwitch(
  routes: readonly Route[],
  previousRouteId: string | undefined,
  nextOperation: Operation,
): OperationRouteSwitch {
  if (!previousRouteId) return { outcome: 'none' };
  const previous = routes.find((route) => route.id === previousRouteId);
  if (!previous) return { outcome: 'none' };
  const available = routes.filter((route) => route.operations.includes(nextOperation));
  if (available.some((route) => route.id === previousRouteId)) {
    return { routeId: previousRouteId, outcome: 'kept' };
  }
  const sameDeployment = available.filter((route) => route.deploymentId === previous.deploymentId);
  if (sameDeployment.length === 1) {
    return {
      routeId: sameDeployment[0]!.id,
      outcome: 'switched-sibling',
      switchedRoute: sameDeployment[0]!,
    };
  }
  if (sameDeployment.length > 1) return { outcome: 'ambiguous-sibling' };
  return { outcome: 'cleared-unsupported' };
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
  const deploymentMap = new Map(deployments.map((deployment) => [deployment.id, deployment]));
  return groupRoutesByProvider(
    routes.filter((route) => {
      const deployment = deploymentMap.get(route.deploymentId);
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
    }),
    deploymentMap,
    model.authorProviderIds,
  );
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

/** Returns true when a draft's routing restrictions exclude a candidate sibling route. */
export function siblingRouteRoutingConflict(
  model: Catalog['models'][number],
  route: Route,
  deployments: Catalog['deployments'],
  draft: GenerateInput,
): boolean {
  if (!draft.routing) return false;
  return eligibleReuseRoutes(model, [route], deployments, draft, draft.operation).length === 0;
}

/** Removes only the routing restrictions that conflict with a chosen route, keeping compatible preferences. */
export function clearConflictingRoutingFilters(
  model: Catalog['models'][number],
  route: Route,
  deployments: Catalog['deployments'],
  routing?: GenerateInput['routing'],
): NonNullable<GenerateInput['routing']> {
  if (!routing) return {};
  const deployment = deployments.find((entry) => entry.id === route.deploymentId);
  const next: NonNullable<GenerateInput['routing']> = { ...routing };
  if (next.modelIds && !next.modelIds.includes(model.id)) delete next.modelIds;
  if (deployment) {
    if (next.deploymentIds && !next.deploymentIds.includes(deployment.id))
      delete next.deploymentIds;
    if (next.providerIds && !next.providerIds.includes(deployment.providerId))
      delete next.providerIds;
    if (next.modelProviderExceptions) {
      const exception = next.modelProviderExceptions.find((item) => item.modelId === model.id);
      if (exception && !exception.providerIds.includes(deployment.providerId)) {
        const remaining = next.modelProviderExceptions.filter((item) => item.modelId !== model.id);
        if (remaining.length) next.modelProviderExceptions = remaining;
        else delete next.modelProviderExceptions;
      }
    }
    if (next.authorOnly && !model.authorProviderIds.includes(deployment.providerId))
      delete next.authorOnly;
    if (next.endpointRegions && !next.endpointRegions.includes(deployment.endpointRegion))
      delete next.endpointRegions;
    if (
      next.processingRegions &&
      (!deployment.processingRegions?.length ||
        !deployment.processingRegions.every((region) => next.processingRegions!.includes(region)))
    )
      delete next.processingRegions;
    if (next.processingScopes && !next.processingScopes.includes(deployment.scope))
      delete next.processingScopes;
  }
  if (next.fidelity === 'native' && route.fidelity !== 'native') delete next.fidelity;
  return next;
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
