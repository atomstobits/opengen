import { groupRoutesByProvider } from '@media-router/catalog';
import type { Deployment, Route } from '@media-router/contracts';

export { groupRoutesByProvider };

export interface ProviderRouteRow {
  route: Route;
  deploymentGroupSize: number;
  deploymentGroupIndex: number;
  isGroupStart: boolean;
  isGroupContinuation: boolean;
  isGroupEnd: boolean;
}

export function buildProviderRouteRows(
  routes: readonly Route[],
  deployments: ReadonlyMap<string, Deployment>,
  authorProviderIds: readonly string[] = [],
): ProviderRouteRow[] {
  const ordered = groupRoutesByProvider(routes, deployments, authorProviderIds);
  const counts = new Map<string, number>();
  for (const route of ordered) {
    counts.set(route.deploymentId, (counts.get(route.deploymentId) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return ordered.map((route) => {
    const deploymentGroupSize = counts.get(route.deploymentId) ?? 1;
    const deploymentGroupIndex = seen.get(route.deploymentId) ?? 0;
    seen.set(route.deploymentId, deploymentGroupIndex + 1);
    return {
      route,
      deploymentGroupSize,
      deploymentGroupIndex,
      isGroupStart: deploymentGroupIndex === 0,
      isGroupContinuation: deploymentGroupIndex > 0,
      isGroupEnd: deploymentGroupIndex === deploymentGroupSize - 1,
    };
  });
}
