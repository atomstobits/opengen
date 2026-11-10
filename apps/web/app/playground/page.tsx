import { canonicalModelId, type Operation } from '@media-router/contracts';
import { generationOperations } from '@media-router/contracts/generation';
import { playgroundHref } from '../links';
import { notFound, permanentRedirect } from 'next/navigation';
import { catalog } from '@media-router/catalog';
import { PlaygroundApp } from '../catalog-browser';
import { Footer, SiteHeader } from '../ui';
import { pageMetadata, siteOrigin } from '../seo';

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
  const route = catalog.routes.find((item) => item.id === routeQuery && item.status !== 'retired');
  if (routeQuery !== undefined && !route) notFound();
  const modelId = typeof modelQuery === 'string' ? canonicalModelId(modelQuery) : route?.modelId;
  if (modelId !== undefined && !catalog.models.some((model) => model.id === modelId)) notFound();
  if (route && route.modelId !== modelId) notFound();
  const operation = operationQuery as Operation | undefined;
  const region = typeof regionQuery === 'string' ? regionQuery : undefined;
  const routes = route
    ? [route]
    : catalog.routes.filter(
        (item) => item.modelId === (modelId ?? 'alibaba/wan-3.0') && item.status !== 'retired',
      );
  if (operation && !generationOperations.includes(operation)) notFound();
  if (operationQuery !== undefined || regionQuery !== undefined) {
    if (
      !routes.some(
        (item) =>
          (operation === undefined || item.operations.includes(operation)) &&
          (region === undefined ||
            catalog.deployments.some(
              (deployment) =>
                deployment.id === item.deploymentId && deployment.endpointRegion === region,
            )),
      )
    )
      notFound();
  }
  if (typeof modelQuery === 'string' && modelQuery !== modelId)
    permanentRedirect(playgroundHref(modelId, route?.id, operation, region));
  return (
    <>
      <SiteHeader active="playground" />
      <main className="playground-page page-width">
        <header className="browse-page-heading">
          <div>
            <span className="eyebrow">THE PLAYGROUND</span>
            <h1>Bring your idea to life.</h1>
            <p>Choose a model, add your inputs and get a quote before you create.</p>
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
          initialModelId={modelId}
          initialRouteId={route?.id}
          initialOperation={operation}
          initialRegion={route ? undefined : region}
          gatewayOrigin={siteOrigin()}
        />
      </main>
      <Footer />
    </>
  );
}
