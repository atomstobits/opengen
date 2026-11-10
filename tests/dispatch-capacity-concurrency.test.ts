import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  beginDispatchInTransaction,
  configurePoolInTransaction,
  enqueueDispatchInTransaction,
  markDispatchUnknownInTransaction,
  providerPoolId,
  releaseDispatchInTransaction,
  workspacePoolId,
  type DispatchIdentity,
} from '../packages/engine/src/dispatch-capacity.js';

// Explicit native-only opt-in: PGlite's one backend cannot demonstrate simultaneous transactions.
const databaseUrl = process.env.EXECUTION_NATIVE_DATABASE_URL;
async function fixture(maxActive = 2, maxQueued = 20) {
  const schema = `execution_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 8,
    options: `-c search_path=${schema}`,
  });
  for (const path of ['migrations/001.sql', 'migrations/007.sql', 'schema-proposals/execution.sql'])
    await pool.query(
      await readFile(new URL(`../packages/engine/${path}`, import.meta.url), 'utf8'),
    );
  const provider = providerPoolId({ mode: 'managed', supplyId: schema });
  async function transaction<T>(
    value: DispatchIdentity | null,
    run: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (value)
        await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
          value.workspaceId,
        ]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  await transaction(null, (client) =>
    configurePoolInTransaction(client, { id: provider, kind: 'provider', maxActive, maxQueued }),
  );
  async function prepare(): Promise<DispatchIdentity> {
    const workspace = `fixture_${randomUUID()}`;
    await pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,9000)', [workspace]);
    const value = {
      jobId: randomUUID(),
      attemptNumber: 1,
      workspaceId: workspace,
      workspacePoolId: workspacePoolId(workspace),
      providerPoolId: provider,
    };
    await pool.query(
      `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros)
      VALUES($1,$2,$3,'fixture','{}','{}','{}','queued',100)`,
      [value.jobId, workspace, value.jobId],
    );
    await transaction(value, (client) =>
      configurePoolInTransaction(client, {
        id: value.workspacePoolId,
        kind: 'workspace',
        maxActive,
        maxQueued,
      }),
    );
    return value;
  }
  return {
    pool,
    transaction,
    prepare,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
describe.skipIf(!databaseUrl)('native PostgreSQL execution capacity races', () => {
  it('atomically limits shared supply across independent workspaces/replicas; unknown survives crash and releases once', async () => {
    const f = await fixture();
    try {
      const jobs = await Promise.all(Array.from({ length: 8 }, () => f.prepare()));
      await Promise.all(
        jobs.map((value) =>
          f.transaction(value, (client) => enqueueDispatchInTransaction(client, value)),
        ),
      );
      const claims = await Promise.all(
        jobs.map((value) =>
          f.transaction(value, (client) => beginDispatchInTransaction(client, value)),
        ),
      );
      expect(claims.filter((state) => state === 'acquired')).toHaveLength(2);
      expect(claims.filter((state) => state === 'blocked')).toHaveLength(6);
      const occupied = jobs[claims.indexOf('acquired')]!;
      const blocked = jobs[claims.indexOf('blocked')]!;
      await f.pool.query(
        `UPDATE mr_jobs SET lease_until=now()-interval '1 day',status='submission-unknown' WHERE id=$1`,
        [occupied.jobId],
      );
      await f.transaction(occupied, (client) => markDispatchUnknownInTransaction(client, occupied));
      expect(
        await f.transaction(blocked, (client) => beginDispatchInTransaction(client, blocked)),
      ).toBe('blocked');
      const releases = await Promise.all(
        Array.from({ length: 8 }, () =>
          f.transaction(occupied, (client) =>
            releaseDispatchInTransaction(client, occupied, 'operator_reconciled'),
          ),
        ),
      );
      expect(releases.filter(Boolean)).toHaveLength(1);
      expect(
        await f.transaction(blocked, (client) => beginDispatchInTransaction(client, blocked)),
      ).toBe('acquired');
      expect((await f.pool.query('SELECT count(*)::int AS n FROM mr_ledger')).rows[0].n).toBe(0);
    } finally {
      await f.close();
    }
  }, 30_000);
  it('bounds concurrent new admissions while the original queued replay consumes no additional backlog', async () => {
    const f = await fixture(2, 2);
    try {
      const jobs = await Promise.all(Array.from({ length: 8 }, () => f.prepare()));
      const attempts = await Promise.allSettled(
        jobs.map((value) =>
          f.transaction(value, (client) => enqueueDispatchInTransaction(client, value)),
        ),
      );
      expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      for (const result of attempts.filter((r) => r.status === 'rejected'))
        expect(result.reason).toMatchObject({ code: 'dispatch_backpressure', statusCode: 429 });
      const original = jobs[attempts.findIndex((r) => r.status === 'fulfilled')]!;
      expect(
        await f.transaction(original, (client) => enqueueDispatchInTransaction(client, original)),
      ).toEqual({ state: 'queued', replay: true });
    } finally {
      await f.close();
    }
  }, 30_000);
});
