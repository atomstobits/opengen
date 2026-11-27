import type { Metadata } from 'next';
import { Footer, SiteHeader } from '../ui';
import { JsonLd, pageMetadata } from '../seo';
import {
  buildFeeBreakdownRows,
  buildPricingCatalogSummary,
  formatUsdCents,
  pricingStructuredData,
  readWebTrialCreditOffer,
  type PricingHighlightRow,
} from './pricing-data';
import styles from './pricing.module.css';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = pageMetadata({
  title: 'Pricing — Pay-as-you-go image & video API | OpenGen',
  description:
    'Zero subscription fees and zero seat fees. Pay only for generation usage with prepaid USD credit or bring your own provider keys (BYOK). Source-linked model prices across image and video APIs.',
  path: '/pricing',
});

function HighlightTable({
  caption,
  rows,
}: {
  caption: string;
  rows: readonly PricingHighlightRow[];
}) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.catalogTable}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">Provider &amp; region</th>
            <th scope="col">Scope</th>
            <th scope="col">Status</th>
            <th scope="col">Published rate</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.routeId}>
              <td>
                <a className={styles.modelLink} href={row.href}>
                  {row.modelName}
                </a>
                <span
                  className={`${styles.modalityBadge} ${
                    row.modality === 'video' ? styles.modalityVideo : styles.modalityImage
                  }`}
                >
                  {row.modality}
                </span>
              </td>
              <td>
                <span>{row.providerName}</span>
                {row.official && <span className={styles.officialTag}>Official</span>}
                <span className={styles.cellMeta}>{row.region}</span>
              </td>
              <td>
                <span>{row.scopeLabel}</span>
                <span className={styles.cellMeta}>Checked {row.checkedAt}</span>
              </td>
              <td>
                <span
                  className={`${styles.statusBadge} ${
                    row.status === 'live-verified' ? styles.statusLive : styles.statusDocumented
                  }`}
                >
                  {row.status === 'live-verified' ? 'Live-verified' : 'Documented'}
                </span>
              </td>
              <td>
                <span className={row.priceAvailable ? styles.priceValue : styles.priceUnavailable}>
                  {row.priceLabel}
                </span>
                <span className={styles.cellMeta}>{row.priceNote}</span>
              </td>
              <td>
                <a
                  className={styles.inlineLink}
                  href={row.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Tariff ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function PricingPage() {
  const trialOffer = readWebTrialCreditOffer();
  const feeRows = buildFeeBreakdownRows();
  const summary = buildPricingCatalogSummary();

  return (
    <>
      <JsonLd data={pricingStructuredData()} />
      <SiteHeader />
      <main className={styles.page}>
        <header className={styles.hero}>
          <div>
            <span className={styles.eyebrow}>PRICING</span>
            <h1>
              Pay only for generation.
              <br />
              <em>$0 subscriptions.</em>
            </h1>
            <p className={styles.heroLead}>
              No monthly plans and no seat fees. Fund a workspace with prepaid USD credit or connect
              your own provider API keys (BYOK) at $0 OpenGen platform fee.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryBtn} href="/billing">
                Add prepaid credit ↗
              </a>
              <a className={styles.secondaryBtn} href="/models">
                Explore {summary.stats.modelsCount} models
              </a>
              <a className={styles.secondaryBtn} href="/agents">
                Connect an agent
              </a>
            </div>
          </div>
          <div className={styles.statStrip} aria-label="OpenGen pricing highlights">
            <div className={styles.statCard}>
              <span className={styles.statValue}>$0</span>
              <span className={styles.statLabel}>Subscription &amp; seat fees</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>$5–$9,999</span>
              <span className={styles.statLabel}>Prepaid USD credit top-ups</span>
            </div>
            <div className={styles.statCard}>
              <span className={styles.statValue}>0%</span>
              <span className={styles.statLabel}>Model rate markup or BYOK</span>
            </div>
          </div>
        </header>

        {trialOffer.enabled && trialOffer.formattedUsd && (
          <section className={styles.trialBanner} aria-labelledby="starter-trial-title">
            <div>
              <span className={styles.eyebrow}>STARTER TRIAL CREDIT</span>
              <h2 id="starter-trial-title">
                {trialOffer.formattedUsd} starter credit available on this deployment
              </h2>
              <p>
                New verified human accounts can claim a one-time {trialOffer.formattedUsd}{' '}
                non-refundable promotional credit into their personal workspace after signing in and
                accepting the active Terms of Service.
              </p>
            </div>
            <a className={styles.primaryBtn} href="/billing">
              Check eligibility on Billing ↗
            </a>
          </section>
        )}

        <section className={styles.modesSection} aria-labelledby="funding-modes-title">
          <div className={styles.sectionHeader}>
            <span className={styles.eyebrow}>01 / TWO WAYS TO PAY</span>
            <h2 id="funding-modes-title">Prepaid USD wallet or bring your own keys.</h2>
            <p>
              Use OpenGen’s managed prepaid balance across every supported route, or attach your own
              provider credentials in your private workspace. Both share the exact same REST, MCP,
              CLI, and Playground workflows.
            </p>
          </div>

          <div className={styles.modesGrid}>
            <article className={styles.prepaidCard}>
              <div className={styles.cardHeader}>
                <span className={styles.eyebrow}>PREPAID MANAGED CREDIT</span>
                <span className={styles.tagOnLight}>USD · STRIPE CHECKOUT</span>
              </div>
              <h3>Top up $5.00–$9,999.00 on demand</h3>
              <p>
                100% of your chosen credit principal lands in your workspace wallet once payment
                confirms. Stripe card processing fees are passed through transparently upfront —
                never hidden inside inflated model rates.
              </p>
              <div className={styles.feeTableWrap}>
                <table className={styles.feeTable}>
                  <caption className="sr-only">
                    Prepaid USD top-up processing fee pass-through breakdown
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Credit added</th>
                      <th scope="col">US fee (2.9% + $0.30)</th>
                      <th scope="col">US total</th>
                      <th scope="col">Intl saved card (4.4% + $0.30)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {feeRows.map((row) => (
                      <tr key={row.creditCents}>
                        <td>{formatUsdCents(row.creditCents)}</td>
                        <td>{formatUsdCents(row.domestic.feeCents)}</td>
                        <td>
                          <strong>{formatUsdCents(row.domestic.totalChargeCents)}</strong>
                        </td>
                        <td>
                          {formatUsdCents(row.international.feeCents)} (
                          {formatUsdCents(row.international.totalChargeCents)} total)
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.feeNote}>
                Hosted Stripe Checkout applies the domestic 2.9% + $0.30 ceiling gross-up; optional
                opt-in automatic recharge on non-US saved cards applies 4.4% + $0.30.
              </p>
              <div className={styles.prepaidFooter}>
                <a className={styles.primaryBtn} href="/billing">
                  Add credit on Billing ↗
                </a>
                <a className={styles.inlineLinkLight} href="/terms#credits-and-refunds">
                  Credit &amp; refund terms
                </a>
              </div>
            </article>

            <article className={styles.byokCard}>
              <div className={styles.byokHeader}>
                <span className={styles.eyebrow}>BRING YOUR OWN KEYS</span>
                <span className={styles.tagOnDark}>$0 PLATFORM FEE</span>
              </div>
              <h3>Connect your own provider accounts</h3>
              <p>
                Already have enterprise credits, regional quota, or direct billing with OpenAI,
                Google, Alibaba Cloud, BytePlus, Kling AI, Black Forest Labs, MiniMax, xAI, fal,
                Runway, or Replicate?
              </p>
              <ul className={styles.featureList}>
                <li>
                  <span className={styles.bullet} aria-hidden="true">
                    →
                  </span>
                  <span>
                    $0 OpenGen platform fee and $0 seat fees — your provider account is billed
                    directly.
                  </span>
                </li>
                <li>
                  <span className={styles.bullet} aria-hidden="true">
                    →
                  </span>
                  <span>
                    OpenGen never debits your managed workspace credit for BYOK generations.
                  </span>
                </li>
                <li>
                  <span className={styles.bullet} aria-hidden="true">
                    →
                  </span>
                  <span>
                    Encrypted workspace-scoped connections with per-key routing policies and
                    regional pinning.
                  </span>
                </li>
                <li>
                  <span className={styles.bullet} aria-hidden="true">
                    →
                  </span>
                  <span>
                    Self-host the Apache-2.0 gateway with PostgreSQL and S3-compatible storage — no
                    payment processor required.
                  </span>
                </li>
              </ul>
              <div className={styles.byokFooter}>
                <a className={styles.inlineLink} href="/app#start">
                  Configure workspace connections ↗
                </a>
                <a className={styles.inlineLink} href="/docs">
                  Read API &amp; self-hosting docs ↗
                </a>
              </div>
            </article>
          </div>
        </section>

        <section className={styles.lifecycleSection} aria-labelledby="settlement-lifecycle-title">
          <div className={styles.sectionHeader}>
            <span className={styles.eyebrow}>02 / HOW BILLING SETTLEMENT WORKS</span>
            <h2 id="settlement-lifecycle-title">Quote → Hold → Actual settlement or release.</h2>
            <p>
              Every managed generation uses integer micro-USD accounting so concurrent requests
              cannot overspend your balance and unused reservations return automatically.
            </p>
          </div>
          <ol className={styles.lifecycleGrid} style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            <li className={styles.lifecycleCard}>
              <span className={styles.stepBadge} aria-hidden="true">
                1
              </span>
              <h3>Quote first — $0 called</h3>
              <p>
                Inspect exact route eligibility and published list-price estimates via{' '}
                <code>POST /v1/quotes</code> or Playground before submitting. Quotes are estimates,
                not guaranteed ceilings.
              </p>
            </li>
            <li className={styles.lifecycleCard}>
              <span className={styles.stepBadge} aria-hidden="true">
                2
              </span>
              <h3>Atomic reservation hold</h3>
              <p>
                Before calling an upstream provider, OpenGen transactionally reserves the estimated
                micro-USD hold from your available workspace balance.
              </p>
            </li>
            <li className={styles.lifecycleCard}>
              <span className={styles.stepBadge} aria-hidden="true">
                3
              </span>
              <h3>Actual settlement &amp; release</h3>
              <p>
                Once the provider finishes and reports actual usage (or fixed tariff units), OpenGen
                settles the actual cost and releases any unused hold immediately back to available
                credit.
              </p>
            </li>
            <li className={styles.lifecycleCard}>
              <span className={styles.stepBadge} aria-hidden="true">
                4
              </span>
              <h3>No blind paid retries</h3>
              <p>
                Failed admissions release their hold. Submission timeouts stay tracked by persisted
                job and idempotency keys rather than silently double-charging a second upstream job.
              </p>
            </li>
          </ol>
        </section>

        <section className={styles.catalogSection} aria-labelledby="catalog-highlights-title">
          <div className={styles.sectionHeader}>
            <span className={styles.eyebrow}>03 / SOURCE-LINKED MODEL RATES</span>
            <h2 id="catalog-highlights-title">Catalog pricing highlights.</h2>
            <p>
              Rates below are derived directly from OpenGen’s open catalog across{' '}
              {summary.stats.modelsCount} exact model variants, {summary.stats.seriesCount} model
              series, and {summary.stats.routesCount} regional provider routes. Live-verified hosted
              routes are listed separately from documented catalog tariffs; unknown or unpriced
              configurations stay marked unavailable rather than zero.
            </p>
          </div>

          <div className={styles.catalogSubheading}>
            <h3>Live-verified hosted routes ({summary.stats.liveVerifiedCount})</h3>
            <span>
              Smoke-verified for the listed operation and resolution on the hosted gateway
            </span>
          </div>
          <HighlightTable
            caption="Live-verified hosted model routes and published rates"
            rows={summary.liveVerifiedHighlights}
          />

          <div className={styles.catalogSubheading}>
            <h3>Documented catalog routes ({summary.stats.documentedCount} total)</h3>
            <span>
              Representative documented list tariffs — not live-verified until smoke-tested
            </span>
          </div>
          <HighlightTable
            caption="Representative documented catalog routes and published list tariffs"
            rows={summary.documentedHighlights}
          />

          <div className={styles.catalogFootnote}>
            <p>
              Exact final cost depends on resolution, duration, audio, references, and provider
              token/output tariffs. Compare every serving provider and original tariff link in the
              full catalog.
            </p>
            <div className={styles.catalogFootnoteLinks}>
              <a className={styles.inlineLink} href="/models">
                Browse all {summary.stats.modelsCount} models ↗
              </a>
              <a className={styles.inlineLink} href="/billing">
                Open workspace billing ↗
              </a>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
