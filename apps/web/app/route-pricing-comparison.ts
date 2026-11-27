import {
  operationLabel,
  routePricingSourceForOperation,
  routePublishedPricingForOperation,
  routeResolutionsForOperation,
  sortOperations,
  type Catalog,
  type Model,
  type Operation,
  type Rate,
  type Route,
} from '@media-router/contracts';
import { routeIdentity } from './route-identity';

export type PublishedOutputRate = NonNullable<
  NonNullable<Route['publishedPricing']>['outputRates']
>[number];
export type PublishedQuality = NonNullable<PublishedOutputRate['quality']>;

export function preferredDisplayQuality(modelId: string): PublishedQuality | undefined {
  if (modelId.startsWith('openai/gpt-image-')) return 'medium';
  if (modelId === 'xai/grok-imagine-image-2.0') return 'low';
  return undefined;
}

export interface DisplayedRouteRate {
  rate: Rate;
  source: Route['pricingSource'];
  qualified: boolean;
  approximate: boolean;
  quality?: PublishedQuality;
}

/**
 * Resolves the single rate displayed for a route at a given resolution and optional operation lens.
 * Shared by ProviderPrice and cheapest-route comparison so highlights always match visible prices.
 */
export function resolveDisplayedRouteRate(
  route: Route,
  resolution: string,
  modality: Model['modality'],
  selectedOperation?: Operation,
): DisplayedRouteRate | null {
  const unit: Rate['unit'] = modality === 'video' ? 'output-second' : 'image';
  if (selectedOperation && !route.operations.includes(selectedOperation)) return null;
  const explicitOpResolutions = selectedOperation
    ? route.operationCapabilities?.[selectedOperation]?.resolutions
    : undefined;
  const allowedResolutions = explicitOpResolutions ?? route.resolutions;
  if (
    resolution &&
    allowedResolutions.length > 0 &&
    !allowedResolutions.some((item) => item.toLowerCase() === resolution.toLowerCase())
  )
    return null;
  if (resolution && explicitOpResolutions !== undefined && explicitOpResolutions.length === 0)
    return null;
  const effectiveOperation =
    selectedOperation ?? (route.operations.length === 1 ? route.operations[0] : undefined);
  const matches = (rate: Rate) =>
    rate.unit === unit && rate.resolution.toLowerCase() === resolution.toLowerCase();
  const matchesOperation = (rate: Rate) =>
    !effectiveOperation || !rate.operation || rate.operation === effectiveOperation;
  const published = routePublishedPricingForOperation(route, effectiveOperation);
  const pricingSource = routePricingSourceForOperation(route, effectiveOperation);
  const preferredQuality = preferredDisplayQuality(route.modelId);
  const qualifiedRate = route.rates.find((rate) => matches(rate) && matchesOperation(rate));
  const eligiblePublished = (published?.outputRates ?? []).filter(
    (rate) =>
      matches(rate) &&
      (!rate.operation ||
        (effectiveOperation
          ? rate.operation === effectiveOperation
          : route.operations.includes(rate.operation))),
  );
  const publishedRate =
    (preferredQuality
      ? eligiblePublished.find((rate) => rate.quality === preferredQuality)
      : undefined) ?? eligiblePublished[0];
  const rate = qualifiedRate ?? publishedRate;
  if (!rate) return null;
  const quality = qualifiedRate ? preferredQuality : publishedRate?.quality;
  return {
    rate,
    source: qualifiedRate ? pricingSource : (published?.source ?? pricingSource),
    qualified: Boolean(qualifiedRate),
    approximate: !qualifiedRate && Boolean(publishedRate?.approximate),
    ...(quality ? { quality } : {}),
  };
}

export interface CheapestComparisonEntry {
  resolution: string;
  quality?: PublishedQuality;
  operations: Operation[];
  unit: Rate['unit'];
  cheapestMicros: number;
  cheapestApproximate: boolean;
  cheapestQualified: boolean;
  mostExpensiveMicros: number;
  mostExpensiveApproximate: boolean;
  mostExpensiveQualified: boolean;
  mostExpensiveRouteIds: string[];
  mostExpensiveLabels: string[];
  percentOff: number;
  comparedRouteCount: number;
  tiedCheapestCount: number;
}

