import { describe, expect, it } from 'vitest';
import { billingFixture } from './billing-fixture.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'original-card-payment authentication capability',
  () => {
    it('requires current explicit owner and versions, preserves PI/amount and never credits from recovery', async () => {
      const f = await billingFixture();
      try {
        const attempt = (await f.recharge.admit(f.workspace))!;
        const transport = {
          ...f.transport,
          async createRecharge(input: Parameters<typeof f.transport.createRecharge>[0]) {
            const value = {
              ...(await f.transport.createRecharge(input)),
              status: 'requires_action',
              authentication_required: true,
            };
            f.payments.set(value.id, value);
            return value;
          },
        };
        await f.recharge.dispatch(attempt.id, transport);
        const payment = [...f.payments.values()][0]!;
        let authorized = 0,
          reads = 0;
        const recovery = {
          ...f.processorProof,
          async retrieveRechargeRecovery(id: string) {
            reads++;
            expect(id).toBe(payment.id);
            return { payment, methodType: 'card', clientSecret: `${payment.id}_secret_fixture` };
          },
        };
        await expect(
          f.recharge.authentication(
            f.workspace,
            attempt.id,
            { expectedPolicyVersion: 1, expectedAuthorityVersion: 1 },
            async () => {
              throw Object.assign(new Error('Owner removed'), { statusCode: 403 });
            },
            recovery,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(reads).toBe(0);
        await expect(
          f.recharge.authentication(
            f.workspace,
            attempt.id,
            { expectedPolicyVersion: 2, expectedAuthorityVersion: 1 },
            async () => {},
            recovery,
          ),
        ).rejects.toMatchObject({ code: 'billing_policy_conflict' });
        const value = await f.recharge.authentication(
          f.workspace,
          attempt.id,
          { expectedPolicyVersion: 1, expectedAuthorityVersion: 1 },
          async () => {
            authorized++;
          },
          recovery,
        );
        expect(value).toMatchObject({
          attemptId: attempt.id,
          paymentIntentId: payment.id,
          amountCents: 1000,
        });
        expect(authorized).toBe(2);
        expect(f.creates).toHaveLength(1);
        expect(
          (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
        ).toBe('0');
        expect(
          JSON.stringify((await f.pool.query('SELECT * FROM mr_billing_recharge_attempts')).rows),
        ).not.toContain('_secret_');
        const paid = await f.paid(payment.id);
        await f.recharge.reconcile(f.event(paid), f.transport);
        expect(
          (await f.pool.query("SELECT count(*) FROM mr_ledger WHERE kind='credit'")).rows[0].count,
        ).toBe('1');
      } finally {
        await f.close();
      }
    });
    it('revalidates owner after GET and refuses capabilities if authority changes while the response is fetched', async () => {
      const f = await billingFixture();
      try {
        const attempt = (await f.recharge.admit(f.workspace))!;
        await f.recharge.dispatch(attempt.id, {
          ...f.transport,
          async createRecharge(input) {
            const value = {
              ...(await f.transport.createRecharge(input)),
              status: 'requires_action',
            };
            f.payments.set(value.id, value);
            return value;
          },
        });
        const payment = [...f.payments.values()][0]!;
        await expect(
          f.recharge.authentication(
            f.workspace,
            attempt.id,
            { expectedPolicyVersion: 1, expectedAuthorityVersion: 1 },
            async () => {},
            {
              ...f.processorProof,
              async retrieveRechargeRecovery() {
                await f.pool.query(
                  'UPDATE mr_billing_owners SET authority_version=2 WHERE workspace_id=$1',
                  [f.workspace],
                );
                return {
                  payment,
                  clientSecret: `${payment.id}_secret_fixture`,
                  methodType: 'card',
                };
              },
            },
          ),
        ).rejects.toMatchObject({ code: 'billing_policy_conflict' });
        expect((await f.recharge.get(f.workspace, attempt.id)).status).toBe(
          'requires_authentication',
        );
        expect(f.creates).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  },
);
