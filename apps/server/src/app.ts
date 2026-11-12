import { operationalError } from './operational-error.js';
import { registerGovernance } from './governance.js';
import {
  AccountGovernanceStore,
  RoutingPolicyStore,
  revalidateGovernanceAuthority,
} from '@media-router/engine';
import { registerJobStatus } from './job-status.js';
import type { JobStatusStore } from '@media-router/engine';
import { registerOwnedAssetRoutes } from './owned-assets.js';
import type { OwnedAssetService } from '@media-router/engine';
import { registerActivity } from './activity.js';
import { registerNotifications } from './notifications.js';
import type {
  ActivityStore,
  NotificationStore,
  OwnedOutputAccess,
  AssetStore,
} from '@media-router/engine';
import { agentEntry, agentSkill, canonicalModelId } from '@media-router/contracts';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { constrainInput, type Principal, type KeyScope } from '@media-router/engine';
import { registerAccounts, type AccountsEngine } from './accounts.js';
import { currentHumanTermsPolicy, type HumanTermsPolicy } from './terms-login.js';
import {
  catalog,
  companies,
  modelSeries,
  generationProfiles,
  catalogSearchQuerySchema,
  getCompanyDetail,
  getSeriesDetail,
  quote,
  searchCatalog,
} from '@media-router/catalog';
import type { GenerateInput, RouteMetrics, Catalog, Quote } from '@media-router/contracts';
import {
  GenerationValidationError,
  getGenerationDefinition,
  getGenerationSchema,
  mapGenerationAssets,
  parseGenerationRequest,
} from '@media-router/contracts/generation';
import { registerPayments, type PaymentsOptions } from './payments.js';
import {
  createBillingFixtureRuntime,
  type BillingFixtureRuntimeOptions,
} from './billing-runtime.js';
import { paymentConfiguration } from './payment-config.js';
import { registerMcp } from './mcp.js';
import { registerMcpAuthorization } from './mcp-authorization.js';
import { registerCompatibility } from './compatibility.js';
import { registerOperator, ledgerQuerySchema } from './operator.js';
import type { Job } from '@media-router/contracts';
import type { Reconciliation } from '@media-router/engine';
import { openApiDocument } from './openapi.js';
import { describeOperations, modelSchemaQuerySchema } from './operations.js';
import { registerFeedback } from './feedback.js';
import type { FeedbackStore } from '@media-router/engine';
import { registerEvents } from './events.js';
import { registerDoctor } from './doctor.js';
import type { EventStore } from '@media-router/engine';
import { registerComparison, type ComparisonEngine } from './comparison.js';

