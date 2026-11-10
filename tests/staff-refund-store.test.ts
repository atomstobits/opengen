import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  StaffRefundStore,
  StaffRefundError,
  staffRefundHash,
  type StaffRefundAction,
  type StaffRefundAllocationRequest,
  type StaffRefundCase,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../packages/engine/src/staff-refunds.js';
import {
  normalizeStaffRefundEvidence,
  type VerifiedProcessorEvent,
  type VerifiedStaffRefundEvidence,
} from '../packages/engine/src/staff-refund-evidence.js';
import { BillingOperationsStore } from '../packages/engine/src/billing-operations.js';
import { staffRefundFixture, staffRefundInput } from './staff-refund-fixture.js';

type Fixture = Awaited<ReturnType<typeof staffRefundFixture>>;
type Funding = Awaited<ReturnType<Fixture['fund']>>;
type Phase = StaffRefundAllocationRequest['operation'];
type Returns = StaffRefundWorksheet['externalReturns'];
const configured = Boolean(process.env.TEST_DATABASE_URL);

/** Synthetic staff attestation, independent of the store's cap/state reducers.
 * It binds the actual original payment and one reviewed portion R + worksheet.
 * It intentionally does not duplicate principal accounting: even an approved
 * incomplete historical-return packet must be refused by the store itself. */
function manualStaff(f: Fixture, paid: Funding) {
  const context = Object.freeze({ session: Symbol('synthetic-staff-review') });
  const packets = new Set<string>();
  const authorize: StaffRefundStoreOptions['authorize'] = async (_client, supplied) => {
    if (supplied !== context) throw new Error('Synthetic staff session was not revalidated.');
    return { kind: 'installation-operator', id: 'fixture-staff-reviewer' };
  };
  const approveAllocation: NonNullable<StaffRefundStoreOptions['approveAllocation']> = async (
    client,
    supplied,
    request,
  ) => {
    expect(supplied).toBe(context);
    const original = (
      await client.query(
        'SELECT workspace_id,payment_intent_id,amount_cents,credited_at FROM mr_payment_orders WHERE id=$1',
        [paid.order.id],
      )
    ).rows[0];
    expect(original.credited_at).not.toBeNull();
    expect(request).toMatchObject({
      workspaceId: f.workspaceId,
      orderId: paid.order.id,
      paymentIntentId: paid.paymentIntentId,
      processorEnvironmentId: f.processorEnvironment.id,
      processorAccountId: f.processorEnvironment.accountId,
      livemode: false,
      creditReference: `stripe-topup:${paid.order.id}`,
      originalAmountCents: paid.amountCents,
      requestVersion: 'staff-refund-original-v1',
      conversionVersion: 'usd-ceil-cent-v1',
    });
    expect(original.workspace_id).toBe(request.workspaceId);
    expect(original.payment_intent_id).toBe(request.paymentIntentId);
    expect(original.amount_cents).toBe(request.originalAmountCents);
    expect(
      packets.has(`${request.operation}/${request.eligibleMicros}/${request.worksheetHash}`),
    ).toBe(true);
    expect(request.worksheetHash).toBe(staffRefundHash(request.worksheet));
    const { requestHash, ...body } = request;
    expect(requestHash).toBe(staffRefundHash(body));
    expect(request.caseRequestHash).toMatch(/^[a-f0-9]{64}$/);
    const existing = (
      await client.query(
        'SELECT request_hash FROM mr_staff_refund_cases WHERE workspace_id=$1 AND reference=$2',
        [f.workspaceId, request.caseReference],
      )
    ).rows[0];
    if (existing) expect(existing.request_hash).toBe(request.caseRequestHash);
    return { approvalReference: 'fixture-reviewed-paid-allocation', requestHash };
  };
  const options: StaffRefundStoreOptions = {
    activation: 'fixture',
    processorEnvironment: f.processorEnvironment,
    authorize,
    approveAllocation,
  };
  const store = new StaffRefundStore(f.engine.pool, options);
  async function packet(operation: Phase, eligibleMicros: number, externalReturns: Returns = []) {
    const worksheet: StaffRefundWorksheet = {
      snapshot: await store.snapshot(f.workspaceId, context),
      externalReturns,
      allocationReference: 'fixture-original-paid-portion',
      originalPayerReference: 'fixture-verified-original-payer',
      note: 'Synthetic staff-reviewed requested paid portion; no automatic paid-lot claim.',
      allocation: [
        {
          fundingReference: `stripe-topup:${paid.order.id}`,
          disposition: 'eligible-paid',
          amountMicros: eligibleMicros,
        },
      ],
    };
    const worksheetHash = staffRefundHash(worksheet);
    packets.add(`${operation}/${eligibleMicros}/${worksheetHash}`);
    return { worksheet, worksheetHash };
  }
  const action = (reference = randomUUID()): StaffRefundAction => ({
    reference,
    note: 'Synthetic fixture reconciliation only.',
    evidenceReference: 'fixture-processor-record',
  });
  async function prepare(
    eligibleMicros: number,
    externalReturns: Returns = [],
    existingRefundEvidence?: VerifiedStaffRefundEvidence,
  ) {
    return store.prepare(
      {
        workspaceId: f.workspaceId,
        orderId: paid.order.id,
        reference: randomUUID(),
        origin: existingRefundEvidence ? 'reconcile-existing' : 'new',
        eligibleMicros,
        ...(await packet('prepare', eligibleMicros, externalReturns)),
        ...(existingRefundEvidence ? { existingRefundEvidence } : {}),
      },
      context,
    );
  }
  async function dispatch(c: StaffRefundCase, externalReturns: Returns = []) {
    const input = { ...action(), ...(await packet('dispatch', c.eligibleMicros, externalReturns)) };
    return { input, value: await store.dispatch(c.id, input, context) };
  }
  async function apply(c: StaffRefundCase, externalReturns: Returns = []) {
    return store.reconcile(
      c.id,
      {
        ...action(),
        action: 'apply-success',
        ...(await packet('apply-success', c.eligibleMicros, externalReturns)),
      },
      context,
    );
  }
  return { store, options, context, packet, action, prepare, dispatch, apply };
}

/** Already-verified ingress fixture: no real signature, payload, key or network.
 * Keep the returned original sealed object; never clone it into a money claim. */
