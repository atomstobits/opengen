import { operationRequest, type OperationId } from '@media-router/contracts';
import type {
  Catalog,
  DoctorReport,
  CatalogSearchFilters,
  FeedbackInput,
  Company,
  Deployment,
  GenerateInput,
  GenerationIssue,
  GenerationProfile,
  Operation,
  Job,
  Model,
  ModelSeries,
  OutputAsset,
  OwnedAssetView,
  Provider,
  Quote,
  Route,
  RouteMetrics,
  RoutingPolicy,
} from '@media-router/contracts';

export type {
  AssetRef,
  GenerationArguments,
  GenerationCapabilities,
  GenerationProfile,
  GenerationIssue,
  GenerateInput,
  Job,
  OutputAsset,
  Quote,
  RoutingPolicy,
} from '@media-router/contracts';
export interface CompanyDetail {
  company: Company;
  series: ModelSeries[];
  models: Model[];
}
export interface SeriesDetail extends Omit<CompanyDetail, 'series'> {
  series: ModelSeries;
  routes: Route[];
  deployments: Deployment[];
  providers: Provider[];
}
export interface Balance {
  availableMicros: number;
  reservedMicros: number;
  currency: 'USD';
}
export interface PreparedUpload {
  key: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}
export interface RequestOptions {
  signal?: AbortSignal;
}
export interface SubmitOptions extends RequestOptions {
  idempotencyKey: string;
}
export interface WaitOptions extends RequestOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}
export interface OpenGenOptions {
  baseUrl: string | URL;
  /** OpenGen workspace key or scoped access token; never an upstream provider key. */
  apiKey?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class OpenGenAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly issues: GenerationIssue[] = [],
  ) {
    super(message);
    this.name = 'OpenGenAPIError';
  }
}
/** The caller must retain the original input/key; the SDK never repeats a paid POST. */
export class SubmissionUncertainError extends Error {
  constructor(
    public readonly idempotencyKey: string,
    public readonly status?: number,
    cause?: unknown,
    public readonly jobId?: string,
  ) {
    super(
      'Generation acceptance is unknown. Retain this idempotency key and original input; recover the existing job before creating another submission.',
      { cause },
    );
    this.name = 'SubmissionUncertainError';
  }
}
export class JobWaitTimeoutError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly lastJob?: Job,
  ) {
    super(`Waiting timed out. Resume job ${jobId}; do not submit another generation.`);
    this.name = 'JobWaitTimeoutError';
  }
}

/** A stopped read retains the known job and does not change provider work. */
export class JobWaitError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly lastJob: Job | undefined,
    public readonly interrupted: boolean,
    cause: unknown,
  ) {
    super(
      interrupted
        ? 'Client wait interrupted. Resume the existing job.'
        : 'Job status could not be read. Resume the existing job.',
      { cause },
    );
    this.name = 'JobWaitError';
  }
}

