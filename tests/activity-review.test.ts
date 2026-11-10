import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityStore } from '../packages/engine/src/activity.js';

let pg: PGlite | null = null;
let nativePool: Pool | null = null;
let nativeClient: PoolClient | null = null;
const schema = `activity_review_${randomUUID().replaceAll('-', '')}`;
const db = {
  query: (sql: string, values?: unknown[]) =>
    nativeClient ? nativeClient.query(sql, values) : pg!.query(sql, values),
  exec: async (sql: string) => (nativeClient ? nativeClient.query(sql) : pg!.exec(sql)),
};
const store = new ActivityStore(db as unknown as Pool);
async function add(workspace: string, at: string, input: Record<string, unknown>) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,
    deployment_snapshot,status,reserved_micros,created_at,completed_at)
    VALUES($1::uuid,$2,$1::text,'fixture',$3,'{"id":"route"}',
      '{"id":"deployment","providerId":"provider","endpointRegion":"eu"}',
      'succeeded',0,$4,$4::timestamptz+interval '1 second')`,
    [
      id,
      workspace,
      JSON.stringify({ modelId: 'exact/model', operation: 'text-to-image', input }),
      at,
    ],
  );
  return id;
}

beforeAll(async () => {
  if (process.env.TEST_DATABASE_URL) {
    nativePool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    nativeClient = await nativePool.connect();
    await nativeClient.query(`CREATE SCHEMA ${schema}`);
    await nativeClient.query(`SET search_path TO ${schema}`);
  } else pg = new PGlite();
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/001.sql', import.meta.url), 'utf8'),
  );
  await db.exec(`ALTER TABLE mr_jobs ADD COLUMN attribution jsonb, ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}', ADD COLUMN delivery_status text;
    INSERT INTO mr_workspaces(id,available_micros) VALUES ('precision',0),('cohorts',0),('accounting',0);`);
  await db.exec(
    await readFile(
      new URL('../packages/engine/schema-proposals/activity-indexes.sql', import.meta.url),
      'utf8',
    ),
  );
}, 120_000);
afterAll(async () => {
  if (nativeClient) {
    await nativeClient.query('SET search_path TO public');
    await nativeClient.query(`DROP SCHEMA ${schema} CASCADE`);
    nativeClient.release();
  }
  await nativePool?.end();
  await pg?.close();
}, 30_000);

describe('Activity review regressions', () => {
  it('honors microsecond since and exclusive-until filters without Date rounding', async () => {
    await add('precision', '2026-11-04T01:00:00.123100Z', {});
    const atBoundary = await add('precision', '2026-11-04T01:00:00.123456Z', {});
    const afterBoundary = await add('precision', '2026-11-04T01:00:00.123789Z', {});
    await add('precision', '2026-11-04T01:00:00.123790Z', {});
    const page = await store.list('precision', {
      since: '2026-11-04T01:00:00.123456Z',
      until: '2026-11-04T01:00:00.123790Z',
    });
    expect(page.items.map((row) => row.id)).toEqual([afterBoundary, atBoundary]);
    const offsetPage = await store.list('precision', {
      since: '2026-11-03T18:00:00.123456-07:00',
      until: '2026-11-03T18:00:00.123790-07:00',
    });
    expect(offsetPage.items.map((row) => row.id)).toEqual([afterBoundary, atBoundary]);
  });

  it('separates material output and size settings while prompts stay out of cohort identity', async () => {
    const inputs = [
      { prompt: 'private one', resolution: '1024', outputFormat: 'png' },
      { prompt: 'private two', resolution: '1024', outputFormat: 'png' },
      { prompt: 'private three', resolution: '1024', outputFormat: 'jpeg' },
      {
        prompt: 'private four',
        resolution: '1024',
        outputFormat: 'png',
        size: { width: 512, height: 512 },
      },
      {
        prompt: 'private five',
        resolution: '1024',
        outputFormat: 'png',
        size: { width: 768, height: 512 },
      },
    ];
    for (const input of inputs) await add('cohorts', '2026-11-04T02:00:00Z', input);
    const report = await store.analytics('cohorts', {
      since: '2026-11-04T00:00:00Z',
      until: '2026-11-05T00:00:00Z',
    });
    expect(report.sampleCount).toBe(5);
    expect(report.cohorts).toHaveLength(4);
    expect(report.cohorts.map((cohort) => cohort.sampleCount).sort()).toEqual([1, 1, 1, 2]);
    for (const input of inputs) expect(JSON.stringify(report)).not.toContain(input.prompt);
  });

  it('marks malformed deltas and release-without-settlement as mismatches', async () => {
    async function reservation() {
      const id = await add('accounting', '2026-11-04T02:00:00Z', {});
      await db.query('UPDATE mr_jobs SET reserved_micros=100 WHERE id=$1', [id]);
      return id;
    }
    const badDeltas = await reservation(),
      releaseOnly = await reservation(),
      correct = await reservation();
    for (const id of [badDeltas, correct]) {
      await db.query('UPDATE mr_jobs SET settled_micros=60 WHERE id=$1', [id]);
      await db.query(
        `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
        VALUES($1,'accounting',$2,'reserve',100,-100,$3),($4,'accounting',$2,'settle',60,0,-60),
          ($5,'accounting',$2,'release',40,40,$6)`,
        [
          randomUUID(),
          id,
          id === badDeltas ? 90 : 100,
          randomUUID(),
          randomUUID(),
          id === badDeltas ? -30 : -40,
        ],
      );
    }
    await db.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
      VALUES($1,'accounting',$2,'reserve',100,-100,100),($3,'accounting',$2,'release',100,100,-100)`,
      [randomUUID(), releaseOnly, randomUUID()],
    );
    const rows = new Map((await store.list('accounting')).items.map((row) => [row.id, row]));
    expect(rows.get(badDeltas)).toMatchObject({ accountingState: 'mismatch', heldMicros: null });
    expect(rows.get(releaseOnly)).toMatchObject({ accountingState: 'mismatch', heldMicros: null });
    expect(rows.get(correct)).toMatchObject({
      accountingState: 'reconciled',
      heldMicros: 0,
      settledMicros: 60,
    });
  });

  it('uses bounded descending cursor/filter indexes on realistic synthetic rows', async () => {
    await db.exec(`INSERT INTO mr_workspaces(id,available_micros)
      SELECT 'plan-'||n,0 FROM generate_series(0,9) n;
      INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,
        status,reserved_micros,created_at,attribution,metadata)
      SELECT md5('activity-plan-'||n)::uuid,'plan-'||(n%10),n::text,'fixture',
        jsonb_build_object('modelId','model-'||(n%51),'operation','operation-'||(n%7),'input',jsonb_build_object('prompt',repeat('private fixture ',20))),
        jsonb_build_object('id','route-'||(n%41)),
        jsonb_build_object('id','deployment-'||(n%41),'providerId','provider-'||(n%17),'endpointRegion','region-'||(n%13)),
        CASE WHEN n%3=0 THEN 'succeeded' ELSE 'running' END,0,
        '2026-11-04T03:00:00Z'::timestamptz-n*interval '1 second',
        jsonb_build_object('kind','api','keyId','key-'||(n%31)),jsonb_build_object('project','project-'||(n%23))
      FROM generate_series(1,12000) n;
      ANALYZE mr_jobs;`);
    const predicates = [
      ['', undefined, 'mr_jobs_activity_cursor'],
      [" AND input->>'modelId'=$2", 'model-10', 'mr_jobs_activity_model'],
      [" AND deployment_snapshot->>'providerId'=$2", 'provider-10', 'mr_jobs_activity_provider'],
      [" AND deployment_snapshot->>'id'=$2", 'deployment-10', 'mr_jobs_activity_deployment'],
      [" AND deployment_snapshot->>'endpointRegion'=$2", 'region-10', 'mr_jobs_activity_region'],
      [" AND input->>'operation'=$2", 'operation-3', 'mr_jobs_activity_operation'],
      [' AND status=$2', 'succeeded', 'mr_jobs_activity_status'],
      [" AND attribution->>'keyId'=$2", 'key-10', 'mr_jobs_activity_key'],
      [" AND metadata->>'project'=$2", 'project-10', 'mr_jobs_activity_project'],
    ] as const;
    for (const [predicate, value, expectedIndex] of predicates) {
      const result = await db.query(
        `EXPLAIN (FORMAT JSON) SELECT id FROM mr_jobs
        WHERE workspace_id=$1${predicate} ORDER BY created_at DESC,id DESC LIMIT 26`,
        value === undefined ? ['plan-0'] : ['plan-0', value],
      );
      expect(JSON.stringify(result.rows), expectedIndex).toContain(expectedIndex);
    }
    // The real service SQL keeps LIMIT before the per-job ledger join; EXPLAIN its
    // captured query rather than relying only on simplified index probes above.
    let sql = '',
      values: unknown[] = [];
    const captured = new ActivityStore({
      query: async (statement: string, args: unknown[]) => {
        sql = statement;
        values = args;
        return db.query(statement, args);
      },
    } as unknown as Pool);
    expect((await captured.list('plan-0', { limit: 25 })).items).toHaveLength(25);
    const result = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, values);
    expect(JSON.stringify(result.rows)).toContain('mr_jobs_activity_cursor');
  }, 60_000);
});
