'use client';

import { getPublishedRate } from '@media-router/catalog';
import type { Catalog, GenerateInput, Job, Model, Quote, Route } from '@media-router/contracts';
import { Icon, regionNames } from './ui';
import { eligibleReuseRoutes } from './playground-request';
import styles from './playground-pricing.module.css';

export const usd = (micros: number) =>
  `$${(micros / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 6, minimumFractionDigits: 2 })}`;

export function routeIdentity(catalog: Catalog, route: Route) {
  const deployment = catalog.deployments.find((entry) => entry.id === route.deploymentId);
  const provider = catalog.providers.find((entry) => entry.id === deployment?.providerId);
  const service = deployment?.name.split(' · ')[0];
  return {
    label:
      [provider?.name, service !== provider?.name ? service : undefined, route.providerModelName]
        .filter(Boolean)
        .join(' · ') || route.id,
    region: deployment
      ? (regionNames[deployment.endpointRegion] ?? deployment.endpointRegion)
      : 'Not disclosed',
  };
}

function PublishedRate({
  route,
  draft,
  details = false,
}: {
  route: Route;
  draft: GenerateInput;
  details?: boolean;
}) {
  const rate = getPublishedRate(route, draft.operation, draft.input.resolution);
  const tariff = route.publishedPricing;
  const source = rate ? route.pricingSource : (tariff?.source ?? route.pricingSource);
  return (
    <div className={styles.rate}>
      {rate ? (
        <strong>
          {usd(rate.usdMicros)} USD / {rate.unit === 'image' ? 'output image' : 'output second'}
          {' · '}
          {rate.resolution}
        </strong>
      ) : tariff ? (
        <strong>{tariff.summary}</strong>
      ) : (
        <strong>Price unavailable for these settings</strong>
      )}
      <a href={source.url} target="_blank" rel="noreferrer">
        Price source ↗
      </a>
      {details && rate?.note && <p>{rate.note}</p>}
      {details && !rate && tariff && (
        <details>
          <summary>Tariff conditions</summary>
          <ul>
            {tariff.conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function PlaygroundPricing({
  catalog,
  model,
  routes,
  draft,
  quote,
  job,
  readiness,
  mobileStatus,
  busy,
  ready,
  canGenerate,
  onQuote,
  onGenerate,
  submissionLabel = 'Generate',
  error,
}: {
  catalog: Catalog;
  model: Model;
  routes: Route[];
  draft: GenerateInput;
  quote: Quote | null;
  job: Job | null;
  readiness: string;
  mobileStatus: string;
  busy: 'quote' | 'generate' | null;
  ready: boolean;
  canGenerate: boolean;
  onQuote: () => void;
  onGenerate: () => void;
  submissionLabel?: string;
  error: string;
}) {
  const selected = quote?.candidates.find((entry) => entry.routeId === quote.selectedRouteId);
  const active = routes.find((entry) => entry.id === (selected?.routeId ?? draft.routeId));
  const activeIdentity = active && routeIdentity(catalog, active);
  const direct = draft.billing === 'byok';
  const priceRoutes = eligibleReuseRoutes(
    model,
    routes,
    catalog.deployments,
    draft,
    draft.operation,
  ).filter((route) => route.status !== 'retired' && (!draft.routeId || route.id === draft.routeId));
  const displayRoute =
    priceRoutes.find((route) => route.id === active?.id) ??
    (priceRoutes.length === 1 ? priceRoutes[0] : undefined);
  const displayIdentity = displayRoute && routeIdentity(catalog, displayRoute);
  const priceSource = priceRoutes.every(
    (route) => route.pricingSource.url === priceRoutes[0]?.pricingSource.url,
  )
    ? priceRoutes[0]?.pricingSource.url
    : undefined;
  const rates = priceRoutes.map((route) =>
    getPublishedRate(route, draft.operation, draft.input.resolution),
  );
  const unit = rates[0]?.unit;
  const comparable = rates.length > 0 && rates.every((rate) => rate && rate.unit === unit);
  const minimum = comparable ? Math.min(...rates.map((rate) => rate!.usdMicros)) : null;
  const maximum = comparable ? Math.max(...rates.map((rate) => rate!.usdMicros)) : null;
  const estimate =
    selected?.estimatedCostMicros != null
      ? usd(selected.estimatedCostMicros)
      : quote
        ? 'Unavailable'
        : 'Get a quote';
  return (
    <section
      className={styles.pricing}
      id="playground-pricing"
      tabIndex={-1}
      aria-labelledby="pricing-heading"
    >
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">COST & READINESS</span>
          <h3 id="pricing-heading">{model.name} pricing</h3>
        </div>
        <a href="#playground-account">Workspace access</a>
      </div>
      <div className={styles.tariff}>
        <span className={styles.term}>Published {displayRoute ? 'route rate' : 'model rates'}</span>
        {displayRoute ? (
          <>
            <p className={styles.routeLabel}>
              {displayIdentity!.label} · {displayIdentity!.region}
            </p>
            <PublishedRate route={displayRoute} draft={draft} details />
          </>
        ) : (
          <>
            <p className={styles.routeLabel}>
              {minimum !== null && maximum !== null
                ? `${usd(minimum)}${minimum === maximum ? '' : `–${usd(maximum)}`} USD / ${unit === 'image' ? 'output image' : 'output second'} · ${draft.input.resolution}`
                : priceRoutes.length
                  ? 'Rates vary by provider and endpoint region'
                  : 'Price unavailable for these settings'}
            </p>
            {priceSource && minimum !== null && (
              <a href={priceSource} target="_blank" rel="noreferrer">
                Price source ↗
              </a>
            )}
            {priceRoutes.length > 1 && (
              <details>
                <summary>View {priceRoutes.length} regional route prices</summary>
                <ul className={styles.routeList}>
                  {priceRoutes.map((route) => {
                    const identity = routeIdentity(catalog, route);
                    return (
                      <li key={route.id}>
                        <b>
                          {identity.label} · {identity.region}
                        </b>
                        <PublishedRate route={route} draft={draft} />
                      </li>
                    );
                  })}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>{selected ? 'Quoted route' : 'Active route selection'}</dt>
          <dd>
            {activeIdentity
              ? `${activeIdentity.label} · ${activeIdentity.region}`
              : 'Automatic · selected at quote time'}
          </dd>
        </div>
        <div>
          <dt>Billing source</dt>
          <dd>{direct ? 'Your provider account' : 'OpenGen workspace credit'}</dd>
        </div>
        <div>
          <dt>Request estimate</dt>
          <dd>{estimate}</dd>
        </div>
        <div>
          <dt>Maximum spend</dt>
          <dd>{draft.maxCostMicros != null ? `${usd(draft.maxCostMicros)} USD` : 'No cap set'}</dd>
        </div>
        <div>
          <dt>Credit hold at submission</dt>
          <dd>
            {direct
              ? 'No OpenGen hold'
              : quote?.reservationMicros != null
                ? usd(quote.reservationMicros)
                : quote
                  ? 'No hold quoted'
                  : 'Pending quote'}
          </dd>
        </div>
        <div>
          <dt>Actual settlement</dt>
          <dd>{direct ? 'Billed by provider' : 'Shown in private result'}</dd>
        </div>
      </dl>
      <p className={styles.explainer}>
        {direct
          ? 'Your provider sets the final charge. With unknown pricing, OpenGen cannot enforce a provider charge limit.'
          : 'Published rates are list prices. The gateway estimates this request and checks route eligibility and the spend cap again at admission.'}
      </p>
      {quote && (
        <details className={styles.quoteDetails}>
          <summary>
            Quote details · {quote.candidates.length}{' '}
            {quote.candidates.length === 1 ? 'route' : 'routes'}
          </summary>
          <ul className={styles.routeList}>
            {quote.candidates.map((candidate) => {
              const route = routes.find((entry) => entry.id === candidate.routeId);
              const identity = route && routeIdentity(catalog, route);
              return (
                <li key={candidate.routeId}>
                  <b>{identity ? `${identity.label} · ${identity.region}` : candidate.routeId}</b>
                  <strong>
                    {candidate.estimatedCostMicros === null
                      ? 'Price unavailable'
                      : usd(candidate.estimatedCostMicros)}
                  </strong>
                  <p>
                    {candidate.executable
                      ? 'Available on this installation'
                      : (candidate.reason ?? 'Comparison only')}
                  </p>
                </li>
              );
            })}
          </ul>
          {quote.notices.map((note) => (
            <p className={styles.explainer} key={note}>
              {note}
            </p>
          ))}
        </details>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actionDock}>
        <p className={styles.desktopStatus} role="status" aria-atomic="true">
          {error ? 'Review the request error above.' : readiness}
        </p>
        <p className={styles.mobileStatus} role="status" aria-atomic="true">
          {mobileStatus}
        </p>
        <div className={styles.actionRow}>
          <button
            className="button button-outline"
            type="button"
            disabled={busy !== null || !ready}
            onClick={onQuote}
          >
            {busy === 'quote' ? 'Quoting…' : 'Get a quote'}
          </button>
          <button
            className="button button-dark"
            type="button"
            disabled={busy !== null || !canGenerate}
            onClick={onGenerate}
          >
            {busy === 'generate' ? 'Submitting…' : submissionLabel}
            <Icon name="arrow" size={14} />
          </button>
        </div>
        <nav className={styles.jumps} aria-label="Playground sections">
          <a href="#playground-pricing">Pricing</a>
          <a href="#playground-input">Input</a>
          <a href="#playground-account">Account</a>
          <a href="#playground-result">
            Result{job ? ` · ${job.status.replaceAll('-', ' ')}` : ''}
          </a>
        </nav>
      </div>
    </section>
  );
}
