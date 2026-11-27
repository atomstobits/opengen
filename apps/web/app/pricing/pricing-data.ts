import { catalog, modelSeries, seriesHref } from '@media-router/catalog';
import {
  operationLabel,
  routePublishedPricingForOperation,
  type Catalog,
  type Deployment,
  type Model,
  type Provider,
  type Route,
} from '@media-router/contracts';
import { previewProcessingFee, type ProcessingFeePreview } from '../billing/billing-client';
import { regionNames } from '../route-identity';
import { formatRouteUnitPrice, resolveDisplayedRouteRate } from '../route-pricing-comparison';
import { canonicalUrl } from '../seo';

export const MAX_WEB_TRIAL_CREDIT_MICROS = 5_000_000;

export const FEE_PREVIEW_AMOUNTS_CENTS = [500, 1000, 2500, 10000, 50000] as const;

export interface WebTrialCreditOffer {
  readonly enabled: boolean;
  readonly amountMicros: number;
  readonly formattedUsd: string | null;
}

export interface FeeBreakdownRow {
  readonly creditCents: number;
  readonly domestic: ProcessingFeePreview;
  readonly international: ProcessingFeePreview;
}

export interface PricingHighlightRow {
  readonly routeId: string;
  readonly modelId: string;
  readonly modelName: string;
  readonly modality: Model['modality'];
  readonly href: string;
  readonly providerName: string;
  readonly official: boolean;
  readonly region: string;
  readonly status: 'live-verified' | 'documented';
  readonly scopeLabel: string;
  readonly priceLabel: string;
  readonly priceAvailable: boolean;
  readonly priceNote: string;
  readonly checkedAt: string;
  readonly sourceUrl: string;
}

export interface PricingCatalogSummary {
  readonly stats: {
    readonly modelsCount: number;
    readonly seriesCount: number;
    readonly routesCount: number;
    readonly providersCount: number;
    readonly liveVerifiedCount: number;
    readonly documentedCount: number;
  };
  readonly liveVerifiedHighlights: readonly PricingHighlightRow[];
  readonly documentedHighlights: readonly PricingHighlightRow[];
}

const usdCentsFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

export function formatUsdCents(cents: number): string {
  return usdCentsFormatter.format(cents / 100);
}

export function formatTrialMicrosUsd(amountMicros: number): string {
  const dollars = amountMicros / 1_000_000;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: amountMicros % 10_000 === 0 ? 2 : 4,
  }).format(dollars);
}

/**
 * Reads optional deployment starter trial credit offer strictly from `OPENGEN_TRIAL_CREDIT_MICROS`.
 * Defaults to disabled (`0`) and fails safe on invalid values so public pages never advertise
 * unconfigured or unbounded promotional credits.
 */
export function readWebTrialCreditOffer(
  env: Readonly<Record<string, string | undefined>> = process.env,
): WebTrialCreditOffer {
  const raw = env.OPENGEN_TRIAL_CREDIT_MICROS?.trim();
  if (!raw || raw === '0' || !/^\d+$/.test(raw)) {
    return Object.freeze({ enabled: false, amountMicros: 0, formattedUsd: null });
  }
  const amountMicros = Number(raw);
  if (
    !Number.isSafeInteger(amountMicros) ||
    amountMicros <= 0 ||
    amountMicros > MAX_WEB_TRIAL_CREDIT_MICROS
  ) {
    return Object.freeze({ enabled: false, amountMicros: 0, formattedUsd: null });
  }
  return Object.freeze({
    enabled: true,
    amountMicros,
    formattedUsd: formatTrialMicrosUsd(amountMicros),
  });
}

export function buildFeeBreakdownRows(): readonly FeeBreakdownRow[] {
  return FEE_PREVIEW_AMOUNTS_CENTS.map((creditCents) => {
    const domestic = previewProcessingFee(creditCents, 'US');
    const international = previewProcessingFee(creditCents, 'GB');
    if (!domestic || !international) {
      throw new Error(`Invalid top-up preview amount: ${creditCents}`);
    }
    return { creditCents, domestic, international };
  });
}

export function formatRoutePricingHighlight(
  route: Route,
  model: Model,
  deployment: Deployment,
  provider: Provider,
): PricingHighlightRow {
  const operation = route.liveVerification?.operation ?? route.operations[0];
  let resolution = route.liveVerification?.resolution ?? route.resolutions[0] ?? '';
  let resolved = resolveDisplayedRouteRate(route, resolution, model.modality, operation);
  if (!resolved && !route.liveVerification) {
    for (const candidateRes of route.resolutions) {
      const attempt = resolveDisplayedRouteRate(route, candidateRes, model.modality, operation);
      if (attempt) {
        resolution = candidateRes;
        resolved = attempt;
        break;
      }
    }
  }

  const published = routePublishedPricingForOperation(route, operation);
  const scopeParts: string[] = [];
  if (resolution) scopeParts.push(resolution);
  if (route.liveVerification?.duration !== undefined) {
    scopeParts.push(`${route.liveVerification.duration}s`);
  }
  if (operation) scopeParts.push(operationLabel(operation));

  const priceAvailable = resolved !== null && resolved.rate.usdMicros > 0;
  const priceLabel = priceAvailable
    ? formatRouteUnitPrice(resolved!.rate.usdMicros, resolved!.rate.unit, resolved!.approximate)
    : 'Price unavailable';

  const priceNote = !priceAvailable
    ? (published?.summary ?? 'Comparison only or BYOK — no published per-unit rate.')
    : resolved!.qualified
      ? route.status === 'live-verified'
        ? 'Verified hosted route tariff'
        : 'Published fixed list tariff'
      : resolved!.approximate
        ? 'Approximate published token rate'
        : 'Published list estimate';

  return {
    routeId: route.id,
    modelId: model.id,
    modelName: model.name,
    modality: model.modality,
    href: seriesHref(model.id) ?? '/models',
    providerName: provider.name,
    official: model.authorProviderIds.includes(deployment.providerId),
    region: regionNames[deployment.endpointRegion] ?? deployment.endpointRegion,
    status: route.status === 'live-verified' ? 'live-verified' : 'documented',
    scopeLabel: scopeParts.join(' · ') || 'See route details',
    priceLabel,
    priceAvailable,
    priceNote,
    checkedAt:
      route.liveVerification?.checkedAt ??
      resolved?.source.checkedAt ??
      route.pricingSource.checkedAt,
    sourceUrl: resolved?.source.url ?? route.pricingSource.url,
  };
}

