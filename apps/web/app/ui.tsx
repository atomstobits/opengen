'use client';

import { useEffect, useId, useState } from 'react';
import { usePublicOrigin } from './public-origin';
import { useLegalPresentation } from './legal/presentation';
import { HeroMedia, HeroSplitMedia } from './hero-media';
import { HeroComparisonModal } from './hero-comparison-modal';
import type { HeroComparisonItem, HeroModelPricing } from './hero-comparisons';
import { buildProviderRouteRows } from './provider-order';
import { regionNames } from './route-identity';
import {
  computeCheapestRouteHighlights,
  formatComparisonScope,
  formatRouteUnitPrice,
  isDisplayedRateCheapest,
  resolveDisplayedRouteRate,
  type CheapestRouteHighlight,
} from './route-pricing-comparison';
export { regionNames };
import {
  describeRouteFeatures,
  operationLabel,
  operationLabels,
  routeFeatureDiscriminator,
  routePublishedPricingForOperation,
  routeResolutionsForOperation,
  sortOperations,
  variantHasFeatureDistinctions,
  type Catalog,
  type Deployment,
  type GenerateInput,
  type Model,
  type Operation,
  type OutputAsset,
  type Route,
  type RouteMetrics,
} from '@media-router/contracts';

const operationNames = operationLabels;
const scopeNames: Record<Exclude<Deployment['scope'], 'undisclosed'>, string> = {
  global: 'Global',
  international: 'International',
  'mainland-china': 'Mainland China',
  regional: 'Regional',
};
const usdFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});
const usd = (micros: number) => `$${usdFormatter.format(micros / 1_000_000)}`;
const regionName = (deployment: Deployment) =>
  regionNames[deployment.endpointRegion] ?? deployment.endpointRegion;

export function Icon({
  name,
  size = 18,
}: {
  name:
    | 'arrow'
    | 'copy'
    | 'check'
    | 'search'
    | 'chevron'
    | 'globe'
    | 'close'
    | 'play'
    | 'code'
    | 'external'
    | 'grid'
    | 'activity'
    | 'users'
    | 'key'
    | 'link'
    | 'wallet';
  size?: number;
}) {
  const paths: Record<typeof name, React.ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h16M14 6l6 6-6 6" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    close: <path d="m5 5 14 14M19 5 5 19" />,
    play: <path d="m8 5 11 7-11 7V5Z" />,
    code: (
      <>
        <path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7M21 3l-11 11M10 4H4v16h16v-6" />
      </>
    ),
    grid: <path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h6v6h-6z" />,
    activity: <path d="M3 12h4l3-7 4 14 3-7h4" />,
    users: (
      <path d="M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 4.1a4 4 0 0 1 0 7.8M13 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
    ),
    key: (
      <path d="M14.5 3a6.5 6.5 0 0 0-5.9 9.2L3 18v3h3l2-2v-2h2l2-2a6.5 6.5 0 1 0 2.5-12Zm1.5 6h.01" />
    ),
    link: (
      <path d="M10 14l4-4m-7 7-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m4 6a3.5 3.5 0 0 0 5 0l4-4a3.5 3.5 0 0 0-5-5l-1 1" />
    ),
    wallet: <path d="M20 8V6H5a2 2 0 0 0 0 4h16v10H5a2 2 0 0 1-2-2V8m18 6h-5v3h5" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
    }
  }
  return (
    <button
      className="copy-button"
      onClick={copy}
      title={failed ? 'Select and copy the text manually' : label}
    >
      <Icon name={copied ? 'check' : 'copy'} size={15} />
      <span>{failed ? 'Select text' : copied ? 'Copied' : label}</span>
    </button>
  );
}

function ConnectCard() {
  const publicOrigin = usePublicOrigin();
  const [tab, setTab] = useState<'agent' | 'cli' | 'api'>('agent');
  const commands = {
    agent: new URL('/llms.txt', publicOrigin).href,
    cli: 'opengen doctor',
    api: `curl ${new URL('/v1/models', publicOrigin).href}`,
  };
  return (
    <div className="connect-card compact">
      <div className="connect-tabs" role="tablist" aria-label="Connection method">
        {(['agent', 'cli', 'api'] as const).map((t) => (
          <button
            key={t}
            data-method={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            <span className="connect-tab-symbol" aria-hidden="true">
              {t === 'agent' ? '✳' : t === 'cli' ? '>_' : '</>'}
            </span>
            {t === 'agent' ? 'Agent' : t.toUpperCase()}
          </button>
        ))}
      </div>
      <p className="connect-instruction">
        {tab === 'agent'
          ? 'Ask your agent to read:'
          : tab === 'cli'
            ? 'With your configured OpenGen CLI:'
            : 'Discover models on your gateway:'}
      </p>
      <div className="command-box">
        <code>{commands[tab]}</code>
        <CopyButton text={commands[tab]} label={tab === 'agent' ? 'Copy link' : 'Copy'} />
      </div>
      <p className="connect-caption">
        Discover, inspect, quote, then create. <a href="/agents">Setup guide ↗</a>
      </p>
    </div>
  );
}

export function SiteHeader({
  active,
  overlay = false,
}: {
  active?: 'catalog' | 'companies' | 'playground' | 'dashboard';
  overlay?: boolean;
}) {
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    if (!setup) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [setup]);
  return (
    <>
      <header className={`site-header ${overlay ? 'site-header-overlay' : ''}`}>
        <div className="header-inner">
          <a href="/" className="brand">
            <img src="/brand/opengen-wordmark-on-dark.svg" width="142" height="34" alt="OpenGen" />
          </a>
          <nav aria-label="Main navigation">
            <a
              className={active === 'catalog' || active === 'companies' ? 'nav-active' : ''}
              href="/models"
            >
              Models
            </a>
            <a
              className={active === 'playground' ? 'nav-playground nav-active' : 'nav-playground'}
              href="/playground"
            >
              Playground
            </a>
            <a className="nav-docs" href="/docs">
              Docs
            </a>
            <a
              className={active === 'dashboard' ? 'nav-active nav-dashboard' : 'nav-dashboard'}
              href="/app#start"
            >
              Workspace
            </a>
            <details className="mobile-nav">
              <summary>
                More <Icon name="chevron" size={11} />
              </summary>
              <div>
                <a href="/playground">Playground</a>
                <a href="/app#start">Workspace</a>
                <a href="/start">Get started</a>
                <a href="/docs">Documentation</a>
                <a href="/docs#self-host">Self-host</a>
                <a href="/feedback">Private feedback</a>
                <button onClick={() => setSetup(true)}>Connect an agent</button>
              </div>
            </details>
            <button className="button button-dark button-sm" onClick={() => setSetup(true)}>
              Connect an agent <Icon name="arrow" size={15} />
            </button>
          </nav>
        </div>
      </header>
      {setup && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSetup(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="setup-title"
            className="setup-modal"
          >
            <button
              className="close-button"
              aria-label="Close setup"
              onClick={() => setSetup(false)}
            >
              <Icon name="close" />
            </button>
            <span className="eyebrow">CONNECT YOUR WORKFLOW</span>
            <h2 id="setup-title">
              One catalog.
              <br />
              Every interface.
            </h2>
            <ConnectCard />
            <p className="setup-note">
              Discovery is public. Connect your workspace when you are ready to create.
              <a href="/agents">Choose your agent setup ↗</a>
            </p>
          </section>
        </div>
      )}
    </>
  );
}

