import {
  NotificationEmailStore,
  notificationEmailConfiguration,
  type NotificationEmailConfiguration,
  type NotificationEmailTransport,
} from './notification-email.js';
import { AttemptCredentialStore, type AttemptCredentialScope } from './attempt-credentials.js';
import {
  DeliveryStore,
  deliveryDatabase,
  deliveryStorage,
  type DeliveryScope,
  type DeliverySource,
  type DeliveryOptions,
} from './delivery.js';
import { projectCustomerJob } from './delivery-projection.js';
import { readPublicAsset } from './output.js';
import { exchangeFalCdnReadToken, isFalRestrictedAssetUrl } from './fal-cdn.js';
import type { CaptureProviderOutputs } from './adapter-output.js';
import type { downloadInput } from './input-download.js';
import { JobStatusStore } from './job-status.js';
import {
  configurePoolInTransaction,
  enqueueDispatchInTransaction,
  beginDispatchInTransaction,
  expireQueuedDispatchInTransaction,
  cancelQueuedDispatchInTransaction,
  markDispatchUnknownInTransaction,
  releaseDispatchInTransaction,
  claimAcceptedWorkInTransaction,
  workspacePoolId,
  providerPoolId,
  type DispatchIdentity,
} from './dispatch-capacity.js';
import {
  jobError,
  providerFailureError,
  normalizeJobError,
  normalizeJobProgress,
  normalizeJobTimings,
  gatewayJobTimings,
} from './execution-telemetry.js';
import { AssetError, OwnedAssetService, type InputManifestEntry } from './owned-assets.js';
import {
  executionScopeAllows,
  executionScopeNotice,
  executionScopeReason,
  validateExecutionScope,
  type ExecutionScope,
} from './execution-scope.js';
import { ActivityStore } from './activity.js';
import { NotificationStore } from './notifications.js';
import { OwnedOutputAccess } from './owned-output-access.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { catalog as defaultCatalog, quote as defaultQuote } from '@media-router/catalog';
import type {
  Catalog,
  ComparisonChildQuote,
  ComparisonJob,
  ComparisonQuote,
  ComparisonRun,
  ComparisonSummary,
  Deployment,
  GenerateInput,
  Job,
  JobStatus,
  Quote,
  Route,
  RouteMetrics,
} from '@media-router/contracts';
import {
  createAlibabaAdapter,
  isPublicHttpsAssetUrl,
  SubmissionRejected,
  type ProviderAdapter,
  type ProviderResult,
} from './adapters.js';
import { createDefaultAdapters } from './providers.js';
import { mapGenerationAssets, parseGenerationRequest } from '@media-router/contracts/generation';
import { FeedbackStore } from './feedback.js';
import { AccountStore, type Principal } from './accounts.js';
import {
  attributionForPrincipal,
  parseGenerationMetadata,
  revalidateGovernanceAuthority,
} from './governance-authority.js';
import {
  constrainGovernedInput,
  constrainRoutingPolicy,
  materializeRoutingPolicy,
  assertGovernedRoutes,
} from './routing-governance.js';
import { KeyBudgetStore } from './key-budgets.js';
import { AssetStore } from './storage.js';
import { EventStore } from './events.js';
import { McpOAuthStore } from './mcp-oauth.js';
import { createFeePolicy, settleVerifiedCost, type FeePolicy } from './billing-fees.js';
import { quoteWithGenerationFee } from './generation-billing-quote.js';
import {
  generationFeeTerms,
  generationFeeSettlementView,
  type GenerationCostScope,
  type GenerationCostEvidence,
  type GenerationFeeAdmission,
} from './generation-billing.js';
import type { GenerationFeeSettlement } from '@media-router/contracts';
import { finalizeAgedCostReliefInTransaction } from './aged-cost-relief-settlement.js';

export * from './adapters.js';
export * from './dispatch-capacity.js';
export * from './execution-telemetry.js';
export * from './execution-scope.js';
export * from './job-status.js';
export * from './byteplus.js';
export * from './providers.js';
export * from './accounts.js';
export * from './terms-receipts.js';
export * from './aged-cost-relief.js';
export * from './governance-authority.js';
export * from './routing-governance.js';
export * from './key-budgets.js';
export * from './account-governance.js';
export * from './mcp-oauth.js';
export * from './storage.js';
export * from './events.js';
export * from './activity.js';
export * from './notifications.js';
export * from './notification-email.js';
export * from './owned-output-access.js';
export * from './owned-assets.js';
export * from './feedback.js';
export * from './payments.js';
export * from './vault.js';
export * from './public-network.js';
export * from './output.js';
export * from './provenance.js';
export * from './delivery.js';
export * from './output-evidence.js';
export * from './attempt-credentials.js';

export class EngineError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface Balance {
  availableMicros: number;
  reservedMicros: number;
  currency: 'USD';
}
export interface Reconciliation {
  action: 'resume' | 'reject' | 'settle';
  reference: string;
  note: string;
  evidenceUrl: string;
  upstreamId?: string;
  billedCostMicros?: number;
  costBasis?: 'operator-audited';
}
export interface EngineOptions {
  databaseUrl: string;
  /** Public origin shared by HTTP discovery and MCP authorization metadata. */
  publicUrl?: string;
  catalog?: Catalog;
  adapters?: ProviderAdapter[];
  /** Immutable runtime fence: false permits billing/account reads but no provider execution. */
  providerExecutionEnabled?: boolean;
  /** Trusted qualification boundary. Unrestricted preserves normal self-hosted capabilities. */
  executionScope?: ExecutionScope;
  /** Explicit, trusted fixture injection. The API and worker entrypoints supply no fee policy. */
  fixtureBillingPolicy?: FeePolicy;
  quote?: (
    input: GenerateInput,
    options: { executableRouteIds: string[]; metrics?: RouteMetrics[] },
  ) => Quote;
  pollIntervalMs?: number;
  leaseMs?: number;
  poolSize?: number;
  vaultKey?: string;
  storage?: AssetStore;
  retainedInputMs?: number;
  /** Trusted runtime configuration; not accepted in generation JSON. */
  providerEnv?: NodeJS.ProcessEnv;
  /** Explicit stable revision for custom adapters; synthetic fixtures need no secrets. */
  adapterCredentialIdentity?: string;
  delivery?: Pick<DeliveryOptions, 'download' | 'inspect' | 'provenance' | 'maxAttempts'>;
  /** Trusted transport injection for deterministic, unpaid input fixtures. */
  inputDownloader?: typeof downloadInput;
  statusPoolSize?: number;
  notificationEmail?: NotificationEmailConfiguration;
  notificationEmailTransport?: NotificationEmailTransport;
  execution?: {
    workspaceMaxActive?: number;
    workspaceMaxQueued?: number;
    providerMaxActive?: number;
    providerMaxQueued?: number;
    /** Trusted logical account mapping. Same managed account across deployments
     * MUST map to one ID. BYOK mapping groups accounts within its workspace.
     * Never return a secret or credential version; rotation must retain occupancy. */
    supplyId?: (input: {
      workspaceId: string;
      route: Route;
      deployment: Deployment;
      billing: 'managed' | 'byok';
    }) => string;
  };
}

interface JobRow {
  fee_admission: GenerationFeeAdmission | null;
  fee_settlement: GenerationFeeSettlement | null;
  billing_poll_pending: boolean;
  lease_until: Date | null;
  attribution: Job['attribution'];
  metadata: Job['metadata'];
  execution_progress?: unknown;
  execution_error?: unknown;
  execution_timings?: unknown;
  queue_start_deadline_at?: Date | null;
  id: string;
  workspace_id: string;
  idempotency_key: string;
  request_hash: string;
  input: GenerateInput;
  route_snapshot: Route;
  deployment_snapshot: Deployment;
  status: JobStatus;
  upstream_id: string | null;
  outputs: Job['outputs'];
  error: string | null;
  reserved_micros: string;
  settled_micros: string | null;
  attempt_count: number;
  created_at: Date;
  updated_at: Date;
  fallback_routes: { route: Route; deployment: Deployment }[];
  delivery_status: Job['deliveryStatus'];
  delivery_errors: Job['deliveryErrors'];
  output_evidence?: unknown;
}

type ExecutionScopeJob = Pick<JobRow, 'id' | 'workspace_id' | 'request_hash' | 'input'> & {
  route_snapshot: Pick<Route, 'id' | 'modelId' | 'deploymentId'>;
};

interface ComparisonRow {
  id: string;
  quote: ComparisonQuote;
  child_key_nonce: string;
  expires_at: Date;
  admitted_at: Date | null;
  first_job_id: string | null;
  second_job_id: string | null;
}

interface Submission {
  workspaceId: string;
  idempotencyKey: string;
  input: GenerateInput;
  principal?: Principal;
}

const comparisonQuoteLifetimeSeconds = 10 * 60;
const terminal = new Set<JobStatus>(['succeeded', 'failed', 'cancelled']);
function micros(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new EngineError('invalid_money', 'Amounts must be nonnegative integer micro-USD.');
  return number;
}
/** The caller owns the transaction; credit and its enclosing business writes commit together. */
export async function creditWorkspaceInTransaction(
  client: PoolClient,
  workspaceId: string,
  amountMicros: number,
  reference: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  micros(amountMicros);
  if (!reference || reference.length > 200 || !amountMicros)
    throw new EngineError('invalid_credit', 'A positive amount and stable reference are required.');
  const owned = await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
    workspaceId,
  ]);
  if (!owned.rowCount) throw new EngineError('workspace_not_found', 'Workspace not found.', 404);
  const existing = await client.query(
    'SELECT amount_micros FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
    [workspaceId, reference],
  );
  if (existing.rows[0]) {
    if (Number(existing.rows[0].amount_micros) !== amountMicros)
      throw new EngineError(
        'credit_conflict',
        'Reference already used for a different credit amount.',
        409,
      );
    return;
  }
  const balance = (
    await client.query('SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1', [
      workspaceId,
    ])
  ).rows[0];
  micros(Number(balance.available_micros) + Number(balance.reserved_micros) + amountMicros);
  await client.query('UPDATE mr_workspaces SET available_micros=available_micros+$2 WHERE id=$1', [
    workspaceId,
    amountMicros,
  ]);
  await client.query(
    "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details) VALUES($1,$2,'credit',$3,$3,0,$4,$5)",
    [randomUUID(), workspaceId, amountMicros, reference, JSON.stringify(details)],
  );
}
function job(row: JobRow): Job {
  return {
    id: row.id,
    attribution: row.attribution ?? null,
    metadata: row.metadata ?? {},
    ...(row.output_evidence ? { outputEvidence: row.output_evidence } : {}),
    progress: normalizeJobProgress(row.execution_progress),
    structuredError: normalizeJobError(row.execution_error),
    deliveryStatus: row.delivery_status ?? undefined,
    deliveryErrors: row.delivery_errors,
    workspaceId: row.workspace_id,
    status: row.status,
    input: row.input,
    routeId: row.route_snapshot.id,
    deploymentId: row.deployment_snapshot.id,
    upstreamId: row.upstream_id,
    outputs: row.outputs,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    reservedMicros: Number(row.reserved_micros),
    settledMicros: row.settled_micros === null ? null : Number(row.settled_micros),
    attemptCount: row.attempt_count,
    ...(row.fee_admission
      ? {
          billing: row.fee_settlement
            ? generationFeeSettlementView(row.fee_settlement)
            : { ...generationFeeTerms(row.fee_admission.snapshot), costStatus: 'pending' as const },
        }
      : {}),
  };
}
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    current && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(
          Object.keys(current)
            .sort()
            .map((key) => [key, current[key]]),
        )
      : current,
  );
}
function requestHash(input: GenerateInput): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}
function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new EngineError('not_found', 'Generation not found.', 404);
}

export class Engine {
  readonly pool: Pool;
  private readonly statusPool: Pool;
  readonly jobStatus: JobStatusStore;
  readonly catalog: Catalog;
  readonly adapters: ProviderAdapter[];
  readonly accounts: AccountStore;
  readonly mcpOAuth: McpOAuthStore;
  readonly storage?: AssetStore;
  readonly events: EventStore;
  readonly activity: ActivityStore;
  readonly notifications: NotificationStore;
  readonly notificationEmail: NotificationEmailStore;
  readonly ownedOutputAccess: OwnedOutputAccess;
  readonly ownedAssets?: OwnedAssetService;
  readonly feedback: FeedbackStore;
  readonly delivery: DeliveryStore;
  private readonly attemptCredentials: AttemptCredentialStore;
  private readonly injectedAdapters: boolean;
  private readonly providerExecutionEnabled: boolean;
  private readonly executionScope: ExecutionScope;
  private readonly vaultKey?: string;
  private readonly providerEnv: NodeJS.ProcessEnv;
  private readonly quoteRequest: NonNullable<EngineOptions['quote']>;
  private readonly customQuote: boolean;
  private readonly fixtureBillingPolicy?: FeePolicy;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly execution: NonNullable<EngineOptions['execution']>;
  /** Process-local cadence only; durable work identity remains in PostgreSQL. */
  private workerTurn = 0;
  private acceptedMaintenancePhase = 0;
  /** Selection cadence only. Eligibility and expiry remain locked PostgreSQL decisions. */
  private qualificationExpiryAfterId: string | null = null;

