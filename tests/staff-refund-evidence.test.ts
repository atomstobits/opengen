import { describe, expect, it } from 'vitest';
import {
  assertVerifiedStaffChargeEvidence,
  assertVerifiedStaffRefundEvidence,
  normalizeStaffRefundEvidence,
  type StaffRefundPaymentBinding,
  type VerifiedProcessorEvent,
  type VerifiedStaffRefundEvidence,
} from '../packages/engine/src/staff-refund-evidence.js';

const environment = { id: 'fixture-stripe', accountId: 'acct_fixture', livemode: false };
const original: StaffRefundPaymentBinding = {
  workspaceId: 'workspace_fixture',
  orderId: 'order_fixture',
  processorEnvironmentId: environment.id,
  processorAccountId: environment.accountId,
  livemode: false,
  paymentIntentId: 'pi_fixture',
  chargeId: null,
  amountCents: 1000,
  currency: 'USD',
};
/** Synthetic, trusted-verifier-boundary fixture only. No signature, key, real
 * processor payload or network client is manufactured by these unit tests. */
function verifiedFixture(
  object: Record<string, unknown> = {},
  event: Partial<VerifiedProcessorEvent> = {},
): VerifiedProcessorEvent {
  return {
    id: 'evt_fixture',
    type: 'refund.updated',
    created: 1800000000,
    livemode: false,
    processorEnvironment: { ...environment },
    data: {
      object: {
        object: 'refund',
        id: 're_fixture',
        payment_intent: 'pi_fixture',
        charge: 'ch_fixture',
        amount: 250,
        currency: 'usd',
        status: 'succeeded',
        ...object,
      },
    },
    ...event,
  };
}
function refund(
  event = verifiedFixture(),
  binding: StaffRefundPaymentBinding = original,
): VerifiedStaffRefundEvidence {
  const result = normalizeStaffRefundEvidence(event, environment, binding);
  expect(result.kind).toBe('refund');
  if (result.kind !== 'refund') throw new Error('Expected synthetic refund evidence.');
  return result.evidence;
}
function chargeFixture(object: Record<string, unknown> = {}): VerifiedProcessorEvent {
  return verifiedFixture(
    {},
    {
      type: 'charge.refunded',
      data: {
        object: {
          object: 'charge',
          id: 'ch_fixture',
          payment_intent: 'pi_fixture',
          amount: 1000,
          amount_refunded: 250,
          currency: 'usd',
          payment_method_details: { type: 'us_bank_account' },
          ...object,
        },
      },
    },
  );
}

