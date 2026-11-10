import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import {
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
  type CheckoutSession,
  type PaymentTransport,
  type Principal,
  type ProviderAdapter,
} from '@media-router/engine';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

export const staffRefundRoutes: [string, string] = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.0-pro',
];
export const staffRefundInput: GenerateInput = {
  modelId: 'xai/grok-imagine-image-2.0',
  routeId: staffRefundRoutes[0],
  operation: 'text-to-image',
  billing: 'managed',
  routing: { fallback: false },
  input: { prompt: 'Synthetic private staff-refund accounting fixture.', count: 1 },
};
export type StaffRefundJobBehavior = {
  submission?: 'known' | 'unknown';
  status?: 'running' | 'failed';
  billedCostMicros?: number | null;
  retryAfterMs?: number;
};

/** Full engine and real funding ledger, isolated to an ephemeral test schema.
 * Only TEST_DATABASE_URL is accepted; no application/production URL fallback.
 * Provider and processor transports below are entirely in-memory. */
export function staffRefundTestDatabaseUrl(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('The staff refund fixture requires TEST_DATABASE_URL.');
  const target = new URL(databaseUrl);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.search !== '' ||
    target.hash !== '' ||
    name === 'opengen_billing_sandbox_261106' ||
    !(
      ['postgres', 'opengen_test'].includes(name) ||
      name.startsWith('opengen_staff_refund_') ||
      name.startsWith('opengen_core_qualification_')
    )
  )
    throw new Error('Staff refund tests require an explicitly named loopback ephemeral database.');
  return databaseUrl;
}
export async function staffRefundFixture() {
  const databaseUrl = staffRefundTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const database = await isolatedEngineDatabase(databaseUrl, 'staff_refund');
  const behavior = new Map<string, StaffRefundJobBehavior>();
  const submit = vi.fn<ProviderAdapter['submit']>(async ({ jobId }) => {
    if (behavior.get(jobId)?.submission === 'unknown')
      throw new Error('Synthetic unknown acceptance; never send a replacement.');
    return { upstreamId: `fixture-original-${jobId}` };
  });
  const poll = vi.fn<ProviderAdapter['poll']>(async ({ jobId, upstreamId }) => {
    if (upstreamId !== `fixture-original-${jobId}`)
      throw new Error('The fixture may poll only the original provider task.');
    const result = behavior.get(jobId) ?? {};
    return {
      status: result.status ?? 'running',
      ...(result.status === 'failed' ? { failureCategory: 'technical' as const } : {}),
      ...(result.billedCostMicros === undefined
        ? {}
        : { billedCostMicros: result.billedCostMicros }),
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    };
  });
  const engine = database.bind(
    createEngine({
      databaseUrl: database.databaseUrl,
      poolSize: 1,
      statusPoolSize: 1,
      storage: privateStorageFixture(),
      vaultKey: 'bc'.repeat(32),
      providerEnv: {},
      pollIntervalMs: 0,
      adapters: ['xai', 'byteplus'].map((id) => ({
        id,
        isConfigured: (route) => staffRefundRoutes.includes(route.id),
        submit,
        poll,
      })),
    }),
  );
  const close = async () => {
    if (!engine.pool.ended) await engine.close();
    await database.close();
  };
  try {
    await engine.initialize();
    const workspaceId = `staff-refund-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, 0);
    const owner: Principal = {
      workspaceId,
      scopes: ['read', 'generate', 'keys:write'],
      bootstrap: true,
    };
    const processorEnvironment = {
      id: `staff-refund-${randomUUID()}`,
      accountId: `acct_fixture${randomUUID().replaceAll('-', '')}`,
      livemode: false,
    };
    await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
    const payments = new PaymentStore(engine.pool, {
      livemode: false,
      processorEnvironment,
      creditInTransaction: creditWorkspaceInTransaction,
    });
    const sessions = new Map<string, CheckoutSession>();
    const creates = vi.fn<PaymentTransport['createSession']>(async (order) => {
      const session: CheckoutSession = {
        id: `cs_test_staff${order.id.replaceAll('-', '')}`,
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: order.amountCents,
        amount_total: order.amountCents,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: order.id,
        payment_intent: null,
        livemode: false,
        url: 'https://checkout.stripe.com/c/pay/synthetic_staff_fixture',
      };
      sessions.set(session.id, session);
      return { ...session };
    });
    const retrieves = vi.fn<PaymentTransport['retrieveSession']>(async (id) => {
      const session = sessions.get(id);
      if (!session) throw new Error('Unknown synthetic payment session.');
      return { ...session };
    });
    const transport: PaymentTransport = {
      processorEnvironment,
      assertProcessorEnvironment() {},
      createSession: creates,
      retrieveSession: retrieves,
    };
    async function fund(amountCents = 500) {
      const created = await payments.createOrder(workspaceId, amountCents, randomUUID());
      await payments.checkout(workspaceId, created.id, transport);
      const session = sessions.get(`cs_test_staff${created.id.replaceAll('-', '')}`)!;
      const paymentIntentId = `pi_staff${created.id.replaceAll('-', '')}`;
      Object.assign(session, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: paymentIntentId,
      });
      await payments.reconcile(
        {
          id: `evt_staff_paid_${created.id.replaceAll('-', '')}`,
          type: 'checkout.session.completed',
          livemode: false,
          processorEnvironment,
          data: { object: { ...session } },
        },
        transport,
      );
      return {
        order: await payments.getOrder(workspaceId, created.id),
        sessionId: session.id,
        paymentIntentId,
        amountCents,
      };
    }
    async function riskHold(
      order: Awaited<ReturnType<typeof fund>>,
      amountRefundedCents = order.amountCents,
    ) {
      const eventId = `evt_staff_risk_${randomUUID().replaceAll('-', '')}`;
      await payments.reconcile(
        {
          id: eventId,
          type: 'charge.refunded',
          livemode: false,
          processorEnvironment,
          data: {
            object: {
              id: `ch_staff${order.order.id.replaceAll('-', '')}`,
              object: 'charge',
              payment_intent: order.paymentIntentId,
              amount: order.amountCents,
              amount_refunded: amountRefundedCents,
              currency: 'usd',
              refunded: amountRefundedCents === order.amountCents,
            },
          },
        },
        transport,
      );
      return eventId;
    }
    async function due(jobId: string) {
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=clock_timestamp()-interval '1 second',lease_until=NULL WHERE id=$1",
        [jobId],
      );
    }
    return {
      database,
      engine,
      workspaceId,
      owner,
      processorEnvironment,
      payments,
      transport,
      behavior,
      submit,
      poll,
      creates,
      retrieves,
      fund,
      riskHold,
      due,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
