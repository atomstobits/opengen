import { catalog, getCompany, getModel, seriesHref } from '@media-router/catalog';
import type { ModelSeries } from '@media-router/contracts';
import { Icon } from './ui';

export function SeriesCards({
  series,
  compact = false,
}: {
  series: ModelSeries[];
  compact?: boolean;
}) {
  return (
    <div className="series-card-list">
      {series.map((item) => {
        const models = item.modelIds.flatMap((id) => {
          const model = getModel(id);
          return model ? [model] : [];
        });
        const routeCount = catalog.routes.filter((route) =>
          item.modelIds.includes(route.modelId),
        ).length;
        const owner = getCompany(item.companyId);
        return (
          <article
            className="series-card"
            key={item.id}
            data-testid="series-card"
            data-media={models[0]?.modality}
          >
            <div className="series-card-top">
              <span className={`model-glyph large ${models[0]?.modality}`}>
                {models[0]?.modality === 'video' ? '▶' : '▧'}
              </span>
              <div>
                <a className="series-card-owner" href={`/${item.companyId}`}>
                  {owner?.name}
                </a>
                <h2>
                  <a href={`/${item.id}`}>{item.name}</a>
                </h2>
              </div>
              <a
                className="series-card-arrow"
                aria-label={`Explore ${item.name} series`}
                href={`/${item.id}`}
              >
                <Icon name="arrow" size={19} />
              </a>
            </div>
            <p>{item.description}</p>
            <div className="series-card-meta">
              <span>{models[0]?.modality === 'video' ? 'Video' : 'Image'}</span>
              <span>
                {models.length} {models.length === 1 ? 'variant' : 'variants'}
              </span>
              <span>
                {routeCount} {routeCount === 1 ? 'provider route' : 'provider routes'}
              </span>
            </div>
            {!compact && (
              <div className="company-model-links">
                {models.map((model) => (
                  <a key={model.id} href={seriesHref(model.id)}>
                    {model.name}
                    <Icon name="chevron" size={11} />
                  </a>
                ))}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
