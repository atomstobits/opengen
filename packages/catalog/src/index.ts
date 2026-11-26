import {
  parseGenerationRequest,
  validateRouteInput,
  getGenerationDefinition,
  getGenerationSchema,
  generationOperations,
} from '@media-router/contracts/generation';
import {
  catalogSearchFiltersSchema,
  catalogSearchQuerySchema,
  canonicalModelId,
  resolveCatalogRoute,
  resolveRouteUpstreamModelId,
  routePricingSourceForOperation,
} from '@media-router/contracts';
import type {
  Catalog,
  CatalogSearchFilters,
  GenerationDefinition,
  GenerationProfile,
  GenerateInput,
  Model,
  Operation,
  Quote,
  QuoteCandidate,
  ResolvedCatalogRoute,
  Route,
  RouteAlias,
  RouteMetrics,
  RoutePublishedPricing,
} from '@media-router/contracts';
import { catalog } from './data';
import { groupRoutesByProvider, selectModelRoutes } from './route-order';
import { validateSeriesCatalog } from './series';
import { generationExamples } from './examples';
import { boundedTokenQuote } from './token-pricing';

export { catalog } from './data';
export { groupRoutesByProvider } from './route-order';
export { boundedTokenQuote } from './token-pricing';
export {
  companies,
  modelSeries,
  getCompany,
  getSeries,
  getSeriesForModel,
  getCompanySeries,
  getCompanyModels,
  getCompanyDetail,
  getSeriesDetail,
  seriesHref,
  validateSeriesCatalog,
} from './series';

export class CatalogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export function getModel(id: string): Model | undefined {
  const canonicalId = canonicalModelId(id);
  return catalog.models.find((item) => item.id === canonicalId);
}
export function getRouteAlias(
  id: string,
  sourceCatalog: Pick<Catalog, 'routeAliases'> = catalog,
): RouteAlias | undefined {
  return sourceCatalog.routeAliases?.find((entry) => entry.id === id);
}
export function canonicalRouteId(
  id: string,
  sourceCatalog: Pick<Catalog, 'routeAliases'> = catalog,
): string {
  return getRouteAlias(id, sourceCatalog)?.routeId ?? id;
}
export function resolveRoute(
  id: string,
  sourceCatalog: Pick<Catalog, 'routes' | 'routeAliases'> = catalog,
): ResolvedCatalogRoute | undefined {
  return resolveCatalogRoute(sourceCatalog, id);
}
export function getRoute(
  id: string,
  sourceCatalog: Pick<Catalog, 'routes' | 'routeAliases'> = catalog,
): Route | undefined {
  return resolveRoute(id, sourceCatalog)?.route;
}
export function getModelRoutes(
  id: string,
  sourceCatalog: Pick<Catalog, 'models' | 'deployments' | 'routes'> = catalog,
): Route[] {
  return selectModelRoutes(id, sourceCatalog);
}

export { catalogSearchFiltersSchema, catalogSearchQuerySchema };

function profileAcceptsRole(profile: GenerationDefinition, role: string) {
  const [field, type] = role.split('.');
  if (
    ![...profile.commonArguments, ...profile.modelSpecificArguments].includes(
      field as keyof typeof profile.defaults,
    )
  )
    return false;
  if (field === 'references')
    return profile.capabilities.references.types.includes(
      type as 'image' | 'video' | 'audio' | 'document',
    );
  if (field === 'keyframes') return profile.capabilities.frames.keyframesMaximum > 0;
  if (field === 'firstFrame') return profile.capabilities.frames.first;
  if (field === 'lastFrame') return profile.capabilities.frames.last;
  return true;
}

