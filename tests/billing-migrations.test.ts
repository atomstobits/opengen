import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const native = Boolean(databaseUrl && process.env.TEST_NATIVE_POSTGRES === '1');
const hostedMigrationNames = Array.from(
  { length: 21 },
  (_, index) => String(index + 1).padStart(3, '0') + '.sql',
);
const addedMigrationNames = [
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
];
const migrationSql = (name: string) =>
  readFile(new URL('../packages/engine/migrations/' + name, import.meta.url), 'utf8');
const migrationChecksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

it.skipIf(!native)(
  'upgrades populated hosted 021 through aged-cost relief 031 without changing prior money or authority',
  async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_upgrade');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        adapters: [],
        providerEnv: {},
      }),
    );
    const workspace = 'billing-upgrade-fixture';
    const job = randomUUID();
    const order = randomUUID();
    const event = 'evt_legacy_fixture';
    try {
      const db = engine.pool;
      expect((await db.query('SELECT current_schema() AS name')).rows[0].name).toBe(
        isolated.schema,
      );
      await db.query(
        'CREATE TABLE mr_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const name of hostedMigrationNames) {
        const sql = await migrationSql(name);
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
          name,
          migrationChecksum(sql),
        ]);
      }
      await db.query(
        'INSERT INTO mr_workspaces(id,available_micros,reserved_micros) VALUES($1,940,60)',
        [workspace],
      );
      await db.query(
        "INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros) VALUES($1,$2,'original-job','fixture-hash','{}','{}','{}','submission-unknown',60)",
        [job, workspace],
      );
      await db.query(
        "INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,$3,'reserve',60,-60,60)",
        [randomUUID(), workspace, job],
      );
      const key = await engine.accounts.createKey(workspace, {
        name: 'Legacy generation fixture',
        scopes: ['read', 'generate'],
      });
      await db.query(
        "INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,stripe_idempotency_key,integration_identifier,checkout_started_at,checkout_expires_at) VALUES($1,$2,'legacy-order',500,5000000,false,'checkout_pending','legacy-external-request','legacy-fixture',now(),now()+interval '1 hour')",
        [order, workspace],
      );
      await db.query(
        "INSERT INTO mr_payment_events(id,type,object_id,livemode,order_id,state) VALUES($1,'charge.refunded','ch_fixture',false,$2,'processed')",
        [event, order],
      );
      await db.query(
        "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES($1,$2,$3,'charge.refunded')",
        [event, workspace, order],
      );

      // Capture only the existing financial and authorization data needed for
      // the upgrade assertions. All rows here are synthetic.
      const wallet = () => engine.getBalance(workspace);
      const ledger = () => engine.ledger(workspace);
      const legacyOrder = async () =>
        (
          await db.query(
            'SELECT id,status,amount_cents,credit_micros,stripe_idempotency_key,integration_identifier,checkout_started_at,checkout_expires_at FROM mr_payment_orders WHERE id=$1',
            [order],
          )
        ).rows[0];
      const migrationLog = async () =>
        (
          await db.query<{ name: string; checksum: string; applied_at: Date }>(
            'SELECT name,checksum,applied_at FROM mr_migrations ORDER BY name',
          )
        ).rows;
      const before = { wallet: await wallet(), ledger: await ledger(), order: await legacyOrder() };
      const historicalMigrations = await migrationLog();
      expect(historicalMigrations.map((item) => item.name)).toEqual(hostedMigrationNames);

      await engine.initialize();
      const upgradedMigrations = await migrationLog();
      expect(upgradedMigrations.slice(0, hostedMigrationNames.length)).toEqual(
        historicalMigrations,
      );
      const added = upgradedMigrations.slice(hostedMigrationNames.length);
      expect(added.map((item) => item.name)).toEqual(addedMigrationNames);
      for (const item of added) {
        expect(item.checksum).toBe(migrationChecksum(await migrationSql(item.name)));
      }
      await engine.initialize();
      expect(await migrationLog()).toEqual(upgradedMigrations);

      expect(await wallet()).toEqual(before.wallet);
      expect(await ledger()).toEqual(before.ledger);
      expect(await legacyOrder()).toEqual(before.order);
      expect(
        (
          await db.query(
            'SELECT checkout_request_version,checkout_api_version FROM mr_payment_orders WHERE id=$1',
            [order],
          )
        ).rows[0],
      ).toEqual({
        checkout_request_version: 'checkout_hosted_v1',
        checkout_api_version: '2026-10-28.endive',
      });
      expect(
        (await db.query('SELECT scopes FROM mr_api_keys WHERE id=$1', [key.id])).rows[0].scopes,
      ).toEqual(['read', 'generate']);
      expect(
        (
          await db.query(
            'SELECT status,reserved_micros,settled_micros,fee_admission,fee_settlement,fee_cost_evidence FROM mr_jobs WHERE id=$1',
            [job],
          )
        ).rows[0],
      ).toEqual({
        status: 'submission-unknown',
        reserved_micros: '60',
        settled_micros: null,
        fee_admission: null,
        fee_settlement: null,
        fee_cost_evidence: null,
      });
      expect(
        (
          await db.query(
            'SELECT processor_environment_id,processor_account_id FROM mr_payment_orders WHERE id=$1',
            [order],
          )
        ).rows[0],
      ).toEqual({ processor_environment_id: null, processor_account_id: null });
      expect(
        (
          await db.query(
            'SELECT order_id,recharge_attempt_id,resolved_at FROM mr_billing_holds WHERE event_id=$1',
            [event],
          )
        ).rows[0],
      ).toEqual({ order_id: order, recharge_attempt_id: null, resolved_at: null });
      expect(
        (
          await db.query('SELECT processor_environment_id FROM mr_payment_events WHERE id=$1', [
            event,
          ])
        ).rows[0].processor_environment_id,
      ).toBeNull();
      for (const table of [
        'mr_billing_owners',
        'mr_billing_delegations',
        'mr_billing_processor_environments',
        'mr_billing_mandates',
        'mr_billing_recharge_attempts',
        'mr_billing_payment_ownership',
        'mr_comparison_runs',
      ]) {
        const { rows } = await db.query('SELECT count(*)::integer AS count FROM ' + table);
        expect(rows[0].count).toBe(0);
      }
    } finally {
      try {
        await engine.close();
      } finally {
        await isolated.close();
      }
    }
  },
);

