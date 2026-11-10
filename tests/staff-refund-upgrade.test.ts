import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEngine, creditWorkspaceInTransaction } from '@media-router/engine';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/(?:postgres|opengen_test|opengen_staff_refund_[a-z0-9_]+|opengen_core_qualification_[a-z0-9_]+)$/.test(
      target.pathname,
    ) ||
    target.search ||
    target.hash
  )
    throw new Error('Refund upgrade tests require an explicit loopback fixture database.');
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected fixture identifier.');
  return `"${value}"`;
};

it.skipIf(!databaseUrl)(
  'upgrades populated 027 through 028 without rewriting existing money, authority, jobs or hold resolutions',
  async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'refund_upgrade');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        adapters: [],
        providerEnv: {},
      }),
    );
    try {
      const db = engine.pool;
      await db.query(
        'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (let i = 1; i <= 27; i++) {
        const name = `${String(i).padStart(3, '0')}.sql`;
        const sql = await readFile(
          new URL(`../packages/engine/migrations/${name}`, import.meta.url),
          'utf8',
        );
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
          name,
          sha256(sql),
        ]);
      }
      const workspace = `refund-upgrade-${randomUUID()}`;
      const order = randomUUID();
      const member = randomUUID();
      const environment = {
        id: 'refund-upgrade-processor',
        accountId: 'acct_fixture',
        livemode: false,
      };
      await registerBillingProcessorEnvironmentInTransaction(db, environment);
      await engine.ensureWorkspace(workspace, 5_000_000);
      await db.query(
        "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://identity.invalid','refund-fixture','admin',now())",
        [member, workspace],
      );
      const epoch = (
        await db.query(
          'SELECT extract(epoch FROM accepted_at)::text AS value FROM mr_memberships WHERE id=$1',
          [member],
        )
      ).rows[0].value;
      await db.query(
        `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
          processor_environment_id,livemode,rails,consent_reference,approval_reference)
          VALUES($1,$2,$3,1,$4,false,
          '{"allowsEnabled":false,"maxThresholdMicros":100000000,"maxAmountCents":10000,
            "maxMonthlyCapCents":100000,"maxAttemptsPerMonth":100,"minCooldownSeconds":60,
            "maxFailureLimit":10}',
          'fixture-consent','fixture-approval')`,
        [workspace, member, epoch, environment.id],
      );
      await engine.accounts.createKey(workspace, {
        name: 'Upgrade fixture',
        scopes: ['read', 'generate'],
      });
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,
          status,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id,credited_at,
          processor_environment_id,processor_account_id)
          VALUES($1,$2,'original-funded-order',500,5000000,false,'credited','original-checkout-key',
          'fixture-upgrade','cs_test_upgrade','pi_upgrade',now(),$3,$4)`,
        [order, workspace, environment.id, environment.accountId],
      );
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await creditWorkspaceInTransaction(client, workspace, 5_000_000, `stripe-topup:${order}`);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      for (const [status, upstream] of [
        ['running', 'original-provider-task'],
        ['submission-unknown', null],
      ] as const) {
        const job = randomUUID();
        await db.query(
          `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,
            deployment_snapshot,status,upstream_id,reserved_micros,attempt_count)
            VALUES($1,$2,$3,'fixture-hash','{}','{}','{}',$4,$5,1000000,1)`,
          [job, workspace, randomUUID(), status, upstream],
        );
        await db.query(
          "INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,'fixture-route','fixture-deployment',$3)",
          [randomUUID(), job, status],
        );
        await db.query(
          'UPDATE mr_workspaces SET available_micros=available_micros-1000000,reserved_micros=reserved_micros+1000000 WHERE id=$1',
          [workspace],
        );
        await db.query(
          "INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,$3,'reserve',1000000,-1000000,1000000)",
          [randomUUID(), workspace, job],
        );
      }
      for (const event of ['evt_original_refund', 'evt_reviewed_refund']) {
        await db.query(
          `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,state,processor_environment_id)
            VALUES($1,'refund.updated','re_original','pi_upgrade',false,$2,'processed',$3)`,
          [event, order, environment.id],
        );
        await db.query(
          "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES($1,$2,$3,'refund.updated')",
          [event, workspace, order],
        );
      }
      await db.query(
        `INSERT INTO mr_billing_hold_resolutions(id,event_id,workspace_id,reference,note,evidence_url,actor)
          VALUES($1,'evt_reviewed_refund',$2,'previous-reviewed-case','Original reviewed fixture evidence',
          'https://cases.invalid/original','{"kind":"fixture-operator"}')`,
        [randomUUID(), workspace],
      );
      await db.query(
        "UPDATE mr_billing_holds SET resolved_at=now(),resolution_reference='previous-reviewed-case' WHERE event_id='evt_reviewed_refund'",
      );

      const columns = (
        await db.query<{ table_name: string; column_name: string }>(
          `SELECT table_name,column_name FROM information_schema.columns
           WHERE table_schema=$1 AND table_name LIKE 'mr_%' ORDER BY table_name,ordinal_position`,
          [isolated.schema],
        )
      ).rows;
      const oldColumns = new Map<string, string[]>();
      for (const row of columns) {
        if (row.table_name === 'mr_migrations') continue;
        oldColumns.set(row.table_name, [
          ...(oldColumns.get(row.table_name) ?? []),
          row.column_name,
        ]);
      }
      const snapshot = async () => {
        const result: Record<string, unknown> = {};
        for (const [table, names] of oldColumns)
          result[table] = (
            await db.query(
              `SELECT row_to_json(t)::text AS value FROM
               (SELECT ${names.map(identifier).join(',')} FROM ${identifier(table)}) t
               ORDER BY row_to_json(t)::text COLLATE "C"`,
            )
          ).rows;
        return result;
      };
      const before = await snapshot();
      const oldJournal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      await engine.initialize();
      expect(await snapshot()).toEqual(before);
      const afterJournal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
      expect(afterJournal.slice(0, 27)).toEqual(oldJournal);
      expect(afterJournal.map((row) => row.name)).toEqual(
        Array.from({ length: 31 }, (_, i) => `${String(i + 1).padStart(3, '0')}.sql`),
      );
      expect(afterJournal[27].checksum).toBe(
        sha256(
          await readFile(new URL('../packages/engine/migrations/028.sql', import.meta.url), 'utf8'),
        ),
      );
      expect(
        (
          await db.query<{ indexdef: string }>(
            `SELECT indexdef FROM pg_indexes WHERE schemaname=$1
             AND tablename='mr_staff_refund_observations'
             AND indexname='mr_staff_refund_observation_case_refund'`,
            [isolated.schema],
          )
        ).rows,
      ).toEqual([
        {
          indexdef: expect.stringContaining(
            'USING btree (processor_environment_id, case_id, refund_id)',
          ),
        },
      ]);
      expect(
        (
          await db.query(
            'SELECT event_id,stripe_event_id,source_kind,staff_refund_case_id FROM mr_billing_holds ORDER BY event_id',
          )
        ).rows,
      ).toEqual([
        {
          event_id: 'evt_original_refund',
          stripe_event_id: 'evt_original_refund',
          source_kind: 'stripe',
          staff_refund_case_id: null,
        },
        {
          event_id: 'evt_reviewed_refund',
          stripe_event_id: 'evt_reviewed_refund',
          source_kind: 'stripe',
          staff_refund_case_id: null,
        },
      ]);
      await engine.initialize();
      expect(await snapshot()).toEqual(before);
      expect((await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows).toEqual(
        afterJournal,
      );
      expect(await engine.getBalance(workspace)).toEqual({
        availableMicros: 8_000_000,
        reservedMicros: 2_000_000,
        currency: 'USD',
      });
    } finally {
      await engine.close();
      await isolated.close();
    }
  },
  60_000,
);
