import { imageToVideoGuide } from '@media-router/contracts';
import { JsonLd, canonicalUrl, pageMetadata, siteOrigin } from '../../seo';
import { Footer, SiteHeader } from '../../ui';
import { GuideBlocks, parseGuide } from './guide-content';
import styles from './guide.module.css';

export const metadata = pageMetadata({
  title: 'Image-to-video guide with a private reference | OpenGen',
  description:
    'Upload an owned image, inspect an exact video model, review a quote, submit once and retrieve the same private OpenGen job through the CLI or MCP.',
  path: '/guides/image-to-video',
});

export default function ImageToVideoGuidePage() {
  const origin = siteOrigin();
  const guide = parseGuide(imageToVideoGuide(origin));
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: guide.title,
          url: canonicalUrl('/guides/image-to-video'),
          description: metadata.description,
          publisher: { '@id': `${canonicalUrl('/')}#organization` },
          isPartOf: { '@id': `${canonicalUrl('/')}#website` },
        }}
      />
      <SiteHeader />
      <main className="docs-page page-width">
        <nav className="page-breadcrumb" aria-label="Breadcrumb">
          <a href="/docs">Documentation</a>
          <span aria-hidden="true">/</span>
          <span>Image to video</span>
        </nav>
        <span className="eyebrow">IMAGE TO VIDEO / CLI & MCP</span>
        <h1>{guide.title}</h1>
        <p className={`docs-intro ${styles.intro}`}>
          Follow the full workflow with a reference image you own.{' '}
          <a href="/agents">Connect your agent or CLI</a>, or{' '}
          <a href="/playground">create in your browser</a>.
        </p>
        <nav className={styles.resources} aria-label="Walkthrough resources">
          <a href="/guides/image-to-video.md">Read the Markdown walkthrough</a>
          <a href="/bytedance/seedance-2.5">Compare Seedance 2.5 routes</a>
          <a href="/v1/models/schema?modelId=bytedance%2Fseedance-2.5&operation=image-to-video">
            Inspect its current schema
          </a>
        </nav>
        <div className="docs-grid">
          <nav className="docs-index" aria-label="Guide sections">
            <span className="eyebrow">ON THIS PAGE</span>
            {guide.sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.title}
              </a>
            ))}
          </nav>
          <article className="docs-body" aria-label="Image-to-video walkthrough">
            <GuideBlocks blocks={guide.introduction} origin={origin} />
            {guide.sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                <GuideBlocks
                  blocks={section.blocks}
                  origin={origin}
                  codeTitle={
                    section.id === 'submit-once-and-keep-the-receipt'
                      ? 'Billable submission'
                      : undefined
                  }
                />
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </>
  );
}
