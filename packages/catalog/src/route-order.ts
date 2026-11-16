import {
  canonicalModelId,
  type Catalog,
  type Deployment,
  type Route,
} from '@media-router/contracts';

/**
 * Groups routes by serving provider while placing explicit author-operated ("Official")
 * providers at the beginning of the model's provider / endpoint list.
 */
export function groupRoutesByProvider(
  routes: readonly Route[],
  deployments: ReadonlyMap<string, Deployment>,
  authorProviderIds: readonly string[] = [],
): Route[] {
  const groups = new Map<string, Route[]>();
  for (const route of routes) {
    const providerId = deployments.get(route.deploymentId)?.providerId ?? route.deploymentId;
    const group = groups.get(providerId);
    if (group) group.push(route);
    else groups.set(providerId, [route]);
  }
  const official: Route[][] = [];
  for (const providerId of authorProviderIds) {
    const group = groups.get(providerId);
    if (group) {
      official.push(group);
      groups.delete(providerId);
    }
  }
  return [...official, ...groups.values()].flat();
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
