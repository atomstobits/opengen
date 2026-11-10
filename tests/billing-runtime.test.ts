import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEngine } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app.js';
import {
  createBillingFixtureRuntime,
  type BillingFixtureRuntimeOptions,
} from '../apps/server/src/billing-runtime.js';
import { createStripeClient } from '../apps/server/src/payments.js';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery.js';
import { workServerOnce } from '../apps/server/src/worker-turn.js';
import {
  registerBillingProcessorEnvironmentInTransaction,
  type RechargePayment,
  type SetupSession,
} from '../packages/engine/src/billing-customer.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const publicUrl = 'https://billing.fixture.invalid';
const signingSecret = 'local-fixture-billing-signing-secret';
const processorEnvironment = { id: 'runtime-fixture', accountId: 'acct_fixture', livemode: false };
const ownerRails = {
  allowsEnabled: true,
  maxThresholdMicros: 10_000_000,
  maxAmountCents: 2500,
  maxMonthlyCapCents: 10000,
  maxAttemptsPerMonth: 4,
  minCooldownSeconds: 60,
  maxFailureLimit: 3,
};

function injectedBilling() {
  const stripe = createStripeClient('local-fixture-noncredential');
  const proof = { processorEnvironment, assertProcessorEnvironment() {} };
  const customer = { id: 'cus_fixture', livemode: false };
  let setup: SetupSession;
  let payment: RechargePayment;
  const config: BillingFixtureRuntimeOptions = {
    activation: 'fixture',
    processorEnvironment,
    terms: { version: 'terms-fixture', text: 'Fixture funding approval for bounded refills.' },
    webhookSecret: signingSecret,
    webhookVerifier: stripe.webhooks,
    operatorBearer: 'dedicated-operator-fixture-bearer',
    manualTransport: {
      ...proof,
      createSession: vi.fn(async (order) => ({
        id: 'cs_test_manual_fixture',
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: order.amountCents,
        amount_total: order.amountCents,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: order.id,
        payment_intent: null,
        livemode: false,
        url: 'https://checkout.stripe.com/c/pay/manual_fixture',
      })),
      retrieveSession: vi.fn(async () => {
        throw new Error('Unexpected manual retrieval.');
      }),
    },
    customerTransport: {
      ...proof,
      createCustomer: vi.fn(async () => customer),
      retrieveCustomer: vi.fn(async () => customer),
      createSetup: vi.fn(
        async (request) =>
          (setup = {
            id: 'cs_test_setup_fixture',
            mode: 'setup',
            customer: request.customerId,
            livemode: false,
            status: 'open',
            client_reference_id: request.id,
            setup_intent: null,
            url: 'https://checkout.stripe.com/c/setup/runtime_fixture',
          }),
      ),
      retrieveSetup: vi.fn(async () => setup),
      retrieveSetupIntent: vi.fn(async (id) => ({
        id,
        customer: customer.id,
        payment_method: 'pm_runtime_fixture',
        livemode: false,
        status: 'succeeded',
        usage: 'off_session',
      })),
      retrievePaymentMethod: vi.fn(async (id) => ({ id, customer: customer.id, livemode: false })),
      createPortal: vi.fn(async () => {
        throw new Error('Portal must remain off.');
      }),
      listDocuments: vi.fn(async () => {
        throw new Error('Unexpected document sync.');
      }),
    },
    rechargeTransport: {
      ...proof,
      createRecharge: vi.fn(
        async (request) =>
          (payment = {
            id: 'pi_runtime_fixture',
            customer: request.customerId,
            payment_method: request.paymentMethodId,
            currency: 'usd',
            amount: request.amountCents,
            amount_received: 0,
            status: 'processing',
            livemode: false,
          }),
      ),
      retrieveRecharge: vi.fn(async () => payment),
    },
  };
  const signed = (type: string, object: object, context?: string) => {
    const payload = JSON.stringify({
      id: `evt_${randomUUID().replaceAll('-', '')}`,
      object: 'event',
      livemode: false,
      type,
      context,
      data: { object, description: '雪' },
    });
    return {
      method: 'POST' as const,
      url: '/webhooks/stripe',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': stripe.webhooks.generateTestHeaderString({
          payload,
          secret: signingSecret,
        }),
      },
      payload,
    };
  };
  return {
    config,
    completedSetup: () =>
      (setup = { ...setup, status: 'complete', setup_intent: 'seti_runtime_fixture' }),
    paid: () => (payment = { ...payment, status: 'succeeded', amount_received: payment.amount }),
    signed,
  };
}