function observation(
  f: Fixture,
  paid: Funding,
  options: {
    refundId?: string;
    eventId?: string;
    type?: string;
    amountCents: number;
    status: 'pending' | 'succeeded' | 'failed';
    created?: number;
    failure?: string;
  },
): VerifiedStaffRefundEvidence {
  const event: VerifiedProcessorEvent = {
    id: options.eventId ?? `evt_fixture_${randomUUID().replaceAll('-', '')}`,
    type: options.type ?? 'refund.updated',
    created: options.created ?? 1800000000,
    livemode: false,
    processorEnvironment: f.processorEnvironment,
    data: {
      object: {
        object: 'refund',
        id: options.refundId ?? `re_fixture_${randomUUID().replaceAll('-', '')}`,
        payment_intent: paid.paymentIntentId,
        charge: `ch_fixture_${paid.order.id.replaceAll('-', '')}`,
        amount: options.amountCents,
        currency: 'usd',
        status: options.status,
        ...(options.failure ? { failure_balance_transaction: options.failure } : {}),
      },
    },
  };
  const normalized = normalizeStaffRefundEvidence(event, f.processorEnvironment, {
    workspaceId: f.workspaceId,
    orderId: paid.order.id,
    processorEnvironmentId: f.processorEnvironment.id,
    processorAccountId: f.processorEnvironment.accountId,
    livemode: false,
    paymentIntentId: paid.paymentIntentId,
    chargeId: null,
    amountCents: paid.amountCents,
    currency: 'USD',
  });
  expect(normalized.kind).toBe('refund');
  if (normalized.kind !== 'refund') throw new Error('Synthetic verifier fixture was invalid.');
  return normalized.evidence;
}
async function wallet(f: Fixture) {
  return (
    await f.engine.pool.query(
      'SELECT available_micros::text,reserved_micros::text FROM mr_workspaces WHERE id=$1',
      [f.workspaceId],
    )
  ).rows[0];
}
/** Coherent accepted-work exposure without any provider workflow or I/O. The
 * synthetic queued job, reserve ledger and wallet movement are one transaction. */
async function reserveSyntheticWork(f: Fixture, amountMicros: number) {
  const jobId = randomUUID();
  const client = await f.engine.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId]);
    await client.query(
      `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros)
       VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8)`,
      [
        jobId,
        f.workspaceId,
        `fixture-reservation-${jobId}`,
        staffRefundHash(staffRefundInput),
        JSON.stringify(staffRefundInput),
        JSON.stringify({ id: staffRefundInput.routeId }),
        JSON.stringify({ id: 'fixture-private-reservation-only' }),
        amountMicros,
      ],
    );
    const updated = await client.query(
      `UPDATE mr_workspaces SET available_micros=available_micros-$2,reserved_micros=reserved_micros+$2
       WHERE id=$1 AND available_micros >= $2`,
      [f.workspaceId, amountMicros],
    );
    expect(updated.rowCount).toBe(1);
    await client.query(
      `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
       VALUES($1,$2,$3,'reserve',$4::bigint,-$4::bigint,$4::bigint)`,
      [randomUUID(), f.workspaceId, jobId, amountMicros],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return jobId;
}
async function allRefundRows(f: Fixture) {
  const snapshot: Record<string, unknown> = {};
  for (const name of [
    'mr_staff_refund_cases',
    'mr_staff_refund_observations',
    'mr_staff_refund_audit',
    'mr_staff_refund_financial_entries',
    'mr_staff_refund_expenses',
    'mr_billing_holds',
    'mr_billing_hold_resolutions',
    'mr_ledger',
  ]) {
    snapshot[name] = (
      await f.engine.pool.query(
        `SELECT row_to_json(t)::text AS row FROM ${name} t ORDER BY row_to_json(t)::text`,
      )
    ).rows;
  }
  return { wallet: await wallet(f), rows: snapshot };
}
async function succeed(
  f: Fixture,
  staff: ReturnType<typeof manualStaff>,
  paid: Funding,
  eligibleMicros: number,
) {
  const c = await staff.prepare(eligibleMicros);
  await staff.dispatch(c);
  const evidence = observation(f, paid, { amountCents: c.cashCents, status: 'succeeded' });
  await staff.store.observeVerifiedProcessorEvidence(c.id, evidence, staff.action(), staff.context);
  return { value: await staff.apply(c), evidence };
}

