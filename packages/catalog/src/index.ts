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
} from '@media-router/contracts';
import type {
  CatalogSearchFilters,
  GenerationDefinition,
  GenerationProfile,
  GenerateInput,
  Model,
  Operation,
  Quote,
  QuoteCandidate,
  Route,
  RouteMetrics,
} from '@media-router/contracts';
import { catalog } from './data';
import { validateSeriesCatalog } from './series';
import { generationExamples } from './examples';
import { boundedTokenQuote } from './token-pricing';

export { catalog } from './data';
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
export function getRoute(id: string): Route | undefined {
  return catalog.routes.find((item) => item.id === id);
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

export function validateCatalog(): string[] {
  const errors: string[] = validateSeriesCatalog();
  const providerIds = new Set(catalog.providers.map((provider) => provider.id));
  for (const [name, items] of Object.entries(catalog)) {
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id)) errors.push(`${name}: duplicate ID ${item.id}`);
      ids.add(item.id);
    }
  }
  for (const model of catalog.models) {
    if (new Set(model.authorProviderIds).size !== model.authorProviderIds.length)
      errors.push(`Duplicate author provider for ${model.id}`);
    for (const id of model.authorProviderIds)
      if (!providerIds.has(id)) errors.push(`Unknown author provider ${id} for ${model.id}`);
  }
  for (const deployment of catalog.deployments) {
    if (!providerIds.has(deployment.providerId))
      errors.push(`Unknown provider for ${deployment.id}`);
  }
  for (const route of catalog.routes) {
    if (!getModel(route.modelId)) errors.push(`Unknown model for ${route.id}`);
    else if (canonicalModelId(route.modelId) !== route.modelId)
      errors.push(`Noncanonical model reference for ${route.id}`);
    if (!catalog.deployments.some((deployment) => deployment.id === route.deploymentId))
      errors.push(`Unknown deployment for ${route.id}`);
    if (!route.source.url.startsWith('https://') || !route.pricingSource.url.startsWith('https://'))
      errors.push(`Missing source for ${route.id}`);
    if (route.rates.some((rate) => !Number.isSafeInteger(rate.usdMicros) || rate.usdMicros < 0))
      errors.push(`Invalid rate for ${route.id}`);
    if (route.publishedPricing) {
      const { summary, source, conditions } = route.publishedPricing;
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
        !validSource ||
        !/^\d{4}-\d{2}-\d{2}$/.test(source.checkedAt) ||
        !Number.isFinite(Date.parse(source.checkedAt))
      )
        errors.push(`Invalid published tariff evidence for ${route.id}`);
    }
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
  if (input.routeId && getRoute(input.routeId)?.modelId !== model.id)
    throw new CatalogError(
      'route_model_mismatch',
      'The pinned route does not serve this exact model.',
    );
  const eligible = catalog.routes.filter((route) => {
    if (
      route.modelId !== model.id ||
      route.status === 'retired' ||
      (input.routeId && route.id !== input.routeId)
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
  const executableIds = new Set(options.executableRouteIds ?? []);
  const candidates: QuoteCandidate[] = eligible
    .map((route) => {
      const deployment = catalog.deployments.find((item) => item.id === route.deploymentId)!;
      const inputIssues = validateRouteInput(input, route);
      const rate = getPublishedRate(route, input.operation, args.resolution);
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
        ((route.upstreamModelId === 'grok-imagine-image-2.0' ||
          route.upstreamModelId === 'xai/grok-imagine-image/v2.0/text-to-image') &&
          (count !== 1 || ![undefined, 'low'].includes(args.quality))) ||
        (route.adapter === 'minimax' &&
          args.promptExpansion !== undefined &&
          (route.upstreamModelId !== 'MiniMax-H3-Max' ||
            ![false, 'none', 'disabled'].includes(args.promptExpansion))) ||
        ((route.upstreamModelId === 'minimax/h3-max/text-to-video' ||
          route.upstreamModelId === 'minimax/h3-max-turbo/text-to-video' ||
          route.upstreamModelId === 'minimax/h3/text-to-video' ||
          route.upstreamModelId === 'minimax/h3/image-to-video') &&
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
        estimatedCostMicros: estimate,
        currency: 'USD' as const,
        executable,
        reason,
        source: tokenQuote?.source ?? route.pricingSource,
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
