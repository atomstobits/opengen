import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import {
  AccountGovernanceStore,
  createEngine,
  type Principal,
  type ProviderAdapter,
} from '@media-router/engine';
import { createFeePolicy } from '../packages/engine/src/billing-fees.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const routes: [string, string] = [
  'xai-undisclosed/xai-grok-imagine-image-2.0',
  'byteplus-modelark-ap-southeast-1/bytedance-seedream-5.0-pro',
];
const policy = createFeePolicy({
  id: 'comparison-integration-fixture',
  version: 1,
  activation: 'fixture',
  basisPoints: 500,
  eligibleOutcomes: ['succeeded'],
  overrunAllocation: 'provider-first',
});
const input: GenerateInput = {
  modelId: 'xai/grok-imagine-image-2.0',
  operation: 'text-to-image',
  billing: 'managed',
  input: { prompt: 'Synthetic private billing and comparison fixture.', count: 1 },
  feeAcceptance: { policyId: policy.id, policyVersion: policy.version },
};
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

async function fixture() {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'billing_comparison');
  const submit = vi.fn<ProviderAdapter['submit']>(async () => {
    throw new Error('No provider request is permitted by this admission fixture.');
  });
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      poolSize: 1,
      statusPoolSize: 1,
      fixtureBillingPolicy: policy,
      storage: privateStorageFixture(),
      vaultKey: 'ab'.repeat(32),
      adapters: ['xai', 'byteplus'].map((id) => ({
        id,
        isConfigured: (route) => routes.includes(route.id),
        submit,
        poll: async () => {
          throw new Error('No provider polling is permitted by this admission fixture.');
        },
      })),
    }),
  );
  cleanup = async () => {
    await engine.close();
    await isolated.close();
  };
  await engine.initialize();
  const workspaceId = `billing-comparison-${randomUUID()}`;
  await engine.ensureWorkspace(workspaceId, 1_000_000);
  const owner: Principal = {
    workspaceId,
    scopes: ['read', 'generate', 'keys:write'],
    bootstrap: true,
  };
  const smartQuote = engine.quoteGeneration(input, { executableRouteIds: routes });
  const pairQuote = await engine.quoteComparison(owner, input.input.prompt as string, routes);
  return { engine, workspaceId, owner, smartQuote, pairQuote, submit };
}

