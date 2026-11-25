import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import type { Deployment } from '@media-router/contracts';
import {
  AttemptCredentialStore,
  recoverLegacyAlibabaSnapshotEnv,
  snapshotCredentialEnvironment,
} from '../packages/engine/src/attempt-credentials.js';
import { alibabaCredentials } from '../packages/engine/src/adapters.js';
import { sealVault } from '../packages/engine/src/vault.js';

let db: PGlite;
const vaultKey = '0'.repeat(64);
const deployment = {
  id: 'fixture-openai',
  providerId: 'openai',
  credentialEnv: 'OPENAI_API_KEY',
  endpointRegion: 'undisclosed',
} as Deployment;
const query = async (sql: string, args?: unknown[]) => {
  const result = await db.query(sql, args);
  return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
};
const pool = { query } as unknown as Pool;
const client = { query } as unknown as PoolClient;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE mr_jobs(id uuid PRIMARY KEY,workspace_id text NOT NULL,UNIQUE(id,workspace_id));
    CREATE TABLE mr_attempts(job_id uuid,number integer,PRIMARY KEY(job_id,number));
    CREATE TABLE mr_connections(workspace_id text,deployment_id text,ciphertext text,PRIMARY KEY(workspace_id,deployment_id));
    CREATE TABLE mr_output_receipts(job_id uuid,attempt integer);`);
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/019.sql', import.meta.url), 'utf8'),
  );
}, 120_000);
afterAll(async () => {
  await db?.close();
});
async function scope(billing: 'managed' | 'byok' = 'managed') {
  const jobId = randomUUID();
  await query('INSERT INTO mr_jobs VALUES($1,$2)', [jobId, 'owner']);
  return { workspaceId: 'owner', jobId, attempt: 1, deployment, billing };
}
async function attempt(value: Awaited<ReturnType<typeof scope>>) {
  await query('INSERT INTO mr_attempts VALUES($1,1)', [value.jobId]);
}
it('retains original encrypted managed credentials across rotation/restart and denies foreign scope', async () => {
  const env = {
    OPENAI_API_KEY: 'fixture-original-not-live',
    UNRELATED_SECRET: 'never-snapshotted',
  } as NodeJS.ProcessEnv;
  const store = new AttemptCredentialStore(pool, { vaultKey, env, injected: false });
  const value = await scope();
  await store.freezeAdmission(client, value);
  await attempt(value);
  const identity = await store.freeze(client, value);
  env.OPENAI_API_KEY = 'fixture-replacement-not-live';
  const restarted = new AttemptCredentialStore(pool, { vaultKey, env, injected: false });
  expect(await restarted.read(value)).toMatchObject({
    identity,
    env: { OPENAI_API_KEY: 'fixture-original-not-live' },
  });
  expect((await restarted.read(value)).env.UNRELATED_SECRET).toBeUndefined();
  await expect(restarted.read({ ...value, workspaceId: 'foreign' })).rejects.toMatchObject({
    code: 'original_credentials_unavailable',
  });
  expect(Object.keys(snapshotCredentialEnvironment(deployment, env))).toEqual(['OPENAI_API_KEY']);
});
it('keeps accepted BYOK work on its original payer after mutable connection replacement and deletion', async () => {
  const store = new AttemptCredentialStore(pool, {
    vaultKey,
    env: {} as NodeJS.ProcessEnv,
    injected: false,
  });
  const value = await scope('byok');
  await query('INSERT INTO mr_connections VALUES($1,$2,$3)', [
    'owner',
    deployment.id,
    sealVault({ apiKey: 'fixture-original-byok' }, vaultKey, `owner:${deployment.id}`),
  ]);
  await store.freezeAdmission(client, value);
  await attempt(value);
  await store.freeze(client, value);
  await query(
    'UPDATE mr_connections SET ciphertext=$3 WHERE workspace_id=$1 AND deployment_id=$2',
    [
      'owner',
      deployment.id,
      sealVault({ apiKey: 'fixture-replacement-byok' }, vaultKey, `owner:${deployment.id}`),
    ],
  );
  expect((await store.read(value)).env.OPENAI_API_KEY).toBe('fixture-original-byok');
  await query('DELETE FROM mr_connections WHERE workspace_id=$1', ['owner']);
  expect((await store.read(value)).env.OPENAI_API_KEY).toBe('fixture-original-byok');
});
it('refuses to guess real legacy credentials and permits secret-free injected fixture recovery', async () => {
  const value = await scope();
  await attempt(value);
  const live = new AttemptCredentialStore(pool, {
    vaultKey,
    env: {} as NodeJS.ProcessEnv,
    injected: false,
  });
  await expect(live.freeze(client, value)).rejects.toMatchObject({
    code: 'original_credentials_unavailable',
  });
  const fixture = new AttemptCredentialStore(pool, {
    env: {} as NodeJS.ProcessEnv,
    injected: true,
  });
  await fixture.freeze(client, value);
  expect((await fixture.read(value)).kind).toBe('injected');
});
it('requires encryption for real managed snapshots before anything can dispatch', async () => {
  const store = new AttemptCredentialStore(pool, {
    env: { OPENAI_API_KEY: 'fixture' } as NodeJS.ProcessEnv,
    injected: false,
  });
  await expect(store.freezeAdmission(client, await scope())).rejects.toMatchObject({
    code: 'vault_not_configured',
  });
});
it('snapshots workspace-specific Alibaba endpoints for managed and BYOK attempts', async () => {
  const alibabaDeployment = {
    id: 'alibaba-model-studio-ap-southeast-1',
    providerId: 'alibaba',
    credentialEnv: 'ALIBABA_AP_SOUTHEAST_1_API_KEY',
    endpointEnv: 'ALIBABA_AP_SOUTHEAST_1_ENDPOINT',
    endpointRegion: 'ap-southeast-1',
  } as Deployment;
  const env = {
    ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture-alibaba-key',
    ALIBABA_AP_SOUTHEAST_1_ENDPOINT: 'https://managed-ws.example.invalid/api/v1',
    ALIBABA_ENDPOINT: 'https://shared-ws.example.invalid/api/v1',
    ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'legacy-ignored',
    UNRELATED_SECRET: 'never-snapshotted',
  } as NodeJS.ProcessEnv;
  expect(snapshotCredentialEnvironment(alibabaDeployment, env)).toEqual({
    ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture-alibaba-key',
    ALIBABA_AP_SOUTHEAST_1_ENDPOINT: 'https://managed-ws.example.invalid/api/v1',
    ALIBABA_ENDPOINT: 'https://shared-ws.example.invalid/api/v1',
  });
  const store = new AttemptCredentialStore(pool, { vaultKey, env, injected: false });
  const jobId = randomUUID();
  await query('INSERT INTO mr_jobs VALUES($1,$2)', [jobId, 'owner']);
  const byokScope = {
    workspaceId: 'owner',
    jobId,
    attempt: 1,
    deployment: alibabaDeployment,
    billing: 'byok' as const,
  };
  await query('INSERT INTO mr_connections VALUES($1,$2,$3)', [
    'owner',
    alibabaDeployment.id,
    sealVault(
      {
        apiKey: 'fixture-byok-alibaba-key',
        endpoint: 'https://byok-ws.example.invalid/api/v1',
      },
      vaultKey,
      `owner:${alibabaDeployment.id}`,
    ),
  ]);
  await store.freezeAdmission(client, byokScope);
  await query('INSERT INTO mr_attempts VALUES($1,1)', [jobId]);
  await store.freeze(client, byokScope);
  expect((await store.read(byokScope)).env).toEqual({
    ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture-byok-alibaba-key',
    ALIBABA_AP_SOUTHEAST_1_ENDPOINT: 'https://byok-ws.example.invalid/api/v1',
  });
});
it('recovers previously frozen pre-upgrade Alibaba workspace snapshots without loosening new admissions', async () => {
  const sgDeployment = {
    id: 'alibaba-model-studio-ap-southeast-1',
    providerId: 'alibaba',
    credentialEnv: 'ALIBABA_AP_SOUTHEAST_1_API_KEY',
    endpointEnv: 'ALIBABA_AP_SOUTHEAST_1_ENDPOINT',
    endpointRegion: 'ap-southeast-1',
  } as Deployment;
  const usDeployment = {
    id: 'alibaba-model-studio-us-east-1',
    providerId: 'alibaba',
    credentialEnv: 'ALIBABA_US_EAST_1_API_KEY',
    endpointEnv: 'ALIBABA_US_EAST_1_ENDPOINT',
    endpointRegion: 'us-east-1',
  } as Deployment;

  // 1. Legacy managed regional snapshot recovers original frozen workspace even after operator rotates.
  const legacyManagedFrozen = {
    ALIBABA_AP_SOUTHEAST_1_API_KEY: 'frozen-old-key',
    ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'old-managed-ws',
  } as NodeJS.ProcessEnv;
  expect(alibabaCredentials(sgDeployment, legacyManagedFrozen)).toBeNull();
  const runtimeEnv = {
    ALIBABA_AP_SOUTHEAST_1_API_KEY: 'new-operator-key',
    ALIBABA_AP_SOUTHEAST_1_ENDPOINT:
      'https://rotated-op-ws.ap-southeast-1.regional-api.example/api/v1',
  } as NodeJS.ProcessEnv;
  const recoveredManaged = recoverLegacyAlibabaSnapshotEnv(
    sgDeployment,
    legacyManagedFrozen,
    runtimeEnv,
  );
  expect(alibabaCredentials(sgDeployment, recoveredManaged)).toEqual({
    apiKey: 'frozen-old-key',
    endpoint: 'https://old-managed-ws.ap-southeast-1.regional-api.example/api/v1',
  });

  // 2. Legacy shared-key snapshot recovers ALIBABA_ENDPOINT for matching region.
  const legacySharedFrozen = {
    ALIBABA_REGION: 'ap-southeast-1',
    DASHSCOPE_API_KEY: 'frozen-shared-key',
    ALIBABA_WORKSPACE_ID: 'old-shared-ws',
  } as NodeJS.ProcessEnv;
  const recoveredShared = recoverLegacyAlibabaSnapshotEnv(
    sgDeployment,
    legacySharedFrozen,
    runtimeEnv,
  );
  expect(alibabaCredentials(sgDeployment, recoveredShared)).toEqual({
    apiKey: 'frozen-shared-key',
    endpoint: 'https://old-shared-ws.ap-southeast-1.regional-api.example/api/v1',
  });

  // 3. Cross-region runtime suffix or explicit ALIBABA_LEGACY_ENDPOINT_TEMPLATE recovers BYOK snapshots.
  const legacyUsFrozen = {
    ALIBABA_US_EAST_1_API_KEY: 'frozen-us-byok-key',
    ALIBABA_US_EAST_1_WORKSPACE_ID: 'customer-us-ws',
  } as NodeJS.ProcessEnv;
  expect(
    alibabaCredentials(
      usDeployment,
      recoverLegacyAlibabaSnapshotEnv(usDeployment, legacyUsFrozen, runtimeEnv),
    ),
  ).toEqual({
    apiKey: 'frozen-us-byok-key',
    endpoint: 'https://customer-us-ws.us-east-1.regional-api.example/api/v1',
  });
  expect(
    alibabaCredentials(
      usDeployment,
      recoverLegacyAlibabaSnapshotEnv(usDeployment, legacyUsFrozen, {
        ALIBABA_LEGACY_ENDPOINT_TEMPLATE: 'https://{workspaceId}.{region}.legacy.example/api/v1',
      }),
    ),
  ).toEqual({
    apiKey: 'frozen-us-byok-key',
    endpoint: 'https://customer-us-ws.us-east-1.legacy.example/api/v1',
  });

  // 4. Persisted pre-upgrade mr_job_credentials + mr_attempt_credentials recover via AttemptCredentialStore.read().
  const managedJobId = randomUUID();
  await query('INSERT INTO mr_jobs VALUES($1,$2)', [managedJobId, 'owner']);
  await query('INSERT INTO mr_attempts VALUES($1,1)', [managedJobId]);
  const managedAad = `provider-job:owner:${managedJobId}:${sgDeployment.id}`;
  const managedIdentity = `managed:${'a'.repeat(64)}`;
  await query('INSERT INTO mr_job_credentials VALUES($1,$2,$3,$4,$5,$6)', [
    managedJobId,
    'owner',
    sgDeployment.id,
    'managed',
    managedIdentity,
    sealVault(legacyManagedFrozen, vaultKey, managedAad),
  ]);
  await query('INSERT INTO mr_attempt_credentials VALUES($1,1,$2,$3,$4)', [
    managedJobId,
    'owner',
    sgDeployment.id,
    managedIdentity,
  ]);
  const store = new AttemptCredentialStore(pool, { vaultKey, env: runtimeEnv, injected: false });
  const readManaged = await store.read({
    workspaceId: 'owner',
    jobId: managedJobId,
    attempt: 1,
    deployment: sgDeployment,
  });
  expect(alibabaCredentials(sgDeployment, readManaged.env)).toEqual({
    apiKey: 'frozen-old-key',
    endpoint: 'https://old-managed-ws.ap-southeast-1.regional-api.example/api/v1',
  });

  // 5. BYOK-only deployment without operator endpoint/template never trusts mutable mr_connections
  // (preventing a replacement connection from redirecting a frozen API key to an unrelated domain).
  const byokJobId = randomUUID();
  await query('INSERT INTO mr_jobs VALUES($1,$2)', [byokJobId, 'byok-tenant']);
  await query('INSERT INTO mr_attempts VALUES($1,1)', [byokJobId]);
  const byokAad = `provider-job:byok-tenant:${byokJobId}:${usDeployment.id}`;
  const byokIdentity = `byok:${'b'.repeat(64)}`;
  await query('INSERT INTO mr_job_credentials VALUES($1,$2,$3,$4,$5,$6)', [
    byokJobId,
    'byok-tenant',
    usDeployment.id,
    'byok',
    byokIdentity,
    sealVault(legacyUsFrozen, vaultKey, byokAad),
  ]);
  await query('INSERT INTO mr_attempt_credentials VALUES($1,1,$2,$3,$4)', [
    byokJobId,
    'byok-tenant',
    usDeployment.id,
    byokIdentity,
  ]);
  await query('INSERT INTO mr_connections VALUES($1,$2,$3)', [
    'byok-tenant',
    usDeployment.id,
    sealVault(
      {
        apiKey: 'different-rotated-key',
        endpoint: 'https://customer-us-ws.us-east-1.attacker.example/api/v1',
      },
      vaultKey,
      `byok-tenant:${usDeployment.id}`,
    ),
  ]);
  const byokOnlyStore = new AttemptCredentialStore(pool, {
    vaultKey,
    env: {} as NodeJS.ProcessEnv,
    injected: false,
  });
  const unconfigured = await byokOnlyStore.read({
    workspaceId: 'byok-tenant',
    jobId: byokJobId,
    attempt: 1,
    deployment: usDeployment,
    billing: 'byok',
  });
  expect(alibabaCredentials(usDeployment, unconfigured.env)).toBeNull();
  const operatorTemplateStore = new AttemptCredentialStore(pool, {
    vaultKey,
    env: {
      ALIBABA_LEGACY_ENDPOINT_TEMPLATE: 'https://{workspaceId}.{region}.legacy.example/api/v1',
    } as NodeJS.ProcessEnv,
    injected: false,
  });
  const recoveredViaOperatorTemplate = await operatorTemplateStore.read({
    workspaceId: 'byok-tenant',
    jobId: byokJobId,
    attempt: 1,
    deployment: usDeployment,
    billing: 'byok',
  });
  expect(alibabaCredentials(usDeployment, recoveredViaOperatorTemplate.env)).toEqual({
    apiKey: 'frozen-us-byok-key',
    endpoint: 'https://customer-us-ws.us-east-1.legacy.example/api/v1',
  });
});
