import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool, type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExistingStaffRefundController,
  type ExistingStaffRefundControllerOptions,
  type StaffRefundRawDelivery,
} from '../apps/server/src/staff-refund-existing-controller.js';
import { createStaffRefundEvidenceProducer } from '../apps/server/src/staff-refund-evidence-producer.js';
import { createStripeClient, STRIPE_API_VERSION } from '../apps/server/src/payments.js';
import { buildApp } from '../apps/server/src/app.js';
import {
  staffRefundHash,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../packages/engine/src/staff-refunds.js';
import type { VerifiedPaymentEvent } from '../packages/engine/src/payments.js';
import { staffRefundFixture } from './staff-refund-fixture.js';

const external = vi.hoisted(() => ({
  request: vi.fn(() => {
    throw new Error('Controller integration forbids real HTTPS requests.');
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
const fetch = vi.fn<typeof globalThis.fetch>(async () => {
  throw new Error('Controller integration forbids real fetch requests.');
});
const secret = 'synthetic_controller_webhook_secret';
const testDatabase = process.env.TEST_DATABASE_URL;
const extraPools: Pool[] = [];
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.stubGlobal('fetch', fetch);
});
afterEach(async () => {
  try {
    await Promise.all(extraPools.splice(0).map((pool) => pool.end()));
    await cleanup?.();
    expect(fetch).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  } finally {
    cleanup = undefined;
    fetch.mockClear();
    external.request.mockClear();
    vi.unstubAllGlobals();
  }
});
const action = (reference = randomUUID()) => ({
  reference,
  note: 'Synthetic independently reviewed existing-return action.',
  evidenceReference: 'fixture-verified-original-return',
});

async function setup(options: { approval?: boolean } = {}) {
  const f = await staffRefundFixture();
  cleanup = f.close;
  const paid = await f.fund();
  const target = {
    workspaceId: f.workspaceId,
    orderId: paid.order.id,
    paymentIntentId: paid.paymentIntentId,
    chargeId: `ch_staff${paid.order.id.replaceAll('-', '')}`,
    refundId: `re_controller${randomUUID().replaceAll('-', '')}`,
    originalAmountCents: 500,
    refundAmountCents: 500,
    eligibleMicros: 5_000_000,
  };
  const expected = Object.freeze({ ...target });
  const context = Object.freeze({ staff: Symbol('independent-fixture-authority') });
  const state = {
    authorized: true,
    actorId: 'fixture-internal-staff',
    processorVerified: true,
    allocationApproved: true,
    revokeProcessorDuringAuthority: false,
    revokeProcessorDuringApproval: false,
  };
  const control: { beforeApplyApproval?: () => Promise<void> } = {};
  const packets = new Set<string>();
  const authorize: StaffRefundStoreOptions['authorize'] = vi.fn(async (_client, supplied) => {
    if (supplied !== context || !state.authorized)
      throw new Error('Current fixture staff authority is required.');
    if (state.revokeProcessorDuringAuthority) state.processorVerified = false;
    return { id: state.actorId, kind: 'installation-operator' };
  });
  const approveAllocation: NonNullable<StaffRefundStoreOptions['approveAllocation']> = vi.fn(
    async (client, supplied, request) => {
      expect(supplied).toBe(context);
      if (!state.allocationApproved)
        throw new Error('Independent paid-allocation approval was revoked.');
      const original = (
        await client.query(
          'SELECT workspace_id,payment_intent_id,amount_cents,credited_at FROM mr_payment_orders WHERE id=$1',
          [expected.orderId],
        )
      ).rows[0];
      expect(original).toMatchObject({
        workspace_id: expected.workspaceId,
        payment_intent_id: expected.paymentIntentId,
        amount_cents: 500,
      });
      expect(original.credited_at).not.toBeNull();
      expect(request).toMatchObject({
        workspaceId: expected.workspaceId,
        orderId: expected.orderId,
        paymentIntentId: expected.paymentIntentId,
        processorEnvironmentId: f.processorEnvironment.id,
        processorAccountId: f.processorEnvironment.accountId,
        livemode: false,
        creditReference: `stripe-topup:${expected.orderId}`,
        originalAmountCents: 500,
        eligibleMicros: expected.eligibleMicros,
        cashCents: 500,
        roundingExpenseMicros: 0,
      });
      expect(['prepare', 'apply-success']).toContain(request.operation);
      expect(
        packets.has(
          `${request.operation}/${request.worksheetHash}/${staffRefundHash(request.reaffirmation)}`,
        ),
      ).toBe(true);
      expect(request.worksheetHash).toBe(staffRefundHash(request.worksheet));
      const { requestHash, ...body } = request;
      expect(requestHash).toBe(staffRefundHash(body));
      expect(request.worksheet.allocation).toEqual([
        {
          fundingReference: `stripe-topup:${expected.orderId}`,
          disposition: 'eligible-paid',
          amountMicros: 5_000_000,
        },
      ]);
      if (request.operation === 'apply-success') await control.beforeApplyApproval?.();
      if (state.revokeProcessorDuringApproval) state.processorVerified = false;
      return { approvalReference: `fixture-approved-${request.operation}`, requestHash };
    },
  );
  const processorTransport = {
    processorEnvironment: { ...f.processorEnvironment },
    assertProcessorEnvironment: vi.fn(() => {
      if (!state.processorVerified)
        throw new Error('Synthetic processor bootstrap proof was revoked.');
    }),
  };
  const config: ExistingStaffRefundControllerOptions = {
    activation: 'sandbox',
    processorEnvironment: { ...f.processorEnvironment },
    processorTransport,
    webhookSecret: secret,
    target,
    authorize,
    ...(options.approval === false ? {} : { approveAllocation }),
  };
  const controller = new ExistingStaffRefundController(f.engine.pool, config);
  const signer = createStripeClient('synthetic-signature-only-no-api-access');
  const producer = createStaffRefundEvidenceProducer({
    activation: 'sandbox',
    processorEnvironment: f.processorEnvironment,
    processorTransport,
    webhookSecret: secret,
  });
  const payment = {
    workspaceId: expected.workspaceId,
    orderId: expected.orderId,
    processorEnvironmentId: f.processorEnvironment.id,
    processorAccountId: f.processorEnvironment.accountId,
    livemode: false,
    paymentIntentId: expected.paymentIntentId,
    chargeId: expected.chargeId,
    amountCents: 500,
    currency: 'USD' as const,
  };
  function delivery(
    patch: Record<string, unknown> = {},
    eventPatch: Record<string, unknown> = {},
  ): StaffRefundRawDelivery {
    const event = {
      id: `evt_controller${randomUUID().replaceAll('-', '')}`,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      type: 'refund.updated',
      livemode: false,
      // Fresh delivery signatures can legitimately carry a much older event.
      created: Math.floor(Date.now() / 1000) - 86400,
      ...eventPatch,
      data: {
        object: {
          id: expected.refundId,
          object: 'refund',
          payment_intent: expected.paymentIntentId,
          charge: expected.chargeId,
          amount: 500,
          currency: 'usd',
          status: 'succeeded',
          ...patch,
        },
      },
    };
    const payload = `${JSON.stringify(event, null, 2)}\n`;
    return {
      rawBody: Buffer.from(payload),
      signature: signer.webhooks.generateTestHeaderString({ payload, secret }),
    };
  }
  async function recordLegacy(delivered: StaffRefundRawDelivery) {
    // Real local SDK signature verification, then the existing trusted billing
    // boundary. Never manufacture staff evidence from a journal or JSON cast.
    const verified = signer.webhooks.constructEvent(delivered.rawBody, delivered.signature, secret);
    return f.payments.reconcile(
      {
        ...verified,
        processorEnvironment: f.processorEnvironment,
      } as unknown as VerifiedPaymentEvent,
      f.transport,
    );
  }
  async function packet(phase: 'prepare' | 'apply-success', reaffirm?: StaffRefundRawDelivery) {
    const worksheet: StaffRefundWorksheet = {
      snapshot: (await controller.review(context)).snapshot,
      allocationReference: 'fixture-original-paid-allocation',
      originalPayerReference: 'fixture-verified-original-payer',
      note: 'Synthetic independent review of original paid funding and the selected return.',
      externalReturns: [],
      allocation: [
        {
          fundingReference: `stripe-topup:${expected.orderId}`,
          disposition: 'eligible-paid',
          amountMicros: expected.eligibleMicros,
        },
      ],
    };
    const worksheetHash = staffRefundHash(worksheet);
    let identity: { eventId: string; payloadFingerprint: string; eventCreated: number } | null =
      null;
    if (reaffirm) {
      const verified = producer.verifyRaw(reaffirm, { payment, refundId: expected.refundId });
      if (verified.kind !== 'refund')
        throw new Error('The independent fixture approval requires signed matching evidence.');
      identity = {
        eventId: verified.evidence.eventId,
        payloadFingerprint: verified.evidence.payloadFingerprint,
        eventCreated: verified.evidence.eventCreated,
      };
    }
    packets.add(`${phase}/${worksheetHash}/${staffRefundHash(identity)}`);
    return { worksheet, worksheetHash };
  }
  async function prepareExisting(delivered = delivery()) {
    return controller.prepareExisting(
      { delivery: delivered, reference: randomUUID(), ...(await packet('prepare')) },
      context,
    );
  }
  return {
    ...f,
    paid,
    expected,
    target,
    context,
    state,
    control,
    packets,
    config,
    controller,
    producer,
    signer,
    payment,
    authorize,
    approveAllocation,
    processorTransport,
    delivery,
    recordLegacy,
    packet,
    prepareExisting,
  };
}

type Fixture = Awaited<ReturnType<typeof setup>>;
async function money(f: Fixture) {
  return {
    balance: await f.engine.getBalance(f.workspaceId),
    ledger: (
      await f.engine.pool.query(
        'SELECT id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details,created_at FROM mr_ledger WHERE workspace_id=$1 ORDER BY created_at,id',
        [f.workspaceId],
      )
    ).rows,
  };
}
async function holds(f: Fixture) {
  return (
    await f.engine.pool.query(
      'SELECT event_id,reason,resolved_at,resolution_reference FROM mr_billing_holds WHERE workspace_id=$1 ORDER BY event_id',
      [f.workspaceId],
    )
  ).rows;
}

/** Entire application-row inventory inside the guarded ephemeral schema. Only
 * counts/hashes are returned, so an assertion failure cannot print private rows.
 * Sequence allocation is deliberately excluded: rollback can leave valid gaps. */
async function databaseRows(f: Fixture) {
  const schema = f.database.schema;
  if (!/^[a-z][a-z0-9_]+$/.test(schema)) throw new Error('Unexpected fixture schema.');
  const tables = (
    await f.engine.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename ~ '^mr_' ORDER BY tablename",
      [schema],
    )
  ).rows;
  expect(tables.length).toBeGreaterThan(50);
  const snapshot: { table: string; count: number; sha256: string }[] = [];
  for (const { tablename } of tables) {
    if (!/^mr_[a-z0-9_]+$/.test(tablename)) throw new Error('Unexpected fixture table.');
    const rows = (
      await f.engine.pool.query<{ row: string }>(
        `SELECT to_jsonb(item)::text AS row FROM "${schema}"."${tablename}" item ORDER BY to_jsonb(item)::text`,
      )
    ).rows;
    snapshot.push({
      table: tablename,
      count: rows.length,
      sha256: createHash('sha256')
        .update(rows.map((row) => row.row).join('\n'))
        .digest('hex'),
    });
  }
  return snapshot;
}

function forbiddenPool() {
  const connect = vi.fn(async () => {
    throw new Error('No database access is permitted by a closed gate.');
  });
  const query = vi.fn(async () => {
    throw new Error('No database access is permitted by a closed gate.');
  });
  return { connect, query, pool: { connect, query } as unknown as Pool };
}
function gateOptions(): ExistingStaffRefundControllerOptions {
  const processorEnvironment = {
    id: 'fixture-controller',
    accountId: 'acct_fixture',
    livemode: false,
  };
  return {
    processorEnvironment,
    processorTransport: { processorEnvironment, assertProcessorEnvironment() {} },
    webhookSecret: secret,
    target: {
      workspaceId: 'fixture-controller',
      orderId: randomUUID(),
      paymentIntentId: 'pi_fixturecontroller',
      chargeId: 'ch_fixturecontroller',
      refundId: 're_fixturecontroller',
      originalAmountCents: 500,
      refundAmountCents: 500,
      eligibleMicros: 5_000_000,
    },
    authorize: async () => ({ id: 'fixture-staff', kind: 'installation-operator' }),
  };
}

describe('internal existing-refund controller gates without a database', () => {
  it('stays closed before database access when activation is omitted', async () => {
    const f = forbiddenPool();
    const controller = new ExistingStaffRefundController(f.pool, gateOptions());
    await expect(controller.review({})).rejects.toMatchObject({ code: 'staff_refunds_disabled' });
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects a live environment before database access', () => {
    const f = forbiddenPool();
    const options = gateOptions();
    expect(
      () =>
        new ExistingStaffRefundController(f.pool, {
          ...options,
          activation: 'sandbox',
          processorEnvironment: { ...options.processorEnvironment, livemode: true },
        }),
    ).toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe.skipIf(!testDatabase)(
  'signed raw event to independently approved existing-refund reconciliation',
  () => {
    it('rehearses actual signed bytes read-only and retains the signed event creation time', async () => {
      const f = await setup();
      const delivered = f.delivery();
      const raw = JSON.parse(delivered.rawBody.toString());
      const before = await money(f);
      const verified = f.producer.verifyRaw(delivered, {
        payment: f.payment,
        refundId: f.expected.refundId,
      });
      expect(verified).toMatchObject({
        kind: 'refund',
        evidence: { eventId: raw.id, eventCreated: raw.created, amountCents: 500 },
      });
      const rehearsal = await f.controller.rehearse(delivered, f.context);
      expect(rehearsal).toMatchObject({
        applyAllowed: false,
        target: f.expected,
        processor: {
          kind: 'refund',
          eventId: raw.id,
          eventCreated: raw.created,
          status: 'succeeded',
          amountCents: 500,
        },
      });
      expect(await money(f)).toEqual(before);
      expect(
        (await f.engine.pool.query('SELECT count(*) FROM mr_staff_refund_cases')).rows[0].count,
      ).toBe('0');
    });

    it('uses genuine raw success for one exact existing-return debit while every original and staff hold stays unresolved', async () => {
      const f = await setup();
      const delivered = f.delivery();
      await f.recordLegacy(delivered);
      expect(await f.recordLegacy(delivered)).toMatchObject({ duplicate: true });
      await f.recordLegacy(
        f.delivery(
          { id: f.expected.chargeId, object: 'charge', amount_refunded: 500 },
          { type: 'charge.refunded' },
        ),
      );
      await f.recordLegacy(
        f.delivery(
          { id: 'dp_controller_dispute', object: 'dispute' },
          { type: 'charge.dispute.created' },
        ),
      );
      await f.recordLegacy(
        f.delivery(
          {
            id: 're_controller_other_failed',
            status: 'failed',
            amount: 100,
            failure_balance_transaction: 'txn_controller_other',
          },
          { type: 'refund.failed' },
        ),
      );
      const before = await money(f);
      const prepared = await f.prepareExisting(delivered);
      expect(prepared).toMatchObject({
        origin: 'reconcile-existing',
        eligibleMicros: 5_000_000,
        cashCents: 500,
        financialState: 'none',
      });
      expect(await money(f)).toEqual(before);
      const protectedHolds = await holds(f);
      expect(protectedHolds.length).toBeGreaterThanOrEqual(5);
      expect(protectedHolds.every((hold) => hold.resolved_at === null)).toBe(true);
      await f.controller.observeExisting(
        prepared.id,
        { delivery: delivered, ...action('same-raw-observation') },
        f.context,
      );
      expect(await money(f)).toEqual(before);
      const input = {
        ...action('explicit-original-wallet-debit'),
        ...(await f.packet('apply-success', delivered)),
        delivery: delivered,
      };
      const applied = await f.controller.applyExisting(prepared.id, input, f.context);
      expect(applied).toMatchObject({
        financialState: 'debited',
        earmarkedMicros: 0,
        outstandingMicros: 0,
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: 0,
      });
      const after = await money(f);
      expect(after.ledger.filter((row) => row.kind === 'credit')).toEqual(
        before.ledger.filter((row) => row.kind === 'credit'),
      );
      expect(
        after.ledger.filter((row) => row.reference === `staff-refund:${prepared.id}:debit`),
      ).toMatchObject([
        {
          amount_micros: '5000000',
          available_delta_micros: '-5000000',
          reserved_delta_micros: '0',
        },
      ]);
      expect(await holds(f)).toEqual(protectedHolds);
      await f.controller.applyExisting(prepared.id, input, f.context);
      await f.controller.observeExisting(
        prepared.id,
        { delivery: delivered, ...action('raw-replay-after-debit') },
        f.context,
      );
      expect(await money(f)).toEqual(after);
      expect(await holds(f)).toEqual(protectedHolds);
      expect(await f.payments.getOrder(f.workspaceId, f.paid.order.id)).toEqual(f.paid.order);
      expect((f.controller as unknown as Record<string, unknown>).dispatch).toBeUndefined();
      expect((f.controller as unknown as Record<string, unknown>).resolveHold).toBeUndefined();
    });

    it.each([
      'tampered',
      'missing-signature',
      'wrong-mode',
      'connected-account',
      'scoped-context',
      'wrong-refund',
      'wrong-intent',
      'aggregate',
    ] as const)(
      'refuses %s evidence without creating a staff case or changing money',
      async (variant) => {
        const f = await setup();
        const valid = f.delivery();
        const delivered =
          variant === 'tampered'
            ? { ...valid, rawBody: Buffer.concat([valid.rawBody, Buffer.from(' ')]) }
            : variant === 'missing-signature'
              ? { ...valid, signature: '' }
              : variant === 'wrong-mode'
                ? f.delivery({}, { livemode: true })
                : variant === 'connected-account'
                  ? f.delivery({}, { account: 'acct_other' })
                  : variant === 'scoped-context'
                    ? f.delivery({}, { context: 'acct_other' })
                    : variant === 'wrong-refund'
                      ? f.delivery({ id: 're_other' })
                      : variant === 'wrong-intent'
                        ? f.delivery({
                            payment_intent: 'pi_other',
                            metadata: { workspaceId: f.workspaceId, orderId: f.paid.order.id },
                          })
                        : f.delivery(
                            { id: f.expected.chargeId, object: 'charge', amount_refunded: 500 },
                            { type: 'charge.refunded' },
                          );
        const before = await money(f);
        expect((await f.controller.rehearse(delivered, f.context)).processor.kind).toBe('review');
        await expect(f.prepareExisting(delivered)).rejects.toMatchObject({
          code: 'staff_refund_evidence_unverified',
        });
        expect(await money(f)).toEqual(before);
        expect(
          (await f.engine.pool.query('SELECT count(*) FROM mr_staff_refund_cases')).rows[0].count,
        ).toBe('0');
      },
    );

    it('holds a pending original return and requires fresh signed success plus independent approval before any debit', async () => {
      const f = await setup();
      const pending = f.delivery({ status: 'pending' });
      const prepared = await f.prepareExisting(pending);
      const before = await money(f);
      await expect(
        f.controller.applyExisting(
          prepared.id,
          { ...action(), ...(await f.packet('apply-success')) },
          f.context,
        ),
      ).rejects.toMatchObject({ code: 'staff_refund_review' });
      const success = f.delivery(
        {},
        { created: JSON.parse(pending.rawBody.toString()).created + 1 },
      );
      await f.controller.observeExisting(
        prepared.id,
        { ...action(), delivery: success },
        f.context,
      );
      expect(await money(f)).toEqual(before);
      const input = {
        ...action(),
        ...(await f.packet('apply-success', success)),
        delivery: success,
      };
      f.state.allocationApproved = false;
      await expect(f.controller.applyExisting(prepared.id, input, f.context)).rejects.toMatchObject(
        { code: 'staff_refund_allocation_unapproved' },
      );
      expect(await money(f)).toEqual(before);
      f.state.allocationApproved = true;
      await f.controller.applyExisting(prepared.id, input, f.context);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: 0,
      });
    });

    it('rejects proof JSON, caller hold resolutions, and missing worksheets instead of using a stored fallback', async () => {
      const f = await setup();
      const delivered = f.delivery();
      const packet = await f.packet('prepare');
      const evidence = f.producer.verifyRaw(delivered, {
        payment: f.payment,
        refundId: f.expected.refundId,
      });
      for (const supplied of [evidence, JSON.parse(JSON.stringify(evidence))])
        await expect(
          Reflect.apply(f.controller.prepareExisting, f.controller, [
            { delivery: delivered, reference: randomUUID(), ...packet, evidence: supplied },
            f.context,
          ]),
        ).rejects.toMatchObject({ code: 'invalid_staff_refund' });
      await expect(
        Reflect.apply(f.controller.prepareExisting, f.controller, [
          { delivery: delivered, reference: randomUUID(), worksheetHash: packet.worksheetHash },
          f.context,
        ]),
      ).rejects.toMatchObject({ code: 'invalid_staff_refund' });
      const prepared = await f.prepareExisting(delivered);
      const before = await money(f);
      const input = { ...action(), ...(await f.packet('apply-success')) };
      await expect(
        Reflect.apply(f.controller.applyExisting, f.controller, [
          prepared.id,
          { ...input, resolveHoldIds: prepared.holdIds },
          f.context,
        ]),
      ).rejects.toMatchObject({ code: 'invalid_staff_refund' });
      await expect(
        Reflect.apply(f.controller.applyExisting, f.controller, [prepared.id, action(), f.context]),
      ).rejects.toMatchObject({ code: 'invalid_staff_refund' });
      expect(await money(f)).toEqual(before);
      expect((await holds(f)).every((hold) => hold.resolved_at === null)).toBe(true);
    });

    it('revalidates staff and processor authority even when apply carries no new delivery', async () => {
      const f = await setup();
      const prepared = await f.prepareExisting();
      const input = { ...action(), ...(await f.packet('apply-success')) };
      const before = await money(f);
      f.state.authorized = false;
      await expect(f.controller.applyExisting(prepared.id, input, f.context)).rejects.toMatchObject(
        { code: 'staff_refund_authority_required' },
      );
      f.state.authorized = true;
      f.state.processorVerified = false;
      await expect(f.controller.applyExisting(prepared.id, input, f.context)).rejects.toThrow();
      expect(await money(f)).toEqual(before);
      expect((await holds(f)).every((hold) => hold.resolved_at === null)).toBe(true);
    });

    it.each(['authority', 'allocation'] as const)(
      'denies processor proof revoked during the awaited %s hook before any debit',
      async (phase) => {
        const f = await setup();
        const prepared = await f.prepareExisting();
        const input = { ...action(), ...(await f.packet('apply-success')) };
        const before = await money(f);
        const protectedHolds = await holds(f);
        if (phase === 'authority') f.state.revokeProcessorDuringAuthority = true;
        else f.state.revokeProcessorDuringApproval = true;
        await expect(f.controller.applyExisting(prepared.id, input, f.context)).rejects.toThrow();
        expect(await money(f)).toEqual(before);
        expect(await holds(f)).toEqual(protectedHolds);
        expect(
          (
            await f.engine.pool.query(
              'SELECT financial_state FROM mr_staff_refund_cases WHERE id=$1',
              [prepared.id],
            )
          ).rows,
        ).toEqual([{ financial_state: 'none' }]);
      },
    );

    it.each([
      {
        condition: 'staff authority is revoked',
        change: (f: Fixture) => {
          f.state.authorized = false;
        },
      },
      {
        condition: 'the staff actor changes',
        change: (f: Fixture) => {
          f.state.actorId = 'fixture-different-current-staff';
        },
      },
    ])(
      'rolls back every database change when $condition during awaited allocation approval',
      async ({ change }) => {
        const f = await setup();
        const prepared = await f.prepareExisting();
        const input = {
          ...action('same-approval-after-authority-revalidation'),
          ...(await f.packet('apply-success')),
        };
        const originalActor = f.state.actorId;
        const before = await databaseRows(f);
        const beforeMoney = await money(f);
        const protectedHolds = await holds(f);
        f.control.beforeApplyApproval = async () => {
          await Promise.resolve();
          change(f);
        };
        const result = await f.controller.applyExisting(prepared.id, input, f.context).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        // Check every persisted row, including the case, private audit/expense/
        // financial receipts, wallet and legacy holds. A revoked caller cannot
        // leave a committed debit or a poisoned audit reference behind.
        expect(await databaseRows(f)).toEqual(before);
        expect(await money(f)).toEqual(beforeMoney);
        expect(await holds(f)).toEqual(protectedHolds);
        expect(result).toMatchObject({
          error: { code: 'staff_refund_authority_required', statusCode: 403 },
        });
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*) FROM mr_staff_refund_financial_entries WHERE case_id=$1',
              [prepared.id],
            )
          ).rows[0].count,
        ).toBe('0');

        // The failed transaction consumed no action reference or worksheet. The
        // same independently approved input can be retried after authority returns.
        f.state.authorized = true;
        f.state.actorId = originalActor;
        f.control.beforeApplyApproval = undefined;
        const applied = await f.controller.applyExisting(prepared.id, input, f.context);
        expect(applied).toMatchObject({ financialState: 'debited' });
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 0,
          reservedMicros: 0,
        });
        expect(
          (await money(f)).ledger.filter(
            (row) => row.reference === `staff-refund:${prepared.id}:debit`,
          ),
        ).toHaveLength(1);
        expect(
          (
            await f.engine.pool.query(
              'SELECT count(*) FROM mr_staff_refund_financial_entries WHERE case_id=$1',
              [prepared.id],
            )
          ).rows[0].count,
        ).toBe('1');
        expect(await holds(f)).toEqual(protectedHolds);
        const after = await databaseRows(f);
        const approvalCalls = vi.mocked(f.approveAllocation).mock.calls.length;
        await f.controller.applyExisting(prepared.id, input, f.context);
        expect(await databaseRows(f)).toEqual(after);
        expect(vi.mocked(f.approveAllocation).mock.calls.length).toBe(approvalCalls);
      },
    );

    it('pins the domain actor before approval entry but allows a later transaction under a new authorized actor', async () => {
      const f = await setup();
      const prepared = await f.prepareExisting();
      const input = {
        ...action('domain-actor-before-approval-entry'),
        ...(await f.packet('apply-success')),
      };
      const before = await databaseRows(f);
      const beforeMoney = await money(f);
      const protectedHolds = await holds(f);
      const approvalCalls = vi.mocked(f.approveAllocation).mock.calls.length;
      const client = await f.engine.pool.connect();
      const actualQuery = client.query;
      let switched = false;
      // This is the domain's idempotency read, after its locked-workspace staff
      // authorization and before allocation-hook entry. Gate the real read's
      // completion, never a fixed authorize call count or a fabricated DB result.
      const boundaryQuery = function (this: PoolClient, ...args: unknown[]) {
        const pending = Reflect.apply(actualQuery, this, args);
        const statement = args[0];
        const text =
          typeof statement === 'string'
            ? statement
            : statement && typeof statement === 'object' && 'text' in statement
              ? String(statement.text)
              : '';
        const values = Array.isArray(args[1]) ? args[1] : [];
        if (
          !switched &&
          /^\s*SELECT\b/i.test(text) &&
          text.includes('mr_staff_refund_audit') &&
          values.includes(input.reference)
        ) {
          return Promise.resolve(pending).then((value) => {
            switched = true;
            f.state.actorId = 'fixture-domain-staff-B';
            return value;
          });
        }
        return pending;
      } as typeof client.query;
      const boundary = vi.spyOn(client, 'query').mockImplementation(boundaryQuery);
      client.release();
      let result: { error?: unknown; value?: unknown };
      try {
        result = await f.controller.applyExisting(prepared.id, input, f.context).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      } finally {
        boundary.mockRestore();
      }
      expect(switched).toBe(true);
      expect(result).toMatchObject({
        error: { code: 'staff_refund_authority_required', statusCode: 403 },
      });
      expect(vi.mocked(f.approveAllocation).mock.calls.length).toBe(approvalCalls);
      expect(await databaseRows(f)).toEqual(before);
      expect(await money(f)).toEqual(beforeMoney);
      expect(await holds(f)).toEqual(protectedHolds);

      // Actor pinning is per domain transaction, not a global controller identity.
      // A new, independently approved operation may legitimately be executed by B.
      const next = {
        ...action('new-authorized-actor-B-transaction'),
        ...(await f.packet('apply-success')),
      };
      await f.controller.applyExisting(prepared.id, next, f.context);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 0,
        reservedMicros: 0,
      });
      expect(
        (
          await f.engine.pool.query(
            "SELECT actor->>'id' AS actor FROM mr_staff_refund_audit WHERE case_id=$1 AND action='apply-success'",
            [prepared.id],
          )
        ).rows,
      ).toEqual([{ actor: 'fixture-domain-staff-B' }]);
      expect(
        (await money(f)).ledger.filter(
          (row) => row.reference === `staff-refund:${prepared.id}:debit`,
        ),
      ).toHaveLength(1);
      expect(await holds(f)).toEqual(protectedHolds);
    });

    it('snapshots constructor configuration and ignores event metadata instead of redirecting the pinned target', async () => {
      const f = await setup();
      const delivered = f.delivery({
        metadata: { workspaceId: 'forged-workspace', orderId: randomUUID(), refundId: 're_forged' },
      });
      f.target.workspaceId = 'changed-after-construction';
      f.target.refundId = 're_changed_after_construction';
      f.target.eligibleMicros = 1;
      f.config.webhookSecret = 'changed-after-construction-secret';
      const report = await f.controller.rehearse(delivered, f.context);
      expect(report.target).toEqual(f.expected);
      expect(report.processor.kind).toBe('refund');
      expect(Object.isFrozen(report.target)).toBe(true);
      const prepared = await f.prepareExisting(delivered);
      expect(prepared).toMatchObject({
        workspaceId: f.expected.workspaceId,
        orderId: f.expected.orderId,
        refundId: f.expected.refundId,
        eligibleMicros: 5_000_000,
      });
      f.state.authorized = false;
      f.config.authorize = async () => ({
        id: 'bypass-replacement-hook',
        kind: 'installation-operator',
      });
      await expect(f.controller.review(f.context)).rejects.toMatchObject({
        code: 'staff_refund_authority_required',
      });
    });

    it('supports authorized read-only configuration without installing money authority or a public route', async () => {
      const f = await setup({ approval: false });
      const before = await money(f);
      expect((await f.controller.rehearse(f.delivery(), f.context)).applyAllowed).toBe(false);
      await expect(f.prepareExisting()).rejects.toMatchObject({
        code: 'staff_refund_allocation_unapproved',
      });
      expect(await money(f)).toEqual(before);
      const app = await buildApp({
        engine: f.engine,
        env: {},
        workspaceId: f.workspaceId,
        publicUrl: f.engine.mcpOAuth.issuer,
      });
      try {
        await app.ready();
        expect(app.printRoutes()).not.toContain('staff-refund');
        expect(app.printRoutes()).not.toContain('refunds/existing');
      } finally {
        await app.close();
      }
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

describe.skipIf(!testDatabase || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native existing-refund controller serialization',
  () => {
    it('uses independent sessions for concurrent explicit apply with one debit and no hold resolution', async () => {
      const f = await setup();
      const prepared = await f.prepareExisting();
      const input = {
        ...action('native-controller-one-debit'),
        ...(await f.packet('apply-success')),
      };
      const secondPool = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
      const observer = new Pool({ connectionString: f.database.databaseUrl, max: 1 });
      extraPools.push(secondPool, observer);
      const second = new ExistingStaffRefundController(secondPool, f.config);
      const [a, b] = await Promise.all([
        f.engine.pool.query('SELECT pg_backend_pid() AS pid'),
        secondPool.query('SELECT pg_backend_pid() AS pid'),
      ]);
      expect(a.rows[0].pid).not.toBe(b.rows[0].pid);
      const held = latch(),
        release = latch();
      let gated = false;
      f.control.beforeApplyApproval = async () => {
        if (gated) return;
        gated = true;
        held.release();
        await release.promise;
      };
      const first = f.controller.applyExisting(prepared.id, input, f.context);
      let replay: Promise<unknown> | undefined;
      try {
        await Promise.race([
          held.promise,
          first.then(() => {
            throw new Error('Expected the native money-lock gate.');
          }),
        ]);
        replay = second.applyExisting(prepared.id, input, f.context);
        // Attach a rejection handler before waiting on the independent backend.
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
          await delay(20);
        }
        expect(blocked).toBe(true);
        release.release();
        expect(await first).toMatchObject({ financialState: 'debited' });
        expect(await replay).toMatchObject({ financialState: 'debited' });
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 0,
          reservedMicros: 0,
        });
        expect(
          (await money(f)).ledger.filter(
            (row) => row.reference === `staff-refund:${prepared.id}:debit`,
          ),
        ).toHaveLength(1);
        expect((await holds(f)).every((hold) => hold.resolved_at === null)).toBe(true);
      } finally {
        release.release();
        await Promise.allSettled([first, ...(replay ? [replay] : [])]);
      }
    });
  },
);