describe.skipIf(!databaseUrl)('Billing fees and atomic comparison admission coexist', () => {
  it('reserves gross single-job credit and legacy comparison credit against the same capped key once', async () => {
    const f = await fixture();
    const gross = f.smartQuote.reservationMicros!;
    const combined = gross + f.pairQuote.ceilingMicros;
    expect(gross).toBeGreaterThan(
      f.smartQuote.candidates.find((candidate) => candidate.routeId === routes[0])!
        .estimatedCostMicros!,
    );
    const key = await new AccountGovernanceStore(f.engine.pool).createKey(f.owner, {
      name: 'Shared capped admission fixture',
      scopes: ['read', 'generate'],
      monthlyCapMicros: combined,
    });
    const principal = (await f.engine.accounts.authenticate(key.token))!;
    const idempotencyKey = randomUUID();
    const single = await f.engine.submit({
      workspaceId: f.workspaceId,
      idempotencyKey,
      input,
      principal,
    });
    expect(single).toMatchObject({
      reservedMicros: gross,
      billing: { ...input.feeAcceptance, costStatus: 'pending' },
    });
    const pair = await f.engine.submitComparison(principal, f.pairQuote.id);
    expect(pair.jobs).toHaveLength(2);
    expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
      availableMicros: 1_000_000 - combined,
      reservedMicros: combined,
    });
    const rows = (
      await f.engine.pool.query(
        'SELECT id,fee_admission,reserved_micros FROM mr_jobs WHERE workspace_id=$1',
        [f.workspaceId],
      )
    ).rows;
    expect(rows.find((row) => row.id === single.id)?.fee_admission).toMatchObject({
      schemaVersion: 1,
      customerCeilingMicros: gross,
      snapshot: { policy: { id: policy.id, version: policy.version } },
    });
    expect(rows.filter((row) => row.id !== single.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fee_admission: null }),
        expect.objectContaining({ fee_admission: null }),
      ]),
    );
    const reserveCount = (await f.engine.ledger(f.workspaceId)).filter(
      (entry) => entry.kind === 'reserve',
    ).length;
    expect(reserveCount).toBe(3);
    expect(
      (await f.engine.submit({ workspaceId: f.workspaceId, idempotencyKey, input, principal })).id,
    ).toBe(single.id);
    expect((await f.engine.submitComparison(principal, pair.id)).jobs.map((job) => job.id)).toEqual(
      pair.jobs.map((job) => job.id),
    );
    await expect(
      f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input,
        principal,
      }),
    ).rejects.toMatchObject({ code: 'key_monthly_cap_exceeded' });
    expect(await f.engine.listJobs(f.workspaceId)).toHaveLength(3);
    expect(
      (await f.engine.pool.query('SELECT held_micros FROM mr_key_months WHERE key_id=$1', [key.id]))
        .rows,
    ).toEqual([{ held_micros: String(combined) }]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it('rolls back both comparison children when prior gross fee exposure leaves room for only one', async () => {
    const f = await fixture();
    const gross = f.smartQuote.reservationMicros!;
    const firstCeiling = f.pairQuote.children[0].ceilingMicros;
    const key = await new AccountGovernanceStore(f.engine.pool).createKey(f.owner, {
      name: 'Pair rollback fixture',
      scopes: ['read', 'generate'],
      monthlyCapMicros: gross + firstCeiling,
    });
    const principal = (await f.engine.accounts.authenticate(key.token))!;
    const single = await f.engine.submit({
      workspaceId: f.workspaceId,
      idempotencyKey: randomUUID(),
      input,
      principal,
    });
    const before = await f.engine.getBalance(f.workspaceId);
    await expect(f.engine.submitComparison(principal, f.pairQuote.id)).rejects.toMatchObject({
      code: 'key_monthly_cap_exceeded',
    });
    expect(await f.engine.getBalance(f.workspaceId)).toEqual(before);
    expect((await f.engine.listJobs(f.workspaceId)).map((job) => job.id)).toEqual([single.id]);
    expect((await f.engine.getComparison(f.workspaceId, f.pairQuote.id))?.admittedAt).toBeNull();
    expect(
      (await f.engine.ledger(f.workspaceId)).filter((row) => row.kind === 'reserve'),
    ).toHaveLength(1);
    expect(
      (await f.engine.pool.query('SELECT held_micros FROM mr_key_months WHERE key_id=$1', [key.id]))
        .rows,
    ).toEqual([{ held_micros: String(gross) }]);
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each([
    { change: 'billing hold', code: 'billing_hold' },
    { change: 'reduced key cap', code: 'key_monthly_cap_exceeded' },
    { change: 'revoked key', code: 'policy_denied' },
  ])(
    'rechecks a $change after quoting without changing the original pair',
    async ({ change, code }) => {
      const f = await fixture();
      const governance = new AccountGovernanceStore(f.engine.pool);
      const key = await governance.createKey(f.owner, {
        name: 'Changed authority after comparison quote',
        scopes: ['read', 'generate'],
        monthlyCapMicros: f.pairQuote.ceilingMicros,
      });
      // Keep the authenticated snapshot: approval must consult current durable
      // authority and accounting, even with the fixture's one-connection pool.
      const principal = (await f.engine.accounts.authenticate(key.token))!;
      const pair = await f.engine.quoteComparison(principal, input.input.prompt as string, routes);
      const quoteBefore = (
        await f.engine.pool.query(
          `SELECT id,quote,child_key_nonce,expires_at,admitted_at,first_job_id,second_job_id
         FROM mr_comparison_runs WHERE workspace_id=$1 AND id=$2`,
          [f.workspaceId, pair.id],
        )
      ).rows;
      const balanceBefore = await f.engine.getBalance(f.workspaceId);
      const ledgerBefore = await f.engine.ledger(f.workspaceId);

      if (change === 'billing hold') {
        const orderId = randomUUID();
        const eventId = `evt_comparison_${randomUUID()}`;
        await f.engine.pool.query(
          `WITH payment AS (
           INSERT INTO mr_payment_orders
             (id,workspace_id,client_key,amount_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier)
           VALUES($1::uuid,$2,$1::uuid::text,500,5000000,false,$1::uuid::text,'comparison-hold-fixture') RETURNING id
         ), receipt AS (
           INSERT INTO mr_payment_events(id,type,object_id,livemode,order_id,state)
           SELECT $3,'charge.refunded','ch_comparison_hold',false,id,'processed' FROM payment
           RETURNING id,order_id
         )
         INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason)
         SELECT id,$2,order_id,'refund_requires_review' FROM receipt`,
          [orderId, f.workspaceId, eventId],
        );
      } else if (change === 'reduced key cap') {
        // One child still fits; failure on the second must roll back the first.
        await governance.updateKey(f.owner, key.id, {
          monthlyCapMicros: pair.children[0].ceilingMicros,
        });
      } else {
        expect(await governance.revokeKey(f.owner, key.id)).toBe(true);
      }

      await expect(f.engine.submitComparison(principal, pair.id)).rejects.toMatchObject({ code });
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(balanceBefore);
      expect(await f.engine.ledger(f.workspaceId)).toEqual(ledgerBefore);
      expect(await f.engine.listJobs(f.workspaceId)).toEqual([]);
      expect(await f.engine.getComparison(f.workspaceId, pair.id)).toEqual(pair);
      expect(
        (
          await f.engine.pool.query(
            `SELECT id,quote,child_key_nonce,expires_at,admitted_at,first_job_id,second_job_id
           FROM mr_comparison_runs WHERE workspace_id=$1 AND id=$2`,
            [f.workspaceId, pair.id],
          )
        ).rows,
      ).toEqual(quoteBefore);
      expect(
        (
          await f.engine.pool.query(
            'SELECT job_id FROM mr_key_reservations WHERE workspace_id=$1 AND key_id=$2',
            [f.workspaceId, key.id],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await f.engine.pool.query('SELECT held_micros FROM mr_key_months WHERE key_id=$1', [
            key.id,
          ])
        ).rows,
      ).toEqual([]);
      expect(f.submit).not.toHaveBeenCalled();
    },
  );
});