export interface CheapestRouteHighlight {
  routeId: string;
  /** Maximum rounded savings percentage across comparable (operation, resolution, quality) cohorts. */
  maxPercentOff: number;
  /** Minimum rounded savings percentage across cohorts where this route is cheapest. */
  minPercentOff: number;
  /** Plain-language savings text rendered next to the Cheapest tag, e.g. '17% off' or 'Up to 9% off'. */
  savingsLabel: string;
  /** Winning resolutions in display casing (lowercase-normalized set also exposed via resolutions). */
  winningResolutions: string[];
  /** Deduplicated comparison rows rendered inside the hover/focus detail popover. */
  comparisons: CheapestComparisonEntry[];
  /** True when every winning cohort is tied with at least one other route. */
  isTied: boolean;
  /** True when any compared rate (cheapest or most expensive) is an un-qualified/approximate published figure. */
  usesPublishedEstimates: boolean;
}

const priceFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

export function formatUsdMicros(usdMicros: number, approximate = false): string {
  return `${approximate ? '≈' : ''}$${priceFormatter.format(usdMicros / 1_000_000)}`;
}

export function formatRouteUnitPrice(
  usdMicros: number,
  unit: Rate['unit'],
  approximate = false,
): string {
  return `${formatUsdMicros(usdMicros, approximate)} / ${unit === 'image' ? 'image' : 'sec'}`;
}

function compareRouteLabel(
  catalog: Catalog,
  route: Route,
  operation: Operation,
  variantRoutes: readonly Route[],
): string {
  const identity = routeIdentity(catalog, route, operation, variantRoutes);
  return identity.region === 'Not disclosed'
    ? identity.label
    : `${identity.label} · ${identity.region}`;
}

/**
 * Computes apples-to-apples cheapest route highlights for one exact model variant.
 * Routes are compared strictly within the same (operation, resolution, unit, quality) cohort and require
 * at least two positive priced routes with at least 1% rounded savings against the most expensive route.
 */
