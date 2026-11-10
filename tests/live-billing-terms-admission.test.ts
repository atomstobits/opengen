/** LIVE-shaped LOCAL source qualification only. Identity, assent, processor and
 * money fixtures are synthetic; no sign-in, hosted database or Stripe request. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, type CheckoutSession, type Principal } from '@media-router/engine';
import {
  createBillingFixtureRuntime,
  type BillingFixtureRuntimeOptions,
} from '../apps/server/src/billing-runtime.js';
import { currentHumanTermsPolicy, type HumanTermsPolicy } from '../apps/server/src/terms-login.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import type { PaymentAuthority, PaymentTransport } from '../packages/engine/src/payments.js';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const external = vi.hoisted(() => ({
  request: vi.fn(() => {
    throw new Error('Live Terms local fixtures forbid HTTPS requests.');
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
  throw new Error('Live Terms local fixtures forbid external fetch requests.');
});
beforeEach(() => vi.stubGlobal('fetch', noNetwork));
afterEach(() => {
  try {
    expect(noNetwork).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  } finally {
    noNetwork.mockClear();
    external.request.mockClear();
    vi.unstubAllGlobals();
  }
});

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) {
  const target = new URL(databaseUrl);
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    !/^\/(?:postgres|opengen_test|opengen_staff_refund_[a-z0-9_]+|opengen_core_qualification_[a-z0-9_]+)$/.test(
      target.pathname,
    ) ||
    target.search ||
    target.hash
  )
    throw new Error('Live Terms tests require an explicit loopback ephemeral fixture database.');
}
const activePolicy = (): HumanTermsPolicy => ({
  version: 'synthetic-live-terms-v1',
  digest: 'a'.repeat(64),
  status: 'active',
  effectiveAt: '2020-01-01T00:00:00.000Z',
});
const rails = {
  allowsEnabled: false,
  maxThresholdMicros: 10_000_000,
  maxAmountCents: 2500,
  maxMonthlyCapCents: 10000,
  maxAttemptsPerMonth: 4,
  minCooldownSeconds: 86400,
  maxFailureLimit: 3,
};

async function fixture(livemode = true) {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'live_terms');
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      poolSize: 1,
      providerEnv: {},
      adapters: [],
      providerExecutionEnabled: false,
    }),
  );
  const close = async () => {
    try {
      await engine.close();
    } finally {
      await isolated.close();
    }
  };
  try {
    await engine.initialize();
    const identity = await engine.accounts.identity(
      'https://identity.fixture.invalid/live-terms',
      `synthetic-person-${randomUUID()}`,
    );
    const cookie = await engine.accounts.createSession(identity);
    const browser = (await engine.accounts.session(cookie))!;
    const workspaceId = browser.workspaceId;
    const environment = { id: 'local-live-terms', accountId: 'acct_localfixture', livemode };
    await registerBillingProcessorEnvironmentInTransaction(engine.pool, environment);
    await engine.pool.query(
      `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
       processor_environment_id,livemode,rails,consent_reference,approval_reference)
       SELECT workspace_id,id,extract(epoch FROM accepted_at)::text,1,$3,$4,$5,
         'synthetic-owner-consent','synthetic-owner-approval' FROM mr_memberships
       WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, browser.membershipId, environment.id, livemode, JSON.stringify(rails)],
    );
    const proof = { processorEnvironment: environment, assertProcessorEnvironment() {} };
    let session: CheckoutSession;
    const createSession = vi.fn<PaymentTransport['createSession']>(
      async (order) =>
        (session = {
          id: `cs_local_${order.id.replaceAll('-', '')}`,
          mode: 'payment',
          currency: 'usd',
          amount_subtotal: order.amountCents,
          amount_total: order.amountCents,
          payment_status: 'unpaid',
          status: 'open',
          client_reference_id: order.id,
          payment_intent: null,
          livemode,
          url: 'https://checkout.stripe.com/c/pay/local_fixture',
        }),
    );
    const retrieveSession = vi.fn(async () => session);
    const unexpected = vi.fn(async () => {
      throw new Error('Unexpected synthetic processor operation.');
    });
    let policy = activePolicy();
    const config: BillingFixtureRuntimeOptions = {
      activation: livemode ? 'manual' : 'fixture',
      processorEnvironment: environment,
      checkoutWritesEnabled: true,
      terms: { version: 'separate-funding-approval', text: 'Synthetic funding approval.' },
      humanTermsPolicy: () => policy,
      webhookSecret: 'local-synthetic-signing-secret',
      webhookVerifier: {
        constructEvent: () => {
          throw new Error('Unexpected local webhook signature verification.');
        },
      },
      manualTransport: { ...proof, createSession, retrieveSession },
      customerTransport: {
        ...proof,
        createCustomer: unexpected,
        retrieveCustomer: unexpected,
        createSetup: unexpected,
        retrieveSetup: unexpected,
        retrieveSetupIntent: unexpected,
        retrievePaymentMethod: unexpected,
        createPortal: unexpected,
        listDocuments: unexpected,
      },
      rechargeTransport: { ...proof, createRecharge: unexpected, retrieveRecharge: unexpected },
    };
    const runtime = createBillingFixtureRuntime(engine.pool, config);
    const receipt = async (
      override: Partial<{
        issuer: string;
        subject: string;
        policyVersion: string;
        policyDigest: string;
      }> = {},
    ) =>
      new TermsReceiptStore(engine.pool).recordVerifiedAcceptance({
        issuer: browser.identity!.issuer,
        subject: browser.identity!.subject,
        policyVersion: policy.version,
        policyDigest: policy.digest,
        ...override,
      });
    const create = async (key = 'local-terms-new-order') =>
      runtime.payments.store!.createOrder(
        workspaceId,
        2500,
        key,
        await runtime.payments.scoped!.authorize(browser, 'mutate'),
      );
    const checkout = async (id: string) =>
      runtime.payments.store!.checkout(
        workspaceId,
        id,
        config.manualTransport,
        await runtime.payments.scoped!.authorize(browser, 'mutate'),
      );
    const access = () => runtime.payments.scoped!.access(browser);
    return {
      engine,
      browser,
      workspaceId,
      environment,
      config,
      runtime,
      receipt,
      create,
      checkout,
      access,
      createSession,
      retrieveSession,
      close,
      setPolicy: (value: HumanTermsPolicy) => {
        policy = value;
      },
      paid: () =>
        (session = {
          ...session,
          status: 'complete',
          payment_status: 'paid',
          payment_intent: 'pi_local_terms_fixture',
        }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('current human Terms admission for new live funding', () => {
  it.each([
    'missing',
    'old version',
    'wrong digest',
    'other subject',
    'other issuer',
    'draft',
    'future',
  ] as const)(
    'denies %s assent without creating an order or dispatching Checkout',
    async (kind) => {
      const f = await fixture();
      try {
        if (kind !== 'missing')
          await f.receipt({
            ...(kind === 'old version' ? { policyVersion: 'synthetic-old-terms-v0' } : {}),
            ...(kind === 'wrong digest' ? { policyDigest: 'b'.repeat(64) } : {}),
            ...(kind === 'other subject'
              ? { subject: f.browser.identity!.subject.toUpperCase() }
              : {}),
            ...(kind === 'other issuer' ? { issuer: `${f.browser.identity!.issuer}/` } : {}),
          });
        if (kind === 'draft')
          f.setPolicy({ ...activePolicy(), status: 'draft', effectiveAt: null });
        if (kind === 'future')
          f.setPolicy({ ...activePolicy(), effectiveAt: '9999-01-01T00:00:00.000Z' });
        const inactive = kind === 'draft' || kind === 'future';
        expect(await f.access()).toMatchObject({
          read: true,
          manual: true,
          newFunding: { allowed: false, reason: inactive ? 'terms-inactive' : 'terms-required' },
        });
        await expect(f.create()).rejects.toMatchObject({
          code: inactive ? 'current_human_terms_inactive' : 'current_human_terms_required',
          statusCode: 403,
        });
        expect(
          (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_payment_orders')).rows[0].n,
        ).toBe(0);
        expect(f.createSession).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('matches exact verified human identity and current policy on the financial client before new funding', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      expect(await f.access()).toMatchObject({
        read: true,
        manual: true,
        newFunding: { allowed: true },
      });
      const order = await f.create();
      expect(await f.checkout(order.id)).toMatchObject({ id: order.id, status: 'checkout_open' });
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.createSession.mock.calls[0]![0]).toMatchObject({ id: order.id });
      expect(
        (
          await f.engine.pool.query('SELECT livemode FROM mr_payment_orders WHERE id=$1', [
            order.id,
          ])
        ).rows[0].livemode,
      ).toBe(true);
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(0);
      expect(
        (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('keeps the production policy draft closed even when a matching synthetic draft receipt exists', async () => {
    const f = await fixture();
    try {
      const draft = currentHumanTermsPolicy();
      expect(draft).toMatchObject({ status: 'draft', effectiveAt: null });
      await f.receipt({ policyVersion: draft.version, policyDigest: draft.digest });
      const runtime = createBillingFixtureRuntime(f.engine.pool, {
        ...f.config,
        humanTermsPolicy: undefined,
      });
      expect(await runtime.payments.scoped!.access(f.browser)).toMatchObject({
        read: true,
        manual: true,
        newFunding: { allowed: false, reason: 'terms-inactive' },
      });
      await expect(
        runtime.payments.store!.createOrder(
          f.workspaceId,
          2500,
          'default-draft-closed',
          await runtime.payments.scoped!.authorize(f.browser, 'mutate'),
        ),
      ).rejects.toMatchObject({ code: 'current_human_terms_inactive' });
      expect(f.createSession).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('preserves fixture/sandbox manual funding without adding a human Terms requirement', async () => {
    const f = await fixture(false);
    try {
      f.setPolicy({ ...activePolicy(), status: 'draft', effectiveAt: null });
      expect(await f.access()).toMatchObject({
        read: true,
        manual: true,
        newFunding: { allowed: true },
      });
      const order = await f.create();
      await f.checkout(order.id);
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(
        (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_terms_receipts')).rows[0].n,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });

  it('rechecks current assent at first Checkout while keeping an existing local order replay available', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      const order = await f.create();
      f.setPolicy({
        ...activePolicy(),
        version: 'synthetic-live-terms-v2',
        digest: 'b'.repeat(64),
      });
      expect(await f.create()).toMatchObject({ id: order.id });
      await expect(f.checkout(order.id)).rejects.toMatchObject({
        code: 'current_human_terms_required',
      });
      expect(f.createSession).not.toHaveBeenCalled();
      expect(
        (
          await f.engine.pool.query(
            'SELECT checkout_started_at FROM mr_payment_orders WHERE id=$1',
            [order.id],
          )
        ).rows[0].checkout_started_at,
      ).toBeNull();
      await f.receipt();
      await f.checkout(order.id);
      expect(f.createSession).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('recovers only the original uncertain Checkout request after current policy withdrawal', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      const order = await f.create();
      f.createSession.mockRejectedValueOnce(new Error('Synthetic unknown upstream acceptance.'));
      await expect(f.checkout(order.id)).rejects.toMatchObject({ code: 'checkout_uncertain' });
      f.setPolicy({ ...activePolicy(), status: 'draft', effectiveAt: null });
      expect(await f.access()).toMatchObject({
        read: true,
        manual: true,
        newFunding: { allowed: false, reason: 'terms-inactive' },
      });
      await f.engine.pool.query(
        "UPDATE mr_payment_orders SET checkout_next_request_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [order.id],
      );
      await f.checkout(order.id);
      expect(f.createSession).toHaveBeenCalledTimes(2);
      expect(f.createSession.mock.calls[0]![0].stripeIdempotencyKey).toBe(
        f.createSession.mock.calls[1]![0].stripeIdempotencyKey,
      );
      expect(f.createSession.mock.calls[0]![0].id).toBe(f.createSession.mock.calls[1]![0].id);
      expect(
        (await f.engine.pool.query('SELECT count(*)::int AS n FROM mr_payment_orders')).rows[0].n,
      ).toBe(1);
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(0);
      await expect(f.create('replacement-new-order')).rejects.toMatchObject({
        code: 'current_human_terms_inactive',
      });
    } finally {
      await f.close();
    }
  });

  it('preserves billing reads, known-session retrieval and exactly-once fulfillment after policy withdrawal', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      const order = await f.create();
      await f.checkout(order.id);
      f.setPolicy({ ...activePolicy(), status: 'draft', effectiveAt: null });
      expect(await f.access()).toMatchObject({
        read: true,
        manual: true,
        newFunding: { allowed: false, reason: 'terms-inactive' },
      });
      const read = await f.runtime.payments.scoped!.authorize(f.browser, 'read');
      expect(await f.runtime.payments.store!.getOrder(f.workspaceId, order.id, read)).toMatchObject(
        { id: order.id },
      );
      expect(await f.runtime.payments.store!.listOrders(f.workspaceId, read)).toHaveLength(1);
      await f.engine.pool.query(
        "UPDATE mr_payment_orders SET checkout_next_request_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [order.id],
      );
      await f.checkout(order.id);
      expect(f.retrieveSession).toHaveBeenCalledOnce();
      const paid = f.paid();
      const event = {
        id: 'evt_local_terms_paid',
        type: 'checkout.session.completed',
        livemode: true,
        processorEnvironment: f.environment,
        data: { object: { ...paid } },
      };
      await f.runtime.payments.reconcileVerifiedEvent!(event);
      await f.runtime.payments.reconcileVerifiedEvent!(event);
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(25_000_000);
      expect(
        (await f.engine.ledger(f.workspaceId)).filter((entry) => entry.kind === 'credit'),
      ).toHaveLength(1);
      expect(f.createSession).toHaveBeenCalledOnce();
      await expect(f.create('new-order-after-withdrawal')).rejects.toMatchObject({
        code: 'current_human_terms_inactive',
      });
    } finally {
      await f.close();
    }
  });

  it.each([
    'digest drift',
    'version drift',
    'withdrawal',
    'owner revocation',
    'membership removal',
  ] as const)(
    'rechecks %s after the awaited receipt read before outbound funding',
    async (kind) => {
      const f = await fixture();
      try {
        await f.receipt();
        const order = await f.create();
        const authorize = await f.runtime.payments.scoped!.authorize(f.browser, 'mutate');
        const afterReceipt: PaymentAuthority = async (client, context) => {
          const originalQuery = client.query.bind(client);
          // Wrap the same real transaction client, after the actual immutable table SELECT.
          const wrapped = {
            query: async (text: string, values?: unknown[]) => {
              const result = await originalQuery(text, values);
              if (text.includes('FROM mr_terms_receipts')) {
                if (kind === 'digest drift')
                  f.setPolicy({ ...activePolicy(), digest: 'c'.repeat(64) });
                if (kind === 'version drift')
                  f.setPolicy({ ...activePolicy(), version: 'synthetic-live-terms-v2' });
                if (kind === 'withdrawal')
                  f.setPolicy({ ...activePolicy(), status: 'draft', effectiveAt: null });
                if (kind === 'owner revocation')
                  await originalQuery(
                    'UPDATE mr_billing_owners SET revoked_at=clock_timestamp() WHERE workspace_id=$1',
                    [f.workspaceId],
                  );
                if (kind === 'membership removal')
                  await originalQuery(
                    'UPDATE mr_memberships SET removed_at=clock_timestamp() WHERE id=$1',
                    [f.browser.membershipId],
                  );
              }
              return result;
            },
          } as PoolClient;
          await authorize(wrapped, context);
        };
        await expect(
          f.runtime.payments.store!.checkout(
            f.workspaceId,
            order.id,
            f.config.manualTransport,
            afterReceipt,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(f.createSession).not.toHaveBeenCalled();
        expect(
          (
            await f.engine.pool.query(
              'SELECT checkout_started_at FROM mr_payment_orders WHERE id=$1',
              [order.id],
            )
          ).rows[0].checkout_started_at,
        ).toBeNull();
      } finally {
        await f.close();
      }
    },
  );

  it('denies bootstrap, API and OAuth-shaped identities even with the owner receipt', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      const key = await f.engine.accounts.createKey(f.workspaceId, {
        name: 'Synthetic terms delegate',
        scopes: ['read'],
      });
      const api = (await f.engine.accounts.authenticate(key.token))!;
      await f.engine.pool.query(
        `INSERT INTO mr_billing_delegations(workspace_id,target_kind,target_id,owner_authority_version,
         permissions,rails,version,consent_reference) VALUES($1,'key',$2,1,'["billing:read","billing:manage"]',$3,1,'synthetic-delegation')`,
        [f.workspaceId, key.id, JSON.stringify(rails)],
      );
      for (const principal of [
        { ...f.browser, bootstrap: true },
        api,
        {
          ...f.browser,
          keyKind: 'oauth',
          grantId: randomUUID(),
          clientId: 'synthetic-agent',
          oauthResource: 'https://fixture.invalid/mcp',
        },
        {
          ...f.browser,
          identity: { issuer: f.browser.identity!.issuer, subject: 'another-person' },
        },
      ] as Principal[]) {
        expect(await f.runtime.payments.scoped!.access(principal)).toMatchObject({
          manual: false,
          newFunding: { allowed: false },
        });
        await expect(
          f.runtime.payments.scoped!.authorize(principal, 'mutate'),
        ).rejects.toMatchObject({ statusCode: 403 });
      }
      expect(f.createSession).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('fails closed when a live funding caller omits the store-owned admission context', async () => {
    const f = await fixture();
    try {
      await f.receipt();
      const authorize = await f.runtime.payments.scoped!.authorize(f.browser, 'mutate');
      const client = await f.engine.pool.connect();
      try {
        await client.query('BEGIN');
        await expect(authorize(client)).rejects.toMatchObject({ code: 'billing_access_denied' });
        await expect(authorize(client, { newFunding: 'true' } as never)).rejects.toMatchObject({
          code: 'billing_access_denied',
        });
        expect(f.createSession).not.toHaveBeenCalled();
      } finally {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
      }
    } finally {
      await f.close();
    }
  });
});
