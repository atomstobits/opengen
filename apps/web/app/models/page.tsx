import { catalog } from '@media-router/catalog';
import { ModelsCatalog } from '../catalog-browser';
import { Footer, SiteHeader } from '../ui';
import { JsonLd, modelsStructuredData, pageMetadata } from '../seo';

type SearchParams = Record<string, string | string[] | undefined>;
export async function generateMetadata({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  return pageMetadata({
    title: 'Image & video AI model catalog | OpenGen',
    description:
      'Explore image and video generation models. Compare exact variants, regional API providers and source-linked pricing, then choose a model for your next project.',
    path: '/models',
    noindex: Object.keys(query).length > 0,
  });
}
export default async function ModelsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const region =
    typeof query.region === 'string' &&
    catalog.deployments.some((deployment) => deployment.endpointRegion === query.region)
      ? query.region
      : 'all';
  return (
    <>
      {Object.keys(query).length === 0 && <JsonLd data={modelsStructuredData()} />}
      <SiteHeader active="catalog" />
      <main className="models-page page-width">
        <header className="browse-page-heading">
          <div>
            <span className="eyebrow">THE MODEL CATALOG</span>
            <h1>Find your next model.</h1>
            <p>
              Explore image and video models. Open a model to compare its variations, providers and
              regions.
            </p>
          </div>
          <a className="text-link" href="/playground">
            Already have a model? Start creating ↗
          </a>
        </header>
        <ModelsCatalog
          catalog={catalog}
          initialQuery={typeof query.q === 'string' ? query.q : ''}
          initialModality={
            query.modality === 'image' || query.modality === 'video' ? query.modality : 'all'
          }
          initialRegion={region}
        />
        <p className="collection-note">
          Pricing and capabilities belong to each provider route. Original sources are linked on
          every model page; unmeasured performance remains unknown.
        </p>
      </main>
      <Footer />
    </>
  );
}