describe.skipIf(!configured)('staff refund store adversarial in-memory accounting fixtures', () => {
  it('keeps review reads available but refuses every mutation without trusted allocation approval', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      const c = await staff.prepare(10000),
        noApproval = new StaffRefundStore(f.engine.pool, {
          ...staff.options,
          approveAllocation: undefined,
        });
      const evidence = observation(f, paid, { amountCents: 1, status: 'succeeded' });
      const packet = await staff.packet('prepare', 10000);
      const before = await allRefundRows(f);
      expect(await noApproval.reviewEvidence(f.workspaceId, staff.context)).toHaveProperty(
        'snapshot',
      );
      for (const attempt of [
        () =>
          noApproval.prepare(
            {
              workspaceId: f.workspaceId,
              orderId: paid.order.id,
              reference: randomUUID(),
              origin: 'new',
              eligibleMicros: 10000,
              ...packet,
            },
            staff.context,
          ),
        () => noApproval.dispatch(c.id, staff.action(), staff.context),
        () =>
          noApproval.observeVerifiedProcessorEvidence(
            c.id,
            evidence,
            staff.action(),
            staff.context,
          ),
        () =>
          noApproval.reconcile(
            c.id,
            { ...staff.action(), action: 'release-failed' },
            staff.context,
          ),
      ])
        await expect(attempt()).rejects.toMatchObject({
          code: 'staff_refund_allocation_unapproved',
          statusCode: 403,
        });
      expect(await allRefundRows(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('keeps one unknown dispatch claim and one refund identity across three event types without automatic release', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid),
        c = await staff.prepare(1000000);
      const first = await staff.dispatch(c);
      expect(first.value).toMatchObject({
        dispatchClaimed: true,
        state: 'unknown',
        financialState: 'none',
      });
      expect(await staff.store.dispatch(c.id, first.input, staff.context)).toMatchObject({
        dispatchClaimed: false,
        dispatchKey: first.value.dispatchKey,
      });
      await expect(staff.store.dispatch(c.id, staff.action(), staff.context)).rejects.toMatchObject(
        { code: 'staff_refund_not_dispatchable' },
      );
      const refundId = 're_fixture_one_return';
      const events = [
        observation(f, paid, {
          refundId,
          eventId: 'evt_fixture_created',
          type: 'refund.created',
          amountCents: 100,
          status: 'pending',
          created: 1800000000,
        }),
        observation(f, paid, {
          refundId,
          eventId: 'evt_fixture_updated',
          type: 'refund.updated',
          amountCents: 100,
          status: 'pending',
          created: 1800000001,
        }),
        observation(f, paid, {
          refundId,
          eventId: 'evt_fixture_failed',
          type: 'refund.failed',
          amountCents: 100,
          status: 'failed',
          created: 1800000002,
        }),
      ];
      for (const event of events)
        await staff.store.observeVerifiedProcessorEvidence(
          c.id,
          event,
          staff.action(event.eventId),
          staff.context,
        );
      const beforeReplay = await allRefundRows(f);
      await staff.store.observeVerifiedProcessorEvidence(
        c.id,
        events[2]!,
        staff.action(events[2]!.eventId),
        staff.context,
      );
      expect(await allRefundRows(f)).toEqual(beforeReplay);
      expect(
        (
          await f.engine.pool.query(
            'SELECT refund_id,state,financial_state,dispatched_at FROM mr_staff_refund_cases',
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          refund_id: refundId,
          state: 'failed',
          financial_state: 'none',
          dispatched_at: expect.any(Date),
        }),
      ]);
      expect(
        (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_staff_refund_observations'))
          .rows[0].n,
      ).toBe(3);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_staff_refund_audit WHERE action='dispatch'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries',
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_billing_holds WHERE resolved_at IS NULL',
          )
        ).rows[0].n,
      ).toBe(1);
      await expect(
        staff.store.reconcile(
          c.id,
          {
            ...staff.action(),
            action: 'release-failed',
            ...(await staff.packet('release-failed', c.eligibleMicros)),
          },
          staff.context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      expect(await wallet(f)).toEqual({ available_micros: '5000000', reserved_micros: '0' });
      expect(f.creates).toHaveBeenCalledTimes(1);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('permits one microUSD→one cent and protects new cases, evidence, receipts, expenses and refund ledger from mutation', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid),
        c = await staff.prepare(1);
      expect(c).toMatchObject({ eligibleMicros: 1, cashCents: 1, roundingExpenseMicros: 9999 });
      const holdId = c.holdIds[0]!;
      const operations = new BillingOperationsStore(f.engine.pool);
      await expect(
        operations.resolveHold(
          f.workspaceId,
          holdId,
          {
            reference: 'fixture-early-clear',
            note: 'Synthetic authorized operator still cannot bypass active staff money.',
            evidenceUrl: 'https://evidence.example.invalid/fixture',
          },
          { kind: 'installation-operator' },
          async () => {},
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      const beforeDowngrade = await allRefundRows(f);
      await expect(
        f.engine.pool.query(
          "UPDATE mr_billing_holds SET source_kind='stripe',stripe_event_id=(SELECT id FROM mr_payment_events LIMIT 1),staff_refund_case_id=NULL WHERE event_id=$1",
          [holdId],
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        f.engine.pool.query('DELETE FROM mr_billing_holds WHERE event_id=$1', [holdId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      expect(await allRefundRows(f)).toEqual(beforeDowngrade);
      await staff.dispatch(c);
      const evidence = observation(f, paid, { amountCents: 1, status: 'succeeded' });
      await staff.store.observeVerifiedProcessorEvidence(
        c.id,
        evidence,
        staff.action(),
        staff.context,
      );
      await expect(
        operations.resolveHold(
          f.workspaceId,
          holdId,
          {
            reference: 'fixture-proof-without-debit',
            note: 'Success observation alone is not a wallet correction.',
            evidenceUrl: 'https://evidence.example.invalid/fixture',
          },
          { kind: 'installation-operator' },
          async () => {},
        ),
      ).rejects.toMatchObject({ code: 'P0001' });
      await staff.apply(c);
      expect(await wallet(f)).toEqual({ available_micros: '4999999', reserved_micros: '0' });
      const entry = (
        await f.engine.pool.query(
          'SELECT * FROM mr_staff_refund_financial_entries WHERE case_id=$1',
          [c.id],
        )
      ).rows[0];
      expect(entry).toMatchObject({
        action: 'debit',
        amount_micros: '1',
        cash_cents: 1,
        rounding_expense_micros: 9999,
        before_available_micros: '5000000',
        after_available_micros: '4999999',
        before_reserved_micros: '0',
        after_reserved_micros: '0',
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT amount_micros FROM mr_staff_refund_expenses WHERE case_id=$1',
            [c.id],
          )
        ).rows[0].amount_micros,
      ).toBe(9999);
      const before = await allRefundRows(f);
      const statements = [
        'UPDATE mr_staff_refund_cases SET eligible_micros=2 WHERE id=$1',
        "UPDATE mr_staff_refund_cases SET dispatch_key='changed' WHERE id=$1",
        'DELETE FROM mr_staff_refund_cases WHERE id=$1',
        'UPDATE mr_staff_refund_observations SET evidence=evidence||\'{"amountCents":999}\'::jsonb WHERE case_id=$1',
        'DELETE FROM mr_staff_refund_observations WHERE case_id=$1',
        "UPDATE mr_staff_refund_audit SET actor='{}'::jsonb WHERE case_id=$1",
        'DELETE FROM mr_staff_refund_audit WHERE case_id=$1',
        'UPDATE mr_staff_refund_financial_entries SET amount_micros=2 WHERE case_id=$1',
        'DELETE FROM mr_staff_refund_financial_entries WHERE case_id=$1',
        'UPDATE mr_staff_refund_expenses SET amount_micros=0 WHERE case_id=$1',
        'DELETE FROM mr_staff_refund_expenses WHERE case_id=$1',
        "UPDATE mr_ledger SET details='{}'::jsonb WHERE reference='staff-refund:'||$1::text||':debit'",
        "DELETE FROM mr_ledger WHERE reference='staff-refund:'||$1::text||':debit'",
      ];
      for (const sql of statements)
        await expect(f.engine.pool.query(sql, [c.id])).rejects.toMatchObject({ code: 'P0001' });
      expect(await allRefundRows(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('caps summed original cash after multiple partials even when a positive microUSD remains', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      await succeed(f, staff, paid, 2500000);
      await succeed(f, staff, paid, 2499999);
      expect(await wallet(f)).toEqual({ available_micros: '1', reserved_micros: '0' });
      const totals = (
        await f.engine.pool.query(
          'SELECT sum(cash_cents)::int AS cash,sum(eligible_micros)::text AS micros FROM mr_staff_refund_cases',
        )
      ).rows[0];
      expect(totals).toEqual({ cash: 500, micros: '4999999' });
      const before = await allRefundRows(f);
      await expect(staff.prepare(1)).rejects.toMatchObject({
        code: 'staff_refund_principal_exceeded',
      });
      expect(await allRefundRows(f)).toEqual(before);
      expect(
        (
          await f.engine.pool.query(
            'SELECT sum(amount_micros)::int AS n FROM mr_staff_refund_expenses',
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('cannot omit a previously audited external return from a later approved worksheet', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(1000),
        staff = manualStaff(f, paid);
      const external: Returns = [
        {
          refundId: 're_fixture_historical',
          amountCents: 500,
          status: 'succeeded',
          evidenceReference: 'fixture-historical-cash-record',
        },
      ];
      await staff.prepare(1000000, external);
      const before = await allRefundRows(f);
      await expect(staff.prepare(8000000, [])).rejects.toMatchObject({
        code: 'staff_refund_review',
      });
      await expect(staff.prepare(8000000, external)).rejects.toMatchObject({
        code: 'staff_refund_principal_exceeded',
      });
      expect(await allRefundRows(f)).toEqual(before);
    } finally {
      await f.close();
    }
  });

  it('counts a historical item and its registered existing refund once, never permits redispatch or a second case', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(1000),
        staff = manualStaff(f, paid);
      const refundId = 're_fixture_existing';
      const external: Returns = [
        {
          refundId,
          amountCents: 400,
          status: 'succeeded',
          evidenceReference: 'fixture-existing-original-refund',
        },
      ];
      await staff.prepare(1000000, external);
      const evidence = observation(f, paid, { refundId, amountCents: 400, status: 'succeeded' });
      const existing = await staff.prepare(4000000, external, evidence);
      expect(existing.origin).toBe('reconcile-existing');
      await expect(staff.dispatch(existing, external)).rejects.toMatchObject({
        code: 'staff_refund_not_dispatchable',
      });
      await staff.apply(existing, external);
      expect(await wallet(f)).toEqual({ available_micros: '6000000', reserved_micros: '0' });
      // The registered400c already includes the old external item; A100+C500
      // reaches the original1000c exactly, rather than falsely counting1400c.
      const final = await staff.prepare(5000000, external);
      expect(final).toMatchObject({ cashCents: 500, state: 'prepared', reviewRequired: false });
      const beforeDuplicate = await allRefundRows(f);
      await expect(staff.prepare(4000000, external, evidence)).rejects.toMatchObject({
        code: 'staff_refund_conflict',
      });
      expect(await allRefundRows(f)).toEqual(beforeDuplicate);
      expect(
        (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_staff_refund_cases')).rows[0]
          .n,
      ).toBe(3);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries',
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_staff_refund_audit WHERE action='dispatch'",
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('keeps new principal review on an already-debited case, including exact old audit replay and new success decisions', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      const a = await staff.prepare(2000000);
      await staff.dispatch(a);
      const initial = observation(f, paid, {
        refundId: 're_fixture_cap_a',
        eventId: 'evt_fixture_cap_a_first',
        amountCents: 200,
        status: 'succeeded',
        created: 1800000000,
      });
      await staff.store.observeVerifiedProcessorEvidence(
        a.id,
        initial,
        staff.action(),
        staff.context,
      );
      const originalApply = {
        ...staff.action('fixture-original-a-success'),
        action: 'apply-success' as const,
        ...(await staff.packet('apply-success', a.eligibleMicros)),
      };
      expect(await staff.store.reconcile(a.id, originalApply, staff.context)).toMatchObject({
        financialState: 'debited',
        reviewRequired: false,
      });
      // A separate real-identity fixture return was already issued externally.
      // Its400c plus A200c exceeds this original500c, and must remain a review.
      const bEvidence = observation(f, paid, {
        refundId: 're_fixture_cap_b',
        eventId: 'evt_fixture_cap_b',
        amountCents: 400,
        status: 'succeeded',
        created: 1800000001,
      });
      expect(await staff.prepare(4000000, [], bEvidence)).toMatchObject({
        origin: 'reconcile-existing',
        reviewRequired: true,
      });
      const refreshedA = observation(f, paid, {
        refundId: initial.refundId,
        eventId: 'evt_fixture_cap_a_new',
        amountCents: 200,
        status: 'succeeded',
        created: 1800000002,
      });
      await staff.store.observeVerifiedProcessorEvidence(
        a.id,
        refreshedA,
        staff.action(),
        staff.context,
      );
      const reviewed = (
        await f.engine.pool.query(
          'SELECT state,financial_state,review_required,evidence_conflict,ordering_review FROM mr_staff_refund_cases WHERE id=$1',
          [a.id],
        )
      ).rows[0];
      expect(reviewed).toEqual({
        state: 'review',
        financial_state: 'debited',
        review_required: true,
        evidence_conflict: false,
        ordering_review: false,
      });
      const beforeOldReplay = await allRefundRows(f);
      expect(await staff.store.reconcile(a.id, originalApply, staff.context)).toMatchObject({
        state: 'review',
        financialState: 'debited',
        reviewRequired: true,
      });
      expect(await allRefundRows(f)).toEqual(beforeOldReplay);

      const balanceBefore = await wallet(f);
      const entriesBefore = (
        await f.engine.pool.query(
          'SELECT row_to_json(t)::text AS row FROM mr_staff_refund_financial_entries t WHERE case_id=$1 ORDER BY action',
          [a.id],
        )
      ).rows;
      const ledgerBefore = (
        await f.engine.pool.query(
          "SELECT row_to_json(t)::text AS row FROM mr_ledger t WHERE reference LIKE 'staff-refund:'||$1::text||':%' ORDER BY reference",
          [a.id],
        )
      ).rows;
      const holdIds = (
        await f.engine.pool.query(
          'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
          [a.id],
        )
      ).rows.map((row) => row.event_id as string);
      expect(holdIds.length).toBeGreaterThan(0);
      const nextApply = {
        ...staff.action(),
        action: 'apply-success' as const,
        ...(await staff.packet('apply-success', a.eligibleMicros)),
        resolveHoldIds: holdIds,
        holdResolutionEvidenceUrl: 'https://evidence.example.invalid/current-principal-review',
      };
      // The public contract may reject or return an audited review. Neither is
      // allowed to clear the review merely because A already has a debit receipt.
      try {
        expect(await staff.store.reconcile(a.id, nextApply, staff.context)).toMatchObject({
          state: 'review',
          financialState: 'debited',
          reviewRequired: true,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(StaffRefundError);
      }
      expect(
        (
          await f.engine.pool.query(
            'SELECT state,financial_state,review_required FROM mr_staff_refund_cases WHERE id=$1',
            [a.id],
          )
        ).rows[0],
      ).toEqual({ state: 'review', financial_state: 'debited', review_required: true });
      expect(await wallet(f)).toEqual(balanceBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT row_to_json(t)::text AS row FROM mr_staff_refund_financial_entries t WHERE case_id=$1 ORDER BY action',
            [a.id],
          )
        ).rows,
      ).toEqual(entriesBefore);
      expect(
        (
          await f.engine.pool.query(
            "SELECT row_to_json(t)::text AS row FROM mr_ledger t WHERE reference LIKE 'staff-refund:'||$1::text||':%' ORDER BY reference",
            [a.id],
          )
        ).rows,
      ).toEqual(ledgerBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_billing_holds WHERE event_id=ANY($1::text[]) AND resolved_at IS NOT NULL',
            [holdIds],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_billing_hold_resolutions WHERE event_id=ANY($1::text[])',
            [holdIds],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('binds a first matching success via direct reaffirmation before writing its one private financial receipt', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      const c = await staff.prepare(1000000);
      expect(await staff.dispatch(c)).toHaveProperty('value.dispatchClaimed', true);
      expect(
        (
          await f.engine.pool.query('SELECT refund_id FROM mr_staff_refund_cases WHERE id=$1', [
            c.id,
          ])
        ).rows[0].refund_id,
      ).toBeNull();
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_observations WHERE case_id=$1',
            [c.id],
          )
        ).rows[0].n,
      ).toBe(0);
      const proof = observation(f, paid, {
        refundId: 're_fixture_direct_success',
        eventId: 'evt_fixture_direct_success',
        amountCents: 100,
        status: 'succeeded',
      });
      const input = {
        ...staff.action('fixture-direct-success'),
        action: 'apply-success' as const,
        ...(await staff.packet('apply-success', c.eligibleMicros)),
        reaffirmLatestEvidence: proof,
      };
      expect(await staff.store.reconcile(c.id, input, staff.context)).toMatchObject({
        financialState: 'debited',
        state: 'succeeded',
        reviewRequired: false,
        refundId: proof.refundId,
      });
      const entries = (
        await f.engine.pool.query(
          'SELECT action,amount_micros::text,cash_cents,receipt FROM mr_staff_refund_financial_entries WHERE case_id=$1',
          [c.id],
        )
      ).rows;
      expect(entries).toEqual([
        expect.objectContaining({
          action: 'debit',
          amount_micros: '1000000',
          cash_cents: 100,
          receipt: expect.objectContaining({
            caseId: c.id,
            orderId: paid.order.id,
            paymentIntentId: paid.paymentIntentId,
            refundId: proof.refundId,
            processorEnvironmentId: f.processorEnvironment.id,
            processorAccountId: f.processorEnvironment.accountId,
            paidCharacter: 'original-payment',
            before: { availableMicros: 5000000, reservedMicros: 0 },
            after: { availableMicros: 4000000, reservedMicros: 0 },
          }),
        }),
      ]);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_observations WHERE case_id=$1 AND refund_id=$2',
            [c.id, proof.refundId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_ledger WHERE reference='staff-refund:'||$1::text||':debit' AND kind='refund'",
            [c.id],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(await wallet(f)).toEqual({ available_micros: '4000000', reserved_micros: '0' });
      const beforeReplay = await allRefundRows(f);
      await staff.store.reconcile(c.id, input, staff.context);
      expect(await allRefundRows(f)).toEqual(beforeReplay);
    } finally {
      await f.close();
    }
  });

  it('keeps registered refund evidence conflicting with historical cents held when apply-success omits the item', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(1000),
        staff = manualStaff(f, paid);
      const target = await staff.prepare(2000000);
      await staff.dispatch(target);
      const historical: Returns = [
        {
          refundId: 're_fixture_registered_conflict',
          amountCents: 400,
          status: 'succeeded',
          evidenceReference: 'fixture-audited-historical-400',
        },
      ];
      await staff.prepare(1000000, historical);
      const proof = observation(f, paid, {
        refundId: historical[0]!.refundId,
        eventId: 'evt_fixture_registered_200',
        amountCents: 200,
        status: 'succeeded',
      });
      expect(
        await staff.store.observeVerifiedProcessorEvidence(
          target.id,
          proof,
          staff.action(),
          staff.context,
        ),
      ).toMatchObject({
        state: 'review',
        financialState: 'none',
        reviewRequired: true,
        refundId: proof.refundId,
      });
      const holdIds = (
        await f.engine.pool.query(
          'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
          [target.id],
        )
      ).rows.map((row) => row.event_id as string);
      const input = {
        ...staff.action('fixture-omitted-registered-item'),
        action: 'apply-success' as const,
        ...(await staff.packet('apply-success', target.eligibleMicros, [])),
        resolveHoldIds: holdIds,
        holdResolutionEvidenceUrl: 'https://evidence.example.invalid/registered-conflict',
      };
      const before = await allRefundRows(f);
      // Registration does not make the earlier400c claim compatible with the
      // verified200c refund. No reaffirmation or current-list omission may waive it.
      expect(input).not.toHaveProperty('reaffirmLatestEvidence');
      await expect(staff.store.reconcile(target.id, input, staff.context)).rejects.toMatchObject({
        code: 'staff_refund_conflict',
      });
      expect(await allRefundRows(f)).toEqual(before);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries WHERE case_id=$1',
            [target.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_ledger WHERE reference LIKE 'staff-refund:'||$1::text||':%'",
            [target.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_billing_holds WHERE event_id=ANY($1::text[]) AND resolved_at IS NOT NULL',
            [holdIds],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await wallet(f)).toEqual({ available_micros: '10000000', reserved_micros: '0' });
    } finally {
      await f.close();
    }
  });

  it.each([
    ['release-failed', 'omitted'],
    ['release-failed', 'changed'],
    ['restore-failed', 'omitted'],
    ['restore-failed', 'changed'],
  ] as const)(
    'refuses %s with %s historical returns without clearing review or poisoning approved history',
    async (operation, corruption) => {
      const f = await staffRefundFixture();
      try {
        const paid = await f.fund(1000),
          staff = manualStaff(f, paid);
        const target = await staff.prepare(2000000);
        await staff.dispatch(target);
        const refundId = `re_fixture_${operation.replaceAll('-', '_')}_${corruption}`;
        if (operation === 'restore-failed') {
          const success = observation(f, paid, {
            refundId,
            amountCents: 200,
            status: 'succeeded',
            created: 1800000000,
          });
          await staff.store.observeVerifiedProcessorEvidence(
            target.id,
            success,
            staff.action(),
            staff.context,
          );
          await staff.apply(target);
        }
        const failed = observation(f, paid, {
          refundId,
          eventId: `evt_fixture_old_${operation.replaceAll('-', '_')}_${corruption}`,
          type: 'refund.failed',
          amountCents: 200,
          status: 'failed',
          created: 1800000001,
          failure: 'txn_fixture_original_balance_return',
        });
        await staff.store.observeVerifiedProcessorEvidence(
          target.id,
          failed,
          staff.action(),
          staff.context,
        );
        const originalHoldIds = (
          await f.engine.pool.query(
            'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
            [target.id],
          )
        ).rows.map((row) => row.event_id as string);
        const originalDecision = {
          ...staff.action(`fixture-original-${operation}-${corruption}`),
          action: operation,
          ...(await staff.packet(operation, target.eligibleMicros, [])),
          reaffirmLatestEvidence: failed,
          resolveHoldIds: originalHoldIds,
          holdResolutionEvidenceUrl: 'https://evidence.example.invalid/original-failure',
        };
        const expectedFinancialState = operation === 'restore-failed' ? 'restored' : 'released';
        expect(
          await staff.store.reconcile(target.id, originalDecision, staff.context),
        ).toMatchObject({
          financialState: expectedFinancialState,
          state: 'failed',
          reviewRequired: false,
        });
        expect(await wallet(f)).toEqual({ available_micros: '10000000', reserved_micros: '0' });

        const historical: Returns = [
          {
            refundId: 're_fixture_other_historical',
            amountCents: 400,
            status: 'succeeded',
            evidenceReference: 'fixture-other-original-400',
          },
        ];
        await staff.prepare(1000000, historical);
        const currentFailure = observation(f, paid, {
          refundId,
          eventId: `evt_fixture_new_${operation.replaceAll('-', '_')}_${corruption}`,
          type: 'refund.failed',
          amountCents: 200,
          status: 'failed',
          created: 1800000002,
          failure: 'txn_fixture_original_balance_return',
        });
        expect(
          await staff.store.observeVerifiedProcessorEvidence(
            target.id,
            currentFailure,
            staff.action(),
            staff.context,
          ),
        ).toMatchObject({
          state: 'review',
          financialState: expectedFinancialState,
          reviewRequired: true,
        });
        const beforeOldReplay = await allRefundRows(f);
        expect(
          await staff.store.reconcile(target.id, originalDecision, staff.context),
        ).toMatchObject({
          state: 'review',
          financialState: expectedFinancialState,
          reviewRequired: true,
        });
        expect(await allRefundRows(f)).toEqual(beforeOldReplay);

        const holdIds = (
          await f.engine.pool.query(
            'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
            [target.id],
          )
        ).rows.map((row) => row.event_id as string);
        expect(holdIds.length).toBeGreaterThan(0);
        const invalidReturns: Returns =
          corruption === 'omitted' ? [] : [{ ...historical[0]!, amountCents: 399 }];
        const invalidDecision = {
          ...staff.action(`fixture-invalid-${operation}-${corruption}`),
          action: operation,
          ...(await staff.packet(operation, target.eligibleMicros, invalidReturns)),
          resolveHoldIds: holdIds,
          holdResolutionEvidenceUrl: 'https://evidence.example.invalid/invalid-failure-accounting',
        };
        const beforeInvalid = await allRefundRows(f);
        await expect(
          staff.store.reconcile(target.id, invalidDecision, staff.context),
        ).rejects.toMatchObject({
          code: corruption === 'omitted' ? 'staff_refund_review' : 'staff_refund_conflict',
        });
        // Rejected accounting must not append an approved phase with the omitted
        // or399c item, erase review, release a hold, or change either financial leg.
        expect(await allRefundRows(f)).toEqual(beforeInvalid);
        const externalRows = (await staff.store.reviewEvidence(f.workspaceId, staff.context))
          .financialRows.externalReturns!;
        expect([
          ...new Set(
            externalRows
              .filter((row) => row.refund_id === historical[0]!.refundId)
              .map((row) => Number(row.amount_cents)),
          ),
        ]).toEqual([400]);

        // A fresh, correct400c worksheet must still work after the refused packet;
        // immutable history must not be poisoned into a permanent399/400 conflict.
        const corrected = {
          ...staff.action(`fixture-corrected-${operation}-${corruption}`),
          action: operation,
          ...(await staff.packet(operation, target.eligibleMicros, historical)),
          reaffirmLatestEvidence: currentFailure,
          resolveHoldIds: holdIds,
          holdResolutionEvidenceUrl:
            'https://evidence.example.invalid/corrected-failure-accounting',
        };
        expect(await staff.store.reconcile(target.id, corrected, staff.context)).toMatchObject({
          financialState: expectedFinancialState,
          state: 'failed',
          reviewRequired: false,
        });
        expect(await wallet(f)).toEqual({ available_micros: '10000000', reserved_micros: '0' });
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries WHERE case_id=$1',
              [target.id],
            )
          ).rows[0].n,
        ).toBe(operation === 'restore-failed' ? 2 : 0);
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_billing_holds WHERE event_id=ANY($1::text[]) AND resolved_at IS NULL',
              [holdIds],
            )
          ).rows[0].n,
        ).toBe(0);
        const beforeFinalOldReplay = await allRefundRows(f);
        await staff.store.reconcile(target.id, originalDecision, staff.context);
        expect(await allRefundRows(f)).toEqual(beforeFinalOldReplay);
      } finally {
        await f.close();
      }
    },
  );

  it('does not manufacture a cap-review hold when first definitive failure releases only its own full-principal claim', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      const target = await staff.prepare(5000000);
      await staff.dispatch(target);
      const otherProof = observation(f, paid, {
        refundId: 're_fixture_other_full_return',
        eventId: 'evt_fixture_other_full_return',
        amountCents: 500,
        status: 'succeeded',
      });
      const other = await staff.prepare(5000000, [], otherProof);
      expect(other).toMatchObject({
        origin: 'reconcile-existing',
        state: 'review',
        reviewRequired: true,
        financialState: 'none',
      });
      const targetHoldsBefore = (
        await f.engine.pool.query(
          'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 ORDER BY event_id',
          [target.id],
        )
      ).rows.map((row) => row.event_id as string);
      const otherBefore = (
        await f.engine.pool.query(
          'SELECT row_to_json(t)::text AS row FROM mr_staff_refund_cases t WHERE id=$1',
          [other.id],
        )
      ).rows;
      const otherHoldsBefore = (
        await f.engine.pool.query(
          'SELECT row_to_json(t)::text AS row FROM mr_billing_holds t WHERE staff_refund_case_id=$1 ORDER BY event_id',
          [other.id],
        )
      ).rows;
      expect(targetHoldsBefore).toHaveLength(1);
      expect(otherHoldsBefore.length).toBeGreaterThan(0);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_observations WHERE case_id=$1',
            [target.id],
          )
        ).rows[0].n,
      ).toBe(0);
      const failed = observation(f, paid, {
        refundId: 're_fixture_target_failed_full',
        eventId: 'evt_fixture_target_first_failure',
        type: 'refund.failed',
        amountCents: 500,
        status: 'failed',
        created: 1800000001,
        failure: 'txn_fixture_target_returned_balance',
      });
      const input = {
        ...staff.action('fixture-first-full-failure-release'),
        action: 'release-failed' as const,
        ...(await staff.packet('release-failed', target.eligibleMicros)),
        reaffirmLatestEvidence: failed,
        resolveHoldIds: targetHoldsBefore,
        holdResolutionEvidenceUrl: 'https://evidence.example.invalid/first-full-failure',
      };
      expect(await staff.store.reconcile(target.id, input, staff.context)).toMatchObject({
        financialState: 'released',
        state: 'failed',
        reviewRequired: false,
        earmarkedMicros: 0,
        outstandingMicros: 0,
      });
      // The proven failed target contributes no returned principal. The OTHER
      //500c return still counts, so no synthetic target cap-conflict hold is needed.
      expect(
        (
          await f.engine.pool.query(
            'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 ORDER BY event_id',
            [target.id],
          )
        ).rows.map((row) => row.event_id as string),
      ).toEqual(targetHoldsBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL',
            [target.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await f.engine.pool.query(
            'SELECT row_to_json(t)::text AS row FROM mr_staff_refund_cases t WHERE id=$1',
            [other.id],
          )
        ).rows,
      ).toEqual(otherBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT row_to_json(t)::text AS row FROM mr_billing_holds t WHERE staff_refund_case_id=$1 ORDER BY event_id',
            [other.id],
          )
        ).rows,
      ).toEqual(otherHoldsBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries',
          )
        ).rows[0].n,
      ).toBe(0);
      expect(await wallet(f)).toEqual({ available_micros: '5000000', reserved_micros: '0' });
      const beforeReplay = await allRefundRows(f);
      await staff.store.reconcile(target.id, input, staff.context);
      expect(await allRefundRows(f)).toEqual(beforeReplay);
    } finally {
      await f.close();
    }
  });

  it.each(['omitted', 'changed'] as const)(
    'rejects %s historical returns before auditing an insufficient-wallet success decision',
    async (corruption) => {
      const f = await staffRefundFixture();
      try {
        const paid = await f.fund(1000),
          staff = manualStaff(f, paid);
        const jobId = await reserveSyntheticWork(f, 9000000);
        const reservationBefore = (
          await f.engine.pool.query(
            'SELECT row_to_json(t)::text AS row FROM mr_jobs t WHERE id=$1',
            [jobId],
          )
        ).rows;
        expect(await wallet(f)).toEqual({
          available_micros: '1000000',
          reserved_micros: '9000000',
        });
        const historical: Returns = [
          {
            refundId: 're_fixture_short_wallet_historical',
            amountCents: 400,
            status: 'succeeded',
            evidenceReference: 'fixture-original-historical-400',
          },
        ];
        await staff.prepare(1, historical);
        const proof = observation(f, paid, {
          refundId: 're_fixture_short_wallet_target',
          amountCents: 200,
          status: 'succeeded',
        });
        const target = await staff.prepare(2000000, historical, proof);
        expect(target).toMatchObject({
          origin: 'reconcile-existing',
          financialState: 'none',
          state: 'review',
          reviewRequired: true,
          outstandingMicros: 2000000,
        });
        expect(
          (
            await f.engine.pool.query(
              'SELECT evidence_conflict,ordering_review FROM mr_staff_refund_cases WHERE id=$1',
              [target.id],
            )
          ).rows[0],
        ).toEqual({ evidence_conflict: false, ordering_review: false });
        const holdIds = (
          await f.engine.pool.query(
            'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
            [target.id],
          )
        ).rows.map((row) => row.event_id as string);
        expect(holdIds.length).toBeGreaterThan(0);
        const invalidReturns: Returns =
          corruption === 'omitted' ? [] : [{ ...historical[0]!, amountCents: 399 }];
        const invalid = {
          ...staff.action(`fixture-short-wallet-invalid-${corruption}`),
          action: 'apply-success' as const,
          ...(await staff.packet('apply-success', target.eligibleMicros, invalidReturns)),
          resolveHoldIds: holdIds,
          holdResolutionEvidenceUrl: 'https://evidence.example.invalid/short-wallet-review',
        };
        const beforeInvalid = await allRefundRows(f);
        expect(invalid).not.toHaveProperty('reaffirmLatestEvidence');
        // A real shortage must not short-circuit historical validation and make
        // the invalid packet an immutable approved phase on the review path.
        await expect(
          staff.store.reconcile(target.id, invalid, staff.context),
        ).rejects.toMatchObject({
          code: corruption === 'omitted' ? 'staff_refund_review' : 'staff_refund_conflict',
        });
        expect(await allRefundRows(f)).toEqual(beforeInvalid);

        const corrected = {
          ...staff.action(`fixture-short-wallet-corrected-${corruption}`),
          action: 'apply-success' as const,
          ...(await staff.packet('apply-success', target.eligibleMicros, historical)),
        };
        expect(await staff.store.reconcile(target.id, corrected, staff.context)).toMatchObject({
          financialState: 'none',
          state: 'review',
          reviewRequired: true,
          outstandingMicros: 2000000,
        });
        const externalRows = (await staff.store.reviewEvidence(f.workspaceId, staff.context))
          .financialRows.externalReturns!;
        expect([
          ...new Set(
            externalRows
              .filter((row) => row.refund_id === historical[0]!.refundId)
              .map((row) => Number(row.amount_cents)),
          ),
        ]).toEqual([400]);
        expect(await wallet(f)).toEqual(beforeInvalid.wallet);
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries',
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await f.engine.pool.query(
              'SELECT row_to_json(t)::text AS row FROM mr_jobs t WHERE id=$1',
              [jobId],
            )
          ).rows,
        ).toEqual(reservationBefore);
        // Independently check that queued exposure and both ledger deltas still
        // explain the short wallet; no synthetic credit disappearance is used.
        expect(
          (
            await f.engine.pool.query(
              `SELECT sum(available_delta_micros)::text AS available_micros,
               sum(reserved_delta_micros)::text AS reserved_micros FROM mr_ledger WHERE workspace_id=$1`,
              [f.workspaceId],
            )
          ).rows[0],
        ).toEqual(beforeInvalid.wallet);
        expect(
          (
            await f.engine.pool.query(
              `SELECT j.status,j.reserved_micros::text,l.kind,l.amount_micros::text,
               l.available_delta_micros::text,l.reserved_delta_micros::text
               FROM mr_jobs j JOIN mr_ledger l ON l.job_id=j.id WHERE j.id=$1`,
              [jobId],
            )
          ).rows,
        ).toEqual([
          {
            status: 'queued',
            reserved_micros: '9000000',
            kind: 'reserve',
            amount_micros: '9000000',
            available_delta_micros: '-9000000',
            reserved_delta_micros: '9000000',
          },
        ]);
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*)::int AS n FROM mr_billing_holds WHERE event_id=ANY($1::text[]) AND resolved_at IS NOT NULL',
              [holdIds],
            )
          ).rows[0].n,
        ).toBe(0);
        expect(f.submit).not.toHaveBeenCalled();
        expect(f.poll).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('rejects stale own pending accounting before first failed reaffirmation and keeps the repaired release final', async () => {
    const f = await staffRefundFixture();
    try {
      const paid = await f.fund(),
        staff = manualStaff(f, paid);
      const pending = observation(f, paid, {
        refundId: 're_fixture_own_pending_release',
        eventId: 'evt_fixture_own_pending_release',
        amountCents: 500,
        status: 'pending',
        created: 1800000000,
      });
      const ownPending: Returns = [
        {
          refundId: pending.refundId,
          amountCents: 500,
          status: 'pending',
          evidenceReference: 'fixture-original-own-pending',
        },
      ];
      const target = await staff.prepare(5000000, ownPending, pending);
      expect(target).toMatchObject({
        origin: 'reconcile-existing',
        financialState: 'none',
        state: 'pending',
        reviewRequired: false,
        refundId: pending.refundId,
      });
      const holdIds = (
        await f.engine.pool.query(
          'SELECT event_id FROM mr_billing_holds WHERE staff_refund_case_id=$1 AND resolved_at IS NULL ORDER BY event_id',
          [target.id],
        )
      ).rows.map((row) => row.event_id as string);
      expect(holdIds).toHaveLength(1);
      const failed = observation(f, paid, {
        refundId: pending.refundId,
        eventId: 'evt_fixture_own_first_failed',
        type: 'refund.failed',
        amountCents: 500,
        status: 'failed',
        created: 1800000001,
        failure: 'txn_fixture_own_returned_balance',
      });
      const stale = {
        ...staff.action('fixture-stale-own-pending-release'),
        action: 'release-failed' as const,
        ...(await staff.packet('release-failed', target.eligibleMicros, ownPending)),
        reaffirmLatestEvidence: failed,
        resolveHoldIds: holdIds,
        holdResolutionEvidenceUrl: 'https://evidence.example.invalid/stale-own-status',
      };
      const beforeStale = await allRefundRows(f);
      await expect(staff.store.reconcile(target.id, stale, staff.context)).rejects.toMatchObject({
        code: 'staff_refund_review',
      });
      expect(await allRefundRows(f)).toEqual(beforeStale);
      const ownFailed: Returns = [
        {
          ...ownPending[0]!,
          status: 'failed',
          definitiveFailureBalanceReturned: true,
          evidenceReference: 'fixture-original-own-failed-returned',
        },
      ];
      const corrected = {
        ...staff.action('fixture-corrected-own-failed-release'),
        action: 'release-failed' as const,
        ...(await staff.packet('release-failed', target.eligibleMicros, ownFailed)),
        reaffirmLatestEvidence: failed,
        resolveHoldIds: holdIds,
        holdResolutionEvidenceUrl: 'https://evidence.example.invalid/corrected-own-status',
      };
      expect(await staff.store.reconcile(target.id, corrected, staff.context)).toMatchObject({
        financialState: 'released',
        state: 'failed',
        reviewRequired: false,
        earmarkedMicros: 0,
        outstandingMicros: 0,
      });
      const laterFailure = observation(f, paid, {
        refundId: pending.refundId,
        eventId: 'evt_fixture_own_matching_failed_later',
        type: 'refund.failed',
        amountCents: 500,
        status: 'failed',
        created: 1800000002,
        failure: 'txn_fixture_own_returned_balance',
      });
      expect(
        await staff.store.observeVerifiedProcessorEvidence(
          target.id,
          laterFailure,
          staff.action(),
          staff.context,
        ),
      ).toMatchObject({ financialState: 'released', state: 'failed', reviewRequired: false });
      expect(
        (
          await f.engine.pool.query(
            'SELECT event_id,resolved_at IS NOT NULL AS resolved FROM mr_billing_holds WHERE staff_refund_case_id=$1 ORDER BY event_id',
            [target.id],
          )
        ).rows,
      ).toEqual(holdIds.map((event_id) => ({ event_id, resolved: true })));
      expect(await wallet(f)).toEqual({ available_micros: '5000000', reserved_micros: '0' });
      expect(
        (
          await f.engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_staff_refund_financial_entries',
          )
        ).rows[0].n,
      ).toBe(0);
      const beforeReplay = await allRefundRows(f);
      await staff.store.reconcile(target.id, corrected, staff.context);
      expect(await allRefundRows(f)).toEqual(beforeReplay);
      const replacement = await staff.prepare(5000000);
      expect(replacement).toMatchObject({ state: 'prepared', earmarkedMicros: 5000000 });
      expect(await staff.dispatch(replacement)).toHaveProperty('value.dispatchClaimed', true);
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*)::int AS n FROM mr_staff_refund_audit WHERE case_id=$1 AND action='dispatch'",
            [target.id],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.poll).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
