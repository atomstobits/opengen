import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import type { GenerateInput } from '@media-router/contracts';
import {
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
  type CheckoutOrder,
  type CheckoutSession,
  type EngineOptions,
  type PaymentTransport,
  type Principal,
  type VerifiedPaymentEvent,
} from '@media-router/engine';
import { AttemptCredentialStore } from '../packages/engine/src/attempt-credentials.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import type { DeliveryScope, DeliverySource } from '../packages/engine/src/delivery.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

const external = vi.hoisted(() => ({
  request: vi.fn(() => {
    throw new Error('The fixture forbids real HTTPS requests.');
  }),
}));
// Output downloads use node:https rather than fetch. Keep that separate escape
// path controlled too, even if a missing execution gate reaches it.
vi.mock('node:https', async (original) => ({
  ...(await original<typeof import('node:https')>()),
  request: external.request,
}));

const databaseUrl = process.env.TEST_DATABASE_URL;
const videoInput: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  operation: 'text-to-video',
  routing: { fallback: false },
  input: {
    prompt: 'Synthetic provider isolation fixture; no external generation is permitted.',
    resolution: '480p',
    duration: 2,
  },
};
const deploymentId = catalog.routes.find((route) => route.id === videoInput.routeId)!.deploymentId;
const comparisonRoutes: [string, string] = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.0-pro',
];
const disabledError = { code: 'provider_execution_disabled', statusCode: 503 };
let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    cleanup = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    external.request.mockClear();
  }
});

async function fixture() {
  const database = await isolatedEngineDatabase(databaseUrl!, 'billing_provider_gate');
  const upstreamId = `fixture-original-${randomUUID()}`;
  const response = { timeout: false, unknown: false };
  const request = vi.fn<typeof fetch>(async (target, options) => {
    const url = new URL(String(target));
    if (
      ![
        'fixture-managed.ap-southeast-1.maas.aliyuncs.com',
        'fixture-byok.ap-southeast-1.maas.aliyuncs.com',
      ].includes(url.hostname)
    )
      throw new Error('Unexpected synthetic provider destination.');
    if (options?.method === 'POST') {
      if (response.timeout) throw new TypeError('Synthetic submission timeout.');
      return Response.json({ output: { task_id: upstreamId } });
    }
    if (url.pathname !== `/api/v1/tasks/${upstreamId}`)
      throw new Error('The fixture may only read its original provider task.');
    return Response.json({ output: { task_status: response.unknown ? 'UNKNOWN' : 'RUNNING' } });
  });
  vi.stubGlobal('fetch', request);
  const options: EngineOptions = {
    databaseUrl: database.databaseUrl,
    poolSize: 1,
    statusPoolSize: 1,
    vaultKey: 'cd'.repeat(32),
    providerEnv: {
      NODE_ENV: 'test',
      ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture-managed-not-a-provider-credential',
      ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID: 'fixture-managed',
      XAI_API_KEY: 'fixture-xai-not-a-provider-credential',
      BYTEPLUS_API_KEY: 'fixture-byteplus-not-a-provider-credential',
    },
    storage: privateStorageFixture(),
    pollIntervalMs: 0,
  };
  const engines = [database.bind(createEngine(options))];
  const enabled = engines[0]!;
  cleanup = async () => {
    for (const engine of engines) if (!engine.pool.ended) await engine.close();
    await database.close();
  };
  await enabled.initialize();
  const workspaceId = `provider-gate-${randomUUID()}`;
  await enabled.ensureWorkspace(workspaceId, 10_000_000);
  await enabled.accounts.putConnection(workspaceId, deploymentId, {
    apiKey: 'fixture-byok-not-a-provider-credential',
    workspaceId: 'fixture-byok',
  });
  const owner: Principal = { workspaceId, scopes: ['read', 'generate'], bootstrap: true };
  return {
    enabled,
    workspaceId,
    owner,
    request,
    response,
    upstreamId,
    databaseUrl: database.databaseUrl,
    async reopenDisabled() {
      if (!enabled.pool.ended) await enabled.close();
      // Match the sandbox's empty managed adapter list. Stored/frozen BYOK
      // credentials previously rebuilt default adapters around that list.
      const disabled = database.bind(
        createEngine({ ...options, adapters: [], providerExecutionEnabled: false }),
      );
      engines.push(disabled);
      await disabled.initialize();
      return disabled;
    },
  };
}

