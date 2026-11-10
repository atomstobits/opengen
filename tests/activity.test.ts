import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let embedded: PGlite | null = null;
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) {
    embedded = new PGlite();
    await embedded.waitReady;
  }
}, 120_000);
afterAll(async () => {
  await embedded?.close();
}, 30_000);
import { ActivityStore, parseActivityFilters } from '../packages/engine/src/activity.js';
import { registerActivity } from '../apps/server/src/activity.js';

async function fixture<T>(
  run: (store: ActivityStore, pool: Pool, workspace: string) => Promise<T>,
) {
  const native = process.env.TEST_DATABASE_URL;
  const db = native ? new Pool({ connectionString: native }) : embedded!;
  const pool = db as unknown as Pool;
  // Dedicated schema keeps native tests isolated from the global executor and other packages.
  const schema = `activity_${randomUUID().replaceAll('-', '')}`;
  const client = native ? await pool.connect() : null;
  const query = client ? client.query.bind(client) : pool.query.bind(pool);
  try {
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}`);
    const sql = await readFile(
      fileURLToPath(new URL('../packages/engine/migrations/001.sql', import.meta.url)),
      'utf8',
    );
    // PGlite query accepts one statement; exec supports the baseline multi-statement migration.
    if (native) await query(sql);
    else await (db as PGlite).exec(sql);
    await query(
      'ALTER TABLE mr_jobs ADD COLUMN attribution jsonb, ADD COLUMN metadata jsonb, ADD COLUMN delivery_status text',
    );
    const workspace = `fixture-${randomUUID()}`;
    await query('INSERT INTO mr_workspaces(id,available_micros) VALUES ($1,1000000),($2,1000000)', [
      workspace,
      'other',
    ]);
    const scopedPool = { query } as unknown as Pool;
    return await run(new ActivityStore(scopedPool), scopedPool, workspace);
  } finally {
    await query('SET search_path TO public');
    await query(`DROP SCHEMA ${schema} CASCADE`);
    client?.release();
    if (native) await pool.end();
  }
}
async function add(
  pool: Pool,
  workspace: string,
  options: {
    id?: string;
    at?: string;
    model?: string;
    status?: string;
    key?: string;
    project?: string;
    ledger?: boolean;
    settled?: number;
    amount?: number;
    deployment?: string;
  } = {},
) {
  const id = options.id ?? randomUUID(),
    amount = options.amount ?? 100;
  await pool.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,
    deployment_snapshot,status,reserved_micros,settled_micros,created_at,completed_at,attribution,metadata)
    VALUES($1::uuid,$2,$1::text,'hash',$3,$4,$5,$6,$7,$8,$9,CASE WHEN $6='succeeded' THEN $9::timestamptz+interval '2 seconds' ELSE NULL END,$10,$11)`,
    [
      id,
      workspace,
      JSON.stringify({
        modelId: options.model ?? 'exact/model',
        operation: 'text-to-image',
        input: {
          prompt: 'PRIVATE PROMPT',
          resolution: '1024',
          references: [{ url: 'PRIVATE_URL' }],
        },
      }),
      JSON.stringify({ id: 'route', credentialEnv: 'PRIVATE_CREDENTIAL' }),
      JSON.stringify({
        id: options.deployment ?? 'deployment',
        providerId: 'provider',
        endpointRegion: 'eu',
      }),
      options.status ?? 'running',
      amount,
      options.settled ?? null,
      options.at ?? '2026-11-04T01:00:00.123456Z',
      options.key
        ? JSON.stringify({ kind: 'api', keyId: options.key, membershipId: null, grantId: null })
        : null,
      options.project
        ? JSON.stringify({ project: options.project, tags: { campaign: 'PRIVATE_TAG' } })
        : null,
    ],
  );
  if (options.ledger !== false) {
    await pool.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
      VALUES($1,$2,$3,'reserve',$4,-$4::bigint,$4)`,
      [randomUUID(), workspace, id, amount],
    );
    if (options.settled !== undefined) {
      await pool.query(
        `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
        VALUES($1,$2,$3,'settle',$4,0,-$4::bigint),($5,$2,$3,'release',$6,$6,-$6::bigint)`,
        [randomUUID(), workspace, id, options.settled, randomUUID(), amount - options.settled],
      );
    }
  }
  return id;
}

describe('private compact Activity', () => {
  it('validates strict bounded filters and explicit timezone/date semantics', () => {
    for (const input of [
      { limit: 101 },
      { limit: 0 },
      { limit: '1.5' },
      { workspaceId: 'other' },
      { since: '2026-01-01' },
      { status: 'complete' },
      { since: '2026-11-05T00:00:00Z', until: '2026-11-04T00:00:00Z' },
    ])
      expect(() => parseActivityFilters(input)).toThrow();
    expect(parseActivityFilters({ limit: '25', since: '2026-11-03T18:00:00-07:00' })).toEqual({
      limit: 25,
      since: '2026-11-04T01:00:00.000000Z',
    });
  });
  it('traverses equal timestamps without duplicates or omissions and rejects cross-workspace/filter cursors', async () =>
    fixture(async (store, pool, ws) => {
      const expected = [];
      for (let i = 0; i < 6; i++) expected.push(await add(pool, ws));
      await add(pool, 'other');
      const first = await store.list(ws, { limit: 2 });
      await add(pool, ws, { at: '2026-11-04T02:00:00Z' });
      const second = await store.list(ws, { limit: 2, cursor: first.nextCursor! });
      const third = await store.list(ws, { limit: 2, cursor: second.nextCursor! });
      expect([...first.items, ...second.items, ...third.items].map((r) => r.id)).toEqual(
        expected.sort().reverse(),
      );
      expect(third.nextCursor).toBeNull();
      await expect(store.list('other', { cursor: first.nextCursor! })).rejects.toMatchObject({
        statusCode: 400,
      });
      await expect(
        store.list(ws, { cursor: first.nextCursor!, modelId: 'different' }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }));
  it('uses exact tenant/model/provider/deployment/region/operation/key/status/project/date filters', async () =>
    fixture(async (store, pool, ws) => {
      const wanted = await add(pool, ws, {
        key: 'key-1',
        project: 'film',
        status: 'succeeded',
        settled: 60,
      });
      await add(pool, ws, { model: 'different/model', key: 'key-1', project: 'film' });
      await add(pool, 'other', { key: 'key-1', project: 'film', status: 'succeeded', settled: 60 });
      const selection = {
        modelId: 'exact/model',
        providerId: 'provider',
        deploymentId: 'deployment',
        endpointRegion: 'eu',
        operation: 'text-to-image',
        keyId: 'key-1',
        status: 'succeeded',
        project: 'film',
        since: '2026-11-04T01:00:00Z',
        until: '2026-11-04T02:00:00Z',
      };
      expect((await store.list(ws, selection)).items.map((r) => r.id)).toEqual([wanted]);
      const analytics = await store.analytics(ws, selection);
      expect(analytics.byKey).toEqual([
        {
          keyId: 'key-1',
          sampleCount: 1,
          settledMicros: 60,
          heldMicros: 0,
          unknownAccountingCount: 0,
        },
      ]);
      expect(analytics.byTag).toEqual([
        {
          name: 'campaign',
          value: 'PRIVATE_TAG',
          sampleCount: 1,
          settledMicros: 60,
          heldMicros: 0,
          unknownAccountingCount: 0,
        },
      ]);

      for (const name of [
        'modelId',
        'providerId',
        'deploymentId',
        'endpointRegion',
        'operation',
        'keyId',
        'project',
      ])
        expect((await store.list(ws, { ...selection, [name]: "' OR true --" })).items).toEqual([]);
      const body = JSON.stringify(await store.list(ws));
      for (const privateData of [
        'PRIVATE PROMPT',
        'PRIVATE_URL',
        'PRIVATE_CREDENTIAL',
        'PRIVATE_TAG',
        'references',
        'outputs',
      ])
        expect(body).not.toContain(privateData);
    }));
  it('reconciles settled, held, zero-BYOK, missing ledger and inconsistent snapshots truthfully', async () =>
    fixture(async (store, pool, ws) => {
      const held = await add(pool, ws),
        settled = await add(pool, ws, { settled: 60, status: 'succeeded' });
      const byok = await add(pool, ws, { settled: 0, amount: 0, status: 'succeeded' });
      const missing = await add(pool, ws, { ledger: false, settled: 50 });
      const mismatch = await add(pool, ws);
      await pool.query('UPDATE mr_jobs SET settled_micros=17 WHERE id=$1', [mismatch]);
      const rows = new Map((await store.list(ws)).items.map((r) => [r.id, r]));
      expect(rows.get(held)).toMatchObject({
        heldMicros: 100,
        settledMicros: null,
        accountingState: 'reconciled',
        attribution: null,
        deliveryStatus: 'unverified',
      });
      expect(rows.get(settled)).toMatchObject({
        heldMicros: 0,
        settledMicros: 60,
        accountingState: 'reconciled',
      });
      expect(rows.get(byok)).toMatchObject({
        heldMicros: 0,
        settledMicros: 0,
        accountingState: 'reconciled',
      });
      expect(rows.get(missing)).toMatchObject({
        heldMicros: null,
        settledMicros: null,
        accountingState: 'unknown',
      });
      expect(rows.get(mismatch)).toMatchObject({
        heldMicros: null,
        settledMicros: null,
        accountingState: 'mismatch',
      });
      const report = await store.analytics(ws, {
        since: '2026-11-04T00:00:00Z',
        until: '2026-11-05T00:00:00Z',
      });
      expect(report).toMatchObject({
        sampleCount: 5,
        settledMicros: 60,
        heldMicros: 100,
        unknownAccountingCount: 2,
      });
      expect(report.cohorts[0]).toMatchObject({
        sampleCount: 5,
        succeeded: 2,
        unresolved: 3,
        providerOutcomeLatency: { sampleCount: 2, p50Ms: 2000 },
        queueLatency: null,
        deliveryLatency: null,
        endToEndLatency: null,
      });
      await expect(store.analytics(ws, { since: '2026-01-01T00:00:00Z' })).rejects.toThrow(
        /31 days/,
      );
      expect(
        (
          await store.analytics('other', {
            since: '2026-11-04T00:00:00Z',
            until: '2026-11-05T00:00:00Z',
          })
        ).sampleCount,
      ).toBe(0);
    }));
  it('legacy rows remain unknown and until is exclusive', async () =>
    fixture(async (store, pool, ws) => {
      await add(pool, ws, { at: '2026-11-04T01:00:00Z' });
      expect((await store.list(ws)).items[0]).toMatchObject({
        attribution: null,
        project: null,
        deliveryStatus: 'unverified',
      });
      expect((await store.list(ws, { keyId: 'key-1' })).items).toEqual([]);
      expect((await store.list(ws, { until: '2026-11-04T01:00:00Z' })).items).toEqual([]);
    }));
  it('authorizes before querying and never accepts client workspace scope', async () => {
    const calls: unknown[] = [];
    let allowed = false;
    const app = Fastify();
    await registerActivity(app, {
      activity: {
        list: async (...args: unknown[]) => {
          calls.push(args);
          return { items: [], nextCursor: null };
        },
      } as unknown as ActivityStore,
      authenticate: async (_request, scope) => {
        expect(scope).toBe('read');
        if (!allowed) throw Object.assign(new Error('Denied'), { statusCode: 403 });
        return { workspaceId: 'authorized', scopes: ['read'] } as any;
      },
    });
    expect((await app.inject({ url: '/v1/activity' })).statusCode).toBe(403);
    expect(calls).toEqual([]);
    allowed = true;
    expect((await app.inject({ url: '/v1/activity?workspaceId=other' })).statusCode).toBe(400);
    const result = await app.inject({ url: '/v1/activity?limit=20' });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(calls).toEqual([['authorized', { limit: 20 }]]);
    await app.close();
  });
});
