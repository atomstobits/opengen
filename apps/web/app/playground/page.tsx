import { canonicalModelId, type Operation } from '@media-router/contracts';
import { generationOperations } from '@media-router/contracts/generation';
import { playgroundHref } from '../links';
import { notFound, permanentRedirect } from 'next/navigation';
import { catalog, resolveRoute } from '@media-router/catalog';
import { PlaygroundApp } from '../catalog-browser';
import { Footer, SiteHeader } from '../ui';
import { pageMetadata, siteOrigin } from '../seo';

const DEFAULT_PLAYGROUND_MODEL_ID = 'openai/gpt-image-2';

export const metadata = pageMetadata({
  title: 'Image & video playground | OpenGen',
  description:
    'Choose a model, describe your idea and create an image or video through your OpenGen workspace.',
  path: '/playground',
  noindex: true,
});
type SearchParams = Record<string, string | string[] | undefined>;
export default async function PlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const {
    model: modelQuery,
    operation: operationQuery,
    region: regionQuery,
    route: routeQuery,
  } = query;
  if ([modelQuery, operationQuery, regionQuery, routeQuery].some(Array.isArray)) notFound();
  const resolvedRoute = typeof routeQuery === 'string' ? resolveRoute(routeQuery) : undefined;
  const route =
    resolvedRoute && resolvedRoute.route.status !== 'retired' ? resolvedRoute.route : undefined;
  if (routeQuery !== undefined && !route) notFound();
  const modelId = typeof modelQuery === 'string' ? canonicalModelId(modelQuery) : route?.modelId;
  if (modelId !== undefined && !catalog.models.some((model) => model.id === modelId)) notFound();
  if (route && route.modelId !== modelId) notFound();
  const operation = operationQuery as Operation | undefined;
  if (operation && !generationOperations.includes(operation)) notFound();
  if (
    resolvedRoute?.alias?.operation &&
    operation !== undefined &&
    operation !== resolvedRoute.alias.operation
  )
    notFound();
  const effectiveOperation = operation ?? resolvedRoute?.alias?.operation;
  const region = typeof regionQuery === 'string' ? regionQuery : undefined;
  const routes = route
    ? [route]
    : catalog.routes.filter(
        (item) =>
          item.modelId === (modelId ?? DEFAULT_PLAYGROUND_MODEL_ID) && item.status !== 'retired',
      );
  if (effectiveOperation !== undefined || regionQuery !== undefined) {
    if (
      !routes.some(
        (item) =>
          (effectiveOperation === undefined || item.operations.includes(effectiveOperation)) &&
          (region === undefined ||
            catalog.deployments.some(
              (deployment) =>
                deployment.id === item.deploymentId && deployment.endpointRegion === region,
            )),
      )
    )
      notFound();
  }
  if (
    (typeof modelQuery === 'string' && modelQuery !== modelId) ||
    (typeof routeQuery === 'string' && route && routeQuery !== route.id)
  )
    permanentRedirect(playgroundHref(modelId, route?.id, effectiveOperation, region));
  return (
    <>
      <SiteHeader active="playground" />
      <main className="playground-page page-width">
        <header className="browse-page-heading">
          <div>
            <span className="eyebrow">THE PLAYGROUND</span>
            <h1>Bring your idea to life.</h1>
            <p>Choose a model, describe your result and get a quote before you create.</p>
            <p>
              <a className="text-link" href="/guides/image-to-video">
                Image-to-video guide ↗
              </a>
            </p>
          </div>
          <div className="playground-page-links">
            <a className="text-link" href="/models">
              Explore model catalog ↗
            </a>
            <a className="text-link" href="/playground/compare">
              Compare models privately ↗
            </a>
          </div>
        </header>
        <PlaygroundApp
          catalog={catalog}
          initialModelId={modelId ?? DEFAULT_PLAYGROUND_MODEL_ID}
          initialRouteId={route?.id}
          initialOperation={effectiveOperation}
          initialRegion={route ? undefined : region}
          gatewayOrigin={siteOrigin()}
        />
      </main>
      <Footer />
    </>
  );
}
