import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { AccountStore } from '../packages/engine/src/accounts.js';

/** Isolated synthetic schema; never reads provider keys or calls upstream. */
export async function governanceFixture(max = 1) {
  const schema = `governance_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    max,
    options: `-c search_path=${schema}`,
    onConnect: async (client) => {
      await client.query(`SET search_path TO ${schema}`);
    },
  });
  const migrations = new URL('../packages/engine/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((file) => /^\d{3}\.sql$/.test(file)).sort())
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const workspaceId = `ws_${randomUUID()}`;
  await pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,1000)', [workspaceId]);
  const accounts = new AccountStore(pool);
  const key = await accounts.createKey(workspaceId, {
    name: 'Fixture key',
    scopes: ['read', 'generate'],
  });
  // A past cutover gives deterministic month-boundary fixtures without claiming
  // that real historical unattributed activity has been reconstructed.
  await pool.query(
    "UPDATE mr_api_keys SET cap_coverage_started_at='2025-01-01T00:00:00Z' WHERE id=$1",
    [key.id],
  );
  const tx = async <T>(fn: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const job = async (client: PoolClient, amount: number, workspace = workspaceId) => {
    const id = randomUUID();
    await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspace]);
    await client.query(
      `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros)
      VALUES($1::uuid,$2,$1::text,'fixture','{}','{}','{}','queued',$3)`,
      [id, workspace, amount],
    );
    return id;
  };
  return {
    pool,
    schema,
    workspaceId,
    accounts,
    key,
    tx,
    job,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query('SET search_path TO public');
      await admin.end();
    },
  };
}