// Native dump/restore needs matching server tools. The dedicated qualification
// harness supplies the same explicit directory; omission is an explicit skip.
const pgBin = process.env.OPENGEN_CORE_QUALIFICATION_PG_BIN;
function pgTool(name: 'pg_dump' | 'pg_restore', args: string[], input?: Buffer): Buffer {
  const url = new URL(databaseUrl!);
  const result = spawnSync(join(pgBin!, name), args, {
    input,
    env: {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: url.pathname.slice(1),
      PGCONNECT_TIMEOUT: '5',
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0)
    throw new Error('Native billing fixture schema dump/restore failed.');
  return result.stdout;
}

it.skipIf(!native || !pgBin)(
  'preserves populated 026 legacy serializer identity through 027, native dump/restore and no-op restart',
  async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_restore');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        providerExecutionEnabled: false,
        adapters: [],
        providerEnv: {},
      }),
    );
    const db = engine.pool;
    const workspace = 'serializer-upgrade-restore';
    const id = randomUUID();
    let backup: Buffer | undefined;
    try {
      await db.query(
        'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (let index = 1; index <= 26; index++) {
        const name = `${String(index).padStart(3, '0')}.sql`,
          sql = await migrationSql(name);
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
          name,
          migrationChecksum(sql),
        ]);
      }
      await db.query(
        'INSERT INTO mr_workspaces(id,available_micros,reserved_micros) VALUES($1,5000000,0)',
        [workspace],
      );
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,
        livemode,status,stripe_idempotency_key,integration_identifier,checkout_started_at,checkout_expires_at,
        checkout_next_request_at) VALUES($1,$2,'pre027-request',500,5000000,false,'checkout_pending',
        'pre027-stripe-idempotency','pre027-integration',now()-interval '2 minutes',now()+interval '22 hours',now()-interval '1 minute')`,
        [id, workspace],
      );
      await db.query(
        `INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference)
        VALUES($1,$2,'credit',5000000,5000000,0,'historical-fixture-credit')`,
        [randomUUID(), workspace],
      );
      const orderBefore = (await db.query('SELECT * FROM mr_payment_orders WHERE id=$1', [id]))
        .rows[0];
      const historyBefore = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      await engine.initialize();
      const versioned = (await db.query('SELECT * FROM mr_payment_orders WHERE id=$1', [id]))
        .rows[0];
      expect(versioned).toEqual({
        ...orderBefore,
        checkout_request_version: 'checkout_hosted_v1',
        checkout_api_version: '2026-10-28.endive',
      });
      expect(
        (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows.slice(0, 26),
      ).toEqual(historyBefore);
      const snapshot = async () => {
        const tables = (
          await db.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [
            isolated.schema,
          ])
        ).rows.map((row) => row.tablename as string);
        const data: Record<string, unknown> = {};
        for (const table of tables) {
          expect(table).toMatch(/^[a-z][a-z0-9_]*$/);
          data[table] = (
            await db.query(
              `SELECT row_to_json(t)::text AS value FROM "${isolated.schema}"."${table}" t ORDER BY row_to_json(t)::text`,
            )
          ).rows;
        }
        return data;
      };
      const before = await snapshot();
      backup = pgTool('pg_dump', [
        '--format=custom',
        `--schema=${isolated.schema}`,
        '--no-owner',
        '--no-acl',
        '--no-password',
      ]);
      // Only the fixture's UUID schema is replaced. No database or other test
      // schema is dropped, and no CREATE DATABASE privilege is required.
      await db.query(`DROP SCHEMA "${isolated.schema}" CASCADE`);
      pgTool(
        'pg_restore',
        [
          '--dbname',
          new URL(databaseUrl!).pathname.slice(1),
          '--no-owner',
          '--no-acl',
          '--no-password',
          '--exit-on-error',
        ],
        backup,
      );
      expect(await snapshot()).toEqual(before);
      await engine.initialize();
      expect(await engine.workOnce()).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(await engine.getBalance(workspace)).toEqual({
        availableMicros: 5000000,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      backup?.fill(0);
      try {
        await engine.close();
      } finally {
        await isolated.close();
      }
    }
  },
  60_000,
);
