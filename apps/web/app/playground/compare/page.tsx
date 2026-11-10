import { catalog } from '@media-router/catalog';
import { Footer, SiteHeader } from '../../ui';
import { pageMetadata } from '../../seo';
import { PrivateComparison } from './private-comparison';

export const metadata = pageMetadata({
  title: 'Private model comparison | OpenGen',
  description: 'Compare two image models on the same prompt in your OpenGen workspace.',
  path: '/playground/compare',
  noindex: true,
});

export default function ComparisonPage() {
  return (
    <>
      <SiteHeader active="playground" />
      <main className="playground-page page-width">
        <header className="browse-page-heading">
          <div>
            <span className="eyebrow">PLAYGROUND / COMPARISON</span>
            <h1>Compare two image models.</h1>
            <p>Give both models the same prompt and review their private results side by side.</p>
          </div>
          <a className="text-link" href="/playground">
            Back to single-request Playground
          </a>
        </header>
        <PrivateComparison catalog={catalog} />
      </main>
      <Footer />
    </>
  );
}
