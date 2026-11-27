'use client';

import { useMemo, useState } from 'react';
import { getModelRoutes, modelSeries, seriesHref } from '@media-router/catalog';
import type { Catalog, Operation } from '@media-router/contracts';
import { CardPricing } from './card-pricing';
import {
  buildCatalogModelEntries,
  describeEndpointRegions,
  groupCatalogModels,
  variantGridColumns,
} from './model-groups';
import {
  summarizeSeriesCardPricing,
  summarizeVariantCardPricing,
} from './route-pricing-comparison';
import { Icon, Playground, regionNames } from './ui';
import type { PlaygroundDraftTransfer } from './private-playground';

function routeCountLabel(count: number, region: string): string {
  if (region === 'all') return count === 1 ? 'provider route' : 'provider routes';
  return count === 1 ? 'matching route' : 'matching routes';
}

export function ModelsCatalog({
  catalog,
  initialQuery = '',
  initialModality = 'all',
  initialRegion = 'all',
}: {
  catalog: Catalog;
  initialQuery?: string;
  initialModality?: 'all' | 'image' | 'video';
  initialRegion?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [modality, setModality] = useState(initialModality);
  const [region, setRegion] = useState(initialRegion);
  const entries = useMemo(() => buildCatalogModelEntries(catalog, regionNames), [catalog]);
  const regions = [
    ...new Set(catalog.deployments.map((deployment) => deployment.endpointRegion)),
  ].sort();
  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (modality === 'all' || entry.model.modality === modality) &&
          (region === 'all' ||
            entry.deployments.some((deployment) => deployment.endpointRegion === region)) &&
          entry.search.includes(query.trim().toLowerCase()),
      ),
    [entries, modality, region, query],
  );
  const groups = useMemo(() => groupCatalogModels(entries, filtered), [entries, filtered]);
  return (
    <>
      <div className="catalog-toolbar">
        <label className="search-box">
          <Icon name="search" size={18} />
          <input
            aria-label="Search models, providers or regions"
            placeholder="Search models, companies or providers…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="segmented" aria-label="Model type">
          {(['all', 'video', 'image'] as const).map((value) => (
            <button
              key={value}
              className={modality === value ? 'selected' : ''}
              aria-pressed={modality === value}
              aria-label={value === 'all' ? 'All models' : undefined}
              onClick={() => setModality(value)}
            >
              {value === 'all' ? 'All' : value === 'video' ? 'Video' : 'Image'}
            </button>
          ))}
        </div>
        <label className="region-filter">
          <Icon name="globe" size={16} />
          <select
            aria-label="Filter endpoint region"
            value={region}
            onChange={(event) => setRegion(event.target.value)}
          >
            <option value="all">All regions</option>
            {regions.map((value) => (
              <option key={value} value={value}>
                {regionNames[value] ?? value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="catalog-results-heading">
        <p aria-live="polite">
          {groups.length} model series · {filtered.length}{' '}
          {filtered.length === 1 ? 'exact variant' : 'exact variants'}
        </p>
        <span>Grouped by model series. Separate regional providers.</span>
      </div>
      <div className="model-directory-list">
        {groups.map((group) => {
          const variantItems = group.entries.map((entry) => {
            const matchingDeployments = entry.deployments.filter(
              (deployment) => region === 'all' || deployment.endpointRegion === region,
            );
            const matchingRoutes = entry.routes.filter((route) =>
              matchingDeployments.some((deployment) => deployment.id === route.deploymentId),
            );
            return {
              ...entry,
              matchingDeployments,
              matchingRoutes,
              pricing: summarizeVariantCardPricing(entry.model, matchingRoutes, catalog),
              regionText: describeEndpointRegions(matchingRoutes.length, matchingDeployments),
            };
          });

          if (group.totalVariants <= 1) {
            const { model, company, matchingRoutes, pricing, regionText } = variantItems[0]!;
            const href = seriesHref(model.id);
            return (
              <section
                className="model-series-group single-variant"
                key={group.id}
                data-series-id={group.id}
                data-testid="model-series-group"
                data-media={group.modality}
                aria-label={`${group.name} model series`}
              >
                <article
                  className="model-directory-card"
                  data-model-id={model.id}
                  data-media={model.modality}
                >
                  <div className="model-directory-main">
                    <div className="model-directory-publisher">
                      <span className={`model-glyph ${model.modality}`} aria-hidden="true">
                        {model.modality === 'video' ? '▶' : '▧'}
                      </span>
                      {company ? (
                        <a href={`/${company.id}`}>{company.name}</a>
                      ) : (
                        <span>{model.creator}</span>
                      )}
                      {company && company.name !== model.creator && (
                        <span className="variant-creator">by {model.creator}</span>
                      )}
                      <span className="modality-tag">
                        {model.modality === 'video' ? 'Video' : 'Image'}
                      </span>
                      {model.openness === 'open-weights' && (
                        <span className="weight-tag">Open weights</span>
                      )}
                    </div>
                    <h2>
                      <a href={href}>
                        {model.name}
                        <Icon name="arrow" size={20} />
                      </a>
                    </h2>
                    <p>{model.description}</p>
                    <div className="model-directory-source">
                      <code>{model.id}</code>
                      <a href={model.source.url} target="_blank" rel="noreferrer">
                        Original model ↗
                      </a>
                    </div>
                  </div>
                  <div className="model-directory-offerings">
                    <CardPricing summary={pricing} variant="directory" />
                    <div className="model-directory-route-stat">
                      <strong>
                        {matchingRoutes.length}{' '}
                        <span>{routeCountLabel(matchingRoutes.length, region)}</span>
                      </strong>
                      <p>{regionText}</p>
                    </div>
                    <a href={href}>
                      Compare providers <Icon name="arrow" size={15} />
                    </a>
                  </div>
                </article>
              </section>
            );
          }

          const groupRoutesCount = variantItems.reduce(
            (sum, item) => sum + item.matchingRoutes.length,
            0,
          );
          const groupDeployments = variantItems.flatMap((item) => item.matchingDeployments);
          const groupRegionText = describeEndpointRegions(groupRoutesCount, groupDeployments);
          const groupPricing = summarizeSeriesCardPricing(
            variantItems.map((item) => item.model),
            catalog,
            new Map(variantItems.map((item) => [item.model.id, item.matchingRoutes])),
          );
          const columns = variantGridColumns(variantItems.length);

          return (
            <section
              className="model-series-group has-variants"
              key={group.id}
              data-series-id={group.id}
              data-testid="model-series-group"
              data-media={group.modality}
              aria-label={`${group.name} model series`}
            >
              <div className="model-series-header">
                <div className="model-series-intro">
                  <div className="model-series-kicker">
                    <span className={`model-glyph ${group.modality}`} aria-hidden="true">
                      {group.modality === 'video' ? '▶' : '▧'}
                    </span>
                    {group.company ? (
                      <a href={`/${group.company.id}`}>{group.company.name}</a>
                    ) : (
                      <span>{variantItems[0]!.model.creator}</span>
                    )}
                    <span className="modality-tag">
                      {group.modality === 'video' ? 'Video' : 'Image'}
                    </span>
                    <span className="variant-count-tag">
                      {variantItems.length === group.totalVariants
                        ? `${group.totalVariants} variants`
                        : `${variantItems.length} of ${group.totalVariants} variants`}
                    </span>
                  </div>
                  <h2 className="model-series-title">
                    {group.href ? (
                      <a href={group.href}>
                        {group.name}
                        <Icon name="arrow" size={20} />
                      </a>
                    ) : (
                      group.name
                    )}
                  </h2>
                  <p className="model-series-description">{group.description}</p>
                </div>
                <div className="model-series-summary">
                  <CardPricing
                    summary={groupPricing}
                    variant="directory"
                    multiVariant={variantItems.length > 1}
                  />
                  <div className="model-directory-route-stat">
                    <strong>
                      {groupRoutesCount} <span>{routeCountLabel(groupRoutesCount, region)}</span>
                    </strong>
                    <p>{groupRegionText}</p>
                  </div>
                  {group.href && (
                    <a href={group.href}>
                      Explore series <Icon name="arrow" size={15} />
                    </a>
                  )}
                </div>
              </div>
              <div className="model-series-variants" data-columns={columns}>
                {variantItems.map(({ model, matchingRoutes, pricing, regionText }) => {
                  const href = seriesHref(model.id);
                  return (
                    <article
                      className="model-directory-card variant-card"
                      key={model.id}
                      data-model-id={model.id}
                      data-media={model.modality}
                    >
                      <div className="model-directory-main">
                        <div className="model-directory-publisher">
                          <span className="variant-creator">by {model.creator}</span>
                          {model.openness === 'open-weights' && (
                            <span className="weight-tag">Open weights</span>
                          )}
                        </div>
                        <h3>
                          <a href={href}>
                            {model.name}
                            <Icon name="arrow" size={17} />
                          </a>
                        </h3>
                        <p>{model.description}</p>
                        <div className="model-directory-source">
                          <code>{model.id}</code>
                          <a href={model.source.url} target="_blank" rel="noreferrer">
                            Original model ↗
                          </a>
                        </div>
                      </div>
                      <div className="model-directory-offerings">
                        <CardPricing
                          summary={pricing}
                          variant={columns === 1 ? 'directory' : 'compact'}
                        />
                        <div className="model-directory-route-stat">
                          <strong>
                            {matchingRoutes.length}{' '}
                            <span>{routeCountLabel(matchingRoutes.length, region)}</span>
                          </strong>
                          <p>{regionText}</p>
                        </div>
                        <a href={href}>
                          Compare providers <Icon name="arrow" size={14} />
                        </a>
                      </div>
                    </article>
                  );
                })}
              </div>
              {group.hiddenSiblings.length > 0 && (
                <div className="model-series-siblings">
                  <span>Also in {group.name}:</span>
                  {group.hiddenSiblings.map((sibling) => (
                    <a key={sibling.id} href={seriesHref(sibling.id)}>
                      {sibling.name}
                      <Icon name="chevron" size={11} />
                    </a>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {!filtered.length && (
        <div className="empty-state">
          <Icon name="search" size={30} />
          <h2>No matching models.</h2>
          <p>Try a different name, provider or region.</p>
          <button
            className="button button-outline"
            onClick={() => {
              setQuery('');
              setModality('all');
              setRegion('all');
            }}
          >
            Clear filters
          </button>
        </div>
      )}
    </>
  );
}

export function PlaygroundApp({
  catalog,
  initialModelId,
  initialRouteId,
  initialOperation,
  initialRegion,
  gatewayOrigin,
}: {
  catalog: Catalog;
  initialModelId?: string;
  initialRouteId?: string;
  initialOperation?: Operation;
  initialRegion?: string;
  gatewayOrigin: string;
}) {
  const defaultModel =
    catalog.models.find((model) => model.id === initialModelId) ??
    catalog.models.find((model) => model.id === 'alibaba/wan-3.0') ??
    catalog.models[0]!;
  const [selection, setSelection] = useState({
    modelId: defaultModel.id,
    routeId: initialRouteId,
    operation: initialOperation,
    region: initialRegion,
  });
  const [query, setQuery] = useState('');
  const [transfer, setTransfer] = useState<PlaygroundDraftTransfer>();
  const search = query.trim().toLowerCase();
  const providerIds = new Set(
    catalog.providers
      .filter((provider) =>
        [provider.name, provider.id].some((term) => term.toLowerCase().includes(search)),
      )
      .map((provider) => provider.id),
  );
  const deploymentIds = new Set(
    catalog.deployments
      .filter((deployment) => providerIds.has(deployment.providerId))
      .map((deployment) => deployment.id),
  );
  const providerModelIds = new Set(
    catalog.routes
      .filter((route) => route.status !== 'retired' && deploymentIds.has(route.deploymentId))
      .map((route) => route.modelId),
  );
  const matching = catalog.models.filter(
    (value) =>
      providerModelIds.has(value.id) ||
      [value.name, value.id, value.creator, value.modality, ...value.aliases].some((term) =>
        term.toLowerCase().includes(search),
      ),
  );
  const model = catalog.models.find((value) => value.id === selection.modelId)!;
  const routes = useMemo(
    () => getModelRoutes(model.id, catalog).filter((route) => route.status !== 'retired'),
    [catalog, model.id],
  );
  return (
    <>
      <div className="playground-model-picker">
        <div className="playground-model-fields">
          <label>
            Find a model
            <input
              type="search"
              placeholder="Name, provider, image or video"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            Model
            <select
              aria-label="Choose generation model"
              value={selection.modelId}
              onChange={(event) => {
                setSelection({
                  modelId: event.target.value,
                  routeId: undefined,
                  operation: undefined,
                  region: undefined,
                });
                setQuery('');
                setTransfer(undefined);
              }}
            >
              {search && !matching.includes(model) && (
                <option value={model.id}>{model.name} · current</option>
              )}
              {modelSeries.map((series) => {
                const models = matching.filter((value) => series.modelIds.includes(value.id));
                return models.length ? (
                  <optgroup key={series.id} label={series.name}>
                    {models.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })}
            </select>
          </label>
          {!matching.length && <p role="status">No models match this search.</p>}
        </div>
        <a href={seriesHref(model.id)}>
          Model details & providers <Icon name="external" size={14} />
        </a>
      </div>
      <section
        className="standalone-playground"
        data-media={model.modality}
        aria-label="Generation workspace"
      >
        <div className="playground-model-heading">
          <span className={`model-glyph ${model.modality}`}>
            {model.modality === 'video' ? '▶' : '▧'}
          </span>
          <div>
            <h2>{model.name}</h2>
            <p>{model.description}</p>
          </div>
        </div>
        <Playground
          key={model.id}
          catalog={catalog}
          model={model}
          routes={routes}
          initialRouteId={selection.routeId}
          initialOperation={selection.operation}
          initialRegion={selection.region}
          transferredDraft={transfer}
          onDraftTransferConsumed={() => setTransfer(undefined)}
          onModelDraft={(value) => {
            setQuery('');
            setTransfer(value);
            setSelection({
              modelId: value.draft.modelId,
              operation: value.draft.operation,
              routeId: value.draft.routeId,
              region: undefined,
            });
          }}
          gatewayOrigin={gatewayOrigin}
        />
      </section>
    </>
  );
}
