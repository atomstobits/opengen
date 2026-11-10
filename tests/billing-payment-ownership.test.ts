import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  canonicalFundingCreditReference,
  claimPaymentOwnershipInTransaction,
  resolvePaymentOwnershipInTransaction,
  type FundingKind,
  type PaymentOwnershipClaim,
} from '../packages/engine/src/billing-payment-ownership.js';
import type { CheckoutSession } from '../packages/engine/src/payments.js';
import { paymentFixture } from './payment-fixture.js';

const db = Boolean(process.env.TEST_DATABASE_URL);
const native = db && process.env.TEST_NATIVE_POSTGRES === '1';
const environment = { processorEnvironmentId: 'fixture-ownership-sandbox', livemode: false };
const otherEnvironment = 'fixture-ownership-other-sandbox';
const pi = () => `pi_fixture_${randomUUID().replaceAll('-', '')}`;

async function fixture(max = 1) {
  const f = await paymentFixture({ max });
  try {
    await f.pool.query(
      await readFile(new URL('../docs/billing/customer-schema.sql', import.meta.url), 'utf8'),
    );
    // Only the recharge identity columns are needed to exercise this helper.
    await f.pool.query(`CREATE TABLE mr_billing_recharge_attempts (
      id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES mr_workspaces(id),
      livemode boolean NOT NULL,processor_environment_id text NOT NULL,
      payment_intent_id text UNIQUE,amount_cents integer NOT NULL
    )`);
    await f.pool.query(
      `INSERT INTO mr_billing_processor_environments(id,account_id,livemode)
      VALUES($1,'acct_fixtureOwnership',false),($2,'acct_fixtureOwnershipOther',false)`,
      [environment.processorEnvironmentId, otherEnvironment],
    );
    await f.pool.query(
      await readFile(
        new URL('../docs/billing/payment-ownership-schema.sql', import.meta.url),
        'utf8',
      ),
    );
  } catch (error) {
    await f.close();
    throw error;
  }
  async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function local(
    kind: FundingKind,
    options: { workspaceId?: string; boundPI?: string; legacy?: boolean } = {},
  ) {
    const localId = randomUUID(),
      workspaceId = options.workspaceId ?? f.workspace;
    const sessionId = `cs_test_fixture_${localId.replaceAll('-', '')}`;
    if (kind === 'manual') {
      await f.pool.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id,processor_environment_id,processor_account_id)
        VALUES($1::uuid,$2,$1::text,1000,10000000,false,$1::text,'fixture-owner',$3,$4,$5,$6)`,
        [
          localId,
          workspaceId,
          sessionId,
          options.boundPI ?? null,
          options.legacy ? null : environment.processorEnvironmentId,
          options.legacy ? null : 'acct_fixtureOwnership',
        ],
      );
    } else {
      await f.pool.query(
        `INSERT INTO mr_billing_recharge_attempts(id,workspace_id,livemode,processor_environment_id,payment_intent_id,amount_cents) VALUES($1,$2,false,$3,$4,1000)`,
        [localId, workspaceId, environment.processorEnvironmentId, options.boundPI ?? null],
      );
    }
    const claim = (paymentIntentId: string): PaymentOwnershipClaim => ({
      ...environment,
      workspaceId,
      kind,
      localId,
      amountCents: 1000,
      paymentIntentId,
      creditReference: canonicalFundingCreditReference(kind, localId),
    });
    const session = (paymentIntentId: string): CheckoutSession => ({
      id: sessionId,
      mode: 'payment',
      currency: 'usd',
      amount_subtotal: 1000,
      amount_total: 1000,
      payment_status: 'paid',
      status: 'complete',
      client_reference_id: localId,
      payment_intent: paymentIntentId,
      livemode: false,
      url: null,
    });
    return { localId, workspaceId, claim, session };
  }
  return { ...f, tx, local };
}

describe.skipIf(!db)('authoritative shared payment ownership', () => {
  it('retains one canonical claim on replay and exposes the same owner to another observation', async () => {
    const f = await fixture();
    try {
      const manual = await f.local('manual'),
        intent = pi();
      const claim = manual.claim(intent);
      const accepted = await f.tx(async (client) => {
        const owner = await claimPaymentOwnershipInTransaction(client, claim);
        await client.query('UPDATE mr_payment_orders SET payment_intent_id=$2 WHERE id=$1', [
          manual.localId,
          intent,
        ]);
        return owner;
      });
      expect(await f.tx((client) => claimPaymentOwnershipInTransaction(client, claim))).toEqual(
        accepted,
      );
      expect(await f.tx((client) => resolvePaymentOwnershipInTransaction(client, claim))).toEqual(
        accepted,
      );
      expect(accepted).toMatchObject({
        currency: 'USD',
        kind: 'manual',
        creditReference: `stripe-topup:${manual.localId}`,
      });
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_billing_payment_ownership')).rows[0].count,
      ).toBe('1');
      expect((await f.pool.query('SELECT count(*) FROM mr_ledger')).rows[0].count).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('rejects conflicting workspace, funding kind, amount, reference or replacement PI', async () => {
    const f = await fixture();
    try {
      const automatic = await f.local('automatic'),
        manual = await f.local('manual'),
        intent = pi();
      await f.tx((client) => claimPaymentOwnershipInTransaction(client, automatic.claim(intent)));
      for (const claim of [
        manual.claim(intent),
        { ...automatic.claim(intent), workspaceId: 'foreign' },
        { ...automatic.claim(intent), amountCents: 1001 },
        { ...automatic.claim(intent), creditReference: 'different-credit' },
        { ...automatic.claim(pi()) },
      ]) {
        await expect(
          f.tx((client) => claimPaymentOwnershipInTransaction(client, claim)),
        ).rejects.toMatchObject({ code: 'payment_ownership_conflict', statusCode: 409 });
      }
      expect(
        (
          await f.pool.query(
            'SELECT kind,local_id,credit_reference FROM mr_billing_payment_ownership',
          )
        ).rows,
      ).toEqual([
        {
          kind: 'automatic',
          local_id: automatic.localId,
          credit_reference: `stripe-recharge:${automatic.localId}`,
        },
      ]);
    } finally {
      await f.close();
    }
  });
  it('keeps unknown legacy PI pending and guards both funding paths until a trusted original Checkout qualifies it', async () => {
    const f = await fixture();
    try {
      const intent = pi(),
        manual = await f.local('manual', { legacy: true, boundPI: intent }),
        automatic = await f.local('automatic');
      const claim = manual.claim(intent);
      expect(
        await f.tx((client) => resolvePaymentOwnershipInTransaction(client, claim)),
      ).toBeNull();
      await expect(
        f.tx((client) => claimPaymentOwnershipInTransaction(client, automatic.claim(intent))),
      ).rejects.toMatchObject({ code: 'payment_ownership_conflict' });
      await expect(
        f.tx((client) => claimPaymentOwnershipInTransaction(client, claim)),
      ).rejects.toMatchObject({ code: 'payment_environment_unqualified' });
      for (const patch of [
        { id: 'cs_test_foreign' },
        { client_reference_id: randomUUID() },
        { currency: 'eur' },
        { amount_total: 999 },
        { payment_intent: pi() },
      ]) {
        await expect(
          f.tx((client) =>
            claimPaymentOwnershipInTransaction(client, {
              ...claim,
              legacySession: { ...manual.session(intent), ...patch },
            }),
          ),
        ).rejects.toMatchObject({ code: 'payment_environment_unqualified' });
      }
      const verified = await f.tx((client) =>
        claimPaymentOwnershipInTransaction(client, {
          ...claim,
          legacySession: manual.session(intent),
        }),
      );
      expect(await f.tx((client) => resolvePaymentOwnershipInTransaction(client, claim))).toEqual(
        verified,
      );
      expect(
        await f.tx((client) =>
          resolvePaymentOwnershipInTransaction(client, {
            ...claim,
            processorEnvironmentId: otherEnvironment,
          }),
        ),
      ).toBeNull();
      expect(
        (
          await f.pool.query(
            'SELECT processor_environment_id,processor_account_id FROM mr_payment_orders WHERE id=$1',
            [manual.localId],
          )
        ).rows[0],
      ).toEqual({ processor_environment_id: null, processor_account_id: null });
    } finally {
      await f.close();
    }
  });
  it('routes frozen bindings only in their registered environment and rejects ambiguous preexisting cross-path binding', async () => {
    const f = await fixture();
    try {
      const intent = pi(),
        automatic = await f.local('automatic', { boundPI: intent });
      expect(
        await f.tx((client) =>
          resolvePaymentOwnershipInTransaction(client, automatic.claim(intent)),
        ),
      ).toMatchObject({ kind: 'automatic', localId: automatic.localId });
      expect(
        await f.tx((client) =>
          resolvePaymentOwnershipInTransaction(client, {
            ...automatic.claim(intent),
            processorEnvironmentId: otherEnvironment,
          }),
        ),
      ).toBeNull();
      await expect(
        f.tx((client) =>
          resolvePaymentOwnershipInTransaction(client, {
            ...automatic.claim(intent),
            livemode: true,
          }),
        ),
      ).rejects.toMatchObject({ code: 'payment_environment_unqualified' });
      await expect(
        f.pool.query(
          "INSERT INTO mr_billing_processor_environments(id,account_id,livemode) VALUES('duplicate-logical-namespace','acct_fixtureOwnership',false)",
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await f.local('manual', { legacy: true, boundPI: intent });
      await expect(
        f.tx((client) => resolvePaymentOwnershipInTransaction(client, automatic.claim(intent))),
      ).rejects.toMatchObject({ code: 'payment_ownership_conflict' });
      expect(
        (await f.pool.query('SELECT count(*) FROM mr_billing_payment_ownership')).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('rolls ownership back with the caller transaction and prevents mismatched tenant foreign keys', async () => {
    const f = await fixture();
    try {
      const manual = await f.local('manual'),
        intent = pi();
      await expect(
        f.tx(async (client) => {
          await claimPaymentOwnershipInTransaction(client, manual.claim(intent));
          throw new Error('abort binding');
        }),
      ).rejects.toThrow('abort binding');
      expect(
        await f.tx((client) => resolvePaymentOwnershipInTransaction(client, manual.claim(intent))),
      ).toBeNull();
      const foreign = `ws_${randomUUID()}`;
      await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [foreign]);
      await expect(
        f.pool.query(
          `INSERT INTO mr_billing_payment_ownership(processor_environment_id,livemode,payment_intent_id,workspace_id,kind,local_id,manual_order_id,amount_cents,credit_reference)
        VALUES($1,false,$2,$3,'manual',$4::uuid,$4::uuid,1000,$5)`,
          [
            environment.processorEnvironmentId,
            intent,
            foreign,
            manual.localId,
            `stripe-topup:${manual.localId}`,
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await f.close();
    }
  });
});

describe.skipIf(!native)('native PostgreSQL payment ownership race', () => {
  it('serializes cross-workspace manual and automatic claims on the same PI before workspace locks', async () => {
    const f = await fixture(4),
      client = await f.pool.connect();
    let competing: Promise<unknown> | undefined;
    try {
      const foreign = `ws_${randomUUID()}`,
        intent = pi();
      await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [foreign]);
      const manual = await f.local('manual'),
        automatic = await f.local('automatic', { workspaceId: foreign });
      await client.query('BEGIN');
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await claimPaymentOwnershipInTransaction(client, manual.claim(intent));
      await client.query('UPDATE mr_payment_orders SET payment_intent_id=$2 WHERE id=$1', [
        manual.localId,
        intent,
      ]);
      competing = f.tx((other) =>
        claimPaymentOwnershipInTransaction(other, automatic.claim(intent)),
      );
      void competing.catch(() => {});
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        blocked = Boolean(
          (
            await f.pool.query(
              'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1',
              [pid],
            )
          ).rowCount,
        );
        if (blocked) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      expect(blocked).toBe(true);
      await client.query('COMMIT');
      await expect(competing).rejects.toMatchObject({ code: 'payment_ownership_conflict' });
      expect(
        (await f.pool.query('SELECT kind,local_id FROM mr_billing_payment_ownership')).rows,
      ).toEqual([{ kind: 'manual', local_id: manual.localId }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      await Promise.allSettled(competing ? [competing] : []);
      await f.close();
    }
  });
});