export function computeCheapestRouteHighlights(
  routes: readonly Route[],
  model: Model,
  catalog: Catalog,
  selectedOperation?: Operation,
): Map<string, CheapestRouteHighlight> {
  const activeRoutes = routes.filter(
    (route) => route.modelId === model.id && route.status !== 'retired',
  );
  const unit: Rate['unit'] = model.modality === 'video' ? 'output-second' : 'image';
  const operations = selectedOperation
    ? [selectedOperation]
    : sortOperations(activeRoutes.flatMap((route) => route.operations));

  const rawByRoute = new Map<
    string,
    Array<Omit<CheapestComparisonEntry, 'operations'> & { operation: Operation }>
  >();

  for (const operation of operations) {
    const resolutions = new Map<string, string>();
    for (const route of activeRoutes) {
      if (!route.operations.includes(operation)) continue;
      for (const resolution of operationResolutions(route, operation, unit)) {
        const key = resolution.toLowerCase();
        if (!resolutions.has(key)) resolutions.set(key, resolution);
      }
    }
    for (const [, resolution] of resolutions) {
      const cohortsByQuality = new Map<
        string,
        {
          quality?: PublishedQuality;
          entries: Array<{ route: Route; resolved: DisplayedRouteRate }>;
        }
      >();
      for (const route of activeRoutes) {
        const resolved = resolveDisplayedRouteRate(route, resolution, model.modality, operation);
        if (!resolved || resolved.rate.usdMicros <= 0) continue;
        const qualityKey = resolved.quality ?? '';
        const bucket = cohortsByQuality.get(qualityKey);
        if (bucket) bucket.entries.push({ route, resolved });
        else
          cohortsByQuality.set(qualityKey, {
            ...(resolved.quality ? { quality: resolved.quality } : {}),
            entries: [{ route, resolved }],
          });
      }

      for (const { quality, entries: priced } of cohortsByQuality.values()) {
        if (priced.length < 2) continue;

        const minMicros = Math.min(...priced.map((entry) => entry.resolved.rate.usdMicros));
        const maxMicros = Math.max(...priced.map((entry) => entry.resolved.rate.usdMicros));
        if (maxMicros <= minMicros) continue;

        const percentOff = Math.round(((maxMicros - minMicros) / maxMicros) * 100);
        if (percentOff < 1) continue;

        const cheapestEntries = priced.filter(
          (entry) => entry.resolved.rate.usdMicros === minMicros,
        );
        const expensiveEntries = priced.filter(
          (entry) => entry.resolved.rate.usdMicros === maxMicros,
        );
        const mostExpensiveRouteIds = expensiveEntries.map((entry) => entry.route.id);
        const mostExpensiveLabels = [
          ...new Set(
            expensiveEntries.map((entry) =>
              compareRouteLabel(catalog, entry.route, operation, activeRoutes),
            ),
          ),
        ];
        const mostExpensiveApproximate = expensiveEntries.some(
          (entry) => entry.resolved.approximate,
        );
        const mostExpensiveQualified = expensiveEntries.every((entry) => entry.resolved.qualified);

        for (const winner of cheapestEntries) {
          const list = rawByRoute.get(winner.route.id) ?? [];
          list.push({
            operation,
            resolution,
            ...(quality ? { quality } : {}),
            unit,
            cheapestMicros: minMicros,
            cheapestApproximate: winner.resolved.approximate,
            cheapestQualified: winner.resolved.qualified,
            mostExpensiveMicros: maxMicros,
            mostExpensiveApproximate,
            mostExpensiveQualified,
            mostExpensiveRouteIds,
            mostExpensiveLabels,
            percentOff,
            comparedRouteCount: priced.length,
            tiedCheapestCount: cheapestEntries.length,
          });
          rawByRoute.set(winner.route.id, list);
        }
      }
    }
  }

  const highlights = new Map<string, CheapestRouteHighlight>();
  for (const [routeId, entries] of rawByRoute) {
    const merged = new Map<string, CheapestComparisonEntry>();
    for (const entry of entries) {
      const key = JSON.stringify([
        entry.resolution.toLowerCase(),
        entry.quality ?? '',
        entry.cheapestMicros,
        entry.cheapestApproximate,
        entry.cheapestQualified,
        entry.mostExpensiveMicros,
        entry.mostExpensiveApproximate,
        entry.mostExpensiveQualified,
        entry.mostExpensiveRouteIds,
        entry.tiedCheapestCount,
      ]);
      const existing = merged.get(key);
      if (existing) {
        if (!existing.operations.includes(entry.operation)) {
          existing.operations = sortOperations([...existing.operations, entry.operation]);
        }
      } else {
        const { operation, ...rest } = entry;
        merged.set(key, { ...rest, operations: [operation] });
      }
    }
    const comparisons = [...merged.values()];
    const maxPercentOff = Math.max(...comparisons.map((entry) => entry.percentOff));
    const minPercentOff = Math.min(...comparisons.map((entry) => entry.percentOff));
    const savingsLabel =
      minPercentOff === maxPercentOff ? `${maxPercentOff}% off` : `Up to ${maxPercentOff}% off`;
    const winningResolutions = [...new Set(comparisons.map((entry) => entry.resolution))];
    highlights.set(routeId, {
      routeId,
      maxPercentOff,
      minPercentOff,
      savingsLabel,
      winningResolutions,
      comparisons,
      isTied: comparisons.every((entry) => entry.tiedCheapestCount > 1),
      usesPublishedEstimates: comparisons.some(
        (entry) => !entry.cheapestQualified || !entry.mostExpensiveQualified,
      ),
    });
  }

  return highlights;
}

export function formatComparisonScope(
  entry: Pick<CheapestComparisonEntry, 'resolution' | 'quality' | 'operations'>,
  selectedOperation?: Operation,
): string {
  const resolutionLabel = entry.quality
    ? `${entry.resolution} (${entry.quality})`
    : entry.resolution;
  if (selectedOperation) return resolutionLabel;
  return `${resolutionLabel} · ${entry.operations.map(operationLabel).join(', ')}`;
}

/**
 * Returns true only when the specific rate currently displayed for a route matches a winning
 * cheapest comparison cohort for the displayed resolution, quality, price, and operation.
 */
export function isDisplayedRateCheapest(
  highlight: CheapestRouteHighlight | undefined,
  resolved: DisplayedRouteRate | null,
  selectedOperation?: Operation,
): boolean {
  if (!highlight || !resolved) return false;
  const targetRes = resolved.rate.resolution.toLowerCase();
  const targetQuality = resolved.quality ?? '';
  const displayedOp = selectedOperation ?? resolved.rate.operation;
  return highlight.comparisons.some(
    (entry) =>
      entry.resolution.toLowerCase() === targetRes &&
      (entry.quality ?? '') === targetQuality &&
      entry.cheapestMicros === resolved.rate.usdMicros &&
      (!displayedOp || entry.operations.includes(displayedOp)),
  );
}

export interface CardLowestPrice {
  modelId: string;
  modelName: string;
  routeId: string;
  resolution: string;
  quality?: PublishedQuality;
  unit: Rate['unit'];
  usdMicros: number;
  approximate: boolean;
  qualified: boolean;
}