type Engine = ReturnType<typeof createEngine>;
type DirectDelivery = {
  refreshDelivery(scope: DeliveryScope, slot: number): Promise<DeliverySource>;
  downloadDelivery(
    source: Extract<DeliverySource, { kind: 'url' }>,
    scope: DeliveryScope,
  ): Promise<Buffer>;
};

async function financialAndExecutionSnapshot(engine: Engine, workspaceId: string) {
  return {
    balance: await engine.getBalance(workspaceId),
    ledger: await engine.ledger(workspaceId),
    jobs: (
      await engine.pool.query('SELECT * FROM mr_jobs WHERE workspace_id=$1 ORDER BY id', [
        workspaceId,
      ])
    ).rows,
    attempts: (
      await engine.pool.query(
        `SELECT a.* FROM mr_attempts a JOIN mr_jobs j ON j.id=a.job_id
         WHERE j.workspace_id=$1 ORDER BY a.job_id,a.number`,
        [workspaceId],
      )
    ).rows,
    slots: (
      await engine.pool.query(
        'SELECT * FROM mr_dispatch_slots WHERE workspace_id=$1 ORDER BY job_id,attempt_number',
        [workspaceId],
      )
    ).rows,
    receipts: (
      await engine.pool.query(
        'SELECT * FROM mr_output_receipts WHERE workspace_id=$1 ORDER BY job_id,attempt,slot',
        [workspaceId],
      )
    ).rows,
  };
}

