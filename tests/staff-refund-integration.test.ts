import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { catalog } from '@media-router/catalog';
import { BillingOperationsStore } from '../packages/engine/src/billing-operations.js';
import {
  StaffRefundStore,
  staffRefundHash,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../packages/engine/src/staff-refunds.js';
import { normalizeStaffRefundEvidence } from '../packages/engine/src/staff-refund-evidence.js';
import { workUntilJob } from './helpers/isolated-engine.js';
import {
  staffRefundFixture,
  staffRefundInput,
  staffRefundRoutes,
  staffRefundTestDatabaseUrl,
} from './staff-refund-fixture.js';

type Fixture = Awaited<ReturnType<typeof staffRefundFixture>>;
type Paid = Awaited<ReturnType<Fixture['fund']>>;
const context = { operator: 'synthetic-staff-refund-operator' };
const actor = { id: context.operator, kind: 'installation-operator' as const };
const noNetwork = vi.fn(async () => {
  throw new Error('Staff refund integration fixtures forbid external requests.');
});
let close: (() => Promise<void>) | undefined;
const extraPools: Pool[] = [];
beforeEach(() => {
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(async () => {
  try {
    await Promise.all(extraPools.splice(0).map((pool) => pool.end()));
    await close?.();
    expect(noNetwork).not.toHaveBeenCalled();
  } finally {
    close = undefined;
    noNetwork.mockClear();
    vi.unstubAllGlobals();
  }
});
async function setup() {
  const f = await staffRefundFixture();
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
        request.livemode !== false ||
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
    activation: 'fixture',
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
      livemode: false,
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
      livemode: false,
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

async function finalizedFailedRefund(mode: 'released' | 'restored') {
  const f = await setup();
  const paid = await f.fund();
  const first = await prepare(f, paid, 5_000_000);
  await f.refunds.dispatch(
    first.id,
    {
      ...resolution(`finalized-${mode}-dispatch`),
      ...(await currentApproval(f, paid, 5_000_000)),
    },
    context,
  );
  const at = Math.floor(Date.now() / 1000);
  const refundId = `re_finalized_${randomUUID().replaceAll('-', '')}`;
  if (mode === 'restored') {
    await f.refunds.observeVerifiedProcessorEvidence(
      first.id,
      refundEvidence(f, paid, 500, refundId, { created: at }),
      resolution('finalized-original-success'),
      context,
    );
    await f.refunds.reconcile(
      first.id,
      {
        action: 'apply-success',
        ...resolution('finalized-original-debit'),
        ...(await currentApproval(f, paid, 5_000_000)),
      },
      context,
    );
  }
  const failureBalanceTransactionId = 'txn_fixture_finalized_return';
  const failed = refundEvidence(f, paid, 500, refundId, {
    status: 'failed',
    created: at + 10,
    failureBalanceTransactionId,
  });
  const observed = await f.refunds.observeVerifiedProcessorEvidence(
    first.id,
    failed,
    resolution('finalized-definitive-failure'),
    context,
  );
  const reaffirm =
    mode === 'restored'
      ? refundEvidence(f, paid, 500, refundId, {
          status: 'failed',
          created: at + 20,
          failureBalanceTransactionId,
        })
      : undefined;
  const final = await f.refunds.reconcile(
    first.id,
    {
      action: mode === 'released' ? 'release-failed' : 'restore-failed',
      ...resolution(`finalized-${mode}-financial-decision`),
      ...(await currentApproval(f, paid, 5_000_000, [], reaffirm)),
      ...(reaffirm ? { reaffirmLatestEvidence: reaffirm } : {}),
      resolveHoldIds: observed.holdIds,
      holdResolutionEvidenceUrl: 'https://fixture.invalid/finalized-failed-return',
    },
    context,
  );
  expect(final).toMatchObject({
    state: 'failed',
    financialState: mode,
    reviewRequired: false,
    earmarkedMicros: 0,
    outstandingMicros: 0,
  });
  expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
    availableMicros: 5_000_000,
    reservedMicros: 0,
  });
  return { f, paid, first: final, refundId, at, failureBalanceTransactionId };
}

async function caseHolds(f: Fixture, caseId: string) {
  return (
    await f.engine.pool.query(
      'SELECT event_id,reason,resolved_at,resolution_reference FROM mr_billing_holds WHERE staff_refund_case_id=$1 ORDER BY event_id',
      [caseId],
    )
  ).rows;
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function nativeSessions(f: Awaited<ReturnType<typeof setup>>) {
  const second = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
  const observer = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
  extraPools.push(second, observer);
  const pids = await Promise.all([
    f.engine.pool.query('SELECT pg_backend_pid() AS pid'),
    second.query('SELECT pg_backend_pid() AS pid'),
  ]);
  const firstPid = pids[0]!.rows[0].pid as number;
  const secondPid = pids[1]!.rows[0].pid as number;
  expect(firstPid).not.toBe(secondPid);
  const refunds = new StaffRefundStore(second, {
    activation: 'fixture',
    processorEnvironment: f.processorEnvironment,
    authorize: f.authorize,
    approveAllocation: f.approveAllocation,
  });
  return { second, observer, refunds, firstPid, secondPid };
}

async function waitForDatabaseLock(observer: Pool, pid: number) {
  for (let step = 0; step < 100; step++) {
    const row = (
      await observer.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [
        pid,
      ])
    ).rows[0];
    if (row?.wait_event_type === 'Lock') return row;
    await delay(20);
  }
  throw new Error('The independent native PostgreSQL session did not reach its guarded lock.');
}

describe('staff refund fixture database guard (no connections)', () => {
  it.each([
    'postgresql://fixture@127.0.0.1:15432/opengen_billing_sandbox_261106',
    'postgresql://fixture@localhost/opengen_production',
    'postgresql://fixture@database.example/opengen_test',
    'postgresql://fixture@127.0.0.1/postgres?host=database.example',
  ])('refuses an unapproved target before creating a pool: %s', (target) => {
    expect(() => staffRefundTestDatabaseUrl(target)).toThrow('loopback ephemeral database');
  });
  it.each([
    'postgresql://fixture@127.0.0.1:56028/postgres',
    'postgresql://fixture@localhost/opengen_test',
    'postgresql://fixture@[::1]/opengen_staff_refund_native',
    'postgresql://fixture@127.0.0.1/opengen_core_qualification_ci',
  ])('accepts only the named local fixture targets without connecting: %s', (target) => {
    expect(staffRefundTestDatabaseUrl(target)).toBe(target);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'staff refund holds preserve admitted work and money',
  () => {
    it('blocks new managed and zero-reserve BYOK work while original queued, accepted and unknown jobs recover', async () => {
      const f = await setup();
      const paid = await f.fund();
      const deployment = catalog.routes.find(
        (route) => route.id === staffRefundRoutes[0],
      )!.deploymentId;
      await f.engine.accounts.putConnection(f.workspaceId, deployment, {
        apiKey: 'synthetic-staff-refund-byok-not-a-provider-key',
      });
      const byok = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...staffRefundInput, billing: 'byok' },
      });
      expect(byok.reservedMicros).toBe(0);
      await f.engine.cancel(f.workspaceId, byok.id);

      const acceptedKey = randomUUID();
      const accepted = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: acceptedKey,
        input: staffRefundInput,
      });
      await workUntilJob(f.engine, f.workspaceId, accepted.id, (job) => job.status === 'running');
      await defer(f, accepted.id);
      const unknown = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      f.behavior.set(unknown.id, { submission: 'unknown' });
      await workUntilJob(
        f.engine,
        f.workspaceId,
        unknown.id,
        (job) => job.status === 'submission-unknown',
      );
      const queued = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      const walletBefore = await f.engine.getBalance(f.workspaceId);
      const ledgerBefore = await ledger(f);
      const frozen = (
        await f.engine.pool.query(
          'SELECT id,input,request_hash,route_snapshot,deployment_snapshot,reserved_micros FROM mr_jobs WHERE workspace_id=$1 ORDER BY id',
          [f.workspaceId],
        )
      ).rows;
      const held = await prepare(f, paid, 1_000_000);
      expect(held.earmarkedMicros).toBe(1_000_000);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(walletBefore);
      expect(await ledger(f)).toEqual(ledgerBefore);
      for (const billing of ['managed', 'byok'] as const)
        await expect(
          f.engine.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: { ...staffRefundInput, billing },
          }),
        ).rejects.toMatchObject({ code: 'billing_hold' });
      expect(
        (
          await f.engine.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: acceptedKey,
            input: staffRefundInput,
          })
        ).id,
      ).toBe(accepted.id);
      expect(await ledger(f)).toEqual(ledgerBefore);
      expect((await f.engine.listJobs(f.workspaceId)).map((job) => job.id).sort()).toEqual(
        [byok.id, accepted.id, unknown.id, queued.id].sort(),
      );
      await workUntilJob(f.engine, f.workspaceId, queued.id, (job) => job.status === 'running');
      f.behavior.set(queued.id, { status: 'failed', billedCostMicros: 1234 });
      await f.due(queued.id);
      await workUntilJob(f.engine, f.workspaceId, queued.id, (job) => job.settledMicros === 1234);
      f.behavior.set(accepted.id, {
        status: 'failed',
        billedCostMicros: null,
        retryAfterMs: 15000,
      });
      await f.due(accepted.id);
      await workUntilJob(
        f.engine,
        f.workspaceId,
        accepted.id,
        (job) => job.status === 'failed' && job.settledMicros === null,
      );
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        reservedMicros: accepted.reservedMicros + unknown.reservedMicros,
      });
      f.behavior.set(accepted.id, {
        status: 'failed',
        billedCostMicros: accepted.reservedMicros + 6543,
      });
      await f.due(accepted.id);
      await workUntilJob(
        f.engine,
        f.workspaceId,
        accepted.id,
        (job) => job.settledMicros === accepted.reservedMicros,
      );
      expect((await f.engine.getJob(f.workspaceId, unknown.id))?.settledMicros).toBeNull();
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        reservedMicros: unknown.reservedMicros,
      });
      await f.engine.reconcile(f.workspaceId, unknown.id, {
        action: 'resume',
        reference: 'original-unknown-task-found',
        upstreamId: `fixture-original-${unknown.id}`,
        note: 'Synthetic evidence identifies the original accepted provider task.',
        evidenceUrl: 'https://fixture.invalid/original-provider-task',
      });
      f.behavior.set(unknown.id, { status: 'failed', billedCostMicros: 2345 });
      await f.due(unknown.id);
      await workUntilJob(f.engine, f.workspaceId, unknown.id, (job) => job.settledMicros === 2345);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000 - accepted.reservedMicros - 1234 - 2345,
        reservedMicros: 0,
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT id,input,request_hash,route_snapshot,deployment_snapshot,reserved_micros FROM mr_jobs WHERE workspace_id=$1 ORDER BY id',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual(frozen);
      expect(f.submit.mock.calls.map(([request]) => request.jobId).sort()).toEqual(
        [accepted.id, unknown.id, queued.id].sort(),
      );
      expect(
        f.poll.mock.calls.every(
          ([request]) => request.upstreamId === `fixture-original-${request.jobId}`,
        ),
      ).toBe(true);
      const settleRows = (await ledger(f)).filter((row) => row.kind === 'settle');
      expect(settleRows.filter((row) => row.job_id === accepted.id)).toMatchObject([
        {
          amount_micros: String(accepted.reservedMicros),
          details: { operatorOverrunMicros: 6543 },
        },
      ]);
      expect(settleRows.filter((row) => row.job_id === unknown.id)).toHaveLength(1);
      expect(settleRows.filter((row) => row.job_id === queued.id)).toHaveLength(1);
    });

    it('blocks atomic new comparison admission and preserves an admitted pair replay', async () => {
      const f = await setup();
      const paid = await f.fund();
      const admittedQuote = await f.engine.quoteComparison(
        f.owner,
        'Original admitted pair.',
        staffRefundRoutes,
      );
      const admitted = await f.engine.submitComparison(f.owner, admittedQuote.id);
      const newQuote = await f.engine.quoteComparison(
        f.owner,
        'Unadmitted pair.',
        staffRefundRoutes,
      );
      const wallet = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      await prepare(f, paid, 1_000_000);
      await expect(f.engine.submitComparison(f.owner, newQuote.id)).rejects.toMatchObject({
        code: 'billing_hold',
      });
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      expect(await ledger(f)).toEqual(entries);
      expect((await f.engine.getComparison(f.workspaceId, newQuote.id))?.admittedAt).toBeNull();
      const replay = await f.engine.submitComparison(f.owner, admitted.id);
      expect(replay.jobs.map((job) => job.id)).toEqual(admitted.jobs.map((job) => job.id));
      expect(await f.engine.listJobs(f.workspaceId)).toHaveLength(2);
      expect(f.submit).not.toHaveBeenCalled();
    });

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

    it('reconciles an already-issued refund without dispatching or rewriting its original credit', async () => {
      const f = await setup();
      const paid = await f.fund();
      const eventId = await f.riskHold(paid);
      const original = (await ledger(f)).filter((row) => row.kind === 'credit');
      const wallet = await f.engine.getBalance(f.workspaceId);
      const refund = await prepare(f, paid, 5_000_000, refundEvidence(f, paid, 500));
      expect(refund.origin).toBe('reconcile-existing');
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      await expect(
        f.refunds.dispatch(
          refund.id,
          {
            ...resolution('must-not-dispatch-existing'),
            ...(await currentApproval(f, paid, refund.eligibleMicros)),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_not_dispatchable' });
      const apply = {
        action: 'apply-success' as const,
        ...resolution('apply-existing-refund'),
        ...(await currentApproval(f, paid, refund.eligibleMicros)),
      };
      await f.refunds.reconcile(refund.id, apply, context);
      await f.refunds.reconcile(refund.id, apply, context);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: 0,
      });
      const after = await ledger(f);
      expect(after.filter((row) => row.kind === 'credit')).toEqual(original);
      expect(await f.payments.getOrder(f.workspaceId, paid.order.id)).toEqual(paid.order);
      expect(
        after.filter((row) => row.reference === `staff-refund:${refund.id}:debit`),
      ).toHaveLength(1);
      expect(
        (
          await f.engine.pool.query('SELECT resolved_at FROM mr_billing_holds WHERE event_id=$1', [
            eventId,
          ])
        ).rows,
      ).toEqual([{ resolved_at: null }]);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('keeps an insufficient staff case protected after independent processor-risk hold resolution', async () => {
      const f = await setup();
      const paid = await f.fund();
      const queued = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      const eventId = await f.riskHold(paid);
      const wallet = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      const refund = await prepare(f, paid, 5_000_000, refundEvidence(f, paid, 500));
      expect(refund).toMatchObject({
        state: 'review',
        earmarkedMicros: 0,
        outstandingMicros: 5_000_000,
      });
      const operations = new BillingOperationsStore(f.engine.pool);
      await operations.resolveHold(
        f.workspaceId,
        eventId,
        {
          reference: 'separate-processor-risk-reviewed',
          note: 'The original processor risk event has its own audited review.',
          evidenceUrl: 'https://fixture.invalid/original-processor-risk',
        },
        actor,
        async () => {},
      );
      const staffHoldId = refund.holdIds[0]!;
      expect(staffHoldId).toBeTruthy();
      await expect(
        operations.resolveHold(
          f.workspaceId,
          staffHoldId,
          {
            reference: 'cannot-clear-active-staff-case',
            note: 'A separate risk resolution cannot clear this unresolved staff liability.',
            evidenceUrl: 'https://fixture.invalid/unresolved-staff-refund',
          },
          actor,
          async () => {},
        ),
      ).rejects.toThrow('staff_refund_active');
      for (const billing of ['managed', 'byok'] as const)
        await expect(
          f.engine.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: { ...staffRefundInput, billing },
          }),
        ).rejects.toMatchObject({ code: 'billing_hold' });
      const reviewed = await f.refunds.reconcile(
        refund.id,
        {
          action: 'apply-success',
          ...resolution('cannot-overdraw'),
          ...(await currentApproval(f, paid, refund.eligibleMicros)),
        },
        context,
      );
      expect(reviewed).toMatchObject({
        state: 'review',
        financialState: 'none',
        earmarkedMicros: 0,
        outstandingMicros: 5_000_000,
        reviewRequired: true,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      expect(await ledger(f)).toEqual(entries);
      expect((await f.engine.getJob(f.workspaceId, queued.id))?.reservedMicros).toBe(
        queued.reservedMicros,
      );
      expect(
        (
          await f.engine.pool.query('SELECT resolved_at FROM mr_billing_holds WHERE event_id=$1', [
            staffHoldId,
          ])
        ).rows,
      ).toEqual([{ resolved_at: null }]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*) FROM mr_billing_hold_resolutions WHERE event_id=$1',
            [staffHoldId],
          )
        ).rows[0].count,
      ).toBe('0');
      expect(
        (
          await f.engine.pool.query(
            'SELECT resolved_at IS NOT NULL AS resolved FROM mr_billing_holds WHERE event_id=$1',
            [eventId],
          )
        ).rows,
      ).toEqual([{ resolved: true }]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT earmark_micros,outstanding_micros,financial_state FROM mr_staff_refund_cases WHERE id=$1',
            [refund.id],
          )
        ).rows,
      ).toEqual([{ earmark_micros: '0', outstanding_micros: '5000000', financial_state: 'none' }]);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('refuses a prepared dispatch when an intervening already-issued return consumes its principal', async () => {
      const f = await setup();
      const paid = await f.fund();
      const pending = await prepare(f, paid, 4_000_000);
      const actual = await prepare(f, paid, 2_000_000, refundEvidence(f, paid, 200));
      const refreshed = await currentApproval(f, paid, pending.eligibleMicros);
      await expect(
        f.refunds.dispatch(
          pending.id,
          {
            ...resolution('principal-changed-before-dispatch'),
            ...refreshed,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_principal_exceeded' });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      const rows = (
        await f.engine.pool.query(
          'SELECT id,earmark_micros,dispatched_at FROM mr_staff_refund_cases WHERE workspace_id=$1',
          [f.workspaceId],
        )
      ).rows;
      expect(rows.map((row) => row.id).sort()).toEqual([pending.id, actual.id].sort());
      expect(rows.find((row) => row.id === pending.id)?.dispatched_at).toBeNull();
      expect(
        rows.reduce((total, row) => total + Number(row.earmark_micros), 0),
      ).toBeLessThanOrEqual(5_000_000);
      expect((await ledger(f)).filter((row) => row.reference?.startsWith('staff-refund:'))).toEqual(
        [],
      );
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('counts an itemized external refund once after the same ID becomes an existing-refund case', async () => {
      const f = await setup();
      const paid = await f.fund();
      const evidence = refundEvidence(f, paid, 100);
      const externalReturns: StaffRefundWorksheet['externalReturns'] = [
        {
          refundId: evidence.refundId,
          amountCents: 100,
          status: 'succeeded',
          evidenceReference: evidence.evidenceReference,
        },
      ];
      const pending = await prepare(f, paid, 4_000_000, undefined, externalReturns);
      const actual = await prepare(f, paid, 1_000_000, evidence, externalReturns);
      const claim = await f.refunds.dispatch(
        pending.id,
        {
          ...resolution('deduplicated-original-principal'),
          ...(await currentApproval(f, paid, pending.eligibleMicros, externalReturns)),
        },
        context,
      );
      expect(claim.dispatchClaimed).toBe(true);
      expect(pending.cashCents + actual.cashCents).toBe(500);
      expect(
        (
          await f.engine.pool.query(
            'SELECT sum(principal_claim_cents)::text AS claimed,sum(earmark_micros)::text AS earmarked FROM mr_staff_refund_cases WHERE workspace_id=$1',
            [f.workspaceId],
          )
        ).rows,
      ).toEqual([{ claimed: '500', earmarked: '5000000' }]);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      expect((await ledger(f)).filter((row) => row.reference?.startsWith('staff-refund:'))).toEqual(
        [],
      );
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('recovers only whitelisted approved external-return history from prepare and fresh dispatch worksheets', async () => {
      const f = await setup();
      const paid = await f.fund();
      await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      const before = await f.refunds.reviewEvidence(f.workspaceId, context);
      const prepareReturn = {
        refundId: 're_projection_prepare',
        amountCents: 100,
        status: 'pending' as const,
        evidenceReference: 'fixture-approved-prepare-return',
      };
      const prep = await currentApproval(f, paid, 2_000_000, [prepareReturn]);
      const privatePrepareNote = 'SYNTHETIC_PRIVATE_PREPARE_NOTE_not_for_financial_projection';
      const privatePayer = 'synthetic-person@example.invalid';
      prep.worksheet.note = privatePrepareNote;
      prep.worksheet.originalPayerReference = privatePayer;
      prep.worksheetHash = staffRefundHash(prep.worksheet);
      f.allocationApprovals.set(paid.order.id, {
        paid,
        eligibleMicros: 2_000_000,
        worksheetHash: prep.worksheetHash,
      });
      const refund = await f.refunds.prepare(
        {
          workspaceId: f.workspaceId,
          orderId: paid.order.id,
          reference: 'projection-approved-history',
          origin: 'new',
          eligibleMicros: 2_000_000,
          ...prep,
        },
        context,
      );
      const prepared = await f.refunds.reviewEvidence(f.workspaceId, context);
      expect(prepared.financialRows.externalReturns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_case_id: refund.id,
            phase: 'prepare',
            refund_id: prepareReturn.refundId,
            amount_cents: '100',
            status: 'pending',
            evidence_reference: prepareReturn.evidenceReference,
          }),
        ]),
      );
      expect(prepared.snapshot.exposureHash).not.toBe(before.snapshot.exposureHash);
      const dispatchReturn = {
        refundId: 're_projection_dispatch',
        amountCents: 50,
        status: 'unknown' as const,
        evidenceReference: 'fixture-approved-dispatch-return',
      };
      const current = await currentApproval(f, paid, 2_000_000, [prepareReturn, dispatchReturn]);
      const privateDispatchNote = 'SYNTHETIC_PRIVATE_DISPATCH_NOTE_not_for_financial_projection';
      current.worksheet.note = privateDispatchNote;
      current.worksheet.originalPayerReference = privatePayer;
      current.worksheetHash = staffRefundHash(current.worksheet);
      f.allocationApprovals.set(paid.order.id, {
        paid,
        eligibleMicros: 2_000_000,
        worksheetHash: current.worksheetHash,
      });
      await f.refunds.dispatch(
        refund.id,
        { ...resolution('projection-dispatch'), ...current },
        context,
      );
      const dispatched = await f.refunds.reviewEvidence(f.workspaceId, context);
      expect(dispatched.financialRows.externalReturns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source_case_id: refund.id,
            phase: 'dispatch',
            refund_id: dispatchReturn.refundId,
            amount_cents: '50',
            status: 'unknown',
            evidence_reference: dispatchReturn.evidenceReference,
            audit_reference: 'projection-dispatch',
            audit_ordinal: expect.any(String),
          }),
        ]),
      );
      expect(dispatched.snapshot.exposureHash).not.toBe(prepared.snapshot.exposureHash);
      const wallet = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      const unapprovedId = 're_unapproved_observer_payload';
      const privateObserveNote = 'SYNTHETIC_PRIVATE_OBSERVER_NOTE_not_for_financial_projection';
      const observerInput = {
        ...resolution('projection-observer'),
        note: privateObserveNote,
        worksheet: {
          externalReturns: [{ refundId: unapprovedId, amountCents: 500, status: 'succeeded' }],
        },
      };
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        refundEvidence(f, paid, 200, undefined, { status: 'pending' }),
        observerInput,
        context,
      );
      const reviewed = await f.refunds.reviewEvidence(f.workspaceId, context);
      expect(reviewed.snapshot.exposureHash).toBe(staffRefundHash(reviewed.financialRows));
      const projected = reviewed.financialRows.externalReturns!;
      expect(projected.map((row) => row.refund_id)).toEqual(
        expect.arrayContaining([prepareReturn.refundId, dispatchReturn.refundId]),
      );
      expect(projected.some((row) => row.refund_id === unapprovedId)).toBe(false);
      const allowed = new Set([
        'source_case_id',
        'source_case_reference',
        'phase',
        'audit_reference',
        'audit_ordinal',
        'refund_id',
        'amount_cents',
        'status',
        'definitive_failure_balance_returned',
        'evidence_reference',
      ]);
      for (const row of projected)
        expect(Object.keys(row).every((key) => allowed.has(key))).toBe(true);
      const changedProjection = structuredClone(reviewed.financialRows);
      changedProjection.externalReturns![0]!.amount_cents = '499';
      expect(staffRefundHash(changedProjection)).not.toBe(reviewed.snapshot.exposureHash);
      for (const privateValue of [
        privatePrepareNote,
        privateDispatchNote,
        privateObserveNote,
        privatePayer,
        unapprovedId,
        staffRefundInput.input.prompt as string,
      ])
        expect(JSON.stringify(reviewed)).not.toContain(privateValue);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      expect(await ledger(f)).toEqual(entries);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('observes against the latest approved dispatch worksheet despite inverted audit timestamps and preserves frozen prepare', async () => {
      const f = await setup();
      const paid = await f.fund();
      // Simulate transaction-start clocks committing in the opposite order.
      // Only defaults in this isolated fixture schema change; audit rows remain immutable.
      await f.engine.pool.query(
        "ALTER TABLE mr_staff_refund_audit ALTER COLUMN created_at SET DEFAULT '2031-01-02T00:00:00Z'::timestamptz",
      );
      const refund = await prepare(f, paid, 2_000_000);
      const frozenBefore = (
        await f.engine.pool.query(
          'SELECT worksheet,worksheet_hash,frozen_body,request_hash FROM mr_staff_refund_cases WHERE id=$1',
          [refund.id],
        )
      ).rows;
      expect(frozenBefore[0].worksheet.externalReturns).toEqual([]);
      await f.engine.pool.query(
        "ALTER TABLE mr_staff_refund_audit ALTER COLUMN created_at SET DEFAULT '2031-01-01T00:00:00Z'::timestamptz",
      );
      const otherReturn = {
        refundId: 're_other_after_prepare',
        amountCents: 100,
        status: 'pending' as const,
        evidenceReference: 'fixture-current-other-refund',
      };
      const current = await currentApproval(f, paid, 2_000_000, [otherReturn]);
      await f.refunds.dispatch(
        refund.id,
        { ...resolution('approved-later-dispatch'), ...current },
        context,
      );
      const phases = (
        await f.engine.pool.query(
          "SELECT action,ordinal::text,created_at FROM mr_staff_refund_audit WHERE case_id=$1 AND action IN ('prepare','dispatch') ORDER BY ordinal",
          [refund.id],
        )
      ).rows;
      const prep = phases.find((row) => row.action === 'prepare')!;
      const dispatch = phases.find((row) => row.action === 'dispatch')!;
      expect(BigInt(dispatch.ordinal)).toBeGreaterThan(BigInt(prep.ordinal));
      expect(dispatch.created_at.getTime()).toBeLessThan(prep.created_at.getTime());
      const evidence = refundEvidence(f, paid, 200);
      const observed = await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        evidence,
        resolution('standalone-observation-after-new-return'),
        context,
      );
      expect(observed).toMatchObject({
        state: 'succeeded',
        reviewRequired: false,
        financialState: 'none',
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT case_id,refund_id FROM mr_staff_refund_observations WHERE event_id=$1',
            [evidence.eventId],
          )
        ).rows,
      ).toEqual([{ case_id: refund.id, refund_id: evidence.refundId }]);
      const applied = await f.refunds.reconcile(
        refund.id,
        {
          action: 'apply-success',
          ...resolution('apply-latest-approved-return-history'),
          ...(await currentApproval(f, paid, 2_000_000, [otherReturn])),
        },
        context,
      );
      expect(applied).toMatchObject({
        financialState: 'debited',
        reviewRequired: false,
        outstandingMicros: 0,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 3_000_000,
        reservedMicros: 0,
      });
      expect(
        (await ledger(f)).filter((row) => row.reference === `staff-refund:${refund.id}:debit`),
      ).toHaveLength(1);
      expect(
        (
          await f.engine.pool.query(
            'SELECT worksheet,worksheet_hash,frozen_body,request_hash FROM mr_staff_refund_cases WHERE id=$1',
            [refund.id],
          )
        ).rows,
      ).toEqual(frozenBefore);
      expect(await f.payments.getOrder(f.workspaceId, paid.order.id)).toEqual(paid.order);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('requires fresh bound success reaffirmation after a stale pending observation and resolves only selected holds', async () => {
      const f = await setup();
      const paid = await f.fund();
      const refund = await prepare(f, paid, 2_000_000);
      await f.refunds.dispatch(
        refund.id,
        {
          ...resolution('ordering-dispatch'),
          ...(await currentApproval(f, paid, 2_000_000)),
        },
        context,
      );
      const at = Math.floor(Date.now() / 1000);
      const success = refundEvidence(f, paid, 200, undefined, { created: at + 10 });
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        success,
        resolution('success-before-stale'),
        context,
      );
      const stale = refundEvidence(f, paid, 200, success.refundId, {
        status: 'pending',
        created: at,
      });
      const review = await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        stale,
        resolution('stale-pending'),
        context,
      );
      expect(review).toMatchObject({
        state: 'review',
        financialState: 'none',
        earmarkedMicros: 2_000_000,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      await expect(
        f.refunds.reconcile(
          refund.id,
          {
            action: 'apply-success',
            ...resolution('cannot-clear-ordering-alone'),
            ...(await currentApproval(f, paid, 2_000_000)),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      const reaffirm = refundEvidence(f, paid, 200, success.refundId, { created: at + 20 });
      const selected = refund.holdIds[0]!;
      const action = {
        action: 'apply-success' as const,
        ...resolution('reaffirm-exact-original-success'),
        ...(await currentApproval(f, paid, 2_000_000, [], reaffirm)),
        reaffirmLatestEvidence: reaffirm,
        resolveHoldIds: [selected],
        holdResolutionEvidenceUrl: 'https://fixture.invalid/selected-success-hold',
      };
      const applied = await f.refunds.reconcile(refund.id, action, context);
      expect(applied).toMatchObject({
        financialState: 'debited',
        reviewRequired: false,
        earmarkedMicros: 0,
      });
      const holds = (
        await f.engine.pool.query(
          'SELECT event_id,resolved_at FROM mr_billing_holds WHERE staff_refund_case_id=$1',
          [refund.id],
        )
      ).rows;
      expect(holds.find((row) => row.event_id === selected)?.resolved_at).not.toBeNull();
      expect(
        holds.filter((row) => row.event_id !== selected).every((row) => row.resolved_at === null),
      ).toBe(true);
      expect(holds.filter((row) => row.resolved_at === null).length).toBeGreaterThan(0);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 3_000_000,
        reservedMicros: 0,
      });
      const entries = await ledger(f);
      const debit = entries.find((row) => row.reference === `staff-refund:${refund.id}:debit`)!;
      for (const privateValue of [
        success.refundId,
        paid.paymentIntentId,
        f.processorEnvironment.accountId,
        actor.id,
      ])
        expect(JSON.stringify(debit.details)).not.toContain(privateValue);
      await f.refunds.reconcile(refund.id, action, context);
      expect(await ledger(f)).toEqual(entries);
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

    it.each(['released', 'restored'] as const)(
      'keeps a %s case finalized after new failed balance-return observations and allows replacement dispatch',
      async (mode) => {
        const { f, paid, first, refundId, at, failureBalanceTransactionId } =
          await finalizedFailedRefund(mode);
        const finalizedHolds = await caseHolds(f, first.id);
        expect(finalizedHolds.length).toBeGreaterThan(0);
        expect(finalizedHolds.every((hold) => hold.resolved_at !== null)).toBe(true);
        const replacement = await prepare(f, paid, 5_000_000);
        const wallet = await f.engine.getBalance(f.workspaceId);
        const entries = await ledger(f);
        // Distinct verified event IDs exercise observation handling, rather than
        // the earlier exact-event replay short circuit. An older same-state
        // receipt must also preserve the latest definitive failure.
        const newer = refundEvidence(f, paid, 500, refundId, {
          status: 'failed',
          created: at + 30,
          failureBalanceTransactionId,
        });
        const older = refundEvidence(f, paid, 500, refundId, {
          status: 'failed',
          created: at + 5,
          failureBalanceTransactionId,
        });
        expect(newer.eventId).not.toBe(older.eventId);
        for (const evidence of [newer, older]) {
          const observed = await f.refunds.observeVerifiedProcessorEvidence(
            first.id,
            evidence,
            resolution(),
            context,
          );
          expect(observed).toMatchObject({
            state: 'failed',
            financialState: mode,
            reviewRequired: false,
            earmarkedMicros: 0,
            outstandingMicros: 0,
          });
          expect(await caseHolds(f, first.id)).toEqual(finalizedHolds);
          expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
          expect(await ledger(f)).toEqual(entries);
        }
        expect(
          (
            await f.engine.pool.query(
              'SELECT latest_status,latest_event_created,definitive_failure_balance_returned,evidence_conflict,ordering_review FROM mr_staff_refund_cases WHERE id=$1',
              [first.id],
            )
          ).rows,
        ).toEqual([
          {
            latest_status: 'failed',
            latest_event_created: String(at + 30),
            definitive_failure_balance_returned: true,
            evidence_conflict: false,
            ordering_review: false,
          },
        ]);
        const claimed = await f.refunds.dispatch(
          replacement.id,
          {
            ...resolution('replacement-after-final-failure'),
            ...(await currentApproval(f, paid, 5_000_000)),
          },
          context,
        );
        expect(claimed).toMatchObject({
          dispatchClaimed: true,
          earmarkedMicros: 5_000_000,
          reviewRequired: false,
        });
        expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
        expect(await ledger(f)).toEqual(entries);
        expect(await f.payments.getOrder(f.workspaceId, paid.order.id)).toEqual(paid.order);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.poll).not.toHaveBeenCalled();
      },
    );

    it.each(
      (['released', 'restored'] as const).flatMap((mode) =>
        (['pending', 'succeeded', 'changed-amount', 'missing-balance-proof'] as const).map(
          (change) => ({ mode, change }),
        ),
      ),
    )(
      '$change evidence cannot reuse the failed-claim exclusion after $mode finalization',
      async ({ mode, change }) => {
        const { f, paid, first, refundId, at, failureBalanceTransactionId } =
          await finalizedFailedRefund(mode);
        const finalizedHolds = await caseHolds(f, first.id);
        const replacement = await prepare(f, paid, 5_000_000);
        const wallet = await f.engine.getBalance(f.workspaceId);
        const entries = await ledger(f);
        const evidence = refundEvidence(
          f,
          paid,
          change === 'changed-amount' ? 499 : 500,
          refundId,
          {
            status:
              change === 'pending' ? 'pending' : change === 'succeeded' ? 'succeeded' : 'failed',
            created: at + 30,
            ...(change === 'changed-amount' ? { failureBalanceTransactionId } : {}),
          },
        );
        const observed = await f.refunds.observeVerifiedProcessorEvidence(
          first.id,
          evidence,
          resolution(),
          context,
        );
        expect(observed).toMatchObject({
          state: 'review',
          financialState: mode,
          reviewRequired: true,
        });
        const holds = await caseHolds(f, first.id);
        expect(holds.filter((hold) => hold.resolved_at === null).length).toBeGreaterThan(0);
        for (const old of finalizedHolds)
          expect(holds.find((hold) => hold.event_id === old.event_id)).toEqual(old);
        await expect(
          f.refunds.dispatch(
            replacement.id,
            {
              ...resolution('unresolved-first-return-blocks-replacement'),
              ...(await currentApproval(f, paid, 5_000_000)),
            },
            context,
          ),
        ).rejects.toMatchObject({ code: 'staff_refund_principal_exceeded' });
        expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
        expect(await ledger(f)).toEqual(entries);
        expect(
          (
            await f.engine.pool.query(
              'SELECT dispatched_at FROM mr_staff_refund_cases WHERE id=$1',
              [replacement.id],
            )
          ).rows,
        ).toEqual([{ dispatched_at: null }]);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.poll).not.toHaveBeenCalled();
      },
    );

    it('batches registered-refund observation reads across dispatch, observation and reconciliation', async () => {
      async function measuredChain(registeredCount: number) {
        const f = await setup();
        try {
          const paid = await f.fund();
          const externalReturns: StaffRefundWorksheet['externalReturns'][number][] = [];
          for (let index = 0; index < registeredCount; index++) {
            const evidence = refundEvidence(f, paid, 1);
            await prepare(f, paid, 10_000, evidence);
            externalReturns.push({
              refundId: evidence.refundId,
              amountCents: 1,
              status: 'succeeded',
              evidenceReference: evidence.evidenceReference,
            });
          }
          const target = await prepare(f, paid, 1_000_000, undefined, externalReturns);
          const claim = {
            ...resolution('bounded-observation-dispatch'),
            ...(await currentApproval(f, paid, 1_000_000, externalReturns)),
          };
          // Observe the actual max-one fixture pool client without replacing
          // queries or introducing a transport wrapper. Snapshot and hold-proof
          // reads are deliberately outside this distinct amount-read counter.
          const client = await f.engine.pool.connect();
          const queries = vi.spyOn(client, 'query');
          client.release();
          try {
            const amountReads = () =>
              queries.mock.calls.flatMap(([statement]) => {
                const text =
                  typeof statement === 'string'
                    ? statement
                    : statement && typeof statement === 'object' && 'text' in statement
                      ? String(statement.text)
                      : '';
                return /\bSELECT\s+DISTINCT\b/i.test(text) &&
                  /\b(?:FROM|JOIN)\s+mr_staff_refund_observations\b/i.test(text) &&
                  text.includes('amountCents')
                  ? [text]
                  : [];
              });
            let previous = 0;
            const phases: number[] = [];
            const checkpoint = () => {
              const current = amountReads().length;
              phases.push(current - previous);
              previous = current;
            };
            await f.refunds.dispatch(target.id, claim, context);
            checkpoint();
            await f.refunds.observeVerifiedProcessorEvidence(
              target.id,
              refundEvidence(f, paid, 100),
              resolution('bounded-observation-success'),
              context,
            );
            checkpoint();
            const applied = await f.refunds.reconcile(
              target.id,
              {
                action: 'apply-success',
                ...resolution('bounded-observation-financial-application'),
                ...(await currentApproval(f, paid, 1_000_000, externalReturns)),
              },
              context,
            );
            checkpoint();
            expect(applied).toMatchObject({ financialState: 'debited', reviewRequired: false });
            expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
              availableMicros: 4_000_000,
              reservedMicros: 0,
            });
            expect(
              (await ledger(f)).filter(
                (row) => row.reference === `staff-refund:${target.id}:debit`,
              ),
            ).toHaveLength(1);
            expect(f.submit).not.toHaveBeenCalled();
            expect(f.poll).not.toHaveBeenCalled();
            return phases;
          } finally {
            queries.mockRestore();
          }
        } finally {
          await f.close();
          close = undefined;
        }
      }
      const small = await measuredChain(2);
      const many = await measuredChain(12);
      // Each operation performs one scoped batched read, regardless of item
      // cardinality. The old per-item implementation grows from 2 to 12 reads.
      expect({ small, many }).toEqual({ small: [1, 1, 1], many: [1, 1, 1] });
    }, 30_000);

    it('never auto-clears hard money conflicts from a later failed-return proof', async () => {
      const f = await setup();
      const paid = await f.fund();
      const refund = await prepare(f, paid, 2_000_000);
      await f.refunds.dispatch(
        refund.id,
        {
          ...resolution('hard-conflict-dispatch'),
          ...(await currentApproval(f, paid, 2_000_000)),
        },
        context,
      );
      const at = Math.floor(Date.now() / 1000);
      const wrongAmount = refundEvidence(f, paid, 250, undefined, { created: at });
      await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        wrongAmount,
        resolution('wrong-cash-amount'),
        context,
      );
      const failed = refundEvidence(f, paid, 200, wrongAmount.refundId, {
        status: 'failed',
        created: at + 10,
        failureBalanceTransactionId: 'txn_fixture_hard_conflict',
      });
      const review = await f.refunds.observeVerifiedProcessorEvidence(
        refund.id,
        failed,
        resolution('failed-after-money-conflict'),
        context,
      );
      const entries = await ledger(f);
      await expect(
        f.refunds.reconcile(
          refund.id,
          {
            action: 'release-failed',
            ...resolution('cannot-waive-money-conflict'),
            ...(await currentApproval(f, paid, 2_000_000, [], failed)),
            reaffirmLatestEvidence: failed,
            resolveHoldIds: review.holdIds,
            holdResolutionEvidenceUrl: 'https://fixture.invalid/hard-money-conflict',
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      expect(await ledger(f)).toEqual(entries);
      expect(
        (
          await f.engine.pool.query(
            'SELECT evidence_conflict,earmark_micros,financial_state FROM mr_staff_refund_cases WHERE id=$1',
            [refund.id],
          )
        ).rows,
      ).toEqual([{ evidence_conflict: true, earmark_micros: '2000000', financial_state: 'none' }]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*) FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NOT NULL',
            [refund.id],
          )
        ).rows[0].count,
      ).toBe('0');
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
        'INSERT INTO mr_billing_processor_environments(id,account_id,livemode) VALUES($1,$2,false)',
        [foreignEnvironment, `acct_foreign${randomUUID().replaceAll('-', '')}`],
      );
      const foreignId = `evt_foreign_${randomUUID().replaceAll('-', '')}`;
      const wrongModeId = `evt_wrongmode_${randomUUID().replaceAll('-', '')}`;
      await f.engine.pool.query(
        `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,processor_environment_id,state)
         VALUES($1,'charge.refunded','ch_foreign_projection',$3,false,$4,$5,'pending'),
               ($2,'charge.refunded','ch_wrongmode_projection',$3,true,$4,$6,'pending')`,
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
            row.processor_environment_id === f.processorEnvironment.id && row.livemode === false,
        ),
      ).toBe(true);
      expect(JSON.stringify(after)).not.toContain(foreignId);
      expect(JSON.stringify(after)).not.toContain(wrongModeId);
      expect(after.snapshot).toEqual(before.snapshot);
    });

    it('returns a complete hash-bound financial review without prompts, provider keys or read mutations', async () => {
      const f = await setup();
      const paid = await f.fund();
      const other = await f.fund();
      const deployment = catalog.routes.find(
        (route) => route.id === staffRefundRoutes[0],
      )!.deploymentId;
      const privateKey = 'synthetic-private-provider-key-excluded-from-staff-review';
      await f.engine.accounts.putConnection(f.workspaceId, deployment, { apiKey: privateKey });
      const queued = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: staffRefundInput,
      });
      const refund = await prepare(f, paid, 1_000_000);
      const wallet = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      const evidence = await f.refunds.reviewEvidence(f.workspaceId, context);
      expect(evidence.snapshot.exposureHash).toBe(staffRefundHash(evidence.financialRows));
      expect(evidence.snapshot).toEqual(await f.refunds.snapshot(f.workspaceId, context));
      expect(Object.keys(evidence.financialRows)).toEqual(
        expect.arrayContaining([
          'jobs',
          'ledger',
          'attempts',
          'intents',
          'keyReservations',
          'funding',
          'automaticFunding',
          'holds',
          'cases',
          'observations',
          'events',
        ]),
      );
      expect(evidence.financialRows.funding!.map((row) => row.id).sort()).toEqual(
        [paid.order.id, other.order.id].sort(),
      );
      expect(evidence.financialRows.jobs).toEqual([
        expect.objectContaining({ id: queued.id, reserved_micros: String(queued.reservedMicros) }),
      ]);
      expect(evidence.financialRows.intents).toEqual([
        expect.objectContaining({ job_id: queued.id, submission_intent_at: null }),
      ]);
      expect(evidence.financialRows.cases).toEqual([
        expect.objectContaining({ id: refund.id, earmark_micros: '1000000' }),
      ]);
      expect(evidence.financialRows.holds).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ staff_refund_case_id: refund.id, resolved_at: null }),
        ]),
      );
      const encoded = JSON.stringify(evidence);
      expect(encoded).not.toContain(staffRefundInput.input.prompt as string);
      expect(encoded).not.toContain(privateKey);
      for (const rows of Object.values(evidence.financialRows))
        for (const row of rows)
          for (const forbidden of [
            'input',
            'outputs',
            'metadata',
            'prompt',
            'api_key',
            'token',
            'source_url',
          ])
            expect(row).not.toHaveProperty(forbidden);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(wallet);
      expect(await ledger(f)).toEqual(entries);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    });

    it('rejects a worksheet that names another funding payment before any earmark or debit', async () => {
      const f = await setup();
      const paid = await f.fund();
      const other = await f.fund();
      const approved = await worksheet(f, paid, 4_000_000);
      f.allocationApprovals.set(paid.order.id, {
        paid,
        eligibleMicros: 4_000_000,
        worksheetHash: approved.worksheetHash,
      });
      const changed = {
        ...approved.worksheet,
        allocation: [
          {
            ...approved.worksheet.allocation[0]!,
            fundingReference: `stripe-topup:${other.order.id}`,
          },
        ],
      };
      const before = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      await expect(
        f.refunds.prepare(
          {
            workspaceId: f.workspaceId,
            orderId: paid.order.id,
            reference: 'wrong-original-funding',
            origin: 'new',
            eligibleMicros: 4_000_000,
            worksheet: changed,
            worksheetHash: staffRefundHash(changed),
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_allocation_unapproved', statusCode: 403 });
      expect(f.approveAllocation).not.toHaveBeenCalled();
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(before);
      expect(await ledger(f)).toEqual(entries);
      expect(
        (await f.engine.pool.query('SELECT count(*) FROM mr_staff_refund_cases')).rows[0].count,
      ).toBe('0');
      expect(
        (await f.engine.pool.query('SELECT count(*) FROM mr_billing_holds')).rows[0].count,
      ).toBe('0');
    });

    it('denies a changed allocation proof even when its JSON hash and paid sum are internally valid', async () => {
      const f = await setup();
      const paid = await f.fund();
      const approved = await worksheet(f, paid, 4_000_000);
      f.allocationApprovals.set(paid.order.id, {
        paid,
        eligibleMicros: 4_000_000,
        worksheetHash: approved.worksheetHash,
      });
      const changed = {
        ...approved.worksheet,
        allocation: [
          { ...approved.worksheet.allocation[0]!, relatedReference: 'unapproved-allocation-proof' },
        ],
      };
      const before = await f.engine.getBalance(f.workspaceId);
      const entries = await ledger(f);
      await expect(
        f.refunds.prepare(
          {
            workspaceId: f.workspaceId,
            orderId: paid.order.id,
            reference: 'changed-allocation-proof',
            origin: 'new',
            eligibleMicros: 4_000_000,
            worksheet: changed,
            worksheetHash: staffRefundHash(changed),
          },
          context,
        ),
      ).rejects.toThrow('Synthetic original-payment allocation approval refused.');
      expect(f.approveAllocation).toHaveBeenCalledTimes(1);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(before);
      expect(await ledger(f)).toEqual(entries);
      expect(
        (await f.engine.pool.query('SELECT count(*) FROM mr_staff_refund_cases')).rows[0].count,
      ).toBe('0');
      expect(
        (await f.engine.pool.query('SELECT count(*) FROM mr_billing_holds')).rows[0].count,
      ).toBe('0');
    });
  },
);

// These races require independent PostgreSQL sessions and are never counted as
// concurrency qualification by the single-backend PGlite wire fixture.
describe.skipIf(!process.env.TEST_DATABASE_URL || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native staff refund serialization against admission and another case',
  () => {
    it('commits a hold before an actually blocked admission from another session', async () => {
      const f = await setup();
      const paid = await f.fund();
      const approved = await currentApproval(f, paid, 4_000_000);
      const sessions = await nativeSessions(f);
      const held = latch(),
        release = latch();
      let gated = false;
      f.allocationControl.beforeApproval = async () => {
        if (gated) return;
        gated = true;
        held.release();
        await release.promise;
      };
      const preparing = sessions.refunds.prepare(
        {
          workspaceId: f.workspaceId,
          orderId: paid.order.id,
          reference: 'native-refund-wins-admission',
          origin: 'new',
          eligibleMicros: 4_000_000,
          ...approved,
        },
        context,
      );
      let admission: Promise<{ error?: unknown; admitted?: unknown }> | undefined;
      try {
        await Promise.race([
          held.promise,
          preparing.then(() => {
            throw new Error('Expected the refund allocation gate.');
          }),
        ]);
        admission = f.engine
          .submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: staffRefundInput,
          })
          .then(
            (admitted) => ({ admitted }),
            (error: unknown) => ({ error }),
          );
        expect(await waitForDatabaseLock(sessions.observer, sessions.firstPid)).toMatchObject({
          wait_event_type: 'Lock',
        });
        release.release();
        const prepared = await preparing;
        expect(await admission).toMatchObject({ error: { code: 'billing_hold' } });
        expect(await f.engine.listJobs(f.workspaceId)).toEqual([]);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 5_000_000,
          reservedMicros: 0,
        });
        const evidence = await f.refunds.reviewEvidence(f.workspaceId, context);
        expect(evidence.financialRows.cases).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: prepared.id, earmark_micros: '4000000' }),
          ]),
        );
        expect(f.submit).not.toHaveBeenCalled();
      } finally {
        release.release();
        await Promise.allSettled([preparing, ...(admission ? [admission] : [])]);
      }
    });

    it('serializes partial cases for the same payment and requires the loser to include the winner', async () => {
      const f = await setup();
      const paid = await f.fund();
      const approved = await currentApproval(f, paid, 2_000_000);
      const sessions = await nativeSessions(f);
      const held = latch(),
        release = latch();
      let gated = false;
      f.allocationControl.beforeApproval = async () => {
        if (gated) return;
        gated = true;
        held.release();
        await release.promise;
      };
      const firstInput = {
        workspaceId: f.workspaceId,
        orderId: paid.order.id,
        reference: 'native-partial-first',
        origin: 'new' as const,
        eligibleMicros: 2_000_000,
        ...approved,
      };
      const secondInput = { ...firstInput, reference: 'native-partial-second' };
      const first = f.refunds.prepare(firstInput, context);
      let second: Promise<{ error?: unknown; value?: unknown }> | undefined;
      try {
        await Promise.race([
          held.promise,
          first.then(() => {
            throw new Error('Expected the first partial-case gate.');
          }),
        ]);
        second = sessions.refunds.prepare(secondInput, context).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        const blocked = await waitForDatabaseLock(sessions.observer, sessions.secondPid);
        expect(blocked).toMatchObject({ wait_event_type: 'Lock', wait_event: 'advisory' });
        release.release();
        const winner = await first;
        expect(await second).toMatchObject({ error: { code: 'staff_refund_conflict' } });
        const evidence = await f.refunds.reviewEvidence(f.workspaceId, context);
        expect(evidence.snapshot.exposureHash).not.toBe(approved.worksheet.snapshot.exposureHash);
        expect(evidence.financialRows.cases).toHaveLength(1);
        expect(evidence.financialRows.cases![0]).toMatchObject({ id: winner.id });
        const refreshed = await currentApproval(f, paid, 2_000_000);
        const other = await sessions.refunds.prepare({ ...secondInput, ...refreshed }, context);
        expect(other.id).not.toBe(winner.id);
        expect(winner.earmarkedMicros + other.earmarkedMicros).toBe(4_000_000);
        expect(winner.cashCents + other.cashCents).toBe(400);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 5_000_000,
          reservedMicros: 0,
        });
        expect(
          (await ledger(f)).filter((row) => row.kind !== 'opening' && row.kind !== 'credit'),
        ).toEqual([]);
        expect(f.submit).not.toHaveBeenCalled();
      } finally {
        release.release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    });
  },
);
