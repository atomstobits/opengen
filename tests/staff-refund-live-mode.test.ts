/** TRUE-mode LOCAL source qualification only. All money, providers, processor
 * events and signing material are synthetic. No live credentials or API issuer. */
import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import {
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
  type CheckoutSession,
  type PaymentTransport,
  type Principal,
  type ProviderAdapter,
} from '@media-router/engine';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import {
  StaffRefundStore,
  staffRefundHash,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../packages/engine/src/staff-refunds.js';
import { normalizeStaffRefundEvidence } from '../packages/engine/src/staff-refund-evidence.js';
import { ExistingStaffRefundController } from '../apps/server/src/staff-refund-existing-controller.js';
import { createStaffRefundEvidenceProducer } from '../apps/server/src/staff-refund-evidence-producer.js';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';
import { staffRefundTestDatabaseUrl } from './staff-refund-fixture.js';

const external = vi.hoisted(() => ({
  request: vi.fn(() => {
    throw new Error('TRUE-mode LOCAL fixtures forbid HTTPS requests.');
  }),
}));
vi.mock('node:https', async (original) => {
  const actual = await original<typeof import('node:https')>();
  return {
    ...actual,
    request: external.request,
    default: { ...actual.default, request: external.request },
  };
});
const noNetwork = vi.fn(async () => {
  throw new Error('TRUE-mode LOCAL fixtures forbid external fetch requests.');
});
let close: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(async () => {
  try {
    await close?.();
    expect(noNetwork).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  } finally {
    close = undefined;
    noNetwork.mockClear();
    external.request.mockClear();
    vi.unstubAllGlobals();
  }
});
const context = Object.freeze({ operator: 'synthetic-live-shaped-staff' });
const actor = { id: context.operator, kind: 'installation-operator' as const };
const staffRefundRoutes: [string, string] = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.0-pro',
];
const staffRefundInput: GenerateInput = {
  modelId: 'xai/grok-imagine-image-2.0',
  routeId: staffRefundRoutes[0],
  operation: 'text-to-image',
  billing: 'managed',
  routing: { fallback: false },
  input: { prompt: 'Synthetic private staff-refund accounting fixture.', count: 1 },
};
type StaffRefundJobBehavior = {
  submission?: 'known' | 'unknown';
  status?: 'running' | 'failed';
  billedCostMicros?: number | null;
  retryAfterMs?: number;
};

/** Full engine and real funding ledger, isolated to an ephemeral test schema.
 * Only TEST_DATABASE_URL is accepted; no application/production URL fallback.
 * Provider and processor transports below are entirely in-memory. */
