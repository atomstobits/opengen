import { createStripeClient, type PaymentsOptions } from './payments.js';

/** Server-only configuration; sandbox is the explicit default. */
export function paymentConfiguration(
  env: NodeJS.ProcessEnv,
): Pick<PaymentsOptions, 'stripe' | 'webhookSecret' | 'livemode'> {
  const mode = env.STRIPE_LIVEMODE ?? 'false';
  if (mode !== 'false' && mode !== 'true')
    throw new Error('STRIPE_LIVEMODE must be exactly true or false.');
  const livemode = mode === 'true';
  const key = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!key || !webhookSecret) return { livemode };
  const expected = livemode ? /^(?:rk|sk)_live_/ : /^(?:rk|sk)_test_/;
  if (!expected.test(key))
    throw new Error('The Stripe server key must match the explicitly configured payment mode.');
  return { livemode, stripe: createStripeClient(key), webhookSecret };
}
