import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  hostedBillingSandbox,
  readBillingSandboxConfiguration,
} from '../apps/server/src/billing-sandbox.js';
import { createStripeClient } from '../apps/server/src/payments.js';
import { billingFixture } from './billing-fixture.js';

const fixture = {
  NODE_ENV: 'test',
  OPENGEN_BILLING_SANDBOX: 'true',
  STRIPE_LIVEMODE: 'false',
  STRIPE_SECRET_KEY: ['rk', 'test', 'fixture'].join('_'),
  STRIPE_WEBHOOK_SECRET: ['whsec', 'fixture'].join('_'),
  OPENGEN_PUBLIC_URL: 'https://billing.example.test',
  DATABASE_URL: 'postgresql://localhost/opengen_billing_sandbox_fixture',
  OPENGEN_BILLING_SANDBOX_WORKSPACE: 'billing-owner-fixture',
  OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: 'billing-fixture',
  OPENGEN_BILLING_PROCESSOR_ACCOUNT: 'acct_fixture',
} as const;

describe('dedicated hosted sandbox startup', () => {
  it('requires explicit sandbox configuration and rejects production origin, mode and DB overrides', () => {
    expect(readBillingSandboxConfiguration({ NODE_ENV: 'test' })).toBeUndefined();
    expect(readBillingSandboxConfiguration(fixture)?.checkoutWritesEnabled).toBe(false);
    expect(
      readBillingSandboxConfiguration({ ...fixture, OPENGEN_BILLING_CHECKOUT: 'open' })
        ?.checkoutWritesEnabled,
    ).toBe(true);
    for (const override of [
      { STRIPE_LIVEMODE: 'true' },
      { STRIPE_LIVEMODE: undefined },
      { STRIPE_SECRET_KEY: ['rk', 'live', 'fixture'].join('_') },
      { OPENGEN_PUBLIC_URL: 'https://opengen.dev.' },
      { OPENGEN_PUBLIC_URL: 'https://billing.example.test/wrong-path' },
      { DATABASE_URL: 'postgresql://localhost/opengen' },
      { DATABASE_URL: fixture.DATABASE_URL + '?database=opengen' },
      { DATABASE_URL: fixture.DATABASE_URL + '?%64atabase=opengen' },
      { OPENGEN_BILLING_CHECKOUT: 'accidental' },
    ]) {
      expect(() => readBillingSandboxConfiguration({ ...fixture, ...override })).toThrow();
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)(
    'requires an approved sandbox owner before account I/O and verifies the exact account',
    async () => {
      const f = await billingFixture();
      try {
        const config = readBillingSandboxConfiguration({
          ...fixture,
          OPENGEN_BILLING_SANDBOX_WORKSPACE: f.workspace,
          OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: f.processorEnvironment.id,
        })!;
        const stripe = createStripeClient('local-fixture-noncredential');
        const account = vi.spyOn(stripe.accounts, 'retrieve');
        account.mockResolvedValue({ id: 'acct_wrong' } as Stripe.Response<Stripe.Account>);
        await expect(
          hostedBillingSandbox(f.pool, { ...config, workspaceId: 'unapproved-workspace' }, stripe),
        ).rejects.toMatchObject({ code: 'processor_environment_unverified' });
        expect(account).not.toHaveBeenCalled();
        await expect(hostedBillingSandbox(f.pool, config, stripe)).rejects.toMatchObject({
          code: 'processor_environment_mismatch',
        });
        expect(account).toHaveBeenCalledTimes(1);
        account.mockResolvedValue({
          id: config.environment.accountId,
        } as Stripe.Response<Stripe.Account>);
        const runtime = await hostedBillingSandbox(f.pool, config, stripe);
        expect(runtime.activation).toBe('sandbox');
        expect(runtime.checkoutWritesEnabled).toBe(false);
        expect(runtime.automaticChargesEnabled).toBeUndefined();
        expect(runtime.setupAvailable).toBeUndefined();
        expect(runtime.manualTransport.processorEnvironment).toEqual(config.environment);
        expect(() => runtime.manualTransport.assertProcessorEnvironment()).not.toThrow();
        expect(runtime.webhookVerifier).toBe(stripe.webhooks);
        expect(account).toHaveBeenCalledTimes(2);
      } finally {
        await f.close();
      }
    },
  );
});