export function searchCatalog(query = '', filters: CatalogSearchFilters = {}) {
  const term = query.trim().toLocaleLowerCase();
  const normalized = (value: string) => value.toLocaleLowerCase().replace(/[-_.]/g, ' ');
  return catalog.models.filter((model) => {
    if (filters.modality && model.modality !== filters.modality) return false;
    if (filters.familyId && model.familyId !== filters.familyId) return false;
    // Match roles within the requested operation, and provider/region on that same route.
    const profiles = generationOperations
      .flatMap((operation) => {
        const definition = getGenerationDefinition(model.id, operation);
        return definition ? [definition] : [];
      })
      .filter(
        (profile) =>
          (!filters.operation || profile.operation === filters.operation) &&
          (!filters.inputRole || profileAcceptsRole(profile, filters.inputRole)),
      );
    if (!profiles.length) return false;
    const operations = new Set(profiles.map((profile) => profile.operation));
    const routes = catalog.routes.filter((route) => route.modelId === model.id);
    if (
      (filters.providerId || filters.region) &&
      !routes.some((route) => {
        const deployment = catalog.deployments.find((item) => item.id === route.deploymentId);
        return (
          deployment &&
          route.operations.some((operation) => operations.has(operation)) &&
          (!filters.providerId || deployment.providerId === filters.providerId) &&
          (!filters.region || deployment.endpointRegion === filters.region)
        );
      })
    )
      return false;
    const searchable = [
      model.id,
      model.name,
      model.creator,
      model.familyId,
      ...model.aliases,
      ...profiles.flatMap((profile) => [
        profile.operation,
        ...profile.commonArguments,
        ...profile.modelSpecificArguments,
        ...profile.capabilities.references.types.map((type) => `references.${type}`),
      ]),
    ];
    return (
      !term ||
      searchable.some(
        (value) =>
          value.toLocaleLowerCase().includes(term) || normalized(value).includes(normalized(term)),
      )
    );
  });
}

function validatePublishedPricingEvidence(
  published: RoutePublishedPricing,
  route: Route,
  label: string,
  errors: string[],
): void {
  const { summary, source, conditions, outputRates } = published;
  let validSource = false;
  try {
    const url = new URL(source.url);
    validSource = url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    /* Invalid catalog evidence is reported below. */
  }
  if (
    !summary.trim() ||
    !conditions.length ||
    conditions.some((condition) => !condition.trim()) ||
    outputRates?.some((rate) => !Number.isSafeInteger(rate.usdMicros) || rate.usdMicros < 0) ||
    !validSource ||
    !/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt) ||
    !Number.isFinite(Date.parse(source.checkedAt))
  )
    errors.push(`Invalid published tariff evidence for ${label}`);
  if (outputRates?.some((rate) => rate.operation && !route.operations.includes(rate.operation)))
    errors.push(`Published tariff output rate lists unsupported operation for ${label}`);
}