  constructor(options: EngineOptions) {
    if (
      options.providerExecutionEnabled !== undefined &&
      typeof options.providerExecutionEnabled !== 'boolean'
    )
      throw new EngineError(
        'invalid_provider_execution_options',
        'Provider execution requires a boolean runtime configuration.',
        503,
      );
    this.providerExecutionEnabled = options.providerExecutionEnabled ?? true;
    this.executionScope = validateExecutionScope(
      options.executionScope ?? { profile: 'unrestricted' },
    );
    if (options.fixtureBillingPolicy) {
      const policy = createFeePolicy(options.fixtureBillingPolicy);
      if (
        !options.adapters?.length ||
        policy.activation !== 'fixture' ||
        policy.eligibleOutcomes.some(
          (outcome) => outcome === 'delivery-partial' || outcome === 'delivery-unusable',
        )
      )
        throw new EngineError(
          'invalid_fee_fixture',
          'The fee fixture requires injected adapters and a provider-outcome policy.',
          503,
        );
      this.fixtureBillingPolicy = policy;
    }
    const poolSize = options.poolSize ?? Number(process.env.MR_DATABASE_POOL_SIZE ?? 8);
    if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 50)
      throw new Error('MR_DATABASE_POOL_SIZE must be 1–50.');
    this.pool = new Pool({ connectionString: options.databaseUrl, max: poolSize });
    const statusPoolSize = options.statusPoolSize ?? 2;
    if (!Number.isInteger(statusPoolSize) || statusPoolSize < 1 || statusPoolSize > 10)
      throw new EngineError('invalid_status_options', 'Status pool size must be 1–10.', 503);
    this.statusPool = new Pool({
      connectionString: options.databaseUrl,
      max: statusPoolSize,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      statement_timeout: 5000,
      idleTimeoutMillis: 30000,
    });
    this.jobStatus = new JobStatusStore(this.statusPool);
    this.catalog = options.catalog ?? defaultCatalog;
    this.activity = new ActivityStore(this.pool);
    this.notificationEmail = new NotificationEmailStore(this.pool, {
      config:
        options.notificationEmail ??
        notificationEmailConfiguration({
          OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: process.env.OPENGEN_NOTIFICATION_EMAIL_ENDPOINT,
          OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: process.env.OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN,
          OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED:
            process.env.OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED,
          OPENGEN_PUBLIC_URL: options.publicUrl ?? process.env.OPENGEN_PUBLIC_URL,
        }),
      send: options.notificationEmailTransport,
    });
    this.notifications = new NotificationStore(this.pool, this.notificationEmail);
    this.ownedOutputAccess = new OwnedOutputAccess(this.pool);
    this.feedback = new FeedbackStore(this.pool);
    this.events = new EventStore(this.pool, {
      vaultKey: options.vaultKey ?? process.env.MR_VAULT_KEY,
    });
    this.accounts = new AccountStore(this.pool, options.vaultKey ?? process.env.MR_VAULT_KEY);
    this.mcpOAuth = new McpOAuthStore(this.pool, this.accounts, {
      issuer: options.publicUrl ?? process.env.OPENGEN_PUBLIC_URL ?? 'http://localhost:4320',
    });
    this.storage = options.storage ?? AssetStore.fromEnv();
    this.ownedAssets = this.storage
      ? new OwnedAssetService(this.pool, this.storage, {
          retainedInputMs:
            options.retainedInputMs ??
            (process.env.MR_INPUT_RETENTION_MS?.trim()
              ? Number(process.env.MR_INPUT_RETENTION_MS)
              : undefined),
          download: options.inputDownloader,
        })
      : undefined;
    this.vaultKey = options.vaultKey ?? process.env.MR_VAULT_KEY;
    this.providerEnv = { ...(options.providerEnv ?? process.env) };
    this.injectedAdapters = options.adapters !== undefined;
    this.attemptCredentials = new AttemptCredentialStore(this.pool, {
      vaultKey: this.vaultKey,
      env: this.providerEnv,
      injected: this.injectedAdapters,
      injectedIdentity: options.adapterCredentialIdentity,
    });
    this.delivery = new DeliveryStore(deliveryDatabase(this.pool), {
      storage: this.storage ? deliveryStorage(this.storage) : undefined,
      ...options.delivery,
      recoveryEnabled: this.providerExecutionEnabled,
      download:
        options.delivery?.download ?? ((source, scope) => this.downloadDelivery(source, scope)),
      refresh: (scope, slot) => this.refreshDelivery(scope, slot),
    });
    this.adapters =
      options.adapters ??
      createDefaultAdapters({
        env: this.providerEnv,
        storeOutput: this.storage ? (input) => this.storage!.putOutput(input) : undefined,
        captureOutputs: this.captureProviderOutputs,
      });
    this.quoteRequest = options.quote ?? defaultQuote;
    this.customQuote = Boolean(options.quote);
    this.pollIntervalMs = options.pollIntervalMs ?? 15_000;
    this.leaseMs = options.leaseMs ?? 120_000;
    this.execution = options.execution ?? {};
    for (const [name, value] of Object.entries({
      workspaceMaxActive: this.execution.workspaceMaxActive ?? 8,
      workspaceMaxQueued: this.execution.workspaceMaxQueued ?? 100,
      providerMaxActive: this.execution.providerMaxActive ?? 8,
      providerMaxQueued: this.execution.providerMaxQueued ?? 100,
    }))
      if (
        !Number.isSafeInteger(value) ||
        value < (name.endsWith('Active') ? 1 : 0) ||
        value > 1_000_000
      )
        throw new EngineError(
          'dispatch_configuration',
          'Invalid dispatch capacity configuration.',
          503,
        );
  }

  async initialize(): Promise<void> {
    const migrations = await Promise.all(
      [
        '001.sql',
        '002.sql',
        '003.sql',
        '004.sql',
        '005.sql',
        '006.sql',
        '007.sql',
        '008.sql',
        '009.sql',
        '010.sql',
        '011.sql',
        '012.sql',
        '013.sql',
        '014.sql',
        '015.sql',
        '016.sql',
        '017.sql',
        '018.sql',
        '019.sql',
        '020.sql',
        '021.sql',
        '022.sql',
        '023.sql',
        '024.sql',
        '025.sql',
        '026.sql',
        '027.sql',
        '028.sql',
        '029.sql',
        '030.sql',
        '031.sql',
      ].map((name, index) => {
        if (name !== `${String(index + 1).padStart(3, '0')}.sql`)
          throw new Error('Migration manifest must be unique and contiguous.');
        return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      }),
    );
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('media-router-schema'))");
      await client.query(
        'CREATE TABLE IF NOT EXISTS mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (let index = 0; index < migrations.length; index++) {
        const migration = migrations[index]!;
        const name = String(index + 1).padStart(3, '0') + '.sql';
        const checksum = createHash('sha256').update(migration).digest('hex');
        const applied = (
          await client.query('SELECT checksum FROM mr_migrations WHERE name=$1', [name])
        ).rows[0];
        if (applied) {
          if (applied.checksum !== checksum)
            throw new Error(
              `Applied migration ${name} changed; restore original and add a forward migration.`,
            );
          continue;
        }
        await client.query(migration);
        await client.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
          name,
          checksum,
        ]);
      }
    });
  }

  async close(): Promise<void> {
    await Promise.all([this.pool.end(), this.statusPool.end()]);
  }

  private assertProviderExecutionEnabled(): void {
    if (!this.providerExecutionEnabled)
      throw new EngineError(
        'provider_execution_disabled',
        'Provider execution is disabled on this runtime.',
        503,
      );
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Operator bootstrap only: repeated calls never mint additional credit. */
  private async privateJobRow(workspaceId: string, id: string): Promise<JobRow | null> {
    validateId(id);
    return (
      (
        await this.pool.query<JobRow>('SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2', [
          workspaceId,
          id,
        ])
      ).rows[0] ?? null
    );
  }
  private async internalJob(workspaceId: string, id: string): Promise<Job | null> {
    const row = await this.privateJobRow(workspaceId, id);
    return row ? job(row) : null;
  }
  private credentialScope(row: JobRow): AttemptCredentialScope {
    return {
      workspaceId: row.workspace_id,
      jobId: row.id,
      attempt: row.attempt_count,
      deployment: row.deployment_snapshot,
      billing: row.input.billing,
    };
  }
  /** Same claim transaction after inserting mr_attempts and before external submit. */
  private async freezeAttemptCredentials(client: PoolClient, row: JobRow): Promise<void> {
    await this.attemptCredentials.freeze(client, this.credentialScope(row));
  }
  /** Private revision identity, distinct from a stable logical capacity supply/account ID. */
  async getAttemptCredentialIdentity(workspaceId: string, id: string): Promise<string> {
    const row = await this.privateJobRow(workspaceId, id);
    if (!row) throw new EngineError('not_found', 'Generation not found.', 404);
    const identity = await this.attemptCredentials.identity(this.credentialScope(row));
    if (!identity)
      throw new EngineError(
        'original_credentials_unavailable',
        'The original provider credential identity is unavailable.',
        409,
      );
    return identity;
  }
  private resultAttempt(row: JobRow) {
    return {
      attemptCount: row.attempt_count,
      routeId: row.route_snapshot.id,
      deploymentId: row.deployment_snapshot.id,
      upstreamId: row.upstream_id,
    };
  }
  private assertResultAttempt(
    row: JobRow,
    expected?: {
      attemptCount: number;
      routeId: string;
      deploymentId: string;
      upstreamId?: string | null;
    },
  ) {
    if (
      expected &&
      (expected.attemptCount !== row.attempt_count ||
        expected.routeId !== row.route_snapshot.id ||
        expected.deploymentId !== row.deployment_snapshot.id ||
        (expected.upstreamId !== undefined && expected.upstreamId !== row.upstream_id))
    )
      throw new EngineError(
        'result_attempt_mismatch',
        'The provider attempt changed; old output was not applied.',
        409,
      );
  }
  private async deliveryScope(row: JobRow, allowLegacyPublic = false): Promise<DeliveryScope> {
    let identity: string | null = null;
    try {
      identity = await this.attemptCredentials.identity(this.credentialScope(row));
      if (!identity && !allowLegacyPublic)
        throw new EngineError(
          'original_credentials_unavailable',
          'The original provider credential identity is unavailable.',
          409,
        );
    } catch (error) {
      if (!allowLegacyPublic) throw error;
    }
    return {
      workspaceId: row.workspace_id,
      jobId: row.id,
      attempt: row.attempt_count,
      routeId: row.route_snapshot.id,
      deploymentId: row.deployment_snapshot.id,
      upstreamId: row.upstream_id,
      providerConnectionId: identity,
    };
  }
  private async scopedDeliveryRow(scope: DeliveryScope): Promise<JobRow> {
    const row = await this.privateJobRow(scope.workspaceId, scope.jobId);
    if (
      !row ||
      row.attempt_count !== scope.attempt ||
      row.route_snapshot.id !== scope.routeId ||
      row.deployment_snapshot.id !== scope.deploymentId ||
      row.upstream_id !== scope.upstreamId
    )
      throw new EngineError(
        'delivery_attempt_mismatch',
        'The original delivery attempt is unavailable.',
        409,
      );
    if (
      scope.providerConnectionId &&
      (await this.attemptCredentials.identity(this.credentialScope(row))) !==
        scope.providerConnectionId
    )
      throw new EngineError(
        'original_credentials_unavailable',
        'The original provider credential identity is unavailable.',
        409,
      );
    return row;
  }
  private async adaptersForAttempt(
    row: JobRow,
    captureOutputs: CaptureProviderOutputs = this.captureProviderOutputs,
  ): Promise<ProviderAdapter[]> {
    this.assertProviderExecutionEnabled();
    const credential = await this.attemptCredentials.read(this.credentialScope(row));
    return credential.kind === 'injected'
      ? this.adapters
      : createDefaultAdapters({
          env: credential.env,
          captureOutputs,
          storeOutput: this.storage ? (input) => this.storage!.putOutput(input) : undefined,
        });
  }
  private async adaptersForDeployment(
    row: JobRow,
    deployment: Deployment,
  ): Promise<ProviderAdapter[]> {
    this.assertProviderExecutionEnabled();
    const credential = await this.attemptCredentials.readAdmission({
      ...this.credentialScope(row),
      deployment,
    });
    return credential.kind === 'injected'
      ? this.adapters
      : createDefaultAdapters({
          env: credential.env,
          captureOutputs: this.captureProviderOutputs,
          storeOutput: this.storage ? (input) => this.storage!.putOutput(input) : undefined,
        });
  }
  private readonly captureProviderOutputs: CaptureProviderOutputs = async (context, sources) => {
    if (!context.workspaceId || !context.attempt)
      throw new EngineError('delivery_attempt_mismatch', 'Missing original attempt context.', 409);
    const row = await this.privateJobRow(context.workspaceId, context.jobId);
    if (
      !row ||
      row.attempt_count !== context.attempt ||
      row.route_snapshot.id !== context.route.id ||
      row.deployment_snapshot.id !== context.deployment.id ||
      (context.upstreamId ?? null) !== row.upstream_id
    )
      throw new EngineError(
        'delivery_attempt_mismatch',
        'The provider output does not belong to the current original attempt.',
        409,
      );
    const scope = await this.deliveryScope(row);
    if (context.providerConnectionId !== scope.providerConnectionId)
      throw new EngineError(
        'original_credentials_unavailable',
        'The original provider connection changed.',
        409,
      );
    const receipts = (await this.delivery.receipts(scope.workspaceId, scope.jobId)).filter(
      (item) => item.attempt === scope.attempt,
    );
    // Poll replays can return a fresh URL for the same task. Retained descriptors
    // stay immutable; only the controlled refresh lookup can replace an unretained URL.
    if (
      receipts.some(
        (item) =>
          item.route_id !== scope.routeId ||
          item.deployment_id !== scope.deploymentId ||
          item.upstream_id !== scope.upstreamId ||
          item.provider_connection_id !== scope.providerConnectionId,
      ) ||
      (receipts.length &&
        (receipts.length !== sources.length ||
          receipts.some((item, index) => item.media_type !== sources[index]?.mediaType)))
    )
      throw new EngineError(
        'delivery_receipt_conflict',
        'The original output package changed; it was not replaced.',
        409,
      );
    if (!receipts.length) await this.delivery.capture(scope, sources);
    return []; // Delivery recovery is independent from provider outcome and money.
  };
  private async downloadDelivery(
    source: Extract<DeliverySource, { kind: 'url' }>,
    scope: DeliveryScope,
  ): Promise<Buffer> {
    this.assertProviderExecutionEnabled();
    const row = await this.scopedDeliveryRow(scope);
    // Legacy original public capabilities can be ingested without inventing an
    // account identity. No credentials or refresh are allowed for that unknown.
    if (!scope.providerConnectionId) return (await readPublicAsset(source.url)).bytes;
    const credential = await this.attemptCredentials.read(this.credentialScope(row));
    if (row.deployment_snapshot.providerId === 'replicate') {
      const key = credential.env.REPLICATE_API_TOKEN;
      if (!key) throw new Error('Original media credential unavailable.');
      return (
        await readPublicAsset(source.url, {
          headers: { Authorization: `Bearer ${key}` },
          credentialHosts: ['.replicate.delivery'],
        })
      ).bytes;
    }
    if (row.deployment_snapshot.providerId === 'fal' && isFalRestrictedAssetUrl(source.url)) {
      const key = credential.env.FAL_KEY;
      if (!key) throw new Error('Original media credential unavailable.');
      const capability = await exchangeFalCdnReadToken({
        apiKey: key,
        assetUrl: source.url,
      });
      return (await readPublicAsset(source.url, capability.readOptions)).bytes;
    }
    return (await readPublicAsset(source.url)).bytes;
  }
  private async refreshDelivery(
    scope: DeliveryScope,
    slot: number,
  ): Promise<Extract<DeliverySource, { kind: 'url' }>> {
    this.assertProviderExecutionEnabled();
    const row = await this.scopedDeliveryRow(scope);
    if (!scope.upstreamId || !scope.providerConnectionId)
      throw new Error('Original source cannot be refreshed.');
    let captured: DeliverySource[] = [];
    const adapters = await this.adaptersForAttempt(row, async (_context, sources) => {
      captured = sources;
      return [];
    });
    const adapter = adapters.find((value) => value.id === row.route_snapshot.adapter);
    if (!adapter) throw new Error('Original provider unavailable.');
    this.assertProviderExecutionEnabled();
    const result = await adapter.poll({
      jobId: row.id,
      workspaceId: row.workspace_id,
      attempt: row.attempt_count,
      providerConnectionId: scope.providerConnectionId,
      input: row.input,
      route: row.route_snapshot,
      deployment: row.deployment_snapshot,
      upstreamId: scope.upstreamId,
    });
    if (result.status !== 'succeeded') throw new Error('Original output is unavailable.');
    const source =
      captured[slot] ??
      (result.outputs?.[slot]
        ? {
            kind: 'url' as const,
            url: result.outputs[slot]!.url,
            mediaType: result.outputs[slot]!.mediaType,
            refreshable: true,
          }
        : undefined);
    if (!source || source.kind !== 'url') throw new Error('Original output is unavailable.');
    return source;
  }
  private async deliveryResultInTransaction(client: PoolClient, row: JobRow) {
    const receipts = await client.query(
      'SELECT id,route_id,deployment_id,upstream_id FROM mr_output_receipts WHERE job_id=$1 AND attempt=$2 ORDER BY slot FOR SHARE',
      [row.id, row.attempt_count],
    );
    if (!receipts.rowCount) return undefined;
    if (
      receipts.rows.some(
        (item) =>
          item.route_id !== row.route_snapshot.id ||
          item.deployment_id !== row.deployment_snapshot.id ||
          item.upstream_id !== row.upstream_id,
      )
    )
      throw new EngineError(
        'delivery_attempt_mismatch',
        'The original output attempt changed.',
        409,
      );
    // Use the checked-out client: no nested pool checkout while the job/receipt
    // locks are held. The result method performs SQL reads only.
    const view = new DeliveryStore({
      query: client.query.bind(client),
      transaction: async (operation) => operation(client),
    });
    return view.result({
      workspaceId: row.workspace_id,
      jobId: row.id,
      attempt: row.attempt_count,
      routeId: row.route_snapshot.id,
      deploymentId: row.deployment_snapshot.id,
      upstreamId: row.upstream_id,
    });
  }
  /** Accepted receipt work only; never a new attempt, submit, reservation or settlement. */
  async recoverDeliveryOnce(): Promise<boolean> {
    if (!this.providerExecutionEnabled) return false;
    const recovered = await this.delivery.recoverOne();
    const candidate = (
      await this.pool
        .query<JobRow>(`SELECT j.* FROM mr_jobs j WHERE j.status='succeeded' AND EXISTS(
      SELECT 1 FROM mr_output_receipts r WHERE r.job_id=j.id AND r.workspace_id=j.workspace_id AND r.attempt=j.attempt_count
      AND r.route_id=j.route_snapshot->>'id' AND r.deployment_id=j.deployment_snapshot->>'id' AND r.upstream_id IS NOT DISTINCT FROM j.upstream_id
      AND (j.delivery_updated_at IS NULL OR r.updated_at>j.delivery_updated_at)) ORDER BY j.updated_at,j.id LIMIT 1`)
    ).rows[0];
    if (!candidate) return recovered;
    await this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        candidate.workspace_id,
      ]);
      const row = (
        await client.query<JobRow>(
          'SELECT * FROM mr_jobs WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [candidate.id, candidate.workspace_id],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== 'succeeded' ||
        row.attempt_count !== candidate.attempt_count ||
        row.route_snapshot.id !== candidate.route_snapshot.id ||
        row.deployment_snapshot.id !== candidate.deployment_snapshot.id ||
        row.upstream_id !== candidate.upstream_id
      )
        return;
      const result = await this.deliveryResultInTransaction(client, row);
      if (!result) return;
      await client.query(
        'UPDATE mr_jobs SET outputs=$2,delivery_status=$3,delivery_errors=$4,output_evidence=$5,delivery_updated_at=clock_timestamp(),updated_at=now() WHERE id=$1',
        [
          row.id,
          JSON.stringify(result.outputs),
          result.deliveryStatus,
          JSON.stringify(result.deliveryErrors),
          JSON.stringify(result.outputEvidence),
        ],
      );
      const pending = Boolean(
        (
          await client.query(
            "SELECT 1 FROM mr_output_receipts WHERE job_id=$1 AND attempt=$2 AND state='pending' LIMIT 1",
            [row.id, row.attempt_count],
          )
        ).rowCount,
      );
      const error =
        result.deliveryStatus === 'available'
          ? null
          : pending
            ? jobError('delivery_unavailable')
            : jobError(
                result.deliveryStatus === 'expired' ? 'delivery_expired' : 'delivery_failed',
              );
      await client.query(
        'UPDATE mr_jobs SET execution_progress=$2,execution_error=$3,error=$4 WHERE id=$1',
        [
          row.id,
          JSON.stringify({
            phase: pending ? 'delivery' : 'complete',
            percent: null,
            source: 'gateway',
            observedAt: new Date().toISOString(),
          }),
          error ? JSON.stringify(error) : null,
          error?.message ?? null,
        ],
      );
    });
    return true;
  }
  /** Existing provider URLs are private recovery data, never a customer fallback.
   * Ingest an old original capability without guessing credentials or refreshing it. */
  private async checkpointLegacyOutputsOnce(): Promise<boolean> {
    const row = (
      await this.pool
        .query<JobRow>(`SELECT j.* FROM mr_jobs j WHERE j.status='succeeded' AND j.attempt_count>0
      AND (j.delivery_status IS NULL OR j.delivery_status IN ('unverified','available'))
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(j.outputs) o WHERE NOT (o ? 'storageKey'))
      AND NOT EXISTS(SELECT 1 FROM mr_output_receipts r WHERE r.job_id=j.id AND r.attempt=j.attempt_count)
      ORDER BY j.created_at,j.id LIMIT 1`)
    ).rows[0];
    if (!row) return false;
    try {
      const scope = await this.deliveryScope(row, true);
      await this.delivery.capture(
        scope,
        row.outputs.map((output) =>
          output.storageKey
            ? {
                kind: 'owned' as const,
                storageKey: output.storageKey,
                mediaType: output.mediaType,
              }
            : {
                kind: 'url' as const,
                url: output.url,
                mediaType: output.mediaType,
                expiresAt: output.expiresAt,
                refreshable: false,
              },
        ),
      );
    } catch {
      await this.pool.query(
        `UPDATE mr_jobs SET delivery_status='failed',delivery_errors='[{"index":0,"code":"legacy_output_unavailable"}]',updated_at=now()
        WHERE id=$1 AND workspace_id=$2 AND attempt_count=$3 AND status='succeeded'`,
        [row.id, row.workspace_id, row.attempt_count],
      );
    }
    return true;
  }
  /** A durable terminal-output checkpoint proves this same render completed.
   * Recover the lost result boundary once, with unknown cost still held. */
  private async reconcileCapturedCompletion(): Promise<boolean> {
    const row = (
      await this.pool
        .query<JobRow>(`SELECT j.* FROM mr_jobs j WHERE j.status IN ('submitting','submission-unknown','running') AND EXISTS(
      SELECT 1 FROM mr_output_receipts r WHERE r.job_id=j.id AND r.workspace_id=j.workspace_id AND r.attempt=j.attempt_count
      AND r.route_id=j.route_snapshot->>'id' AND r.deployment_id=j.deployment_snapshot->>'id' AND r.upstream_id IS NOT DISTINCT FROM j.upstream_id)
      ORDER BY j.created_at,j.id LIMIT 1`)
    ).rows[0];
    if (!row) return false;
    await this.applyProviderResult(
      row.workspace_id,
      row.id,
      { status: 'succeeded', billedCostMicros: null },
      undefined,
      this.resultAttempt(row),
    );
    return true;
  }

  async ensureWorkspace(workspaceId: string, openingBalanceMicros = 0): Promise<Balance> {
    micros(openingBalanceMicros);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId))
      throw new EngineError('invalid_workspace', 'Invalid workspace ID.');
    await this.transaction(async (client) => {
      const inserted = await client.query(
        'INSERT INTO mr_workspaces(id, available_micros) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING id',
        [workspaceId, openingBalanceMicros],
      );
      if (inserted.rowCount)
        await client.query(
          "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,'opening',$3,$3,0)",
          [randomUUID(), workspaceId, openingBalanceMicros],
        );
    });
    return this.getBalance(workspaceId);
  }

  async getBalance(workspaceId: string): Promise<Balance> {
    const { rows } = await this.pool.query(
      'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
      [workspaceId],
    );
    if (!rows[0]) throw new EngineError('workspace_not_found', 'Workspace not found.', 404);
    return {
      availableMicros: Number(rows[0].available_micros),
      reservedMicros: Number(rows[0].reserved_micros),
      currency: 'USD',
    };
  }

  private scopeAllowsPrepared(
    input: GenerateInput,
    route: ExecutionScopeJob['route_snapshot'],
    manifest: InputManifestEntry[] = [],
  ): boolean {
    if (!executionScopeAllows(this.executionScope, route, input)) return false;
    if (this.executionScope.profile === 'unrestricted' || input.operation !== 'image-to-video')
      return true;
    const frame = manifest[0];
    return Boolean(
      manifest.length === 1 &&
      frame?.path === 'firstFrame' &&
      frame.type === 'image' &&
      frame.assetKey === input.input.firstFrame?.assetKey &&
      frame.mediaType === 'image/png' &&
      frame.sha256 === this.executionScope.firstFrameSha256,
    );
  }

  private async scopeAllowsQueued(
    query: Pick<PoolClient, 'query'>,
    row: ExecutionScopeJob,
  ): Promise<boolean> {
    if (!executionScopeAllows(this.executionScope, row.route_snapshot, row.input)) return false;
    if (this.executionScope.profile === 'unrestricted' || row.input.operation !== 'image-to-video')
      return true;
    try {
      const prepared = await this.ownedAssets?.admittedInputForJob(
        row.workspace_id,
        {
          jobId: row.id,
          requestHash: row.request_hash,
          input: row.input,
        },
        query,
      );
      return Boolean(
        prepared && this.scopeAllowsPrepared(prepared.input, row.route_snapshot, prepared.manifest),
      );
    } catch (error) {
      if (error instanceof AssetError && error.code === 'legacy_input_conflict') return false;
      throw error;
    }
  }

  private async executionScopeQueuePage(afterId: string | null, workspaceId?: string) {
    return (
      await this.pool.query<ExecutionScopeJob>(
        `SELECT j.id,j.workspace_id,j.request_hash,(j.input #- '{input,prompt}')-'metadata' AS input,
       jsonb_build_object('id',j.route_snapshot->'id','modelId',j.route_snapshot->'modelId',
         'deploymentId',j.route_snapshot->'deploymentId') AS route_snapshot
       FROM mr_jobs j WHERE j.status='queued'
       AND ($1::uuid IS NULL OR j.id>$1::uuid) AND ($2::text IS NULL OR j.workspace_id=$2)
       ORDER BY j.id LIMIT 32`,
        [afterId, workspaceId ?? null],
      )
    ).rows;
  }

  /** Hot-path existence only: bounded transfers, shared predicate, and stop at the first conflict. */
  async hasExecutionScopeConflict(): Promise<boolean> {
    if (this.executionScope.profile === 'unrestricted') return false;
    let afterId: string | null = null;
    for (;;) {
      const rows = await this.executionScopeQueuePage(afterId);
      for (const row of rows) if (!(await this.scopeAllowsQueued(this.pool, row))) return true;
      if (rows.length < 32) return false;
      afterId = rows[rows.length - 1]!.id;
    }
  }

  /** Explicit private operator inventory. It never changes requests, deadlines, holds or attempts. */
  async executionScopeConflicts(workspaceId?: string) {
    const conflicts: {
      jobId: string;
      workspaceId: string;
      routeId: string;
      operation: GenerateInput['operation'];
    }[] = [];
    if (this.executionScope.profile === 'unrestricted') return conflicts;
    let afterId: string | null = null;
    for (;;) {
      const rows = await this.executionScopeQueuePage(afterId, workspaceId);
      for (const row of rows)
        if (!(await this.scopeAllowsQueued(this.pool, row)))
          conflicts.push({
            jobId: row.id,
            workspaceId: row.workspace_id,
            routeId: row.route_snapshot.id,
            operation: row.input.operation,
          });
      if (rows.length < 32) return conflicts;
      afterId = rows[rows.length - 1]!.id;
    }
  }

  private async assertExecutionScopeTransition(): Promise<void> {
    if (await this.hasExecutionScopeConflict())
      throw new EngineError(
        'execution_scope_transition_required',
        'Queued work is outside the selected qualification scope. The operator must review the transition; original jobs and holds are unchanged.',
        503,
      );
  }

  private async qualificationFrameMatches(
    workspaceId: string,
    input: GenerateInput,
    manifest?: InputManifestEntry[],
  ): Promise<boolean> {
    if (this.executionScope.profile === 'unrestricted' || input.operation !== 'image-to-video')
      return true;
    const key = input.input.firstFrame?.assetKey;
    const fingerprint = this.executionScope.firstFrameSha256;
    if (!key || !fingerprint || !this.ownedAssets || !this.storage) return false;
    try {
      const owned = manifest
        ? manifest.length === 1 && manifest[0]?.assetKey === key
          ? manifest[0]
          : undefined
        : await this.ownedAssets.requireReady(workspaceId, key, 'image');
      if (!owned) return false;
      if (owned.mediaType !== 'image/png' || owned.sha256 !== fingerprint) return false;
      // Read the already-owned immutable object. This is not an import, decoder or provider call.
      const frozen = await this.storage.readInput(workspaceId, key);
      return (
        frozen.mediaType === 'image/png' &&
        frozen.sha256 === fingerprint &&
        frozen.size === owned.byteLength
      );
    } catch {
      return false;
    }
  }

  /** Read-only configuration evidence; no provider request or reservation is made. */
  async workspaceReadiness(workspaceId: string) {
    const balance = await this.getBalance(workspaceId);
    const holds = await this.pool.query(
      'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
      [workspaceId],
    );
    const byok = new Set<string>();
    const ownConflicts =
      this.executionScope.profile === 'unrestricted'
        ? 0
        : (await this.executionScopeConflicts(workspaceId)).length;
    for (const deployment of this.executionScope.profile === 'unrestricted'
      ? this.catalog.deployments
      : []) {
      const adapters = await this.deploymentAdapters(workspaceId, deployment, 'byok');
      for (const id of this.getExecutableRouteIds(undefined, adapters))
        if (
          this.catalog.routes.some(
            (route) => route.id === id && route.deploymentId === deployment.id,
          )
        )
          byok.add(id);
    }
    return {
      balance,
      billingHold: Boolean(holds.rowCount),
      configuredRoutes: {
        managed: this.getExecutableRouteIds(),
        byok: [...byok],
      },
      ...(this.executionScope.profile === 'unrestricted'
        ? {}
        : {
            executionScope: {
              profile: this.executionScope.profile,
              queuedConflicts: ownConflicts,
              transitionBlocked: ownConflicts > 0 || (await this.hasExecutionScopeConflict()),
            },
          }),
    };
  }

  /** Lookup only: an uncertain client must never create a replacement paid submission. */
  async lookupJob(workspaceId: string, idempotencyKey: string): Promise<Job | null> {
    const { rows } = await this.pool.query(
      'SELECT id FROM mr_jobs WHERE workspace_id=$1 AND idempotency_key=$2',
      [workspaceId, idempotencyKey],
    );
    return rows[0] ? this.getJob(workspaceId, rows[0].id) : null;
  }

  /** Operator-only funding; a stable external reference cannot credit a workspace twice. */
  async creditWorkspace(
    workspaceId: string,
    amountMicros: number,
    reference: string,
  ): Promise<Balance> {
    await this.transaction((client) =>
      creditWorkspaceInTransaction(client, workspaceId, amountMicros, reference),
    );
    return this.getBalance(workspaceId);
  }

  private normalizeInput(input: GenerateInput): GenerateInput {
    // Custom catalogs supply their own quote/validation contract, including synthetic test models.
    if (this.customQuote) return input;
    try {
      return parseGenerationRequest(input);
    } catch (error) {
      throw new EngineError(
        'invalid_generation_input',
        error instanceof Error ? error.message : 'Invalid canonical generation input.',
        422,
      );
    }
  }

  getExecutableRouteIds(
    input?: GenerateInput,
    adapters = this.adapters,
    previousUpstreamId?: string,
  ): string[] {
    return this.configuredRouteIds(input, adapters, previousUpstreamId);
  }

  private configuredRouteIds(
    input?: GenerateInput,
    adapters = this.adapters,
    previousUpstreamId?: string,
    scopeInput = input,
    firstFrameVerified = false,
  ): string[] {
    if (!this.providerExecutionEnabled) return [];
    if (!this.injectedAdapters && !/^[a-f0-9]{64}$/i.test(this.vaultKey ?? '')) return [];
    if (scopeInput && this.executionScope.profile !== 'unrestricted')
      scopeInput = this.normalizeInput(scopeInput);
    return this.catalog.routes
      .filter((route) => {
        if (
          !executionScopeAllows(this.executionScope, route, scopeInput) ||
          (this.executionScope.profile !== 'unrestricted' &&
            scopeInput?.operation === 'image-to-video' &&
            !firstFrameVerified)
        )
          return false;
        if (!route.adapter || route.status === 'retired') return false;
        if (
          input &&
          (route.modelId !== input.modelId || !route.operations.includes(input.operation))
        )
          return false;
        const deployment = this.catalog.deployments.find(
          (value) => value.id === route.deploymentId,
        );
        const adapter = adapters.find((value) => value.id === route.adapter);
        return (
          deployment &&
          adapter &&
          adapter.isConfigured(route, deployment) &&
          (!input ||
            ((!adapter.supportedOperations ||
              adapter.supportedOperations.includes(input.operation)) &&
              (!adapter.preflight ||
                adapter.preflight({
                  input,
                  route,
                  deployment,
                  previousUpstreamId,
                }) === null)))
        );
      })
      .map((route) => route.id);
  }

  private async deploymentAdapters(
    workspaceId: string,
    deployment: Deployment,
    billing: GenerateInput['billing'],
  ): Promise<ProviderAdapter[]> {
    if (!this.providerExecutionEnabled) return [];
    if (billing !== 'byok') return this.adapters;
    const connection = await this.accounts.getConnection(workspaceId, deployment.id);
    if (!connection) return [];
    const env = { ...process.env };
    if (deployment.credentialEnv) env[deployment.credentialEnv] = connection.apiKey;
    if (deployment.providerId === 'alibaba') {
      const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
      env[`${prefix}_API_KEY`] = connection.apiKey;
      env[`${prefix}_WORKSPACE_ID`] = connection.workspaceId;
    }
    return createDefaultAdapters({
      env,
      captureOutputs: this.captureProviderOutputs,
      storeOutput: this.storage ? (input) => this.storage!.putOutput(input) : undefined,
    });
  }

  async executableForWorkspace(
    workspaceId: string,
    input: GenerateInput,
    scopeInput = input,
  ): Promise<string[]> {
    if (!this.providerExecutionEnabled) return [];
    if (
      this.executionScope.profile !== 'unrestricted' &&
      !this.catalog.routes.some((route) =>
        executionScopeAllows(this.executionScope, route, this.normalizeInput(scopeInput)),
      )
    )
      return [];
    const firstFrameVerified = await this.qualificationFrameMatches(workspaceId, scopeInput);
    const previousUpstreamId = input.previousJobId
      ? ((await this.internalJob(workspaceId, input.previousJobId))?.upstreamId ?? undefined)
      : undefined;
    const ids = new Set(
      input.billing === 'byok'
        ? []
        : this.configuredRouteIds(
            input,
            this.adapters,
            previousUpstreamId,
            scopeInput,
            firstFrameVerified,
          ),
    );
    if (input.billing !== 'byok') return [...ids];
    const deployments = this.catalog.deployments.filter((deployment) =>
      this.catalog.routes.some(
        (route) => route.modelId === input.modelId && route.deploymentId === deployment.id,
      ),
    );
    for (const deployment of deployments) {
      const adapters = await this.deploymentAdapters(workspaceId, deployment, input.billing);
      for (const id of this.configuredRouteIds(
        input,
        adapters,
        previousUpstreamId,
        scopeInput,
        firstFrameVerified,
      )) {
        if (
          this.catalog.routes.some(
            (route) => route.id === id && route.deploymentId === deployment.id,
          )
        )
          ids.add(id);
      }
    }
    return [...ids];
  }

  async resolveInput(
    workspaceId: string,
    input: GenerateInput,
    options: { forDispatch?: boolean; jobId?: string } = {},
  ): Promise<GenerateInput> {
    if (options.forDispatch) this.assertProviderExecutionEnabled();
    if (
      options.forDispatch &&
      this.executionScope.profile !== 'unrestricted' &&
      !this.catalog.routes.some((route) => executionScopeAllows(this.executionScope, route, input))
    )
      throw new EngineError('execution_scope_denied', executionScopeReason, 422);
    if (options.forDispatch && options.jobId && this.ownedAssets) {
      const prepared = await this.ownedAssets.preparedInputForJob(
        workspaceId,
        options.jobId,
        input,
        { allowLegacyCutover: this.executionScope.profile === 'unrestricted' },
      );
      if (
        !this.catalog.routes.some((route) =>
          this.scopeAllowsPrepared(prepared.input, route, prepared.manifest),
        ) ||
        !(await this.qualificationFrameMatches(workspaceId, prepared.input, prepared.manifest))
      )
        throw new EngineError('execution_scope_denied', executionScopeReason, 422);
      input = prepared.input;
    } else if (options.forDispatch && !(await this.qualificationFrameMatches(workspaceId, input))) {
      throw new EngineError('execution_scope_denied', executionScopeReason, 422);
    }
    input = this.normalizeInput(input);
    if (input.previousJobId) {
      const previous = await this.internalJob(workspaceId, input.previousJobId);
      if (!previous || previous.status !== 'succeeded' || !previous.upstreamId)
        throw new EngineError(
          'invalid_continuation',
          'Continuation requires a completed generation in this workspace with a provider interaction ID.',
        );
      if (
        input.modelId !== 'google/gemini-omni-1.1-flash' ||
        previous.input.modelId !== input.modelId
      )
        throw new EngineError(
          'invalid_continuation',
          'This model does not support an owned Omni continuation.',
        );
      if (input.routeId && input.routeId !== previous.routeId)
        throw new EngineError(
          'continuation_route_mismatch',
          'Continue on the original deployment; cross-provider continuation is not supported.',
        );
      input = { ...input, routeId: previous.routeId };
    }
    const args = await mapGenerationAssets(input.input, async (asset, role) => {
      if ('url' in asset && asset.url) {
        if (!isPublicHttpsAssetUrl(asset.url))
          throw new EngineError(
            'invalid_asset_url',
            'Media requires public HTTPS URLs without embedded credentials.',
          );
        return { url: asset.url };
      }
      if (!('assetKey' in asset) || !asset.assetKey)
        throw new EngineError(
          'invalid_asset',
          'Media requires one owned asset key or a public HTTPS URL.',
        );
      if (!this.storage)
        throw new EngineError(
          'storage_not_configured',
          'Private reference storage is not configured.',
          503,
        );
      if (options.forDispatch && options.jobId && this.ownedAssets) {
        const signed = await this.ownedAssets.signForJob(
          workspaceId,
          options.jobId,
          asset.assetKey,
        );
        if (!isPublicHttpsAssetUrl(signed.url))
          throw new EngineError(
            'invalid_asset_url',
            'Private storage must provide a public HTTPS provider read URL.',
            503,
          );
        return { url: signed.url };
      }
      const ready = await this.ownedAssets?.requireReady(workspaceId, asset.assetKey, role.type);
      const owned = ready
        ? { mediaType: ready.mediaType! }
        : await this.storage.inspectUpload(workspaceId, asset.assetKey);
      const matches =
        role.type === 'document'
          ? owned.mediaType.startsWith('application/') || owned.mediaType.startsWith('text/')
          : owned.mediaType.startsWith(`${role.type}/`);
      if (!matches)
        throw new EngineError(
          'invalid_reference_type',
          `The owned asset at input.${role.path} does not match its ${role.type} role.`,
        );
      // Quote preflight receives a public-shaped URL, never a credential-bearing read signature.
      if (!options.forDispatch)
        return {
          url: `https://assets.opengen.dev/owned/${encodeURIComponent(asset.assetKey)}`,
        };
      const signed = await this.storage.sign(asset.assetKey, owned.mediaType, 3600);
      if (!isPublicHttpsAssetUrl(signed.url))
        throw new EngineError(
          'invalid_asset_url',
          'Private storage must provide a public HTTPS provider read URL.',
          503,
        );
      return { url: signed.url };
    });
    return { ...input, input: args };
  }

  private generationQuote(
    input: GenerateInput,
    options: { executableRouteIds: string[]; metrics?: RouteMetrics[]; scopeInput?: GenerateInput },
  ) {
    const scopeInput =
      this.executionScope.profile === 'unrestricted'
        ? input
        : this.normalizeInput(options.scopeInput ?? input);
    const ids =
      this.executionScope.profile === 'unrestricted'
        ? options.executableRouteIds
        : options.executableRouteIds.filter((id) => {
            const route = this.catalog.routes.find((route) => route.id === id);
            return route && executionScopeAllows(this.executionScope, route, scopeInput);
          });
    const result = quoteWithGenerationFee(
      input,
      { ...options, executableRouteIds: ids },
      (request, quoteOptions) =>
        this.quoteRequest(request, {
          ...quoteOptions,
          executableRouteIds: quoteOptions?.executableRouteIds ?? [],
        }),
      this.fixtureBillingPolicy,
    );
    if (this.executionScope.profile !== 'unrestricted') {
      result.quote.candidates = result.quote.candidates.map((candidate) => {
        const route = this.catalog.routes.find((route) => route.id === candidate.routeId);
        return route && executionScopeAllows(this.executionScope, route, scopeInput)
          ? candidate
          : { ...candidate, executable: false, reason: executionScopeReason };
      });
      if (
        !result.quote.candidates.some(
          (candidate) => candidate.routeId === result.quote.selectedRouteId && candidate.executable,
        )
      ) {
        result.quote.selectedRouteId = null;
        result.quote.reservationMicros = null;
      }
      result.quote.notices = [...result.quote.notices, executionScopeNotice];
    }
    return result;
  }

  quoteGeneration(
    input: GenerateInput,
    options: {
      executableRouteIds?: string[];
      metrics?: RouteMetrics[];
      scopeInput?: GenerateInput;
    } = {},
  ): Quote {
    return this.generationQuote(input, {
      ...options,
      executableRouteIds: options.executableRouteIds ?? [],
    }).quote;
  }

  async submit(options: Submission): Promise<Job> {
    const { workspaceId, idempotencyKey } = options;
    this.assertSubmissionAuthority(options);
    const identity = this.submissionIdentity(options.input);
    // A replay returns the accepted job even if credentials or uploads were subsequently removed.
    const accepted = (
      await this.pool.query<JobRow>(
        'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND idempotency_key=$2',
        [workspaceId, idempotencyKey],
      )
    ).rows[0];
    if (accepted) {
      if (accepted.request_hash !== identity.hash)
        throw new EngineError(
          'idempotency_conflict',
          'This idempotency key already belongs to a different request.',
          409,
        );
      return this.withFreshAssets(job(accepted));
    }
    this.assertProviderExecutionEnabled();
    const prepared = await this.prepareSubmission(options, identity);
    const result = await this.transaction((client) => this.admitSubmission(client, prepared));
    return this.withFreshAssets(result);
  }

  private assertSubmissionAuthority(options: Submission): void {
    const { workspaceId, idempotencyKey, principal } = options;
    if (principal && principal.workspaceId !== workspaceId)
      throw new EngineError(
        'policy_denied',
        'The authenticated workspace does not match admission.',
        403,
      );
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new EngineError(
        'idempotency_required',
        'Provide an Idempotency-Key of 1–200 characters.',
      );
  }

  private submissionIdentity(request: GenerateInput) {
    const metadata = parseGenerationMetadata(request.metadata);
    const { metadata: _metadata, ...input } = request;
    const hash = requestHash({
      ...input,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
    return { input, metadata, hash };
  }

  private async prepareSubmission(
    options: Submission,
    { input, metadata, hash } = this.submissionIdentity(options.input),
  ) {
    this.assertProviderExecutionEnabled();
    const { workspaceId, idempotencyKey } = options;
    if (input.feeAcceptance && !this.fixtureBillingPolicy)
      throw new EngineError(
        'fee_policy_unavailable',
        'The accepted fee policy is unavailable.',
        503,
      );
    if (
      input.feeAcceptance &&
      (input.feeAcceptance.policyId !== this.fixtureBillingPolicy?.id ||
        input.feeAcceptance.policyVersion !== this.fixtureBillingPolicy?.version)
    )
      throw new EngineError(
        'fee_policy_mismatch',
        'Review the current fee policy before submitting.',
        409,
      );
    if (input.feeAcceptance && input.billing === 'byok')
      throw new EngineError(
        'fee_managed_only',
        'The fee fixture supports managed generation only.',
        422,
      );
    if (!this.storage)
      throw new EngineError(
        'storage_not_configured',
        'Private output storage must be configured before generation.',
        503,
      );
    // Fast refusal avoids unneeded imports; the same hold is rechecked under the reserve lock.
    if (
      (
        await this.pool.query(
          'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
          [workspaceId],
        )
      ).rowCount
    )
      throw new EngineError('billing_hold', 'Billing needs review before new generation.', 409);
    if (
      (!this.injectedAdapters || input.billing === 'byok') &&
      !/^[a-f0-9]{64}$/i.test(this.vaultKey ?? '')
    )
      throw new EngineError(
        'vault_not_configured',
        'Encrypted original provider credentials must be configured before generation.',
        503,
      );
    const canonical = this.normalizeInput(input);
    if (canonical.queueStartDeadlineAt)
      canonical.queueStartDeadlineAt = new Date(canonical.queueStartDeadlineAt).toISOString();
    const initial = options.principal
      ? constrainGovernedInput(this.catalog, options.principal.policy, canonical)
      : canonical;
    if (this.executionScope.profile !== 'unrestricted') {
      if (
        !this.catalog.routes.some((route) =>
          executionScopeAllows(this.executionScope, route, initial),
        ) ||
        !(await this.qualificationFrameMatches(workspaceId, initial))
      )
        throw new EngineError('execution_scope_denied', executionScopeReason, 422);
      await this.assertExecutionScopeTransition();
    }
    // Cheap capability rejection precedes input network work. Owned references
    // use a non-secret placeholder here; readiness is checked by preparation.
    const preflightInput = {
      ...initial,
      input: await mapGenerationAssets(initial.input, async (asset) =>
        'assetKey' in asset
          ? {
              url: `https://assets.opengen.dev/owned/${encodeURIComponent(asset.assetKey!)}`,
            }
          : asset,
      ),
    };
    const preliminaryRoutes = await this.executableForWorkspace(
      workspaceId,
      preflightInput,
      initial,
    );
    if (
      !preliminaryRoutes.length ||
      (initial.routeId && !preliminaryRoutes.includes(initial.routeId))
    )
      throw new EngineError(
        'no_executable_route',
        'No configured, compatible route can execute this request.',
        422,
      );
    const frozenPreparation = await this.ownedAssets!.prepare({
      workspaceId,
      idempotencyKey,
      input: canonical,
      requestHash: hash,
    });
    const prepared = await this.resolveInput(workspaceId, {
      ...frozenPreparation.input,
      routing: initial.routing,
    });
    const executableRouteIds = await this.executableForWorkspace(
      workspaceId,
      prepared,
      frozenPreparation.input,
    );
    const metrics =
      prepared.routing?.preference && prepared.routing.preference !== 'cost'
        ? await this.routeMetrics(prepared)
        : undefined;
    return {
      options,
      input,
      metadata,
      hash,
      frozenPreparation,
      prepared,
      executableRouteIds,
      metrics,
    };
  }

  private async admitSubmission(
    client: PoolClient,
    preparation: Awaited<ReturnType<Engine['prepareSubmission']>>,
    comparisonRouteId?: string,
  ): Promise<Job> {
    this.assertProviderExecutionEnabled();
    const { options, input, metadata, hash, frozenPreparation, executableRouteIds, metrics } =
      preparation;
    const { workspaceId, idempotencyKey } = options;
    let { prepared } = preparation;
    // Serialize reservation admission per workspace, including idempotent concurrent submissions.
    const balance = await client.query('SELECT * FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
      workspaceId,
    ]);
    if (!balance.rows[0]) throw new EngineError('workspace_not_found', 'Workspace not found.', 404);
    const previous = await client.query<JobRow>(
      'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND idempotency_key=$2',
      [workspaceId, idempotencyKey],
    );
    if (previous.rows[0]) {
      if (comparisonRouteId)
        throw new EngineError(
          'idempotency_conflict',
          'A comparison child key already exists.',
          409,
        );
      if (previous.rows[0].request_hash !== hash)
        throw new EngineError(
          'idempotency_conflict',
          'This idempotency key already belongs to a different request.',
          409,
        );
      return job(previous.rows[0]);
    }
    // Preparation can involve storage I/O. Recheck live source/member/grant,
    // rotation version and narrowed policy under the authoritative reserve lock.
    const current = options.principal
      ? await revalidateGovernanceAuthority(client, options.principal)
      : undefined;
    const effectivePolicy = constrainRoutingPolicy(current?.policy, input.routing);
    prepared = {
      ...prepared,
      routing: materializeRoutingPolicy(this.catalog, effectivePolicy, prepared.modelId),
    };
    if (current?.maxCostMicros !== undefined)
      prepared = {
        ...prepared,
        maxCostMicros: Math.min(prepared.maxCostMicros ?? Infinity, current.maxCostMicros),
      };
    const storedInput: GenerateInput = {
      ...frozenPreparation.input,
      routing: prepared.routing,
      ...(prepared.maxCostMicros === undefined ? {} : { maxCostMicros: prepared.maxCostMicros }),
      ...(prepared.routeId ? { routeId: prepared.routeId } : {}),
    };
    if (
      !this.catalog.routes.some((route) =>
        this.scopeAllowsPrepared(storedInput, route, frozenPreparation.manifest),
      )
    )
      throw new EngineError('execution_scope_denied', executionScopeReason, 422);
    await this.assertLegacyCapacityReconciled(client);
    const hold = await client.query(
      'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
      [workspaceId],
    );
    if (hold.rowCount)
      throw new EngineError('billing_hold', 'Billing needs review before new generation.', 409);
    const { quote, snapshot } = this.generationQuote(prepared, {
      executableRouteIds,
      metrics,
      scopeInput: storedInput,
    });
    const candidate = quote.candidates.find(
      (value) =>
        value.routeId === quote.selectedRouteId && value.executable && value.reason === null,
    );
    if (
      !candidate ||
      (candidate.estimatedCostMicros === null && input.billing !== 'byok') ||
      !executableRouteIds.includes(candidate.routeId) ||
      (comparisonRouteId !== undefined && candidate.routeId !== comparisonRouteId)
    ) {
      throw new EngineError(
        'no_executable_route',
        'No configured, compatible route with supported pricing can execute this request.',
        422,
      );
    }
    const selectedCandidates = [
      candidate,
      ...(prepared.routing?.fallback
        ? quote.candidates
            .filter(
              (value) =>
                value.routeId !== candidate.routeId && value.executable && value.reason === null,
            )
            .slice(0, 3)
        : []),
    ];
    const amount = snapshot
      ? micros(
          Math.max(
            ...selectedCandidates.map((value) => {
              const gross = value.billing?.customerEstimateMicros;
              if (gross === null || gross === undefined)
                throw new EngineError(
                  'invalid_fee_quote',
                  'A selected route lacks a gross estimate.',
                  409,
                );
              return gross;
            }),
          ),
        )
      : input.billing === 'byok'
        ? 0
        : micros(Math.max(...selectedCandidates.map((value) => value.estimatedCostMicros!)));
    if (snapshot && quote.reservationMicros !== amount)
      throw new EngineError('invalid_fee_quote', 'The gross quote and reservation differ.', 409);
    const feeAdmission: GenerationFeeAdmission | null = snapshot
      ? { schemaVersion: 1, snapshot, customerCeilingMicros: amount }
      : null;
    if (prepared.maxCostMicros !== undefined && amount > micros(prepared.maxCostMicros))
      throw new EngineError(
        'budget_exceeded',
        'The route quote exceeds this request’s spending ceiling.',
        402,
      );
    if (Number(balance.rows[0].available_micros) < amount)
      throw new EngineError(
        'insufficient_balance',
        'The workspace has insufficient available credit.',
        402,
      );
    const route = this.catalog.routes.find((value) => value.id === candidate.routeId);
    const deployment = this.catalog.deployments.find((value) => value.id === route?.deploymentId);
    if (!route || !deployment)
      throw new EngineError(
        'invalid_catalog',
        'The selected route does not resolve to a deployment.',
        500,
      );
    const fallbackRoutes = selectedCandidates.map((candidate) => {
      const route = this.catalog.routes.find((value) => value.id === candidate.routeId)!;
      return {
        route,
        deployment: this.catalog.deployments.find((value) => value.id === route.deploymentId)!,
      };
    });
    assertGovernedRoutes(
      this.catalog,
      effectivePolicy,
      prepared.modelId,
      selectedCandidates.map((value) => value.routeId),
    );
    const id = randomUUID();
    if (
      storedInput.queueStartDeadlineAt &&
      Date.parse(storedInput.queueStartDeadlineAt) <= Date.now()
    )
      throw new EngineError(
        'start_deadline_exceeded',
        'The local queue-start deadline has expired.',
        422,
      );
    const dispatches = await this.configureDispatchPools(
      client,
      workspaceId,
      fallbackRoutes,
      input.billing,
    );
    const inserted = await client.query<JobRow>(
      `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,delivery_status,reserved_micros,fallback_routes,attribution,metadata,effective_policy,queue_start_deadline_at,execution_progress,fee_admission)
       VALUES($1,$2,$3,$4,$5,$6,$7,'queued','pending',$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id,
        workspaceId,
        idempotencyKey,
        hash,
        JSON.stringify(storedInput),
        JSON.stringify(route),
        JSON.stringify(deployment),
        amount,
        JSON.stringify(fallbackRoutes),
        JSON.stringify(attributionForPrincipal(current)),
        JSON.stringify(metadata),
        JSON.stringify(effectivePolicy),
        storedInput.queueStartDeadlineAt ?? null,
        JSON.stringify({
          phase: 'queued',
          percent: null,
          source: 'gateway',
          observedAt: new Date().toISOString(),
        }),
        feeAdmission ? JSON.stringify(feeAdmission) : null,
      ],
    );
    for (const { deployment: frozenDeployment } of fallbackRoutes)
      await this.attemptCredentials.freezeAdmission(client, {
        workspaceId,
        jobId: id,
        attempt: 0,
        deployment: frozenDeployment,
        billing: input.billing,
      });
    await enqueueDispatchInTransaction(client, {
      ...dispatches[0]!,
      jobId: id,
      attemptNumber: 1,
      startDeadlineAt: storedInput.queueStartDeadlineAt ?? null,
    });
    await this.ownedAssets!.finalizeInTransaction(
      client,
      workspaceId,
      frozenPreparation.id,
      id,
      hash,
    );
    await new KeyBudgetStore().reserveInTransaction(client, {
      workspaceId,
      jobId: id,
      keyId: current?.keyKind === 'browser' ? null : (current?.keyId ?? null),
      billing: input.billing ?? 'managed',
      reservedMicros: amount,
    });
    await client.query(
      'UPDATE mr_workspaces SET available_micros=available_micros-$2,reserved_micros=reserved_micros+$2 WHERE id=$1',
      [workspaceId, amount],
    );
    await client.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
       VALUES($1,$2,$3,'reserve',$4::bigint,-($4::bigint),$4::bigint)`,
      [randomUUID(), workspaceId, id, amount],
    );
    return job(inserted.rows[0]!);
  }

  async quoteComparison(
    principal: Principal,
    prompt: string,
    routeIds: [string, string],
  ): Promise<ComparisonRun> {
    this.assertProviderExecutionEnabled();
    const [first, second] = routeIds.map((id) =>
      this.catalog.routes.find((route) => route.id === id && route.status !== 'retired'),
    );
    if (
      !first ||
      !second ||
      first.modelId === second.modelId ||
      ![first, second].every((route) => route.operations.includes('text-to-image'))
    )
      throw new EngineError(
        'incompatible_comparison',
        'Choose two different exact models with text-to-image routes.',
        422,
      );
    const childQuote = async (route: Route): Promise<ComparisonChildQuote> => {
      const input = this.normalizeInput({
        modelId: route.modelId,
        operation: 'text-to-image',
        billing: 'managed',
        routeId: route.id,
        routing: { fallback: false },
        input: { prompt, count: 1 },
      });
      const constrained = constrainGovernedInput(this.catalog, principal.policy, input);
      if (principal.maxCostMicros !== undefined)
        constrained.maxCostMicros = principal.maxCostMicros;
      const executableRouteIds = await this.executableForWorkspace(
        principal.workspaceId,
        constrained,
      );
      const metrics =
        constrained.routing?.preference && constrained.routing.preference !== 'cost'
          ? await this.routeMetrics(constrained)
          : undefined;
      const quote = this.quoteRequest(constrained, { executableRouteIds, metrics });
      const candidate = quote.candidates.find((entry) => entry.routeId === route.id);
      if (
        quote.selectedRouteId !== route.id ||
        !candidate?.executable ||
        candidate.reason !== null ||
        candidate.estimatedCostMicros === null ||
        quote.reservationMicros == null
      )
        throw new EngineError(
          'comparison_route_unavailable',
          `${route.id} · ${candidate?.reason ?? 'No executable managed quote for this request.'}`,
          422,
        );
      const ceilingMicros = micros(quote.reservationMicros);
      return {
        input: { ...input, maxCostMicros: ceilingMicros },
        providerId: candidate.providerId,
        endpointRegion: candidate.endpointRegion,
        estimatedMicros: micros(candidate.estimatedCostMicros),
        ceilingMicros,
        notices: candidate.notices,
      };
    };
    const children = await Promise.all([childQuote(first), childQuote(second)]);
    const quote: ComparisonQuote = {
      children,
      estimatedMicros: micros(children[0].estimatedMicros + children[1].estimatedMicros),
      ceilingMicros: micros(children[0].ceilingMicros + children[1].ceilingMicros),
    };
    const { rows } = await this.pool.query<ComparisonRow>(
      `INSERT INTO mr_comparison_runs(workspace_id,id,quote,child_key_nonce,expires_at)
       VALUES($1,$2,$3,$4,clock_timestamp()+($5::integer * interval '1 second')) RETURNING *`,
      [
        principal.workspaceId,
        randomUUID(),
        JSON.stringify(quote),
        randomUUID(),
        comparisonQuoteLifetimeSeconds,
      ],
    );
    return this.projectComparison(principal.workspaceId, rows[0]!);
  }

  async submitComparison(principal: Principal, id: string): Promise<ComparisonRun> {
    validateId(id);
    const { workspaceId } = principal;
    const comparison = await this.comparisonRow(workspaceId, id);
    if (!comparison) throw new EngineError('not_found', 'Comparison not found.', 404);
    if (comparison.admitted_at) return this.projectComparison(workspaceId, comparison);
    this.assertProviderExecutionEnabled();
    if (comparison.expires_at.getTime() <= Date.now())
      throw new EngineError('comparison_quote_expired', 'Get a new comparison quote.', 409);

    // The persisted quote fixes the shared prompt, exact routes and both ceilings.
    // Text-only preparations perform no external input imports. Each is replayable.
    const prepare = (child: ComparisonChildQuote, position: number) =>
      this.prepareSubmission({
        workspaceId,
        idempotencyKey: `comparison:${comparison.child_key_nonce}:${position}`,
        input: child.input,
        principal,
      });
    const [firstQuote, secondQuote] = comparison.quote.children;
    let first: Awaited<ReturnType<Engine['prepareSubmission']>>;
    let second: Awaited<ReturnType<Engine['prepareSubmission']>>;
    try {
      first = await prepare(firstQuote, 1);
      second = await prepare(secondQuote, 2);
    } catch (error) {
      const accepted = await this.comparisonRow(workspaceId, id);
      if (accepted?.admitted_at) return this.projectComparison(workspaceId, accepted);
      throw error;
    }
    const accepted = await this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const { rows } = await client.query<ComparisonRow & { expired: boolean }>(
        `SELECT *,expires_at<=clock_timestamp() AS expired FROM mr_comparison_runs
         WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
        [workspaceId, id],
      );
      const current = rows[0];
      if (!current || (current.expired && !current.admitted_at))
        throw new EngineError('comparison_quote_expired', 'Get a new comparison quote.', 409);
      if (current.admitted_at) return current;
      // Both children retain their supply locks until this transaction commits.
      // Acquire their union in the usual stable order before either admission.
      const routes = current.quote.children.map(({ input }) => {
        const route = this.catalog.routes.find((value) => value.id === input.routeId);
        const deployment = this.catalog.deployments.find(
          (value) => value.id === route?.deploymentId,
        );
        if (!route || !deployment)
          throw new EngineError('invalid_catalog', 'A comparison route is unavailable.', 500);
        return { route, deployment };
      });
      await this.configureDispatchPools(client, workspaceId, routes, 'managed');
      const firstJob = await this.admitSubmission(client, first, firstQuote.input.routeId!);
      const secondJob = await this.admitSubmission(client, second, secondQuote.input.routeId!);
      const updated = await client.query<ComparisonRow>(
        `UPDATE mr_comparison_runs SET admitted_at=clock_timestamp(),first_job_id=$3,second_job_id=$4
         WHERE workspace_id=$1 AND id=$2 RETURNING *`,
        [workspaceId, id, firstJob.id, secondJob.id],
      );
      return updated.rows[0]!;
    });
    return this.projectComparison(workspaceId, accepted);
  }

  private async comparisonRow(workspaceId: string, id: string): Promise<ComparisonRow | undefined> {
    const { rows } = await this.pool.query<ComparisonRow>(
      'SELECT * FROM mr_comparison_runs WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return rows[0];
  }

  private async projectComparison(workspaceId: string, row: ComparisonRow): Promise<ComparisonRun> {
    const projectChild = async (id: string): Promise<ComparisonJob | null> => {
      const child = await this.privateJobRow(workspaceId, id);
      if (!child) return null;
      const value = await this.withFreshAssets(job(child));
      const timing = normalizeJobTimings(child.execution_timings)?.execution;
      return {
        ...value,
        executionTiming: timing ? { durationMs: timing.durationMs, source: timing.source } : null,
      };
    };
    const jobs: (ComparisonJob | null)[] =
      row.first_job_id && row.second_job_id
        ? await Promise.all([projectChild(row.first_job_id), projectChild(row.second_job_id)])
        : [];
    return {
      ...row.quote,
      id: row.id,
      expiresAt: row.expires_at.toISOString(),
      admittedAt: row.admitted_at?.toISOString() ?? null,
      jobs: jobs.filter((entry): entry is ComparisonJob => entry !== null),
    };
  }

  async getComparison(workspaceId: string, id: string): Promise<ComparisonRun | null> {
    validateId(id);
    const row = await this.comparisonRow(workspaceId, id);
    return row && (row.admitted_at || row.expires_at.getTime() > Date.now())
      ? this.projectComparison(workspaceId, row)
      : null;
  }

  async listComparisons(workspaceId: string): Promise<ComparisonSummary[]> {
    const { rows } = await this.pool.query<{
      id: string;
      admitted_at: Date;
      first_route: string;
      second_route: string;
    }>(
      `SELECT id,admitted_at,quote#>>'{children,0,input,routeId}' AS first_route,
         quote#>>'{children,1,input,routeId}' AS second_route
       FROM mr_comparison_runs WHERE workspace_id=$1 AND admitted_at IS NOT NULL
       ORDER BY admitted_at DESC,id DESC LIMIT 20`,
      [workspaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      admittedAt: row.admitted_at.toISOString(),
      routeIds: [row.first_route, row.second_route],
    }));
  }

  private async expireComparisonQuotes(): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM mr_comparison_runs
       WHERE admitted_at IS NULL AND (workspace_id,id) IN (
         SELECT workspace_id,id FROM mr_comparison_runs
         WHERE admitted_at IS NULL AND expires_at<=clock_timestamp()
         ORDER BY expires_at LIMIT 20
       )`,
    );
    return Boolean(rowCount);
  }

  async getJob(workspaceId: string, id: string): Promise<Job | null> {
    validateId(id);
    const { rows } = await this.pool.query<JobRow>(
      'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
      [workspaceId, id],
    );
    return rows[0] ? this.withFreshAssets(job(rows[0])) : null;
  }

  /** Installation operator transport only; customer reads never include provider task IDs. */
  async inspectJob(workspaceId: string, id: string): Promise<Job | null> {
    validateId(id);
    const row = await this.privateJobRow(workspaceId, id);
    return row ? { ...(await this.withFreshAssets(job(row))), upstreamId: row.upstream_id } : null;
  }

  private async withFreshAssets(value: Job): Promise<Job> {
    return projectCustomerJob(value.workspaceId, value, this.storage);
  }

  async listJobs(workspaceId: string): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      'SELECT * FROM mr_jobs WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',
      [workspaceId],
    );
    return Promise.all(rows.map((row) => this.withFreshAssets(job(row))));
  }

  async ledger(
    workspaceId: string,
    options: { after?: string; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const limit = options.limit ?? 100;
    if (options.after) validateId(options.after);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new EngineError('invalid_limit', 'Ledger page size must be 1–1000.');
    const { rows } = await this.pool.query(
      `SELECT id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,details,created_at FROM mr_ledger
      WHERE workspace_id=$1 AND ($2::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM mr_ledger WHERE id=$2 AND workspace_id=$1))
      ORDER BY created_at DESC,id DESC LIMIT $3`,
      [workspaceId, options.after ?? null, limit],
    );
    return rows;
  }

  async reconcile(
    workspaceId: string,
    id: string,
    input: Reconciliation,
    authority?: { operatorId: string },
  ): Promise<Job> {
    const existing = await this.internalJob(workspaceId, id);
    if (!existing) throw new EngineError('not_found', 'Generation not found.', 404);
    const prior = (
      await this.pool.query(
        'SELECT request_hash FROM mr_reconciliations WHERE workspace_id=$1 AND job_id=$2 AND reference=$3',
        [workspaceId, id, input.reference],
      )
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== createHash('sha256').update(stableJson(input)).digest('hex'))
        throw new EngineError(
          'reconciliation_conflict',
          'This reference already records different evidence or cost.',
          409,
        );
      return existing;
    }
    let result: ProviderResult;
    if (input.action === 'resume') {
      if (!['submission-unknown', 'submitting'].includes(existing.status))
        throw new EngineError(
          'invalid_transition',
          'Only an unresolved submission can be resumed by evidence.',
          409,
        );
      if (!input.upstreamId || (existing.upstreamId && existing.upstreamId !== input.upstreamId))
        throw new EngineError(
          'invalid_upstream_id',
          'Resume requires the original provider task ID.',
        );
      result = { status: 'running' };
    } else if (input.action === 'reject') {
      if (existing.upstreamId || existing.status !== 'submission-unknown')
        throw new EngineError(
          'invalid_transition',
          'Only unconfirmed acceptance can be rejected by evidence.',
          409,
        );
      result = {
        status: 'failed',
        failureCategory: 'invalid',
        billedCostMicros: 0,
        error: 'The installation operator confirmed that the upstream request was not accepted.',
      };
    } else {
      if (!terminal.has(existing.status) || input.billedCostMicros === undefined)
        throw new EngineError(
          'invalid_settlement',
          'Reconciliation requires a completed job and evidenced provider cost.',
        );
      micros(input.billedCostMicros);
      result = {
        status: existing.status as 'succeeded' | 'failed' | 'cancelled',
        billedCostMicros: input.billedCostMicros,
      };
    }
    return this.applyProviderResult(
      workspaceId,
      id,
      result,
      input,
      {
        attemptCount: existing.attemptCount,
        routeId: existing.routeId,
        deploymentId: existing.deploymentId,
        upstreamId: existing.upstreamId,
      },
      authority,
    );
  }

  async reconciliations(workspaceId: string, id: string) {
    validateId(id);
    return (
      await this.pool.query(
        'SELECT reference,action,note,evidence_url,created_at FROM mr_reconciliations WHERE workspace_id=$1 AND job_id=$2 ORDER BY created_at DESC',
        [workspaceId, id],
      )
    ).rows;
  }

  async cancel(workspaceId: string, id: string): Promise<Job> {
    validateId(id);
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const { rows } = await client.query<JobRow>(
        'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      const row = rows[0];
      if (!row) throw new EngineError('not_found', 'Generation not found.', 404);
      if (terminal.has(row.status)) return job(row);
      if (row.status !== 'queued')
        throw new EngineError(
          'cancellation_unconfirmed',
          'This job has reached the provider. Cancellation and a refund cannot be guaranteed; no local cancellation was applied.',
          409,
        );
      const pendingDispatch = await this.currentDispatch(client, row, row.attempt_count + 1);
      const closed = pendingDispatch
        ? await cancelQueuedDispatchInTransaction(client, pendingDispatch)
        : false;
      await this.settleNeverDispatched(client, row, closed);
      const updated = await client.query<JobRow>(
        "UPDATE mr_jobs SET status='cancelled',delivery_status='failed',error=NULL,execution_error=NULL,execution_progress=$2,completed_at=now(),updated_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          JSON.stringify({
            phase: 'complete',
            percent: null,
            source: 'gateway',
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      await this.ownedAssets?.releaseJobPins(client, workspaceId, id);
      await this.events.enqueue(client, {
        workspaceId,
        type: 'generation.completed',
        dedupeKey: id,
        data: {
          jobId: id,
          status: 'cancelled',
          deliveryStatus: 'failed',
          routeId: row.route_snapshot.id,
          deploymentId: row.deployment_snapshot.id,
        },
      });
      return job(updated.rows[0]!);
    }).then((value) => this.withFreshAssets(value));
  }

  private async settle(
    client: PoolClient,
    row: JobRow,
    chargedMicros: number,
    upstreamCostMicros: number | null,
    feeSettlement?: GenerationFeeSettlement,
    costEvidence?: GenerationCostEvidence,
  ): Promise<void> {
    if (row.settled_micros !== null) return;
    if (Boolean(row.fee_admission) !== Boolean(feeSettlement))
      throw new EngineError(
        'invalid_fee_settlement',
        'A fee admission requires a composed settlement.',
        409,
      );
    const reservation = Number(row.reserved_micros);
    const charge = Math.min(micros(chargedMicros), reservation);
    const release = reservation - charge;
    if (
      feeSettlement &&
      (charge !== feeSettlement.customerTotalMicros ||
        upstreamCostMicros !== feeSettlement.providerCostMicros)
    )
      throw new EngineError(
        'invalid_fee_settlement',
        'The composed settlement exceeds the accepted terms.',
        409,
      );
    await new KeyBudgetStore().settleInTransaction(client, row.workspace_id, row.id, charge);
    await client.query(
      'UPDATE mr_workspaces SET available_micros=available_micros+$2,reserved_micros=reserved_micros-$3 WHERE id=$1',
      [row.workspace_id, release, reservation],
    );
    await client.query(
      'UPDATE mr_jobs SET settled_micros=$2,upstream_cost_micros=$3,billing_poll_pending=false,lease_until=NULL,fee_settlement=$4,fee_cost_evidence=$5 WHERE id=$1',
      [
        row.id,
        charge,
        upstreamCostMicros === null ? null : micros(upstreamCostMicros),
        feeSettlement ? JSON.stringify(feeSettlement) : null,
        costEvidence ? JSON.stringify(costEvidence) : null,
      ],
    );
    const settleLedgerId = randomUUID();
    const releaseLedgerId = randomUUID();
    await client.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,details)
       VALUES($1,$2,$3,'settle',$4::bigint,0,-($4::bigint),$5)`,
      [
        settleLedgerId,
        row.workspace_id,
        row.id,
        charge,
        JSON.stringify({
          upstreamCostMicros,
          billing: row.input.billing ?? 'managed',
          operatorOverrunMicros:
            feeSettlement?.operatorOverrunMicros ??
            (row.input.billing === 'byok'
              ? 0
              : upstreamCostMicros === null
                ? null
                : Math.max(0, upstreamCostMicros - charge)),
          ...(feeSettlement ? { billingFee: feeSettlement } : {}),
        }),
      ],
    );
    await client.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
       VALUES($1,$2,$3,'release',$4::bigint,$4::bigint,-($4::bigint))`,
      [releaseLedgerId, row.workspace_id, row.id, release],
    );
    const customerRelief = await finalizeAgedCostReliefInTransaction(client, {
      workspaceId: row.workspace_id,
      jobId: row.id,
      reservedMicros: reservation,
      chargedMicros: charge,
      upstreamCostMicros,
      settleLedgerId,
      releaseLedgerId,
    });
    await this.events.enqueue(client, {
      workspaceId: row.workspace_id,
      type: 'billing.settled',
      dedupeKey: row.id,
      data: {
        jobId: row.id,
        chargedMicros: charge,
        billing: row.input.billing ?? 'managed',
        upstreamCostMicros,
        ...(customerRelief ? { customerRelief } : {}),
        ...(feeSettlement ? { billingFee: feeSettlement } : {}),
      },
    });
  }

  private async settleNeverDispatched(client: PoolClient, row: JobRow, slotClosed: boolean) {
    // Closing a queued fallback says nothing about its earlier supplier bill.
    // The same durable-intent checks apply to legacy and fee-bearing jobs.
    if (row.attempt_count !== 0 || row.upstream_id) return;
    const prior = await client.query(
      'SELECT 1 FROM mr_attempts WHERE job_id=$1 UNION ALL SELECT 1 FROM mr_dispatch_slots WHERE job_id=$1 AND submission_intent_at IS NOT NULL LIMIT 1',
      [row.id],
    );
    if (prior.rowCount) return;
    if (!row.fee_admission) return this.settle(client, row, 0, 0);
    if (!slotClosed) return;
    await this.settle(client, row, 0, 0, {
      ...generationFeeTerms(row.fee_admission.snapshot),
      costStatus: 'no-upstream-charge',
      providerCostMicros: 0,
      customerProviderDebitMicros: 0,
      nominalFeeMicros: 0,
      collectedFeeMicros: 0,
      waivedFeeMicros: 0,
      operatorOverrunMicros: 0,
      customerTotalMicros: 0,
    });
  }

  private async generationCostScope(
    row: JobRow,
    client: Pick<PoolClient, 'query'> | Pool,
  ): Promise<GenerationCostScope | null> {
    if (
      !row.upstream_id ||
      row.upstream_id.length > 256 ||
      !/^[^\s\u0000-\u001f]+$/.test(row.upstream_id)
    )
      return null;
    const attempt = (
      await client.query<{ id: string }>(
        'SELECT id FROM mr_attempts WHERE job_id=$1 AND number=$2 AND route_id=$3 AND deployment_id=$4',
        [row.id, row.attempt_count, row.route_snapshot.id, row.deployment_snapshot.id],
      )
    ).rows[0];
    const credentialIdentity = await this.attemptCredentials.identity(
      this.credentialScope(row),
      client,
    );
    if (!attempt || !credentialIdentity) return null;
    return {
      workspaceId: row.workspace_id,
      jobId: row.id,
      routeId: row.route_snapshot.id,
      credentialIdentity,
      attemptId: attempt.id,
      providerId: row.deployment_snapshot.providerId,
      deploymentId: row.deployment_snapshot.id,
      upstreamReference: row.upstream_id,
    };
  }

  private async settleFeeObservation(
    client: PoolClient,
    row: JobRow,
    result: ProviderResult,
    reconciliation?: Reconciliation,
    authority?: { operatorId: string },
  ): Promise<boolean> {
    const admission = row.fee_admission!;
    const audit = reconciliation?.action === 'settle';
    const refuse = () => {
      if (audit)
        throw new EngineError(
          'fee_evidence_required',
          'Fee settlement requires audited cost tied to the original provider attempt.',
          409,
        );
      return false;
    };
    if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) return refuse();
    if (audit && (reconciliation.costBasis !== 'operator-audited' || !authority?.operatorId))
      return refuse();
    if (!audit && (!result.costEvidence || !this.injectedAdapters)) return false;
    const scope = await this.generationCostScope(row, client);
    if (!scope) return refuse();
    const observation: GenerationCostEvidence = audit
      ? {
          workspaceId: scope.workspaceId,
          jobId: scope.jobId,
          routeId: scope.routeId,
          credentialIdentity: scope.credentialIdentity,
          evidence: {
            attemptId: scope.attemptId,
            providerId: scope.providerId,
            deploymentId: scope.deploymentId,
            upstreamReference: scope.upstreamReference,
            reference: reconciliation.reference,
            auditReference: reconciliation.reference,
            operatorId: authority!.operatorId,
            basis: 'operator-audited',
            currency: 'USD',
            amountMicros: micros(reconciliation.billedCostMicros),
          },
        }
      : result.costEvidence!;
    if (
      observation.workspaceId !== scope.workspaceId ||
      observation.jobId !== scope.jobId ||
      observation.routeId !== scope.routeId ||
      observation.credentialIdentity !== scope.credentialIdentity ||
      (!audit && observation.evidence?.basis !== 'provider-billed-usd')
    )
      return refuse();
    const decision = settleVerifiedCost(admission.snapshot, {
      reservedMicros: micros(row.reserved_micros),
      customerCeilingMicros: admission.customerCeilingMicros,
      evidence: observation.evidence,
      expected: scope,
      outcome: result.status as 'succeeded' | 'failed' | 'cancelled',
      // The first fixture slice cannot establish unbilled predecessor attempts.
      billableAttemptCount: row.attempt_count,
    });
    if (decision.status !== 'settled') return refuse();
    const amount = decision.statement;
    const view = generationFeeSettlementView({
      ...generationFeeTerms(admission.snapshot),
      costStatus: 'verified',
      providerCostMicros: amount.providerCostMicros,
      customerProviderDebitMicros: amount.customerProviderDebitMicros,
      nominalFeeMicros: amount.nominalFeeMicros,
      collectedFeeMicros: amount.collectedFeeMicros,
      waivedFeeMicros: amount.waivedFeeMicros,
      operatorOverrunMicros: amount.operatorOverrunMicros,
      customerTotalMicros: amount.customerTotalMicros,
    });
    await this.settle(client, row, view.customerTotalMicros, view.providerCostMicros, view, {
      workspaceId: scope.workspaceId,
      jobId: scope.jobId,
      routeId: scope.routeId,
      credentialIdentity: scope.credentialIdentity,
      evidence: amount.evidence,
    });
    return true;
  }

  /** Called by polling or an authenticated, signature-verified callback handler; terminal replays are harmless. */
  async applyProviderResult(
    workspaceId: string,
    id: string,
    result: ProviderResult,
    reconciliation?: Reconciliation,
    expectedAttempt?: {
      attemptCount: number;
      routeId: string;
      deploymentId: string;
      upstreamId?: string | null;
      leaseUntil?: Date | null;
      /** Internal worker provenance, distinct from actual provider usage evidence. */
      unverifiedSubmissionRejection?: boolean;
    },
    authority?: { operatorId: string },
  ): Promise<Job> {
    validateId(id);
    const existing = await this.privateJobRow(workspaceId, id);
    if (!existing) throw new EngineError('not_found', 'Generation not found.', 404);
    this.assertResultAttempt(existing, expectedAttempt);
    if (result.status === 'succeeded' && result.outputs?.length && !terminal.has(existing.status)) {
      const scope = await this.deliveryScope(existing, true);
      const receipts = (await this.delivery.receipts(workspaceId, id)).filter(
        (item) => item.attempt === scope.attempt,
      );
      if (!receipts.length)
        await this.delivery.capture(
          scope,
          result.outputs.map((output) =>
            output.storageKey
              ? {
                  kind: 'owned' as const,
                  storageKey: output.storageKey,
                  mediaType: output.mediaType,
                }
              : {
                  kind: 'url' as const,
                  url: output.url,
                  mediaType: output.mediaType,
                  expiresAt: output.expiresAt,
                  refreshable: Boolean(scope.upstreamId && scope.providerConnectionId),
                },
          ),
        );
    }
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const { rows } = await client.query<JobRow>(
        'SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, id],
      );
      const row = rows[0];
      if (!row) throw new EngineError('not_found', 'Generation not found.', 404);
      this.assertResultAttempt(row, expectedAttempt);
      if (expectedAttempt?.unverifiedSubmissionRejection && result.billedCostMicros === 0) {
        const reliefSchema = (
          await client.query("SELECT to_regclass('mr_aged_cost_reliefs') AS name")
        ).rows[0].name;
        const relief =
          reliefSchema &&
          (
            await client.query(
              'SELECT 1 FROM mr_aged_cost_reliefs WHERE workspace_id=$1 AND job_id=$2',
              [workspaceId, id],
            )
          ).rowCount;
        // A submission rejection contains no verified bill. A funded remedy
        // must retain that supplier uncertainty until actual cost evidence.
        if (relief) result = { ...result, billedCostMicros: null };
      }
      const delivery =
        result.status === 'succeeded'
          ? await this.deliveryResultInTransaction(client, row)
          : undefined;
      if (reconciliation) {
        const hash = createHash('sha256').update(stableJson(reconciliation)).digest('hex');
        const prior = (
          await client.query(
            'SELECT request_hash FROM mr_reconciliations WHERE workspace_id=$1 AND job_id=$2 AND reference=$3',
            [workspaceId, id, reconciliation.reference],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash)
            throw new EngineError(
              'reconciliation_conflict',
              'This reference already records different evidence or cost.',
              409,
            );
          return job(row);
        }
        if (
          expectedAttempt &&
          (row.attempt_count !== expectedAttempt.attemptCount ||
            row.route_snapshot.id !== expectedAttempt.routeId ||
            row.deployment_snapshot.id !== expectedAttempt.deploymentId)
        )
          throw new EngineError(
            'reconciliation_conflict',
            'The provider attempt changed; inspect the current job and verify its evidence again.',
            409,
          );
        if (
          terminal.has(row.status) &&
          (result.status !== row.status ||
            (row.settled_micros !== null && reconciliation.action !== 'settle'))
        )
          throw new EngineError(
            'invalid_transition',
            'A completed generation cannot be reopened or replaced.',
            409,
          );
        if (
          reconciliation.action === 'reject' &&
          (row.upstream_id || row.status !== 'submission-unknown')
        )
          throw new EngineError(
            'invalid_transition',
            'Acceptance changed or submission is still active. No rejection or refund was applied.',
            409,
          );
        if (reconciliation.action === 'settle' && row.settled_micros !== null)
          throw new EngineError(
            'already_settled',
            'This job is already settled; no second financial adjustment was applied.',
            409,
          );
        if (
          reconciliation.action === 'resume' &&
          row.upstream_id &&
          row.upstream_id !== reconciliation.upstreamId
        )
          throw new EngineError(
            'invalid_upstream_id',
            'The recorded provider task ID cannot be replaced.',
            409,
          );
        await client.query(
          'INSERT INTO mr_reconciliations(id,workspace_id,job_id,reference,request_hash,action,note,evidence_url) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            randomUUID(),
            workspaceId,
            id,
            reconciliation.reference,
            hash,
            reconciliation.action,
            reconciliation.note,
            reconciliation.evidenceUrl,
          ],
        );
        if (reconciliation.action === 'resume')
          await client.query('UPDATE mr_jobs SET upstream_id=$2 WHERE id=$1', [
            id,
            reconciliation.upstreamId,
          ]);
      }
      if (terminal.has(row.status)) {
        // Providers may report usage after the generation result. Reconcile that hold exactly once.
        if (row.fee_admission && row.settled_micros === null) {
          if (
            result.status === row.status &&
            (await this.settleFeeObservation(client, row, result, reconciliation, authority))
          ) {
            const refreshed = await client.query<JobRow>('SELECT * FROM mr_jobs WHERE id=$1', [id]);
            return job(refreshed.rows[0]!);
          }
          if (
            row.upstream_id &&
            (row.billing_poll_pending || result.retryAfterMs) &&
            (!row.lease_until ||
              row.lease_until.getTime() === expectedAttempt?.leaseUntil?.getTime())
          )
            await client.query(
              "UPDATE mr_jobs SET billing_poll_pending=true,lease_until=NULL,next_poll_at=now()+($2 * interval '1 millisecond') WHERE id=$1",
              [
                row.id,
                result.retryAfterMs
                  ? Math.max(15000, Math.min(3600000, result.retryAfterMs))
                  : this.pollIntervalMs,
              ],
            );
          return job(row);
        }
        if (
          result.status === row.status &&
          row.settled_micros === null &&
          result.billedCostMicros !== undefined &&
          result.billedCostMicros !== null
        ) {
          await this.settle(client, row, result.billedCostMicros, result.billedCostMicros);
          const refreshed = await client.query<JobRow>('SELECT * FROM mr_jobs WHERE id=$1', [id]);
          return job(refreshed.rows[0]!);
        }
        if (result.status === row.status && row.settled_micros === null && result.retryAfterMs) {
          await client.query(
            "UPDATE mr_jobs SET lease_until=NULL,next_poll_at=now()+($2 * interval '1 millisecond') WHERE id=$1",
            [row.id, Math.max(15000, Math.min(3600000, result.retryAfterMs))],
          );
        }
        return job(row);
      }
      if (!['running', 'submitting', 'submission-unknown'].includes(row.status))
        throw new EngineError('invalid_transition', 'The provider has not received this job.', 409);
      const status = result.status === 'unknown' ? 'submission-unknown' : result.status;
      const dispatch = await this.currentDispatch(client, row, row.attempt_count);
      if (dispatch && status === 'submission-unknown')
        await markDispatchUnknownInTransaction(client, dispatch);
      else if (dispatch && terminal.has(status))
        await releaseDispatchInTransaction(
          client,
          dispatch,
          reconciliation ? 'operator_reconciled' : 'confirmed_terminal',
        );
      const deliveryHasPending =
        result.status === 'succeeded' &&
        Boolean(
          (
            await client.query(
              "SELECT 1 FROM mr_output_receipts WHERE job_id=$1 AND attempt=$2 AND state='pending' LIMIT 1",
              [row.id, row.attempt_count],
            )
          ).rowCount,
        );
      const observationError =
        normalizeJobError(result.structuredError) ??
        (status === 'submission-unknown'
          ? jobError('submission_unknown')
          : status === 'failed'
            ? providerFailureError(result.failureCategory)
            : status === 'succeeded' && delivery?.deliveryStatus !== 'available'
              ? jobError(
                  deliveryHasPending
                    ? 'delivery_unavailable'
                    : delivery?.deliveryStatus === 'expired'
                      ? 'delivery_expired'
                      : 'delivery_failed',
                )
              : result.error
                ? jobError('status_unavailable')
                : null);
      const observationProgress =
        normalizeJobProgress(result.progress) ??
        normalizeJobProgress({
          phase:
            status === 'submission-unknown'
              ? 'submitting'
              : status === 'succeeded' && deliveryHasPending
                ? 'delivery'
                : terminal.has(status)
                  ? 'complete'
                  : 'running',
          percent: null,
          source: 'gateway',
          observedAt: new Date().toISOString(),
        });
      const observationTimings = normalizeJobTimings(result.timings);
      const isTerminal = terminal.has(status);
      let feeSettled = false;
      if (row.fee_admission && isTerminal) {
        feeSettled = await this.settleFeeObservation(
          client,
          row,
          result,
          reconciliation,
          authority,
        );
      } else if (row.input.billing === 'byok' && isTerminal) {
        await this.settle(client, row, 0, result.billedCostMicros ?? null);
      } else if (
        result.billedCostMicros !== undefined &&
        result.billedCostMicros !== null &&
        isTerminal
      ) {
        await this.settle(client, row, result.billedCostMicros, result.billedCostMicros);
      }
      const updated = await client.query<JobRow>(
        `UPDATE mr_jobs SET status=$2,outputs=$3,error=$4,failure_category=$7,delivery_status=COALESCE($8,delivery_status),delivery_errors=COALESCE($9,delivery_errors),billing_poll_pending=$10,execution_progress=$11,execution_error=$12,execution_timings=COALESCE($13,execution_timings),lease_until=NULL,
         completed_at=CASE WHEN $5 THEN now() ELSE completed_at END,
         next_poll_at=now()+($6 * interval '1 millisecond'),updated_at=now() WHERE id=$1 RETURNING *`,
        [
          id,
          status,
          JSON.stringify(
            delivery?.outputs ?? (result.status === 'succeeded' ? [] : (result.outputs ?? [])),
          ),
          observationError?.message ?? null,
          isTerminal,
          result.retryAfterMs
            ? Math.max(15000, Math.min(3600000, result.retryAfterMs))
            : this.pollIntervalMs,
          result.status === 'failed' ? (result.failureCategory ?? 'unknown') : null,
          delivery?.deliveryStatus ?? (isTerminal ? 'failed' : null),
          delivery ? JSON.stringify(delivery.deliveryErrors) : null,
          Boolean(
            isTerminal &&
            result.retryAfterMs &&
            (row.fee_admission
              ? !feeSettled && row.upstream_id
              : (result.billedCostMicros === undefined || result.billedCostMicros === null) &&
                row.input.billing !== 'byok'),
          ),
          JSON.stringify(observationProgress),
          JSON.stringify(observationError),
          observationTimings ? JSON.stringify(observationTimings) : null,
        ],
      );
      if (isTerminal) await this.ownedAssets?.releaseJobPins(client, workspaceId, id);
      if (delivery) {
        await client.query(
          'UPDATE mr_jobs SET output_evidence=$2,delivery_updated_at=clock_timestamp() WHERE id=$1',
          [id, JSON.stringify(delivery.outputEvidence)],
        );
        updated.rows[0]!.output_evidence = delivery.outputEvidence;
      }
      await client.query(
        'UPDATE mr_attempts SET state=$2,completed_at=CASE WHEN $3 THEN now() ELSE completed_at END,failure_category=$5 WHERE job_id=$1 AND number=$4',
        [
          id,
          status,
          isTerminal,
          row.attempt_count,
          result.status === 'failed' ? (result.failureCategory ?? 'unknown') : null,
        ],
      );
      if (isTerminal)
        await this.events.enqueue(client, {
          workspaceId: row.workspace_id,
          type: 'generation.completed',
          dedupeKey: row.id,
          data: {
            jobId: row.id,
            status,
            deliveryStatus:
              delivery?.deliveryStatus ??
              (status === 'succeeded' ? 'failed' : (row.delivery_status ?? 'failed')),
            routeId: row.route_snapshot.id,
            deploymentId: row.deployment_snapshot.id,
          },
        });
      return job(updated.rows[0]!);
    }).then((value) => this.withFreshAssets(value));
  }

  private async safeFallback(row: JobRow): Promise<boolean> {
    if (!this.providerExecutionEnabled) return false;
    if (this.executionScope.profile !== 'unrestricted') return false;
    // The legacy rejection signal establishes acceptance, not a verified zero bill.
    if (row.fee_admission) return false;
    const next = row.fallback_routes?.[row.attempt_count];
    if (!next) return false;
    // Recheck adapter/credential capability, while preserving admission-time model/region/policy snapshots.
    const adapters = await this.adaptersForDeployment(row, next.deployment).catch(() => []);
    const adapter = adapters.find((value) => value.id === next.route.adapter);
    let input: GenerateInput;
    try {
      input = await this.resolveInput(row.workspace_id, row.input, {
        forDispatch: true,
        jobId: row.id,
      });
    } catch {
      return false;
    }
    if (
      !adapter?.isConfigured(next.route, next.deployment) ||
      adapter.preflight?.({
        input,
        route: next.route,
        deployment: next.deployment,
      })
    )
      return false;
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [row.workspace_id]);
      const current = (
        await client.query<JobRow>('SELECT * FROM mr_jobs WHERE id=$1 FOR UPDATE', [row.id])
      ).rows[0];
      if (
        !current ||
        current.attempt_count !== row.attempt_count ||
        !['submitting', 'submission-unknown'].includes(current.status)
      )
        return false;
      await this.configureDispatchPools(
        client,
        row.workspace_id,
        [{ route: row.route_snapshot, deployment: row.deployment_snapshot }, next],
        row.input.billing,
      );
      const predecessor = await this.currentDispatch(client, current, current.attempt_count);
      if (predecessor)
        await releaseDispatchInTransaction(client, predecessor, 'explicit_rejection');
      const successor = this.dispatchFor(
        row.workspace_id,
        next.route,
        next.deployment,
        row.input.billing,
      );
      await enqueueDispatchInTransaction(client, {
        ...successor,
        jobId: row.id,
        attemptNumber: row.attempt_count + 1,
        startDeadlineAt: row.queue_start_deadline_at?.toISOString() ?? null,
      });
      await client.query(
        "UPDATE mr_attempts SET state='rejected',completed_at=now() WHERE job_id=$1 AND number=$2",
        [row.id, row.attempt_count],
      );
      await client.query(
        "UPDATE mr_jobs SET status='queued',route_snapshot=$2,deployment_snapshot=$3,upstream_id=NULL,lease_until=NULL,next_poll_at=now(),error='Provider explicitly rejected submission; an eligible fallback is queued.',updated_at=now() WHERE id=$1",
        [row.id, JSON.stringify(next.route), JSON.stringify(next.deployment)],
      );
      return true;
    });
  }

  /** Pool identities are private logical-account IDs; credential revisions are
   * frozen separately by the delivery/credential boundary. */
  private dispatchFor(
    workspaceId: string,
    route: Route,
    deployment: Deployment,
    billing: GenerateInput['billing'],
  ) {
    const mode = billing ?? 'managed';
    const supplyId =
      this.execution.supplyId?.({ workspaceId, route, deployment, billing: mode }) ??
      (mode === 'byok'
        ? `connection:${deployment.id}`
        : `operator:${deployment.credentialEnv ?? deployment.providerId}`);
    return {
      workspaceId,
      workspacePoolId: workspacePoolId(workspaceId),
      providerPoolId:
        mode === 'byok'
          ? providerPoolId({ mode, workspaceId, connectionId: supplyId })
          : providerPoolId({ mode, supplyId }),
    };
  }

  private async configureDispatchPools(
    client: PoolClient,
    workspaceId: string,
    routes: { route: Route; deployment: Deployment }[],
    billing: GenerateInput['billing'],
  ) {
    const values = routes.map(({ route, deployment }) =>
      this.dispatchFor(workspaceId, route, deployment, billing),
    );
    await configurePoolInTransaction(client, {
      id: workspacePoolId(workspaceId),
      kind: 'workspace',
      maxActive: this.execution.workspaceMaxActive ?? 8,
      maxQueued: this.execution.workspaceMaxQueued ?? 100,
    });
    // Fallback can cross supply pools. Lock every supply in one stable order to
    // prevent opposite fallback directions forming a workspace/pool deadlock.
    for (const id of [...new Set(values.map((value) => value.providerPoolId))].sort())
      await configurePoolInTransaction(client, {
        id,
        kind: 'provider',
        maxActive: this.execution.providerMaxActive ?? 8,
        maxQueued: this.execution.providerMaxQueued ?? 100,
      });
    return values;
  }

  private async currentDispatch(
    client: PoolClient,
    row: JobRow,
    attemptNumber: number,
  ): Promise<DispatchIdentity | null> {
    if (attemptNumber < 1) return null;
    const slot = (
      await client.query(
        'SELECT workspace_pool_id,provider_pool_id FROM mr_dispatch_slots WHERE workspace_id=$1 AND job_id=$2 AND attempt_number=$3',
        [row.workspace_id, row.id, attemptNumber],
      )
    ).rows[0];
    return slot
      ? {
          workspaceId: row.workspace_id,
          jobId: row.id,
          attemptNumber,
          workspacePoolId: slot.workspace_pool_id,
          providerPoolId: slot.provider_pool_id,
        }
      : null;
  }

  private async assertLegacyCapacityReconciled(client: PoolClient): Promise<void> {
    const legacy =
      await client.query(`SELECT 1 FROM mr_jobs j WHERE j.status IN ('submitting','running','submission-unknown')
      AND NOT EXISTS(SELECT 1 FROM mr_dispatch_slots s WHERE s.job_id=j.id AND s.attempt_number=j.attempt_count AND s.state IN ('occupied','unknown')) LIMIT 1`);
    if (legacy.rowCount)
      throw new EngineError(
        'legacy_capacity_unreconciled',
        'Accepted legacy work needs capacity reconciliation before new submissions. Existing polling and delivery remain available.',
        503,
      );
  }

  /** No provider call or money release. Persisting unknown keeps capacity held. */
  private async recoverAbandonedSubmission(): Promise<boolean> {
    const candidates = await this.pool.query<{ id: string; workspace_id: string }>(
      "SELECT id,workspace_id FROM mr_jobs WHERE status='submitting' AND lease_until<clock_timestamp() ORDER BY created_at,id LIMIT 1",
    );
    const candidate = candidates.rows[0];
    if (!candidate) return false;
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        candidate.workspace_id,
      ]);
      const row = (
        await client.query<JobRow>(
          "SELECT * FROM mr_jobs WHERE id=$1 AND status='submitting' AND lease_until<clock_timestamp() FOR UPDATE SKIP LOCKED",
          [candidate.id],
        )
      ).rows[0];
      if (!row) return false;
      const dispatch = await this.currentDispatch(client, row, row.attempt_count);
      if (dispatch) await markDispatchUnknownInTransaction(client, dispatch);
      const error = jobError('submission_unknown');
      await client.query(
        "UPDATE mr_attempts SET state='submission-unknown' WHERE job_id=$1 AND number=$2 AND state='submitting'",
        [row.id, row.attempt_count],
      );
      await client.query(
        "UPDATE mr_jobs SET status='submission-unknown',error=$2,execution_error=$3,execution_progress=$4,lease_until=NULL,updated_at=now() WHERE id=$1",
        [
          row.id,
          error.message,
          JSON.stringify(error),
          JSON.stringify({
            phase: 'submitting',
            percent: null,
            source: 'gateway',
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      return true;
    });
  }

  /** Deadline closure is independent of input signing and never creates a
   * provider attempt. A permanently unavailable input cannot defeat expiry. */
  private async expireBeforePreparation(candidate: JobRow): Promise<boolean> {
    if (!candidate.queue_start_deadline_at) return false;
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
        candidate.workspace_id,
      ]);
      const row = (
        await client.query<JobRow>(
          "SELECT * FROM mr_jobs WHERE workspace_id=$1 AND id=$2 AND status='queued' AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED",
          [candidate.workspace_id, candidate.id],
        )
      ).rows[0];
      if (
        !row ||
        row.attempt_count !== candidate.attempt_count ||
        row.request_hash !== candidate.request_hash
      )
        return false;
      if (!(await this.scopeAllowsQueued(client, row))) return false;
      let identity = await this.currentDispatch(client, row, row.attempt_count + 1);
      if (!identity) {
        const values = await this.configureDispatchPools(
          client,
          row.workspace_id,
          [{ route: row.route_snapshot, deployment: row.deployment_snapshot }],
          row.input.billing,
        );
        identity = { ...values[0]!, jobId: row.id, attemptNumber: row.attempt_count + 1 };
        await enqueueDispatchInTransaction(client, {
          ...identity,
          startDeadlineAt: row.queue_start_deadline_at?.toISOString() ?? null,
        });
      }
      if (!(await expireQueuedDispatchInTransaction(client, identity))) return false;
      await this.settleNeverDispatched(client, row, true);
      const error = jobError('start_deadline_exceeded');
      await client.query(
        "UPDATE mr_jobs SET status='failed',delivery_status='failed',error=$2,execution_error=$3,execution_progress=$4,lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1",
        [
          row.id,
          error.message,
          JSON.stringify(error),
          JSON.stringify({
            phase: 'complete',
            percent: null,
            source: 'gateway',
            observedAt: new Date().toISOString(),
          }),
        ],
      );
      await this.ownedAssets?.releaseJobPins(client, row.workspace_id, row.id);
      await this.events.enqueue(client, {
        workspaceId: row.workspace_id,
        type: 'generation.completed',
        dedupeKey: row.id,
        data: {
          jobId: row.id,
          status: 'failed',
          routeId: row.route_snapshot.id,
          deploymentId: row.deployment_snapshot.id,
        },
      });
      return true;
    });
  }

  /** Inspect due deadlines independently of polling pressure and queue backoff.
   * Actual closure still revalidates/locks one existing never-submitted job. */
  private async expireDueQueuedOnce(): Promise<boolean> {
    const candidates =
      this.executionScope.profile === 'unrestricted'
        ? await this.pool.query<JobRow>(`SELECT * FROM mr_jobs WHERE status='queued'
      AND queue_start_deadline_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp())
      ORDER BY queue_start_deadline_at,created_at,id LIMIT 8`)
        : await this.pool.query<JobRow>(
            `SELECT * FROM mr_jobs WHERE status='queued'
      AND queue_start_deadline_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<clock_timestamp())
      AND ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT 8`,
            [this.qualificationExpiryAfterId],
          );
    if (this.executionScope.profile !== 'unrestricted')
      this.qualificationExpiryAfterId =
        candidates.rows.length === 8 ? candidates.rows[candidates.rows.length - 1]!.id : null;
    for (const candidate of candidates.rows)
      if (await this.expireBeforePreparation(candidate)) return true;
    return false;
  }

  /** At most one successful accepted-maintenance action per turn. Rotating the
   * starting category prevents an endless captured/legacy backlog from starving
   * retained-byte delivery, and advances even when one category throws. */
  private async acceptedMaintenanceOnce(): Promise<boolean> {
    for (let inspected = 0; inspected < 3; inspected++) {
      const phase = this.acceptedMaintenancePhase;
      this.acceptedMaintenancePhase = (phase + 1) % 3;
      const worked =
        phase === 0
          ? await this.reconcileCapturedCompletion()
          : phase === 1
            ? await this.checkpointLegacyOutputsOnce()
            : await this.recoverDeliveryOnce();
      if (worked) return true;
    }
    return false;
  }

  private async claimGenerationWork(): Promise<
    | { row: JobRow; isSubmit: false }
    | { row: JobRow; isSubmit: true; preparedInput: GenerateInput; previousUpstreamId?: string }
    | { expired: true }
    | null
  > {
    if (!this.providerExecutionEnabled) return null;
    // These bounded SQL sweeps are accepted-work maintenance, not submissions.
    // Neither continuously due polls nor a full provider pool may defer them.
    const maintenanceTurn = this.workerTurn === 0;
    this.workerTurn = (this.workerTurn + 1) % 4;
    const abandoned = await this.recoverAbandonedSubmission();
    // Bounded expiry checks each queued row's original scope before settlement.
    // No global backlog scan may delay accepted maintenance or provider polling.
    const expired = await this.expireDueQueuedOnce();
    // One in four turns (including the first after restart) offers maintenance
    // before polling. The other turns keep accepted polling ahead of NEW submit.
    if (maintenanceTurn && (await this.acceptedMaintenanceOnce())) return { expired: true };
    const accepted = await this.transaction((client) =>
      claimAcceptedWorkInTransaction<JobRow>(client, this.leaseMs, !this.injectedAdapters),
    );
    if (accepted) return { row: accepted, isSubmit: false };
    if (!maintenanceTurn && (await this.acceptedMaintenanceOnce())) return { expired: true };
    if (abandoned || expired) return { expired: true };
    if (!this.storage) return null;
    await this.assertExecutionScopeTransition();
    // Bounded scan skips full supply instead of letting its head job block all
    // other suppliers. Accepted polling above never acquires a generation slot.
    const candidates = await this.pool.query<JobRow>(
      `SELECT * FROM mr_jobs WHERE status='queued' AND next_poll_at<=clock_timestamp()
      AND ($1 OR fee_admission IS NULL)
      AND (lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY next_poll_at,created_at,id LIMIT 16`,
      [Boolean(this.fixtureBillingPolicy)],
    );
    for (const candidate of candidates.rows) {
      if (!(await this.scopeAllowsQueued(this.pool, candidate)))
        throw new EngineError(
          'execution_scope_transition_required',
          'Queued work requires operator review before new dispatch. Original jobs and holds are unchanged.',
          503,
        );
      if (await this.expireBeforePreparation(candidate)) return { expired: true };
      let preparedInput: GenerateInput;
      let previousUpstreamId: string | undefined;
      try {
        // This can read storage/sign capabilities. It deliberately runs with NO
        // workspace/job/pool lock and BEFORE capacity or submit intent exists.
        preparedInput = await this.resolveInput(candidate.workspace_id, candidate.input, {
          forDispatch: true,
          jobId: candidate.id,
        });
        previousUpstreamId = candidate.input.previousJobId
          ? ((await this.internalJob(candidate.workspace_id, candidate.input.previousJobId))
              ?.upstreamId ?? undefined)
          : undefined;
      } catch {
        // An outage may cross a deadline. Close a never-submitted expired job
        // before rescheduling; neither path manufactures unknown acceptance.
        if (await this.expireBeforePreparation(candidate)) return { expired: true };
        const error = jobError('input_preparation_unavailable');
        await this.pool.query(
          `UPDATE mr_jobs SET next_poll_at=clock_timestamp()+interval '1 second',error=$7,execution_error=$8,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND status='queued' AND attempt_count=$3 AND request_hash=$4
          AND route_snapshot->>'id'=$5 AND deployment_snapshot->>'id'=$6
          AND (lease_until IS NULL OR lease_until<clock_timestamp())`,
          [
            candidate.workspace_id,
            candidate.id,
            candidate.attempt_count,
            candidate.request_hash,
            candidate.route_snapshot.id,
            candidate.deployment_snapshot.id,
            error.message,
            JSON.stringify(error),
          ],
        );
        continue;
      }
      const claim = await this.transaction(async (client) => {
        await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
          candidate.workspace_id,
        ]);
        const row = (
          await client.query<JobRow>(
            "SELECT * FROM mr_jobs WHERE id=$1 AND status='queued' AND (lease_until IS NULL OR lease_until<clock_timestamp()) FOR UPDATE SKIP LOCKED",
            [candidate.id],
          )
        ).rows[0];
        // Cancellation, another worker, fallback or a cutover input change may
        // have won while preparation was outside locks. Discard its stale URL.
        if (
          !row ||
          row.request_hash !== candidate.request_hash ||
          row.attempt_count !== candidate.attempt_count ||
          row.route_snapshot.id !== candidate.route_snapshot.id ||
          row.deployment_snapshot.id !== candidate.deployment_snapshot.id ||
          requestHash(row.input) !== requestHash(candidate.input)
        )
          return null;
        if (!(await this.scopeAllowsQueued(client, row)))
          throw new EngineError(
            'execution_scope_transition_required',
            'Queued work changed outside the qualification scope before dispatch.',
            503,
          );
        const attemptNumber = row.attempt_count + 1;
        let identity = await this.currentDispatch(client, row, attemptNumber);
        if (!identity) {
          // Legacy queued work has never sent this attempt. Adopt only that
          // unsubmitted boundary; do not infer active legacy account occupancy.
          const identities = await this.configureDispatchPools(
            client,
            row.workspace_id,
            [{ route: row.route_snapshot, deployment: row.deployment_snapshot }],
            row.input.billing,
          );
          identity = { ...identities[0]!, jobId: row.id, attemptNumber };
          await enqueueDispatchInTransaction(client, {
            ...identity,
            startDeadlineAt: row.queue_start_deadline_at?.toISOString() ?? null,
          });
        }
        if (await expireQueuedDispatchInTransaction(client, identity)) {
          await this.settleNeverDispatched(client, row, true);
          const error = jobError('start_deadline_exceeded');
          await client.query(
            "UPDATE mr_jobs SET status='failed',delivery_status='failed',error=$2,execution_error=$3,execution_progress=$4,lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1",
            [
              row.id,
              error.message,
              JSON.stringify(error),
              JSON.stringify({
                phase: 'complete',
                percent: null,
                source: 'gateway',
                observedAt: new Date().toISOString(),
              }),
            ],
          );
          await this.ownedAssets?.releaseJobPins(client, row.workspace_id, row.id);
          await this.events.enqueue(client, {
            workspaceId: row.workspace_id,
            type: 'generation.completed',
            dedupeKey: row.id,
            data: {
              jobId: row.id,
              status: 'failed',
              deliveryStatus: 'failed',
              routeId: row.route_snapshot.id,
              deploymentId: row.deployment_snapshot.id,
            },
          });
          return { expired: true as const };
        }
        // A fence after expiry allows due never-submitted jobs to release their
        // reservation even while unresolved legacy provider work blocks supply.
        const legacy = await client.query(
          `SELECT 1 FROM mr_jobs j WHERE j.status IN ('submitting','running','submission-unknown') AND NOT EXISTS(SELECT 1 FROM mr_dispatch_slots s WHERE s.job_id=j.id AND s.attempt_number=j.attempt_count AND s.state IN ('occupied','unknown')) LIMIT 1`,
        );
        if (legacy.rowCount) {
          await client.query(
            "UPDATE mr_jobs SET next_poll_at=clock_timestamp()+interval '1 second' WHERE id=$1",
            [row.id],
          );
          return null;
        }
        const permit = await beginDispatchInTransaction(client, identity);
        if (permit === 'blocked') {
          await client.query(
            "UPDATE mr_jobs SET next_poll_at=clock_timestamp()+interval '1 second',execution_error=$2 WHERE id=$1",
            [row.id, JSON.stringify(jobError('capacity_full'))],
          );
          return null;
        }
        if (permit === 'expired') {
          // beginDispatch can cross the boundary while waiting for pool locks.
          await this.settleNeverDispatched(client, row, true);
          const error = jobError('start_deadline_exceeded');
          await client.query(
            "UPDATE mr_jobs SET status='failed',delivery_status='failed',error=$2,execution_error=$3,execution_progress=$4,lease_until=NULL,completed_at=now(),updated_at=now() WHERE id=$1",
            [
              row.id,
              error.message,
              JSON.stringify(error),
              JSON.stringify({
                phase: 'complete',
                percent: null,
                source: 'gateway',
                observedAt: new Date().toISOString(),
              }),
            ],
          );
          await this.ownedAssets?.releaseJobPins(client, row.workspace_id, row.id);
          await this.events.enqueue(client, {
            workspaceId: row.workspace_id,
            type: 'generation.completed',
            dedupeKey: row.id,
            data: {
              jobId: row.id,
              status: 'failed',
              deliveryStatus: 'failed',
              routeId: row.route_snapshot.id,
              deploymentId: row.deployment_snapshot.id,
            },
          });
          return { expired: true as const };
        }
        if (permit !== 'acquired') return null; // A replayed intent never authorizes submit.
        const started = (
          await client.query(
            'SELECT submission_intent_at FROM mr_dispatch_slots WHERE job_id=$1 AND attempt_number=$2',
            [row.id, attemptNumber],
          )
        ).rows[0].submission_intent_at as Date;
        const timings = gatewayJobTimings({
          createdAt: row.created_at.toISOString(),
          dispatchStartedAt: started.toISOString(),
        });
        const updated = await client.query<JobRow>(
          `UPDATE mr_jobs SET status='submitting',attempt_count=$2,lease_until=clock_timestamp()+($3*interval '1 millisecond'),error=NULL,execution_error=NULL,
          execution_progress=$4,execution_timings=COALESCE(execution_timings,'{}')::jsonb || $5::jsonb,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            row.id,
            attemptNumber,
            this.leaseMs,
            JSON.stringify({
              phase: 'submitting',
              percent: null,
              source: 'gateway',
              observedAt: started.toISOString(),
            }),
            JSON.stringify({ queue: timings.queue }),
          ],
        );
        await client.query(
          "INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,$3,$4,$5,'submitting')",
          [randomUUID(), row.id, attemptNumber, row.route_snapshot.id, row.deployment_snapshot.id],
        );
        await this.freezeAttemptCredentials(client, updated.rows[0]!);
        return {
          row: updated.rows[0]!,
          isSubmit: true as const,
          preparedInput,
          previousUpstreamId,
        };
      });
      if (claim) return claim;
    }
    return null;
  }

  async workOnce(): Promise<boolean> {
    // A disabled runtime must not claim leases, expire work or manufacture releases.
    if (!this.providerExecutionEnabled) return false;
    const claimed = await this.claimGenerationWork();
    if (!claimed) {
      const expiredComparison = await this.expireComparisonQuotes();
      return Boolean((await this.ownedAssets?.cleanup(10)) || expiredComparison);
    }
    if ('expired' in claimed) return true;
    const { row, isSubmit } = claimed;
    let adapters: ProviderAdapter[] = [];
    try {
      // Injected fixtures may safely acquire a missing legacy binding. Real old
      // credentials are never inferred from a mutable current connection.
      if (this.injectedAdapters && row.input.billing !== 'byok')
        await this.transaction((client) => this.freezeAttemptCredentials(client, row));
      adapters = await this.adaptersForAttempt(row);
    } catch {
      /* Credentials are unavailable; never substitute another account. */
    }
    const adapter = adapters.find((value) => value.id === row.route_snapshot.adapter);
    if (!adapter) {
      if (isSubmit)
        await this.applyProviderResult(row.workspace_id, row.id, {
          status: 'failed',
          failureCategory: 'invalid',
          structuredError: jobError('credentials_unavailable'),
          error:
            'Credentials or adapter unavailable before submission; no provider request was sent.',
          billedCostMicros: 0,
        });
      else
        await this.pool.query(
          "UPDATE mr_jobs SET lease_until=NULL,next_poll_at=now()+($2 * interval '1 millisecond'),error='The original provider connection needs operator attention to resume this job.',execution_error=$3,updated_at=now() WHERE id=$1",
          [row.id, this.pollIntervalMs, JSON.stringify(jobError('credentials_unavailable'))],
        );
      return true;
    }
    const context = {
      jobId: row.id,
      workspaceId: row.workspace_id,
      attempt: row.attempt_count,
      providerConnectionId: (await this.attemptCredentials.read(this.credentialScope(row)))
        .identity,
      input: row.input,
      route: row.route_snapshot,
      deployment: row.deployment_snapshot,
    };
    if (claimed.isSubmit) {
      try {
        // Use exactly the ephemeral package prepared before intent. No storage,
        // continuation lookup or signing is repeated after the paid boundary.
        const prepared = {
          ...context,
          input: claimed.preparedInput,
          previousUpstreamId: claimed.previousUpstreamId,
        };
        this.assertProviderExecutionEnabled();
        const submitted = await adapter.submit(prepared);
        if (submitted.immediateResult) {
          await this.applyProviderResult(
            row.workspace_id,
            row.id,
            submitted.immediateResult,
            undefined,
            this.resultAttempt(row),
          );
          return true;
        }
        if (!submitted.upstreamId) throw new Error('Missing upstream task ID.');
        await this.transaction(async (client) => {
          await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
            row.workspace_id,
          ]);
          const accepted = await client.query(
            "UPDATE mr_jobs SET status='running',upstream_id=$2,lease_until=NULL,next_poll_at=now()+($3 * interval '1 millisecond'),execution_progress=$4,error=NULL,execution_error=NULL,updated_at=now() WHERE id=$1 AND attempt_count=$5 AND route_snapshot->>'id'=$6 AND deployment_snapshot->>'id'=$7 AND status IN ('submitting','submission-unknown','running') AND (upstream_id IS NULL OR upstream_id=$2) RETURNING id",
            [
              row.id,
              submitted.upstreamId,
              this.pollIntervalMs,
              JSON.stringify({
                phase: 'running',
                percent: null,
                source: 'gateway',
                observedAt: new Date().toISOString(),
              }),
              row.attempt_count,
              row.route_snapshot.id,
              row.deployment_snapshot.id,
            ],
          );
          if (accepted.rowCount) {
            await client.query(
              "UPDATE mr_dispatch_slots SET state='occupied' WHERE job_id=$1 AND attempt_number=$2 AND workspace_id=$3 AND state='unknown'",
              [row.id, row.attempt_count, row.workspace_id],
            );
            await client.query(
              "UPDATE mr_attempts SET state='running' WHERE job_id=$1 AND number=$2 AND state IN ('submitting','submission-unknown')",
              [row.id, row.attempt_count],
            );
          }
        });
      } catch (error) {
        if (error instanceof SubmissionRejected && (await this.safeFallback(row))) return true;
        await this.applyProviderResult(
          row.workspace_id,
          row.id,
          error instanceof SubmissionRejected
            ? {
                status: 'failed',
                failureCategory: 'unknown',
                structuredError: jobError('submission_rejected'),
                error: error.message,
                billedCostMicros: 0,
              }
            : {
                status: 'unknown',
                error:
                  'Provider submission acceptance is unknown. No automatic retry was sent; credit remains reserved.',
              },
          undefined,
          {
            ...this.resultAttempt(row),
            unverifiedSubmissionRejection: error instanceof SubmissionRejected,
          },
        );
      }
    } else {
      try {
        if (!row.upstream_id) throw new Error('Missing upstream task ID.');
        const costEvidenceScope = row.fee_admission
          ? await this.generationCostScope(row, this.pool)
          : null;
        this.assertProviderExecutionEnabled();
        const result = await adapter.poll({
          ...context,
          upstreamId: row.upstream_id,
          ...(costEvidenceScope ? { costEvidenceScope } : {}),
        });
        await this.applyProviderResult(row.workspace_id, row.id, result, undefined, {
          ...this.resultAttempt(row),
          leaseUntil: row.lease_until,
        });
      } catch {
        // A status-read failure does not establish generation failure or refundability.
        if (row.fee_admission) {
          await this.pool.query(
            "UPDATE mr_jobs SET lease_until=NULL,next_poll_at=now()+($2 * interval '1 millisecond') WHERE id=$1 AND workspace_id=$3 AND attempt_count=$4 AND upstream_id=$5 AND date_trunc('milliseconds',lease_until)=$6::timestamptz AND (status='running' OR billing_poll_pending=true)",
            [
              row.id,
              this.pollIntervalMs,
              row.workspace_id,
              row.attempt_count,
              row.upstream_id,
              row.lease_until,
            ],
          );
        } else {
          await this.pool.query(
            "UPDATE mr_jobs SET lease_until=NULL,next_poll_at=now()+($2 * interval '1 millisecond'),error='Provider status is temporarily unavailable. Resume reading the same job.',execution_error=$3,updated_at=now() WHERE id=$1 AND (status='running' OR billing_poll_pending=true)",
            [row.id, this.pollIntervalMs, JSON.stringify(jobError('status_unavailable'))],
          );
        }
      }
    }
    return true;
  }

  async routeMetrics(configuration?: GenerateInput): Promise<RouteMetrics[]> {
    const { rows } = await this.pool.query(
      `WITH attempts AS (
      SELECT a.route_id,count(*)::int AS samples,
        count(*) FILTER (WHERE a.state='succeeded')::int AS succeeded,
        count(*) FILTER (WHERE a.state IN ('failed','rejected'))::int AS failed,
        count(*) FILTER (WHERE a.state IN ('failed','rejected') AND (a.failure_category IS NULL OR a.failure_category='unknown'))::int AS unclassified_failures,
        count(*) FILTER (WHERE a.state='failed' AND a.failure_category='technical')::int AS technical_failures,
        count(*) FILTER (WHERE a.state IN ('submitting','running','submission-unknown'))::int AS unresolved,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at-a.started_at)*1000) FILTER (WHERE a.state='succeeded') AS p50,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at-a.started_at)*1000) FILTER (WHERE a.state='succeeded') AS p75,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at-a.started_at)*1000) FILTER (WHERE a.state='succeeded') AS p90,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at-a.started_at)*1000) FILTER (WHERE a.state='succeeded') AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM a.completed_at-a.started_at)*1000) FILTER (WHERE a.state='succeeded') AS p99
      FROM mr_attempts a JOIN mr_jobs j ON j.id=a.job_id
      WHERE a.started_at>=now()-interval '7 days'
        AND ($1::text IS NULL OR (j.input->>'operation'=$1 AND j.input->'input'->>'resolution' IS NOT DISTINCT FROM $2::text AND j.input->'input'->>'duration' IS NOT DISTINCT FROM $3::text))
      GROUP BY a.route_id
    ), delivery_observations AS (
      SELECT j.route_snapshot->>'id' AS route_id,j.status,j.delivery_status,
        j.status='succeeded' AND j.delivery_status='available' AND coalesce(receipt.available,false) AS delivery_available,
        CASE WHEN j.status='succeeded' AND j.delivery_status='available' AND coalesce(receipt.available,false)
          AND j.delivery_updated_at IS NOT NULL AND isfinite(j.delivery_updated_at) AND isfinite(j.created_at)
          AND j.delivery_updated_at>=j.created_at AND j.delivery_updated_at<=clock_timestamp()
          THEN extract(epoch FROM j.delivery_updated_at-j.created_at)*1000 END AS delivery_ms
      FROM mr_jobs j LEFT JOIN LATERAL (
        SELECT count(*)>0 AND bool_and(coalesce(r.state='available' AND r.sha256 ~ '^[a-f0-9]{64}$'
          AND r.byte_length>0 AND r.object_key LIKE ('outputs/' || j.id::text || '/%'),false)) AS available
        FROM mr_output_receipts r WHERE r.workspace_id=j.workspace_id AND r.job_id=j.id AND r.attempt=j.attempt_count
          AND r.route_id=j.route_snapshot->>'id' AND r.deployment_id=j.deployment_snapshot->>'id'
          AND r.upstream_id IS NOT DISTINCT FROM j.upstream_id
      ) receipt ON true
      WHERE j.attempt_count>0 AND j.created_at>=now()-interval '7 days'
        AND ($1::text IS NULL OR (j.input->>'operation'=$1 AND j.input->'input'->>'resolution' IS NOT DISTINCT FROM $2::text AND j.input->'input'->>'duration' IS NOT DISTINCT FROM $3::text))
    ), jobs AS (
      SELECT route_id,count(*)::int AS job_samples,
        count(*) FILTER (WHERE delivery_available)::int AS delivery_available,
        count(*) FILTER (WHERE status='succeeded' AND delivery_status IN ('failed','expired'))::int AS delivery_failed,
        count(*) FILTER (WHERE status='succeeded' AND NOT coalesce(delivery_available,false)
          AND coalesce(delivery_status,'unverified') NOT IN ('failed','expired'))::int AS delivery_unresolved,
        count(delivery_ms)::int AS end_to_end_samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY delivery_ms) AS job_p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY delivery_ms) AS job_p95
      FROM delivery_observations GROUP BY route_id
    ) SELECT attempts.*,jobs.job_samples,jobs.delivery_available,jobs.delivery_failed,jobs.delivery_unresolved,
      jobs.end_to_end_samples,jobs.job_p50,jobs.job_p95
      FROM attempts LEFT JOIN jobs ON jobs.route_id=attempts.route_id`,
      [
        configuration?.operation ?? null,
        configuration?.input.resolution ?? null,
        configuration?.input.duration === undefined ? null : String(configuration.input.duration),
      ],
    );
    return this.catalog.routes.map((route) => {
      const row = rows.find((value) => value.route_id === route.id);
      const resolved = row ? row.succeeded + row.technical_failures : 0;
      return {
        routeId: route.id,
        jobSampleCount: row?.job_samples ?? 0,
        deliveryAvailableJobCount: row?.delivery_available ?? 0,
        deliveryFailedJobCount: row?.delivery_failed ?? 0,
        deliveryUnresolvedJobCount: row?.delivery_unresolved ?? 0,
        endToEndSampleCount: row?.end_to_end_samples ?? 0,
        trafficProvenance: 'mixed-unclassified' as const,
        p50EndToEndMs:
          row?.job_p50 === null || row?.job_p50 === undefined ? null : Number(row.job_p50),
        p95EndToEndMs:
          row?.job_p95 === null || row?.job_p95 === undefined ? null : Number(row.job_p95),
        technicalOutcomeCount: resolved,
        ...(configuration
          ? {
              configuration: {
                operation: configuration.operation,
                resolution: configuration.input.resolution,
                duration: configuration.input.duration,
              },
            }
          : {}),
        sampleCount: row?.samples ?? 0,
        succeeded: row?.succeeded ?? 0,
        failed: row?.failed ?? 0,
        unclassifiedFailures: row?.unclassified_failures ?? 0,
        unresolved: row?.unresolved ?? 0,
        technicalSuccessRate:
          resolved && !row.unclassified_failures ? row.succeeded / resolved : null,
        p50CompletionMs: row?.p50 === null || row?.p50 === undefined ? null : Number(row.p50),
        p75CompletionMs: row?.p75 === null || row?.p75 === undefined ? null : Number(row.p75),
        p90CompletionMs: row?.p90 === null || row?.p90 === undefined ? null : Number(row.p90),
        p95CompletionMs: row?.p95 === null || row?.p95 === undefined ? null : Number(row.p95),
        p99CompletionMs: row?.p99 === null || row?.p99 === undefined ? null : Number(row.p99),
        window: '7 days',
        benchmarkOrigin: process.env.METRICS_ORIGIN_REGION ?? 'undisclosed',
      };
    });
  }
}

export function createEngine(options: EngineOptions): Engine {
  return new Engine(options);
}
