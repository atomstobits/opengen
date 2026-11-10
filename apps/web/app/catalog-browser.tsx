'use client';

import { useMemo, useState } from 'react';
import { getCompany, getSeriesForModel, modelSeries, seriesHref } from '@media-router/catalog';
import type { Catalog, Operation } from '@media-router/contracts';
import { Icon, Playground, regionNames } from './ui';
import type { PlaygroundDraftTransfer } from './private-playground';

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
  const entries = useMemo(
    () =>
      catalog.models.map((model) => {
        const series = getSeriesForModel(model.id);
        const company = series ? getCompany(series.companyId) : undefined;
        const routes = catalog.routes.filter((route) => route.modelId === model.id);
        const deployments = catalog.deployments.filter((deployment) =>
          routes.some((route) => route.deploymentId === deployment.id),
        );
        const search = [
          model.name,
          model.id,
          model.creator,
          company?.name,
          ...model.aliases,
          ...deployments.map(
            (deployment) =>
              `${deployment.name} ${regionNames[deployment.endpointRegion] ?? deployment.endpointRegion}`,
          ),
        ]
          .join(' ')
          .toLowerCase();
        return { model, company, routes, deployments, search };
      }),
    [catalog],
  );
  const regions = [
    ...new Set(catalog.deployments.map((deployment) => deployment.endpointRegion)),
  ].sort();
  const filtered = entries.filter(
    (entry) =>
      (modality === 'all' || entry.model.modality === modality) &&
      (region === 'all' ||
        entry.deployments.some((deployment) => deployment.endpointRegion === region)) &&
      entry.search.includes(query.trim().toLowerCase()),
  );
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
          {filtered.length} {filtered.length === 1 ? 'model' : 'models'}
        </p>
        <span>Exact variants. Separate regional providers.</span>
      </div>
      <div className="model-directory-list">
        {filtered.map(({ model, company, routes, deployments }) => {
          const matchingDeployments = deployments.filter(
            (deployment) => region === 'all' || deployment.endpointRegion === region,
          );
          const matchingRoutes = routes.filter((route) =>
            matchingDeployments.some((deployment) => deployment.id === route.deploymentId),
          );
          const disclosedRegions = new Set(
            matchingDeployments
              .filter(
                (deployment) =>
                  !['undisclosed', 'unknown', 'global'].includes(deployment.endpointRegion),
              )
              .map((deployment) => deployment.endpointRegion),
          );
          const regionText = disclosedRegions.size
            ? `${disclosedRegions.size} disclosed endpoint ${disclosedRegions.size === 1 ? 'region' : 'regions'}`
            : matchingDeployments.some((deployment) => deployment.endpointRegion === 'global')
              ? 'Global endpoint'
              : 'Region not disclosed';
          return (
            <article
              className="model-directory-card"
              key={model.id}
              data-model-id={model.id}
              data-media={model.modality}
            >
              <div className="model-directory-main">
                <div className="model-directory-publisher">
                  {company ? (
                    <a href={`/${company.id}`}>{company.name}</a>
                  ) : (
                    <span>{model.creator}</span>
                  )}
                  <span className="modality-tag">
                    {model.modality === 'video' ? 'Video' : 'Image'}
                  </span>
                  {model.openness === 'open-weights' && (
                    <span className="weight-tag">Open weights</span>
                  )}
                </div>
                <h2>
                  <a href={seriesHref(model.id)}>
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
                <strong>
                  {matchingRoutes.length}{' '}
                  <span>
                    {region === 'all'
                      ? matchingRoutes.length === 1
                        ? 'provider route'
                        : 'provider routes'
                      : matchingRoutes.length === 1
                        ? 'matching route'
                        : 'matching routes'}
                  </span>
                </strong>
                <p>{regionText}</p>
                <a href={seriesHref(model.id)}>
                  Compare providers <Icon name="arrow" size={15} />
                </a>
              </div>
            </article>
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
    () =>
      catalog.routes.filter((route) => route.modelId === model.id && route.status !== 'retired'),
    [catalog.routes, model.id],
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
