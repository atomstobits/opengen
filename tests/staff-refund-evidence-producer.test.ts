import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStaffRefundEvidenceProducer,
  type StaffRefundEvidenceProducerOptions,
} from '../apps/server/src/staff-refund-evidence-producer.js';
import {
  assertVerifiedStaffRefundEvidence,
  type StaffRefundPaymentBinding,
} from '../packages/engine/src/staff-refund-evidence.js';

const environment = { id: 'fixture-refund-sandbox', accountId: 'acct_fixture', livemode: false };
const payment: StaffRefundPaymentBinding = {
  workspaceId: 'workspace_fixture',
  orderId: 'order_fixture',
  processorEnvironmentId: environment.id,
  processorAccountId: environment.accountId,
  livemode: false,
  paymentIntentId: 'pi_fixture',
  chargeId: 'ch_fixture',
  amountCents: 1000,
  currency: 'USD',
};
const refundId = 're_fixture_existing';
const secret = 'synthetic-refund-producer-signing-secret';
const now = new Date('2026-11-09T12:00:00Z');
const target = () => ({ payment: { ...payment }, refundId });
function fixture(overrides: Partial<StaffRefundEvidenceProducerOptions> = {}) {
  const assertProcessorEnvironment = vi.fn();
  const options: StaffRefundEvidenceProducerOptions = {
    activation: 'sandbox',
    processorEnvironment: { ...environment },
    processorTransport: {
      processorEnvironment: { ...environment },
      assertProcessorEnvironment,
    },
    webhookSecret: secret,
    ...overrides,
  };
  return {
    producer: createStaffRefundEvidenceProducer(options),
    options,
    assertProcessorEnvironment,
  };
}
function rawEvent(
  object: Record<string, unknown> = {},
  event: Record<string, unknown> = {},
): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        object: 'event',
        id: 'evt_fixture_refund',
        type: 'refund.updated',
        created: Math.floor(now.getTime() / 1000) - 86400,
        livemode: false,
        data: {
          object: {
            object: 'refund',
            id: refundId,
            payment_intent: payment.paymentIntentId,
            charge: payment.chargeId,
            amount: 250,
            currency: 'usd',
            status: 'succeeded',
            ...object,
          },
        },
        ...event,
      },
      null,
      2,
    ) + '\n',
  );
}
function signed(
  rawBody: Buffer,
  timestamp = Math.floor(Date.now() / 1000),
  signingSecret = secret,
) {
  return {
    rawBody,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload: rawBody.toString('utf8'),
      secret: signingSecret,
      timestamp,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('internal sandbox raw-signature staff refund evidence producer', () => {
  it('returns the original sealed partial-refund evidence from exact signed bytes and an owned target', () => {
    const { producer } = fixture();
    const bound = target();
    const result = producer.verifyRaw(
      signed(
        rawEvent({
          metadata: { order_id: 'foreign-order', payer_email: 'private@example.invalid' },
          payment_method_details: { type: 'us_bank_account' },
        }),
      ),
      bound,
    );
    expect(result.kind).toBe('refund');
    if (result.kind !== 'refund') throw new Error('Expected synthetic signed refund.');
    expect(result.evidence).toMatchObject({
      workspaceId: payment.workspaceId,
      orderId: payment.orderId,
      processorEnvironmentId: environment.id,
      processorAccountId: environment.accountId,
      livemode: false,
      paymentIntentId: payment.paymentIntentId,
      chargeId: payment.chargeId,
      refundId,
      amountCents: 250,
      currency: 'USD',
      status: 'succeeded',
    });
    expect(() => assertVerifiedStaffRefundEvidence(result.evidence)).not.toThrow();
    expect(() => assertVerifiedStaffRefundEvidence({ ...result.evidence })).toThrow();
    expect(() =>
      assertVerifiedStaffRefundEvidence(JSON.parse(JSON.stringify(result.evidence))),
    ).toThrow();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    bound.payment.paymentIntentId = 'pi_mutated';
    expect(result.evidence.paymentIntentId).toBe(payment.paymentIntentId);
    expect(JSON.stringify(result.evidence)).not.toContain('private@example.invalid');
    expect(result.evidence).not.toHaveProperty('bankReceived');
  });

  it('accepts a fresh redelivery of an old event without changing its event time or fingerprint', () => {
    const { producer } = fixture();
    const raw = rawEvent({}, { created: 1600000000 });
    const first = producer.verifyRaw(signed(raw), target());
    vi.setSystemTime(now.getTime() + 3600_000);
    const replay = producer.verifyRaw(signed(raw), target());
    expect(first.kind).toBe('refund');
    expect(replay).toEqual(first);
    if (first.kind !== 'refund' || replay.kind !== 'refund') throw new Error('Expected evidence.');
    expect(first.evidence.eventCreated).toBe(1600000000);
    expect(replay.evidence.payloadFingerprint).toBe(first.evidence.payloadFingerprint);
    expect(() => assertVerifiedStaffRefundEvidence(replay.evidence)).not.toThrow();
  });

  it.each(['refund.created', 'refund.updated', 'refund.failed'])(
    'accepts the supported individual %s event without issuing anything',
    (type) => {
      const { producer } = fixture();
      const result = producer.verifyRaw(
        signed(rawEvent({ status: type === 'refund.failed' ? 'failed' : 'pending' }, { type })),
        target(),
      );
      expect(result).toMatchObject({ kind: 'refund', evidence: { eventType: type, refundId } });
    },
  );

  it.each([
    ['pending', 'pending'],
    ['requires_action', 'pending'],
    ['succeeded', 'succeeded'],
    ['failed', 'failed'],
    ['canceled', 'failed'],
  ])(
    'keeps processor %s distinct from bank receipt or financial reconciliation',
    (status, normalized) => {
      const result = fixture().producer.verifyRaw(signed(rawEvent({ status })), target());
      expect(result).toMatchObject({
        kind: 'refund',
        evidence: {
          processorStatus: status,
          status: normalized,
          definitiveFailureBalanceReturned: false,
        },
      });
    },
  );

  it('retains signed failed-balance-return evidence without performing restoration', () => {
    const result = fixture().producer.verifyRaw(
      signed(rawEvent({ status: 'failed', failure_balance_transaction: 'txn_fixture_returned' })),
      target(),
    );
    expect(result).toMatchObject({
      kind: 'refund',
      evidence: {
        status: 'failed',
        failureBalanceTransactionId: 'txn_fixture_returned',
        definitiveFailureBalanceReturned: true,
      },
    });
  });

  it('requires explicit matching mode activation and safe bootstrap configuration', () => {
    for (const activation of [undefined, 'manual', 'fixture']) {
      expect(() => fixture({ activation: activation as 'sandbox' })).toThrow(
        'verified matching configuration',
      );
    }
    for (const webhookSecret of ['', ' ', 'secret\nvalue', 'a'.repeat(4097)]) {
      expect(() => fixture({ webhookSecret })).toThrow('verified matching configuration');
    }
    for (const patch of [{ id: 'foreign' }, { accountId: 'acct_foreign' }, { livemode: true }]) {
      expect(() => fixture({ processorEnvironment: { ...environment, ...patch } })).toThrow(
        'verified matching configuration',
      );
    }
    const sensitiveError = `${secret}: private bootstrap failure`;
    expect(() =>
      fixture({
        processorTransport: {
          processorEnvironment: environment,
          assertProcessorEnvironment() {
            throw new Error(sensitiveError);
          },
        },
      }),
    ).toThrow('verified matching configuration');
    try {
      fixture({ webhookSecret: secret + '\n' });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rechecks the proof on every call and ignores later mutation of the trusted options object', () => {
    const f = fixture();
    f.options.activation = undefined;
    f.options.webhookSecret = 'mutated-untrusted-secret';
    f.options.processorEnvironment.accountId = 'acct_mutated';
    expect(f.producer.verifyRaw(signed(rawEvent()), target()).kind).toBe('refund');
    f.assertProcessorEnvironment.mockImplementation(() => {
      throw new Error(secret);
    });
    expect(f.producer.verifyRaw(signed(rawEvent()), target())).toEqual({
      kind: 'review',
      reason: 'processor_environment_unverified',
    });
  });

  it('rejects changed bytes, unsigned JSON, wrong signing keys and reserialized payloads', () => {
    const { producer } = fixture();
    const input = signed(rawEvent());
    for (const invalid of [
      { ...input, rawBody: Buffer.concat([input.rawBody, Buffer.from(' ')]) },
      { ...input, rawBody: Buffer.from(JSON.stringify(JSON.parse(input.rawBody.toString()))) },
      signed(rawEvent(), undefined, 'different-synthetic-secret'),
      { ...input, signature: '' },
      { ...input, signature: input.signature.replace(/v1=.+$/, 'v1=00') },
    ]) {
      expect(producer.verifyRaw(invalid, target()).kind).toBe('review');
    }
    expect(
      producer.verifyRaw(
        { rawBody: JSON.parse(input.rawBody.toString()), signature: input.signature } as never,
        target(),
      ).kind,
    ).toBe('review');
    expect(
      producer.verifyRaw({ rawBody: Buffer.alloc(1_000_001), signature: input.signature }, target())
        .kind,
    ).toBe('review');
    expect(producer.verifyRaw({ ...input, signature: 'x'.repeat(4097) }, target()).kind).toBe(
      'review',
    );
  });

  it.each([-301, 301])(
    'refuses delivery timestamp skew of %s seconds even with a valid HMAC',
    (skew) => {
      const result = fixture().producer.verifyRaw(
        signed(rawEvent(), Math.floor(Date.now() / 1000) + skew),
        target(),
      );
      expect(result).toEqual({ kind: 'review', reason: 'signature_timestamp_out_of_range' });
    },
  );
  it.each([-300, 300])('accepts the fixed delivery timestamp boundary of %s seconds', (skew) => {
    expect(
      fixture().producer.verifyRaw(
        signed(rawEvent(), Math.floor(Date.now() / 1000) + skew),
        target(),
      ).kind,
    ).toBe('refund');
  });
  it.each(['duplicate', 'fractional', 'suffix', 'negative', 'unsafe', 'space', 'missing'])(
    'refuses a %s delivery timestamp instead of loosening SDK tolerance',
    (variant) => {
      const input = signed(rawEvent());
      const t = Math.floor(Date.now() / 1000);
      const timestamps: Record<string, string> = {
        duplicate: `t=${t},t=${t}`,
        fractional: `t=${t}.5`,
        suffix: `t=${t}junk`,
        negative: `t=-${t}`,
        unsafe: 't=9007199254740993',
        space: `t= ${t}`,
        missing: '',
      };
      input.signature = `${timestamps[variant]},${input.signature
        .split(',')
        .filter((part) => !part.startsWith('t='))
        .join(',')}`;
      expect(fixture().producer.verifyRaw(input, target()).kind).toBe('review');
    },
  );

  it.each([
    { livemode: true },
    { account: environment.accountId },
    { account: 'acct_foreign' },
    { context: 'ctx_foreign' },
    { context: '' },
  ])('rejects signed events outside the own-account test namespace: %j', (patch) => {
    expect(fixture().producer.verifyRaw(signed(rawEvent({}, patch)), target()).kind).toBe('review');
  });

  it.each([
    { id: 're_foreign' },
    { payment_intent: 'pi_foreign' },
    { charge: 'ch_foreign' },
    { livemode: true },
    { currency: 'eur' },
    { amount: 0 },
    { amount: 250.5 },
    { amount: 1001 },
    { status: undefined },
    { status: 'unknown' },
  ])('rejects signed refund identity, money or state mismatch: %j', (patch) => {
    expect(fixture().producer.verifyRaw(signed(rawEvent(patch)), target()).kind).toBe('review');
  });

  it.each([
    { processorEnvironmentId: 'foreign-environment' },
    { processorAccountId: 'acct_foreign' },
    { livemode: true },
    { workspaceId: '' },
    { orderId: '' },
    { paymentIntentId: 'pi_foreign' },
    { chargeId: 'ch_foreign' },
    { amountCents: 0 },
    { currency: 'EUR' },
  ])('rejects an incompatible canonical target binding: %j', (patch) => {
    const bound = target();
    Object.assign(bound.payment, patch);
    expect(fixture().producer.verifyRaw(signed(rawEvent()), bound).kind).toBe('review');
  });

  it('does not take refund, workspace or processor ownership from signed metadata', () => {
    const raw = rawEvent({
      metadata: {
        refund_id: refundId,
        payment_intent: payment.paymentIntentId,
        workspace_id: payment.workspaceId,
      },
    });
    expect(
      fixture().producer.verifyRaw(signed(raw), { ...target(), refundId: 're_other_selected' }),
    ).toEqual({ kind: 'review', reason: 'refund_identity_mismatch' });
    expect(
      fixture().producer.verifyRaw(
        signed(
          rawEvent({
            payment_intent: 'pi_foreign',
            metadata: { payment_intent: payment.paymentIntentId },
          }),
        ),
        target(),
      ).kind,
    ).toBe('review');
  });

  it('keeps aggregate charge evidence and unsupported events outside individual refund reconciliation', () => {
    for (const type of ['charge.refunded', 'payment_intent.succeeded', 'invoice.paid']) {
      const result = fixture().producer.verifyRaw(signed(rawEvent({}, { type })), target());
      expect(result.kind).toBe('review');
      expect(() => assertVerifiedStaffRefundEvidence(result)).toThrow();
    }
  });
});
