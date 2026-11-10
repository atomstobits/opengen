import type { Deployment, Route } from '@media-router/contracts';

export function groupRoutesByProvider(
  routes: Route[],
  deployments: ReadonlyMap<string, Deployment>,
): Route[] {
  const groups = new Map<string, Route[]>();
  for (const route of routes) {
    const providerId = deployments.get(route.deploymentId)?.providerId ?? route.deploymentId;
    const group = groups.get(providerId);
    if (group) group.push(route);
    else groups.set(providerId, [route]);
  }
  return [...groups.values()].flat();
}