async function liveFixture() {
  const databaseUrl = staffRefundTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const database = await isolatedEngineDatabase(databaseUrl, 'staff_refund_true');
  const behavior = new Map<string, StaffRefundJobBehavior>();
  const submit = vi.fn<ProviderAdapter['submit']>(async ({ jobId }) => {
    if (behavior.get(jobId)?.submission === 'unknown')
      throw new Error('Synthetic unknown acceptance; never send a replacement.');
    return { upstreamId: `fixture-original-${jobId}` };
  });
  const poll = vi.fn<ProviderAdapter['poll']>(async ({ jobId, upstreamId }) => {
    if (upstreamId !== `fixture-original-${jobId}`)
      throw new Error('The fixture may poll only the original provider task.');
    const result = behavior.get(jobId) ?? {};
    return {
      status: result.status ?? 'running',
      ...(result.status === 'failed' ? { failureCategory: 'technical' as const } : {}),
      ...(result.billedCostMicros === undefined
        ? {}
        : { billedCostMicros: result.billedCostMicros }),
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  });
  const engine = database.bind(
    createEngine({
      databaseUrl: database.databaseUrl,
      poolSize: 1,
      statusPoolSize: 1,
      storage: privateStorageFixture(),
      vaultKey: 'bc'.repeat(32),
      providerEnv: {},
      pollIntervalMs: 0,
      adapters: ['xai', 'byteplus'].map((id) => ({
        id,
        isConfigured: (route) => staffRefundRoutes.includes(route.id),
        submit,
        poll,
      })),
    }),
  );
  const close = async () => {
    if (!engine.pool.ended) await engine.close();
    await database.close();
  };
  try {
    await engine.initialize();
    const workspaceId = `local-true-refund-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, 0);
    const owner: Principal = {
      workspaceId,
      scopes: ['read', 'generate', 'keys:write'],
      bootstrap: true,
    };
    const processorEnvironment = {
      id: `local-true-refund-${randomUUID()}`,
      accountId: `acct_fixture${randomUUID().replaceAll('-', '')}`,
      livemode: true,
    };
    await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
    const payments = new PaymentStore(engine.pool, {
      livemode: true,
      processorEnvironment,
      creditInTransaction: creditWorkspaceInTransaction,
    });
    const sessions = new Map<string, CheckoutSession>();
    const creates = vi.fn<PaymentTransport['createSession']>(async (order) => {
      const session: CheckoutSession = {
        id: `cs_live_shaped_staff${order.id.replaceAll('-', '')}`,
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: order.amountCents,
        amount_total: order.amountCents,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: order.id,
        payment_intent: null,
        livemode: true,
        url: 'https://checkout.stripe.com/c/pay/synthetic_staff_fixture',
      };
      sessions.set(session.id, session);
      return { ...session };
    });
    const retrieves = vi.fn<PaymentTransport['retrieveSession']>(async (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error('Unknown synthetic payment session.');
      return { ...session };
    });
    const transport: PaymentTransport = {
      processorEnvironment,
      assertProcessorEnvironment() {},
      createSession: creates,
      retrieveSession: retrieves,
    };
    async function fund(amountCents = 500) {
      const created = await payments.createOrder(workspaceId, amountCents, randomUUID());
      await payments.checkout(workspaceId, created.id, transport);
      const session = sessions.get(`cs_live_shaped_staff${created.id.replaceAll('-', '')}`)!;
      const paymentIntentId = `pi_staff${created.id.replaceAll('-', '')}`;
      Object.assign(session, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: paymentIntentId,
      });
      await payments.reconcile(
        {
          id: `evt_staff_paid_${created.id.replaceAll('-', '')}`,
          type: 'checkout.session.completed',
          livemode: true,
          processorEnvironment,
          data: { object: { ...session } },
        },
        transport,
      );
      return {
        order: await payments.getOrder(workspaceId, created.id),
        sessionId: session.id,
        paymentIntentId,
        amountCents,
      };
    }
    async function riskHold(
      order: Awaited<ReturnType<typeof fund>>,
      amountRefundedCents = order.amountCents,
    ) {
      const eventId = `evt_staff_risk_${randomUUID().replaceAll('-', '')}`;
      await payments.reconcile(
        {
          id: eventId,
          type: 'charge.refunded',
          livemode: true,
          processorEnvironment,
          data: {
            object: {
              id: `ch_staff${order.order.id.replaceAll('-', '')}`,
              object: 'charge',
              payment_intent: order.paymentIntentId,
              amount: order.amountCents,
              amount_refunded: amountRefundedCents,
              currency: 'usd',
              refunded: amountRefundedCents === order.amountCents,
            },
          },
        },
        transport,
      );
      return eventId;
    }
    async function due(jobId: string) {
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE id=$1",
        [jobId],
      );
    }
    return {
      database,
      engine,
      workspaceId,
      owner,
      processorEnvironment,
      payments,
      transport,
      behavior,
      submit,
      poll,
      creates,
      retrieves,
      fund,
      riskHold,
      due,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof liveFixture>>;
type Paid = Awaited<ReturnType<Fixture['fund']>>;
async function setup() {
  const f = await liveFixture();
  close = f.close;
  const allocationApprovals = new Map<
    string,
    {
      paid: Paid;
      eligibleMicros: number;
      worksheetHash: string;
      reaffirmation?: { eventId: string; payloadFingerprint: string; eventCreated: number };
    }
  >();
  const allocationControl: { beforeApproval?: () => Promise<void> } = {};
  const authorize = vi.fn(async (_client: PoolClient, authority: unknown) => {
    if (authority !== context) throw new Error('Current fixture operator authority is required.');
    return actor;
  });
  const approveAllocation = vi.fn<NonNullable<StaffRefundStoreOptions['approveAllocation']>>(
    async (_client, authority, request) => {
      const approved = allocationApprovals.get(request.orderId);
      const cashCents = approved ? Math.ceil(approved.eligibleMicros / 10000) : -1;
      const rows = request.worksheet.allocation;
      if (
        authority !== context ||
        !approved ||
        !['prepare', 'dispatch', 'apply-success', 'release-failed', 'restore-failed'].includes(
          request.operation,
        ) ||
        request.workspaceId !== f.workspaceId ||
        request.orderId !== approved.paid.order.id ||
        request.paymentIntentId !== approved.paid.paymentIntentId ||
        request.processorEnvironmentId !== f.processorEnvironment.id ||
        request.processorAccountId !== f.processorEnvironment.accountId ||
        request.livemode !== true ||
        request.creditReference !== `stripe-topup:${approved.paid.order.id}` ||
        request.originalAmountCents !== approved.paid.amountCents ||
        request.eligibleMicros !== approved.eligibleMicros ||
        request.cashCents !== cashCents ||
        request.roundingExpenseMicros !== cashCents * 10000 - approved.eligibleMicros ||
        request.requestVersion !== 'staff-refund-original-v1' ||
        request.conversionVersion !== 'usd-ceil-cent-v1' ||
        !request.caseReference ||
        !/^[a-f0-9]{64}$/.test(request.caseRequestHash) ||
        request.worksheetHash !== approved.worksheetHash ||
        staffRefundHash(request.worksheet) !== approved.worksheetHash ||
        staffRefundHash(request.reaffirmation) !==
          staffRefundHash(approved.reaffirmation ?? null) ||
        rows.length !== 1 ||
        rows[0]?.fundingReference !== `stripe-topup:${approved.paid.order.id}` ||
        rows[0]?.disposition !== 'eligible-paid' ||
        rows[0]?.amountMicros !== approved.eligibleMicros ||
        !/^[a-f0-9]{64}$/.test(request.requestHash)
      )
        throw new Error('Synthetic original-payment allocation approval refused.');
      await allocationControl.beforeApproval?.();
      return {
        approvalReference: `fixture-approved-${request.operation}-${request.caseReference}`,
        requestHash: request.requestHash,
      };
    },
  );
  const refunds = new StaffRefundStore(f.engine.pool, {
    activation: 'manual',
    processorEnvironment: f.processorEnvironment,
    authorize,
    approveAllocation,
  });
  return { ...f, refunds, authorize, approveAllocation, allocationApprovals, allocationControl };
}
async function worksheet(
  f: Awaited<ReturnType<typeof setup>>,
  paid: Paid,
  eligibleMicros: number,
  externalReturns: StaffRefundWorksheet['externalReturns'] = [],
) {
  const value = {
    snapshot: await f.refunds.snapshot(f.workspaceId, context),
    externalReturns,
    allocationReference: `allocation-${randomUUID()}`,
    originalPayerReference: `payer-${randomUUID()}`,
    note: 'Synthetic staff review of original payer and chronological paid allocation.',
    allocation: [
      {
        fundingReference: `stripe-topup:${paid.order.id}`,
        disposition: 'eligible-paid' as const,
        amountMicros: eligibleMicros,
      },
    ],
  };
  return { worksheet: value, worksheetHash: staffRefundHash(value) };
}
async function currentApproval(
  f: Awaited<ReturnType<typeof setup>>,
  paid: Paid,
  eligibleMicros: number,
  externalReturns: StaffRefundWorksheet['externalReturns'] = [],
  reaffirmation?: ReturnType<typeof refundEvidence>,
) {
  // An independent fixture staff decision fixes the original funding and exact
  // worksheet before the store request. The hook never approves arbitrary JSON.
  const approval = await worksheet(f, paid, eligibleMicros, externalReturns);
  f.allocationApprovals.set(paid.order.id, {
    paid,
    eligibleMicros,
    worksheetHash: approval.worksheetHash,
    ...(reaffirmation
      ? {
          reaffirmation: {
            eventId: reaffirmation.eventId,
            payloadFingerprint: reaffirmation.payloadFingerprint,
            eventCreated: reaffirmation.eventCreated,
          },
        }
      : {}),
  });
  return approval;
}
async function prepare(
  f: Awaited<ReturnType<typeof setup>>,
  paid: Paid,
  eligibleMicros: number,
  existingRefundEvidence?: ReturnType<typeof refundEvidence>,
  externalReturns: StaffRefundWorksheet['externalReturns'] = [],
) {
  const approval = await currentApproval(f, paid, eligibleMicros, externalReturns);
  return f.refunds.prepare(
    {
      workspaceId: f.workspaceId,
      orderId: paid.order.id,
      reference: `staff-case-${randomUUID()}`,
      origin: existingRefundEvidence ? 'reconcile-existing' : 'new',
      eligibleMicros,
      ...approval,
      ...(existingRefundEvidence ? { existingRefundEvidence } : {}),
    },
    context,
  );
}
function refundEvidence(
  f: Fixture,
  paid: Paid,
  amountCents: number,
  refundId = `re_staff${randomUUID().replaceAll('-', '')}`,
  options: {
    status?: 'pending' | 'succeeded' | 'failed' | 'canceled';
    created?: number;
    failureBalanceTransactionId?: string;
  } = {},
) {
  // Explicit trusted-verifier boundary with a synthetic, already-verified event.
  // No Stripe SDK, signature secret, HTTP request or refund creation is involved.
  const result = normalizeStaffRefundEvidence(
    {
      id: `evt_staff_refund_${randomUUID().replaceAll('-', '')}`,
      type: 'refund.updated',
      created: options.created ?? Math.floor(Date.now() / 1000),
      livemode: true,
      processorEnvironment: f.processorEnvironment,
      data: {
        object: {
          id: refundId,
          object: 'refund',
          payment_intent: paid.paymentIntentId,
          charge: `ch_staff${paid.order.id.replaceAll('-', '')}`,
          amount: amountCents,
          currency: 'usd',
          status: options.status ?? 'succeeded',
          ...(options.failureBalanceTransactionId
            ? { failure_balance_transaction: options.failureBalanceTransactionId }
            : {}),
        },
      },
    },
    f.processorEnvironment,
    {
      workspaceId: f.workspaceId,
      orderId: paid.order.id,
      processorEnvironmentId: f.processorEnvironment.id,
      processorAccountId: f.processorEnvironment.accountId,
      livemode: true,
      paymentIntentId: paid.paymentIntentId,
      chargeId: null,
      amountCents: paid.amountCents,
      currency: 'USD',
    },
  );
  if (result.kind !== 'refund') throw new Error('Synthetic refund evidence was rejected.');
  return result.evidence;
}
function resolution(reference = randomUUID()) {
  return {
    reference,
    note: 'Synthetic authoritative processor and immutable ledger reconciliation.',
    evidenceReference: `fixture-evidence-${reference}`,
  };
}
async function ledger(f: Fixture) {
  return (
    await f.engine.pool.query(
      'SELECT id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details,created_at FROM mr_ledger WHERE workspace_id=$1 ORDER BY created_at,id',
      [f.workspaceId],
    )
  ).rows;
}
async function defer(f: Fixture, jobId: string) {
  await f.engine.pool.query(
    "UPDATE mr_jobs SET next_poll_at=clock_timestamp()+interval '1 hour',lease_until=NULL WHERE id=$1",
    [jobId],
  );
}

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'TRUE-mode LOCAL domain qualification (synthetic only)',
  () => {
    it('keeps collective earmarks within available balance without moving any reserved money', async () => {
      const f = await setup();
      const paid = await Promise.all([f.fund(), f.fund(), f.fund()]);
      await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      const wallet = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      const first = await prepare(f, paid[0]!, 5_000_000);
      const second = await prepare(f, paid[1]!, 5_000_000);
      const third = await prepare(f, paid[2]!, 5_000_000);
      expect(first.earmarkedMicros + second.earmarkedMicros).toBe(10_000_000);
      expect(third).toMatchObject({
        state: 'review',
        earmarkedMicros: 0,
        outstandingMicros: 5_000_000,
      });
      expect(
        first.earmarkedMicros + second.earmarkedMicros + third.earmarkedMicros,
      ).toBeLessThanOrEqual(wallet.availableMicros);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      expect(await ledger(f)).toEqual(entries);
      expect(f.submit).not.toHaveBeenCalled();
    });

    it('debits exact eligible microUSD once, records upward-rounding expense and preserves the funding credit', async () => {
      const f = await setup();
      const paid = await f.fund();
      const original = (await ledger(f)).filter((row) => row.kind === 'credit');
      const wallet = await f.engine.getBalance(f.workspaceId);
      const refund = await prepare(f, paid, 4_993_456);
      expect(refund).toMatchObject({
        cashCents: 500,
        roundingExpenseMicros: 6544,
        earmarkedMicros: 4_993_456,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      const claim = {
        ...resolution('new-refund-dispatch'),
        ...(await currentApproval(f, paid, refund.eligibleMicros)),
      };
      const dispatched = await f.refunds.dispatch(refund.id, claim, context);
      expect(dispatched.dispatchClaimed).toBe(true);
      const replayed = await f.refunds.dispatch(refund.id, claim, context);
      expect(replayed.dispatchKey).toBe(dispatched.dispatchKey);
      expect(replayed.dispatchClaimed).toBe(false);
      await expect(
        f.refunds.dispatch(refund.id, { ...claim, reference: 'must-not-claim-again' }, context),
      ).rejects.toMatchObject({ code: 'staff_refund_not_dispatchable' });
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        refundEvidence(f, paid, 500),
        resolution('processor-success'),
        context,
      );
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      const apply = {
        action: 'apply-success' as const,
        ...resolution('apply-original-success'),
        ...(await currentApproval(f, paid, refund.eligibleMicros)),
      };
      const applied = await f.refunds.reconcile(refund.id, apply, context);
      expect(applied).toMatchObject({
        earmarkedMicros: 0,
        outstandingMicros: 0,
        roundingExpenseMicros: 6544,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 6544,
        reservedMicros: 0,
      });
      const after = await ledger(f);
      expect(after.filter((row) => row.kind === 'credit')).toEqual(original);
      expect(await f.payments.getOrder(f.workspaceId, paid.order.id)).toEqual(paid.order);
      expect(
        after.filter((row) => row.reference === `staff-refund:${refund.id}:debit`),
      ).toMatchObject([
        {
          amount_micros: '4993456',
          available_delta_micros: '-4993456',
          reserved_delta_micros: '0',
        },
      ]);
      await f.refunds.reconcile(refund.id, apply, context);
      expect(await ledger(f)).toEqual(after);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 6544,
        reservedMicros: 0,
      });
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('restores only the exact original debit after current sealed failed-return proof and explicit approval', async () => {
      const f = await setup();
      const paid = await f.fund();
      const refund = await prepare(f, paid, 2_000_000);
      await f.refunds.dispatch(
        refund.id,
        {
          ...resolution('restore-dispatch'),
          ...(await currentApproval(f, paid, 2_000_000)),
        },
        context,
      );
      const at = Math.floor(Date.now() / 1000);
      const success = refundEvidence(f, paid, 200, undefined, { created: at });
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        success,
        resolution('restore-first-success'),
        context,
      );
      await f.refunds.reconcile(
        refund.id,
        {
          action: 'apply-success',
          ...resolution('restore-original-debit'),
          ...(await currentApproval(f, paid, 2_000_000)),
        },
        context,
      );
      const failed = refundEvidence(f, paid, 200, success.refundId, {
        status: 'failed',
        created: at + 10,
        failureBalanceTransactionId: 'txn_fixture_restored',
      });
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        failed,
        resolution('return-later-failed'),
        context,
      );
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 3_000_000,
        reservedMicros: 0,
      });
      expect((await ledger(f)).filter((row) => row.kind === 'refund-restore')).toEqual([]);
      await expect(
        f.refunds.reconcile(
          refund.id,
          {
            action: 'restore-failed',
            ...resolution('no-implicit-failure-restore'),
            ...(await currentApproval(f, paid, 2_000_000)),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      const wrong = refundEvidence(f, paid, 200, undefined, {
        status: 'failed',
        created: at + 20,
        failureBalanceTransactionId: 'txn_fixture_other_refund',
      });
      await expect(
        f.refunds.reconcile(
          refund.id,
          {
            action: 'restore-failed',
            ...resolution('wrong-refund-cannot-restore'),
            ...(await currentApproval(f, paid, 2_000_000, [], wrong)),
            reaffirmLatestEvidence: wrong,
          },
          context,
        ),
      ).rejects.toThrow();
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 3_000_000,
      });
      const reaffirm = refundEvidence(f, paid, 200, success.refundId, {
        status: 'failed',
        created: at + 20,
        failureBalanceTransactionId: 'txn_fixture_restored',
      });
      const action = {
        action: 'restore-failed' as const,
        ...resolution('explicit-matched-failure-restoration'),
        ...(await currentApproval(f, paid, 2_000_000, [], reaffirm)),
        reaffirmLatestEvidence: reaffirm,
      };
      const restored = await f.refunds.reconcile(refund.id, action, context);
      expect(restored).toMatchObject({
        financialState: 'restored',
        earmarkedMicros: 0,
        outstandingMicros: 0,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      const entries = await ledger(f);
      expect(
        entries.filter((row) => row.reference === `staff-refund:${refund.id}:debit`),
      ).toHaveLength(1);
      expect(
        entries.filter((row) => row.reference === `staff-refund:${refund.id}:restore`),
      ).toMatchObject([
        { amount_micros: '2000000', available_delta_micros: '2000000', reserved_delta_micros: '0' },
      ]);
      await f.refunds.reconcile(refund.id, action, context);
      expect(await ledger(f)).toEqual(entries);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*) FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL',
            [refund.id],
          )
        ).rows[0].count,
      ).not.toBe('0');
    });

    it('keeps two refunds on one payment isolated and refuses other-case or aggregate hold finalization', async () => {
      const f = await setup();
      const paid = await f.fund();
      const first = await prepare(f, paid, 2_000_000);
      const second = await prepare(f, paid, 2_000_000);
      await f.refunds.dispatch(
        first.id,
        {
          ...resolution('first-of-two-dispatch'),
          ...(await currentApproval(f, paid, 2_000_000)),
        },
        context,
      );
      const success = refundEvidence(f, paid, 200);
      await f.refunds.observeVerifiedProcessorEvidence(
        first.id,
        success,
        resolution('first-of-two-success'),
        context,
      );
      await expect(
        f.refunds.observeVerifiedProcessorEvidence(
          second.id,
          refundEvidence(f, paid, 200, success.refundId, { created: success.eventCreated + 1 }),
          resolution('same-refund-cannot-bind-twice'),
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_conflict' });
      const aggregate = await f.riskHold(paid, 200);
      for (const holdId of [second.holdIds[0]!, aggregate]) {
        await expect(
          f.refunds.reconcile(
            first.id,
            {
              action: 'apply-success',
              ...resolution(),
              ...(await currentApproval(f, paid, 2_000_000)),
              resolveHoldIds: [holdId],
              holdResolutionEvidenceUrl: 'https://fixture.invalid/wrong-hold-owner',
            },
            context,
          ),
        ).rejects.toMatchObject({ code: 'staff_refund_hold_mismatch' });
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 5_000_000,
          reservedMicros: 0,
        });
        expect((await ledger(f)).filter((row) => row.kind === 'refund')).toEqual([]);
      }
      await f.refunds.reconcile(
        first.id,
        {
          action: 'apply-success',
          ...resolution('only-first-case-finalized'),
          ...(await currentApproval(f, paid, 2_000_000)),
          resolveHoldIds: first.holdIds,
          holdResolutionEvidenceUrl: 'https://fixture.invalid/first-case-only',
        },
        context,
      );
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 3_000_000,
        reservedMicros: 0,
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT resolved_at FROM mr_billing_holds WHERE event_id=ANY($1::text[]) ORDER BY event_id',
            [[second.holdIds[0]!, aggregate]],
          )
        ).rows,
      ).toEqual([{ resolved_at: null }, { resolved_at: null }]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT earmark_micros,financial_state FROM mr_staff_refund_cases WHERE id=$1',
            [second.id],
          )
        ).rows,
      ).toEqual([{ earmark_micros: '2000000', financial_state: 'none' }]);
      await expect(
        f.engine.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input: staffRefundInput,
        }),
      ).rejects.toMatchObject({ code: 'billing_hold' });
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('excludes same-text payment intents from foreign processor environments and wrong modes in review evidence', async () => {
      const f = await setup();
      const paid = await f.fund();
      const before = await f.refunds.reviewEvidence(f.workspaceId, context);
      const foreignEnvironment = `foreign-refund-${randomUUID()}`;
      await f.engine.pool.query(
        'INSERT INTO mr_billing_processor_environments(id,account_id,livemode) VALUES($1,$2,true)',
        [foreignEnvironment, `acct_foreign${randomUUID().replaceAll('-', '')}`],
      );
      const foreignId = `evt_foreign_${randomUUID().replaceAll('-', '')}`;
      const wrongModeId = `evt_wrongmode_${randomUUID().replaceAll('-', '')}`;
      await f.engine.pool.query(
        `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,processor_environment_id,state)
         VALUES($1,'charge.refunded','ch_foreign_projection',$3,true,$4,$5,'pending'),
               ($2,'charge.refunded','ch_wrongmode_projection',$3,false,$4,$6,'pending')`,
        [
          foreignId,
          wrongModeId,
          paid.paymentIntentId,
          paid.order.id,
          foreignEnvironment,
          f.processorEnvironment.id,
        ],
      );
      const after = await f.refunds.reviewEvidence(f.workspaceId, context);
      expect(before.financialRows.events!.length).toBeGreaterThan(0);
      expect(after.financialRows.events).toEqual(before.financialRows.events);
      expect(
        after.financialRows.events!.every(
          (row) =>
            row.processor_environment_id === f.processorEnvironment.id && row.livemode === true,
        ),
      ).toBe(true);
      expect(JSON.stringify(after)).not.toContain(foreignId);
      expect(JSON.stringify(after)).not.toContain(wrongModeId);
      expect(after.snapshot).toEqual(before.snapshot);
    });
  },
);

const signingSecret = 'synthetic_TRUE_mode_LOCAL_signature_only';
function signedDelivery(
  paid: Paid,
  refundId: string,
  amountCents: number,
  objectPatch: Record<string, unknown> = {},
  eventPatch: Record<string, unknown> = {},
) {
  const rawBody = Buffer.from(
    `${JSON.stringify(
      {
        object: 'event',
        id: `evt_local_true_${randomUUID().replaceAll('-', '')}`,
        type: 'refund.updated',
        created: Math.floor(Date.now() / 1000) - 86400,
        livemode: true,
        data: {
          object: {
            object: 'refund',
            id: refundId,
            payment_intent: paid.paymentIntentId,
            charge: `ch_staff${paid.order.id.replaceAll('-', '')}`,
            amount: amountCents,
            currency: 'usd',
            status: 'succeeded',
            ...objectPatch,
          },
        },
        ...eventPatch,
      },
      null,
      2,
    )}\n`,
  );
  return {
    rawBody,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload: rawBody.toString('utf8'),
      secret: signingSecret,
    }),
  };
}

async function applicationRows(f: Fixture) {
  const tables = (
    await f.engine.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'mr_%' ORDER BY table_name`,
      [f.database.schema],
    )
  ).rows;
  const hashes: Record<string, unknown> = {};
  for (const { table_name } of tables) {
    if (!/^mr_[a-z0-9_]+$/.test(table_name)) throw new Error('Unexpected local fixture table.');
    hashes[table_name] = (
      await f.engine.pool.query(
        `SELECT count(*)::text AS count,md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text COLLATE "C"),'')) AS hash FROM "${table_name}" t`,
      )
    ).rows[0];
  }
  return hashes;
}

