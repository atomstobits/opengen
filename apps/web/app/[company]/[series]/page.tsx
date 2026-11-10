import { canonicalModelId } from '@media-router/contracts';
import { getGenerationDefinition } from '@media-router/contracts/generation';
import type { Metadata } from 'next';
import { notFound, redirect, permanentRedirect } from 'next/navigation';
import {
  catalog,
  getCompany,
  getModel,
  getSeries,
  modelSeries,
  seriesHref,
} from '@media-router/catalog';
import { Footer, Icon, SiteHeader, CopyButton } from '../../ui';
import { playgroundHref } from '../../links';
import { SeriesProviders } from '../../series-content';
import { JsonLd, seriesMetadata, seriesStructuredData, seriesReviewDate } from '../../seo';

type Props = {
  params: Promise<{ company: string; series: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};
export function generateStaticParams() {
  return modelSeries.map((series) => {
    const [company, slug] = series.id.split('/');
    return { company, series: slug };
  });
}
export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { company, series: slug } = await params;
  const series = getSeries(`${company}/${slug}`);
  const query = await searchParams;
  if (
    !series ||
    (typeof query.variant === 'string' &&
      !series.modelIds.includes(canonicalModelId(query.variant)))
  )
    return { title: 'Model series not found — OpenGen', robots: { index: false, follow: true } };
  return seriesMetadata(series);
}
export default async function ModelSeriesPage({ params, searchParams }: Props) {
  const { company: companySlug, series: slug } = await params;
  const id = `${companySlug}/${slug}`;
  const series = getSeries(id);
  if (!series) {
    const exact = getModel(id);
    const canonical = exact ? seriesHref(exact.id) : undefined;
    if (canonical) {
      if (canonicalModelId(id) !== id) permanentRedirect(canonical);
      redirect(canonical);
    }
    notFound();
  }
  const company = getCompany(series.companyId);
  if (!company) notFound();
  const query = await searchParams;
  const selectedVariant =
    typeof query.variant === 'string' ? canonicalModelId(query.variant) : undefined;
  if (selectedVariant && !series.modelIds.includes(selectedVariant)) notFound();
  if (typeof query.variant === 'string' && query.variant !== selectedVariant) {
    const canonical = selectedVariant ? seriesHref(selectedVariant) : undefined;
    if (canonical) permanentRedirect(canonical);
  }
  const models = series.modelIds.flatMap((modelId) => {
    const model = getModel(modelId);
    return model ? [model] : [];
  });
  const routes = catalog.routes.filter((route) => series.modelIds.includes(route.modelId));
  const servingProviderIds = new Set(
    routes.flatMap((route) => {
      const deployment = catalog.deployments.find((item) => item.id === route.deploymentId);
      return deployment ? [deployment.providerId] : [];
    }),
  );
  const first = models[0]!;
  return (
    <>
      <JsonLd data={seriesStructuredData(series)} />
      <SiteHeader active="catalog" />
      <main className="series-page page-width" data-media={first.modality}>
        <div className="page-breadcrumb">
          <a href="/models">Models</a>
          <span>/</span>
          <a href={`/${company.id}`}>{company.name}</a>
          <span>/</span>
          <span>{series.name}</span>
        </div>
        <header className="series-hero">
          <div className="series-hero-copy">
            <div className="hero-kicker">
              <span className="status-dot" />
              <a href={`/${company.id}`}>{company.name}</a>
              <span>/</span> MODEL SERIES
            </div>
            <h1>{series.name}</h1>
            <div className="series-canonical-id">
              <code>{series.id}</code>
              <CopyButton text={series.id} label="Copy series ID" />
            </div>
            <p>{series.description}</p>
            <div className="series-hero-actions">
              <a className="button button-dark" href={playgroundHref(selectedVariant ?? first.id)}>
                Open playground <Icon name="arrow" size={15} />
              </a>
              <a className="text-link" href={first.source.url} target="_blank" rel="noreferrer">
                Original model <Icon name="external" size={14} />
              </a>
            </div>
          </div>
          <div className="company-stats">
            <div>
              <strong>{models.length}</strong>
              <span>{models.length === 1 ? 'exact variant' : 'exact variants'}</span>
            </div>
            <div>
              <strong>{servingProviderIds.size}</strong>
              <span>serving providers</span>
            </div>
            <div>
              <strong>{routes.length}</strong>
              <span>regional routes</span>
            </div>
          </div>
        </header>
        <div className="series-layout">
          <aside className="series-sidebar" aria-label="Series navigation">
            <a className="series-sidebar-overview" href="#providers">
              Providers <span>{routes.length}</span>
            </a>
            <span className="eyebrow">VARIANTS</span>
            {models.map((model) => (
              <a
                key={model.id}
                href={`#variant-${model.id.replaceAll('/', '-')}`}
                className={selectedVariant === model.id ? 'selected' : ''}
              >
                <strong>{model.name}</strong>
                <small>by {model.creator}</small>
              </a>
            ))}
            <a className="series-sidebar-about" href="#about">
              About this series
            </a>
          </aside>
          <div className="series-main">
            <SeriesProviders catalog={catalog} models={models} selectedVariant={selectedVariant} />
            <section className="series-about" id="about">
              <span className="eyebrow">MODEL IDENTITY & EVIDENCE</span>
              <h2>About {series.name} API access</h2>
              <p>
                This series belongs to <a href={`/${company.id}`}>{company.name}</a>. Each variant
                keeps its own API model ID, author, license and provider routes. A provider switch
                preserves the selected variant.
              </p>
              <h3>Which variants are included?</h3>
              <p>
                {models.map((model) => model.name).join(', ')}. Their exact model IDs, authors and
                licenses are listed separately above.
              </p>
              <h3>Which providers are listed?</h3>
              <p>
                {catalog.providers
                  .filter((provider) => servingProviderIds.has(provider.id))
                  .map((provider) => provider.name)
                  .join(', ')}
                . Every documented regional deployment has its own provider row; a listed offering
                is not a claim that credentials are configured or that a live generation was tested.
              </p>
              <h3>How are prices and performance compared?</h3>
              <p>
                The table lists supported resolutions and shows available prices per video second or
                image. The price details include the provider's billing terms and source. Latency
                percentiles and technical success rates use this installation's observations.
                Missing measurements remain unknown, and generation success is not provider uptime.
              </p>
              {routes.some(
                (route) =>
                  (!selectedVariant || route.modelId === selectedVariant) &&
                  route.operations.includes('image-to-video') &&
                  getGenerationDefinition(route.modelId, 'image-to-video')?.capabilities.frames
                    .first,
              ) && (
                <p>
                  Working with a reference image?{' '}
                  <a href="/guides/image-to-video">Follow the image-to-video walkthrough</a> for
                  private uploads, model inspection, quotes and retrieval.
                </p>
              )}
              <div className="series-license-list">
                {models.map((model) => (
                  <div key={model.id}>
                    <strong>{model.name}</strong>
                    <span>{model.license}</span>
                    <a href={model.source.url} target="_blank" rel="noreferrer">
                      Source ↗
                    </a>
                  </div>
                ))}
              </div>
              <p className="detail-note">
                Latest catalog source check: {seriesReviewDate(series)}. Documented offerings are
                not live-verification claims. Published prices retain their own units; missing
                prices and measurements remain unknown.
              </p>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