type Empty = Record<string, never>;
export interface ImageInput {
  model: string;
  prompt: string;
  n?: 1;
  size?: '1024x1024' | '2048x2048' | '4096x4096';
  response_format?: 'url';
  billing?: 'managed' | 'byok';
  route_id?: string;
  max_cost_micros?: number;
}
export interface VideoInput {
  model: string;
  prompt: string;
  seconds: number | string;
  size: '1280x720' | '720x1280' | '1920x1080' | '1080x1920' | '854x480' | '480x854';
  billing?: 'managed' | 'byok';
  route_id?: string;
  max_cost_micros?: number;
}
export interface AlertSettingsInput {
  enabled: boolean;
  lowBalanceMicros?: number | null;
  spendingLimitMicros?: number | null;
  keyExpiryHours?: number | null;
  webhookFailures: boolean;
}
export interface LedgerQuery {
  after?: string;
  limit?: number;
}
export interface ReconcileInput {
  workspaceId: string;
  id: string;
  action: 'resume' | 'reject' | 'settle';
  reference: string;
  note: string;
  evidenceUrl: string;
  upstreamId?: string;
  billedCostMicros?: number;
}
export interface OperationInputs {
  'media.generate': GenerateInput;
  'catalog.list': Empty;
  'catalog.search': CatalogSearchFilters & { q: string };
  'doctor.get': Empty;
  'feedback.submit': FeedbackInput;
  'feedback.get': { id: string };
  'catalog.request': FeedbackInput & { kind: 'catalog-request' };
  'jobs.lookup': { idempotencyKey: string };
  'companies.list': Empty;
  'companies.get': { company: string };
  'series.list': Empty;
  'series.get': { company: string; slug: string };
  'models.list': Empty;
  'models.schema': { modelId: string; operation: Operation };
  'providers.list': Empty;
  'deployments.list': Empty;
  'routes.list': { modelId?: string };
  'metrics.list': Empty;
  'operations.list': Empty;
  'quotes.single': GenerateInput;
  'quotes.batch': GenerateInput[];
  'assets.prepare': { mediaType: string; size: number };
  'assets.complete': { key: string };
  'assets.delete': { key: string };
  'jobs.list': Empty;
  'jobs.get': { id: string };
  'jobs.cancel': { id: string };
  'balance.get': Empty;
  'ledger.list': LedgerQuery;
  'ledger.export': LedgerQuery & { format?: 'json' };
  'operator.inspect': { workspaceId: string; id: string };
  'operator.reconcile': ReconcileInput;
  'operator.reconciliations': { workspaceId: string; id: string };
  'keys.list': Empty;
  'keys.create': { name: string; scopes: string[]; policyId?: string; expiresAt?: string };
  'keys.revoke': { id: string };
  'policies.list': Empty;
  'policies.create': { name: string; policy: RoutingPolicy; maxCostMicros?: number };
  'connections.list': Empty;
  'connections.put': { deploymentId: string; apiKey: string; workspaceId?: string };
  'connections.delete': { deploymentId: string };
  'webhooks.list': Empty;
  'webhooks.create': { name: string; url: string; eventTypes: string[] };
  'webhooks.update': { id: string; enabled: boolean };
  'webhooks.rotate': { id: string };
  'webhooks.deliveries': Empty;
  'alerts.list': Empty;
  'alerts.settings.get': Empty;
  'alerts.settings.put': AlertSettingsInput;
  'workspaces.list': Empty;
  'teams.create': { name: string };
  'members.list': Empty;
  'members.invite': { issuer: string; subject: string; role: 'admin' | 'member' };
  'members.update': { id: string; role: 'admin' | 'member' };
  'members.remove': { id: string };
  'workspaces.acceptInvite': { id: string };
  'workspaces.create': { id: string; openingBalanceMicros?: number };
  'workspaces.credit': { id: string; amountMicros: number; reference: string };
  'images.generate': ImageInput;
  'videos.create': VideoInput;
  'videos.get': { id: string };
  'videos.content': { id: string };
}
export type RegisteredOperation = keyof OperationInputs & OperationId;
type Envelope = { data: Record<string, unknown>[] };
export interface OperationOutputs extends Record<RegisteredOperation, unknown> {
  'media.generate': Job;
  'catalog.list': Catalog & { companies: Company[]; series: ModelSeries[] };
  'catalog.search': Model[];
  'doctor.get': DoctorReport;
  'feedback.submit': { id: string; status: 'received'; visibility: 'workspace-and-operator' };
  'feedback.get': Omit<FeedbackInput, 'reviewedForPrivacy' | 'modelId' | 'routeId' | 'jobId'> & {
    modelId: string | null;
    routeId: string | null;
    jobId: string | null;
    id: string;
    status: 'received';
    visibility: 'workspace-and-operator';
    createdAt: string;
  };
  'catalog.request': { id: string; status: 'received'; visibility: 'workspace-and-operator' };
  'jobs.lookup': Job;
  'companies.list': { data: Company[] };
  'companies.get': CompanyDetail;
  'series.list': { data: ModelSeries[] };
  'series.get': SeriesDetail;
  'models.list': { data: Model[] };
  'models.schema': GenerationProfile;
  'providers.list': { data: Provider[] };
  'deployments.list': { data: Deployment[] };
  'routes.list': { data: Route[] };
  'metrics.list': { data: RouteMetrics[] };
  'operations.list': { data: { id: string; method: string; path: string }[] };
  'quotes.single': Quote;
  'quotes.batch': { data: Quote[] };
  'assets.prepare': PreparedUpload;
  'assets.complete': OwnedAssetView;
  'assets.delete': { state: 'deleted'; inUse: boolean };
  'jobs.list': Job[];
  'jobs.get': Job;
  'jobs.cancel': Job;
  'balance.get': Balance;
  'ledger.list': Envelope;
  'ledger.export': Envelope;
  'operator.inspect': Job;
  'operator.reconcile': Job;
  'operator.reconciliations': Envelope;
  'keys.list': Envelope;
  'keys.create': { id: string; token: string; name: string; scopes: string[] };
  'keys.revoke': { revoked: boolean };
  'policies.list': Envelope;
  'policies.create': {
    id: string;
    name: string;
    policy: RoutingPolicy;
    max_cost_micros: string | null;
  };
  'connections.list': { data: { deployment_id: string; created_at: string }[] };
  'connections.put': { deploymentId: string; configured: boolean };
  'connections.delete': { deleted: boolean };
  'webhooks.list': Envelope;
  'webhooks.create': { id: string; secret: string; name: string; url: string };
  'webhooks.update': { id: string; enabled: boolean };
  'webhooks.rotate': { id: string; secret: string };
  'webhooks.deliveries': Envelope;
  'alerts.list': Envelope;
  'alerts.settings.get': Record<string, unknown>;
  'alerts.settings.put': Record<string, unknown>;
  'workspaces.list': Envelope;
  'teams.create': Record<string, unknown>;
  'members.list': Envelope;
  'members.invite': Record<string, unknown>;
  'members.update': Record<string, unknown>;
  'members.remove': Record<string, unknown>;
  'workspaces.acceptInvite': Record<string, unknown>;
  'workspaces.create': Balance;
  'workspaces.credit': Balance;
  'images.generate': Record<string, unknown>;
  'videos.create': Record<string, unknown>;
  'videos.get': Record<string, unknown>;
  'videos.content': { statusCode: 303; location: string };
}

