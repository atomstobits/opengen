import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolClient } from 'pg';
import type { Deployment } from '@media-router/contracts';
import {
  AttemptCredentialStore,
  snapshotCredentialEnvironment,
} from '../packages/engine/src/attempt-credentials.js';
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