describe('staff refund processor evidence at the already-verified ingress boundary', () => {
  it('minimizes, freezes and seals a partial refund against the original owned payment', () => {
    const evidence = refund(
      verifiedFixture({
        metadata: {
          order_id: 'untrusted-other-order',
          payer_email: 'not-retained@example.invalid',
        },
      }),
    );
    expect(evidence).toMatchObject({
      kind: 'refund',
      workspaceId: original.workspaceId,
      orderId: original.orderId,
      processorEnvironmentId: environment.id,
      processorAccountId: environment.accountId,
      livemode: false,
      paymentIntentId: 'pi_fixture',
      chargeId: 'ch_fixture',
      refundId: 're_fixture',
      amountCents: 250,
      currency: 'USD',
      status: 'succeeded',
      processorStatus: 'succeeded',
      eventId: 'evt_fixture',
      eventType: 'refund.updated',
      eventCreated: 1800000000,
      observedAt: '2027-01-15T08:00:00.000Z',
      evidenceReference: 'stripe-event:evt_fixture',
      failureBalanceTransactionId: null,
      definitiveFailureBalanceReturned: false,
    });
    expect(evidence.payloadFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(() => assertVerifiedStaffRefundEvidence(evidence)).not.toThrow();
    expect(JSON.stringify(evidence)).not.toContain('not-retained');
    expect(evidence).not.toHaveProperty('metadata');
    expect(evidence).not.toHaveProperty('bankReceived');
  });
  it('accepts explicit expanded references without treating metadata as ownership', () => {
    const evidence = refund(
      verifiedFixture({
        payment_intent: { id: 'pi_fixture' },
        charge: { id: 'ch_fixture' },
      }),
      { ...original, chargeId: 'ch_fixture' },
    );
    expect(evidence.chargeId).toBe('ch_fixture');
    expect(evidence.paymentIntentId).toBe('pi_fixture');
    expect(
      normalizeStaffRefundEvidence(
        verifiedFixture({
          payment_intent: 'pi_foreign',
          metadata: { payment_intent: 'pi_fixture', order_id: original.orderId },
        }),
        environment,
        original,
      ),
    ).toEqual({ kind: 'review', reason: 'payment_intent_mismatch' });
  });
  it.each([
    ['pending', 'pending'],
    ['requires_action', 'pending'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
  ] as const)('maps %s as processor state only, keeping the raw state', (raw, expected) => {
    const evidence = refund(verifiedFixture({ status: raw }));
    expect(evidence.status).toBe(expected);
    expect(evidence.processorStatus).toBe(raw);
    expect(evidence.definitiveFailureBalanceReturned).toBe(false);
  });
  it.each(['failed', 'canceled'] as const)(
    'requires signed failure balance-transaction identity for %s restoration evidence',
    (status) => {
      const noReturn = refund(verifiedFixture({ status, balance_transaction: 'txn_original' }));
      expect(noReturn.definitiveFailureBalanceReturned).toBe(false);
      const returned = refund(
        verifiedFixture({ status, failure_balance_transaction: { id: 'txn_returned' } }),
      );
      expect(returned.failureBalanceTransactionId).toBe('txn_returned');
      expect(returned.definitiveFailureBalanceReturned).toBe(true);
    },
  );
  it.each(['pending', 'requires_action', 'succeeded'] as const)(
    'never treats failure balance-transaction presence alone as a %s failure',
    (status) => {
      expect(
        refund(verifiedFixture({ status, failure_balance_transaction: 'txn_returned' }))
          .definitiveFailureBalanceReturned,
      ).toBe(false);
    },
  );
  it('does not infer returned balance from refund.failed or a failure reason', () => {
    const event = verifiedFixture(
      { status: 'failed', failure_reason: 'declined' },
      { type: 'refund.failed' },
    );
    expect(refund(event).definitiveFailureBalanceReturned).toBe(false);
    expect(
      normalizeStaffRefundEvidence(
        verifiedFixture({ status: 'succeeded' }, { type: 'refund.failed' }),
        environment,
        original,
      ),
    ).toEqual({ kind: 'review', reason: 'refund_event_status_conflict' });
    expect(
      normalizeStaffRefundEvidence(
        verifiedFixture({ status: 'failed', failure_balance_transaction: 'not-a-transaction' }),
        environment,
        original,
      ),
    ).toEqual({ kind: 'review', reason: 'invalid_failure_balance_transaction' });
  });
  it.each([undefined, null, '', 'unknown_future_status'])(
    'keeps missing/unknown status %s in review',
    (status) => {
      expect(
        normalizeStaffRefundEvidence(verifiedFixture({ status }), environment, original),
      ).toEqual({ kind: 'review', reason: 'missing_or_unknown_refund_status' });
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, '250', Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-positive/non-integer processor amount %s',
    (amount) => {
      expect(
        normalizeStaffRefundEvidence(verifiedFixture({ amount }), environment, original),
      ).toEqual({ kind: 'review', reason: 'invalid_processor_amount' });
    },
  );
  it('permits positive partial cents and the original principal, but not over-refunding it', () => {
    expect(refund(verifiedFixture({ amount: 1 })).amountCents).toBe(1);
    expect(refund(verifiedFixture({ amount: 1000 })).amountCents).toBe(1000);
    expect(
      normalizeStaffRefundEvidence(verifiedFixture({ amount: 1001 }), environment, original),
    ).toEqual({ kind: 'review', reason: 'refund_exceeds_original_payment' });
  });
  it.each([
    [{ payment_intent: undefined }, 'missing_payment_intent'],
    [{ payment_intent: 'pi_other' }, 'payment_intent_mismatch'],
    [{ charge: undefined }, 'missing_charge_identity'],
    [{ charge: 'pi_fixture' }, 'missing_charge_identity'],
    [{ id: undefined }, 'missing_refund_identity'],
    [{ id: 'ch_fixture' }, 'missing_refund_identity'],
    [{ currency: 'eur' }, 'currency_mismatch'],
    [{ currency: 'USD' }, 'currency_mismatch'],
    [{ livemode: true }, 'processor_object_mode_mismatch'],
    [{ object: 'charge' }, 'processor_object_kind_mismatch'],
  ] as const)('reviews invalid original-payment/refund identity %j', (patch, reason) => {
    expect(normalizeStaffRefundEvidence(verifiedFixture(patch), environment, original)).toEqual({
      kind: 'review',
      reason,
    });
  });
  it('requires a known original Charge to match but can establish it from a matching signed Refund', () => {
    expect(refund().chargeId).toBe('ch_fixture');
    expect(
      normalizeStaffRefundEvidence(verifiedFixture(), environment, {
        ...original,
        chargeId: 'ch_other',
      }),
    ).toEqual({ kind: 'review', reason: 'charge_mismatch' });
  });
  it.each([
    { workspaceId: undefined },
    { orderId: undefined },
    { amountCents: 0 },
    { amountCents: -1 },
    { currency: 'usd' },
    { paymentIntentId: 'ch_fixture' },
    { chargeId: 're_fixture' },
    { processorEnvironmentId: 'other' },
    { processorAccountId: 'acct_other' },
    { livemode: true },
  ])('rejects malformed/foreign canonical store binding %j', (patch) => {
    expect(
      normalizeStaffRefundEvidence(verifiedFixture(), environment, {
        ...original,
        ...patch,
      } as never),
    ).toEqual({ kind: 'review', reason: 'invalid_original_payment_binding' });
  });
  it.each([{ id: undefined }, { accountId: 'invalid' }, { livemode: undefined }])(
    'rejects malformed trusted configuration %j',
    (patch) => {
      expect(
        normalizeStaffRefundEvidence(
          verifiedFixture(),
          { ...environment, ...patch } as never,
          original,
        ),
      ).toEqual({ kind: 'review', reason: 'invalid_trusted_environment' });
    },
  );
  it.each([
    { processorEnvironment: { ...environment, id: 'other' } },
    { processorEnvironment: { ...environment, accountId: 'acct_other' } },
    { processorEnvironment: { ...environment, livemode: true } },
    { processorEnvironment: undefined },
    { livemode: true },
  ])('reviews foreign/missing verified context %j', (patch) => {
    expect(
      normalizeStaffRefundEvidence(verifiedFixture({}, patch as never), environment, original),
    ).toEqual({ kind: 'review', reason: 'processor_environment_mismatch' });
  });
  it.each([
    { account: 'acct_other' },
    { account: 'acct_fixture' },
    { context: 'organization-context' },
  ])('rejects unsupported account/context envelope %j', (patch) => {
    expect(normalizeStaffRefundEvidence(verifiedFixture({}, patch), environment, original)).toEqual(
      { kind: 'review', reason: 'unsupported_account_context' },
    );
  });
  it.each([
    { id: 'not-an-event' },
    { id: undefined },
    { created: 0 },
    { created: NaN },
    { created: '1800000000' },
  ])('reviews unusable event identity/time %j', (patch) => {
    expect(
      normalizeStaffRefundEvidence(verifiedFixture({}, patch as never), environment, original),
    ).toEqual({ kind: 'review', reason: 'invalid_event_identity_or_time' });
  });
  it('does not infer a refund from another event family', () => {
    expect(
      normalizeStaffRefundEvidence(
        verifiedFixture({}, { type: 'payment_intent.succeeded' }),
        environment,
        original,
      ),
    ).toEqual({ kind: 'review', reason: 'unsupported_processor_event' });
  });
  it('preserves three events as observations of one actual refund, without arrival-order state reduction', () => {
    const events = [
      verifiedFixture(
        { status: 'pending' },
        { id: 'evt_created', type: 'refund.created', created: 1800000000 },
      ),
      verifiedFixture({ status: 'succeeded' }, { id: 'evt_updated', created: 1800000002 }),
      verifiedFixture(
        { status: 'failed' },
        { id: 'evt_failed', type: 'refund.failed', created: 1800000001 },
      ),
    ];
    const evidence = events.map((e) => refund(e));
    expect(new Set(evidence.map((e) => `${e.processorEnvironmentId}/${e.refundId}`)).size).toBe(1);
    expect(new Set(evidence.map((e) => e.eventId)).size).toBe(3);
    expect(evidence.map((e) => e.eventCreated)).toEqual([1800000000, 1800000002, 1800000001]);
    expect(evidence.map((e) => e.status)).toEqual(['pending', 'succeeded', 'failed']);
  });
  it('fingerprints equivalent JSON key order identically, but retains changed-payload conflicts', () => {
    const first = verifiedFixture({ metadata: { z: 1, a: 2 } });
    const second = verifiedFixture({ metadata: { a: 2, z: 1 } });
    expect(refund(first).payloadFingerprint).toBe(refund(second).payloadFingerprint);
    expect(refund(first).payloadFingerprint).not.toBe(
      refund(verifiedFixture({ amount: 249 })).payloadFingerprint,
    );
    expect(refund(first).payloadFingerprint).not.toBe(
      refund(verifiedFixture({ status: 'failed' })).payloadFingerprint,
    );
    expect(refund(first).payloadFingerprint).toBe(
      refund(JSON.parse(JSON.stringify(first))).payloadFingerprint,
    );
  });
  it('rejects unusable JSON payload fingerprints without retaining the raw object', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      normalizeStaffRefundEvidence(verifiedFixture({ metadata: cyclic }), environment, original),
    ).toEqual({ kind: 'review', reason: 'unusable_payload_fingerprint' });
    expect(
      normalizeStaffRefundEvidence(
        verifiedFixture({ metadata: { unsupported: 1n } }),
        environment,
        original,
      ),
    ).toEqual({ kind: 'review', reason: 'unusable_payload_fingerprint' });
  });
  it('does not let plain JSON, a clone, frozen claims or another evidence kind manufacture success', () => {
    const evidence = refund();
    for (const claim of [
      null,
      undefined,
      42,
      {},
      { ...evidence },
      JSON.parse(JSON.stringify(evidence)),
      Object.freeze({ ...evidence }),
      Object.create(evidence),
    ]) {
      expect(() => assertVerifiedStaffRefundEvidence(claim)).toThrowError(
        expect.objectContaining({ code: 'staff_refund_evidence_unverified', statusCode: 403 }),
      );
    }
    const aggregate = normalizeStaffRefundEvidence(chargeFixture(), environment, original);
    expect(aggregate.kind).toBe('charge');
    if (aggregate.kind !== 'charge') throw new Error('Expected charge evidence.');
    expect(() => assertVerifiedStaffRefundEvidence(aggregate.evidence)).toThrow();
    expect(() => assertVerifiedStaffChargeEvidence(evidence)).toThrow();
  });
  it('keeps sealed evidence unchanged when its caller mutates fixture inputs later', () => {
    const event = verifiedFixture();
    const binding = { ...original };
    const evidence = refund(event, binding),
      fingerprint = evidence.payloadFingerprint;
    (event.data.object as Record<string, unknown>).status = 'failed';
    binding.workspaceId = 'changed';
    expect(evidence.status).toBe('succeeded');
    expect(evidence.workspaceId).toBe('workspace_fixture');
    expect(evidence.payloadFingerprint).toBe(fingerprint);
    expect(() => {
      (evidence as unknown as Record<string, unknown>).status = 'failed';
    }).toThrow();
    expect(() => assertVerifiedStaffRefundEvidence(evidence)).not.toThrow();
  });
});

describe('separate charge.refunded aggregate evidence', () => {
  it('validates original charge/PI/principal and never emits another individual refund', () => {
    const result = normalizeStaffRefundEvidence(
      chargeFixture({
        refunds: {
          data: [
            { id: 're_one', amount: 125 },
            { id: 're_two', amount: 125 },
          ],
        },
      }),
      environment,
      original,
    );
    expect(result.kind).toBe('charge');
    if (result.kind !== 'charge') throw new Error('Expected aggregate proof.');
    expect(result.evidence).toMatchObject({
      kind: 'charge',
      chargeId: 'ch_fixture',
      originalAmountCents: 1000,
      amountRefundedCents: 250,
      paymentMethodType: 'us_bank_account',
    });
    expect(result.evidence).not.toHaveProperty('refundId');
    expect(result.evidence).not.toHaveProperty('amountCents');
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(() => assertVerifiedStaffChargeEvidence(result.evidence)).not.toThrow();
    expect(() => assertVerifiedStaffChargeEvidence({ ...result.evidence })).toThrow();
  });
  it.each([undefined, null, -1, 1.5, 1001, '250'])(
    'reviews missing/invalid aggregate %s',
    (amount_refunded) => {
      expect(
        normalizeStaffRefundEvidence(chargeFixture({ amount_refunded }), environment, original),
      ).toEqual({ kind: 'review', reason: 'invalid_charge_refund_total' });
    },
  );
  it('requires the original charged amount, not the current refund amount', () => {
    expect(
      normalizeStaffRefundEvidence(chargeFixture({ amount: 250 }), environment, original),
    ).toEqual({ kind: 'review', reason: 'invalid_charge_refund_total' });
    expect(
      normalizeStaffRefundEvidence(chargeFixture({ amount_refunded: 0 }), environment, original)
        .kind,
    ).toBe('charge');
  });
  it('supports generic manual methods and only enforces a method when explicitly required', () => {
    expect(
      normalizeStaffRefundEvidence(
        chargeFixture({ payment_method_details: { type: 'card' } }),
        environment,
        original,
      ).kind,
    ).toBe('charge');
    expect(normalizeStaffRefundEvidence(chargeFixture(), environment, original).kind).toBe(
      'charge',
    );
    expect(
      normalizeStaffRefundEvidence(chargeFixture(), environment, {
        ...original,
        expectedPaymentMethodType: 'card',
      }),
    ).toEqual({ kind: 'review', reason: 'payment_method_proof_mismatch' });
    expect(
      normalizeStaffRefundEvidence(chargeFixture(), environment, {
        ...original,
        expectedPaymentMethodType: 'us_bank_account',
      }).kind,
    ).toBe('charge');
    expect(
      normalizeStaffRefundEvidence(verifiedFixture(), environment, {
        ...original,
        expectedPaymentMethodType: 'card',
      }),
    ).toEqual({ kind: 'review', reason: 'missing_original_method_binding' });
    expect(
      normalizeStaffRefundEvidence(verifiedFixture(), environment, {
        ...original,
        chargeId: 'ch_fixture',
        expectedPaymentMethodType: 'card',
      }).kind,
    ).toBe('refund');
  });
});