const PREFERRED_DOCUMENTED_MODELS = [
  'openai/gpt-image-2.5',
  'openai/gpt-image-2',
  'google/nano-banana-2.1',
  'bytedance/seedream-5.0-pro',
  'alibaba/qwen-image-3.0-pro',
  'bytedance/seedance-2.5',
  'bytedance/seedance-2.5-flash',
  'minimax/h3-max',
  'google/gemini-omni-1.1-flash',
  'xai/grok-imagine-video-1.5',
] as const;

export function buildPricingCatalogSummary(
  sourceCatalog: Catalog = catalog,
): PricingCatalogSummary {
  const modelsById = new Map(sourceCatalog.models.map((m) => [m.id, m]));
  const deploymentsById = new Map(sourceCatalog.deployments.map((d) => [d.id, d]));
  const providersById = new Map(sourceCatalog.providers.map((p) => [p.id, p]));

  const activeRoutes = sourceCatalog.routes.filter((route) => route.status !== 'retired');
  const liveRoutes = activeRoutes.filter((route) => route.status === 'live-verified');
  const documentedRoutes = activeRoutes.filter((route) => route.status === 'documented');

  const toHighlight = (route: Route): PricingHighlightRow | null => {
    const model = modelsById.get(route.modelId);
    const deployment = deploymentsById.get(route.deploymentId);
    const provider = deployment ? providersById.get(deployment.providerId) : undefined;
    if (!model || !deployment || !provider) return null;
    return formatRoutePricingHighlight(route, model, deployment, provider);
  };

  const liveVerifiedHighlights = liveRoutes
    .map(toHighlight)
    .filter((row): row is PricingHighlightRow => row !== null);

  const liveModelIds = new Set(liveVerifiedHighlights.map((row) => row.modelId));
  const documentedHighlights: PricingHighlightRow[] = [];
  const pickedModels = new Set<string>();

  const pickDocumentedForModel = (modelId: string) => {
    if (liveModelIds.has(modelId) || pickedModels.has(modelId)) return;
    const candidate = documentedRoutes.find((route) => route.modelId === modelId);
    if (!candidate) return;
    const row = toHighlight(candidate);
    if (!row) return;
    pickedModels.add(modelId);
    documentedHighlights.push(row);
  };

  for (const modelId of PREFERRED_DOCUMENTED_MODELS) {
    pickDocumentedForModel(modelId);
  }

  // Ensure any unpriced documented route is represented truthfully if present in the catalog.
  for (const route of documentedRoutes) {
    if (documentedHighlights.length >= 10) break;
    if (liveModelIds.has(route.modelId) || pickedModels.has(route.modelId)) continue;
    const row = toHighlight(route);
    if (row && !row.priceAvailable) {
      pickedModels.add(route.modelId);
      documentedHighlights.push(row);
    }
  }

  // Fill up to 10 total documented highlights if fewer than 10 matched preferred models.
  for (const route of documentedRoutes) {
    if (documentedHighlights.length >= 10) break;
    pickDocumentedForModel(route.modelId);
  }

  return {
    stats: {
      modelsCount: sourceCatalog.models.length,
      seriesCount: modelSeries.length,
      routesCount: activeRoutes.length,
      providersCount: sourceCatalog.providers.length,
      liveVerifiedCount: liveRoutes.length,
      documentedCount: documentedRoutes.length,
    },
    liveVerifiedHighlights,
    documentedHighlights,
  };
}

export function pricingStructuredData(): Record<string, unknown> {
  const pageUrl = canonicalUrl('/pricing');
  return {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': `${pageUrl}#page`,
    name: 'OpenGen Pricing — Pay-as-you-go image and video generation API',
    url: pageUrl,
    description:
      'Zero subscription fees and zero seat fees. Add prepaid USD credit or bring your own provider keys (BYOK), with source-linked catalog pricing.',
    isPartOf: { '@id': `${canonicalUrl('/')}#website` },
    breadcrumb: {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'OpenGen', item: canonicalUrl('/') },
        { '@type': 'ListItem', position: 2, name: 'Pricing', item: pageUrl },
      ],
    },
    relatedLink: [canonicalUrl('/models'), canonicalUrl('/billing'), canonicalUrl('/docs')],
  };
}
