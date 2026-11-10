'use client';

import { useState } from 'react';
import type { Catalog, Model } from '@media-router/contracts';
import {
  CopyButton,
  hasCompletionSamples,
  Icon,
  PercentileControl,
  ProviderTable,
  useRouteMetrics,
  type LatencyPercentile,
} from './ui';
import { playgroundHref } from './links';

export function SeriesProviders({
  catalog,
  models,
  selectedVariant,
}: {
  catalog: Catalog;
  models: Model[];
  selectedVariant?: string;
}) {
  const metrics = useRouteMetrics();
  const [percentile, setPercentile] = useState<LatencyPercentile>('p50');
  const variants = models.map((model) => ({
    model,
    routes: catalog.routes.filter((route) => route.modelId === model.id),
  }));
  const routeIds = new Set(variants.flatMap(({ routes }) => routes.map((route) => route.id)));
  const showCompletionControl = metrics.some(
    (observation) => routeIds.has(observation.routeId) && hasCompletionSamples(observation),
  );
  return (
    <section className="series-providers" id="providers" aria-labelledby="providers-title">
      <div className="series-section-heading">
        <div>
          <span className="eyebrow">COMPARE SERVING ROUTES</span>
          <h2 id="providers-title">Providers</h2>
        </div>
        {showCompletionControl && <PercentileControl value={percentile} onChange={setPercentile} />}
      </div>
      <p className="series-section-intro">
        Every variant and regional deployment is listed separately. Choose an exact variant when
        generating; provider routing never substitutes another variant.
      </p>
      <div className="variant-sections">
        {variants.map(({ model, routes }) => {
          return (
            <section
              key={model.id}
              className={`variant-section ${selectedVariant === model.id ? 'variant-highlighted' : ''}`}
              id={`variant-${model.id.replaceAll('/', '-')}`}
              data-testid="series-variant"
              data-model-id={model.id}
              data-media={model.modality}
              aria-label={`${model.name} providers`}
            >
              <div className="variant-section-heading">
                <div>
                  <div className="variant-attribution">
                    <span className={`model-glyph ${model.modality}`}>
                      {model.modality === 'video' ? '▶' : '▧'}
                    </span>
                    <span>VARIANT BY {model.creator}</span>
                    <span className="official-tag" title="Original author of this exact variant">
                      Official
                    </span>
                    {selectedVariant === model.id && (
                      <span className="selected-variant-label">SELECTED</span>
                    )}
                  </div>
                  <h2>{model.name}</h2>
                  <div className="variant-api-id">
                    <code>{model.id}</code>
                    <CopyButton text={model.id} label="Copy model ID" />
                  </div>
                </div>
                <a className="button button-outline" href={playgroundHref(model.id)}>
                  Try this variant <Icon name="arrow" size={14} />
                </a>
              </div>
              <p className="variant-description">{model.description}</p>
              <div className="variant-facts">
                <span className={model.openness === 'open-weights' ? 'weight-tag' : 'hosting-tag'}>
                  {model.openness === 'open-weights' ? 'Open weights' : 'Hosted model'}
                </span>
                <span>
                  {routes.length} {routes.length === 1 ? 'provider route' : 'provider routes'}
                </span>
                <a href={model.source.url} target="_blank" rel="noreferrer">
                  Original variant ↗
                </a>
              </div>
              <ProviderTable
                model={model}
                routes={routes}
                catalog={catalog}
                metrics={metrics}
                percentile={percentile}
                tryHref={(routeId) => playgroundHref(model.id, routeId)}
              />
            </section>
          );
        })}
      </div>
      <p className="series-observation-note">
        Endpoint region does not establish inference residency. Success rate describes generation
        outcomes, not uptime. Measurements reflect this installation’s observed jobs across
        settings. A dash beside a supported resolution indicates unavailable unit pricing.
      </p>
    </section>
  );
}
