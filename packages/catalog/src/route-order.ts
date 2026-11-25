import {
  canonicalModelId,
  operationOrder,
  sortOperations,
  type Catalog,
  type Deployment,
  type Route,
} from '@media-router/contracts';

function routeOperationRank(route: Route): number {
  const ordered = sortOperations(route.operations);
  const first = ordered[0];
  return first ? operationOrder.indexOf(first) : operationOrder.length;
}

/**
 * Groups routes by serving provider while placing explicit author-operated ("Official")
 * providers first, keeping same-deployment sibling routes contiguous in canonical operation order.
 */
export function groupRoutesByProvider(
  routes: readonly Route[],
  deployments: ReadonlyMap<string, Deployment>,
  authorProviderIds: readonly string[] = [],
): Route[] {
  const groups = new Map<string, Map<string, Route[]>>();
  for (const route of routes) {
    const providerId = deployments.get(route.deploymentId)?.providerId ?? route.deploymentId;
    let deploymentGroups = groups.get(providerId);
    if (!deploymentGroups) {
      deploymentGroups = new Map<string, Route[]>();
      groups.set(providerId, deploymentGroups);
    }
    const group = deploymentGroups.get(route.deploymentId);
    if (group) group.push(route);
    else deploymentGroups.set(route.deploymentId, [route]);
  }
  const official: Map<string, Route[]>[] = [];
  for (const providerId of authorProviderIds) {
    const group = groups.get(providerId);
    if (group) {
      official.push(group);
      groups.delete(providerId);
    }
  }
  const ordered: Route[] = [];
  for (const deploymentGroups of [...official, ...groups.values()]) {
    for (const group of deploymentGroups.values()) {
      if (group.length > 1) {
        ordered.push(
          ...[...group].sort(
            (a, b) =>
              routeOperationRank(a) - routeOperationRank(b) ||
              (a.feature?.id ?? '').localeCompare(b.feature?.id ?? ''),
          ),
        );
      } else {
        ordered.push(...group);
      }
    }
  }
  return ordered;
}

export function selectModelRoutes(
  modelId: string,
  sourceCatalog: Pick<Catalog, 'models' | 'deployments' | 'routes'>,
): Route[] {
  const canonicalId = canonicalModelId(modelId);
  const model = sourceCatalog.models.find((item) => item.id === canonicalId);
  const deployments = new Map(sourceCatalog.deployments.map((item) => [item.id, item]));
  return groupRoutesByProvider(
    sourceCatalog.routes.filter((route) => route.modelId === canonicalId),
    deployments,
    model?.authorProviderIds ?? [],
  );
}
