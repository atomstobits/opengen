import type { Metadata } from 'next';
import { companies, getCompanyModels, getCompanySeries } from '@media-router/catalog';
import { Footer, Icon, SiteHeader } from '../ui';
import { JsonLd, companyDirectoryStructuredData, pageMetadata } from '../seo';

export const metadata: Metadata = pageMetadata({
  title: 'AI model companies & generation API publishers | OpenGen',
  description:
    'Browse image and video model publishers on OpenGen. Explore their model series, exact variants and independently listed regional API providers.',
  path: '/companies',
});
export default function CompaniesPage() {
  return (
    <>
      <JsonLd data={companyDirectoryStructuredData()} />
      <SiteHeader active="companies" />
      <main className="directory-page page-width">
        <header className="directory-hero">
          <span className="hero-kicker">
            <span className="status-dot" /> THE MODEL PUBLISHERS
          </span>
          <h1>
            Companies.
            <br />
            <span>Models. Possibilities.</span>
          </h1>
          <p>
            Explore each publisher’s model series. Compare the variants and providers behind every
            generation.
          </p>
        </header>
        <div className="company-directory-grid">
          {companies.map((company) => (
            <article className="company-directory-card" key={company.id}>
              <a href={`/${company.id}`}>
                <span className="company-monogram">{company.name.slice(0, 1)}</span>
                <h2>{company.name}</h2>
                <p>{company.description}</p>
                <div>
                  <span>{getCompanySeries(company.id).length} series</span>
                  <span>{getCompanyModels(company.id).length} variants</span>
                  <Icon name="arrow" size={17} />
                </div>
              </a>
            </article>
          ))}
        </div>
      </main>
      <Footer />
    </>
  );
}