export function validateCatalog(): string[] {
  const errors: string[] = validateSeriesCatalog();
  const providerIds = new Set(catalog.providers.map((provider) => provider.id));
  for (const [name, items] of Object.entries(catalog)) {
    if (!Array.isArray(items)) continue;
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) errors.push(`${name}: duplicate ID ${item.id}`);
      ids.add(item.id);
    }
  }
  const deploymentsById = new Map(
    catalog.deployments.map((deployment) => [deployment.id, deployment]),
  );
  for (const model of catalog.models) {
    if (new Set(model.authorProviderIds).size !== model.authorProviderIds.length)
      errors.push(`Duplicate author provider for ${model.id}`);
    for (const id of model.authorProviderIds)
      if (!providerIds.has(id)) errors.push(`Unknown author provider ${id} for ${model.id}`);
    const modelRoutes = catalog.routes.filter((route) => route.modelId === model.id);
    const orderedRoutes = groupRoutesByProvider(
      modelRoutes,
      deploymentsById,
      model.authorProviderIds,
    );
    if (modelRoutes.some((route, index) => route.id !== orderedRoutes[index]?.id))
      errors.push(`Official routes must precede third-party routes for ${model.id}`);
  }
  for (const deployment of catalog.deployments) {
    if (!providerIds.has(deployment.providerId))
      errors.push(`Unknown provider for ${deployment.id}`);
  }
  const activeDeploymentRoutes = new Map<string, string>();
  const routesById = new Map(catalog.routes.map((route) => [route.id, route]));
  for (const route of catalog.routes) {
    if (!getModel(route.modelId)) errors.push(`Unknown model for ${route.id}`);
    else if (canonicalModelId(route.modelId) !== route.modelId)
      errors.push(`Noncanonical model reference for ${route.id}`);
    if (!catalog.deployments.some((deployment) => deployment.id === route.deploymentId))
      errors.push(`Unknown deployment for ${route.id}`);
    if (!route.operations.length) errors.push(`Missing operations for ${route.id}`);
    if (new Set(route.operations).size !== route.operations.length)
      errors.push(`Duplicate operations for ${route.id}`);
    if (route.feature) {
      if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.feature.id) ||
        !route.feature.label.trim() ||
        (route.feature.summary !== undefined && !route.feature.summary.trim())
      )
        errors.push(`Invalid route feature metadata for ${route.id}`);
    }
    if (route.status !== 'retired') {
      const deploymentKey = `${route.modelId}|${route.deploymentId}`;
      const existing = activeDeploymentRoutes.get(deploymentKey);
      if (existing)
        errors.push(
          `Duplicate active routes for ${route.modelId} on ${route.deploymentId}: ${existing} and ${route.id} must be unified into one canonical route`,
        );
      else activeDeploymentRoutes.set(deploymentKey, route.id);
    }
    if (route.upstreamEndpoints) {
      for (const [operation, endpoint] of Object.entries(route.upstreamEndpoints)) {
        if (!route.operations.includes(operation as Operation))
          errors.push(`Upstream endpoint lists unsupported operation ${operation} for ${route.id}`);
        if (!endpoint?.trim())
          errors.push(`Empty upstream endpoint for ${route.id} (${operation})`);
      }
    }
    if (route.operationCapabilities) {
      for (const [operation, cap] of Object.entries(route.operationCapabilities)) {
        if (!route.operations.includes(operation as Operation))
          errors.push(
            `Operation capability override lists unsupported operation ${operation} for ${route.id}`,
          );
        if (!cap) continue;
        if (cap.resolutions?.some((res) => !route.resolutions.includes(res)))
          errors.push(
            `Operation capability resolution outside route resolutions for ${route.id} (${operation})`,
          );
        if (cap.durations?.some((duration) => !route.durations.includes(duration)))
          errors.push(
            `Operation capability duration outside route durations for ${route.id} (${operation})`,
          );
        if (cap.source && !cap.source.url.startsWith('https://'))
          errors.push(`Invalid operation capability source for ${route.id} (${operation})`);
        if (cap.pricingSource && !cap.pricingSource.url.startsWith('https://'))
          errors.push(`Invalid operation capability pricingSource for ${route.id} (${operation})`);
        if (cap.publishedPricing)
          validatePublishedPricingEvidence(
            cap.publishedPricing,
            route,
            `${route.id} (${operation})`,
            errors,
          );
      }
    }
    if (route.liveVerification) {
      const verifiedOps = route.liveVerification.operations ?? [route.liveVerification.operation];
      if (
        !route.operations.includes(route.liveVerification.operation) ||
        verifiedOps.some((operation) => !route.operations.includes(operation))
      )
        errors.push(`Live verification lists unsupported operation for ${route.id}`);
    }
    if (!route.source.url.startsWith('https://') || !route.pricingSource.url.startsWith('https://'))
      errors.push(`Missing source for ${route.id}`);
    if (route.rates.some((rate) => !Number.isSafeInteger(rate.usdMicros) || rate.usdMicros < 0))
      errors.push(`Invalid rate for ${route.id}`);
    if (route.rates.some((rate) => rate.operation && !route.operations.includes(rate.operation)))
      errors.push(`Rate lists unsupported operation for ${route.id}`);
    if (route.publishedPricing)
      validatePublishedPricingEvidence(route.publishedPricing, route, route.id, errors);
  }
  for (const alias of catalog.routeAliases ?? []) {
    if (routesById.has(alias.id))
      errors.push(`Route alias collides with canonical route ID ${alias.id}`);
    const target = routesById.get(alias.routeId);
    if (!target) errors.push(`Route alias ${alias.id} references unknown route ${alias.routeId}`);
    else if (alias.operation && !target.operations.includes(alias.operation))
      errors.push(
        `Route alias ${alias.id} lists unsupported operation ${alias.operation} for ${alias.routeId}`,
      );
  }
  return errors;
}