export interface CardSavingsSummary {
  modelId: string;
  modelName: string;
  /** Maximum rounded savings percentage across comparable cohorts (1–99). */
  maxPercentOff: number;
  /** Minimum rounded savings percentage across comparable cohorts where savings exist (1–99). */
  minPercentOff: number;
  /** Plain-language savings badge label rendered on cards, e.g. 'Up to 53% off'. */
  label: string;
  /** Representative winning comparison cohort for tooltip context. */
  bestComparison: CheapestComparisonEntry;
  /** True when any compared rate in the representative cohort is an informational/approximate estimate. */
  usesPublishedEstimates: boolean;
}

export interface CardPricingSummary {
  lowest: CardLowestPrice | null;
  savings: CardSavingsSummary | null;
}

function resolutionRank(resolution: string): number {
  const kMatch = /^(\d+(?:\.\d+)?)k$/i.exec(resolution.trim());
  if (kMatch) return Number(kMatch[1]) * 1000;
  const pMatch = /^(\d+(?:\.\d+)?)p$/i.exec(resolution.trim());
  if (pMatch) return Number(pMatch[1]);
  return Number.POSITIVE_INFINITY;
}

function compareResolution(a: string, b: string): number {
  const rankDiff = resolutionRank(a) - resolutionRank(b);
  if (rankDiff !== 0) return rankDiff;
  return a.localeCompare(b);
}

function isBetterLowestPrice(candidate: CardLowestPrice, current: CardLowestPrice): boolean {
  if (candidate.usdMicros !== current.usdMicros) return candidate.usdMicros < current.usdMicros;
  if (candidate.approximate !== current.approximate) return !candidate.approximate;
  if (candidate.qualified !== current.qualified) return candidate.qualified;
  const resDiff = compareResolution(candidate.resolution, current.resolution);
  if (resDiff !== 0) return resDiff < 0;
  if (candidate.modelId !== current.modelId)
    return candidate.modelId.localeCompare(current.modelId) < 0;
  return candidate.routeId.localeCompare(current.routeId) < 0;
}

function isBetterComparison(
  candidate: CheapestComparisonEntry,
  current: CheapestComparisonEntry,
): boolean {
  const candidatePct = Math.min(99, candidate.percentOff);
  const currentPct = Math.min(99, current.percentOff);
  if (candidatePct !== currentPct) return candidatePct > currentPct;
  const candidateApprox = candidate.cheapestApproximate || candidate.mostExpensiveApproximate;
  const currentApprox = current.cheapestApproximate || current.mostExpensiveApproximate;
  if (candidateApprox !== currentApprox) return !candidateApprox;
  const candidateQualified = candidate.cheapestQualified && candidate.mostExpensiveQualified;
  const currentQualified = current.cheapestQualified && current.mostExpensiveQualified;
  if (candidateQualified !== currentQualified) return candidateQualified;
  if (candidate.cheapestMicros !== current.cheapestMicros)
    return candidate.cheapestMicros < current.cheapestMicros;
  const resDiff = compareResolution(candidate.resolution, current.resolution);
  if (resDiff !== 0) return resDiff < 0;
  return (candidate.operations[0] ?? '').localeCompare(current.operations[0] ?? '') < 0;
}

function isBetterCardSavings(candidate: CardSavingsSummary, current: CardSavingsSummary): boolean {
  if (candidate.maxPercentOff !== current.maxPercentOff)
    return candidate.maxPercentOff > current.maxPercentOff;
  if (isBetterComparison(candidate.bestComparison, current.bestComparison)) return true;
  if (isBetterComparison(current.bestComparison, candidate.bestComparison)) return false;
  return candidate.modelId.localeCompare(current.modelId) < 0;
}

function operationResolutions(route: Route, operation: Operation, unit: Rate['unit']): string[] {
  const explicitOpResolutions = route.operationCapabilities?.[operation]?.resolutions;
  const seen = new Set<string>();
  const result: string[] = [];
  const add = (resolution: string) => {
    const key = resolution.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(resolution);
  };
  if (explicitOpResolutions !== undefined) {
    for (const resolution of explicitOpResolutions) add(resolution);
    return result;
  }
  const declared = routeResolutionsForOperation(route, operation);
  if (declared.length) {
    for (const resolution of declared) add(resolution);
    return result;
  }
  for (const rate of route.rates) {
    if (rate.unit === unit && (!rate.operation || rate.operation === operation))
      add(rate.resolution);
  }
  for (const rate of routePublishedPricingForOperation(route, operation)?.outputRates ?? []) {
    if (rate.unit === unit && (!rate.operation || rate.operation === operation))
      add(rate.resolution);
  }
  return result;
}

