import type { Catalog, Operation, Route, RouteAlias, RoutePublishedPricing, Source } from './index';

/** Resolves the concrete upstream endpoint/model ID for a route and operation. */
export function resolveRouteUpstreamModelId(
  route: Pick<Route, 'upstreamModelId' | 'upstreamEndpoints'>,
  operation?: Operation,
): string {
  return (operation ? route.upstreamEndpoints?.[operation] : undefined) ?? route.upstreamModelId;
}

/** Returns every distinct upstream endpoint/model ID backed by a route. */
export function routeUpstreamModelIds(
  route: Pick<Route, 'upstreamModelId' | 'upstreamEndpoints'>,
): string[] {
  const endpoints = route.upstreamEndpoints
    ? Object.values(route.upstreamEndpoints).filter((value): value is string => Boolean(value))
    : [];
  return endpoints.length ? [...new Set(endpoints)] : [route.upstreamModelId];
}

/** Returns the supported output resolutions for a route under an optional operation lens. */
export function routeResolutionsForOperation(
  route: Pick<Route, 'resolutions' | 'operationCapabilities'>,
  operation?: Operation,
): string[] {
  const override = operation ? route.operationCapabilities?.[operation]?.resolutions : undefined;
  return override ?? route.resolutions;
}

/** Returns the supported output durations for a route under an optional operation lens. */
export function routeDurationsForOperation(
  route: Pick<Route, 'durations' | 'operationCapabilities'>,
  operation?: Operation,
): number[] {
  const override = operation ? route.operationCapabilities?.[operation]?.durations : undefined;
  return override ?? route.durations;
}

/** Returns the pricing evidence source for a route under an optional operation lens. */
export function routePricingSourceForOperation(
  route: Pick<Route, 'pricingSource' | 'operationCapabilities'>,
  operation?: Operation,
): Source {
  return (
    (operation ? route.operationCapabilities?.[operation]?.pricingSource : undefined) ??
    route.pricingSource
  );
}

/** Returns the provider documentation source for a route under an optional operation lens. */
export function routeSourceForOperation(
  route: Pick<Route, 'source' | 'operationCapabilities'>,
  operation?: Operation,
): Source {
  return (operation ? route.operationCapabilities?.[operation]?.source : undefined) ?? route.source;
}

/** Returns the published tariff metadata for a route under an optional operation lens. */
export function routePublishedPricingForOperation(
  route: Pick<Route, 'publishedPricing' | 'operationCapabilities'>,
  operation?: Operation,
): RoutePublishedPricing | undefined {
  return (
    (operation ? route.operationCapabilities?.[operation]?.publishedPricing : undefined) ??
    route.publishedPricing
  );
}

export interface ResolvedCatalogRoute {
  route: Route;
  alias?: RouteAlias;
}

/** Resolves a canonical route ID or a registered RouteAlias against a catalog snapshot. */
export function resolveCatalogRoute(
  catalog: Pick<Catalog, 'routes' | 'routeAliases'>,
  id: string,
): ResolvedCatalogRoute | undefined {
  const direct = catalog.routes.find((route) => route.id === id);
  if (direct) return { route: direct };
  const alias = catalog.routeAliases?.find((entry) => entry.id === id);
  if (!alias) return undefined;
  const target = catalog.routes.find((route) => route.id === alias.routeId);
  return target ? { route: target, alias } : undefined;
}

export const operationLabels: Record<Operation, string> = {
  'text-to-image': 'Text to image',
  'image-edit': 'Image editing',
  'text-to-video': 'Text to video',
  'image-to-video': 'Image to video',
  'reference-to-video': 'Reference to video',
  'video-edit': 'Video editing',
  'video-extend': 'Video extension',
};

export const operationOrder: readonly Operation[] = [
  'text-to-image',
  'image-edit',
  'text-to-video',
  'image-to-video',
  'reference-to-video',
  'video-edit',
  'video-extend',
];

export function operationLabel(operation: Operation): string {
  return operationLabels[operation];
}

export function sortOperations(operations: readonly Operation[]): Operation[] {
  return [...new Set(operations)].sort(
    (a, b) => operationOrder.indexOf(a) - operationOrder.indexOf(b),
  );
}

/** Deterministic uniqueness signature for sibling routes sharing (modelId, deploymentId). */
export function routeFeatureSignature(route: Pick<Route, 'operations' | 'feature'>): string {
  const operations = [...new Set(route.operations)].sort().join(',');
  return `${operations}|${route.feature?.id ?? ''}`;
}

export interface RouteFeatureDescriptor {
  operations: Operation[];
  operationLabels: string[];
  featureLabel: string | null;
  featureSummary: string | null;
  scopeLabel: string;
  badges: string[];
}

export function describeRouteFeatures(
  route: Pick<Route, 'operations' | 'feature'>,
): RouteFeatureDescriptor {
  const operations = sortOperations(route.operations);
  const labels = operations.map(operationLabel);
  const featureLabel = route.feature?.label?.trim() || null;
  const featureSummary = route.feature?.summary?.trim() || null;
  const scopeLabel =
    labels.length === 1
      ? featureLabel
        ? `${labels[0]} · ${featureLabel}`
        : labels[0]!
      : featureLabel
        ? `${featureLabel}${labels.length ? ` (${labels.join(', ')})` : ''}`
        : labels.join(', ');
  const badges = featureLabel ? [...labels, featureLabel] : labels;
  return {
    operations,
    operationLabels: labels,
    featureLabel,
    featureSummary,
    scopeLabel,
    badges,
  };
}

export type RouteScopeLike = Pick<Route, 'modelId' | 'deploymentId' | 'operations' | 'feature'>;

/** True when a variant's routes differ in supported operations, split a deployment, or declare sub-operation features. */
export function variantHasFeatureDistinctions(routes: readonly RouteScopeLike[]): boolean {
  if (!routes.length) return false;
  const seenDeployments = new Set<string>();
  const baselineSignature = routeFeatureSignature(routes[0]!);
  for (const route of routes) {
    if (route.feature) return true;
    if (seenDeployments.has(route.deploymentId)) return true;
    seenDeployments.add(route.deploymentId);
    if (routeFeatureSignature(route) !== baselineSignature) return true;
  }
  return false;
}

/**
 * Plain-language feature discriminator appended to provider/deployment labels when needed to
 * distinguish feature-split or narrower-scope routes from sibling routes of the same variant.
 */
export function routeFeatureDiscriminator(
  route: RouteScopeLike,
  variantRoutes: readonly RouteScopeLike[],
  activeOperation?: Operation,
): string | null {
  const active = variantRoutes.filter((item) => item.modelId === route.modelId);
  const sameDeployment = active.filter((item) => item.deploymentId === route.deploymentId);
  const variantOperations = new Set(active.flatMap((item) => item.operations));
  const isSplitDeployment = sameDeployment.length > 1;
  const isNarrowerThanVariant =
    variantOperations.size > 1 && route.operations.length < variantOperations.size;
  const mismatch = activeOperation !== undefined && !route.operations.includes(activeOperation);
  const descriptor = describeRouteFeatures(route);

  if (activeOperation !== undefined && !mismatch) {
    if (descriptor.featureLabel) return descriptor.featureLabel;
    if (descriptor.operations.length === 1 && (isSplitDeployment || isNarrowerThanVariant)) {
      return descriptor.operationLabels[0]!;
    }
    return null;
  }
  if (descriptor.featureLabel || isSplitDeployment || isNarrowerThanVariant || mismatch) {
    return descriptor.scopeLabel || null;
  }
  return null;
}