export interface EngineLike extends AccountsEngine, Partial<ComparisonEngine> {
  catalog?: Catalog;
  jobStatus?: Pick<JobStatusStore, 'wait'>;
  events?: EventStore;
  activity?: ActivityStore;
  notifications?: NotificationStore;
  ownedOutputAccess?: OwnedOutputAccess;
  storage?: AssetStore;
  ownedAssets?: OwnedAssetService;
  feedback?: FeedbackStore;
  workspaceReadiness?(
    workspaceId: string,
  ): Promise<import('@media-router/contracts').WorkspaceReadiness>;
  lookupJob?(workspaceId: string, idempotencyKey: string): Promise<Job | null>;
  getExecutableRouteIds(input?: GenerateInput): string[];
  quoteGeneration?(
    input: GenerateInput,
    options: {
      executableRouteIds?: string[];
      metrics?: RouteMetrics[];
      scopeInput?: GenerateInput;
    },
  ): Quote;
  submit(args: {
    workspaceId: string;
    idempotencyKey: string;
    input: GenerateInput;
    principal?: Principal;
  }): Promise<unknown>;
  getJob(workspaceId: string, id: string): Promise<unknown>;
  inspectJob?(workspaceId: string, id: string): Promise<Job | null>;
  listJobs(workspaceId: string): Promise<unknown>;
  cancel(workspaceId: string, id: string): Promise<unknown>;
  getBalance(workspaceId: string): Promise<unknown>;
  routeMetrics(configuration?: GenerateInput): Promise<RouteMetrics[]>;
  ledger?(workspaceId: string, options?: { after?: string; limit?: number }): Promise<unknown>;
  reconcile?(
    workspaceId: string,
    id: string,
    input: Reconciliation,
    authority?: { operatorId: string },
  ): Promise<Job>;
  reconciliations?(workspaceId: string, id: string): Promise<unknown>;
  executableForWorkspace?(
    workspaceId: string,
    input: GenerateInput,
    scopeInput?: GenerateInput,
  ): Promise<string[]>;
  resolveInput?(workspaceId: string, input: GenerateInput): Promise<GenerateInput>;
}
export interface AppOptions {
  engine?: EngineLike;
  payments?: PaymentsOptions['store'];
  billingRuntime?: BillingFixtureRuntimeOptions;
  onBillingRuntime?: (runtime: { workOnce: () => Promise<void> }) => void;
  paymentConfig?: Pick<PaymentsOptions, 'stripe' | 'webhookSecret' | 'livemode'>;
  humanTermsPolicy?: () => HumanTermsPolicy;
  apiToken?: string;
  workspaceId?: string;
  logger?: boolean;
  publicUrl?: string;
  env?: NodeJS.ProcessEnv;
}
export async function buildApp(options: AppOptions = {}) {
  const publicUrl = new URL(
    options.publicUrl ??
      options.env?.OPENGEN_PUBLIC_URL ??
      process.env.OPENGEN_PUBLIC_URL ??
      'http://localhost:4320',
  ).origin;
  if (options.engine?.mcpOAuth && options.engine.mcpOAuth.issuer !== publicUrl)
    throw new Error(
      'The engine OAuth issuer must match the HTTP public origin. Set the same publicUrl on the engine and application.',
    );
  if (
    options.billingRuntime?.activation === 'sandbox' &&
    (options.humanTermsPolicy !== undefined ||
      options.billingRuntime.humanTermsPolicy !== undefined)
  )
    throw new Error('Sandbox billing activation cannot bind a hosted human Terms policy reader.');
  if (
    options.billingRuntime?.activation === 'manual' &&
    (options.billingRuntime.humanTermsPolicy ?? currentHumanTermsPolicy) !==
      (options.humanTermsPolicy ?? currentHumanTermsPolicy)
  )
    throw new Error('Auth and manual billing must share the exact human Terms policy reader.');
  if (
    !options.billingRuntime &&
    options.humanTermsPolicy &&
    options.humanTermsPolicy !== currentHumanTermsPolicy
  ) {
    const unscoped = options.paymentConfig ?? paymentConfiguration(options.env ?? process.env);
    if (options.payments || unscoped.livemode || unscoped.stripe || unscoped.webhookSecret)
      throw new Error(
        'Hosted human Terms composition requires scoped manual billing rather than unscoped payments.',
      );
  }
  const app = Fastify({
    logger: options.logger
      ? {
          serializers: {
            err: (error) => ({
              type: 'OperationError',
              message: 'Operation failed.',
              stack: '',
              ...operationalError(error),
            }),
            req: (request) => ({
              method: request.method,
              url: request.routeOptions?.url ?? 'unmatched',
              remoteAddress: request.ip,
            }),
          },
          redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
        }
      : false,
    bodyLimit: 1_000_000,
  });
  await app.register(cors, { origin: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GenerationValidationError)
      return reply
        .code(400)
        .send({ error: { code: error.code, message: error.message, issues: error.issues } });
    const e = error as {
      statusCode?: number;
      code?: string;
      message: string;
      name?: string;
      retryAfterSeconds?: number;
    };
    if (
      e.statusCode === 429 &&
      typeof e.retryAfterSeconds === 'number' &&
      Number.isSafeInteger(e.retryAfterSeconds) &&
      e.retryAfterSeconds > 0
    )
      reply.header('Retry-After', String(e.retryAfterSeconds));
    if (e.name === 'ZodError')
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'Request parameters do not match the documented schema.',
        },
      });
    const status =
      e.statusCode ?? (e.name === 'CatalogError' || e.code?.startsWith('FST_') ? 400 : 500);
    reply.status(status >= 400 && status < 600 ? status : 500).send({
      error: {
        code: e.code ?? 'invalid_request',
        message:
          status >= 500 &&
          !['database_not_configured', 'authentication_not_configured'].includes(e.code ?? '')
            ? 'Service could not complete this request.'
            : e.message,
      },
    });
  });
  const { authenticate, authenticateBrowser, oauthEnabled, oidcEnabled } = await registerAccounts(
    app,
    { ...options, publicUrl },
  );
  await registerFeedback(app, { feedback: options.engine?.feedback, authenticate });
  const governancePool = options.engine?.accounts?.pool;
  if (options.billingRuntime && !governancePool)
    throw new Error('Billing fixture runtime requires the engine account database.');
  const billingRuntime =
    options.billingRuntime && governancePool
      ? createBillingFixtureRuntime(governancePool, options.billingRuntime)
      : undefined;
  if (billingRuntime) options.onBillingRuntime?.({ workOnce: billingRuntime.workOnce });
  const billingAvailable = Boolean(billingRuntime);

  await registerGovernance(app, {
    authenticate,
    keys: governancePool ? new AccountGovernanceStore(governancePool) : undefined,
    policies: governancePool
      ? new RoutingPolicyStore(
          governancePool,
          options.engine?.catalog ?? catalog,
          revalidateGovernanceAuthority,
        )
      : undefined,
  });
  await registerJobStatus(app, { store: options.engine?.jobStatus, authenticate });
  await registerActivity(app, { activity: options.engine?.activity, authenticate });
  await registerNotifications(app, { notifications: options.engine?.notifications, authenticate });
  await app.register(async (scoped) => {
    registerOwnedAssetRoutes(scoped, { assets: options.engine?.ownedAssets, authenticate });
  });
  await billingRuntime?.register(app, authenticate, publicUrl);
  const paymentOptions = billingRuntime?.payments ?? {
    store: options.payments,
    ...(options.paymentConfig ?? paymentConfiguration(options.env ?? process.env)),
  };
  await registerPayments(app, {
    ...paymentOptions,
    authenticate: (request) => authenticateBrowser(request),
    publicUrl,
  });
  await registerMcpAuthorization(app, {
    store: options.engine?.mcpOAuth,
    publicUrl,
    signInEnabled: oidcEnabled,
    authenticateBrowser,
    authenticate,
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.headers.authorization ||
      request.cookies.og_session ||
      /^\/(auth|v1\/(session|keys|policies|connections|assets|generations|comparisons|ledger|balance|workspaces))/.test(
        request.url,
      )
    )
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const requireEngine = () => {
    if (!options.engine)
      throw Object.assign(
        new Error('Configure DATABASE_URL and run migrations to enable durable jobs.'),
        { statusCode: 503, code: 'database_not_configured' },
      );
    return options.engine;
  };
  await registerDoctor(app, { authenticate, requireEngine });
  registerComparison(app, authenticate, options.engine);
  const makeQuote = async (input: GenerateInput, principal?: Principal) => {
    let constrained = principal ? constrainInput(principal, input) : input;
    const scopeInput = constrained;
    let ownedAssets = false;
    await mapGenerationAssets(constrained.input, async (asset) => {
      ownedAssets ||= Boolean(asset.assetKey);
      return asset;
    });
    if (ownedAssets || constrained.previousJobId) {
      if (!principal || !options.engine?.resolveInput)
        throw Object.assign(new Error('Private uploads require an authenticated workspace.'), {
          statusCode: 401,
          code: 'unauthorized',
        });
      constrained = await options.engine.resolveInput(principal.workspaceId, constrained);
    }
    const executableRouteIds =
      principal && options.engine?.executableForWorkspace
        ? await options.engine.executableForWorkspace(
            principal.workspaceId,
            constrained,
            scopeInput,
          )
        : constrained.billing === 'byok'
          ? []
          : (options.engine?.getExecutableRouteIds(constrained) ?? []);
    const metrics =
      constrained.routing?.preference && constrained.routing.preference !== 'cost'
        ? await options.engine?.routeMetrics(constrained)
        : undefined;
    if (options.engine?.quoteGeneration)
      return options.engine.quoteGeneration(constrained, {
        executableRouteIds,
        metrics,
        scopeInput,
      });
    if (constrained.feeAcceptance)
      throw Object.assign(new Error('Generation fee terms are unavailable.'), {
        statusCode: 503,
        code: 'fee_policy_unavailable',
      });
    return quote(constrained, { executableRouteIds, metrics });
  };
  const quotePrincipal = async (request: Parameters<typeof authenticate>[0]) =>
    request.headers.authorization ||
    request.cookies?.og_session ||
    request.headers['x-opengen-recovery-scope']
      ? authenticate(request)
      : undefined;
  const parseInput = (input: unknown): GenerateInput => parseGenerationRequest(input);
  app.get('/openapi.json', async () => openApiDocument(billingAvailable));
  app.get('/v1/operations', async () => ({ data: describeOperations(billingAvailable) }));
  app.get('/health', async () => ({ status: 'ok', database: !!options.engine, version: '0.1.1' }));
  const discoveredModels = catalog.models.map((model) => ({
    ...model,
    generationProfiles: generationProfiles(model.id),
  }));
  app.get('/v1/catalog', async () => ({
    ...catalog,
    models: discoveredModels,
    companies,
    series: modelSeries,
  }));
  app.get('/v1/companies', async () => ({ data: companies }));
  app.get<{ Params: { company: string } }>('/v1/companies/:company', async (request, reply) => {
    const entry = getCompanyDetail(request.params.company);
    if (!entry)
      return reply
        .code(404)
        .send({ error: { code: 'company_not_found', message: 'Company not found.' } });
    return {
      ...entry,
      models: entry.models.map((model) => ({
        ...model,
        generationProfiles: generationProfiles(model.id),
      })),
    };
  });
  app.get('/v1/series', async () => ({ data: modelSeries }));
  app.get<{ Params: { company: string; slug: string } }>(
    '/v1/series/:company/:slug',
    async (request, reply) => {
      const entry = getSeriesDetail(`${request.params.company}/${request.params.slug}`);
      if (!entry)
        return reply
          .code(404)
          .send({ error: { code: 'series_not_found', message: 'Model series not found.' } });
      return {
        ...entry,
        models: entry.models.map((model) => ({
          ...model,
          generationProfiles: generationProfiles(model.id),
        })),
      };
    },
  );
  app.get('/v1/catalog/search', async (request) => {
    const { q, ...filters } = catalogSearchQuerySchema.parse(request.query);
    return searchCatalog(q, filters);
  });
  app.get('/v1/models', async () => ({ data: discoveredModels }));
  app.get('/v1/models/schema', async (request, reply) => {
    const { modelId, operation } = modelSchemaQuerySchema.parse(request.query);
    const definition = getGenerationDefinition(modelId, operation);
    const inputSchema = getGenerationSchema(modelId, operation);
    if (!definition || !inputSchema)
      return reply.code(404).send({
        error: {
          code: 'generation_schema_not_found',
          message: 'No schema is registered for this exact model and operation.',
        },
      });
    return generationProfiles(modelId).find((profile) => profile.operation === operation);
  });
  app.get('/v1/providers', async () => ({ data: catalog.providers }));
  app.get('/v1/deployments', async () => ({ data: catalog.deployments }));
  app.get<{ Querystring: { modelId?: string } }>('/v1/routes', async (request) => ({
    data: catalog.routes.filter(
      (r) => !request.query.modelId || r.modelId === canonicalModelId(request.query.modelId),
    ),
  }));
  app.post('/v1/quotes', async (request) =>
    makeQuote(parseInput(request.body), await quotePrincipal(request)),
  );
  app.post('/v1/quotes/batch', async (request) => {
    if (!Array.isArray(request.body) || request.body.length < 1 || request.body.length > 20)
      throw Object.assign(new Error('Send an array of 1–20 quote requests.'), { statusCode: 400 });
    const principal = await quotePrincipal(request);
    return {
      data: await Promise.all(request.body.map((input) => makeQuote(parseInput(input), principal))),
    };
  });
  app.get('/v1/metrics', async () => ({
    data: options.engine
      ? await options.engine.routeMetrics()
      : catalog.routes.map((route) => ({
          routeId: route.id,
          sampleCount: 0,
          succeeded: 0,
          failed: 0,
          unresolved: 0,
          unclassifiedFailures: 0,
          technicalSuccessRate: null,
          p50CompletionMs: null,
          p75CompletionMs: null,
          p90CompletionMs: null,
          p95CompletionMs: null,
          p99CompletionMs: null,
          window: '7 days',
          benchmarkOrigin: 'not configured',
        })),
  }));
  app.post('/v1/generations', async (request, reply) => {
    const principal = await authenticate(request, 'generate');
    const input = parseInput(request.body);
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 200)
      throw Object.assign(new Error('An Idempotency-Key header of 1–200 characters is required.'), {
        statusCode: 400,
        code: 'idempotency_key_required',
      });
    const job = await requireEngine().submit({
      workspaceId: principal.workspaceId,
      idempotencyKey: key,
      input,
      principal,
    });
    reply.code(202);
    return job;
  });
  app.get('/v1/generations', async (request) =>
    requireEngine().listJobs((await authenticate(request)).workspaceId),
  );
  app.get<{ Params: { id: string } }>('/v1/generations/:id', async (request, reply) => {
    const job = await requireEngine().getJob(
      (await authenticate(request)).workspaceId,
      request.params.id,
    );
    return (
      job ??
      reply.code(404).send({ error: { code: 'not_found', message: 'Generation not found.' } })
    );
  });
  app.post<{ Params: { id: string } }>('/v1/generations/:id/cancel', async (request) =>
    requireEngine().cancel(
      (await authenticate(request, 'generate')).workspaceId,
      request.params.id,
    ),
  );
  app.get('/v1/balance', async (request) =>
    requireEngine().getBalance((await authenticate(request)).workspaceId),
  );
  app.get('/llms.txt', async (_request, reply) =>
    reply
      .type('text/plain')
      .send(
        `# OpenGen\n\nRead ${publicUrl}/skill.md for the installable skill and safe generation workflow.\n\n${agentEntry(publicUrl)}\nCatalog: ${publicUrl}/v1/catalog/search. Operations: ${publicUrl}/v1/operations. OpenAPI: ${publicUrl}/openapi.json.`,
      ),
  );
  app.get('/skill.md', async (_request, reply) =>
    reply.type('text/markdown').send(agentSkill(publicUrl)),
  );
  app.get('/v1/ledger', async (request) => {
    const principal = await authenticate(request);
    const engine = requireEngine();
    if (!engine.ledger)
      throw Object.assign(new Error('Ledger is unavailable.'), { statusCode: 503 });
    const query = ledgerQuerySchema.parse(request.query);
    const data = (await engine.ledger(principal.workspaceId, query)) as Record<string, unknown>[];
    return { data, nextCursor: data.length === query.limit ? data.at(-1)!.id : null };
  });
  await registerOperator(app, { engine: options.engine, authenticate });
  await registerEvents(app, { events: options.engine?.events, authenticate });
  await registerCompatibility(app, { authenticate, requireEngine, parseInput });
  await registerMcp(app, {
    billingAvailable,
    oauthEnabled,
    publicUrl,
    env: options.env ?? process.env,
    authenticate: async (header, scope) =>
      authenticate({ headers: { authorization: header }, cookies: {} }, scope),
    parseInput,
    makeQuote,
    requireEngine,
  });
  return app;
}
