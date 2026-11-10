import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
  hostedBillingManual,
  readBillingManualConfiguration,
} from '../apps/server/src/billing-manual.js';
import { readBillingSandboxConfiguration } from '../apps/server/src/billing-sandbox.js';
import { createBillingFixtureRuntime } from '../apps/server/src/billing-runtime.js';
import { createStripeClient } from '../apps/server/src/payments.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { billingFixture } from './billing-fixture.js';

const configured = {
  OPENGEN_BILLING_MANUAL: 'true',
  STRIPE_LIVEMODE: 'true',
  STRIPE_SECRET_KEY: ['rk', 'live', 'syntheticfixture'].join('_'),
  STRIPE_WEBHOOK_SECRET: ['whsec', 'syntheticfixture'].join('_'),
  OPENGEN_PUBLIC_URL: 'https://opengen.dev',
  DATABASE_URL: 'postgresql://localhost/opengen_manual_fixture',
  OPENGEN_BILLING_MANUAL_WORKSPACE: 'manual-owner-fixture',
  OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: 'manual-live-fixture',
  OPENGEN_BILLING_PROCESSOR_ACCOUNT: 'acct_fixture',
  OPENGEN_BILLING_APPROVAL_REFERENCE: 'manual-fixture-approval',
  OPENGEN_BILLING_TERMS_VERSION: 'manual-fixture-terms-v1',
  OPENGEN_BILLING_TERMS_TEXT: 'Synthetic fixture terms supplied explicitly by the test.',
} as const;

