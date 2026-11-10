import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Deployment } from '@media-router/contracts';
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
  if (deployment.providerId === 'alibaba') {
    const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
    for (const key of [
      `${prefix}_API_KEY`,
      `${prefix}_WORKSPACE_ID`,
      'ALIBABA_REGION',
      'DASHSCOPE_API_KEY',
      'ALIBABA_WORKSPACE_ID',
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
function connectionEnvironment(
  deployment: Deployment,
  values: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  if (deployment.credentialEnv) env[deployment.credentialEnv] = values.apiKey;
  if (deployment.providerId === 'alibaba') {
    const prefix = `ALIBABA_${deployment.endpointRegion.toUpperCase().replaceAll('-', '_')}`;
    env[`${prefix}_API_KEY`] = values.apiKey;
    env[`${prefix}_WORKSPACE_ID`] = values.workspaceId;
  }
  return env;
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
    if (!row.ciphertext) throw denied();
    return {
      identity: row.identity,
      kind: row.kind,
      env: openVault<NodeJS.ProcessEnv>(row.ciphertext, this.options.vaultKey, this.context(scope)),
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
    if (!row.ciphertext) throw denied();
    return {
      identity: row.identity,
      kind: row.kind,
      env: openVault<NodeJS.ProcessEnv>(row.ciphertext, this.options.vaultKey, this.context(scope)),
    };
  }
}
