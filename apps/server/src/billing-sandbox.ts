import type Stripe from 'stripe';
import type { Pool } from 'pg';
import { PaymentStore, creditWorkspaceInTransaction } from '@media-router/engine';
import {
  assertBillingProcessorEnvironmentInTransaction,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
} from '../../../packages/engine/src/billing-customer.js';
import { readBillingOwnerInTransaction } from '../../../packages/engine/src/billing-policy.js';
import { admitInstallationExternalInTransaction } from './billing-manual.js';
import type { BillingFixtureRuntimeOptions } from './billing-runtime.js';
import { StripeBillingTransport } from './billing-stripe.js';
import { createStripeClient } from './payments.js';

export interface BillingSandboxConfiguration {
  databaseUrl: string;
  publicUrl: string;
  workspaceId?: string;
  environment: BillingProcessorEnvironment;
  key: string;
  webhookSecret: string;
  checkoutWritesEnabled: boolean;
  rechargeEnabled: boolean;
  publishableKey?: string;
  portalConfigurationId?: string;
}

/** Parse before any database initialization. Error messages omit runtime values. */
export function readBillingSandboxConfiguration(
  env: NodeJS.ProcessEnv,
): BillingSandboxConfiguration | undefined {
  const enabled = env.OPENGEN_BILLING_SANDBOX ?? 'false';
  if (enabled === 'false') return;
  if (enabled !== 'true' || env.STRIPE_LIVEMODE !== 'false')
    throw new Error('Scoped payment qualification requires an explicit Stripe sandbox.');
  const { DATABASE_URL, OPENGEN_PUBLIC_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = env;
  const workspaceId = env.OPENGEN_BILLING_SANDBOX_WORKSPACE || undefined;
  const checkout = env.OPENGEN_BILLING_CHECKOUT ?? 'paused';
  const recharge = env.OPENGEN_BILLING_RECHARGE ?? 'paused';
  const publishableKey = env.OPENGEN_BILLING_PUBLISHABLE_KEY || undefined;
  const portalConfigurationId = env.OPENGEN_BILLING_PORTAL_CONFIGURATION || undefined;
  if (
    !DATABASE_URL ||
    !OPENGEN_PUBLIC_URL ||
    (workspaceId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId)) ||
    !STRIPE_SECRET_KEY ||
    !/^rk_test_[A-Za-z0-9]+$/.test(STRIPE_SECRET_KEY) ||
    !STRIPE_WEBHOOK_SECRET ||
    !/^whsec_[A-Za-z0-9]+$/.test(STRIPE_WEBHOOK_SECRET) ||
    !['paused', 'open'].includes(checkout) ||
    !['paused', 'open'].includes(recharge) ||
    (publishableKey !== undefined && !/^pk_test_[A-Za-z0-9]+$/.test(publishableKey)) ||
    (portalConfigurationId !== undefined && !/^bpc_[A-Za-z0-9_]+$/.test(portalConfigurationId))
  )
    throw new Error('Complete the dedicated sandbox configuration before starting billing.');
  if (recharge === 'open' && !publishableKey)
    throw new Error('Sandbox automatic recharge requires a test Stripe publishable key.');
  let database: URL;
  let origin: URL;
  try {
    database = new URL(DATABASE_URL);
    origin = new URL(OPENGEN_PUBLIC_URL);
  } catch {
    throw new Error('Use a dedicated sandbox database and a canonical HTTPS sandbox origin.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !/^\/opengen_billing_sandbox(?:_[a-z0-9]+)*$/.test(database.pathname) ||
    database.hash ||
    [...database.searchParams.keys()].some((key) =>
      ['database', 'dbname', 'connectionstring', 'options'].includes(key.toLowerCase()),
    ) ||
    origin.protocol !== 'https:' ||
    ['opengen.dev', 'www.opengen.dev'].includes(origin.hostname.replace(/\.$/, '')) ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Use a dedicated sandbox database and a canonical HTTPS sandbox origin.');
  return {
    databaseUrl: DATABASE_URL,
    publicUrl: origin.origin,
    ...(workspaceId ? { workspaceId } : {}),
    environment: validatedBillingProcessorEnvironment({
      id: env.OPENGEN_BILLING_PROCESSOR_ENVIRONMENT ?? '',
      accountId: env.OPENGEN_BILLING_PROCESSOR_ACCOUNT ?? '',
      livemode: false,
    }),
    key: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    checkoutWritesEnabled: checkout === 'open',
    rechargeEnabled: recharge === 'open',
    ...(publishableKey ? { publishableKey } : {}),
    ...(portalConfigurationId ? { portalConfigurationId } : {}),
  };
}

/** One admitted account proof, using the same SDK for Checkout and signatures. */
export async function hostedBillingSandbox(
  pool: Pool,
  config: BillingSandboxConfiguration,
  stripe: Stripe = createStripeClient(config.key),
): Promise<BillingFixtureRuntimeOptions> {
  const transport = new StripeBillingTransport(stripe, {
    enabled: true,
    processorEnvironment: config.environment,
    publicUrl: config.publicUrl,
    ...(config.portalConfigurationId
      ? { portalConfigurationId: config.portalConfigurationId }
      : {}),
  });
  const limiter = new PaymentStore(pool, {
    livemode: false,
    processorEnvironment: config.environment,
    creditInTransaction: creditWorkspaceInTransaction,
  });
  await transport.verifyProcessorEnvironment(async (environment) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (config.workspaceId !== undefined) {
        await limiter.admitExternalInTransaction(client, config.workspaceId);
        await assertBillingProcessorEnvironmentInTransaction(client, environment);
        const owner = await readBillingOwnerInTransaction(client, config.workspaceId);
        if (!owner || owner.processorEnvironmentId !== environment.id || owner.livemode)
          throw new Error('Approved sandbox funding authority is required.');
      } else {
        await admitInstallationExternalInTransaction(client, limiter);
        await assertBillingProcessorEnvironmentInTransaction(client, environment);
        if (environment.livemode)
          throw new Error('Sandbox processor environment cannot run in live mode.');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  const rechargeEnabled = config.rechargeEnabled === true;
  return {
    activation: 'sandbox',
    processorEnvironment: config.environment,
    terms: { version: 'sandbox-acceptance-v1', text: 'Sandbox validation uses simulated funds.' },
    manualTransport: transport.verifiedLegacyCheckoutTransport(),
    customerTransport: transport,
    rechargeTransport: transport,
    webhookVerifier: stripe.webhooks,
    webhookSecret: config.webhookSecret,
    checkoutWritesEnabled: config.checkoutWritesEnabled,
    ...(rechargeEnabled ? { setupAvailable: true, automaticChargesEnabled: true } : {}),
    ...(rechargeEnabled && config.portalConfigurationId ? { portalAvailable: true } : {}),
    ...(rechargeEnabled && config.publishableKey
      ? { recovery: { transport, publishableKey: config.publishableKey } }
      : {}),
  };
}