describe.skipIf(!databaseUrl)('billing sandbox provider execution isolation', () => {
  it('blocks stored BYOK and managed admission, including an existing comparison approval, before credential access', async () => {
    const f = await fixture();
    const pair = await f.enabled.quoteComparison(
      f.owner,
      'Synthetic comparison admission fixture.',
      comparisonRoutes,
    );
    const disabled = await f.reopenDisabled();
    const connection = vi.spyOn(disabled.accounts, 'getConnection');
    const freeze = vi.spyOn(AttemptCredentialStore.prototype, 'freezeAdmission');
    const read = vi.spyOn(AttemptCredentialStore.prototype, 'read');
    const before = await financialAndExecutionSnapshot(disabled, f.workspaceId);
    expect(before.jobs).toEqual([]);
    expect(await disabled.accounts.listConnections(f.workspaceId)).toEqual([
      expect.objectContaining({ deployment_id: deploymentId }),
    ]);

    expect(disabled.getExecutableRouteIds()).toEqual([]);
    for (const billing of ['byok', 'managed'] as const) {
      const input = { ...videoInput, billing };
      expect(await disabled.executableForWorkspace(f.workspaceId, input)).toEqual([]);
      await expect(
        disabled.submit({ workspaceId: f.workspaceId, idempotencyKey: randomUUID(), input }),
      ).rejects.toMatchObject(disabledError);
      await expect(
        disabled.resolveInput(f.workspaceId, input, { forDispatch: true }),
      ).rejects.toMatchObject(disabledError);
    }
    await expect(
      disabled.quoteComparison(f.owner, 'A blocked comparison.', comparisonRoutes),
    ).rejects.toMatchObject(disabledError);
    await expect(disabled.submitComparison(f.owner, pair.id)).rejects.toMatchObject(disabledError);
    expect(await disabled.workOnce()).toBe(false);
    expect(await disabled.recoverDeliveryOnce()).toBe(false);

    expect(await financialAndExecutionSnapshot(disabled, f.workspaceId)).toEqual(before);
    expect(await disabled.getComparison(f.workspaceId, pair.id)).toEqual(pair);
    expect(connection).not.toHaveBeenCalled();
    expect(freeze).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  });

  it('returns an admitted comparison with its original child IDs while further admission is disabled', async () => {
    const f = await fixture();
    const quote = await f.enabled.quoteComparison(
      f.owner,
      'Synthetic accepted comparison fixture.',
      comparisonRoutes,
    );
    const original = await f.enabled.submitComparison(f.owner, quote.id);
    expect(original.jobs).toHaveLength(2);
    const before = await financialAndExecutionSnapshot(f.enabled, f.workspaceId);
    const disabled = await f.reopenDisabled();
    const replay = await disabled.submitComparison(f.owner, quote.id);
    expect(replay).toEqual(original);
    expect(replay.jobs.map((job) => job.id)).toEqual(original.jobs.map((job) => job.id));
    expect(await disabled.workOnce()).toBe(false);
    expect(await financialAndExecutionSnapshot(disabled, f.workspaceId)).toEqual(before);
    expect(f.request).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  });

  it('fulfills one USD5 Checkout through the production credit path while provider execution stays disabled', async () => {
    const f = await fixture();
    const disabled = await f.reopenDisabled();
    const processorEnvironment = {
      id: 'billing-provider-pause-fixture',
      accountId: 'acct_providerpausefixture',
      livemode: false,
    };
    await registerBillingProcessorEnvironmentInTransaction(disabled.pool, processorEnvironment);
    const payments = new PaymentStore(disabled.pool, {
      livemode: false,
      processorEnvironment,
      creditInTransaction: creditWorkspaceInTransaction,
    });
    let session: CheckoutSession | undefined;
    const createSession = vi.fn(async (order: CheckoutOrder): Promise<CheckoutSession> => {
      session = {
        id: `cs_test_${randomUUID().replaceAll('-', '')}`,
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: order.amountCents,
        amount_total: order.amountCents,
        payment_status: 'unpaid',
        status: 'open',
        client_reference_id: order.id,
        payment_intent: null,
        livemode: false,
        url: 'https://checkout.stripe.com/c/pay/test_provider_pause_fixture',
      };
      return { ...session };
    });
    const retrieveSession = vi.fn(async (id: string): Promise<CheckoutSession> => {
      if (!session || id !== session.id) throw new Error('Unexpected fixture Checkout session.');
      return { ...session };
    });
    const transport: PaymentTransport = {
      processorEnvironment,
      assertProcessorEnvironment() {},
      createSession,
      retrieveSession,
    };
    const before = await disabled.getBalance(f.workspaceId);
    const order = await payments.createOrder(f.workspaceId, 500, randomUUID());
    expect(order).toMatchObject({ amountCents: 500, creditMicros: 5_000_000, currency: 'USD' });
    expect((await payments.checkout(f.workspaceId, order.id, transport)).status).toBe(
      'checkout_open',
    );
    session = {
      ...session!,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: `pi_fixture_${randomUUID().replaceAll('-', '')}`,
    };
    // Model an already verified delivery and the matching authoritative GET.
    // This is local reconciliation proof, not a Stripe signature/browser test.
    const paid: VerifiedPaymentEvent = {
      id: `evt_fixture_${randomUUID().replaceAll('-', '')}`,
      type: 'checkout.session.completed',
      livemode: false,
      processorEnvironment,
      data: { object: { ...session } },
    };
    await expect(payments.reconcile(paid, transport)).resolves.toEqual({ received: true });
    const creditedBalance = await disabled.getBalance(f.workspaceId);
    const creditedLedger = await disabled.ledger(f.workspaceId);
    expect(creditedBalance).toEqual({
      ...before,
      availableMicros: before.availableMicros + 5_000_000,
    });
    expect(creditedLedger.filter((entry) => entry.kind === 'credit')).toEqual([
      expect.objectContaining({
        amount_micros: '5000000',
        available_delta_micros: '5000000',
        reserved_delta_micros: '0',
      }),
    ]);
    expect(
      (
        await disabled.pool.query(
          "SELECT reference,amount_micros FROM mr_ledger WHERE workspace_id=$1 AND kind='credit'",
          [f.workspaceId],
        )
      ).rows,
    ).toEqual([{ reference: `stripe-topup:${order.id}`, amount_micros: '5000000' }]);
    await expect(payments.reconcile(paid, transport)).resolves.toEqual({
      received: true,
      duplicate: true,
    });
    expect(await payments.getOrder(f.workspaceId, order.id)).toMatchObject({
      status: 'credited',
      creditedAt: expect.any(String),
    });
    await expect(
      disabled.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...videoInput, billing: 'byok' },
      }),
    ).rejects.toMatchObject(disabledError);
    expect(await disabled.workOnce()).toBe(false);
    expect(await disabled.getBalance(f.workspaceId)).toEqual(creditedBalance);
    expect(await disabled.ledger(f.workspaceId)).toEqual(creditedLedger);
    expect(await disabled.listJobs(f.workspaceId)).toEqual([]);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(retrieveSession).toHaveBeenCalledTimes(1);
    expect(f.request).not.toHaveBeenCalled();
    expect(external.request).not.toHaveBeenCalled();
  });

  it.skipIf(process.env.TEST_NATIVE_POSTGRES !== '1')(
    'runs the official worker once with only the shared false control and preserves its frozen BYOK queue',
    async () => {
      const f = await fixture();
      const original = await f.enabled.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...videoInput, billing: 'byok' },
      });
      const before = await financialAndExecutionSnapshot(f.enabled, f.workspaceId);
      expect(before.jobs).toEqual([
        expect.objectContaining({ id: original.id, status: 'queued', attempt_count: 0 }),
      ]);
      expect(
        (
          await f.enabled.pool.query(
            'SELECT kind,ciphertext IS NOT NULL AS encrypted FROM mr_job_credentials WHERE job_id=$1',
            [original.id],
          )
        ).rows,
      ).toEqual([{ kind: 'byok', encrypted: true }]);
      await f.enabled.close();

      const entry = new URL('../apps/server/src/worker.ts', import.meta.url).href;
      const script = `
        import { createRequire, syncBuiltinESMExports } from 'node:module';
        const require = createRequire(import.meta.url);
        let providerCalls = 0;
        const refuseHttp = () => {
          providerCalls++;
          throw new Error('The worker fixture forbids external HTTP transport.');
        };
        globalThis.fetch = refuseHttp;
        for (const name of ['node:http', 'node:https']) {
          const transport = require(name);
          transport.request = refuseHttp;
          transport.get = refuseHttp;
        }
        syncBuiltinESMExports();
        const realTimeout = globalThis.setTimeout;
        let turns = 0;
        globalThis.setTimeout = (callback, delay, ...args) => {
          if (delay === 2000 && process.listenerCount('SIGTERM') > 0) {
            turns++;
            process.emit('SIGTERM');
            return realTimeout(callback, 0, ...args);
          }
          return realTimeout(callback, delay, ...args);
        };
        await import(${JSON.stringify(entry)});
        console.log(JSON.stringify({ turns, providerCalls }));
      `;
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', script],
        {
          cwd: fileURLToPath(new URL('../', import.meta.url)),
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            NODE_ENV: 'test',
            DATABASE_URL: f.databaseUrl,
            MR_DATABASE_POOL_SIZE: '1',
            MR_VAULT_KEY: 'cd'.repeat(32),
            OPENGEN_PROVIDER_EXECUTION_ENABLED: 'false',
            // Configure private storage so a missing worker gate would reach
            // the queued BYOK submission rather than return for absent storage.
            S3_BUCKET: 'fixture-worker-no-network',
            S3_ENDPOINT: 'https://storage.invalid',
            S3_REGION: 'us-east-1',
            AWS_ACCESS_KEY_ID: 'fixture-not-an-aws-key',
            AWS_SECRET_ACCESS_KEY: 'fixture-not-an-aws-secret',
            AWS_EC2_METADATA_DISABLED: 'true',
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(0);
      expect(child.stderr).not.toContain('Worker iteration failed');
      expect(JSON.parse(child.stdout.trim())).toEqual({ turns: 1, providerCalls: 0 });
      const disabled = await f.reopenDisabled();
      expect(await financialAndExecutionSnapshot(disabled, f.workspaceId)).toEqual(before);
      expect(f.request).not.toHaveBeenCalled();
      expect(external.request).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['managed', 'byok'] as const).flatMap((billing) =>
      (['queued', 'running', 'known-unknown', 'timeout'] as const).map((phase) => ({
        billing,
        phase,
      })),
    ),
  )(
    'preserves a frozen $billing $phase original across disabled restart without provider I/O or refunds',
    async ({ billing, phase }) => {
      const f = await fixture();
      const idempotencyKey = randomUUID();
      const input = { ...videoInput, billing };
      const original = await f.enabled.submit({
        workspaceId: f.workspaceId,
        idempotencyKey,
        input,
      });
      if (phase !== 'queued') {
        f.response.timeout = phase === 'timeout';
        expect(await f.enabled.workOnce()).toBe(true);
        if (phase === 'known-unknown') {
          f.response.unknown = true;
          expect(await f.enabled.workOnce()).toBe(true);
        }
      }
      const current = await financialAndExecutionSnapshot(f.enabled, f.workspaceId);
      const row = current.jobs[0]!;
      expect(row).toMatchObject({
        id: original.id,
        status:
          phase === 'queued' ? 'queued' : phase === 'running' ? 'running' : 'submission-unknown',
        settled_micros: null,
        attempt_count: phase === 'queued' ? 0 : 1,
        upstream_id: phase === 'running' || phase === 'known-unknown' ? f.upstreamId : null,
      });
      expect(current.balance.reservedMicros).toBe(billing === 'byok' ? 0 : original.reservedMicros);
      if (billing === 'managed') expect(current.balance.reservedMicros).toBeGreaterThan(0);
      const credentials = (
        await f.enabled.pool.query(
          'SELECT kind,identity,ciphertext IS NOT NULL AS encrypted FROM mr_job_credentials WHERE job_id=$1',
          [original.id],
        )
      ).rows;
      expect(credentials).toEqual([
        expect.objectContaining({ kind: billing, identity: expect.any(String), encrypted: true }),
      ]);
      const scope: DeliveryScope = {
        workspaceId: f.workspaceId,
        jobId: original.id,
        attempt: row.attempt_count,
        routeId: row.route_snapshot.id,
        deploymentId: row.deployment_snapshot.id,
        upstreamId: row.upstream_id,
        providerConnectionId: phase === 'queued' ? null : credentials[0]!.identity,
      };
      if (scope.upstreamId)
        await f.enabled.delivery.capture(scope, [
          {
            kind: 'url',
            url: 'https://93.184.216.34/fixture.mp4',
            mediaType: 'video/mp4',
            refreshable: true,
          },
        ]);
      const before = await financialAndExecutionSnapshot(f.enabled, f.workspaceId);
      if (scope.upstreamId)
        expect(before.receipts).toEqual([
          expect.objectContaining({
            state: 'pending',
            attempts: 0,
            lease_until: null,
            lease_token: null,
            error_code: null,
          }),
        ]);
      expect(f.request).toHaveBeenCalledTimes(
        phase === 'queued' ? 0 : phase === 'known-unknown' ? 2 : 1,
      );
      // The enabled positive control above used only our local transport. Once
      // disabled, even a persisted accepted task must not reach it or decrypt.
      f.request.mockClear();
      const disabled = await f.reopenDisabled();
      const connection = vi.spyOn(disabled.accounts, 'getConnection');
      const read = vi.spyOn(AttemptCredentialStore.prototype, 'read');
      const readAdmission = vi.spyOn(AttemptCredentialStore.prototype, 'readAdmission');
      const freeze = vi.spyOn(AttemptCredentialStore.prototype, 'freeze');
      expect(
        await disabled.submit({ workspaceId: f.workspaceId, idempotencyKey, input }),
      ).toMatchObject({ id: original.id, status: row.status });
      expect(await disabled.workOnce()).toBe(false);
      expect(await disabled.workOnce()).toBe(false);
      expect(await disabled.recoverDeliveryOnce()).toBe(false);
      expect(await disabled.delivery.recoverOne()).toBe(false);
      const direct = disabled as unknown as DirectDelivery;
      if (scope.upstreamId)
        await expect(direct.refreshDelivery(scope, 0)).rejects.toMatchObject(disabledError);
      // A public IP avoids DNS; the separately mocked HTTPS transport guarantees
      // an accidentally unguarded output download still cannot reach a socket.
      await expect(
        direct.downloadDelivery(
          { kind: 'url', url: 'https://93.184.216.34/fixture.mp4', mediaType: 'video/mp4' },
          scope,
        ),
      ).rejects.toMatchObject(disabledError);
      if (phase !== 'queued')
        await expect(disabled.cancel(f.workspaceId, original.id)).rejects.toMatchObject({
          code: 'cancellation_unconfirmed',
        });

      expect(await financialAndExecutionSnapshot(disabled, f.workspaceId)).toEqual(before);
      expect(await disabled.getJob(f.workspaceId, original.id)).toMatchObject({
        id: original.id,
        status: row.status,
        attemptCount: row.attempt_count,
        settledMicros: null,
      });
      expect(connection).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(readAdmission).not.toHaveBeenCalled();
      expect(freeze).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(external.request).not.toHaveBeenCalled();
    },
  );
});
