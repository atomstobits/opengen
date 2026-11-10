import { canonicalModelId } from '@media-router/contracts';
import { notFound, permanentRedirect } from 'next/navigation';
import { catalog, modelSeries, seriesHref } from '@media-router/catalog';
import { Footer, HomeHero, Icon, SiteHeader } from './ui';
import { SeriesCards } from './company-cards';
import {
  HomeOverview,
  JsonLd,
  homeStructuredData,
  pageMetadata,
  SITE_DESCRIPTION,
  canonicalUrl,
} from './seo';

type SearchParams = Record<string, string | string[] | undefined>;
export const metadata = pageMetadata({
  title: 'OpenGen — compare image & video generation API providers',
  description: SITE_DESCRIPTION,
  path: '/',
});

export default async function Home({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const query = await searchParams;
  if (query.view !== undefined || query.model !== undefined || query.route !== undefined) {
    if (query.view === 'playground' || query.route !== undefined) {
      const target = new URLSearchParams();
      for (const key of ['model', 'route'] as const) {
        const value = query[key];
        if (value !== undefined && typeof value !== 'string') notFound();
        if (value) target.set(key, key === 'model' ? canonicalModelId(value) : value);
      }
      permanentRedirect(`/playground${target.size ? `?${target}` : ''}`);
    }
    if (typeof query.model === 'string') {
      const modelId = canonicalModelId(query.model);
      if (!catalog.models.some((model) => model.id === modelId)) notFound();
      const canonical = seriesHref(modelId);
      if (!canonical) notFound();
      permanentRedirect(canonical);
    }
    permanentRedirect('/models');
  }
  const featured = ['bytedance/seedance-2.5', 'google/nano-banana-2.1', 'minimax/h3'].flatMap(
    (id) => {
      const series = modelSeries.find((item) => item.id === id);
      return series ? [series] : [];
    },
  );
  return (
    <>
      <JsonLd data={homeStructuredData()} />
      <SiteHeader overlay />
      <main>
        <HomeHero
          agentUrl={canonicalUrl('/llms.txt')}
          heroVideoUrl={process.env.OPENGEN_HERO_VIDEO_URL}
          heroPosterUrl={process.env.OPENGEN_HERO_POSTER_URL}
        />
        <section
          className="home-discovery page-width"
          id="catalog"
          aria-labelledby="featured-models-title"
        >
          <div className="section-heading">
            <div>
              <span className="eyebrow">START WITH A MODEL</span>
              <h2 id="featured-models-title">Find a model for your next idea.</h2>
            </div>
            <a className="text-link" href="/models">
              Explore all {catalog.models.length} models <Icon name="arrow" size={16} />
            </a>
          </div>
          <SeriesCards series={featured} compact />
        </section>
        <section className="home-pricing page-width" aria-labelledby="home-pricing-title">
          <h2 id="home-pricing-title">0% markup on direct routes.</h2>
          <p className="home-pricing-equation">
            provider estimate <strong>+ $0.000 OpenGen markup</strong> = your quote
          </p>
          <p>Provider charges apply. Review your quote before generating.</p>
        </section>
        <HomeOverview />
      </main>
      <Footer />
    </>
  );
}
