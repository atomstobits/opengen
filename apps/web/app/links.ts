import { canonicalModelId, type Operation } from '@media-router/contracts';
/** Shared URL construction is usable by both server-rendered pages and client controls. */
export function playgroundHref(
  modelId?: string,
  routeId?: string,
  operation?: Operation,
  region?: string,
): string {
  const query = new URLSearchParams();
  if (modelId) query.set('model', canonicalModelId(modelId));
  if (operation) query.set('operation', operation);
  if (routeId) query.set('route', routeId);
  else if (region) query.set('region', region);
  return `/playground${query.size ? `?${query.toString()}` : ''}`;
}
