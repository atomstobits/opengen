import {
  formatComparisonScope,
  formatRouteUnitPrice,
  formatUsdMicros,
  type CardPricingSummary,
} from './route-pricing-comparison';

export function CardPricing({
  summary,
  variant = 'series',
  multiVariant = false,
}: {
  summary: CardPricingSummary;
  variant?: 'series' | 'directory' | 'compact';
  multiVariant?: boolean;
}) {
  const { lowest, savings } = summary;
  if (!lowest && !savings) return null;

  const lowestUnit = lowest ? (lowest.unit === 'image' ? 'image' : 'sec') : null;
  const lowestAmount = lowest ? formatUsdMicros(lowest.usdMicros, lowest.approximate) : null;
  const lowestScope = lowest
    ? [
        multiVariant ? lowest.modelName : undefined,
        lowest.quality ? `${lowest.resolution} (${lowest.quality})` : lowest.resolution,
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const lowestTitle = lowest
    ? `Lowest published rate: ${lowestAmount} / ${lowestUnit}${lowestScope ? ` (${lowestScope})` : ''}`
    : undefined;

  const best = savings?.bestComparison;
  const savingsTitle =
    savings && best
      ? `${savings.label} across ${savings.modelName} routes (${formatComparisonScope(best)}: ${formatRouteUnitPrice(best.cheapestMicros, best.unit, best.cheapestApproximate)} vs. ${formatRouteUnitPrice(best.mostExpensiveMicros, best.unit, best.mostExpensiveApproximate)})`
      : undefined;

  const containerClass =
    variant === 'series'
      ? 'series-card-pricing'
      : variant === 'compact'
        ? 'model-directory-pricing is-compact'
        : 'model-directory-pricing';

  return (
    <div className={containerClass} data-testid="card-pricing">
      {lowest && (
        <span className="card-price" title={lowestTitle} data-testid="card-price">
          <span className="card-price-prefix">From</span> <strong>{lowestAmount}</strong>{' '}
          <small>/ {lowestUnit}</small>
        </span>
      )}
      {savings && (
        <span className="card-savings-badge" title={savingsTitle} data-testid="card-savings">
          {savings.label}
        </span>
      )}
    </div>
  );
}
