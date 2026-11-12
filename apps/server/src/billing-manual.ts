import type Stripe from 'stripe';
import type { Pool } from 'pg';
import { PaymentStore, creditWorkspaceInTransaction } from '@media-router/engine';
import {
  assertBillingProcessorEnvironmentInTransaction,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
  type BillingTerms,
} from '../../../packages/engine/src/billing-customer.js';
import { readBillingOwnerInTransaction } from '../../../packages/engine/src/billing-policy.js';
import type { BillingFixtureRuntimeOptions } from './billing-runtime.js';
import { StripeBillingTransport } from './billing-stripe.js';
import { createStripeClient } from './payments.js';
import type { HumanTermsPolicy } from './terms-login.js';

interface BillingManualConfiguration {
  databaseUrl: string;
  publicUrl: string;
  workspaceId: string;
  environment: BillingProcessorEnvironment;
  key: string;
  webhookSecret: string;
  operatorBearer?: string;
  checkoutWritesEnabled: boolean;
  rechargeEnabled: boolean;
  publishableKey?: string;
  portalConfigurationId?: string;
  approvalReference: string;
  terms: BillingTerms;
}

/** Validate before database initialization. Runtime secrets never appear in errors. */
export function readBillingManualConfiguration(
  env: NodeJS.ProcessEnv,
): BillingManualConfiguration | undefined {
  const enabled = env.OPENGEN_BILLING_MANUAL ?? 'false';
  if (!['false', 'true'].includes(enabled))
    throw new Error('Manual billing requires an explicit activation flag.');
  if (enabled === 'false') {
    if (env.STRIPE_LIVEMODE === 'true')
      throw new Error('Live billing requires the reviewed explicit manual binding.');
    if (
      env.OPENGEN_BILLING_SANDBOX !== 'true' &&
      (env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET)
    )
      throw new Error('Stripe credentials require an explicit scoped binding.');
    return;
  }
  if ((env.OPENGEN_BILLING_SANDBOX ?? 'false') !== 'false' || env.STRIPE_LIVEMODE !== 'true')
    throw new Error('Manual billing and sandbox activation are mutually exclusive.');

  const { DATABASE_URL, OPENGEN_PUBLIC_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = env;
  const workspaceId = env.OPENGEN_BILLING_MANUAL_WORKSPACE;
  const checkout = env.OPENGEN_BILLING_CHECKOUT ?? 'paused';
  const recharge = env.OPENGEN_BILLING_RECHARGE ?? 'paused';
  const publishableKey = env.OPENGEN_BILLING_PUBLISHABLE_KEY || undefined;
  const portalConfigurationId = env.OPENGEN_BILLING_PORTAL_CONFIGURATION || undefined;
  const approvalReference = env.OPENGEN_BILLING_APPROVAL_REFERENCE;
  const termsVersion = env.OPENGEN_BILLING_TERMS_VERSION;
  const termsText = env.OPENGEN_BILLING_TERMS_TEXT;
  const operatorBearer = env.OPENGEN_BILLING_OPERATOR_BEARER || undefined;
  if (
    operatorBearer &&
    (operatorBearer.length < 32 ||
      operatorBearer.length > 512 ||
      /[\s\p{Cc}]/u.test(operatorBearer) ||
      [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, env.MR_API_TOKEN, publishableKey].includes(
        operatorBearer,
      ))
  )
    throw new Error('Use a bounded dedicated manual billing operator credential.');
  if (
    !DATABASE_URL ||
    !OPENGEN_PUBLIC_URL ||
    !workspaceId ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId) ||
    !STRIPE_SECRET_KEY ||
    !/^rk_live_[A-Za-z0-9]+$/.test(STRIPE_SECRET_KEY) ||
    !STRIPE_WEBHOOK_SECRET ||
    !/^whsec_[A-Za-z0-9]+$/.test(STRIPE_WEBHOOK_SECRET) ||
    !['paused', 'open'].includes(checkout) ||
    !['paused', 'open'].includes(recharge) ||
    (publishableKey !== undefined && !/^pk_live_[A-Za-z0-9]+$/.test(publishableKey)) ||
    (portalConfigurationId !== undefined && !/^bpc_[A-Za-z0-9]+$/.test(portalConfigurationId)) ||
    !approvalReference ||
    approvalReference.length > 200 ||
    approvalReference.trim() !== approvalReference ||
    /[\u0000-\u001f\u007f]/.test(approvalReference) ||
    !termsVersion ||
    termsVersion.length > 120 ||
    termsVersion.trim() !== termsVersion ||
    /[\u0000-\u001f\u007f]/.test(termsVersion) ||
    !termsText?.trim() ||
    termsText.length > 20_000 ||
    termsText.includes('\0')
  )
    throw new Error('Complete the reviewed manual billing configuration before startup.');
  if (recharge === 'open' && !publishableKey)
    throw new Error('Live automatic recharge requires a live Stripe publishable key.');

  let database: URL;
  let origin: URL;
  try {
    database = new URL(DATABASE_URL);
    origin = new URL(OPENGEN_PUBLIC_URL);
  } catch {
    throw new Error('Use the reviewed production database and canonical OpenGen HTTPS origin.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !/^\/[A-Za-z0-9_-]+$/.test(database.pathname) ||
    database.pathname.toLowerCase().startsWith('/opengen_billing_sandbox') ||
    database.hash ||
    [...database.searchParams.keys()].some((key) =>
      ['database', 'dbname', 'connectionstring', 'options'].includes(key.toLowerCase()),
    ) ||
    origin.origin !== 'https://opengen.dev' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    throw new Error('Use the reviewed production database and canonical OpenGen HTTPS origin.');

  return {
    databaseUrl: DATABASE_URL,
    publicUrl: origin.origin,
    workspaceId,
    environment: validatedBillingProcessorEnvironment({
      id: env.OPENGEN_BILLING_PROCESSOR_ENVIRONMENT ?? '',
      accountId: env.OPENGEN_BILLING_PROCESSOR_ACCOUNT ?? '',
      livemode: true,
    }),
    key: STRIPE_SECRET_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    ...(operatorBearer ? { operatorBearer } : {}),
    checkoutWritesEnabled: checkout === 'open',
    rechargeEnabled: recharge === 'open',
    ...(publishableKey ? { publishableKey } : {}),
    ...(portalConfigurationId ? { portalConfigurationId } : {}),
    approvalReference,
    terms: { version: termsVersion, text: termsText },
  };
}

/** Construct a scoped manual runtime after one admitted, owner-bound account proof. */
export async function hostedBillingManual(
  pool: Pool,
  config: BillingManualConfiguration,
  stripe: Stripe = createStripeClient(config.key),
  options: { humanTermsPolicy?: () => HumanTermsPolicy } = {},
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
    livemode: true,
    processorEnvironment: config.environment,
    creditInTransaction: creditWorkspaceInTransaction,
  });
  await transport.verifyProcessorEnvironment(async (environment) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await limiter.admitExternalInTransaction(client, config.workspaceId);
      await assertBillingProcessorEnvironmentInTransaction(client, environment);
      const owner = await readBillingOwnerInTransaction(client, config.workspaceId);
      if (
        !environment.livemode ||
        !owner ||
        owner.processorEnvironmentId !== environment.id ||
        owner.livemode !== true ||
        owner.approvalReference !== config.approvalReference
      )
        throw new Error('Current reviewed manual funding authority is required.');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
  const rechargeEnabled = config.rechargeEnabled === true;
  if (rechargeEnabled && !config.publishableKey)
    throw new Error('Live automatic recharge requires a live Stripe publishable key.');
  return {
    activation: 'manual',
    processorEnvironment: config.environment,
    terms: config.terms,
    ...(options.humanTermsPolicy ? { humanTermsPolicy: options.humanTermsPolicy } : {}),
    manualTransport: transport.verifiedLegacyCheckoutTransport(),
    customerTransport: transport,
    rechargeTransport: transport,
    webhookVerifier: stripe.webhooks,
    webhookSecret: config.webhookSecret,
    ...(config.operatorBearer ? { operatorBearer: config.operatorBearer } : {}),
    checkoutWritesEnabled: config.checkoutWritesEnabled,
    ...(rechargeEnabled ? { liveRechargeApproved: true } : {}),
    setupAvailable: rechargeEnabled,
    automaticChargesEnabled: rechargeEnabled,
    portalAvailable: rechargeEnabled && Boolean(config.portalConfigurationId),
    ...(rechargeEnabled && config.publishableKey
      ? { recovery: { transport, publishableKey: config.publishableKey } }
      : {}),
  };
}
