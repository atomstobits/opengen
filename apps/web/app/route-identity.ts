import {
  routeFeatureDiscriminator,
  type Catalog,
  type Operation,
  type Route,
} from '@media-router/contracts';

export const regionNames: Record<string, string> = {
  'cn-beijing': 'Beijing, China',
  'ap-southeast-1': 'Singapore',
  'ap-northeast-1': 'Tokyo, Japan',
  'eu-central-1': 'Frankfurt, Germany',
  'us-east-1': 'Virginia, US',
  'cn-hongkong': 'Hong Kong, China',
  global: 'Global endpoint',
  undisclosed: 'Not disclosed',
  unknown: 'Not disclosed',
};

export function routeIdentity(
  catalog: Catalog,
  route: Route,
  activeOperation?: Operation,
  variantRoutes?: readonly Route[],
) {
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId);
  const provider = catalog.providers.find((entry) => entry.id === deployment?.providerId);
  const service = deployment?.name.split(' · ')[0];
  const scopedRoutes =
    variantRoutes ??
    catalog.routes.filter((entry) => entry.modelId === route.modelId && entry.status !== 'retired');
  const feature = routeFeatureDiscriminator(route, scopedRoutes, activeOperation);
  return {
    label:
      [
        provider?.name,
        service !== provider?.name ? service : undefined,
        route.providerModelName,
        feature,
      ]
        .filter(Boolean)
        .join(' · ') || route.id,
    feature,
    summary: route.feature?.summary ?? null,
    region: deployment
      ? (regionNames[deployment.endpointRegion] ?? deployment.endpointRegion)
      : 'Not disclosed',
  };
}
