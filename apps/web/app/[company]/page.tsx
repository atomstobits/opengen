import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  catalog,
  companies,
  getCompany,
  getCompanyModels,
  getCompanySeries,
} from '@media-router/catalog';
import { Footer, Icon, SiteHeader } from '../ui';
import { SeriesCards } from '../company-cards';
import { JsonLd, companyMetadata, companyStructuredData } from '../seo';

type Props = { params: Promise<{ company: string }> };
export function generateStaticParams() {
  return companies.map((company) => ({ company: company.id }));
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const company = getCompany((await params).company);
  if (!company)
    return { title: 'Company not found — OpenGen', robots: { index: false, follow: true } };
  return companyMetadata(company);
}
export default async function CompanyPage({ params }: Props) {
  const company = getCompany((await params).company);
  if (!company) notFound();
  const series = getCompanySeries(company.id);
  const models = getCompanyModels(company.id);
  const modelIds = new Set(models.map((model) => model.id));
  const routes = catalog.routes.filter((route) => modelIds.has(route.modelId));
  const parent = company.parentCompanyId ? getCompany(company.parentCompanyId) : undefined;
  return (
    <>
      <JsonLd data={companyStructuredData(company)} />
      <SiteHeader active="companies" />
      <main className="directory-page page-width">
        <div className="page-breadcrumb">
          <a href="/models">Models</a>
          <span>/</span>
          <span>{company.name}</span>
        </div>
        <header className="company-hero">
          <div>
            <div className="hero-kicker">
              <span className="status-dot" /> MODEL PUBLISHER
              {parent && (
                <>
                  <span>/</span>
                  <a href={`/${parent.id}`}>{parent.name}</a>
                </>
              )}
            </div>
            <h1>{company.name}</h1>
            <p>{company.description}</p>
            <p>
              Compare {series.length} model series, {models.length} exact variants and{' '}
              {routes.length} documented regional provider routes on OpenGen.
            </p>
            <a className="text-link" href={company.website} target="_blank" rel="noreferrer">
              Company website <Icon name="external" size={14} />
            </a>
          </div>
          <div className="company-stats">
            <div>
              <strong>{series.length}</strong>
              <span>model series</span>
            </div>
            <div>
              <strong>{models.length}</strong>
              <span>exact variants</span>
            </div>
            <div>
              <strong>{routes.length}</strong>
              <span>provider routes</span>
            </div>
          </div>
        </header>
        <div className="directory-section-title">
          <div>
            <span className="eyebrow">THE MODEL COLLECTION</span>
            <h2>Models by {company.name}</h2>
          </div>
          <p>Open a series to compare every variant and regional provider.</p>
        </div>
        <SeriesCards series={series} />
        <p className="collection-note">
          Publisher attribution is separate from hosting. Derivatives stay in their original model
          series with the team that created each variant clearly named.
        </p>
      </main>
      <Footer />
    </>
  );
}