export const heroAgentGuides = [
  { slug: 'claude-code', name: 'Claude Code' },
  { slug: 'codex', name: 'Codex' },
  { slug: 'openclaw', name: 'OpenClaw' },
  { slug: 'hermes', name: 'Hermes Agent' },
  { slug: 'opencode', name: 'OpenCode' },
  { slug: 'pi', name: 'pi' },
] as const;

function HeroModelBadge({ model, side }: { model: HeroModelPricing; side: 'left' | 'right' }) {
  return (
    <a
      className={`hero-model-badge is-${side}`}
      href={model.seriesHref}
      title={model.priceNote}
      data-testid={`hero-badge-${side}`}
    >
      <span className={`hero-model-dot is-${side}`} aria-hidden="true" />
      <span className="hero-badge-name">{model.modelName}</span>
      {model.priceLabel && (
        <>
          <span className="hero-badge-sep" aria-hidden="true" />
          <span className="hero-price-group">
            <span className="hero-price-current">{model.priceLabel}</span>
            {model.comparePriceLabel && (
              <span className="hero-price-compare">{model.comparePriceLabel}</span>
            )}
            {model.discountLabel && (
              <span className="hero-price-discount">{model.discountLabel}</span>
            )}
          </span>
        </>
      )}
    </a>
  );
}

