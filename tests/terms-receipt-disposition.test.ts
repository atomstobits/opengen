import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const native = Boolean(databaseUrl && process.env.TEST_NATIVE_POSTGRES === '1');
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/(?:postgres|opengen_test|opengen_identity_terms_[a-z0-9_]+|opengen_core_qualification_[a-z0-9_]+)$/.test(
      target.pathname,
    ) ||
    target.search ||
    target.hash
  )
    throw new Error('Receipt disposition tests require an explicit loopback fixture database.');
}
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected fixture identifier.');
  return `"${value}"`;
};
type Target = {
  issuer: string;
  subject: string;
  policyVersion: string;
  policyDigest: string;
  acceptedAtExact: string;
};
const values = (target: Target) => [
  target.issuer,
  target.subject,
  target.policyVersion,
  target.policyDigest,
  target.acceptedAtExact,
];
const predicate =
  'issuer=$1 AND subject=$2 AND policy_version=$3 AND policy_digest=$4 AND accepted_at=$5::timestamptz';
const receiptColumns = `issuer,subject,policy_version AS "policyVersion",policy_digest AS "policyDigest",accepted_at::text AS "acceptedAtExact"`;

async function guards(client: Pick<PoolClient, 'query'> | Pool, table: string) {
  return (
    await client.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname,tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname`,
      [table],
    )
  ).rows;
}
const enabled = [
  { tgname: 'mr_terms_receipts_no_truncate', tgenabled: 'O' },
  { tgname: 'mr_terms_receipts_no_update_delete', tgenabled: 'O' },
];
async function snapshot(pool: Pool, table: string) {
  return (
    await pool.query<{ value: string }>(
      `SELECT row_to_json(t)::text AS value FROM ${table} t ORDER BY row_to_json(t)::text COLLATE "C"`,
    )
  ).rows;
}
async function ordinaryMutationsFail(pool: Pool, table: string) {
  for (const sql of [
    `UPDATE ${table} SET policy_digest=repeat('f',64)`,
    `DELETE FROM ${table}`,
    `TRUNCATE ${table}`,
  ])
    await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' });
  expect(await guards(pool, table)).toEqual(enabled);
}

/** Qualification fixture ONLY: not exported, imported by runtime, or a disposition eligibility engine.
 * The protected operator review chooses one eligible synthetic target before this transaction. */
async function disposeFixtureReceipt(
  pool: Pool,
  table: string,
  target: Target,
  afterDelete?: (client: PoolClient) => Promise<void>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await client.query("SET LOCAL lock_timeout='2s'");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    expect(
      (await client.query('SHOW session_replication_role')).rows[0]?.session_replication_role,
    ).toBe('origin');
    expect(await guards(client, table)).toEqual(enabled);
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER mr_terms_receipts_no_update_delete`);
    expect(await guards(client, table)).toEqual([
      enabled[0],
      { tgname: 'mr_terms_receipts_no_update_delete', tgenabled: 'D' },
    ]);
    const result = await client.query<Target>(
      `DELETE FROM ${table} WHERE ${predicate} RETURNING ${receiptColumns}`,
      values(target),
    );
    if (result.rowCount !== 1) throw new Error('receipt_disposition_target_mismatch');
    expect(result.rows).toEqual([target]);
    await afterDelete?.(client);
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER mr_terms_receipts_no_update_delete`);
    expect(await guards(client, table)).toEqual(enabled);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function withFixture(
  run: (fixture: {
    pool: Pool;
    schema: string;
    table: string;
    target: Target;
    peer: Target;
  }) => Promise<void>,
) {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'terms_disposition');
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      poolSize: 3,
      providerEnv: {},
      adapters: [],
      providerExecutionEnabled: false,
    }),
  );
  try {
    await engine.initialize();
    const store = new TermsReceiptStore(engine.pool);
    const original = {
      issuer: 'https://identity.fixture.invalid/disposition',
      subject: 'eligible-fixture-person',
      policyVersion: 'terms-disposition-fixture-v1',
      policyDigest: 'a'.repeat(64),
    };
    await store.recordVerifiedAcceptance(original);
    await store.recordVerifiedAcceptance({ ...original, subject: 'retained-fixture-peer' });
    await store.recordVerifiedAcceptance({
      ...original,
      policyVersion: 'terms-disposition-fixture-v2',
      policyDigest: 'b'.repeat(64),
    });
    await store.recordVerifiedAcceptance({ ...original, issuer: `${original.issuer}/other` });
    const table = `${identifier(isolated.schema)}.mr_terms_receipts`;
    const target = (
      await engine.pool.query<Target>(
        `SELECT ${receiptColumns} FROM ${table} WHERE issuer=$1 AND subject=$2 AND policy_version=$3`,
        [original.issuer, original.subject, original.policyVersion],
      )
    ).rows[0]!;
    const peer = (
      await engine.pool.query<Target>(
        `SELECT ${receiptColumns} FROM ${table} WHERE issuer=$1 AND subject='retained-fixture-peer'`,
        [original.issuer],
      )
    ).rows[0]!;
    await run({ pool: engine.pool, schema: isolated.schema, table, target, peer });
  } finally {
    try {
      await engine.close();
    } finally {
      await isolated.close();
    }
  }
}

describe.skipIf(!databaseUrl)('owner-only exact Terms receipt disposition qualification', () => {
  it('deletes only the approved full-precision target and restores ordinary guards before commit', async () =>
    withFixture(async ({ pool, table, target, peer }) => {
      const before = await snapshot(pool, table);
      await ordinaryMutationsFail(pool, table);
      await disposeFixtureReceipt(pool, table, target);
      expect(
        (
          await pool.query(
            `SELECT ${receiptColumns} FROM ${table} WHERE ${predicate}`,
            values(target),
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await pool.query(
            `SELECT ${receiptColumns} FROM ${table} WHERE ${predicate}`,
            values(peer),
          )
        ).rows,
      ).toEqual([peer]);
      const remaining = await snapshot(pool, table);
      expect(remaining).toEqual(
        before.filter((row) => {
          const value = JSON.parse(row.value);
          return !(
            value.issuer === target.issuer &&
            value.subject === target.subject &&
            value.policy_version === target.policyVersion
          );
        }),
      );
      expect(remaining).toHaveLength(3);
      await ordinaryMutationsFail(pool, table);
    }));

  it('rolls back data and transactional trigger changes after failure following DELETE', async () =>
    withFixture(async ({ pool, table, target, peer }) => {
      const before = await snapshot(pool, table);
      await ordinaryMutationsFail(pool, table);
      await expect(
        disposeFixtureReceipt(pool, table, target, async (client) => {
          expect(
            (
              await client.query(
                `SELECT ${receiptColumns} FROM ${table} WHERE ${predicate}`,
                values(target),
              )
            ).rows,
          ).toEqual([]);
          expect(
            (
              await client.query(
                `SELECT ${receiptColumns} FROM ${table} WHERE ${predicate}`,
                values(peer),
              )
            ).rows,
          ).toEqual([peer]);
          // Use a real server error to abort the transaction after the guarded row was deleted.
          await client.query('SELECT 1/0');
        }),
      ).rejects.toMatchObject({ code: '22012' });
      expect(await snapshot(pool, table)).toEqual(before);
      await ordinaryMutationsFail(pool, table);
    }));

  it('fails closed and rolls back every identity/version/digest/timestamp mismatch', async () =>
    withFixture(async ({ pool, table, target }) => {
      const before = await snapshot(pool, table);
      const differentTime = (
        await pool.query("SELECT ($1::timestamptz + interval '1 microsecond')::text AS value", [
          target.acceptedAtExact,
        ])
      ).rows[0].value;
      for (const mismatched of [
        { ...target, issuer: 'https://different.fixture.invalid' },
        { ...target, subject: 'different-subject' },
        { ...target, policyVersion: 'terms-not-approved' },
        { ...target, policyDigest: 'e'.repeat(64) },
        { ...target, acceptedAtExact: differentTime },
      ]) {
        await expect(disposeFixtureReceipt(pool, table, mismatched)).rejects.toThrow(
          'receipt_disposition_target_mismatch',
        );
        expect(await snapshot(pool, table)).toEqual(before);
        await ordinaryMutationsFail(pool, table);
      }
    }));

  it('rejects an old approval tuple after a later verified acceptance recreates the identity/policy receipt', async () =>
    withFixture(async ({ pool, table, target }) => {
      await disposeFixtureReceipt(pool, table, target);
      await new TermsReceiptStore(pool).recordVerifiedAcceptance({
        issuer: target.issuer,
        subject: target.subject,
        policyVersion: target.policyVersion,
        policyDigest: target.policyDigest,
      });
      const replacement = (
        await pool.query<Target>(
          `SELECT ${receiptColumns} FROM ${table} WHERE issuer=$1 AND subject=$2 AND policy_version=$3`,
          [target.issuer, target.subject, target.policyVersion],
        )
      ).rows[0]!;
      expect(replacement.acceptedAtExact).not.toBe(target.acceptedAtExact);
      const beforeStaleAttempt = await snapshot(pool, table);
      await expect(disposeFixtureReceipt(pool, table, target)).rejects.toThrow(
        'receipt_disposition_target_mismatch',
      );
      expect(await snapshot(pool, table)).toEqual(beforeStaleAttempt);
      await ordinaryMutationsFail(pool, table);
    }));

  it.skipIf(!native)(
    'cannot disable guards as a restricted non-owner native fixture role',
    async (context) =>
      withFixture(async ({ pool, schema, table }) => {
        const capabilities = (
          await pool.query<{ rolsuper: boolean }>(
            'SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname=current_user',
          )
        ).rows[0];
        if (!capabilities?.rolsuper)
          context.skip(
            'Disposable native cluster superuser is required to create/remove this isolated role fixture.',
          );
        const role = `terms_disposition_${randomUUID().replaceAll('-', '')}`;
        const quotedRole = identifier(role);
        let created = false;
        try {
          await pool.query(
            `CREATE ROLE ${quotedRole} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
          );
          created = true;
          await pool.query(`GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${quotedRole}`);
          // Deliberately grant DML: 55000 below proves the table's guards, rather than missing DELETE privileges.
          await pool.query(
            `GRANT SELECT,INSERT,UPDATE,DELETE,TRUNCATE ON ${table} TO ${quotedRole}`,
          );
          const before = await snapshot(pool, table);
          const client = await pool.connect();
          try {
            for (const [sql, code] of [
              [`ALTER TABLE ${table} DISABLE TRIGGER mr_terms_receipts_no_update_delete`, '42501'],
              [`UPDATE ${table} SET policy_digest=repeat('f',64)`, '55000'],
              [`DELETE FROM ${table}`, '55000'],
              [`TRUNCATE ${table}`, '55000'],
            ]) {
              await client.query('BEGIN');
              try {
                await client.query(`SET LOCAL ROLE ${quotedRole}`);
                expect((await client.query('SELECT current_user AS name')).rows[0].name).toBe(role);
                expect(
                  (await client.query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n,
                ).toBe(4);
                await expect(client.query(sql!)).rejects.toMatchObject({ code });
              } finally {
                await client.query('ROLLBACK');
              }
            }
          } finally {
            client.release();
          }
          expect(await snapshot(pool, table)).toEqual(before);
          await ordinaryMutationsFail(pool, table);
        } finally {
          if (created) {
            await pool.query(`REVOKE ALL PRIVILEGES ON ${table} FROM ${quotedRole}`);
            await pool.query(
              `REVOKE ALL PRIVILEGES ON SCHEMA ${identifier(schema)} FROM ${quotedRole}`,
            );
            await pool.query(`DROP ROLE ${quotedRole}`);
          }
        }
      }),
  );
});
