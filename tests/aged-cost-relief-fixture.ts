import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import { catalog } from '@media-router/catalog';
import {
  AccountGovernanceStore,
  AgedCostReliefStore,
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
  SubmissionRejected,
  type CheckoutSession,
  type PaymentTransport,
  type ProviderAdapter,
} from '@media-router/engine';
import { createFeePolicy } from '../packages/engine/src/billing-fees.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { staffRefundHash } from '../packages/engine/src/staff-refunds.js';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

export const agedReliefPolicyVersion = 'fixture-credit-policy-section-8-v1';
export const agedReliefRoute = 'alibaba/ap-southeast-1/wan-3.0';
export const agedReliefFallbackRoutes = [agedReliefRoute, 'alibaba/cn-beijing/wan-3.0'] as const;
export const agedReliefOpeningMicros = 1_000_000;
export const agedReliefInput: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  billing: 'managed',
  routing: { fallback: false },
  input: {
    prompt: 'Synthetic aged-cost accounting fixture.',
    resolution: '720p',
    duration: 2,
  },
};

export function agedCostReliefTestDatabaseUrl(value: string | undefined) {
  if (!value) throw new Error('The aged-cost fixture requires TEST_DATABASE_URL.');
  const target = new URL(value);
  const database = decodeURIComponent(target.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
    target.search !== '' ||
    target.hash !== '' ||
    !(
      ['postgres', 'opengen_test'].includes(database) ||
      database.startsWith('opengen_aged_cost_relief_') ||
      database.startsWith('opengen_core_qualification_')
    )
  )
    throw new Error('Aged-cost fixtures require a named loopback ephemeral database.');
  return value;
}

type ReliefOptions = ConstructorParameters<typeof AgedCostReliefStore>[1];
type ReliefTarget = Parameters<AgedCostReliefStore['review']>[0];
type ReliefGrant = Parameters<AgedCostReliefStore['grant']>[0];
type ReliefReview = Awaited<ReturnType<AgedCostReliefStore['review']>>;

