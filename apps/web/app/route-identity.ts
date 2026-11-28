import {
  routeFeatureDiscriminator,
  type Catalog,
  type Deployment,
  type Operation,
  type Provider,
  type Route,
} from '@media-router/contracts';

export const regionNames: Record<string, string> = {
  'cn-beijing': 'CN',
  'ap-southeast-1': 'SG',
  'ap-northeast-1': 'JP',
  'eu-central-1': 'DE',
  'us-east-1': 'US',
  'cn-hongkong': 'HK',
  global: 'Global endpoint',
};

export function isDisclosedRegion(region: string | null | undefined): region is string {
  if (!region) return false;
  const normalized = region.trim().toLowerCase();
  return normalized.length > 0 && normalized !== 'undisclosed' && normalized !== 'unknown';
}

export function formatDisclosedRegion(region: string | null | undefined): string | null {
  if (!isDisclosedRegion(region)) return null;
  return regionNames[region] ?? region;
}

export function formatRouteLabel(identity: { label: string; region: string | null }): string {
  return identity.region ? `${identity.label} · ${identity.region}` : identity.label;
}

export function formatDeploymentLabel(
  deployment: Pick<Deployment, 'name' | 'endpointRegion'>,
  provider?: Pick<Provider, 'name'>,
): string {
  const baseName = deployment.name.replace(/\s*·\s*Region undisclosed$/i, '').trim();
  const region = formatDisclosedRegion(deployment.endpointRegion);
  if (!region) {
    return baseName || provider?.name || deployment.name;
  }
  const service = baseName.split(' · ')[0] || baseName;
  const head =
    provider?.name && service !== provider.name ? `${provider.name} · ${service}` : service;
  return `${head} · ${region}`;
}

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
    region: formatDisclosedRegion(deployment?.endpointRegion),
  };
}