/**
 * Summarizes the lowest displayed per-output price and maximum same-cohort route savings
 * for one exact model variant. Reuses resolveDisplayedRouteRate and computeCheapestRouteHighlights
 * so card prices and "% off" labels always agree with the provider comparison table.
 */
export function summarizeVariantCardPricing(
  model: Model,
  routes: readonly Route[],
  catalog: Catalog,
): CardPricingSummary {
  const activeRoutes = routes.filter(
    (route) => route.modelId === model.id && route.status !== 'retired',
  );
  const unit: Rate['unit'] = model.modality === 'video' ? 'output-second' : 'image';
  let lowest: CardLowestPrice | null = null;

  for (const route of activeRoutes) {
    for (const operation of route.operations) {
      for (const resolution of operationResolutions(route, operation, unit)) {
        const resolved = resolveDisplayedRouteRate(route, resolution, model.modality, operation);
        if (
          !resolved ||
          !Number.isSafeInteger(resolved.rate.usdMicros) ||
          resolved.rate.usdMicros <= 0
        )
          continue;
        const candidate: CardLowestPrice = {
          modelId: model.id,
          modelName: model.name,
          routeId: route.id,
          resolution: resolved.rate.resolution,
          ...(resolved.quality ? { quality: resolved.quality } : {}),
          unit: resolved.rate.unit,
          usdMicros: resolved.rate.usdMicros,
          approximate: resolved.approximate,
          qualified: resolved.qualified,
        };
        if (!lowest || isBetterLowestPrice(candidate, lowest)) lowest = candidate;
      }
    }
  }

  const highlights = computeCheapestRouteHighlights(activeRoutes, model, catalog);
  let bestComparison: CheapestComparisonEntry | null = null;
  let maxPercentOff = 0;
  let minPercentOff = Infinity;

  for (const highlight of highlights.values()) {
    for (const comparison of highlight.comparisons) {
      if (
        comparison.cheapestMicros <= 0 ||
        comparison.mostExpensiveMicros <= comparison.cheapestMicros
      )
        continue;
      const pct = Math.min(99, comparison.percentOff);
      if (pct < 1) continue;
      if (pct > maxPercentOff) maxPercentOff = pct;
      if (pct < minPercentOff) minPercentOff = pct;
      if (!bestComparison || isBetterComparison(comparison, bestComparison)) {
        bestComparison = comparison;
      }
    }
  }

  const savings: CardSavingsSummary | null =
    bestComparison && maxPercentOff >= 1
      ? {
          modelId: model.id,
          modelName: model.name,
          maxPercentOff,
          minPercentOff: Number.isFinite(minPercentOff) ? minPercentOff : maxPercentOff,
          label: `Up to ${maxPercentOff}% off`,
          bestComparison,
          usesPublishedEstimates:
            !bestComparison.cheapestQualified || !bestComparison.mostExpensiveQualified,
        }
      : null;

  return { lowest, savings };
}

/**
 * Aggregates card pricing across a series of variants. Starting price is emitted only when all
 * priced variants share one billing unit; "% off" always comes from same-variant route comparisons
 * and never compares different variants against one another.
 */
export function summarizeSeriesCardPricing(
  models: readonly Model[],
  catalog: Catalog,
  routesByModelId?: ReadonlyMap<string, readonly Route[]>,
): CardPricingSummary {
  const summaries = models.map((model) => {
    const routes =
      routesByModelId?.get(model.id) ??
      catalog.routes.filter((route) => route.modelId === model.id);
    return summarizeVariantCardPricing(model, routes, catalog);
  });

  const units = new Set(
    summaries.flatMap((summary) => (summary.lowest ? [summary.lowest.unit] : [])),
  );
  let lowest: CardLowestPrice | null = null;
  if (units.size === 1) {
    for (const summary of summaries) {
      if (summary.lowest && (!lowest || isBetterLowestPrice(summary.lowest, lowest))) {
        lowest = summary.lowest;
      }
    }
  }

  let savings: CardSavingsSummary | null = null;
  for (const summary of summaries) {
    if (summary.savings && (!savings || isBetterCardSavings(summary.savings, savings))) {
      savings = summary.savings;
    }
  }

  return { lowest, savings };
}