async function fixture() {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_runtime');
  const engine = isolated.bind(
    createEngine({ databaseUrl: isolated.databaseUrl, publicUrl, providerEnv: {}, poolSize: 1 }),
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
      'https://identity.fixture.invalid',
      randomUUID(),
    );
    const cookie = await engine.accounts.createSession(identity);
    const principal = (await engine.accounts.session(cookie))!;
    const workspaceId = principal.workspaceId;
    const recoveryScope = sessionRecoveryScope(principal);
    const headers = {
      cookie: `og_session=${cookie}`,
      'x-opengen-workspace': workspaceId,
      'x-opengen-recovery-scope': recoveryScope,
    };
    await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
    const approve = async () =>
      engine.pool.query(
        `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
        processor_environment_id,livemode,rails,consent_reference,approval_reference)
       SELECT workspace_id,id,extract(epoch FROM accepted_at)::text,1,$3,false,$4,
        'fixture-owner-consent','fixture-owner-approval'
       FROM mr_memberships WHERE workspace_id=$1 AND id=$2`,
        [workspaceId, principal.membershipId, processorEnvironment.id, JSON.stringify(ownerRails)],
      );
    return { engine, close, approve, headers, workspaceId, recoveryScope };
  } catch (error) {
    await close();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('injected billing runtime through the server', () => {
  it('preserves the legacy route contract and hides the absent runtime from discovery', async () => {
    const f = await fixture();
    const app = await buildApp({ engine: f.engine, publicUrl, env: {} });
    try {
      const legacy = await app.inject({
        url: '/v1/billing',
        headers: { cookie: f.headers.cookie, 'x-opengen-workspace': f.workspaceId },
      });
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).toMatchObject({
        workspaceId: f.workspaceId,
        enabled: false,
        orders: [],
      });
      expect((await app.inject({ url: '/v1/billing/access', headers: f.headers })).statusCode).toBe(
        404,
      );
      expect(
        (await app.inject('/v1/operations')).json().data.map(({ id }: { id: string }) => id),
      ).not.toContain('billing.policy.get');
    } finally {
      await app.close();
      await f.close();
    }
  });

  it('keeps wallet reads available and checks real owner and recovery authority for manual funding', async () => {
    const f = await fixture();
    const transport = injectedBilling();
    const app = await buildApp({
      engine: f.engine,
      publicUrl,
      env: {},
      billingRuntime: transport.config,
    });
    try {
      const order = {
        method: 'POST' as const,
        url: '/v1/billing/orders',
        headers: { ...f.headers, origin: publicUrl, 'idempotency-key': 'runtime-order-fixture' },
        payload: { amountCents: 2500 },
      };
      const capabilities = () => app.inject({ url: '/v1/billing/access', headers: f.headers });
      const wallet = () => app.inject({ url: '/v1/billing', headers: f.headers });
      expect((await capabilities()).json()).toEqual({
        workspaceId: f.workspaceId,
        recoveryScope: f.recoveryScope,
        capabilities: { read: false, manage: false, setup: false },
      });
      expect((await wallet()).json()).toMatchObject({ enabled: false, orders: [] });
      expect((await app.inject(order)).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            url: '/v1/billing/access',
            headers: { ...f.headers, 'x-opengen-recovery-scope': 'stale' },
          })
        ).statusCode,
      ).toBe(409);
      await f.approve();
      const access = await capabilities();
      expect(access.headers['cache-control']).toContain('no-store');
      expect(access.json().capabilities).toEqual({ read: true, manage: true, setup: true });
      const policy = await app.inject({ url: '/v1/billing/policy', headers: f.headers });
      expect(policy.statusCode).toBe(200);
      expect(policy.json().setupAvailable).toBe(false);
      const pausedSetup = await app.inject({
        method: 'POST',
        url: '/v1/billing/setup',
        headers: order.headers,
        payload: { termsVersion: transport.config.terms.version, acceptedTerms: true },
      });
      expect(pausedSetup.statusCode).toBe(409);
      expect(pausedSetup.json().error.code).toBe('setup_not_activated');
      expect(transport.config.customerTransport.createSetup).not.toHaveBeenCalled();
      const created = await app.inject(order);
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id;
      const checkout = await app.inject({
        method: 'POST',
        url: `/v1/billing/orders/${id}/checkout`,
        headers: order.headers,
        payload: {},
      });
      expect(checkout.statusCode, checkout.body).toBe(200);
      expect(checkout.json().checkoutUrl).toContain('checkout.stripe.com');
      expect(transport.config.manualTransport.createSession).toHaveBeenCalledOnce();
      const key = await f.engine.accounts.createKey(f.workspaceId, {
        name: 'Billing fixture',
        scopes: ['read'],
      });
      const keyPrincipal = (await f.engine.accounts.authenticate(key.token))!;
      const keyCookie = await f.engine.accounts.createSession(keyPrincipal);
      const apiCookieHeaders = {
        ...f.headers,
        cookie: `og_session=${keyCookie}`,
        'x-opengen-recovery-scope': sessionRecoveryScope(keyPrincipal),
      };
      expect(
        (await app.inject({ url: '/v1/billing', headers: apiCookieHeaders })).json(),
      ).toMatchObject({ enabled: false, orders: [] });
      expect(
        (await app.inject({ url: `/v1/billing/orders/${id}`, headers: apiCookieHeaders }))
          .statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: '/v1/operator/billing', headers: f.headers })).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/v1/operator/billing',
            headers: { authorization: `Bearer ${transport.config.operatorBearer}` },
          })
        ).statusCode,
      ).toBe(200);
      await f.engine.pool.query(
        'UPDATE mr_billing_owners SET revoked_at=now() WHERE workspace_id=$1',
        [f.workspaceId],
      );
      expect((await wallet()).json()).toMatchObject({ enabled: false, orders: [] });
      expect((await app.inject(order)).statusCode).toBe(403);
    } finally {
      await app.close();
      await f.close();
    }
  });

  it('reconstructs setup authority, reads the accepted payment after disabling charges and credits once through the same signed ingress', async () => {
    const f = await fixture();
    const transport = injectedBilling();
    const enabled = { ...transport.config, setupAvailable: true, automaticChargesEnabled: true };
    const app = await buildApp({ engine: f.engine, publicUrl, env: {}, billingRuntime: enabled });
    try {
      await f.approve();
      const mutationHeaders = { ...f.headers, origin: publicUrl };
      const setup = await app.inject({
        method: 'POST',
        url: '/v1/billing/setup',
        headers: { ...mutationHeaders, 'idempotency-key': 'runtime-setup-fixture' },
        payload: { termsVersion: enabled.terms.version, acceptedTerms: true },
      });
      expect(setup.statusCode, setup.body).toBe(200);
      const setupId = setup.json().id;
      const readPolicy = () => app.inject({ url: '/v1/billing/policy', headers: f.headers });
      expect((await readPolicy()).json()).toMatchObject({ mandate: null });
      const signedSetup = transport.signed(
        'checkout.session.completed',
        transport.completedSetup(),
      );
      expect(
        (await app.inject({ ...signedSetup, payload: `${signedSetup.payload} ` })).statusCode,
      ).toBe(400);
      const foreign = await app.inject(
        transport.signed(
          'checkout.session.completed',
          transport.completedSetup(),
          'acct_foreign_fixture',
        ),
      );
      expect(foreign.statusCode, foreign.body).toBe(400);
      expect(foreign.json().error.code).toBe('wrong_payment_environment');
      expect(enabled.customerTransport.retrieveSetup).not.toHaveBeenCalled();
      const setupWebhook = await app.inject(signedSetup);
      expect(setupWebhook.statusCode, setupWebhook.body).toBe(200);
      const verified = await app.inject({
        url: `/v1/billing/setups/${setupId}`,
        headers: f.headers,
      });
      expect(verified.statusCode, verified.body).toBe(200);
      const setupPaused = await buildApp({
        engine: f.engine,
        publicUrl,
        env: {},
        billingRuntime: transport.config,
      });
      try {
        const access = await setupPaused.inject({ url: '/v1/billing/access', headers: f.headers });
        expect(access.json().capabilities.setup).toBe(true);
        const read = await setupPaused.inject({
          url: `/v1/billing/setups/${setupId}`,
          headers: f.headers,
        });
        expect(read.statusCode, read.body).toBe(200);
        expect(read.json()).toMatchObject({
          id: setupId,
          status: 'complete',
          mandateId: verified.json().mandateId,
        });
        const create = await setupPaused.inject({
          method: 'POST',
          url: '/v1/billing/setup',
          headers: { ...mutationHeaders, 'idempotency-key': 'runtime-new-setup-paused' },
          payload: { termsVersion: enabled.terms.version, acceptedTerms: true },
        });
        expect(create.statusCode).toBe(409);
        expect(enabled.customerTransport.createSetup).toHaveBeenCalledOnce();
      } finally {
        await setupPaused.close();
      }
      const policy = await readPolicy();
      expect(policy.statusCode, policy.body).toBe(200);
      expect(policy.json()).toMatchObject({
        policy: { enabled: false, mandateId: null, version: 0 },
        mandate: { id: verified.json().mandateId, status: 'active' },
      });
      const mandateId = policy.json().mandate.id;
      expect(mandateId).toMatch(/^[a-f0-9-]{36}$/);
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(0);
      const update = await app.inject({
        method: 'PUT',
        url: '/v1/billing/policy',
        headers: mutationHeaders,
        payload: {
          expectedVersion: 0,
          expectedAuthorityVersion: 1,
          consentReference: 'fixture-policy-consent',
          policy: {
            enabled: true,
            thresholdMicros: 5_000_000,
            amountCents: 2500,
            monthlyCapCents: 10000,
            maxAttemptsPerMonth: 4,
            cooldownSeconds: 60,
            failureLimit: 3,
            mandateId,
          },
        },
      });
      expect(update.statusCode, update.body).toBe(200);
      await workServerOnce(f.engine, createBillingFixtureRuntime(f.engine.pool, enabled));
      expect(enabled.rechargeTransport.createRecharge).toHaveBeenCalledOnce();
      await f.engine.pool.query(
        "UPDATE mr_billing_recharge_attempts SET next_request_at=now()-interval '1 second' WHERE workspace_id=$1",
        [f.workspaceId],
      );
      const paid = transport.paid();
      await workServerOnce(f.engine, createBillingFixtureRuntime(f.engine.pool, transport.config));
      expect(enabled.rechargeTransport.retrieveRecharge).toHaveBeenCalledWith(paid.id);
      expect(enabled.rechargeTransport.createRecharge).toHaveBeenCalledOnce();
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(0);
      const signedPaid = transport.signed('payment_intent.succeeded', paid);
      const first = await app.inject(signedPaid);
      expect(first.statusCode, first.body).toBe(200);
      expect((await app.inject(signedPaid)).statusCode).toBe(200);
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(25_000_000);
      expect(
        (await f.engine.ledger(f.workspaceId)).filter((entry) => entry.kind === 'credit'),
      ).toHaveLength(1);
      expect(enabled.rechargeTransport.createRecharge).toHaveBeenCalledOnce();
    } finally {
      await app.close();
      await f.close();
    }
  });
});