/** Real admission, wallet and worker paths with isolated synthetic storage and adapters. */
export async function agedCostReliefFixture(
  options: { fee?: boolean; paid?: boolean; fallback?: boolean; rejectFirst?: boolean } = {},
) {
  if (options.fee && (options.fallback || options.rejectFirst))
    throw new Error('The rejected-predecessor fixture exercises only legacy zero-fee fallback.');
  const databaseUrl = agedCostReliefTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const database = await isolatedEngineDatabase(databaseUrl, 'aged_cost_relief');
  const behavior = new Map<string, 'accepted' | 'unknown'>();
  let rejectedFirst = false;
  const submit = vi.fn<ProviderAdapter['submit']>(async ({ jobId }) => {
    if (behavior.get(jobId) === 'unknown')
      throw new Error('Synthetic unknown acceptance. The original request must be recovered.');
    if (options.rejectFirst && !rejectedFirst) {
      rejectedFirst = true;
      throw new SubmissionRejected('Synthetic legacy rejection with unresolved cost.');
    }
    return { upstreamId: `fixture-aged-${jobId}` };
  });
  const poll = vi.fn<ProviderAdapter['poll']>(async ({ jobId, upstreamId }) => {
    if (upstreamId !== `fixture-aged-${jobId}`)
      throw new Error('Aged-cost recovery must use the original task.');
    return { status: 'running' };
  });
  const policy = createFeePolicy({
    id: 'fixture-aged-cost-fee',
    version: 1,
    activation: 'fixture',
    basisPoints: 500,
    eligibleOutcomes: ['succeeded'],
    overrunAllocation: 'provider-first',
  });
  const engine = database.bind(
    createEngine({
      databaseUrl: database.databaseUrl,
      poolSize: process.env.TEST_NATIVE_POSTGRES === '1' ? 3 : 1,
      statusPoolSize: 1,
      storage: privateStorageFixture(),
      vaultKey: 'de'.repeat(32),
      providerEnv: {},
      pollIntervalMs: 0,
      ...(options.fee ? { fixtureBillingPolicy: policy } : {}),
      adapters: [
        {
          id: 'alibaba',
          isConfigured: (route) =>
            options.fallback
              ? agedReliefFallbackRoutes.some((id) => id === route.id)
              : route.id === agedReliefRoute,
          submit,
          poll,
        },
      ],
    }),
  );
  const context = Object.freeze({ staff: Symbol('synthetic-aged-cost-review') });
  let authorized = true;
  const approvals: { input: ReliefGrant; reviewed: ReliefReview }[] = [];
  const authoritySessions = new Set<number>();
  const storeOptions: ReliefOptions = {
    activation: 'staff-approved',
    policyVersion: agedReliefPolicyVersion,
    creditInTransaction: creditWorkspaceInTransaction,
    authorize: async (client, supplied) => {
      if (!authorized || supplied !== context)
        throw new Error('Current synthetic installation staff authority is required.');
      if (process.env.TEST_NATIVE_POSTGRES === '1') {
        const result = await client.query('SELECT pg_backend_pid() AS id');
        authoritySessions.add(result.rows[0].id as number);
      }
      return { kind: 'installation-operator', id: 'fixture-aged-cost-owner' };
    },
    approveRelief: async (_client, supplied, request) => {
      const approved = approvals.find(
        ({ input, reviewed }) =>
          input.reference === request.reference &&
          input.note === request.note &&
          input.evidenceUrl === request.evidenceUrl &&
          input.workspaceId === request.workspaceId &&
          input.jobId === request.jobId &&
          input.snapshotHash === request.snapshotHash &&
          reviewed.amountMicros === request.amountMicros &&
          staffRefundHash(reviewed.snapshot) === staffRefundHash(request.snapshot) &&
          staffRefundHash(reviewed.allocation) === staffRefundHash(request.allocation),
      );
      if (supplied !== context || !approved)
        throw new Error('The exact current financial packet needs independent approval.');
      if (
        request.policyVersion !== agedReliefPolicyVersion ||
        request.requestVersion !== 'aged-cost-relief-v1' ||
        request.requestHash !==
          staffRefundHash({
            input: approved.input,
            policyVersion: agedReliefPolicyVersion,
            requestVersion: request.requestVersion,
          })
      )
        throw new Error('A different policy cannot inherit this fixture approval.');
      return {
        approvalReference: 'fixture-independent-aged-cost-approval',
        requestHash: request.requestHash,
      };
    },
  };
  const store = new AgedCostReliefStore(engine.pool, storeOptions);
  const close = async () => {
    if (!engine.pool.ended) await engine.close();
    await database.close();
  };
  try {
    await engine.initialize();
    const workspaceId = `aged-relief-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, options.paid ? 0 : agedReliefOpeningMicros);
    const processorEnvironment = {
      id: `aged-relief-${randomUUID()}`,
      accountId: `acct_fixture${randomUUID().replaceAll('-', '')}`,
      livemode: false,
    };
    let originalPayment: {
      orderId: string;
      paymentIntentId: string;
      createdAt: string;
      creditedAt: string;
    } | null = null;
    if (options.paid) {
      await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
      const payments = new PaymentStore(engine.pool, {
        livemode: false,
        processorEnvironment,
        creditInTransaction: creditWorkspaceInTransaction,
      });
      let session: CheckoutSession;
      const transport: PaymentTransport = {
        processorEnvironment,
        assertProcessorEnvironment() {},
        createSession: async (order) => {
          session = {
            id: `cs_test_aged${order.id.replaceAll('-', '')}`,
            mode: 'payment',
            currency: 'usd',
            amount_subtotal: order.amountCents,
            amount_total: order.amountCents,
            payment_status: 'unpaid',
            status: 'open',
            client_reference_id: order.id,
            payment_intent: null,
            livemode: false,
            url: 'https://checkout.stripe.com/c/pay/synthetic_aged_fixture',
          };
          return { ...session };
        },
        retrieveSession: async (id) => {
          if (id !== session.id)
            throw new Error('Only the original synthetic Checkout may be retrieved.');
          return { ...session };
        },
      };
      const order = await payments.createOrder(workspaceId, 500, randomUUID());
      await payments.checkout(workspaceId, order.id, transport);
      const paymentIntentId = `pi_aged${order.id.replaceAll('-', '')}`;
      Object.assign(session!, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: paymentIntentId,
      });
      await payments.reconcile(
        {
          id: `evt_aged_paid_${order.id.replaceAll('-', '')}`,
          type: 'checkout.session.completed',
          livemode: false,
          processorEnvironment,
          data: { object: { ...session! } },
        },
        transport,
      );
      const paid = (
        await engine.pool.query<{ created_at: Date; credited_at: Date }>(
          'SELECT created_at,credited_at FROM mr_payment_orders WHERE id=$1',
          [order.id],
        )
      ).rows[0]!;
      originalPayment = {
        orderId: order.id,
        paymentIntentId,
        createdAt: paid.created_at.toISOString(),
        creditedAt: paid.credited_at.toISOString(),
      };
    }
    const originalCredit = (
      await engine.pool.query<{ id: string }>(
        `SELECT id FROM mr_ledger WHERE workspace_id=$1 AND ${options.paid ? "kind='credit'" : "kind='opening'"}`,
        [workspaceId],
      )
    ).rows[0]!;
    const key = await new AccountGovernanceStore(engine.pool).createKey(
      { workspaceId, bootstrap: true, scopes: ['read', 'generate', 'keys:write'] },
      {
        name: 'Synthetic aged-cost key',
        scopes: ['read', 'generate'],
        monthlyCapMicros: agedReliefOpeningMicros,
      },
    );
    const principal = await engine.accounts.authenticate(key.token);
    if (!principal) throw new Error('Fixture key must authenticate before admission.');
    const request: GenerateInput = {
      ...agedReliefInput,
      ...(options.fallback ? { routing: { fallback: true } } : {}),
      ...(options.fee
        ? { feeAcceptance: { policyId: policy.id, policyVersion: policy.version } }
        : {}),
    };
    const admit = async (
      settings: { unknown?: boolean; queued?: boolean; hours?: number; byok?: boolean } = {},
    ) => {
      if (settings.byok)
        await engine.accounts.putConnection(
          workspaceId,
          catalog.routes.find((route) => route.id === agedReliefRoute)!.deploymentId,
          {
            apiKey: 'synthetic-aged-cost-byok',
            workspaceId: 'synthetic-aged-cost-provider-workspace',
          },
        );
      const job = await engine.submit({
        workspaceId,
        idempotencyKey: randomUUID(),
        input: settings.byok ? { ...request, billing: 'byok', feeAcceptance: undefined } : request,
        principal,
      });
      if (settings.unknown) behavior.set(job.id, 'unknown');
      // BYOK is admitted only to demonstrate its zero OpenGen reservation.
      // Its real adapter must never be dispatched by this in-memory fixture.
      if (!settings.queued && !settings.byok)
        await workUntilJob(engine, workspaceId, job.id, (value) =>
          options.rejectFirst
            ? value.status === 'queued' && value.attemptCount === 1
            : value.status === (settings.unknown ? 'submission-unknown' : 'running'),
        );
      await engine.pool.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-($2 * interval '1 hour') WHERE job_id=$1",
        [job.id, settings.hours ?? 25],
      );
      return (await engine.getJob(workspaceId, job.id))!;
    };
    const target = (job: { id: string; reservedMicros: number }): ReliefTarget => ({
      workspaceId,
      jobId: job.id,
      allocation: [{ ledgerId: originalCredit.id, amountMicros: job.reservedMicros }],
    });
    const packet = async (
      job: { id: string; reservedMicros: number },
      reference: string = randomUUID(),
    ) => {
      const selected = target(job);
      const reviewed = await store.review(selected, context);
      const input: ReliefGrant = {
        ...selected,
        reference,
        note: 'Synthetic documented aged-cost customer remedy.',
        evidenceUrl: 'https://fixture.invalid/aged-cost-decision',
        snapshotHash: reviewed.snapshotHash,
      };
      approvals.push({ input: JSON.parse(JSON.stringify(input)) as ReliefGrant, reviewed });
      return { input, reviewed };
    };
    const keyExposure = async () =>
      (
        await engine.pool.query(
          'SELECT admission_month::text,gross_debit_micros::text,held_micros::text FROM mr_key_months WHERE workspace_id=$1 AND key_id=$2 ORDER BY admission_month',
          [workspaceId, key.id],
        )
      ).rows;
    const originalJobRecords = async (jobId: string) => {
      const records: Record<string, unknown> = {};
      for (const [name, filter] of [
        ['mr_jobs', 'id'],
        ['mr_attempts', 'job_id'],
        ['mr_job_credentials', 'job_id'],
        ['mr_attempt_credentials', 'job_id'],
        ['mr_key_reservations', 'job_id'],
        ['mr_dispatch_slots', 'job_id'],
      ])
        records[name!] = (
          await engine.pool.query(
            `SELECT row_to_json(t)::text AS row FROM ${name} t WHERE ${filter}=$1 ORDER BY row_to_json(t)::text`,
            [jobId],
          )
        ).rows;
      return records;
    };
    return {
      engine,
      store,
      storeOptions,
      context,
      workspaceId,
      key,
      policy,
      request,
      originalCredit,
      processorEnvironment,
      originalPayment,
      submit,
      poll,
      authoritySessions,
      target,
      packet,
      admit,
      keyExposure,
      originalJobRecords,
      revoke: () => {
        authorized = false;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
