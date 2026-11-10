import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgedCostReliefStore,
  creditWorkspaceInTransaction,
  SubmissionRejected,
} from '@media-router/engine';
import { StaffRefundStore } from '../packages/engine/src/staff-refunds.js';
import { BillingOperationsStore } from '../packages/engine/src/billing-operations.js';
import {
  agedCostReliefFixture,
  agedCostReliefTestDatabaseUrl,
  agedReliefFallbackRoutes,
  agedReliefOpeningMicros,
  agedReliefPolicyVersion,
} from './aged-cost-relief-fixture.js';

const configured = Boolean(process.env.TEST_DATABASE_URL);
const native = configured && process.env.TEST_NATIVE_POSTGRES === '1';
type Fixture = Awaited<ReturnType<typeof agedCostReliefFixture>>;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Aged-cost fixtures cannot make provider, payment or other HTTP calls.');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

async function ledger(f: Fixture) {
  return (
    await f.engine.pool.query(
      'SELECT row_to_json(t)::text AS row FROM mr_ledger t WHERE workspace_id=$1 ORDER BY created_at,id',
      [f.workspaceId],
    )
  ).rows;
}
async function walletAndLedger(f: Fixture) {
  return { wallet: await f.engine.getBalance(f.workspaceId), ledger: await ledger(f) };
}
async function reliefCredits(f: Fixture) {
  return (
    await f.engine.pool.query(
      "SELECT id,amount_micros::text,available_delta_micros::text,reserved_delta_micros::text FROM mr_ledger WHERE workspace_id=$1 AND kind='credit' ORDER BY id",
      [f.workspaceId],
    )
  ).rows;
}
async function supplierCost(f: Fixture, jobId: string) {
  const row = (
    await f.engine.pool.query<{ upstream_cost_micros: string | null }>(
      'SELECT upstream_cost_micros FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
      [f.workspaceId, jobId],
    )
  ).rows[0]!;
  return row.upstream_cost_micros === null ? null : Number(row.upstream_cost_micros);
}
async function attemptedTransaction(f: Fixture, change: (client: PoolClient) => Promise<unknown>) {
  const client = await f.engine.pool.connect();
  try {
    await client.query('BEGIN');
    await change(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function waitForBlockedSessions(client: PoolClient, blocker: number, count: number) {
  let predecessors = [blocker];
  for (let attempt = 0; attempt < 100; attempt++) {
    // The blocker intentionally remains in one transaction. Refresh the
    // statistics snapshot so each observation sees newly waiting sessions.
    await client.query('SELECT pg_stat_clear_snapshot()');
    const rows = (
      await client.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pg_blocking_pids(pid) && $1::integer[]",
        [predecessors],
      )
    ).rows;
    if (rows.length >= count) return rows.map((row) => row.pid);
    predecessors = [...new Set([blocker, ...predecessors, ...rows.map((row) => row.pid)])];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Independent native sessions did not reach the expected workspace lock queue.');
}

describe('aged-cost fixture and default activation boundaries', () => {
  it.each([
    undefined,
    'postgresql://db.example.invalid/postgres',
    'postgresql://localhost/opengen_billing_sandbox_261106',
    'postgresql://localhost/customer_data',
    'postgresql://localhost/postgres?options=-c%20search_path=public',
  ])('rejects an unapproved database target before opening it', (url) => {
    expect(() => agedCostReliefTestDatabaseUrl(url)).toThrow();
  });

  it('accepts only explicit loopback fixture database names', () => {
    const url = 'postgresql://fixture@127.0.0.1:55419/opengen_aged_cost_relief_unit';
    expect(agedCostReliefTestDatabaseUrl(url)).toBe(url);
  });

  it('keeps default-closed review and grant from acquiring a database connection', async () => {
    const connect = vi.fn(async () => {
      throw new Error('Closed relief must not acquire a connection.');
    });
    const store = new AgedCostReliefStore({ connect } as unknown as Pool, {
      policyVersion: agedReliefPolicyVersion,
      creditInTransaction: creditWorkspaceInTransaction,
      authorize: async () => ({ kind: 'installation-operator', id: 'fixture-owner' }),
    });
    const selected = {
      workspaceId: 'fixture-workspace',
      jobId: randomUUID(),
      allocation: [{ ledgerId: randomUUID(), amountMicros: 100 }],
    };
    await expect(store.review(selected, {})).rejects.toThrow();
    await expect(
      store.grant(
        {
          ...selected,
          reference: 'fixture-closed-relief',
          note: 'Closed module fixture.',
          evidenceUrl: 'https://fixture.invalid/closed-relief',
          snapshotHash: 'a'.repeat(64),
        },
        {},
      ),
    ).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe.skipIf(!configured)('bounded staff relief preserves original supplier accounting', () => {
  it('credits one full accepted exposure without changing accepted work, supplier unknown or key quota', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const selected = await f.packet(job);
      const original = await f.originalJobRecords(job.id);
      const exposure = await f.keyExposure();
      const before = await f.engine.getBalance(f.workspaceId);
      const receipt = await f.store.grant(selected.input, f.context);
      expect(receipt).toMatchObject({
        workspaceId: f.workspaceId,
        jobId: job.id,
        amountMicros: job.reservedMicros,
        allocation: selected.reviewed.allocation,
      });
      expect(receipt.creditLedgerId).toEqual(expect.any(String));
      expect(receipt.allocation).toEqual([
        expect.objectContaining({
          sourceLedgerId: f.originalCredit.id,
          character: 'noncash',
          originalPayment: null,
          amountMicros: job.reservedMicros,
        }),
      ]);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual({
        ...before,
        availableMicros: before.availableMicros + job.reservedMicros,
      });
      expect(await f.originalJobRecords(job.id)).toEqual(original);
      expect(await f.keyExposure()).toEqual(exposure);
      const incomplete = {
        ...f.target(job),
        allocation: [{ ledgerId: f.originalCredit.id, amountMicros: job.reservedMicros - 1 }],
      };
      await expect(f.store.review(incomplete, f.context)).rejects.toThrow();
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        settledMicros: null,
        reservedMicros: job.reservedMicros,
      });
      expect(await supplierCost(f, job.id)).toBeNull();
      expect(
        (await f.engine.pool.query('SELECT upstream_id FROM mr_jobs WHERE id=$1', [job.id])).rows,
      ).toEqual([{ upstream_id: `fixture-aged-${job.id}` }]);
      expect(await reliefCredits(f)).toEqual([
        {
          id: receipt.creditLedgerId,
          amount_micros: String(job.reservedMicros),
          available_delta_micros: String(job.reservedMicros),
          reserved_delta_micros: '0',
        },
      ]);
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.poll).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('replays an exact staff decision once and rejects changed or second decisions for the same job', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const { input } = await f.packet(job);
      const secondDecision = await f.packet(job);
      const first = await f.store.grant(input, f.context);
      const before = await walletAndLedger(f);
      expect(await f.store.grant(input, f.context)).toEqual(first);
      await expect(
        f.store.grant(
          { ...input, note: 'Different evidence under the original reference.' },
          f.context,
        ),
      ).rejects.toThrow();
      await expect(f.store.grant(secondDecision.input, f.context)).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(before);
      expect(await reliefCredits(f)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('retains the original paid purchase and processor identity in relief and staff refund evidence', async () => {
    const f = await agedCostReliefFixture({ paid: true });
    try {
      const paid = f.originalPayment!;
      const job = await f.admit();
      const staff = new StaffRefundStore(f.engine.pool, {
        activation: 'fixture',
        processorEnvironment: f.processorEnvironment,
        authorize: f.storeOptions.authorize,
      });
      const before = await staff.reviewEvidence(f.workspaceId, f.context);
      const selected = await f.packet(job);
      const receipt = await f.store.grant(selected.input, f.context);
      expect(receipt.allocation).toEqual([
        expect.objectContaining({
          sourceLedgerId: f.originalCredit.id,
          sourceReference: `stripe-topup:${paid.orderId}`,
          character: 'paid',
          amountMicros: job.reservedMicros,
          originalPayment: {
            kind: 'manual',
            localId: paid.orderId,
            paymentIntentId: paid.paymentIntentId,
            processorEnvironmentId: f.processorEnvironment.id,
            processorAccountId: f.processorEnvironment.accountId,
            livemode: false,
            originalAmountCents: 500,
            createdAt: paid.createdAt,
            creditedAt: paid.creditedAt,
          },
        }),
      ]);
      const granted = await staff.reviewEvidence(f.workspaceId, f.context);
      expect(granted.snapshot.exposureHash).not.toBe(before.snapshot.exposureHash);
      expect(granted.financialRows.agedCostReliefs).toEqual([
        expect.objectContaining({
          job_id: job.id,
          credit_ledger_id: receipt.creditLedgerId,
          allocation: receipt.allocation,
        }),
      ]);
      const originalOrder = (
        await f.engine.pool.query(
          'SELECT row_to_json(t)::text AS row FROM mr_payment_orders t WHERE id=$1',
          [paid.orderId],
        )
      ).rows;
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const settled = await staff.reviewEvidence(f.workspaceId, f.context);
      expect(settled.snapshot.exposureHash).not.toBe(granted.snapshot.exposureHash);
      expect(settled.financialRows.agedCostReliefs).toEqual(granted.financialRows.agedCostReliefs);
      expect(settled.financialRows.agedCostReliefSettlements).toEqual([
        expect.objectContaining({
          job_id: job.id,
          advance_micros: String(job.reservedMicros),
          gross_charge_micros: '100000',
          operator_funded_micros: '100000',
          recovered_micros: String(job.reservedMicros - 100_000),
        }),
      ]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT row_to_json(t)::text AS row FROM mr_payment_orders t WHERE id=$1',
            [paid.orderId],
          )
        ).rows,
      ).toEqual(originalOrder);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 5_000_000,
        reservedMicros: 0,
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('recovers the unused advance only from the new late-settlement release after relief was spent', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      await f.store.grant((await f.packet(job)).input, f.context);
      const later = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...f.request, input: { ...f.request.input, duration: 10 } },
      });
      expect(later.reservedMicros).toBe(agedReliefOpeningMicros);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: job.reservedMicros + later.reservedMicros,
      });
      const laterRecords = await f.originalJobRecords(later.id);
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: later.reservedMicros,
      });
      expect(await f.originalJobRecords(later.id)).toEqual(laterRecords);
      const offset = (
        await f.engine.pool.query(
          "SELECT amount_micros::text,available_delta_micros::text,reserved_delta_micros::text FROM mr_ledger WHERE workspace_id=$1 AND kind='relief-offset'",
          [f.workspaceId],
        )
      ).rows;
      expect(offset).toEqual([
        { amount_micros: '100000', available_delta_micros: '-100000', reserved_delta_micros: '0' },
      ]);
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('requires current staff authority and independent approval of the unchanged financial packet', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const { input } = await f.packet(job);
      const before = await walletAndLedger(f);
      await expect(f.store.review(f.target(job), {})).rejects.toThrow();
      await expect(f.store.grant(input, {})).rejects.toThrow();
      const readOnly = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        approveRelief: undefined,
      });
      await expect(readOnly.grant(input, f.context)).rejects.toThrow();
      const wrongProof = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        approveRelief: async () => ({
          approvalReference: 'fixture-wrong-packet',
          requestHash: 'b'.repeat(64),
        }),
      });
      await expect(wrongProof.grant(input, f.context)).rejects.toThrow();
      f.revoke();
      await expect(f.store.grant(input, f.context)).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('refuses a later operator credit as the original reservation funding despite a willing approval hook', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      await f.engine.creditWorkspace(
        f.workspaceId,
        job.reservedMicros,
        'fixture-later-operator-grant',
      );
      const later = (
        await f.engine.pool.query<{ id: string }>(
          "SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference='fixture-later-operator-grant'",
          [f.workspaceId],
        )
      ).rows[0]!;
      const approval = vi.fn<NonNullable<typeof f.storeOptions.approveRelief>>(
        async (_client, _context, request) => ({
          approvalReference: 'fixture-willing-independent-owner',
          requestHash: request.requestHash,
        }),
      );
      const store = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        approveRelief: approval,
      });
      const invalid = {
        ...f.target(job),
        allocation: [{ ledgerId: later.id, amountMicros: job.reservedMicros }],
      };
      const before = await walletAndLedger(f);
      await expect(store.review(invalid, f.context)).rejects.toMatchObject({
        code: 'aged_cost_relief_origin_invalid',
      });
      await expect(
        store.grant(
          {
            ...invalid,
            reference: 'fixture-later-funding-decision',
            note: 'A later source must not replace accepted original funding.',
            evidenceUrl: 'https://fixture.invalid/later-funding',
            snapshotHash: 'a'.repeat(64),
          },
          f.context,
        ),
      ).rejects.toMatchObject({ code: 'aged_cost_relief_origin_invalid' });
      expect(approval).not.toHaveBeenCalled();
      expect(await walletAndLedger(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('refuses a canonical paid credit changed into an opening entry before relief', async () => {
    const f = await agedCostReliefFixture({ paid: true });
    try {
      const job = await f.admit();
      const selected = await f.packet(job);
      await f.engine.pool.query("UPDATE mr_ledger SET kind='opening' WHERE id=$1", [
        f.originalCredit.id,
      ]);
      const before = await walletAndLedger(f);
      const store = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        approveRelief: async (_client, _context, request) => ({
          approvalReference: 'fixture-willing-owner',
          requestHash: request.requestHash,
        }),
      });
      await expect(store.review(f.target(job), f.context)).rejects.toMatchObject({
        code: 'aged_cost_relief_origin_invalid',
      });
      await expect(store.grant(selected.input, f.context)).rejects.toMatchObject({
        code: 'aged_cost_relief_origin_invalid',
      });
      expect(await walletAndLedger(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('keeps source, grant and settlement receipts immutable and rolls back an unbound offset', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const granted = await f.store.grant((await f.packet(job)).input, f.context);
      const beforeOffset = await walletAndLedger(f);
      await expect(
        attemptedTransaction(f, async (client) => {
          await client.query(
            'UPDATE mr_workspaces SET available_micros=available_micros-1 WHERE id=$1',
            [f.workspaceId],
          );
          await client.query(
            "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference) VALUES($1,$2,'relief-offset',1,-1,0,$3)",
            [randomUUID(), f.workspaceId, `aged-cost-relief:${job.id}:unbound-offset`],
          );
        }),
      ).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(beforeOffset);
      for (const statement of [
        'UPDATE mr_ledger SET amount_micros=amount_micros+1 WHERE id=$1',
        'DELETE FROM mr_ledger WHERE id=$1',
      ])
        await expect(f.engine.pool.query(statement, [f.originalCredit.id])).rejects.toThrow();
      for (const statement of [
        "UPDATE mr_aged_cost_reliefs SET note='changed after approval' WHERE job_id=$1",
        'DELETE FROM mr_aged_cost_reliefs WHERE job_id=$1',
      ])
        await expect(f.engine.pool.query(statement, [job.id])).rejects.toThrow();
      await expect(
        f.engine.pool.query('TRUNCATE mr_aged_cost_relief_settlements,mr_aged_cost_reliefs'),
      ).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(beforeOffset);
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const settled = await walletAndLedger(f);
      for (const statement of [
        "UPDATE mr_aged_cost_relief_settlements SET receipt='{}' WHERE job_id=$1",
        'DELETE FROM mr_aged_cost_relief_settlements WHERE job_id=$1',
      ])
        await expect(f.engine.pool.query(statement, [job.id])).rejects.toThrow();
      await expect(
        f.engine.pool.query('TRUNCATE mr_aged_cost_relief_settlements'),
      ).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(settled);
      expect(
        (await f.store.getReceipt({ workspaceId: f.workspaceId, jobId: job.id }, f.context)).grant,
      ).toEqual(granted);
    } finally {
      await f.close();
    }
  });

  it('reads the immutable relief receipt while supplier cost is pending and after reliable settlement', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const grant = await f.store.grant((await f.packet(job)).input, f.context);
      const selected = { workspaceId: f.workspaceId, jobId: job.id };
      expect(await f.store.getReceipt(selected, f.context)).toEqual({ grant, settlement: null });
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const beforeRead = await walletAndLedger(f);
      const receipt = await f.store.getReceipt(selected, f.context);
      expect(receipt.grant).toEqual(grant);
      expect(receipt.settlement).toMatchObject({
        jobId: job.id,
        workspaceId: f.workspaceId,
        advanceMicros: job.reservedMicros,
        grossChargeMicros: 100_000,
        recoveredMicros: job.reservedMicros - 100_000,
        operatorFundedMicros: 100_000,
        customerNetChargeMicros: 0,
      });
      expect(await f.store.getReceipt(selected, f.context)).toEqual(receipt);
      expect(await walletAndLedger(f)).toEqual(beforeRead);
      await expect(f.store.review(f.target(job), f.context)).rejects.toThrow();
      await expect(f.store.getReceipt(selected, {})).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('refuses a stale financial snapshot and cannot allocate another workspace or relief credit as original funding', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const { input } = await f.packet(job);
      const foreignWorkspace = `foreign-relief-${randomUUID()}`;
      await f.engine.ensureWorkspace(foreignWorkspace, agedReliefOpeningMicros);
      const foreignCredit = (
        await f.engine.pool.query<{ id: string }>(
          "SELECT id FROM mr_ledger WHERE workspace_id=$1 AND kind='opening'",
          [foreignWorkspace],
        )
      ).rows[0]!;
      await expect(
        f.store.review({ ...f.target(job), workspaceId: foreignWorkspace }, f.context),
      ).rejects.toThrow();
      await expect(
        f.store.review(
          {
            ...f.target(job),
            allocation: [{ ledgerId: foreignCredit.id, amountMicros: job.reservedMicros }],
          },
          f.context,
        ),
      ).rejects.toThrow();
      await f.engine.creditWorkspace(f.workspaceId, 1, 'fixture-financial-change');
      const before = await walletAndLedger(f);
      await expect(f.store.grant(input, f.context)).rejects.toThrow();
      expect(await walletAndLedger(f)).toEqual(before);
      const refreshed = await f.packet(job);
      const receipt = await f.store.grant(refreshed.input, f.context);
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const another = await f.admit();
      await expect(
        f.store.review(
          {
            ...f.target(another),
            allocation: [
              { ledgerId: receipt.creditLedgerId, amountMicros: another.reservedMicros },
            ],
          },
          f.context,
        ),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

  it('requires a durable attempt aged at least 24 hours rather than an old queued job', async () => {
    const f = await agedCostReliefFixture();
    try {
      const queued = await f.admit({ queued: true });
      await f.engine.pool.query(
        "UPDATE mr_jobs SET created_at=clock_timestamp()-interval '40 days' WHERE id=$1",
        [queued.id],
      );
      await expect(f.store.review(f.target(queued), f.context)).rejects.toThrow();
      await f.engine.cancel(f.workspaceId, queued.id);
      const recent = await f.admit({ hours: 23.99 });
      await expect(f.store.review(f.target(recent), f.context)).rejects.toThrow();
      await f.engine.pool.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-interval '24 hours' WHERE job_id=$1",
        [recent.id],
      );
      expect((await f.store.review(f.target(recent), f.context)).amountMicros).toBe(
        recent.reservedMicros,
      );
      await f.engine.applyProviderResult(f.workspaceId, recent.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      const byok = await f.admit({ byok: true });
      expect(byok.reservedMicros).toBe(0);
      await expect(f.store.review(f.target(byok), f.context)).rejects.toThrow();
      expect(await reliefCredits(f)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each([false, true])(
    'preserves unresolved cost after a real rejected fallback predecessor, with missing legacy slot %s',
    async (missingLegacySlot) => {
      const f = await agedCostReliefFixture({ fallback: true, rejectFirst: true });
      try {
        const job = await f.admit();
        expect(job).toMatchObject({ status: 'queued', attemptCount: 1, settledMicros: null });
        expect(job.reservedMicros).toBeGreaterThan(0);
        expect(await supplierCost(f, job.id)).toBeNull();
        const originalAttempt = (
          await f.engine.pool.query<{ state: string; route_id: string }>(
            'SELECT state,route_id FROM mr_attempts WHERE job_id=$1 ORDER BY number',
            [job.id],
          )
        ).rows;
        expect(originalAttempt).toEqual([{ state: 'rejected', route_id: expect.any(String) }]);
        expect(agedReliefFallbackRoutes).toContain(originalAttempt[0]!.route_id);
        expect(agedReliefFallbackRoutes).toContain(job.routeId);
        expect(job.routeId).not.toBe(originalAttempt[0]!.route_id);
        if (missingLegacySlot) {
          // An older journal may lack the capacity slot. The real persisted
          // predecessor attempt still establishes unresolved provider exposure.
          await f.engine.pool.query(
            'DELETE FROM mr_dispatch_slots WHERE job_id=$1 AND attempt_number=1',
            [job.id],
          );
        }
        const records = await f.originalJobRecords(job.id);
        const keyExposure = await f.keyExposure();
        const balance = await f.engine.getBalance(f.workspaceId);
        const reviewed = await f.packet(job);
        expect(reviewed.reviewed.amountMicros).toBe(job.reservedMicros);
        const receipt = await f.store.grant(reviewed.input, f.context);
        expect(receipt.amountMicros).toBe(job.reservedMicros);
        expect(await f.originalJobRecords(job.id)).toEqual(records);
        expect(await f.keyExposure()).toEqual(keyExposure);
        expect(await f.engine.getBalance(f.workspaceId)).toEqual({
          ...balance,
          availableMicros: balance.availableMicros + job.reservedMicros,
        });
        expect(await supplierCost(f, job.id)).toBeNull();
        expect(
          (
            await f.engine.pool.query(
              'SELECT kind FROM mr_ledger WHERE job_id=$1 ORDER BY created_at,id',
              [job.id],
            )
          ).rows,
        ).toEqual([{ kind: 'reserve' }]);
        expect(f.submit).toHaveBeenCalledOnce();
        expect(f.poll).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('keeps rejected predecessor cost in operator review after the accepted fallback cost settles', async () => {
    const f = await agedCostReliefFixture({ fallback: true, rejectFirst: true });
    try {
      const job = await f.admit();
      const predecessor = (
        await f.engine.pool.query<{
          id: string;
          number: number;
          route_id: string;
          deployment_id: string;
          state: string;
          credential_identity: string;
        }>(
          `SELECT a.id,a.number,a.route_id,a.deployment_id,a.state,c.identity AS credential_identity
          FROM mr_attempts a JOIN mr_attempt_credentials c
            ON c.job_id=a.job_id AND c.attempt_number=a.number
          WHERE a.job_id=$1 AND a.number=1`,
          [job.id],
        )
      ).rows[0]!;
      expect(predecessor.state).toBe('rejected');
      const original = await f.originalJobRecords(job.id);
      await f.store.grant((await f.packet(job)).input, f.context);
      expect(await f.originalJobRecords(job.id)).toEqual(original);
      expect(f.submit).toHaveBeenCalledOnce();

      // The existing executor explicitly continues its accepted fallback plan.
      // The relief grant itself has not dispatched another provider attempt.
      await f.engine.workOnce();
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        status: 'running',
        attemptCount: 2,
        settledMicros: null,
      });
      const current = (
        await f.engine.pool.query<{ id: string; route_id: string; deployment_id: string }>(
          'SELECT id,route_id,deployment_id FROM mr_attempts WHERE job_id=$1 AND number=2',
          [job.id],
        )
      ).rows[0]!;
      const result = {
        status: 'failed' as const,
        failureCategory: 'technical' as const,
        billedCostMicros: 100_000,
      };
      await f.engine.applyProviderResult(f.workspaceId, job.id, result);
      const selected = { workspaceId: f.workspaceId, jobId: job.id };
      const receipt = await f.store.getReceipt(selected, f.context);
      expect(receipt.settlement).toMatchObject({
        customerNetChargeMicros: 0,
        supplierCostScope: 'current-attempt',
        unverifiedPredecessorCount: 1,
        currentCostScope: {
          attemptId: current.id,
          attemptNumber: 2,
          routeId: current.route_id,
          deploymentId: current.deployment_id,
          upstreamReference: `fixture-aged-${job.id}`,
          providerCostMicros: 100_000,
          scope: 'current-attempt',
        },
        unverifiedPredecessors: [
          {
            attemptId: predecessor.id,
            attemptNumber: predecessor.number,
            routeId: predecessor.route_id,
            deploymentId: predecessor.deployment_id,
            state: 'rejected',
            credentialIdentity: predecessor.credential_identity,
            upstreamReference: null,
            supplierCostMicros: null,
          },
        ],
      });
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        status: 'failed',
        attemptCount: 2,
        settledMicros: 100_000,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: agedReliefOpeningMicros,
        reservedMicros: 0,
      });
      const operations = new BillingOperationsStore(f.engine.pool);
      const queue = () =>
        operations.queue(
          async (client) => {
            await f.storeOptions.authorize(client, f.context);
          },
          { workspaceId: f.workspaceId },
        );
      const review = await queue();
      expect(review).toContainEqual(
        expect.objectContaining({
          kind: 'provider-cost',
          id: job.id,
          workspaceId: f.workspaceId,
          reason: 'operator-funded-predecessor-cost-unverified',
        }),
      );
      const offset = (
        await f.engine.pool.query<{ details: Record<string, unknown> }>(
          "SELECT details FROM mr_ledger WHERE workspace_id=$1 AND kind='relief-offset'",
          [f.workspaceId],
        )
      ).rows;
      expect(offset).toEqual([
        {
          details: expect.objectContaining({
            supplierCostScope: 'current-attempt',
            unverifiedPredecessorCount: 1,
            customerNetChargeMicros: 0,
          }),
        },
      ]);
      const beforeReplay = await walletAndLedger(f);
      await f.engine.applyProviderResult(f.workspaceId, job.id, result);
      expect(await walletAndLedger(f)).toEqual(beforeReplay);
      expect(await f.store.getReceipt(selected, f.context)).toEqual(receipt);
      expect(await queue()).toEqual(review);
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(f.poll).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(['cancel', 'expiry'] as const)(
    'queued fallback closure through %s retains unresolved predecessor exposure',
    async (closure) => {
      const f = await agedCostReliefFixture({ fallback: true, rejectFirst: true });
      try {
        const job = await f.admit();
        expect(job).toMatchObject({ status: 'queued', attemptCount: 1, settledMicros: null });
        await f.store.grant((await f.packet(job)).input, f.context);
        const before = await f.originalJobRecords(job.id);
        const keyExposure = await f.keyExposure();
        const balance = await f.engine.getBalance(f.workspaceId);
        if (closure === 'cancel') await f.engine.cancel(f.workspaceId, job.id);
        else {
          // Advance the coherent persisted deadline without changing the
          // original request or fabricating another provider attempt.
          await f.engine.pool.query(
            "UPDATE mr_jobs SET queue_start_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [job.id],
          );
          await f.engine.pool.query(
            `UPDATE mr_dispatch_slots SET start_deadline_at=j.queue_start_deadline_at
            FROM mr_jobs j WHERE j.id=$1 AND mr_dispatch_slots.job_id=j.id AND attempt_number=2`,
            [job.id],
          );
          await f.engine.workOnce();
        }
        expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
          status: closure === 'cancel' ? 'cancelled' : 'failed',
          attemptCount: 1,
          reservedMicros: job.reservedMicros,
          settledMicros: null,
        });
        expect(await supplierCost(f, job.id)).toBeNull();
        expect(await f.engine.getBalance(f.workspaceId)).toEqual(balance);
        expect(await f.keyExposure()).toEqual(keyExposure);
        const after = await f.originalJobRecords(job.id);
        for (const table of [
          'mr_attempts',
          'mr_job_credentials',
          'mr_attempt_credentials',
          'mr_key_reservations',
        ])
          expect(after[table]).toEqual(before[table]);
        expect(
          (
            await f.engine.pool.query(
              'SELECT state,submission_intent_at,release_evidence FROM mr_dispatch_slots WHERE job_id=$1 AND attempt_number=2',
              [job.id],
            )
          ).rows,
        ).toEqual([
          {
            state: closure === 'cancel' ? 'released' : 'expired',
            submission_intent_at: null,
            release_evidence:
              closure === 'cancel' ? 'never_submitted_cancelled' : 'never_submitted_deadline',
          },
        ]);
        expect(
          (
            await f.engine.pool.query(
              'SELECT kind FROM mr_ledger WHERE job_id=$1 ORDER BY created_at,id',
              [job.id],
            )
          ).rows,
        ).toEqual([{ kind: 'reserve' }]);
        expect(
          (
            await f.engine.pool.query(
              "SELECT id FROM mr_ledger WHERE workspace_id=$1 AND kind='relief-offset'",
              [f.workspaceId],
            )
          ).rows,
        ).toEqual([]);
        const selected = { workspaceId: f.workspaceId, jobId: job.id };
        expect((await f.store.getReceipt(selected, f.context)).settlement).toBeNull();
        const operations = new BillingOperationsStore(f.engine.pool);
        const queue = () =>
          operations.queue(
            async (client) => {
              await f.storeOptions.authorize(client, f.context);
            },
            { workspaceId: f.workspaceId },
          );
        const review = await queue();
        expect(review).toContainEqual(
          expect.objectContaining({
            kind: 'provider-cost',
            id: job.id,
            workspaceId: f.workspaceId,
            reason: 'provider-cost-unverified',
            heldMicros: job.reservedMicros,
          }),
        );
        const beforeReplay = await walletAndLedger(f);
        const receipt = await f.store.getReceipt(selected, f.context);
        if (closure === 'cancel') await f.engine.cancel(f.workspaceId, job.id);
        else await f.engine.workOnce();
        expect(await walletAndLedger(f)).toEqual(beforeReplay);
        expect(await f.originalJobRecords(job.id)).toEqual(after);
        expect(await f.store.getReceipt(selected, f.context)).toEqual(receipt);
        expect(await queue()).toEqual(review);
        expect(f.submit).toHaveBeenCalledOnce();
        expect(f.poll).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('final fallback rejection retains unverified current supplier cost after relief', async () => {
    const f = await agedCostReliefFixture({ fallback: true, rejectFirst: true });
    try {
      const job = await f.admit();
      await f.store.grant((await f.packet(job)).input, f.context);
      const balance = await f.engine.getBalance(f.workspaceId);
      const keyExposure = await f.keyExposure();
      f.submit.mockRejectedValueOnce(
        new SubmissionRejected('Synthetic final-route rejection without verified supplier cost.'),
      );
      await f.engine.workOnce();
      expect(await supplierCost(f, job.id)).toBeNull();
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        status: 'failed',
        attemptCount: 2,
        reservedMicros: job.reservedMicros,
        settledMicros: null,
      });
      expect(
        (
          await f.engine.pool.query(
            "SELECT execution_error->>'code' AS code FROM mr_jobs WHERE id=$1",
            [job.id],
          )
        ).rows,
      ).toEqual([{ code: 'submission_rejected' }]);
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(balance);
      expect(await f.keyExposure()).toEqual(keyExposure);
      expect(
        (
          await f.engine.pool.query(
            'SELECT kind FROM mr_ledger WHERE job_id=$1 ORDER BY created_at,id',
            [job.id],
          )
        ).rows,
      ).toEqual([{ kind: 'reserve' }]);
      expect(
        (
          await f.engine.pool.query(
            "SELECT id FROM mr_ledger WHERE workspace_id=$1 AND kind='relief-offset'",
            [f.workspaceId],
          )
        ).rows,
      ).toEqual([]);
      const selected = { workspaceId: f.workspaceId, jobId: job.id };
      expect((await f.store.getReceipt(selected, f.context)).settlement).toBeNull();
      const operations = new BillingOperationsStore(f.engine.pool);
      expect(
        await operations.queue(
          async (client) => {
            await f.storeOptions.authorize(client, f.context);
          },
          { workspaceId: f.workspaceId },
        ),
      ).toContainEqual(
        expect.objectContaining({
          kind: 'provider-cost',
          id: job.id,
          reason: 'provider-cost-unverified',
          heldMicros: job.reservedMicros,
        }),
      );
      const beforeIdleTurn = await walletAndLedger(f);
      await f.engine.workOnce();
      expect(await walletAndLedger(f)).toEqual(beforeIdleTurn);
      expect(await f.keyExposure()).toEqual(keyExposure);
      expect(f.submit).toHaveBeenCalledTimes(2);
      expect(f.poll).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('keeps ambiguous acceptance recoverable and cannot use relief to reject or resubmit it', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit({ unknown: true });
      const { input } = await f.packet(job);
      const before = await f.originalJobRecords(job.id);
      await f.store.grant(input, f.context);
      expect(await f.originalJobRecords(job.id)).toEqual(before);
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        status: 'submission-unknown',
        settledMicros: null,
      });
      expect(await supplierCost(f, job.id)).toBeNull();
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.poll).not.toHaveBeenCalled();
      expect(await f.keyExposure()).toMatchObject([
        { gross_debit_micros: '0', held_micros: String(job.reservedMicros) },
      ]);
    } finally {
      await f.close();
    }
  });

  it('keeps historical admission-month exposure when relief and reliable cost arrive in a later month', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const current = (await f.keyExposure())[0]!.admission_month as string;
      const previous = (
        await f.engine.pool.query<{ month: string }>(
          "SELECT to_char(date_trunc('month',clock_timestamp())-interval '1 month','YYYY-MM-DD') AS month",
        )
      ).rows[0]!.month;
      // Seed an already-admitted historical cohort while keeping its accounting
      // consistent. Runtime relief and settlement still use their normal paths.
      await f.engine.pool.query(
        'INSERT INTO mr_key_months(workspace_id,key_id,admission_month,held_micros) VALUES($1,$2,$3,$4)',
        [f.workspaceId, f.key.id, previous, job.reservedMicros],
      );
      await f.engine.pool.query(
        'UPDATE mr_key_reservations SET admission_month=$2,admitted_at=$2::date WHERE job_id=$1',
        [job.id, previous],
      );
      await f.engine.pool.query(
        'UPDATE mr_key_months SET held_micros=0 WHERE workspace_id=$1 AND key_id=$2 AND admission_month=$3',
        [f.workspaceId, f.key.id, current],
      );
      const before = await f.keyExposure();
      await f.store.grant((await f.packet(job)).input, f.context);
      expect(await f.keyExposure()).toEqual(before);
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      expect(await f.keyExposure()).toEqual([
        { admission_month: previous, gross_debit_micros: '100000', held_micros: '0' },
        { admission_month: current, gross_debit_micros: '0', held_micros: '0' },
      ]);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: agedReliefOpeningMicros,
        reservedMicros: 0,
      });
    } finally {
      await f.close();
    }
  });

  it.each([0, 100_000, 200_000, 300_000])(
    'absorbs late cost %i once without a second customer benefit or taking another reservation',
    async (cost) => {
      const f = await agedCostReliefFixture();
      try {
        const job = await f.admit();
        const other = await f.admit({ queued: true });
        const { input } = await f.packet(job);
        await f.store.grant(input, f.context);
        const result = {
          status: 'failed' as const,
          failureCategory: 'technical' as const,
          billedCostMicros: cost,
        };
        await f.engine.applyProviderResult(f.workspaceId, job.id, result);
        const beforeReplay = await walletAndLedger(f);
        await f.engine.applyProviderResult(f.workspaceId, job.id, result);
        expect(await walletAndLedger(f)).toEqual(beforeReplay);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: agedReliefOpeningMicros - other.reservedMicros,
          reservedMicros: other.reservedMicros,
        });
        expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
          settledMicros: Math.min(cost, job.reservedMicros),
        });
        expect(await supplierCost(f, job.id)).toBe(cost);
        expect(await f.engine.getJob(f.workspaceId, other.id)).toMatchObject({
          status: 'queued',
          settledMicros: null,
          reservedMicros: other.reservedMicros,
        });
        expect(await f.keyExposure()).toEqual([
          expect.objectContaining({
            gross_debit_micros: String(Math.min(cost, job.reservedMicros)),
            held_micros: String(other.reservedMicros),
          }),
        ]);
        const entries = (await f.engine.ledger(f.workspaceId)).filter(
          (row) => row.job_id === job.id,
        );
        expect(entries.filter((row) => row.kind === 'settle')).toHaveLength(1);
        expect(entries.filter((row) => row.kind === 'release')).toHaveLength(1);
        expect(await reliefCredits(f)).toHaveLength(1);
        expect(f.submit).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );

  it('retains verified-cost requirements for fee jobs after relief and later records the original audited cost', async () => {
    const f = await agedCostReliefFixture({ fee: true });
    try {
      const job = await f.admit();
      const { input } = await f.packet(job);
      await f.store.grant(input, f.context);
      const exposure = await f.keyExposure();
      await f.engine.applyProviderResult(f.workspaceId, job.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 100_000,
      });
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
        settledMicros: null,
        billing: { costStatus: 'pending' },
      });
      expect(await supplierCost(f, job.id)).toBeNull();
      expect(await f.keyExposure()).toEqual(exposure);
      const evidence = {
        action: 'settle' as const,
        billedCostMicros: 100_000,
        costBasis: 'operator-audited' as const,
        reference: 'fixture-original-late-fee-cost',
        note: 'Synthetic final supplier receipt on the original accepted attempt.',
        evidenceUrl: 'https://fixture.invalid/late-cost',
      };
      await f.engine.reconcile(f.workspaceId, job.id, evidence, { operatorId: 'fixture-owner' });
      const beforeReplay = await walletAndLedger(f);
      await f.engine.reconcile(f.workspaceId, job.id, evidence, { operatorId: 'fixture-owner' });
      expect(await walletAndLedger(f)).toEqual(beforeReplay);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: agedReliefOpeningMicros,
        reservedMicros: 0,
      });
      expect(await supplierCost(f, job.id)).toBe(100_000);
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });
});

