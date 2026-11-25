import type { Operation, Route } from './index';

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