export function HomeHero({
  heroVideoUrl,
  heroPosterUrl,
  agentUrl,
  comparisons = [],
}: {
  heroVideoUrl?: string;
  heroPosterUrl?: string;
  agentUrl?: string;
  comparisons?: HeroComparisonItem[];
}) {
  const publicOrigin = usePublicOrigin();
  const setupPrompt = `Set up OpenGen - ${agentUrl ?? new URL('/llms.txt', publicOrigin).href}`;
  const [sequenceIndex, setSequenceIndex] = useState(0);
  const [progress, setProgress] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);

  const hasComparisons = comparisons.length > 0;
  const activeClip = hasComparisons ? comparisons[sequenceIndex % comparisons.length] : undefined;
  const nextClip =
    hasComparisons && comparisons.length > 1
      ? comparisons[(sequenceIndex + 1) % comparisons.length]
      : undefined;

  const advanceClip = () => {
    if (comparisons.length <= 1) return;
    setProgress(0);
    setSequenceIndex((prev) => (prev + 1) % comparisons.length);
  };

  return (
    <section
      className={`hero${hasComparisons ? ' hero-has-comparisons' : ''}`}
      aria-labelledby="home-title"
    >
      {activeClip ? (
        <HeroSplitMedia
          clip={activeClip}
          nextClip={nextClip}
          paused={modalOpen}
          loopSingle={comparisons.length === 1}
          onEnded={advanceClip}
          onProgress={setProgress}
        />
      ) : (
        <HeroMedia videoUrl={heroVideoUrl} posterUrl={heroPosterUrl} />
      )}

      {activeClip && (
        <>
          <HeroModelBadge model={activeClip.left} side="left" />
          <HeroModelBadge model={activeClip.right} side="right" />
        </>
      )}

      <div className="hero-copy">
        <h1 id="home-title">
          Image & video models.
          <br />
          One open <span>gateway.</span>
        </h1>
        <p>Connect your agent, use the CLI or API, or create in your browser.</p>
        <section className="hero-agent-setup" aria-labelledby="hero-agent-title">
          <div className="hero-agent-heading">
            <h2 id="hero-agent-title">Give this to your agent</h2>
            <div className="hero-agent-icons">
              {heroAgentGuides.map(({ slug, name }) => (
                <a
                  key={slug}
                  href={`/agents/${slug}`}
                  aria-label={`${name} setup guide`}
                  title={name}
                >
                  <img src={`/agent-icons/${slug}.svg`} alt="" width={18} height={18} />
                </a>
              ))}
            </div>
          </div>
          <div className="hero-agent-command">
            <span aria-hidden="true">$</span>
            <code>{setupPrompt}</code>
            <CopyButton text={setupPrompt} />
          </div>
        </section>
        <div className="hero-setup-links">
          <a href="/agents/cli">CLI setup</a>
          <a href="/docs#http-examples">API docs</a>
          {hasComparisons && <a href="/models">Explore models</a>}
        </div>
        <a className="hero-create-link" href="/playground">
          Create in browser <Icon name="arrow" size={20} />
        </a>
      </div>

      {activeClip ? (
        <div className="hero-prompt-dock" data-testid="hero-prompt-dock">
          <div className="hero-prompt-capsule">
            <button
              type="button"
              className="hero-prompt-trigger"
              onClick={() => setModalOpen(true)}
              aria-label="Inspect shared input and comparison videos"
            >
              <img
                className="hero-prompt-thumb"
                src={activeClip.media.inputThumbWebp}
                alt=""
                width={34}
                height={34}
                loading="lazy"
                decoding="async"
              />
              <span className="hero-prompt-line">{activeClip.shortPrompt}</span>
            </button>
            <button
              type="button"
              className="hero-prompt-generate"
              onClick={() => setModalOpen(true)}
            >
              Generate
            </button>
            <div className="hero-prompt-progress" aria-hidden="true">
              <div
                className="hero-prompt-progress-fill"
                style={{ width: `${progress.toFixed(1)}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        <a className="hero-explore" href="/models">
          Explore models <span aria-hidden="true">↗</span>
        </a>
      )}

      {modalOpen && activeClip && (
        <HeroComparisonModal
          clip={activeClip}
          agentPrompt={setupPrompt}
          agentGuides={heroAgentGuides}
          onClose={() => setModalOpen(false)}
        />
      )}
    </section>
  );
}

export type LatencyPercentile = 'p50' | 'p75' | 'p90' | 'p95' | 'p99';
const percentiles: LatencyPercentile[] = ['p50', 'p75', 'p90', 'p95', 'p99'];

export function hasCompletionSamples(observation?: RouteMetrics): boolean {
  return (
    !!observation &&
    observation.sampleCount > 0 &&
    percentiles.some((percentile) => observation[`${percentile}CompletionMs`] != null)
  );
}

export function useRouteMetrics(enabled = true): RouteMetrics[] {
  const [metrics, setMetrics] = useState<RouteMetrics[]>([]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/metrics', { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (response.ok) {
          const body = await response.json();
          if (Array.isArray(body.data)) setMetrics(body.data);
        }
      })
      .catch(() => {
        /* Unavailable measurements remain unknown. */
      });
    return () => controller.abort();
  }, [enabled]);
  return metrics;
}

export function PercentileControl({
  value,
  onChange,
}: {
  value: LatencyPercentile;
  onChange: (value: LatencyPercentile) => void;
}) {
  return (
    <div className="latency-control">
      <span>Attempt completion</span>
      <div className="percentile-options" role="group" aria-label="Latency percentile">
        {percentiles.map((percentile) => (
          <button
            key={percentile}
            aria-pressed={value === percentile}
            onClick={() => onChange(percentile)}
          >
            {percentile.toUpperCase()}
          </button>
        ))}
      </div>
    </div>
  );
}

function ProviderTariff({
  route,
  selectedOperation,
}: {
  route: Route;
  selectedOperation?: Operation;
}) {
  const published = routePublishedPricingForOperation(route, selectedOperation);
  if (!published) return null;
  const source = published.source;
  const conditions = Array.from(
    new Set([...(published.conditions ?? []), ...(source.note ? [source.note] : [])]),
  );
  const checked = `Checked ${source.checkedAt}`;
  const hoverDetails = [published.summary, ...conditions, checked].filter(Boolean).join('\n');
  return (
    <details className="price-details tariff-only">
      <summary title={hoverDetails}>
        <span className="tariff-summary">{published.summary}</span>
      </summary>
      <div className="price-detail-body">
        <p className="published-tariff">{published.summary}</p>
        <p>Published tariff · request quote unqualified</p>
        {conditions.length > 0 && (
          <ul>
            {conditions.map((condition) => (
              <li key={condition}>{condition}</li>
            ))}
          </ul>
        )}
        <p>{checked}</p>
        <a href={source.url} target="_blank" rel="noreferrer">
          Price source ↗
        </a>
      </div>
    </details>
  );
}

function ProviderPrice({
  route,
  resolution,
  modality,
  selectedOperation,
  cheapestHighlight,
}: {
  route: Route;
  resolution: string;
  modality: Model['modality'];
  selectedOperation?: Operation;
  cheapestHighlight?: CheapestRouteHighlight;
}) {
  const unit = modality === 'video' ? 'output-second' : 'image';
  const effectiveOperation =
    selectedOperation ?? (route.operations.length === 1 ? route.operations[0] : undefined);
  const published = routePublishedPricingForOperation(route, effectiveOperation);
  const resolved = resolveDisplayedRouteRate(route, resolution, modality, selectedOperation);
  const isCheapest = isDisplayedRateCheapest(cheapestHighlight, resolved, selectedOperation);
  const rate = resolved?.rate;
  const qualifiedRate = resolved?.qualified;
  const source = resolved?.source ?? published?.source ?? route.pricingSource;
  const samePriceOperations =
    !selectedOperation && resolved && rate?.operation && route.operations.length > 1
      ? sortOperations(route.operations).filter((operation) => {
          const opResolved = resolveDisplayedRouteRate(route, resolution, modality, operation);
          return (
            opResolved !== null &&
            opResolved.rate.unit === rate.unit &&
            opResolved.rate.resolution.toLowerCase() === rate.resolution.toLowerCase() &&
            opResolved.rate.usdMicros === rate.usdMicros &&
            (opResolved.quality ?? '') === (resolved.quality ?? '') &&
            opResolved.qualified === resolved.qualified
          );
        })
      : [];
  const operationScopeNote =
    !selectedOperation && rate?.operation && route.operations.length > 1
      ? `Applies to: ${(samePriceOperations.length ? samePriceOperations : [rate.operation]).map(operationLabel).join(', ')}. Other operations may have different or unqualified pricing.`
      : null;
  const conditions = Array.from(
    new Set([
      rate
        ? `Resolution: ${rate.resolution}`
        : selectedOperation
          ? `No per-output price for ${operationLabel(selectedOperation)} at this resolution.`
          : 'No per-output price for this selection.',
      ...(operationScopeNote ? [operationScopeNote] : []),
      ...(rate?.note ? [rate.note] : []),
      ...(published?.conditions ?? []),
      ...(source.note && !rate?.note ? [source.note] : []),
    ]),
  );
  const checked = `Checked ${source.checkedAt}`;
  const hoverDetails = [published?.summary, ...conditions, checked].filter(Boolean).join('\n');
  return (
    <details className="price-details" data-cheapest={isCheapest ? 'true' : undefined}>
      <summary
        title={hoverDetails}
        aria-label={rate ? undefined : `${resolution} price unavailable`.trim()}
      >
        {resolution && <span className="price-resolution">{resolution}</span>}
        {rate ? (
          <>
            <strong>
              {resolved?.approximate && '≈'}
              {usd(rate.usdMicros)}
            </strong>
            <small>/ {unit === 'image' ? 'image' : 'sec'}</small>
          </>
        ) : (
          <span className="unknown-price">—</span>
        )}
      </summary>
      <div className="price-detail-body">
        {published && <p className="published-tariff">{published.summary}</p>}
        {published && !qualifiedRate && <p>Published tariff · request quote unqualified</p>}
        <ul>
          {conditions.map((condition) => (
            <li key={condition}>{condition}</li>
          ))}
        </ul>
        <p>{checked}</p>
        <a href={source.url} target="_blank" rel="noreferrer">
          Price source ↗
        </a>
      </div>
    </details>
  );
}

function CheapestBadge({
  highlight,
  tooltipId,
  open,
  pinned,
  placement,
  selectedOperation,
  onOpen,
  onClose,
  onUnpin,
  onToggle,
}: {
  highlight: CheapestRouteHighlight;
  tooltipId: string;
  open: boolean;
  pinned: boolean;
  placement: 'up' | 'down';
  selectedOperation?: Operation;
  onOpen: () => void;
  onClose: () => void;
  onUnpin: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      className="cheapest-badge-wrap"
      onMouseEnter={onOpen}
      onMouseLeave={(event) => {
        if (open && !pinned && !event.currentTarget.matches(':focus-within')) onClose();
      }}
      onFocus={onOpen}
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget)) {
          if (event.currentTarget.matches(':hover')) onUnpin();
          else onClose();
        }
      }}
    >
      <button
        type="button"
        className="cheapest-trigger"
        aria-describedby={tooltipId}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="cheapest-tag">Cheapest</span>
        <span className="cheapest-savings">{highlight.savingsLabel}</span>
      </button>
      <div
        className="cheapest-tooltip"
        id={tooltipId}
        role="tooltip"
        data-open={open}
        data-placement={placement}
      >
        <p className="cheapest-tooltip-title">
          {highlight.isTied
            ? `Tied cheapest across ${highlight.comparisons[0]!.tiedCheapestCount} routes`
            : 'Cheapest vs highest priced route'}
        </p>
        <ul className="cheapest-tooltip-list">
          {highlight.comparisons.map((entry) => {
            const scope = formatComparisonScope(entry, selectedOperation);
            const cheapestPrice = formatRouteUnitPrice(
              entry.cheapestMicros,
              entry.unit,
              entry.cheapestApproximate,
            );
            const highestPrice = formatRouteUnitPrice(
              entry.mostExpensiveMicros,
              entry.unit,
              entry.mostExpensiveApproximate,
            );
            const highestName = entry.mostExpensiveLabels.join(', ');
            return (
              <li key={`${entry.resolution}-${entry.quality ?? ''}-${entry.operations.join(',')}`}>
                <span className="cheapest-tooltip-scope">
                  {scope} · <strong>{entry.percentOff}% off</strong>
                </span>
                <span className="cheapest-tooltip-compare">
                  {cheapestPrice} vs {highestName} ({highestPrice})
                </span>
              </li>
            );
          })}
        </ul>
        <p className="cheapest-tooltip-note">
          {highlight.usesPublishedEstimates
            ? 'Compares published list estimates at matching resolution and feature; actual charges vary.'
            : 'Compares published list rates at matching resolution and feature; excludes additional input charges.'}
        </p>
      </div>
    </div>
  );
}

function RouteFeatureBadges({
  route,
  selectedOperation,
  dedicated,
}: {
  route: Route;
  selectedOperation?: Operation;
  dedicated: boolean;
}) {
  const descriptor = describeRouteFeatures(route);
  return (
    <div className="route-features" aria-label="Supported features">
      {descriptor.operations.map((operation) => {
        const isActive = selectedOperation === operation;
        return (
          <span
            key={operation}
            className={`route-feature-pill${dedicated ? ' is-dedicated' : ''}${isActive ? ' is-active' : ''}`}
            data-operation={operation}
          >
            {operationLabel(operation)}
          </span>
        );
      })}
      {descriptor.featureLabel && (
        <span className="route-feature-pill is-subfeature" data-feature-id={route.feature?.id}>
          {descriptor.featureLabel}
        </span>
      )}
    </div>
  );
}

export function ProviderTable({
  model,
  routes,
  catalog,
  onTry,
  tryHref,
  metrics,
  percentile,
}: {
  model: Model;
  routes: Route[];
  catalog: Catalog;
  onTry?: (routeId: string, operation?: Operation) => void;
  tryHref?: (routeId: string, operation?: Operation) => string;
  metrics?: RouteMetrics[];
  percentile?: LatencyPercentile;
}) {
  const providerTooltipPrefix = useId();
  const cheapestTooltipPrefix = useId();
  const [activeProviderTooltip, setActiveProviderTooltip] = useState<string | null>(null);
  const [activeCheapestTooltip, setActiveCheapestTooltip] = useState<{
    id: string;
    pinned: boolean;
  } | null>(null);
  const [selectedFeature, setSelectedFeature] = useState<Operation | 'all'>('all');
  useEffect(() => {
    if (!activeProviderTooltip && !activeCheapestTooltip) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActiveProviderTooltip(null);
        setActiveCheapestTooltip(null);
      }
    };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [activeProviderTooltip, activeCheapestTooltip]);
  const [localPercentile, setLocalPercentile] = useState<LatencyPercentile>('p50');
  const localMetrics = useRouteMetrics(metrics === undefined);
  const observations = metrics ?? localMetrics;
  const selectedPercentile = percentile ?? localPercentile;
  const deployments = new Map(catalog.deployments.map((item) => [item.id, item]));
  const availableOperations = sortOperations(routes.flatMap((route) => route.operations));
  const activeOperation =
    selectedFeature !== 'all' && availableOperations.includes(selectedFeature)
      ? selectedFeature
      : undefined;
  const hasFeatureDistinctions = variantHasFeatureDistinctions(routes);
  const deploymentTotals = new Map<string, number>();
  for (const route of routes)
    deploymentTotals.set(route.deploymentId, (deploymentTotals.get(route.deploymentId) ?? 0) + 1);
  const hasSplitDeployment = [...deploymentTotals.values()].some((count) => count > 1);
  const visibleRoutes = activeOperation
    ? routes.filter((route) => route.operations.includes(activeOperation))
    : routes;
  const groupedRows = buildProviderRouteRows(visibleRoutes, deployments, model.authorProviderIds);
  const cheapestHighlights = computeCheapestRouteHighlights(
    visibleRoutes,
    model,
    catalog,
    activeOperation,
  );
  const sampledRoutes = new Map(
    observations.filter((item) => item.sampleCount > 0).map((item) => [item.routeId, item]),
  );
  const showCompletion = routes.some((route) => hasCompletionSamples(sampledRoutes.get(route.id)));
  const showSuccessRate = routes.some(
    (route) => sampledRoutes.get(route.id)?.technicalSuccessRate != null,
  );
  return (
    <div className="providers-view">
      <div className="table-topline">
        <div className="table-topline-summary">
          <p>
            {hasSplitDeployment
              ? 'Every regional deployment and feature-specific route is listed separately; split routes are grouped by deployment.'
              : 'Every regional deployment is its own route.'}
          </p>
          {availableOperations.length > 1 && (
            <div className="feature-filter" role="group" aria-label="Filter routes by feature">
              <button
                type="button"
                aria-pressed={activeOperation === undefined}
                onClick={() => {
                  setSelectedFeature('all');
                  setActiveCheapestTooltip(null);
                }}
              >
                All ({routes.length})
              </button>
              {availableOperations.map((operation) => (
                <button
                  key={operation}
                  type="button"
                  aria-pressed={activeOperation === operation}
                  onClick={() => {
                    setSelectedFeature(operation);
                    setActiveCheapestTooltip(null);
                  }}
                >
                  {operationLabel(operation)}
                </button>
              ))}
            </div>
          )}
        </div>
        {percentile === undefined && showCompletion && (
          <div className="table-controls">
            <PercentileControl value={localPercentile} onChange={setLocalPercentile} />
          </div>
        )}
      </div>
      <div className="route-table-wrap">
        <table className="route-table">
          <thead>
            <tr>
              <th>
                {hasFeatureDistinctions ? 'Provider / feature route' : 'Provider / endpoint region'}
              </th>
              <th>Published price</th>
              {showCompletion && <th>Attempt completion</th>}
              {showSuccessRate && <th>Success rate</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {groupedRows.map((row, rowIndex) => {
              const { route, deploymentGroupSize, isGroupStart, isGroupContinuation, isGroupEnd } =
                row;
              const deployment = deployments.get(route.deploymentId);
              const provider = catalog.providers.find((p) => p.id === deployment?.providerId);
              if (!deployment || !provider) return null;
              const observation = sampledRoutes.get(route.id);
              const duration = observation?.[`${selectedPercentile}CompletionMs`];
              const success = observation?.technicalSuccessRate;
              const cheapest = cheapestHighlights.get(route.id);
              const cheapestTooltipId = `${cheapestTooltipPrefix}-${route.id}`;
              const cheapestPlacement =
                rowIndex === groupedRows.length - 1 && groupedRows.length > 1 ? 'up' : 'down';
              const discriminator = routeFeatureDiscriminator(route, routes, activeOperation);
              const handoffOperation =
                activeOperation ??
                (route.operations.length === 1 ? route.operations[0] : undefined);
              const actionFeature = activeOperation
                ? (route.feature?.label ?? operationLabel(activeOperation))
                : discriminator;
              const actionLabel = actionFeature
                ? `Use ${provider.name} ${regionName(deployment)} ${actionFeature} route`
                : `Use ${provider.name} ${regionName(deployment)} route`;
              const endpointKnown = !['undisclosed', 'unknown'].includes(deployment.endpointRegion);
              const scope =
                deployment.scope === 'undisclosed' ? null : scopeNames[deployment.scope];
              const regionTooltip = !endpointKnown
                ? scope
                  ? 'API endpoint region (where requests enter the provider) is not disclosed.'
                  : 'API endpoint region and inference scope are not disclosed.'
                : !scope
                  ? 'Inference scope (where processing may occur) is not disclosed.'
                  : null;
              const verification = route.liveVerification;
              const statusTooltip = verification
                ? `Verified on ${verification.checkedAt} for ${(verification.operations ?? [verification.operation]).map((operation) => operationNames[operation].toLowerCase()).join(' and ')} at ${verification.resolution} and ${verification.duration}s.`
                : route.status === 'documented'
                  ? 'Documented by the provider.'
                  : null;
              const providerTooltip = [statusTooltip, regionTooltip].filter(Boolean).join(' ');
              const providerTooltipId = `${providerTooltipPrefix}-${route.id}`;
              const opResolutions = routeResolutionsForOperation(route, activeOperation);
              const resolutions = opResolutions.length ? opResolutions : [''];
              const hasResolutionRate = resolutions.some(
                (resolution) =>
                  resolveDisplayedRouteRate(route, resolution, model.modality, activeOperation) !=
                  null,
              );
              const isGrouped = deploymentGroupSize > 1;
              const groupState = !isGrouped
                ? 'single'
                : isGroupStart
                  ? 'start'
                  : isGroupEnd
                    ? 'end'
                    : 'middle';
              const showFeatureBadges =
                isGrouped || hasFeatureDistinctions || Boolean(route.feature);
              const isDedicatedRoute =
                isGrouped ||
                (deploymentTotals.get(route.deploymentId) ?? 1) > 1 ||
                (availableOperations.length > 1 && route.operations.length === 1);
              return (
                <tr
                  key={route.id}
                  data-route-id={route.id}
                  data-deployment-id={route.deploymentId}
                  data-route-group={groupState}
                  data-cheapest-route={cheapest ? 'true' : undefined}
                  className={isGrouped ? `route-group-row route-group-${groupState}` : undefined}
                >
                  <td>
                    {!isGroupContinuation && (
                      <div
                        className="provider-region"
                        onMouseEnter={
                          providerTooltip
                            ? () => setActiveProviderTooltip(providerTooltipId)
                            : undefined
                        }
                        onMouseLeave={(event) => {
                          if (
                            activeProviderTooltip === providerTooltipId &&
                            !event.currentTarget.matches(':focus-within')
                          )
                            setActiveProviderTooltip(null);
                        }}
                        onFocus={
                          providerTooltip
                            ? () => setActiveProviderTooltip(providerTooltipId)
                            : undefined
                        }
                        onBlur={(event) => {
                          if (
                            activeProviderTooltip === providerTooltipId &&
                            !event.currentTarget.contains(event.relatedTarget) &&
                            !event.currentTarget.matches(':hover')
                          )
                            setActiveProviderTooltip(null);
                        }}
                      >
                        <div className="provider-name">
                          <span className="provider-initial">{provider.name.slice(0, 1)}</span>
                          <a
                            href={provider.website}
                            target="_blank"
                            rel="noreferrer"
                            aria-describedby={providerTooltip ? providerTooltipId : undefined}
                          >
                            <strong>{provider.name}</strong>
                          </a>
                          {model.authorProviderIds.includes(provider.id) && (
                            <span
                              className="official-tag"
                              title={`Operated by ${model.creator}, the author of this exact variant`}
                            >
                              Official
                            </span>
                          )}
                          {isGrouped && (
                            <span className="route-group-count">
                              {deploymentGroupSize} feature routes
                            </span>
                          )}
                          {!isGrouped && route.status !== 'documented' && (
                            <span className="route-state">
                              <i />
                              {route.status === 'live-verified' ? 'Verified' : 'Retired'}
                            </span>
                          )}
                        </div>
                        {!isGrouped &&
                          route.providerModelName &&
                          route.providerModelName !== model.name && (
                            <span className="provider-model-name">
                              Listed as {route.providerModelName}
                            </span>
                          )}
                        {(endpointKnown || scope) && (
                          <div className="region-line">
                            {endpointKnown && (
                              <span
                                className="endpoint-region"
                                data-region={deployment.endpointRegion}
                              >
                                <Icon name="globe" size={12} />
                                {deployment.endpointRegion === 'global'
                                  ? 'Global endpoint'
                                  : `Endpoint: ${regionName(deployment)}`}
                              </span>
                            )}
                            {scope && <span className="scope-tag">Inference scope: {scope}</span>}
                          </div>
                        )}
                        {providerTooltip && (
                          <span
                            className="provider-tooltip"
                            id={providerTooltipId}
                            role="tooltip"
                            data-open={activeProviderTooltip === providerTooltipId}
                          >
                            {providerTooltip}
                          </span>
                        )}
                      </div>
                    )}
                    {isGrouped ? (
                      <div
                        className={`route-branch${isGroupContinuation ? ' is-continuation' : ' is-start'}`}
                      >
                        <div className="route-branch-header">
                          {isGroupContinuation && (
                            <span className="sr-only">{provider.name} — </span>
                          )}
                          <RouteFeatureBadges
                            route={route}
                            selectedOperation={activeOperation}
                            dedicated={isDedicatedRoute}
                          />
                          {route.status !== 'documented' && (
                            <span className="route-state">
                              <i />
                              {route.status === 'live-verified' ? 'Verified' : 'Retired'}
                            </span>
                          )}
                        </div>
                        {route.providerModelName && route.providerModelName !== model.name && (
                          <span className="provider-model-name">
                            Listed as {route.providerModelName}
                          </span>
                        )}
                        {route.feature?.summary && (
                          <span className="route-feature-summary">{route.feature.summary}</span>
                        )}
                        <code className="route-id" title={route.id}>
                          {route.id}
                        </code>
                      </div>
                    ) : (
                      <>
                        {showFeatureBadges && (
                          <RouteFeatureBadges
                            route={route}
                            selectedOperation={activeOperation}
                            dedicated={isDedicatedRoute}
                          />
                        )}
                        {route.feature?.summary && (
                          <span className="route-feature-summary">{route.feature.summary}</span>
                        )}
                        <code className="route-id" title={route.id}>
                          {route.id}
                        </code>
                      </>
                    )}
                  </td>
                  <td className="price-cell">
                    {cheapest && (
                      <CheapestBadge
                        highlight={cheapest}
                        tooltipId={cheapestTooltipId}
                        open={activeCheapestTooltip?.id === cheapestTooltipId}
                        pinned={
                          activeCheapestTooltip?.id === cheapestTooltipId &&
                          activeCheapestTooltip.pinned
                        }
                        placement={cheapestPlacement}
                        selectedOperation={activeOperation}
                        onOpen={() =>
                          setActiveCheapestTooltip((current) =>
                            current?.id === cheapestTooltipId
                              ? current
                              : { id: cheapestTooltipId, pinned: false },
                          )
                        }
                        onClose={() => setActiveCheapestTooltip(null)}
                        onUnpin={() =>
                          setActiveCheapestTooltip((current) =>
                            current?.id === cheapestTooltipId
                              ? { id: cheapestTooltipId, pinned: false }
                              : current,
                          )
                        }
                        onToggle={() =>
                          setActiveCheapestTooltip((current) =>
                            current?.id === cheapestTooltipId && current.pinned
                              ? null
                              : { id: cheapestTooltipId, pinned: true },
                          )
                        }
                      />
                    )}
                    {!hasResolutionRate &&
                    routePublishedPricingForOperation(route, activeOperation) ? (
                      <ProviderTariff route={route} selectedOperation={activeOperation} />
                    ) : (
                      resolutions.map((resolution) => (
                        <ProviderPrice
                          key={resolution}
                          route={route}
                          resolution={resolution}
                          modality={model.modality}
                          selectedOperation={activeOperation}
                          cheapestHighlight={cheapest}
                        />
                      ))
                    )}
                  </td>
                  {showCompletion && (
                    <td className="metric-cell">
                      {observation && duration != null && (
                        <>
                          <span>
                            {(duration / 1000).toLocaleString('en-US', {
                              maximumFractionDigits: 2,
                            })}
                            s
                          </span>
                          <small>
                            {selectedPercentile.toUpperCase()} · {observation.sampleCount} samples
                          </small>
                        </>
                      )}
                    </td>
                  )}
                  {showSuccessRate && (
                    <td className="metric-cell">
                      {observation && success != null && (
                        <>
                          <span>{(success * 100).toFixed(2)}%</span>
                          <small>
                            {observation.unclassifiedFailures
                              ? `${observation.unclassifiedFailures} unclassified failures`
                              : `${observation.sampleCount} samples`}
                          </small>
                        </>
                      )}
                    </td>
                  )}
                  <td>
                    {tryHref ? (
                      <a
                        className="route-action"
                        href={tryHref(route.id, handoffOperation)}
                        aria-label={actionLabel}
                      >
                        <Icon name="arrow" size={17} />
                      </a>
                    ) : (
                      <button
                        className="route-action"
                        onClick={() => onTry?.(route.id, handoffOperation)}
                        aria-label={actionLabel}
                      >
                        <Icon name="arrow" size={17} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!groupedRows.length && (
              <tr>
                <td colSpan={3 + Number(showCompletion) + Number(showSuccessRate)}>
                  <div className="table-empty">
                    {activeOperation
                      ? `No documented serving route supports ${operationLabel(activeOperation)} for this variant.`
                      : 'No documented serving provider is listed for this variant yet.'}
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="table-bottomline">
        <span>Published estimates exclude additional input charges and promotions.</span>
        <a href={model.source.url} target="_blank" rel="noreferrer">
          Creator documentation ↗
        </a>
      </div>
      <div className="residency-note">
        <Icon name="globe" size={16} />
        <p>
          <strong>An endpoint region is not a residency guarantee.</strong> Global inference may
          process requests elsewhere. Success rate measures generation outcomes, not provider
          uptime.
        </p>
      </div>
    </div>
  );
}

export function PlaygroundWorkflow({
  gatewayOrigin,
  buildRequest,
}: {
  gatewayOrigin: string;
  buildRequest: () => GenerateInput;
}) {
  const [method, setMethod] = useState<'agent' | 'api' | null>(null);
  let requestJson = '';
  let requestError = '';
  if (method) {
    try {
      requestJson = JSON.stringify(buildRequest(), null, 2);
    } catch (cause) {
      requestError = cause instanceof Error ? cause.message : 'Check your inputs below.';
    }
  }
  const agentBrief = `Read ${gatewayOrigin}/llms.txt and connect to ${gatewayOrigin}/mcp using my authorized OpenGen workspace. Inspect the model schema and quote this request. Show me the provider, endpoint region, billing source, request estimate, credit hold and spend cap, and ask before submitting a billable generation. Keep the returned job ID and poll it; never blindly replace an unresolved submission.\n\n${requestJson}`;
  const authHeader = '-H "Authorization: Bearer ${OPENGEN_API_KEY:?Set OPENGEN_API_KEY privately}"';
  const quoteCommand = [
    `curl '${gatewayOrigin}/v1/quotes' \\`,
    `  ${authHeader} \\`,
    "  -H 'Content-Type: application/json' \\",
    '  --data-binary @request.json',
  ].join('\n');
  const generateCommand = [
    `curl '${gatewayOrigin}/v1/generations' \\`,
    `  ${authHeader} \\`,
    '  -H "Idempotency-Key: ${OPENGEN_REQUEST_ID:?Set and save a unique ID for this generation}" \\',
    "  -H 'Content-Type: application/json' \\",
    '  --data-binary @request.json',
  ].join('\n');
  const pollCommand = [
    `curl "${gatewayOrigin}/v1/generations/\${OPENGEN_JOB_ID:?Set the returned job ID}" \\`,
    `  ${authHeader}`,
  ].join('\n');
  return (
    <section className="playground-workflow" aria-label="API and agent instructions">
      <div className="workflow-heading">
        <div>
          <Icon name="code" size={18} />
          <span>Developer tools · current request</span>
        </div>
        <div className="workflow-methods">
          {(['agent', 'api'] as const).map((value) => (
            <button
              key={value}
              aria-expanded={method === value}
              aria-controls="playground-workflow-instructions"
              onClick={() => setMethod(method === value ? null : value)}
            >
              {value === 'agent' ? 'Use an agent' : 'Use the API'}
              <Icon name={method === value ? 'close' : 'arrow'} size={14} />
            </button>
          ))}
        </div>
      </div>
      {method && (
        <div className="workflow-instructions" id="playground-workflow-instructions">
          <div className="workflow-intro">
            <h3>
              {method === 'agent' ? 'Give your agent the brief.' : 'Generate through the API.'}
            </h3>
            <p>Finish your inputs below. These instructions update as you edit.</p>
          </div>
          {method === 'agent' ? (
            <>
              <p>
                <a href="/agents">Choose your agent’s connection guide ↗</a>, connect the MCP
                address below, then sign in and choose your workspace.
              </p>
              <div className="workflow-code">
                <code>{gatewayOrigin}/mcp</code>
                <CopyButton text={`${gatewayOrigin}/mcp`} label="Copy MCP address" />
              </div>
              {requestError ? (
                <p className="detail-note">{requestError}</p>
              ) : (
                <div className="workflow-code">
                  <pre>
                    <code>{agentBrief}</code>
                  </pre>
                  <CopyButton text={agentBrief} label="Copy agent brief" />
                </div>
              )}
            </>
          ) : (
            <>
              <p>
                <a href="/dashboard#keys">Create an API key ↗</a> with read and generate
                permissions. Set <code>OPENGEN_API_KEY</code> privately in your terminal or server.
              </p>
              <h4>1. Save your inputs as request.json</h4>
              {requestError ? (
                <p className="detail-note">{requestError}</p>
              ) : (
                <div className="workflow-code">
                  <pre>
                    <code>{requestJson}</code>
                  </pre>
                  <CopyButton text={requestJson} label="Copy request JSON" />
                </div>
              )}
              <h4>2. Check the quote</h4>
              <div className="workflow-code">
                <pre>
                  <code>{quoteCommand}</code>
                </pre>
                <CopyButton text={quoteCommand} label="Copy quote command" />
              </div>
              <details>
                <summary>3. Submit when you’re ready, then check the job</summary>
                <p>
                  Confirm the route, request estimate, billing source, credit hold and spend cap.
                  Set and save a unique <code>OPENGEN_REQUEST_ID</code> for this generation; reuse
                  it with the same request for retries. A submission is billable.
                </p>
                <div className="workflow-code">
                  <pre>
                    <code>{generateCommand}</code>
                  </pre>
                  <CopyButton text={generateCommand} label="Copy generation command" />
                </div>
                <p>
                  Save the returned job ID as <code>OPENGEN_JOB_ID</code> and poll it. Keep your
                  request ID if the submission times out; do not start a replacement generation.
                </p>
                <div className="workflow-code">
                  <pre>
                    <code>{pollCommand}</code>
                  </pre>
                  <CopyButton text={pollCommand} label="Copy job command" />
                </div>
              </details>
              <a href="/docs#generate">Full API guide ↗</a>
            </>
          )}
          <p className="workflow-note">
            Generation needs a configured gateway and workspace credit or a saved provider
            connection. Keep API and provider keys out of prompts and browser code.
          </p>
        </div>
      )}
    </section>
  );
}

export { Playground } from './private-playground';

export function OutputCredentials({ asset }: { asset: OutputAsset }) {
  const verification = asset.c2pa;
  const labels = {
    trusted: 'Trusted signer',
    valid: 'Valid signature · signer trust not established',
    invalid: 'Invalid content credentials',
    absent: 'No content credentials found',
    unknown: 'Verification result unknown',
    unavailable: 'Verification unavailable',
  };
  return (
    <div className={`output-credentials ${verification?.status ?? 'unknown'}`}>
      <span>
        Content credentials: {verification ? labels[verification.status] : 'Not verified'}
      </span>
      {(verification || asset.sha256) && (
        <details>
          <summary>View provenance</summary>
          <dl>
            {verification && (
              <>
                <div>
                  <dt>Checked</dt>
                  <dd>{new Date(verification.checkedAt).toLocaleString()}</dd>
                </div>
                {verification.signer && (
                  <div>
                    <dt>Signer</dt>
                    <dd>{verification.signer}</dd>
                  </div>
                )}
                {verification.validationCodes.length > 0 && (
                  <div>
                    <dt>Validation codes</dt>
                    <dd>{verification.validationCodes.join(', ')}</dd>
                  </div>
                )}
              </>
            )}
            <div>
              <dt>SHA-256</dt>
              <dd>
                <code>{asset.sha256 ?? verification?.sha256}</code>
              </dd>
            </div>
            {asset.byteLength !== undefined && (
              <div>
                <dt>File size</dt>
                <dd>{asset.byteLength.toLocaleString()} bytes</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}

export function Footer() {
  const legal = useLegalPresentation();
  return (
    <footer className="site-footer page-width">
      <a className="brand" href="/">
        <img src="/brand/opengen-wordmark-on-dark.svg" width="142" height="34" alt="OpenGen" />
      </a>
      <p>Open-source image & video routing.</p>
      <div>
        <a href="/docs">Documentation</a>
        <a href="/docs#self-host">Self-host</a>
        <a href="/feedback">Private feedback</a>
        {legal.mode === 'published' ? (
          <>
            <a href="/terms">Terms of Service</a>
            <a href="/privacy">Privacy Notice</a>
          </>
        ) : legal.mode === 'staged' ? (
          <>
            <a href="/terms">Terms (scheduled)</a>
            <a href="/privacy">Privacy Notice (scheduled)</a>
          </>
        ) : (
          <>
            <a href="/terms">Terms draft</a>
            <a href="/privacy">Privacy draft</a>
          </>
        )}
        <span>Apache 2.0</span>
      </div>
    </footer>
  );
}
