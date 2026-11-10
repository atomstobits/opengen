import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { paymentFixture } from './payment-fixture.js';
import { creditWorkspaceInTransaction } from '../packages/engine/src/index.js';
import { PaymentStore } from '../packages/engine/src/payments.js';
import { RechargeStore } from '../packages/engine/src/billing-recharge.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import type {
  RechargePayment,
  RechargeAttemptRequest,
} from '../packages/engine/src/billing-customer.js';

export async function billingFixture(
  options: { max?: number; enabled?: boolean; credit?: typeof creditWorkspaceInTransaction } = {},
) {
  let now = new Date('2030-01-15T00:00:00.000Z');
  const f = await paymentFixture({ max: options.max, now: () => now.getTime() });
  for (let index = 13; index <= 25; index++)
    await f.pool.query(
      await readFile(
        new URL(
          `../packages/engine/migrations/${String(index).padStart(3, '0')}.sql`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
  const processorEnvironment = {
    id: 'fixture-billing-processor',
    accountId: 'acct_fixture',
    livemode: false,
  };
  const processorEnvironmentId = processorEnvironment.id;
  await registerBillingProcessorEnvironmentInTransaction(f.pool, processorEnvironment);
  const processorProof = { processorEnvironment, assertProcessorEnvironment() {} };
  const memberId = randomUUID(),
    customerId = `cus_fixture_${randomUUID().replaceAll('-', '')}`,
    setupId = randomUUID(),
    mandateId = randomUUID();
  await f.pool.query(
    "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://fixture.example','fixture-billing-owner','admin',now())",
    [memberId, f.workspace],
  );
  const epoch = (
    await f.pool.query(
      'SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1',
      [memberId],
    )
  ).rows[0].epoch;
  const ownerRails = {
    allowsEnabled: true,
    maxThresholdMicros: 100000000,
    maxAmountCents: 10000,
    maxMonthlyCapCents: 100000,
    maxAttemptsPerMonth: 100,
    minCooldownSeconds: 60,
    maxFailureLimit: 10,
  };
  await f.pool.query(
    "INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,processor_environment_id,livemode,rails,consent_reference,approval_reference) VALUES($1,$2,$3,1,$4,false,$5,'fixture-consent','fixture-owner-approval')",
    [f.workspace, memberId, epoch, processorEnvironmentId, JSON.stringify(ownerRails)],
  );
  await f.pool.query(
    "INSERT INTO mr_billing_customers(id,workspace_id,livemode,stripe_customer_id,status,stripe_idempotency_key,started_at,processor_environment_id,processor_account_id) VALUES($1,$2,false,$3,'ready',$4,$5,$6,$7)",
    [
      randomUUID(),
      f.workspace,
      customerId,
      randomUUID(),
      now,
      processorEnvironment.id,
      processorEnvironment.accountId,
    ],
  );
  await f.pool.query(
    "INSERT INTO mr_billing_setups(id,workspace_id,livemode,customer_id,client_key,stripe_idempotency_key,session_id,status,terms_version,terms_snapshot,authority_snapshot,human_membership_id,consent_reference,owner_authority_version,owner_consent_reference,owner_membership_epoch,started_at,expires_at,processor_environment_id,processor_account_id) VALUES($1,$2,false,$3,$4,$5,$6,'complete','fixture-v1','{}','{}',$7,$8,1,'fixture-consent',$11,$9,$10,$12,$13)",
    [
      setupId,
      f.workspace,
      customerId,
      randomUUID(),
      randomUUID(),
      `cs_fixture_${setupId}`,
      memberId,
      randomUUID(),
      now,
      new Date(now.getTime() + 3600000),
      epoch,
      processorEnvironment.id,
      processorEnvironment.accountId,
    ],
  );
  await f.pool.query(
    "INSERT INTO mr_billing_mandates(id,workspace_id,customer_id,payment_method_id,livemode,status,terms_version,terms_snapshot,consent_reference,human_membership_id,setup_id,owner_authority_version,owner_consent_reference,owner_membership_epoch,processor_environment_id,processor_account_id) VALUES($1,$2,$3,'pm_fixture',false,'active','fixture-v1','{}',$4,$5,$6,1,'fixture-consent',$7,$8,$9)",
    [
      mandateId,
      f.workspace,
      customerId,
      randomUUID(),
      memberId,
      setupId,
      epoch,
      processorEnvironment.id,
      processorEnvironment.accountId,
    ],
  );
  await f.pool.query(
    'INSERT INTO mr_billing_policies(workspace_id,enabled,threshold_micros,amount_cents,monthly_cap_cents,max_attempts_per_month,cooldown_seconds,failure_limit,mandate_id,version,owner_authority_version) VALUES($1,true,5000000,1000,5000,5,60,2,$2,1,1)',
    [f.workspace, mandateId],
  );
  const recharge = new RechargeStore(f.pool, {
    processorEnvironment,
    automaticChargesEnabled: options.enabled ?? true,
    authenticationRecoveryEnabled: options.enabled ?? true,
    creditInTransaction: options.credit ?? creditWorkspaceInTransaction,
    now: () => now,
    lockExternalInTransaction: (client) => f.store.lockExternalInTransaction(client),
    admitExternalInTransaction: (client, workspace) =>
      f.store.admitExternalInTransaction(client, workspace),
  });
  const creates: RechargeAttemptRequest[] = [],
    retrieves: string[] = [];
  const payments = new Map<string, RechargePayment>();
  const transport = {
    ...processorProof,
    async createRecharge(request: RechargeAttemptRequest) {
      creates.push(request);
      const id = `pi_fixture_${request.id.replaceAll('-', '')}`;
      if (!payments.has(id))
        payments.set(id, {
          id,
          customer: request.customerId,
          payment_method: request.paymentMethodId,
          currency: 'usd',
          amount: request.amountCents,
          amount_received: 0,
          status: 'processing',
          livemode: false,
        });
      return { ...payments.get(id)! };
    },
    async retrieveRecharge(id: string) {
      retrieves.push(id);
      if (!payments.has(id)) throw new Error('Unknown fixture payment.');
      return { ...payments.get(id)! };
    },
  };
  const event = (payment: RechargePayment, type = 'payment_intent.succeeded') => ({
    id: `evt_${randomUUID()}`,
    type,
    livemode: false,
    processorEnvironment,
    data: { object: { ...payment } },
  });
  return {
    ...f,
    processorProof,
    processorEnvironment,
    manual: new PaymentStore(f.pool, {
      livemode: false,
      processorEnvironment,
      creditInTransaction: creditWorkspaceInTransaction,
      now: () => now.getTime(),
    }),
    manualTransport: { ...f.transport, ...processorProof },
    transportForManual: f.transport,
    recharge,
    transport,
    creates,
    retrieves,
    payments,
    memberId,
    customerId,
    mandateId,
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    setNow: (at: string) => {
      now = new Date(at);
    },
    event,
    async paid(id: string) {
      const prior = payments.get(id)!;
      const paid = { ...prior, status: 'succeeded', amount_received: prior.amount };
      payments.set(id, paid);
      return paid;
    },
  };
}
