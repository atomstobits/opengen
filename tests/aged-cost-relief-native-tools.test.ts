import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgedCostReliefStore } from '@media-router/engine';
import {
  agedCostReliefFixture,
  agedCostReliefTestDatabaseUrl,
} from './aged-cost-relief-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pgBin = process.env.OPENGEN_CORE_QUALIFICATION_PG_BIN;
const qualified = Boolean(databaseUrl && process.env.TEST_NATIVE_POSTGRES === '1' && pgBin);
type Fixture = Awaited<ReturnType<typeof agedCostReliefFixture>>;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Native aged-cost qualification cannot contact a provider or processor.');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function identifier(value: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value))
    throw new Error('Only generated qualification identifiers are allowed.');
  return `"${value}"`;
}

async function fixtureSchema(f: Fixture) {
  const schema = (await f.engine.pool.query<{ name: string }>('SELECT current_schema() AS name'))
    .rows[0]!.name;
  if (!/^aged_cost_relief_[a-f0-9]{32}$/.test(schema))
    throw new Error('Native qualification may replace only its own generated fixture schema.');
  return schema;
}

function pgTool(name: 'pg_dump' | 'pg_restore', args: string[], input?: Buffer) {
  const url = new URL(agedCostReliefTestDatabaseUrl(databaseUrl));
  const result = spawnSync(join(pgBin!, name), args, {
    input,
    env: {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGCONNECT_TIMEOUT: '5',
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error('Native aged-cost fixture schema dump/restore failed.');
  return result.stdout;
}

async function snapshot(f: Fixture, schema: string) {
  const tables = (
    await f.engine.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'mr_%' ORDER BY tablename",
      [schema],
    )
  ).rows;
  const rows: Record<string, string[]> = {};
  for (const { tablename } of tables)
    rows[tablename] = (
      await f.engine.pool.query<{ row: string }>(
        `SELECT row_to_json(t)::text AS row FROM ${identifier(schema)}.${identifier(tablename)} t ORDER BY row_to_json(t)::text`,
      )
    ).rows.map((row) => row.row);
  const sequence = (
    await f.engine.pool.query<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text,is_called FROM ${identifier(schema)}.mr_ledger_posting_order_seq`,
    )
  ).rows;
  return { rows, sequence };
}

describe.skipIf(!qualified)('native aged-cost restore and reduced-runtime qualification', () => {
  it('restores populated pending and settled relief with every original financial row and a no-op restart', async () => {
    const f = await agedCostReliefFixture({ paid: true });
    let schema: string | undefined;
    let schemaDropped = false;
    try {
      schema = await fixtureSchema(f);
      const settledJob = await f.admit();
      await f.store.grant((await f.packet(settledJob)).input, f.context);
      await f.engine.applyProviderResult(f.workspaceId, settledJob.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const pendingJob = await f.admit();
      await f.store.grant((await f.packet(pendingJob)).input, f.context);
      const selected = (jobId: string) => ({ workspaceId: f.workspaceId, jobId });
      const settledReceipt = await f.store.getReceipt(selected(settledJob.id), f.context);
      const pendingReceipt = await f.store.getReceipt(selected(pendingJob.id), f.context);
      expect(settledReceipt.settlement).toMatchObject({
        grossChargeMicros: 100_000,
        operatorFundedMicros: 100_000,
        customerNetChargeMicros: 0,
      });
      expect(pendingReceipt.settlement).toBeNull();
      const jobState = async () =>
        (
          await f.engine.pool.query(
            'SELECT id,upstream_id,settled_micros::text,upstream_cost_micros::text,reserved_micros::text FROM mr_jobs WHERE workspace_id=$1 ORDER BY id',
            [f.workspaceId],
          )
        ).rows;
      const originalJobs = await jobState();
      expect(originalJobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: pendingJob.id,
            upstream_id: `fixture-aged-${pendingJob.id}`,
            settled_micros: null,
            upstream_cost_micros: null,
          }),
          expect.objectContaining({
            id: settledJob.id,
            upstream_id: `fixture-aged-${settledJob.id}`,
            upstream_cost_micros: '100000',
          }),
        ]),
      );
      const before = await snapshot(f, schema);
      const backup = pgTool('pg_dump', [
        '--format=custom',
        '--no-owner',
        '--no-acl',
        `--schema=${schema}`,
      ]);
      expect(backup.length).toBeGreaterThan(0);
      await f.engine.pool.query(`DROP SCHEMA ${identifier(schema)} CASCADE`);
      schemaDropped = true;
      const target = new URL(agedCostReliefTestDatabaseUrl(databaseUrl));
      pgTool(
        'pg_restore',
        [
          '--no-owner',
          '--no-acl',
          '--exit-on-error',
          '--dbname',
          decodeURIComponent(target.pathname.slice(1)),
        ],
        backup,
      );
      schemaDropped = false;
      expect(await fixtureSchema(f)).toBe(schema);
      expect(await snapshot(f, schema)).toEqual(before);
      await f.engine.initialize();
      await f.engine.initialize();
      expect(await snapshot(f, schema)).toEqual(before);
      expect(await jobState()).toEqual(originalJobs);
      expect(await f.store.getReceipt(selected(settledJob.id), f.context)).toEqual(settledReceipt);
      expect(await f.store.getReceipt(selected(pendingJob.id), f.context)).toEqual(pendingReceipt);
      expect(await snapshot(f, schema)).toEqual(before);
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(f.poll).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      // If restore fails, recreate only the missing owned schema so the fixture's
      // normal cleanup can run without obscuring the original restore error.
      if (schemaDropped && schema)
        await f.engine.pool.query(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`);
      await f.close();
    }
  });

  it('requires posting-sequence usage for a reduced runtime and rolls back a denied relief completely', async () => {
    const f = await agedCostReliefFixture();
    const role = `aged_relief_runtime_${randomUUID().replaceAll('-', '')}`;
    let createdRole = false;
    try {
      const schema = await fixtureSchema(f);
      const qualification = (
        await f.engine.pool.query<{ allowed: boolean }>(
          'SELECT rolsuper OR rolcreaterole AS allowed FROM pg_roles WHERE rolname=current_user',
        )
      ).rows[0]!;
      if (!qualification.allowed)
        throw new Error('Reduced-runtime qualification requires a fixture owner with CREATEROLE.');
      await f.engine.pool.query(
        `CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
      createdRole = true;
      await f.engine.pool.query(
        `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${identifier(role)}`,
      );
      await f.engine.pool.query(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${identifier(schema)} TO ${identifier(role)}`,
      );
      await f.engine.pool.query(
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${identifier(schema)} TO ${identifier(role)}`,
      );
      expect(
        (
          await f.engine.pool.query<{ allowed: boolean }>(
            "SELECT has_sequence_privilege($1,$2,'USAGE') AS allowed",
            [role, `${schema}.mr_ledger_posting_order_seq`],
          )
        ).rows[0]!.allowed,
      ).toBe(false);
      const job = await f.admit();
      const { input } = await f.packet(job);
      const store = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        authorize: async (client, context) => {
          await client.query(`SET LOCAL ROLE ${identifier(role)}`);
          return f.storeOptions.authorize(client, context);
        },
      });
      const before = await snapshot(f, schema);
      await expect(store.grant(input, f.context)).rejects.toMatchObject({ code: '42501' });
      expect(await snapshot(f, schema)).toEqual(before);
      await f.engine.pool.query(
        `GRANT USAGE ON SEQUENCE ${identifier(schema)}.mr_ledger_posting_order_seq TO ${identifier(role)}`,
      );
      const receipt = await store.grant(input, f.context);
      expect(receipt).toMatchObject({
        workspaceId: f.workspaceId,
        jobId: job.id,
        amountMicros: job.reservedMicros,
      });
      const credit = (
        await f.engine.pool.query<{ posting_order: string; amount_micros: string }>(
          'SELECT posting_order::text,amount_micros::text FROM mr_ledger WHERE id=$1',
          [receipt.creditLedgerId],
        )
      ).rows[0]!;
      expect(BigInt(credit.posting_order)).toBeGreaterThan(BigInt(before.sequence[0]!.last_value));
      expect(credit.amount_micros).toBe(String(job.reservedMicros));
      expect(
        (await store.getReceipt({ workspaceId: f.workspaceId, jobId: job.id }, f.context)).grant,
      ).toEqual(receipt);
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.poll).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (createdRole) {
        await f.engine.pool.query(`DROP OWNED BY ${identifier(role)}`);
        await f.engine.pool.query(`DROP ROLE ${identifier(role)}`);
      }
      await f.close();
    }
  });
});
