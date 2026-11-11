import {
  createEngine,
  PaymentStore,
  creditWorkspaceInTransaction,
  readExecutionScopeConfiguration,
} from '@media-router/engine';
import { buildApp } from './app.js';
import { paymentConfiguration } from './payment-config.js';
import { hostedBillingSandbox, readBillingSandboxConfiguration } from './billing-sandbox.js';
import { hostedBillingManual, readBillingManualConfiguration } from './billing-manual.js';
import {
  createHostedHumanTermsPolicyReader,
  readHostedLegalPublicationConfiguration,
} from './hosted-legal.js';
import { readProviderExecutionConfiguration } from './provider-execution.js';

const manual = readBillingManualConfiguration(process.env);
const sandbox = readBillingSandboxConfiguration(process.env);
const providerExecutionEnabled = readProviderExecutionConfiguration(process.env);
const executionScope = readExecutionScopeConfiguration(process.env);
const scoped = manual ?? sandbox;
const publicUrl = scoped?.publicUrl ?? process.env.OPENGEN_PUBLIC_URL ?? 'http://localhost:4320';
const hostedLegalPublication = readHostedLegalPublicationConfiguration(process.env, { publicUrl });
if (hostedLegalPublication && sandbox)
  throw new Error('Hosted legal publication cannot be combined with billing sandbox activation.');
const humanTermsPolicy = createHostedHumanTermsPolicyReader(hostedLegalPublication);
const paymentConfig = scoped ? undefined : paymentConfiguration(process.env);
if (
  hostedLegalPublication &&
  paymentConfig &&
  (paymentConfig.livemode || paymentConfig.stripe || paymentConfig.webhookSecret)
)
  throw new Error(
    'Hosted legal publication requires scoped manual billing rather than unscoped payments.',
  );
const databaseUrl = scoped?.databaseUrl ?? process.env.DATABASE_URL;

const engine = databaseUrl
  ? createEngine({
      databaseUrl,
      publicUrl,
      providerExecutionEnabled,
      executionScope,
      ...(sandbox ? { adapters: [], providerEnv: { NODE_ENV: 'production' as const } } : {}),
    })
  : undefined;
if (engine) {
  await engine.initialize();
  if (!manual)
    await engine.ensureWorkspace(
      process.env.MR_WORKSPACE_ID ?? 'local',
      Number(process.env.MR_INITIAL_BALANCE_MICROS ?? 0),
    );
}
const billingRuntime =
  engine && manual
    ? await hostedBillingManual(engine.pool, manual, undefined, { humanTermsPolicy })
    : engine && sandbox
      ? await hostedBillingSandbox(engine.pool, sandbox)
      : undefined;
const payments =
  engine && paymentConfig && !hostedLegalPublication
    ? new PaymentStore(engine.pool, {
        creditInTransaction: creditWorkspaceInTransaction,
        livemode: paymentConfig.livemode,
      })
    : undefined;
let workBillingOnce: (() => Promise<void>) | undefined;
const app = await buildApp({
  engine,
  payments,
  paymentConfig,
  billingRuntime,
  onBillingRuntime: (runtime) => {
    workBillingOnce = runtime.workOnce;
  },
  ...(sandbox ? {} : { humanTermsPolicy }),
  publicUrl,
  apiToken: process.env.MR_API_TOKEN,
  workspaceId: process.env.MR_WORKSPACE_ID,
  logger: true,
});
let rechargeWorking = false;
const rechargeInterval =
  billingRuntime?.automaticChargesEnabled && workBillingOnce
    ? setInterval(() => {
        if (rechargeWorking) return;
        rechargeWorking = true;
        void workBillingOnce!()
          .catch((error) => {
            app.log.error({ err: error }, 'Background billing recharge tick failed');
          })
          .finally(() => {
            rechargeWorking = false;
          });
      }, 15_000)
    : undefined;
rechargeInterval?.unref();
const shutdown = async () => {
  if (rechargeInterval) clearInterval(rechargeInterval);
  await app.close();
  await engine?.close();
  process.exit(0);
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 4310) });