function validateInput(input: GenerateInput): Model {
  const model = getModel(input.modelId);
  if (!model)
    throw new CatalogError('model_not_found', 'The requested exact model is not in the catalog.');
  return model;
}

export function generationProfiles(modelId: string): GenerationProfile[] {
  return generationOperations.flatMap((operation) => {
    const definition = getGenerationDefinition(modelId, operation);
    return definition
      ? [
          {
            ...definition,
            inputSchema: getGenerationSchema(modelId, operation)!,
            examples: generationExamples(definition),
          },
        ]
      : [];
  });
}

export function getPublishedRate(route: Route, operation: Operation, resolution?: string) {
  return (
    route.rates.find((rate) => rate.resolution === resolution && rate.operation === operation) ??
    route.rates.find((rate) => rate.resolution === resolution && rate.operation === undefined)
  );
}

export function quote(
  input: GenerateInput,
  options: { executableRouteIds?: string[]; metrics?: RouteMetrics[] } = {},
): Quote {
  input = parseGenerationRequest(input);
  const args = input.input;
  const model = validateInput(input);
  const policy = input.routing ?? {};
  const resolvedPin = input.routeId ? resolveRoute(input.routeId) : undefined;
  const pinnedRouteId = resolvedPin?.route.id ?? input.routeId;
  const pinnedAlias = resolvedPin?.alias;
  if (input.routeId && resolvedPin?.route.modelId !== model.id)
    throw new CatalogError(
      'route_model_mismatch',
      'The pinned route does not serve this exact model.',
    );
  const eligible = catalog.routes.filter((route) => {
    if (
      route.modelId !== model.id ||
      route.status === 'retired' ||
      (pinnedRouteId && route.id !== pinnedRouteId)
    )
      return false;
    const deployment = catalog.deployments.find((item) => item.id === route.deploymentId)!;
    if (policy.providerIds && !policy.providerIds.includes(deployment.providerId)) return false;
    if (policy.deploymentIds && !policy.deploymentIds.includes(deployment.id)) return false;
    if (policy.endpointRegions && !policy.endpointRegions.includes(deployment.endpointRegion))
      return false;
    // An endpoint region cannot satisfy an inference-region constraint. All known processing regions must fit.
    if (
      policy.processingRegions &&
      (!deployment.processingRegions?.length ||
        !deployment.processingRegions.every((region) => policy.processingRegions!.includes(region)))
    )
      return false;
    if (policy.fidelity === 'native' && route.fidelity !== 'native') return false;
    return true;
  });
  if (!eligible.length)
    throw new CatalogError(
      'no_matching_route',
      'No route satisfies the exact model and regional/fidelity restrictions.',
    );
  // When routing automatically on a deployment that splits operations into separate routes,
  // omit sibling routes for other operations once that deployment has a matching operation route.
  const deploymentsSupportingOperation = new Set(
    eligible
      .filter((route) => route.operations.includes(input.operation))
      .map((route) => route.deploymentId),
  );
  const evaluated = pinnedRouteId
    ? eligible
    : eligible.filter(
        (route) =>
          route.operations.includes(input.operation) ||
          !deploymentsSupportingOperation.has(route.deploymentId),
      );
  const executableIds = new Set(
    (options.executableRouteIds ?? []).flatMap((id) => {
      const resolved = resolveRoute(id);
      if (resolved?.alias?.operation && resolved.alias.operation !== input.operation) return [];
      return [resolved?.route.id ?? id];
    }),
  );
  const candidates: QuoteCandidate[] = evaluated
    .map((route) => {
      const deployment = catalog.deployments.find((item) => item.id === route.deploymentId)!;
      const inputIssues = validateRouteInput(input, route);
      if (pinnedAlias?.operation && pinnedAlias.operation !== input.operation) {
        inputIssues.push({
          code: 'unsupported_operation',
          field: 'operation',
          message: `Route alias ${pinnedAlias.id} is bound to ${pinnedAlias.operation} and cannot execute ${input.operation}.`,
        });
      }
      const rate = getPublishedRate(route, input.operation, args.resolution);
      const upstream = resolveRouteUpstreamModelId(route, input.operation);
      // Reference media can incur additional input billing. No partial output-only estimate is presented as a full quote.
      const extraInputs = Boolean(
        args.references?.length ||
        args.sourceVideo ||
        args.mask ||
        args.elements?.length ||
        args.keyframes?.length ||
        input.previousJobId,
      );
      const count = args.count ?? 1;
      // Only complete, fixed-quantity tariffs qualify. Auto duration, exact sizes and special model modes need a qualified price first.
      const modelExtras = Boolean(
        args.draft ||
        args.draftJobId ||
        args.targetAudio ||
        args.layers ||
        args.thinking ||
        args.grounding ||
        args.shots?.length ||
        args.codec ||
        args.bitrateMode ||
        ((upstream === 'grok-imagine-image-2.0' ||
          upstream === 'xai/grok-imagine-image/v2.0/text-to-image') &&
          (count !== 1 || ![undefined, 'low'].includes(args.quality))) ||
        (route.adapter === 'minimax' &&
          !upstream.startsWith('MiniMax-H3-Image') &&
          args.promptExpansion !== undefined &&
          (upstream !== 'MiniMax-H3-Max' ||
            ![false, 'none', 'disabled'].includes(args.promptExpansion))) ||
        ((upstream === 'minimax/h3-max/text-to-video' ||
          upstream === 'minimax/h3-max-turbo/text-to-video' ||
          upstream === 'minimax/h3/text-to-video' ||
          upstream === 'minimax/h3/image-to-video') &&
          ![undefined, false, 'none', 'disabled'].includes(args.promptExpansion)),
      );
      const quantity =
        rate?.unit === 'output-second'
          ? typeof args.duration === 'number'
            ? args.duration
            : null
          : count;
      const canPrice =
        rate &&
        !inputIssues.length &&
        !extraInputs &&
        !modelExtras &&
        !args.size &&
        quantity !== null;
      const value = canPrice ? rate.usdMicros * quantity! : null;
      const rateEstimate = value !== null && Number.isSafeInteger(value) ? value : null;
      const tokenQuote =
        rateEstimate === null &&
        !rate &&
        !inputIssues.length &&
        !modelExtras &&
        !args.size &&
        !args.sourceVideo &&
        !args.mask &&
        !args.elements?.length &&
        !args.keyframes?.length &&
        !input.previousJobId
          ? boundedTokenQuote(route, input)
          : null;
      const estimate = rateEstimate ?? tokenQuote?.estimatedCostMicros ?? null;
      const withinBudget =
        estimate === null || input.maxCostMicros === undefined || estimate <= input.maxCostMicros;
      const configured = executableIds.has(route.id) && route.adapter !== null;
      const directBilling = input.billing === 'byok';
      const unboundedDirectBilling = directBilling && input.maxCostMicros === undefined;
      const executable =
        configured &&
        inputIssues.length === 0 &&
        (estimate !== null || unboundedDirectBilling) &&
        withinBudget;
      const reason = inputIssues.length
        ? inputIssues[0]!.message
        : estimate === null && !unboundedDirectBilling
          ? 'Request price is not qualified; comparison only.'
          : !withinBudget
            ? 'Estimated cost exceeds the request budget.'
            : !configured
              ? 'No qualified adapter and regional credentials are configured.'
              : null;
      return {
        routeId: route.id,
        deploymentId: deployment.id,
        providerId: deployment.providerId,
        endpointRegion: deployment.endpointRegion,
        scope: deployment.scope,
        operations: [...route.operations],
        ...(route.feature ? { feature: route.feature } : {}),
        estimatedCostMicros: estimate,
        currency: 'USD' as const,
        executable,
        reason,
        source: tokenQuote?.source ?? routePricingSourceForOperation(route, input.operation),
        issues: inputIssues,
        notices: [
          ...(directBilling
            ? [
                'Your provider account is billed directly. OpenGen does not debit managed credit. Unknown provider charges cannot be capped by the gateway.',
              ]
            : []),
          ...(tokenQuote
            ? tokenQuote.notices
            : ['Published list-price estimate; not a guaranteed settled provider charge.']),
          ...(route.liveVerification
            ? [
                `Live verification covered ${(route.liveVerification.operations ?? [route.liveVerification.operation]).join(', ')} at ${route.liveVerification.resolution} for ${route.liveVerification.duration}s.`,
              ]
            : route.status !== 'live-verified'
              ? ['This route has not been live-verified by this installation.']
              : []),
          ...(deployment.processingRegions === null
            ? ['Inference location is undisclosed; endpoint region does not establish residency.']
            : []),
          ...(rate?.note ? [rate.note] : []),
        ],
      };
    })
    .sort(
      (a, b) =>
        (a.estimatedCostMicros ?? Infinity) - (b.estimatedCostMicros ?? Infinity) ||
        a.routeId.localeCompare(b.routeId),
    );
  const notices = ['All quotes are estimates. No provider is called while quoting.'];
  const metricsPreference = policy.preference && policy.preference !== 'cost';
  const evidence = new Map(
    (options.metrics ?? [])
      .filter(
        (metric) =>
          metric.configuration?.operation === input.operation &&
          metric.configuration.resolution === args.resolution &&
          metric.configuration.duration === args.duration,
      )
      .map((metric) => [metric.routeId, metric]),
  );
  const measured = candidates
    .filter((candidate) => {
      if (!candidate.executable) return false;
      const metric = evidence.get(candidate.routeId);
      return (
        metric &&
        (policy.preference === 'speed'
          ? metric.succeeded >= 5 && metric.p50CompletionMs !== null
          : (metric.technicalOutcomeCount ?? 0) >= 10 && metric.technicalSuccessRate !== null)
      );
    })
    .sort((a, b) => {
      const x = evidence.get(a.routeId)!,
        y = evidence.get(b.routeId)!;
      return policy.preference === 'speed'
        ? x.p50CompletionMs! - y.p50CompletionMs!
        : y.technicalSuccessRate! - x.technicalSuccessRate!;
    });
  if (metricsPreference && !measured.length)
    notices.push(
      'No executable route has enough matching observations: speed requires five completed successes; reliability requires ten classified technical outcomes. Pin a route or choose cost.',
    );
  const selectedRouteId = metricsPreference
    ? (measured[0]?.routeId ?? null)
    : (candidates.find((candidate) => candidate.executable)?.routeId ?? null);
  if (metricsPreference) {
    const qualified = new Set(measured.map((candidate) => candidate.routeId));
    for (const candidate of candidates)
      if (candidate.executable && !qualified.has(candidate.routeId)) {
        candidate.executable = false;
        candidate.reason =
          'Insufficient matching observations for the requested performance preference.';
      }
  }
  const selected = candidates.find((candidate) => candidate.routeId === selectedRouteId);
  const reservationMicros =
    input.billing === 'byok'
      ? 0
      : !selected
        ? null
        : input.routing?.fallback
          ? Math.max(
              ...[
                selected,
                ...candidates
                  .filter(
                    (candidate) =>
                      candidate.routeId !== selectedRouteId &&
                      candidate.executable &&
                      candidate.reason === null,
                  )
                  .slice(0, 3),
              ].map((candidate) => candidate.estimatedCostMicros!),
            )
          : selected.estimatedCostMicros;
  if (input.routing?.fallback)
    notices.push(
      'Fallback is limited to explicit submission rejections before acceptance. Ambiguous outcomes are held and never automatically retried. Managed credit reserves the largest estimate among at most four eligible attempts.',
    );
  return {
    reservationMicros,
    modelId: model.id,
    operation: input.operation,
    candidates,
    selectedRouteId,
    estimateOnly: true,
    notices,
  };
}
