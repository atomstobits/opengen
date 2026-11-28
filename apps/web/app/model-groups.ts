import { getCompany, getModelRoutes, getSeriesForModel, seriesHref } from '@media-router/catalog';
import type {
  Catalog,
  Company,
  Deployment,
  Model,
  ModelSeries,
  Route,
} from '@media-router/contracts';
import { formatDisclosedRegion, isDisclosedRegion } from './route-identity';

export interface CatalogModelEntry {
  model: Model;
  series?: ModelSeries;
  company?: Company;
  routes: Route[];
  deployments: Deployment[];
  search: string;
}

export interface CatalogSeriesGroup {
  id: string;
  name: string;
  description: string;
  href?: string;
  company?: Company;
  modality: Model['modality'];
  entries: CatalogModelEntry[];
  totalVariants: number;
  hiddenSiblings: Model[];
}

export function buildCatalogModelEntries(
  catalog: Catalog,
  regionLabels: Readonly<Record<string, string>>,
): CatalogModelEntry[] {
  return catalog.models.map((model) => {
    const series = getSeriesForModel(model.id);
    const company = series ? getCompany(series.companyId) : undefined;
    const routes = getModelRoutes(model.id, catalog);
    const deployments = catalog.deployments.filter((deployment) =>
      routes.some((route) => route.deploymentId === deployment.id),
    );
    const search = [
      model.name,
      model.id,
      model.creator,
      series?.name,
      series?.id,
      company?.name,
      ...model.aliases,
      ...deployments.map((deployment) => {
        const baseName = deployment.name.replace(/\s*·\s*Region undisclosed$/i, '').trim();
        const regionLabel = isDisclosedRegion(deployment.endpointRegion)
          ? (regionLabels[deployment.endpointRegion] ?? deployment.endpointRegion)
          : '';
        return `${baseName} ${regionLabel}`.trim();
      }),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return { model, series, company, routes, deployments, search };
  });
}

export function groupCatalogModels(
  allEntries: readonly CatalogModelEntry[],
  filteredEntries: readonly CatalogModelEntry[],
): CatalogSeriesGroup[] {
  const groupKey = (entry: CatalogModelEntry) =>
    entry.series?.id ?? `family:${entry.model.modality}:${entry.model.familyId}`;

  const allByGroup = new Map<string, CatalogModelEntry[]>();
  for (const entry of allEntries) {
    const key = groupKey(entry);
    const bucket = allByGroup.get(key);
    if (bucket) bucket.push(entry);
    else allByGroup.set(key, [entry]);
  }

  const filteredByGroup = new Map<string, CatalogModelEntry[]>();
  for (const entry of filteredEntries) {
    const key = groupKey(entry);
    const bucket = filteredByGroup.get(key);
    if (bucket) bucket.push(entry);
    else filteredByGroup.set(key, [entry]);
  }

  const orderBySeries = (entries: CatalogModelEntry[], series?: ModelSeries) => {
    if (!series) return entries;
    const rank = new Map(series.modelIds.map((id, index) => [id, index]));
    return [...entries].sort(
      (left, right) =>
        (rank.get(left.model.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(right.model.id) ?? Number.MAX_SAFE_INTEGER),
    );
  };

  const groups: CatalogSeriesGroup[] = [];
  for (const [key, matches] of filteredByGroup) {
    const series = matches[0]!.series;
    const orderedMatches = orderBySeries(matches, series);
    const orderedAll = orderBySeries(allByGroup.get(key) ?? matches, series);
    const matchedIds = new Set(orderedMatches.map((entry) => entry.model.id));
    const first = orderedAll[0] ?? orderedMatches[0]!;
    groups.push({
      id: series?.id ?? key,
      name: series?.name ?? first.model.name,
      description: series?.description ?? first.model.description,
      href: series ? `/${series.id}` : seriesHref(first.model.id),
      company: first.company,
      modality: first.model.modality,
      entries: orderedMatches,
      totalVariants: orderedAll.length,
      hiddenSiblings: orderedAll
        .filter((entry) => !matchedIds.has(entry.model.id))
        .map((entry) => entry.model),
    });
  }
  return groups;
}

export function describeEndpointRegions(
  routesCount: number,
  deployments: readonly Deployment[],
): string | null {
  if (routesCount === 0) return 'No hosted routes listed';
  const disclosedRegions = [
    ...new Set(
      deployments
        .map((deployment) => deployment.endpointRegion)
        .filter((region) => isDisclosedRegion(region) && region !== 'global')
        .map((region) => formatDisclosedRegion(region) ?? region),
    ),
  ].sort();
  if (disclosedRegions.length > 0) {
    return `${disclosedRegions.length === 1 ? 'Endpoint' : 'Endpoints'}: ${disclosedRegions.join(', ')}`;
  }
  if (deployments.some((deployment) => deployment.endpointRegion === 'global')) {
    return 'Global endpoint';
  }
  return null;
}

export function variantGridColumns(count: number): 1 | 2 | 3 {
  if (count <= 1) return 1;
  if (count === 2 || count === 4) return 2;
  return 3;
}