const fixtureEnvironment = {
  id: 'local_true_source_only',
  accountId: 'acct_localtruesourceonly',
  livemode: true,
};
const fakePool = {} as Pool;
const fixtureTarget = {
  workspaceId: 'local_true_source_only',
  orderId: '77777777-7777-4777-8777-777777777777',
  paymentIntentId: 'pi_local_true_source_only',
  chargeId: null,
  refundId: 're_local_true_source_only',
  originalAmountCents: 500,
  refundAmountCents: 100,
  eligibleMicros: 999_999,
};

describe('TRUE-mode LOCAL explicit composition boundary (no database or network)', () => {
  it('requires matching explicit manual activation and processor transport for producer and controller', () => {
    const options = {
      activation: 'manual' as const,
      processorEnvironment: fixtureEnvironment,
      processorTransport: {
        processorEnvironment: fixtureEnvironment,
        assertProcessorEnvironment() {},
      },
      webhookSecret: signingSecret,
      target: fixtureTarget,
      authorize: async () => actor,
    };
    expect(() => createStaffRefundEvidenceProducer(options)).not.toThrow();
    expect(() => new ExistingStaffRefundController(fakePool, options)).not.toThrow();
    expect(() => new StaffRefundStore(fakePool, options)).not.toThrow();
    for (const activation of ['sandbox', 'fixture'] as const) {
      expect(() =>
        createStaffRefundEvidenceProducer({ ...options, activation } as never),
      ).toThrow();
      expect(
        () => new ExistingStaffRefundController(fakePool, { ...options, activation } as never),
      ).toThrow();
      expect(() => new StaffRefundStore(fakePool, { ...options, activation })).toThrow();
    }
    const falseEnvironment = { ...fixtureEnvironment, livemode: false };
    const mixed = {
      ...options,
      processorEnvironment: falseEnvironment,
      processorTransport: { ...options.processorTransport, processorEnvironment: falseEnvironment },
    };
    expect(() => createStaffRefundEvidenceProducer(mixed)).toThrow();
    expect(() => new ExistingStaffRefundController(fakePool, mixed)).toThrow();
    expect(() => new StaffRefundStore(fakePool, mixed)).toThrow();
    for (const patch of [{ id: 'foreign' }, { accountId: 'acct_foreign' }, { livemode: false }]) {
      const mismatched = {
        ...options,
        processorTransport: {
          ...options.processorTransport,
          processorEnvironment: { ...fixtureEnvironment, ...patch },
        },
      };
      expect(() => createStaffRefundEvidenceProducer(mismatched)).toThrow();
      expect(() => new ExistingStaffRefundController(fakePool, mismatched)).toThrow();
    }
    expect(() =>
      createStaffRefundEvidenceProducer({ ...options, activation: undefined }),
    ).toThrow();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'TRUE-mode LOCAL current staff and controller qualification',
  () => {
    it('keeps default-closed domain operations and requires canonical paid ownership and credit', async () => {
      const f = await setup();
      const paid = await f.fund();
      expect(
        () =>
          new StaffRefundStore(f.engine.pool, {
            processorEnvironment: f.processorEnvironment,
            authorize: f.authorize,
            approveAllocation: f.approveAllocation,
          }),
      ).toThrow();
      const packet = await currentApproval(f, paid, 1_000_000);
      const candidate = {
        workspaceId: f.workspaceId,
        orderId: paid.order.id,
        reference: randomUUID(),
        origin: 'new' as const,
        eligibleMicros: 1_000_000,
        ...packet,
      };
      const before = await applicationRows(f);
      // Real source validation is tested with a foreign registered environment,
      // while the immutable original rows remain unchanged.
      const foreign = {
        id: `local_foreign_${randomUUID()}`,
        accountId: `acct_foreign${randomUUID().replaceAll('-', '')}`,
        livemode: true,
      };
      await registerBillingProcessorEnvironmentInTransaction(f.engine.pool, foreign);
      const foreignStore = new StaffRefundStore(f.engine.pool, {
        activation: 'manual',
        processorEnvironment: foreign,
        authorize: f.authorize,
        approveAllocation: f.approveAllocation,
      });
      await expect(foreignStore.prepare(candidate, context)).rejects.toMatchObject({
        code: 'staff_refund_payment_mismatch',
      });
      const after = await applicationRows(f);
      expect(after.mr_staff_refund_cases).toEqual(before.mr_staff_refund_cases);
      expect(after.mr_ledger).toEqual(before.mr_ledger);
      expect(after.mr_payment_orders).toEqual(before.mr_payment_orders);
    });

    it.each([
      'DELETE FROM mr_billing_payment_ownership WHERE local_id=$1',
      "UPDATE mr_payment_orders SET status='review',credited_at=NULL WHERE id=$1",
      "UPDATE mr_ledger SET available_delta_micros=0 WHERE reference='stripe-topup:'||$1::text",
    ])(
      'rejects noncanonical original paid funding before creating a TRUE case: %s',
      async (sql) => {
        const f = await setup();
        const paid = await f.fund();
        const packet = await currentApproval(f, paid, 1_000_000);
        await f.engine.pool.query(sql, [paid.order.id]);
        const before = await applicationRows(f);
        await expect(
          f.refunds.prepare(
            {
              workspaceId: f.workspaceId,
              orderId: paid.order.id,
              reference: randomUUID(),
              origin: 'new',
              eligibleMicros: 1_000_000,
              ...packet,
            },
            context,
          ),
        ).rejects.toMatchObject({ code: 'staff_refund_payment_mismatch' });
        expect(await applicationRows(f)).toEqual(before);
      },
    );

    it('preserves accepted original jobs and reserves while a live-shaped case blocks only new admission', async () => {
      const f = await setup();
      const paid = await f.fund();
      const key = randomUUID();
      const accepted = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: key,
        input: staffRefundInput,
      });
      await workUntilJob(f.engine, f.workspaceId, accepted.id, (job) => job.status === 'running');
      const frozen = (await f.engine.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [accepted.id]))
        .rows;
      const before = await f.engine.getBalance(f.workspaceId);
      const held = await prepare(f, paid, 1_000_000);
      expect(held.earmarkedMicros).toBe(1_000_000);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(before);
      await expect(
        f.engine.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input: staffRefundInput,
        }),
      ).rejects.toMatchObject({ code: 'billing_hold' });
      expect(
        (
          await f.engine.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: key,
            input: staffRefundInput,
          })
        ).id,
      ).toBe(accepted.id);
      expect(
        (await f.engine.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [accepted.id])).rows,
      ).toEqual(frozen);
      f.behavior.set(accepted.id, { status: 'failed', billedCostMicros: 1234 });
      await f.due(accepted.id);
      await workUntilJob(f.engine, f.workspaceId, accepted.id, (job) => job.settledMicros === 1234);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000 - 1234,
        reservedMicros: 0,
      });
      expect(f.submit).toHaveBeenCalledTimes(1);
    });

    it('releases a definitively failed dispatch without debit and resolves only explicitly selected case holds', async () => {
      const f = await setup();
      const paid = await f.fund();
      const c = await prepare(f, paid, 1_999_999);
      await f.refunds.dispatch(
        c.id,
        { ...resolution(), ...(await currentApproval(f, paid, c.eligibleMicros)) },
        context,
      );
      const failed = refundEvidence(f, paid, c.cashCents, undefined, {
        status: 'failed',
        failureBalanceTransactionId: 'txn_local_true_return',
      });
      const observed = await f.refunds.observeVerifiedProcessorEvidence(
        c.id,
        failed,
        resolution(),
        context,
      );
      const input = {
        action: 'release-failed' as const,
        ...resolution(),
        ...(await currentApproval(f, paid, c.eligibleMicros)),
        resolveHoldIds: [observed.holdIds[0]!],
        holdResolutionEvidenceUrl: 'https://fixture.invalid/local-true-failed',
      };
      const released = await f.refunds.reconcile(c.id, input, context);
      expect(released).toMatchObject({
        financialState: 'released',
        earmarkedMicros: 0,
        outstandingMicros: 0,
      });
      const rows = await ledger(f);
      await f.refunds.reconcile(c.id, input, context);
      expect(await ledger(f)).toEqual(rows);
      expect(rows.every((row) => !['refund', 'refund-restore'].includes(String(row.kind)))).toBe(
        true,
      );
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT event_id FROM mr_billing_hold_resolutions WHERE workspace_id=$1',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual([{ event_id: observed.holdIds[0] }]);
    });

    it.each(
      (
        ['prepare', 'dispatch', 'apply-success', 'release-failed', 'restore-failed'] as const
      ).flatMap((operation) =>
        (['changed actor', 'revoked role'] as const).map((change) => ({ operation, change })),
      ),
    )(
      'revalidates current staff after awaited $operation allocation approval with $change',
      async ({ operation, change }) => {
        const f = await setup();
        const paid = await f.fund();
        const amount = 1_000_000;
        let c: Awaited<ReturnType<typeof prepare>> | undefined;
        let reaffirm: ReturnType<typeof refundEvidence> | undefined;
        if (operation !== 'prepare') c = await prepare(f, paid, amount);
        if (c && ['apply-success', 'release-failed', 'restore-failed'].includes(operation)) {
          await f.refunds.dispatch(
            c.id,
            { ...resolution(), ...(await currentApproval(f, paid, amount)) },
            context,
          );
          const success = refundEvidence(f, paid, 100);
          if (operation !== 'release-failed')
            await f.refunds.observeVerifiedProcessorEvidence(c.id, success, resolution(), context);
          if (operation === 'restore-failed')
            await f.refunds.reconcile(
              c.id,
              {
                action: 'apply-success',
                ...resolution(),
                ...(await currentApproval(f, paid, amount)),
              },
              context,
            );
          if (operation !== 'apply-success') {
            const failed = refundEvidence(
              f,
              paid,
              100,
              operation === 'restore-failed' ? success.refundId : undefined,
              {
                status: 'failed',
                created: success.eventCreated + 10,
                failureBalanceTransactionId: 'txn_local_true_revocation',
              },
            );
            await f.refunds.observeVerifiedProcessorEvidence(c.id, failed, resolution(), context);
            if (operation === 'restore-failed')
              reaffirm = refundEvidence(f, paid, 100, success.refundId, {
                status: 'failed',
                created: success.eventCreated + 20,
                failureBalanceTransactionId: 'txn_local_true_revocation',
              });
          }
        }
        const packet = await currentApproval(f, paid, amount, [], reaffirm);
        const before = await applicationRows(f);
        f.allocationControl.beforeApproval = async () => {
          f.authorize.mockImplementation(async () => {
            if (change === 'revoked role') return { ...actor, kind: 'workspace-member' as never };
            return { ...actor, id: 'different-current-staff' };
          });
        };
        const pending =
          operation === 'prepare'
            ? f.refunds.prepare(
                {
                  workspaceId: f.workspaceId,
                  orderId: paid.order.id,
                  origin: 'new',
                  reference: randomUUID(),
                  eligibleMicros: amount,
                  ...packet,
                },
                context,
              )
            : operation === 'dispatch'
              ? f.refunds.dispatch(c!.id, { ...resolution(), ...packet }, context)
              : f.refunds.reconcile(
                  c!.id,
                  {
                    action: operation,
                    ...resolution(),
                    ...packet,
                    ...(reaffirm ? { reaffirmLatestEvidence: reaffirm } : {}),
                  },
                  context,
                );
        await expect(pending).rejects.toMatchObject({
          code: 'staff_refund_authority_required',
          statusCode: 403,
        });
        expect(await applicationRows(f)).toEqual(before);
      },
    );

    it('verifies actual SDK synthetic HMAC bytes for one fixed existing refund and applies once with all holds retained', async () => {
      const f = await setup();
      const paid = await f.fund();
      const amount = 4_993_456;
      const target = {
        workspaceId: f.workspaceId,
        orderId: paid.order.id,
        paymentIntentId: paid.paymentIntentId,
        chargeId: `ch_staff${paid.order.id.replaceAll('-', '')}`,
        refundId: `re_local_true_${randomUUID().replaceAll('-', '')}`,
        originalAmountCents: paid.amountCents,
        refundAmountCents: 500,
        eligibleMicros: amount,
      };
      const transport = {
        processorEnvironment: f.processorEnvironment,
        assertProcessorEnvironment() {},
      };
      const options = {
        activation: 'manual' as const,
        processorEnvironment: f.processorEnvironment,
        processorTransport: transport,
        webhookSecret: signingSecret,
        target,
        authorize: f.authorize,
        approveAllocation: f.approveAllocation,
      };
      const controller = new ExistingStaffRefundController(f.engine.pool, options);
      const delivered = signedDelivery(paid, target.refundId, 500);
      const before = await applicationRows(f);
      expect(await controller.rehearse(delivered, context)).toMatchObject({
        applyAllowed: false,
        target,
        processor: { kind: 'refund', amountCents: 500 },
      });
      expect(await applicationRows(f)).toEqual(before);
      const initial = await currentApproval(f, paid, amount);
      const c = await controller.prepareExisting(
        { delivery: delivered, reference: randomUUID(), ...initial },
        context,
      );
      expect(c).toMatchObject({
        origin: 'reconcile-existing',
        refundId: target.refundId,
        roundingExpenseMicros: 6544,
      });
      await expect(
        controller.applyExisting(c.id, { ...resolution(), ...initial }, context),
      ).rejects.toMatchObject({ code: 'staff_refund_conflict' });
      const holds = (
        await f.engine.pool.query(
          'SELECT * FROM mr_billing_holds WHERE workspace_id=$1 ORDER BY event_id',
          [f.workspaceId],
        )
      ).rows;
      const apply = { ...resolution(), ...(await currentApproval(f, paid, amount)) };
      await controller.applyExisting(c.id, apply, context);
      await controller.applyExisting(c.id, apply, context);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 6544,
        reservedMicros: 0,
      });
      expect(
        (await ledger(f)).filter((row) => row.reference === `staff-refund:${c.id}:debit`),
      ).toHaveLength(1);
      expect(
        (
          await f.engine.pool.query(
            'SELECT * FROM mr_billing_holds WHERE workspace_id=$1 ORDER BY event_id',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual(holds);
      expect(
        (
          await f.engine.pool.query(
            'SELECT receipt FROM mr_staff_refund_financial_entries WHERE case_id=$1',
            [c.id],
          )
        ).rows[0].receipt,
      ).toMatchObject({
        livemode: true,
        processorEnvironmentId: f.processorEnvironment.id,
        processorAccountId: f.processorEnvironment.accountId,
        paidCharacter: 'original-payment',
      });
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(controller))).not.toContain(
        'dispatch',
      );
      for (const [objectPatch, eventPatch] of [
        [{}, { livemode: false }],
        [{}, { account: f.processorEnvironment.accountId }],
        [{}, { context: 'ctx_foreign' }],
        [{ livemode: false }, {}],
        [{ id: 're_foreign' }, {}],
        [{ payment_intent: 'pi_foreign' }, {}],
        [{ charge: 'ch_foreign' }, {}],
        [{}, { type: 'charge.refunded' }],
      ] as const) {
        expect(
          (
            await controller.rehearse(
              signedDelivery(paid, target.refundId, 500, objectPatch, eventPatch),
              context,
            )
          ).processor.kind,
        ).toBe('review');
      }
      const altered = {
        ...delivered,
        rawBody: Buffer.concat([delivered.rawBody, Buffer.from(' ')]),
      };
      expect((await controller.rehearse(altered, context)).processor.kind).toBe('review');
      const stale = {
        ...delivered,
        signature: Stripe.webhooks.generateTestHeaderString({
          payload: delivered.rawBody.toString('utf8'),
          secret: signingSecret,
          timestamp: Math.floor(Date.now() / 1000) - 301,
        }),
      };
      expect((await controller.rehearse(stale, context)).processor.kind).toBe('review');
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  '030 TRUE-mode LOCAL financial trigger qualification',
  () => {
    it('rejects malformed receipt modes and mismatched namespace/witness with the exact guard error before any duplicate key', async () => {
      const f = await setup();
      const paid = await f.fund();
      const amount = 999_999;
      const evidence = refundEvidence(f, paid, 100);
      const c = await prepare(f, paid, amount, evidence);
      const before = await applicationRows(f);
      const receipt = {
        caseId: c.id,
        caseReference: c.reference,
        orderId: paid.order.id,
        creditReference: `stripe-topup:${paid.order.id}`,
        processorEnvironmentId: f.processorEnvironment.id,
        processorAccountId: f.processorEnvironment.accountId,
        livemode: true,
        paymentIntentId: paid.paymentIntentId,
        refundId: evidence.refundId,
        paidCharacter: 'original-payment',
        eligibleMicros: amount,
        cashCents: 100,
        roundingExpenseMicros: 1,
        requestVersion: 'staff-refund-original-v1',
        conversionVersion: 'usd-ceil-cent-v1',
        before: { availableMicros: 5_000_000, reservedMicros: 0 },
        after: { availableMicros: 5_000_000 - amount, reservedMicros: 0 },
      };
      const stored = (
        await f.engine.pool.query(
          'SELECT evidence FROM mr_staff_refund_observations WHERE case_id=$1',
          [c.id],
        )
      ).rows[0].evidence as Record<string, unknown>;
      type Mutation = {
        label: string;
        receipt?: Record<string, unknown>;
        witness?: Record<string, unknown>;
      };
      const missing = undefined;
      const mutations: Mutation[] = [
        { label: 'receipt false mode', receipt: { livemode: false } },
        { label: 'receipt string mode', receipt: { livemode: 'true' } },
        { label: 'receipt missing mode', receipt: { livemode: missing } },
        { label: 'receipt null mode', receipt: { livemode: null } },
        ...Object.entries({
          processorEnvironmentId: 'foreign_environment',
          processorAccountId: 'acct_foreign',
          paymentIntentId: 'pi_foreign',
          refundId: 're_foreign',
          creditReference: 'stripe-topup:foreign',
        }).map(([key, value]) => ({ label: `receipt ${key}`, receipt: { [key]: value } })),
        { label: 'witness false mode', witness: { livemode: false } },
        { label: 'witness string mode', witness: { livemode: 'true' } },
        { label: 'witness missing mode', witness: { livemode: missing } },
        { label: 'witness null mode', witness: { livemode: null } },
        ...Object.entries({
          kind: 'charge',
          workspaceId: 'foreign_workspace',
          orderId: randomUUID(),
          processorEnvironmentId: 'foreign_environment',
          processorAccountId: 'acct_foreign',
          paymentIntentId: 'pi_foreign',
          refundId: 're_foreign',
          chargeId: 'ch_foreign',
          eventId: 'evt_foreign_witness',
          eventCreated: evidence.eventCreated + 1,
          amountCents: 99,
          currency: 'EUR',
        }).map(([key, value]) => ({ label: `witness ${key}`, witness: { [key]: value } })),
      ];
      const client = await f.engine.pool.connect();
      try {
        for (const mutation of [{ label: 'valid control' }, ...mutations] as Mutation[]) {
          await client.query('BEGIN');
          try {
            const eventId = `evt_local_true_guard_${randomUUID().replaceAll('-', '')}`;
            const witness = JSON.parse(
              JSON.stringify({ ...stored, eventId, ...mutation.witness }),
            ) as Record<string, unknown>;
            await client.query(
              `INSERT INTO mr_staff_refund_observations(processor_environment_id,event_id,case_id,refund_id,event_created,observation_hash,evidence)
             VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [
                f.processorEnvironment.id,
                eventId,
                c.id,
                evidence.refundId,
                evidence.eventCreated,
                staffRefundHash(witness),
                JSON.stringify(witness),
              ],
            );
            await client.query('UPDATE mr_staff_refund_cases SET latest_event_id=$2 WHERE id=$1', [
              c.id,
              eventId,
            ]);
            const ledgerId = randomUUID();
            await client.query('UPDATE mr_workspaces SET available_micros=$2 WHERE id=$1', [
              f.workspaceId,
              receipt.after.availableMicros,
            ]);
            await client.query(
              `INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference)
             VALUES($1,$2,'refund',$3::bigint,-$3::bigint,0,$4)`,
              [ledgerId, f.workspaceId, amount, `staff-refund:${c.id}:debit`],
            );
            // There is no pre-existing (case_id,action) or ledger_id: a duplicate
            // primary key cannot satisfy this financial identity assertion.
            expect(
              (
                await client.query(
                  'SELECT count(*)::text AS count FROM mr_staff_refund_financial_entries WHERE case_id=$1',
                  [c.id],
                )
              ).rows[0].count,
            ).toBe('0');
            const write = client.query(
              `INSERT INTO mr_staff_refund_financial_entries(case_id,action,ledger_id,amount_micros,cash_cents,rounding_expense_micros,request_version,conversion_version,before_available_micros,after_available_micros,before_reserved_micros,after_reserved_micros,receipt)
             VALUES($1,'debit',$2,$3,100,1,'staff-refund-original-v1','usd-ceil-cent-v1',5000000,$4,0,0,$5)`,
              [
                c.id,
                ledgerId,
                amount,
                receipt.after.availableMicros,
                JSON.stringify({ ...receipt, ...mutation.receipt }),
              ],
            );
            if (mutation.label === 'valid control') expect((await write).rowCount).toBe(1);
            else
              await expect(write, mutation.label).rejects.toMatchObject({
                code: 'P0001',
                message: 'staff_refund_financial_identity',
              });
          } finally {
            await client.query('ROLLBACK');
          }
        }
      } finally {
        client.release();
      }
      expect(await applicationRows(f)).toEqual(before);
    });
  },
);

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe.skipIf(!process.env.TEST_DATABASE_URL || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native TRUE-mode LOCAL separate-session serialization',
  () => {
    it('claims one dispatch and commits one debit across independently blocked duplicate sessions', async () => {
      const f = await setup();
      const paid = await f.fund();
      const amount = 1_999_999;
      const c = await prepare(f, paid, amount);
      const secondPool = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
      const observer = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
      const second = new StaffRefundStore(secondPool, {
        activation: 'manual',
        processorEnvironment: f.processorEnvironment,
        authorize: f.authorize,
        approveAllocation: f.approveAllocation,
      });
      const [a, b] = await Promise.all([
        f.engine.pool.query('SELECT pg_backend_pid() AS pid'),
        secondPool.query('SELECT pg_backend_pid() AS pid'),
      ]);
      expect(a.rows[0].pid).not.toBe(b.rows[0].pid);
      async function overlap<T>(firstAction: () => Promise<T>, secondAction: () => Promise<T>) {
        const entered = latch(),
          release = latch();
        let gated = false;
        f.allocationControl.beforeApproval = async () => {
          if (gated) return;
          gated = true;
          entered.release();
          await release.promise;
        };
        const first = firstAction();
        let replay: Promise<T> | undefined;
        try {
          await Promise.race([
            entered.promise,
            first.then(() => {
              throw new Error('Expected the TRUE-mode native allocation lock gate.');
            }),
          ]);
          replay = secondAction();
          void replay.catch(() => {});
          let blocked = false;
          for (let step = 0; step < 100; step++) {
            const row = (
              await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [
                b.rows[0].pid,
              ])
            ).rows[0];
            if (row?.wait_event_type === 'Lock') {
              blocked = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          expect(blocked).toBe(true);
          release.release();
          return await Promise.all([first, replay]);
        } finally {
          release.release();
          await Promise.allSettled([first, ...(replay ? [replay] : [])]);
          f.allocationControl.beforeApproval = undefined;
        }
      }
      try {
        const claim = { ...resolution(), ...(await currentApproval(f, paid, amount)) };
        const [firstClaim, replayClaim] = await overlap(
          () => f.refunds.dispatch(c.id, claim, context),
          () => second.dispatch(c.id, claim, context),
        );
        expect(firstClaim).toMatchObject({ dispatchClaimed: true });
        expect(replayClaim).toMatchObject({
          dispatchClaimed: false,
          dispatchKey: firstClaim.dispatchKey,
        });
        expect(
          (
            await f.engine.pool.query(
              "SELECT count(*)::text AS count FROM mr_staff_refund_audit WHERE case_id=$1 AND action='dispatch'",
              [c.id],
            )
          ).rows[0].count,
        ).toBe('1');
        await f.refunds.observeVerifiedProcessorEvidence(
          c.id,
          refundEvidence(f, paid, 200),
          resolution(),
          context,
        );
        const apply = {
          action: 'apply-success' as const,
          ...resolution(),
          ...(await currentApproval(f, paid, amount)),
        };
        const results = await overlap(
          () => f.refunds.reconcile(c.id, apply, context),
          () => second.reconcile(c.id, apply, context),
        );
        expect(results.every((result) => result.financialState === 'debited')).toBe(true);
        expect(
          (await ledger(f)).filter((row) => row.reference === `staff-refund:${c.id}:debit`),
        ).toHaveLength(1);
        expect(
          (
            await f.engine.pool.query(
              'SELECT action,amount_micros FROM mr_staff_refund_expenses WHERE case_id=$1',
              [c.id],
            )
          ).rows,
        ).toEqual([{ action: 'expense', amount_micros: 1 }]);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 3_000_001,
          reservedMicros: 0,
        });
      } finally {
        await Promise.all([secondPool.end(), observer.end()]);
      }
    });
  },
);

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'TRUE-mode LOCAL principal and dispatch risk scopes',
  () => {
    it('counts rounded cash claims collectively against original principal without moving wallet money', async () => {
      const f = await setup();
      const paid = await f.fund();
      const first = await prepare(f, paid, 2_499_999);
      const second = await prepare(f, paid, 2_499_999);
      expect(first.cashCents + second.cashCents).toBe(paid.amountCents);
      expect(first.earmarkedMicros + second.earmarkedMicros).toBe(4_999_998);
      const before = await applicationRows(f);
      await expect(prepare(f, paid, 1)).rejects.toMatchObject({
        code: 'staff_refund_principal_exceeded',
      });
      expect(await applicationRows(f)).toEqual(before);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
    });

    it('ignores foreign and wrong-mode uncertainty but blocks matching live-shaped processor risk before a dispatch claim', async () => {
      const f = await setup();
      const firstPaid = await f.fund();
      const secondPaid = await f.fund();
      const first = await prepare(f, firstPaid, 1_000_000);
      const foreign = {
        id: `local-foreign-risk-${randomUUID()}`,
        accountId: `acct_foreign${randomUUID().replaceAll('-', '')}`,
        livemode: true,
      };
      await registerBillingProcessorEnvironmentInTransaction(f.engine.pool, foreign);
      for (const [id, environmentId, mode] of [
        [`evt_local_foreign_risk_${randomUUID().replaceAll('-', '')}`, foreign.id, true],
        [
          `evt_local_wrong_mode_${randomUUID().replaceAll('-', '')}`,
          f.processorEnvironment.id,
          false,
        ],
      ] as const) {
        await f.engine.pool.query(
          `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,processor_environment_id,state)
         VALUES($1,'refund.updated','re_local_foreign_risk',$2,$3,$4,$5,'pending')`,
          [id, firstPaid.paymentIntentId, mode, firstPaid.order.id, environmentId],
        );
      }
      expect(
        await f.refunds.dispatch(
          first.id,
          { ...resolution(), ...(await currentApproval(f, firstPaid, first.eligibleMicros)) },
          context,
        ),
      ).toMatchObject({ dispatchClaimed: true });
      const second = await prepare(f, secondPaid, 1_000_000);
      await f.riskHold(secondPaid, 100);
      const approved = await currentApproval(f, secondPaid, second.eligibleMicros);
      const before = await applicationRows(f);
      await expect(
        f.refunds.dispatch(second.id, { ...resolution(), ...approved }, context),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      expect(await applicationRows(f)).toEqual(before);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::text AS count FROM mr_staff_refund_audit WHERE case_id=$1 AND action='dispatch'",
            [second.id],
          )
        ).rows[0].count,
      ).toBe('0');
    });
  },
);