describe('scoped production manual billing configuration', () => {
  it('is off by default and keeps Checkout paused until explicitly opened', () => {
    expect(readBillingManualConfiguration({})).toBeUndefined();
    expect(
      readBillingManualConfiguration({ OPENGEN_BILLING_MANUAL: 'false', STRIPE_LIVEMODE: 'false' }),
    ).toBeUndefined();
    const parsed = readBillingManualConfiguration(configured)!;
    expect(parsed).toMatchObject({
      publicUrl: 'https://opengen.dev',
      checkoutWritesEnabled: false,
      environment: {
        id: configured.OPENGEN_BILLING_PROCESSOR_ENVIRONMENT,
        accountId: 'acct_fixture',
        livemode: true,
      },
      approvalReference: configured.OPENGEN_BILLING_APPROVAL_REFERENCE,
      terms: {
        version: configured.OPENGEN_BILLING_TERMS_VERSION,
        text: configured.OPENGEN_BILLING_TERMS_TEXT,
      },
    });
    expect(
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_CHECKOUT: 'open' })
        ?.checkoutWritesEnabled,
    ).toBe(true);
  });

  it('refuses a legacy live fallback without the explicit reviewed binding', () => {
    expect(() =>
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_MANUAL: undefined }),
    ).toThrow(/explicit manual binding/);
    expect(() =>
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_MANUAL: 'false' }),
    ).toThrow(/explicit manual binding/);
    expect(() =>
      readBillingManualConfiguration({
        STRIPE_LIVEMODE: 'false',
        STRIPE_SECRET_KEY: ['rk', 'test', 'fixture'].join('_'),
      }),
    ).toThrow(/explicit scoped binding/);
  });

  it('requires scoped binding for any credentialed startup while keeping keyless and explicit sandbox parsing available', () => {
    const key = ['rk', 'test', 'fixture'].join('_');
    const secret = ['whsec', 'fixture'].join('_');
    for (const OPENGEN_PUBLIC_URL of [undefined, 'http://localhost:4320', 'https://opengen.dev']) {
      for (const credentials of [
        { STRIPE_SECRET_KEY: key },
        { STRIPE_WEBHOOK_SECRET: secret },
        { STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: secret },
      ]) {
        expect(() =>
          readBillingManualConfiguration({ ...credentials, OPENGEN_PUBLIC_URL }),
        ).toThrow(/explicit scoped binding/);
        expect(() =>
          readBillingManualConfiguration({
            ...credentials,
            OPENGEN_PUBLIC_URL,
            OPENGEN_BILLING_SANDBOX: 'false',
            STRIPE_LIVEMODE: 'false',
          }),
        ).toThrow(/explicit scoped binding/);
      }
    }
    expect(
      readBillingManualConfiguration({
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
        STRIPE_LIVEMODE: 'false',
      }),
    ).toBeUndefined();
    expect(
      readBillingManualConfiguration({
        OPENGEN_BILLING_SANDBOX: 'true',
        STRIPE_LIVEMODE: 'false',
        STRIPE_SECRET_KEY: key,
        STRIPE_WEBHOOK_SECRET: secret,
      }),
    ).toBeUndefined();
  });

  it('rejects unscoped test credentials through the server entry point before any database or provider connection', () => {
    const entry = new URL('../apps/server/src/index.ts', import.meta.url).href;
    const root = fileURLToPath(new URL('../', import.meta.url));
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const require = createRequire(import.meta.url);
      const refuseNetwork = () => { throw new Error('UNEXPECTED_STARTUP_NETWORK'); };
      globalThis.fetch = refuseNetwork;
      require('node:net').Socket.prototype.connect = refuseNetwork;
      for (const module of ['node:http', 'node:https']) {
        require(module).request = refuseNetwork;
        require(module).get = refuseNetwork;
      }
      syncBuiltinESMExports();
      await import(${JSON.stringify(entry)});
    `;
    for (const mode of [undefined, 'false']) {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            PATH: '/usr/bin:/bin',
            NODE_ENV: 'production',
            OPENGEN_PUBLIC_URL: 'https://opengen.dev',
            DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/opengen_fixture',
            STRIPE_SECRET_KEY: ['rk', 'test', 'unscopedfixture'].join('_'),
            STRIPE_WEBHOOK_SECRET: ['whsec', 'unscopedfixture'].join('_'),
            ...(mode === undefined ? {} : { STRIPE_LIVEMODE: mode }),
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).not.toBe(0);
      const output = child.stdout + child.stderr;
      expect(output).toContain('Stripe credentials require an explicit scoped binding.');
      expect(output).not.toMatch(/UNEXPECTED_STARTUP_NETWORK|ECONNREFUSED|ETIMEDOUT/);
      expect(output).not.toContain(['rk', 'test', 'unscopedfixture'].join('_'));
      expect(output).not.toContain(['whsec', 'unscopedfixture'].join('_'));
    }
  });

  it('rejects conflicting modes, insufficient credentials and unreviewed terms before initialization', () => {
    for (const override of [
      { OPENGEN_BILLING_MANUAL: 'accidental' },
      { OPENGEN_BILLING_SANDBOX: 'true' },
      { OPENGEN_BILLING_SANDBOX: 'accidental' },
      { STRIPE_LIVEMODE: 'false' },
      { STRIPE_LIVEMODE: undefined },
      { STRIPE_SECRET_KEY: ['sk', 'live', 'fixture'].join('_') },
      { STRIPE_SECRET_KEY: ['rk', 'test', 'fixture'].join('_') },
      { STRIPE_WEBHOOK_SECRET: undefined },
      { OPENGEN_BILLING_MANUAL_WORKSPACE: undefined },
      { OPENGEN_BILLING_MANUAL_WORKSPACE: '../other' },
      { OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: undefined },
      { OPENGEN_BILLING_PROCESSOR_ACCOUNT: undefined },
      { OPENGEN_BILLING_CHECKOUT: 'enabled' },
      { OPENGEN_BILLING_APPROVAL_REFERENCE: undefined },
      { OPENGEN_BILLING_APPROVAL_REFERENCE: 'stale\nreference' },
      { OPENGEN_BILLING_TERMS_VERSION: undefined },
      { OPENGEN_BILLING_TERMS_VERSION: 'v'.repeat(121) },
      { OPENGEN_BILLING_TERMS_TEXT: ' ' },
      { OPENGEN_BILLING_TERMS_TEXT: 't'.repeat(20_001) },
    ])
      expect(() => readBillingManualConfiguration({ ...configured, ...override })).toThrow();
    // The existing sandbox reader still requires explicit test mode.
    expect(() =>
      readBillingSandboxConfiguration({ ...configured, OPENGEN_BILLING_SANDBOX: 'true' }),
    ).toThrow();
  });

  it('pins the canonical production origin and rejects sandbox or overridden database targets', () => {
    for (const override of [
      { OPENGEN_PUBLIC_URL: 'https://opengen-billing-sbx-fixture.vercel.app' },
      { OPENGEN_PUBLIC_URL: 'https://www.opengen.dev' },
      { OPENGEN_PUBLIC_URL: 'https://opengen.dev.' },
      { OPENGEN_PUBLIC_URL: 'http://opengen.dev' },
      { OPENGEN_PUBLIC_URL: 'https://user:pass@opengen.dev' },
      { OPENGEN_PUBLIC_URL: 'https://opengen.dev:444' },
      { OPENGEN_PUBLIC_URL: 'https://opengen.dev/billing' },
      { OPENGEN_PUBLIC_URL: 'https://opengen.dev?override=true' },
      { DATABASE_URL: 'postgresql://localhost/opengen_billing_sandbox_fixture' },
      { DATABASE_URL: 'postgresql://localhost/opengen?%64bname=other' },
      { DATABASE_URL: 'postgresql://localhost/opengen?options=-csearch_path%3Dother' },
      { DATABASE_URL: 'postgresql://localhost/opengen#other' },
      { DATABASE_URL: undefined },
    ])
      expect(() => readBillingManualConfiguration({ ...configured, ...override })).toThrow();
  });

  it('keeps operator access off unless a bounded dedicated credential is configured', () => {
    const operator = 'synthetic-dedicated-manual-operator-fixture';
    expect(readBillingManualConfiguration(configured)?.operatorBearer).toBeUndefined();
    expect(
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_OPERATOR_BEARER: '' })
        ?.operatorBearer,
    ).toBeUndefined();
    expect(
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_OPERATOR_BEARER: operator })
        ?.operatorBearer,
    ).toBe(operator);
    for (const invalid of [
      'x'.repeat(31),
      'x'.repeat(513),
      'x'.repeat(31) + ' ',
      'x'.repeat(32) + '\n',
      'x'.repeat(32) + '\u007f',
      'x'.repeat(32) + '\u0085',
    ])
      expect(() =>
        readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_OPERATOR_BEARER: invalid }),
      ).toThrow(/dedicated manual billing operator/);
    const stripeKey = ['rk', 'live', 'k'.repeat(40)].join('_');
    const webhookSecret = ['whsec', 'h'.repeat(40)].join('_');
    for (const credential of [stripeKey, webhookSecret, operator])
      expect(() =>
        readBillingManualConfiguration({
          ...configured,
          STRIPE_SECRET_KEY: stripeKey,
          STRIPE_WEBHOOK_SECRET: webhookSecret,
          MR_API_TOKEN: operator,
          OPENGEN_BILLING_OPERATOR_BEARER: credential,
        }),
      ).toThrow(/dedicated manual billing operator/);
    try {
      readBillingManualConfiguration({
        ...configured,
        MR_API_TOKEN: operator,
        OPENGEN_BILLING_OPERATOR_BEARER: operator,
      });
    } catch (error) {
      expect(String(error)).not.toContain(operator);
    }
  });

  it('omits all configured secrets and terms from validation error messages', () => {
    try {
      readBillingManualConfiguration({ ...configured, OPENGEN_BILLING_MANUAL_WORKSPACE: '' });
      throw new Error('Expected rejection');
    } catch (error) {
      const message = String(error);
      for (const value of [
        configured.STRIPE_SECRET_KEY,
        configured.STRIPE_WEBHOOK_SECRET,
        configured.DATABASE_URL,
        configured.OPENGEN_BILLING_TERMS_TEXT,
      ])
        expect(message).not.toContain(value);
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  'approved manual startup with mocked Stripe',
  () => {
    it('binds the existing live owner approval before one counted account read and closes advanced features', async () => {
      const f = await billingFixture();
      try {
        const environment = {
          id: `manual-live-${randomUUID()}`,
          accountId: 'acct_fixture',
          livemode: true,
        };
        const client = await f.pool.connect();
        try {
          await client.query('BEGIN');
          await registerBillingProcessorEnvironmentInTransaction(client, environment);
          await client.query(
            'UPDATE mr_billing_owners SET processor_environment_id=$2,livemode=true,approval_reference=$3 WHERE workspace_id=$1',
            [f.workspace, environment.id, configured.OPENGEN_BILLING_APPROVAL_REFERENCE],
          );
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        const config = readBillingManualConfiguration({
          ...configured,
          OPENGEN_BILLING_MANUAL_WORKSPACE: f.workspace,
          OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: environment.id,
        })!;
        const stripe = createStripeClient('local-fixture-noncredential');
        const account = vi
          .spyOn(stripe.accounts, 'retrieve')
          .mockRejectedValue(new Error('Unexpected mocked account request'));
        const checkout = vi
          .spyOn(stripe.checkout.sessions, 'create')
          .mockRejectedValue(new Error('Unexpected mocked Checkout write'));
        await expect(
          hostedBillingManual(f.pool, { ...config, approvalReference: 'stale-approval' }, stripe),
        ).rejects.toMatchObject({ code: 'processor_environment_unverified' });
        await expect(
          hostedBillingManual(f.pool, { ...config, workspaceId: 'unapproved-workspace' }, stripe),
        ).rejects.toMatchObject({ code: 'processor_environment_unverified' });
        await expect(
          hostedBillingManual(
            f.pool,
            { ...config, environment: { ...environment, id: 'unregistered' } },
            stripe,
          ),
        ).rejects.toMatchObject({ code: 'processor_environment_unverified' });
        expect(account).not.toHaveBeenCalled();
        account.mockResolvedValueOnce({
          id: 'acct_wrong',
          charges_enabled: true,
        } as Stripe.Response<Stripe.Account>);
        await expect(hostedBillingManual(f.pool, config, stripe)).rejects.toMatchObject({
          code: 'processor_environment_mismatch',
        });
        account.mockResolvedValueOnce({
          id: environment.accountId,
          charges_enabled: false,
        } as Stripe.Response<Stripe.Account>);
        await expect(hostedBillingManual(f.pool, config, stripe)).rejects.toMatchObject({
          code: 'processor_account_not_ready',
        });
        account.mockImplementationOnce(async () => {
          await f.pool.query('SELECT 1'); // Pool size one proves no connection remains held over account I/O.
          return {
            id: environment.accountId,
            charges_enabled: true,
          } as Stripe.Response<Stripe.Account>;
        });
        const runtime = await hostedBillingManual(f.pool, config, stripe);
        expect(runtime).toMatchObject({
          activation: 'manual',
          checkoutWritesEnabled: false,
          setupAvailable: false,
          automaticChargesEnabled: false,
          portalAvailable: false,
          terms: config.terms,
        });
        expect(runtime.recovery).toBeUndefined();
        expect(runtime.operatorBearer).toBeUndefined();
        expect(runtime.manualTransport.processorEnvironment).toEqual(environment);
        expect(() => runtime.manualTransport.assertProcessorEnvironment()).not.toThrow();
        expect(runtime.webhookVerifier).toBe(stripe.webhooks);
        expect(account).toHaveBeenCalledTimes(3);
        expect(checkout).not.toHaveBeenCalled();
        expect(
          Number(
            (
              await f.pool.query('SELECT payment_checkout_count FROM mr_workspaces WHERE id=$1', [
                f.workspace,
              ])
            ).rows[0].payment_checkout_count,
          ),
        ).toBe(3);
        expect(() => createBillingFixtureRuntime(f.pool, runtime)).not.toThrow();
        for (const advanced of [
          { setupAvailable: true },
          { automaticChargesEnabled: true },
          { portalAvailable: true },
          {
            recovery: {
              transport: runtime.rechargeTransport as never,
              publishableKey: 'synthetic-fixture',
            },
          },
        ])
          expect(() => createBillingFixtureRuntime(f.pool, { ...runtime, ...advanced })).toThrow();
        for (const activation of ['fixture', 'sandbox'] as const)
          expect(() => createBillingFixtureRuntime(f.pool, { ...runtime, activation })).toThrow();
        expect(() =>
          createBillingFixtureRuntime(f.pool, {
            ...runtime,
            processorEnvironment: { ...environment, livemode: false },
          }),
        ).toThrow();
        expect(account).toHaveBeenCalledTimes(3);
        const operatorBearer = 'synthetic-dedicated-manual-operator-fixture';
        const withOperator = readBillingManualConfiguration({
          ...configured,
          OPENGEN_BILLING_MANUAL_WORKSPACE: f.workspace,
          OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: environment.id,
          OPENGEN_BILLING_OPERATOR_BEARER: operatorBearer,
        })!;
        account.mockImplementationOnce(async () => {
          await f.pool.query('SELECT 1');
          return {
            id: environment.accountId,
            charges_enabled: true,
          } as Stripe.Response<Stripe.Account>;
        });
        const operatorRuntime = await hostedBillingManual(f.pool, withOperator, stripe);
        expect(operatorRuntime.operatorBearer).toBe(operatorBearer);
        expect(operatorRuntime.checkoutWritesEnabled).toBe(false);
        expect(operatorRuntime.automaticChargesEnabled).toBe(false);
        expect(account).toHaveBeenCalledTimes(4);
        expect(checkout).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    });
  },
);