const stopWaiting = new Set<Job['status']>([
  'succeeded',
  'failed',
  'cancelled',
  'submission-unknown',
]);
function positiveDuration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new TypeError(`${name} must be a positive integer of at most 2147483647 milliseconds.`);
  return value;
}
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export class OpenGen {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly apiKey?: string;
  constructor(options: OpenGenOptions) {
    this.base = new URL(options.baseUrl);
    if (
      !['https:', 'http:'].includes(this.base.protocol) ||
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash
    )
      throw new TypeError(
        'baseUrl must be an HTTP(S) gateway URL without credentials, query or fragment.',
      );
    if (!this.base.pathname.endsWith('/')) this.base.pathname += '/';
    this.fetcher = options.fetch ?? fetch;
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = positiveDuration(
      options.requestTimeoutMs ?? 15_000,
      'requestTimeoutMs',
    );
  }
  private async request<T>(
    path: string,
    method: string,
    body?: unknown,
    options: RequestOptions & {
      idempotencyKey?: string;
      contentRedirect?: boolean;
      paidAdmission?: boolean;
      nativeJob?: boolean;
    } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const headers = new Headers({ Accept: 'application/json' });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (this.apiKey) headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    const deadline = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let serialized: string | undefined;
    try {
      serialized = body === undefined ? undefined : JSON.stringify(body);
    } catch {
      throw new TypeError('Request body must be JSON-serializable. No request was sent.');
    }
    let response: Response;
    try {
      response = await this.fetcher(new URL(path.replace(/^\//, ''), this.base), {
        method,
        headers,
        body: serialized,
        signal,
        cache: 'no-store',
        redirect: options.contentRedirect ? 'manual' : 'error',
      });
    } catch {
      if (options.paidAdmission) throw new SubmissionUncertainError(options.idempotencyKey!);
      signal.throwIfAborted();
      throw new Error('The OpenGen gateway response could not be read.');
    }
    if (options.contentRedirect && response.status === 303)
      return { statusCode: 303, location: response.headers.get('location') } as T;
    let data: unknown;
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // A known 4xx (except request timeout) rejects admission even if its body is unreadable.
      // A successful/5xx/408 response may follow paid acceptance, so recover by read-only lookup.
      if (
        options.paidAdmission &&
        (response.ok || response.status >= 500 || response.status === 408)
      )
        throw new SubmissionUncertainError(options.idempotencyKey!, response.status);
      if (!response.ok)
        throw new OpenGenAPIError(
          response.status,
          'request_failed',
          'The OpenGen request was rejected; its error body could not be read.',
        );
      signal.throwIfAborted();
      throw new Error('The OpenGen gateway response could not be read.');
    }
    if (!response.ok) {
      if (options.paidAdmission && (response.status >= 500 || response.status === 408))
        throw new SubmissionUncertainError(options.idempotencyKey!, response.status);
      const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
      const details =
        error && typeof error === 'object'
          ? (error as { code?: unknown; message?: unknown; issues?: unknown })
          : undefined;
      throw new OpenGenAPIError(
        response.status,
        typeof details?.code === 'string' ? details.code : 'request_failed',
        typeof details?.message === 'string'
          ? details.message
          : 'The OpenGen request was rejected.',
        Array.isArray(details?.issues) ? (details.issues as GenerationIssue[]) : [],
      );
    }
    if (options.nativeJob) {
      const value =
        data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
      const jobId =
        typeof value?.id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)
          ? value.id
          : undefined;
      if (
        !jobId ||
        ![
          'queued',
          'submitting',
          'running',
          'submission-unknown',
          'succeeded',
          'failed',
          'cancelled',
        ].includes(String(value?.status))
      )
        throw new SubmissionUncertainError(
          options.idempotencyKey!,
          response.status,
          undefined,
          jobId,
        );
    }
    return data as T;
  }
  catalog(options?: RequestOptions) {
    return this.call('catalog.list', {}, options);
  }
  search(query: string, options?: RequestOptions, filters: CatalogSearchFilters = {}) {
    return this.call('catalog.search', { q: query, ...filters }, options);
  }
  doctor(options?: RequestOptions) {
    return this.call('doctor.get', {}, options);
  }
  lookupJob(idempotencyKey: string, options?: RequestOptions) {
    return this.call('jobs.lookup', { idempotencyKey }, options);
  }
  async models(options?: RequestOptions) {
    return (await this.call('models.list', {}, options)).data;
  }
  async companies(options?: RequestOptions) {
    return (await this.call('companies.list', {}, options)).data;
  }
  company(id: string, options?: RequestOptions) {
    return this.call('companies.get', { company: id }, options);
  }
  series(company: string, series: string, options?: RequestOptions) {
    return this.call('series.get', { company, slug: series }, options);
  }
  quote(input: GenerateInput, options?: RequestOptions) {
    return this.call('quotes.single', input, options);
  }
  async quotes(inputs: GenerateInput[], options?: RequestOptions) {
    return (await this.call('quotes.batch', inputs, options)).data;
  }
  submit(input: GenerateInput, options: SubmitOptions): Promise<Job> {
    return this.call('media.generate', input, options);
  }
  job(id: string, options?: RequestOptions) {
    return this.call('jobs.get', { id }, options);
  }
  cancel(id: string, options?: RequestOptions) {
    return this.call('jobs.cancel', { id }, options);
  }
  balance(options?: RequestOptions) {
    return this.call('balance.get', {}, options);
  }
  async metrics(options?: RequestOptions) {
    return (await this.call('metrics.list', {}, options)).data;
  }
  async operations(options?: RequestOptions) {
    return (await this.call('operations.list', {}, options)).data;
  }
  call<K extends RegisteredOperation>(
    operationId: K,
    input: OperationInputs[K],
    ...options: K extends 'media.generate' | 'images.generate' | 'videos.create'
      ? [SubmitOptions]
      : [RequestOptions?]
  ): Promise<OperationOutputs[K]> {
    const requestOptions: RequestOptions & { idempotencyKey?: string } = options[0] ?? {};
    const paidAdmission = ['media.generate', 'images.generate', 'videos.create'].includes(
      operationId,
    );
    if (
      paidAdmission &&
      (!requestOptions.idempotencyKey || requestOptions.idempotencyKey.length > 200)
    )
      throw new TypeError('A stable idempotencyKey of 1–200 characters is required.');
    const { method, path, payload } = operationRequest(operationId, input);
    return this.request<OperationOutputs[K]>(path, method, payload, {
      ...requestOptions,
      contentRedirect: operationId === 'videos.content',
      paidAdmission,
      nativeJob: operationId === 'media.generate',
    });
  }
  async wait(id: string, options: WaitOptions = {}): Promise<Job> {
    const deadline = AbortSignal.timeout(
      positiveDuration(options.timeoutMs ?? 900_000, 'timeoutMs'),
    );
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const interval = positiveDuration(options.pollIntervalMs ?? 2_000, 'pollIntervalMs');
    let lastJob: Job | undefined;
    try {
      options.signal?.throwIfAborted();
      for (;;) {
        lastJob = await this.job(id, { signal });
        if (stopWaiting.has(lastJob.status)) return lastJob;
        await delay(interval, signal);
      }
    } catch (error) {
      if (deadline.aborted && !options.signal?.aborted) throw new JobWaitTimeoutError(id, lastJob);
      throw new JobWaitError(id, lastJob, Boolean(options.signal?.aborted), error);
    }
  }
}
