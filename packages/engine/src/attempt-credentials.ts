import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Deployment } from '@media-router/contracts';
import { alibabaCredentials, normalizeAlibabaEndpoint } from './adapters.js';
import { openVault, sealVault } from './vault.js';

export interface AttemptCredentialScope {
  workspaceId: string;
  jobId: string;
  attempt: number;
  deployment: Deployment;
  billing?: 'managed' | 'byok';
}
interface CredentialRow {
  identity: string;
  kind: 'injected' | 'managed' | 'byok';
  ciphertext: string | null;
}
const denied = () =>
  Object.assign(
    new Error(
      'The original provider credential snapshot is unavailable. Restore it or obtain operator reconciliation; no replacement credential was used.',
    ),
    { code: 'original_credentials_unavailable', statusCode: 409 },
  );
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const providerFields: Record<string, readonly string[]> = {
  byteplus: ['BYTEPLUS_API_KEY'],
  fal: ['FAL_KEY', 'FAL_END_USER_ID'],
  openai: ['OPENAI_API_KEY'],
  xai: ['XAI_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  replicate: ['REPLICATE_API_TOKEN'],
  runway: ['RUNWAYML_API_SECRET'],
  pika: ['PIKA_API_KEY'],
};
/** Only this deployment's configured credentials, never the complete process environment. */
export function snapshotCredentialEnvironment(
  deployment: Deployment,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = new Set(providerFields[deployment.providerId] ?? []);
  if (deployment.credentialEnv) names.add(deployment.credentialEnv);
  if (deployment.endpointEnv) names.add(deployment.endpointEnv);
  if (deployment.providerId === 'alibaba') {
    const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
    for (const key of [
      `${prefix}_API_KEY`,
      `${prefix}_ENDPOINT`,
      'ALIBABA_REGION',
      'DASHSCOPE_API_KEY',
      'ALIBABA_ENDPOINT',
    ])
      names.add(key);
  }
  return Object.fromEntries(
    [...names]
      .sort()
      .filter((name) => env[name] !== undefined)
      .map((name) => [name, env[name]]),
  ) as NodeJS.ProcessEnv;
}
export function connectionEnvironment(
  deployment: Deployment,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  if (deployment.credentialEnv) env[deployment.credentialEnv] = values.apiKey;
  if (deployment.providerId === 'alibaba') {
    const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
    env[`${prefix}_API_KEY`] = values.apiKey;
    if (values.endpoint) {
      if (deployment.endpointEnv) env[deployment.endpointEnv] = values.endpoint;
      env[`${prefix}_ENDPOINT`] = values.endpoint;
    }
  }
  return env;
}
const alibabaRegionCodes = [
  'ap-southeast-1',
  'us-east-1',
  'eu-central-1',
  'cn-hongkong',
  'ap-northeast-1',
  'cn-beijing',
] as const;

const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function deriveLegacyAlibabaEndpoint(
  deployment: Deployment,
  workspaceId: string,
  runtimeEnv: NodeJS.ProcessEnv,
  byokConnection?: Record<string, string> | null,
): string | null {
  if (!dnsLabelPattern.test(workspaceId)) return null;
  const region = deployment.endpointRegion.toLowerCase();
  if (!dnsLabelPattern.test(region)) return null;
  const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
  const ws = workspaceId.toLowerCase();

  // 1. Same-region configured runtime endpoint: replace only the leading workspace label
  // so legacy managed/BYOK snapshots always recover against their original frozen workspace.
  const sameRegionCandidate = normalizeAlibabaEndpoint(
    (deployment.endpointEnv ? runtimeEnv[deployment.endpointEnv] : undefined) ||
      runtimeEnv[`${prefix}_ENDPOINT`] ||
      (runtimeEnv.ALIBABA_REGION === deployment.endpointRegion
        ? runtimeEnv.ALIBABA_ENDPOINT
        : undefined),
  );
  if (sameRegionCandidate) {
    const parsed = new URL(sameRegionCandidate);
    const labels = parsed.hostname.toLowerCase().split('.');
    if (labels.length >= 4 && labels[1] === region) {
      const recovered = normalizeAlibabaEndpoint(
        `https://${ws}.${labels.slice(1).join('.')}${parsed.pathname}`,
      );
      if (recovered) return recovered;
    }
  }

  // 2. Any other configured regional Alibaba endpoint in the runtime environment.
  for (const otherRegion of alibabaRegionCodes) {
    const otherPrefix = `ALIBABA_${otherRegion.toUpperCase().replaceAll('-', '_')}`;
    const otherCandidate = normalizeAlibabaEndpoint(runtimeEnv[`${otherPrefix}_ENDPOINT`]);
    if (!otherCandidate) continue;
    const parsed = new URL(otherCandidate);
    const labels = parsed.hostname.toLowerCase().split('.');
    if (labels.length >= 4 && labels[1] === otherRegion) {
      const recovered = normalizeAlibabaEndpoint(
        `https://${ws}.${region}.${labels.slice(2).join('.')}${parsed.pathname}`,
      );
      if (recovered) return recovered;
    }
  }

  // 3. Explicit operator recovery template for BYOK-only deployments without managed Alibaba envs.
  const template = runtimeEnv.ALIBABA_LEGACY_ENDPOINT_TEMPLATE;
  if (template && template.includes('{workspaceId}') && template.includes('{region}')) {
    const recovered = normalizeAlibabaEndpoint(
      template.replaceAll('{workspaceId}', ws).replaceAll('{region}', region),
    );
    if (recovered) return recovered;
  }

  // 4. For legacy BYOK snapshots, allow an updated BYOK connection only when its endpoint host
  // starts with the exact same frozen workspace and region labels (never swapping accounts).
  const byokEndpoint = normalizeAlibabaEndpoint(byokConnection?.endpoint);
  if (byokEndpoint) {
    const parsed = new URL(byokEndpoint);
    if (parsed.hostname.toLowerCase().startsWith(`${ws}.${region}.`)) {
      return byokEndpoint;
    }
  }

  return null;
}

/**
 * Upgrade-only recovery for previously frozen Alibaba attempt snapshots that persisted
 * ALIBABA_<REGION>_WORKSPACE_ID (or shared ALIBABA_WORKSPACE_ID) before endpoint env vars.
 * Never used for new admissions, which still require an explicit endpoint URL.
 */
export function recoverLegacyAlibabaSnapshotEnv(
  deployment: Deployment,
  frozenEnv: NodeJS.ProcessEnv,
  runtimeEnv: NodeJS.ProcessEnv,
  byokConnection?: Record<string, string> | null,
): NodeJS.ProcessEnv {
  if (deployment.providerId !== 'alibaba') return frozenEnv;
  if (alibabaCredentials(deployment, frozenEnv) !== null) return frozenEnv;
  const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
  const regionalKey =
    (deployment.credentialEnv ? frozenEnv[deployment.credentialEnv] : undefined) ||
    frozenEnv[`${prefix}_API_KEY`];
  const regionalWorkspace = frozenEnv[`${prefix}_WORKSPACE_ID`];
  if (regionalKey && regionalWorkspace) {
    const endpoint = deriveLegacyAlibabaEndpoint(
      deployment,
      regionalWorkspace,
      runtimeEnv,
      byokConnection,
    );
    if (!endpoint) return frozenEnv;
    return {
      ...frozenEnv,
      ...(deployment.endpointEnv ? { [deployment.endpointEnv]: endpoint } : {}),
      [`${prefix}_ENDPOINT`]: endpoint,
    };
  }
  if (
    frozenEnv.ALIBABA_REGION === deployment.endpointRegion &&
    frozenEnv.DASHSCOPE_API_KEY &&
    frozenEnv.ALIBABA_WORKSPACE_ID
  ) {
    const endpoint = deriveLegacyAlibabaEndpoint(
      deployment,
      frozenEnv.ALIBABA_WORKSPACE_ID,
      runtimeEnv,
      byokConnection,
    );
    if (!endpoint) return frozenEnv;
    return {
      ...frozenEnv,
      ALIBABA_ENDPOINT: endpoint,
    };
  }
  return frozenEnv;
}

/** Private immutable attempt credentials. No customer DTO or receipt contains ciphertext or keys. */
export class AttemptCredentialStore {
  constructor(
    private readonly pool: Pool,
    private readonly options: {
      vaultKey?: string;
      env: NodeJS.ProcessEnv;
      injected: boolean;
      injectedIdentity?: string;
    },
  ) {}
  private context(scope: AttemptCredentialScope) {
    return `provider-job:${scope.workspaceId}:${scope.jobId}:${scope.deployment.id}`;
  }
  /** Same caller-owned transaction as attempt intent, before any provider submit. */
  async freezeAdmission(client: PoolClient, scope: AttemptCredentialScope): Promise<string> {
    let row: CredentialRow;
    if (scope.billing === 'byok') {
      const connection = (
        await client.query(
          'SELECT ciphertext FROM mr_connections WHERE workspace_id=$1 AND deployment_id=$2 FOR SHARE',
          [scope.workspaceId, scope.deployment.id],
        )
      ).rows[0];
      if (!connection) throw denied();
      // Re-encrypt under attempt-specific AAD. Removal/rotation of the mutable connection
      // cannot redirect accepted work to a different provider account.
      const values = openVault<Record<string, string>>(
        connection.ciphertext,
        this.options.vaultKey,
        `${scope.workspaceId}:${scope.deployment.id}`,
      );
      row = {
        kind: 'byok',
        identity: `byok:${digest(connection.ciphertext)}`,
        ciphertext: sealVault(
          connectionEnvironment(scope.deployment, values),
          this.options.vaultKey,
          this.context(scope),
        ),
      };
    } else if (this.options.injected) {
      // An explicitly injected adapter is a trusted internal integration boundary.
      // Fixture adapters have no provider secrets. Real custom adapters must supply
      // a stable revision identity and preserve their own original credentials.
      row = {
        kind: 'injected',
        identity: `injected:${digest([this.options.injectedIdentity ?? 'fixture', scope.deployment.providerId])}`,
        ciphertext: null,
      };
    } else {
      const env = snapshotCredentialEnvironment(scope.deployment, this.options.env);
      row = {
        kind: 'managed',
        identity: `managed:${digest(env)}`,
        ciphertext: sealVault(env, this.options.vaultKey, this.context(scope)),
      };
    }
    const saved = (
      await client.query<CredentialRow>(
        `INSERT INTO mr_job_credentials(job_id,workspace_id,deployment_id,kind,identity,ciphertext) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(job_id,deployment_id) DO UPDATE SET identity=mr_job_credentials.identity
      WHERE mr_job_credentials.workspace_id=EXCLUDED.workspace_id RETURNING identity,kind,ciphertext`,
        [
          scope.jobId,
          scope.workspaceId,
          scope.deployment.id,
          row.kind,
          row.identity,
          row.ciphertext,
        ],
      )
    ).rows[0];
    if (!saved || saved.identity !== row.identity) throw denied();
    return saved.identity;
  }
  /** The caller inserted the matching attempt intent. Only the admission snapshot may be bound. */
  async freeze(client: PoolClient, scope: AttemptCredentialScope): Promise<string> {
    let saved = (
      await client.query<CredentialRow>(
        'SELECT identity,kind,ciphertext FROM mr_job_credentials WHERE job_id=$1 AND workspace_id=$2 AND deployment_id=$3 FOR SHARE',
        [scope.jobId, scope.workspaceId, scope.deployment.id],
      )
    ).rows[0];
    // Synthetic injected fixtures can safely acquire a missing legacy binding;
    // live legacy accounts cannot be reconstructed from whichever key is newest.
    if (!saved && this.options.injected && scope.billing !== 'byok') {
      await this.freezeAdmission(client, scope);
      saved = (
        await client.query<CredentialRow>(
          'SELECT identity,kind,ciphertext FROM mr_job_credentials WHERE job_id=$1 AND workspace_id=$2 AND deployment_id=$3 FOR SHARE',
          [scope.jobId, scope.workspaceId, scope.deployment.id],
        )
      ).rows[0];
    }
    if (!saved) throw denied();
    const bound = (
      await client.query(
        `INSERT INTO mr_attempt_credentials(job_id,attempt_number,workspace_id,deployment_id,identity) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(job_id,attempt_number) DO UPDATE SET identity=mr_attempt_credentials.identity
      WHERE mr_attempt_credentials.workspace_id=EXCLUDED.workspace_id AND mr_attempt_credentials.deployment_id=EXCLUDED.deployment_id RETURNING identity`,
        [scope.jobId, scope.attempt, scope.workspaceId, scope.deployment.id, saved.identity],
      )
    ).rows[0];
    if (bound?.identity !== saved.identity) throw denied();
    return saved.identity;
  }

  /** Read a private revision fence without decrypting credentials. */
  async identity(
    scope: AttemptCredentialScope,
    client: Pick<PoolClient, 'query'> | Pool = this.pool,
  ): Promise<string | null> {
    return (
      (
        await client.query<{ identity: string }>(
          `SELECT c.identity FROM mr_attempt_credentials a JOIN mr_job_credentials c
      ON c.job_id=a.job_id AND c.workspace_id=a.workspace_id AND c.deployment_id=a.deployment_id AND c.identity=a.identity
      WHERE a.job_id=$1 AND a.attempt_number=$2 AND a.workspace_id=$3 AND a.deployment_id=$4`,
          [scope.jobId, scope.attempt, scope.workspaceId, scope.deployment.id],
        )
      ).rows[0]?.identity ?? null
    );
  }
  private async readStoredEnv(
    scope: AttemptCredentialScope,
    row: CredentialRow,
  ): Promise<NodeJS.ProcessEnv> {
    if (!row.ciphertext) throw denied();
    const frozenEnv = openVault<NodeJS.ProcessEnv>(
      row.ciphertext,
      this.options.vaultKey,
      this.context(scope),
    );
    if (
      scope.deployment.providerId !== 'alibaba' ||
      alibabaCredentials(scope.deployment, frozenEnv) !== null
    ) {
      return frozenEnv;
    }
    let byokConnection: Record<string, string> | null = null;
    if (row.kind === 'byok') {
      const current = (
        await this.pool.query<{ ciphertext: string }>(
          'SELECT ciphertext FROM mr_connections WHERE workspace_id=$1 AND deployment_id=$2',
          [scope.workspaceId, scope.deployment.id],
        )
      ).rows[0];
      if (current?.ciphertext) {
        try {
          byokConnection = openVault<Record<string, string>>(
            current.ciphertext,
            this.options.vaultKey,
            `${scope.workspaceId}:${scope.deployment.id}`,
          );
        } catch {
          byokConnection = null;
        }
      }
    }
    return recoverLegacyAlibabaSnapshotEnv(
      scope.deployment,
      frozenEnv,
      this.options.env,
      byokConnection,
    );
  }
  /** Original admitted credentials for an eligible fallback before its attempt exists. */
  async readAdmission(
    scope: AttemptCredentialScope,
  ): Promise<{ identity: string; kind: CredentialRow['kind']; env: NodeJS.ProcessEnv }> {
    const row = (
      await this.pool.query<CredentialRow>(
        'SELECT identity,kind,ciphertext FROM mr_job_credentials WHERE job_id=$1 AND workspace_id=$2 AND deployment_id=$3',
        [scope.jobId, scope.workspaceId, scope.deployment.id],
      )
    ).rows[0];
    if (!row) throw denied();
    if (row.kind === 'injected') {
      if (
        !this.options.injected ||
        row.identity !==
          `injected:${digest([this.options.injectedIdentity ?? 'fixture', scope.deployment.providerId])}`
      )
        throw denied();
      return { ...row, env: {} as NodeJS.ProcessEnv };
    }
    return {
      identity: row.identity,
      kind: row.kind,
      env: await this.readStoredEnv(scope, row),
    };
  }
  async read(scope: AttemptCredentialScope): Promise<{
    identity: string;
    kind: CredentialRow['kind'];
    env: NodeJS.ProcessEnv;
  }> {
    const row = (
      await this.pool.query<CredentialRow>(
        'SELECT c.identity,c.kind,c.ciphertext FROM mr_attempt_credentials a JOIN mr_job_credentials c ON c.job_id=a.job_id AND c.workspace_id=a.workspace_id AND c.deployment_id=a.deployment_id AND c.identity=a.identity WHERE a.job_id=$1 AND a.attempt_number=$2 AND a.workspace_id=$3 AND a.deployment_id=$4',
        [scope.jobId, scope.attempt, scope.workspaceId, scope.deployment.id],
      )
    ).rows[0];
    if (!row) throw denied();
    if (row.kind === 'injected') {
      if (
        !this.options.injected ||
        row.identity !==
          `injected:${digest([this.options.injectedIdentity ?? 'fixture', scope.deployment.providerId])}`
      )
        throw denied();
      return { ...row, env: {} as NodeJS.ProcessEnv };
    }
    return {
      identity: row.identity,
      kind: row.kind,
      env: await this.readStoredEnv(scope, row),
    };
  }
}