describe.skipIf(!native)('native concurrent aged-cost decisions', () => {
  it('uses posting order when an older transaction credits funds after the original reservation commits', async () => {
    const f = await agedCostReliefFixture();
    try {
      const older = await f.engine.pool.connect();
      let job: Awaited<ReturnType<typeof f.admit>>;
      try {
        await older.query('BEGIN');
        await older.query('SELECT now() AS transaction_started_at');
        job = await f.admit();
        await creditWorkspaceInTransaction(
          older,
          f.workspaceId,
          job.reservedMicros,
          'fixture-old-transaction-late-funding',
        );
        await older.query('COMMIT');
      } catch (error) {
        await older.query('ROLLBACK');
        throw error;
      } finally {
        older.release();
      }
      const late = (
        await f.engine.pool.query<{
          id: string;
          timestamp_precedes_reservation: boolean;
          posting_follows_reservation: boolean;
        }>(
          `SELECT source.id,source.created_at<reserve.created_at AS timestamp_precedes_reservation,
            source.posting_order>reserve.posting_order AS posting_follows_reservation
          FROM mr_ledger source JOIN mr_ledger reserve ON reserve.workspace_id=source.workspace_id
          WHERE source.workspace_id=$1 AND source.reference='fixture-old-transaction-late-funding'
            AND reserve.job_id=$2 AND reserve.kind='reserve'`,
          [f.workspaceId, job!.id],
        )
      ).rows[0]!;
      expect(late).toEqual({
        id: expect.any(String),
        timestamp_precedes_reservation: true,
        posting_follows_reservation: true,
      });
      const approval = vi.fn<NonNullable<typeof f.storeOptions.approveRelief>>(
        async (_client, _context, request) => ({
          approvalReference: 'fixture-independent-owner',
          requestHash: request.requestHash,
        }),
      );
      const store = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        approveRelief: approval,
      });
      const invalid = {
        ...f.target(job!),
        allocation: [{ ledgerId: late.id, amountMicros: job!.reservedMicros }],
      };
      const before = await walletAndLedger(f);
      await expect(store.review(invalid, f.context)).rejects.toMatchObject({
        code: 'aged_cost_relief_origin_invalid',
      });
      await expect(
        store.grant(
          {
            ...invalid,
            reference: 'fixture-older-clock-late-funding',
            note: 'An earlier transaction clock cannot establish original funding.',
            evidenceUrl: 'https://fixture.invalid/posting-order',
            snapshotHash: 'a'.repeat(64),
          },
          f.context,
        ),
      ).rejects.toMatchObject({ code: 'aged_cost_relief_origin_invalid' });
      expect(approval).not.toHaveBeenCalled();
      expect(await walletAndLedger(f)).toEqual(before);
      const selected = await f.packet(job!);
      const granted = await f.store.grant(selected.input, f.context);
      expect(granted.allocation).toEqual([
        expect.objectContaining({
          sourceLedgerId: f.originalCredit.id,
          chronologyBasis: 'recorded-posting-order',
          sourcePostingOrder: expect.any(String),
          reservationPostingOrder: expect.any(String),
        }),
      ]);
      expect(BigInt(granted.allocation[0]!.sourcePostingOrder!)).toBeLessThan(
        BigInt(granted.allocation[0]!.reservationPostingOrder!),
      );
    } finally {
      await f.close();
    }
  });

  it('commits one bounded relief across distinct staff sessions racing on the same job', async () => {
    const f = await agedCostReliefFixture();
    try {
      const job = await f.admit();
      const { input } = await f.packet(job);
      const second = await f.packet(job);
      f.authoritySessions.clear();
      const results = await Promise.allSettled([
        f.store.grant(input, f.context),
        f.store.grant(second.input, f.context),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(f.authoritySessions.size).toBeGreaterThanOrEqual(2);
      expect(await reliefCredits(f)).toHaveLength(1);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: agedReliefOpeningMicros,
        reservedMicros: job.reservedMicros,
      });
    } finally {
      await f.close();
    }
  });

  it.each(['relief-first', 'cost-first'] as const)(
    'serializes %s across independently blocked native sessions',
    async (order) => {
      const f = await agedCostReliefFixture();
      try {
        const job = await f.admit();
        const { input } = await f.packet(job);
        const cost = 100_000;
        const blocker = await f.engine.pool.connect();
        const settle = () =>
          f.engine.applyProviderResult(f.workspaceId, job.id, {
            status: 'failed',
            failureCategory: 'technical',
            billedCostMicros: cost,
          });
        const grant = () => f.store.grant(input, f.context);
        const observed = <T>(promise: Promise<T>) =>
          promise.then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          );
        let grantResult: ReturnType<typeof observed<Awaited<ReturnType<typeof grant>>>>;
        let costResult: ReturnType<typeof observed<Awaited<ReturnType<typeof settle>>>>;
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
            f.workspaceId,
          ]);
          const blockerId = (await blocker.query<{ id: number }>('SELECT pg_backend_pid() AS id'))
            .rows[0]!.id;
          if (order === 'relief-first') grantResult = observed(grant());
          else costResult = observed(settle());
          await waitForBlockedSessions(blocker, blockerId, 1);
          if (order === 'relief-first') costResult = observed(settle());
          else grantResult = observed(grant());
          await waitForBlockedSessions(blocker, blockerId, 2);
          await blocker.query('COMMIT');
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        const results = await Promise.all([grantResult!, costResult!]);
        expect(results[1]!.status).toBe('fulfilled');
        const granted = results[0]!.status === 'fulfilled';
        expect(granted).toBe(order === 'relief-first');
        expect(await reliefCredits(f)).toHaveLength(granted ? 1 : 0);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: agedReliefOpeningMicros - (granted ? 0 : cost),
          reservedMicros: 0,
        });
        expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
          settledMicros: cost,
        });
        expect(await supplierCost(f, job.id)).toBe(cost);
        expect(f.submit).toHaveBeenCalledOnce();
      } finally {
        await f.close();
      }
    },
  );
});
