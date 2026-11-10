import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateInput, Job, Quote } from '@media-router/contracts';
import { catalog } from '@media-router/catalog';
import {
  AccountGovernanceStore,
  createEngine,
  type ProviderAdapter,
  type ProviderResult,
} from '@media-router/engine';
import { buildApp } from '../apps/server/src/app.js';
import { createFeePolicy } from '../packages/engine/src/billing-fees.js';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine.js';
import { privateOutputFixture, privateStorageFixture } from './helpers/private-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const publicUrl = 'https://billing-fixture.invalid';
const operatorToken = 'fixture-installation-operator';
const upstreamId = 'fixture-provider-task'.padEnd(256, 'a');
const routeId = 'alibaba/ap-southeast-1/wan-3.0';
const deploymentId = catalog.routes.find((route) => route.id === routeId)!.deploymentId;
const providerEstimateMicros = 200_000;
const grossEstimateMicros = 210_000;
const openingMicros = 1_000_000;
const policy = createFeePolicy({
  id: 'fixture-smart-5-percent',
  version: 1,
  activation: 'fixture',
  basisPoints: 500,
  eligibleOutcomes: ['succeeded'],
  overrunAllocation: 'provider-first',
});
const feeAcceptance = { policyId: policy.id, policyVersion: policy.version };
const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  input: { prompt: 'Synthetic generation billing fixture.', resolution: '720p', duration: 2 },
};
const acceptedInput: GenerateInput = { ...input, feeAcceptance };

async function fixture(options: { disabled?: boolean; openingMicros?: number } = {}) {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'generation_billing');
  const storage = privateStorageFixture();
  const submit = vi.fn(async () => ({ upstreamId }));
  const poll = vi.fn<ProviderAdapter['poll']>(async () => {
    throw new Error('Unexpected provider polling in the fixture.');
  });
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      publicUrl,
      storage,
      vaultKey: 'ab'.repeat(32),
      providerEnv: {},
      ...(options.disabled ? {} : { fixtureBillingPolicy: policy }),
      pollIntervalMs: 0,
      adapters: [
        {
          id: 'alibaba',
          isConfigured: (route) => route.id === routeId,
          submit,
          poll,
        },
      ],
    }),
  );
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const close = async () => {
    try {
      await app?.close();
    } finally {
      try {
        await engine.close();
      } finally {
        await isolated.close();
      }
    }
  };
  try {
    await engine.initialize();
    const workspaceId = `billing-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, options.openingMicros ?? openingMicros);
    app = await buildApp({ engine, apiToken: operatorToken, publicUrl, env: {} });
    const server = app;
    const createKey = (monthlyCapMicros?: number) =>
      new AccountGovernanceStore(engine.pool).createKey(
        { workspaceId, bootstrap: true, scopes: ['read', 'generate', 'keys:write'] },
        { name: 'Synthetic generation key', scopes: ['read', 'generate'], monthlyCapMicros },
      );
    const quote = (token: string, payload: GenerateInput) =>
      server.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const generate = (token: string, payload: GenerateInput, idempotencyKey = randomUUID()) =>
      server.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
        payload,
      });
    const assertNoAdmission = async () => {
      expect(await engine.listJobs(workspaceId)).toEqual([]);
      expect((await engine.ledger(workspaceId)).filter((row) => row.kind === 'reserve')).toEqual(
        [],
      );
      expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
      expect(submit).not.toHaveBeenCalled();
    };
    return {
      engine,
      server,
      workspaceId,
      storage,
      submit,
      poll,
      createKey,
      quote,
      generate,
      close,
      assertNoAdmission,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function expectError(
  response: { statusCode: number; json: () => unknown },
  status: number,
  code: string,
) {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(status);
  expect(response.json()).toMatchObject({ error: { code } });
}

function expectAccepted(response: { statusCode: number; json: <T>() => T }): Job {
  expect(response.statusCode, JSON.stringify(response.json())).toBe(202);
  return response.json<Job>();
}

describe.skipIf(!databaseUrl)('022 generation quote, admission and verified cost', () => {
  it('quotes the same gross amount over HTTP that admission reserves for the wallet and key', async () => {
    const f = await fixture();
    try {
      const key = await f.createKey(grossEstimateMicros);
      const before = await f.engine.getBalance(f.workspaceId);
      const response = await f.quote(key.token, acceptedInput);
      expect(response.statusCode, response.body).toBe(200);
      const quote = response.json<Quote>();
      expect(quote).toMatchObject({
        selectedRouteId: routeId,
        reservationMicros: grossEstimateMicros,
        billing: { ...feeAcceptance, service: 'smart', basisPoints: 500 },
      });
      expect(quote.candidates.find((candidate) => candidate.routeId === routeId)?.billing).toEqual({
        providerEstimateMicros,
        nominalFeeEstimateMicros: 10_000,
        customerEstimateMicros: grossEstimateMicros,
      });
      expect(
        await f.engine.quoteGeneration(acceptedInput, { executableRouteIds: [routeId] }),
      ).toMatchObject({ billing: quote.billing, reservationMicros: quote.reservationMicros });
      expect(await f.engine.getBalance(f.workspaceId)).toEqual(before);
      await f.assertNoAdmission();

      const replayKey = randomUUID();
      const job = expectAccepted(await f.generate(key.token, acceptedInput, replayKey));
      expect(job.reservedMicros).toBe(quote.reservationMicros);
      expect(expectAccepted(await f.generate(key.token, acceptedInput, replayKey)).id).toBe(job.id);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: openingMicros - grossEstimateMicros,
        reservedMicros: grossEstimateMicros,
      });
      expect(
        (
          await f.engine.pool.query(
            'SELECT gross_debit_micros,held_micros FROM mr_key_months WHERE key_id=$1',
            [key.id],
          )
        ).rows,
      ).toEqual([{ gross_debit_micros: '0', held_micros: String(grossEstimateMicros) }]);
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('rejects a wallet and a monthly key cap that cover only the provider estimate', async () => {
    const f = await fixture({ openingMicros: providerEstimateMicros });
    try {
      const walletKey = await f.createKey();
      expectError(await f.generate(walletKey.token, acceptedInput), 402, 'insufficient_balance');
      await f.assertNoAdmission();
      await f.engine.creditWorkspace(f.workspaceId, openingMicros, 'fixture-wallet-funding');
      const capped = await f.createKey(providerEstimateMicros);
      expectError(await f.generate(capped.token, acceptedInput), 402, 'key_monthly_cap_exceeded');
      await f.assertNoAdmission();
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(
        openingMicros + providerEstimateMicros,
      );
    } finally {
      await f.close();
    }
  });

  it.each(['provider evidence', 'operator reconciliation'] as const)(
    'holds bare cost and settles the original job once through %s',
    async (path) => {
      const f = await fixture();
      try {
        const key = await f.createKey(grossEstimateMicros);
        const job = expectAccepted(await f.generate(key.token, acceptedInput));
        await workUntilJob(f.engine, f.workspaceId, job.id, (value) => value.status === 'running');
        const output = await privateOutputFixture(f.storage, job.id);
        const bare: ProviderResult = {
          status: 'succeeded',
          billedCostMicros: 204_000,
          ...(path === 'provider evidence' ? { retryAfterMs: 15_000 } : {}),
          outputs: [output],
        };
        await f.engine.applyProviderResult(f.workspaceId, job.id, bare);
        const completed = await workUntilJob(
          f.engine,
          f.workspaceId,
          job.id,
          (value) => value.status === 'succeeded' && value.deliveryStatus === 'available',
        );
        expect(completed).toMatchObject({
          settledMicros: null,
          billing: { costStatus: 'pending' },
        });
        expect((await f.engine.getBalance(f.workspaceId)).reservedMicros).toBe(grossEstimateMicros);
        const ledger = async () =>
          (await f.engine.ledger(f.workspaceId)).filter((row) => row.job_id === job.id);
        expect((await ledger()).map((row) => row.kind)).toEqual(['reserve']);

        if (path === 'provider evidence') {
          const identity = (
            await f.engine.pool.query<{
              attempt_id: string;
              route_id: string;
              deployment_id: string;
              identity: string;
              upstream_id: string;
            }>(
              `SELECT a.id AS attempt_id,a.route_id,a.deployment_id,c.identity,j.upstream_id
               FROM mr_jobs j JOIN mr_attempts a ON a.job_id=j.id AND a.number=j.attempt_count
               JOIN mr_attempt_credentials c ON c.job_id=a.job_id AND c.attempt_number=a.number
               WHERE j.workspace_id=$1 AND j.id=$2`,
              [f.workspaceId, job.id],
            )
          ).rows[0]!;
          expect(identity).toMatchObject({
            route_id: routeId,
            upstream_id: upstreamId,
          });
          const result: ProviderResult = {
            status: 'succeeded',
            costEvidence: {
              workspaceId: f.workspaceId,
              jobId: job.id,
              routeId: identity.route_id,
              credentialIdentity: identity.identity,
              evidence: {
                attemptId: identity.attempt_id,
                providerId: 'alibaba',
                deploymentId: identity.deployment_id,
                upstreamReference: identity.upstream_id,
                reference: 'fixture-provider-receipt',
                basis: 'provider-billed-usd',
                currency: 'USD',
                amountMicros: 220_000,
              },
            },
          };
          await f.engine.applyProviderResult(f.workspaceId, job.id, {
            ...result,
            costEvidence: { ...result.costEvidence!, credentialIdentity: 'wrong-original-payer' },
          });
          expect((await f.engine.getJob(f.workspaceId, job.id))?.settledMicros).toBeNull();
          const pending = (
            await f.engine.pool.query(
              'UPDATE mr_jobs SET next_poll_at=clock_timestamp() WHERE id=$1 RETURNING billing_poll_pending',
              [job.id],
            )
          ).rows[0];
          expect(pending.billing_poll_pending).toBe(true);
          f.poll.mockResolvedValueOnce(result);
          await workUntilJob(
            f.engine,
            f.workspaceId,
            job.id,
            (value) => value.settledMicros !== null,
          );
          expect(f.poll).toHaveBeenCalledOnce();
          expect(f.poll.mock.calls[0]![0].costEvidenceScope).toMatchObject({
            attemptId: identity.attempt_id,
            credentialIdentity: identity.identity,
            upstreamReference: identity.upstream_id,
          });
          await f.engine.applyProviderResult(f.workspaceId, job.id, result);
        } else {
          const reconcile = (audited = true) =>
            f.server.inject({
              method: 'POST',
              url: `/v1/workspaces/${f.workspaceId}/generations/${job.id}/reconcile`,
              headers: { authorization: `Bearer ${operatorToken}` },
              payload: {
                action: 'settle',
                reference: 'fixture-audited-cost',
                note: 'Synthetic verified provider receipt for the original attempt.',
                evidenceUrl: 'https://provider.invalid/fixture-cost-receipt',
                ...(audited ? { costBasis: 'operator-audited' } : {}),
                billedCostMicros: 204_000,
              },
            });
          expectError(await reconcile(false), 409, 'fee_evidence_required');
          expect(await f.engine.reconciliations(f.workspaceId, job.id)).toHaveLength(0);
          const first = await reconcile();
          expect(first.statusCode, first.body).toBe(200);
          const duplicate = await reconcile();
          expect(duplicate.statusCode, duplicate.body).toBe(200);
          expect(await f.engine.reconciliations(f.workspaceId, job.id)).toHaveLength(1);
        }

        const statement = {
          ...feeAcceptance,
          basisPoints: 500,
          service: 'smart',
          ...(path === 'provider evidence'
            ? {
                providerCostMicros: 220_000,
                customerProviderDebitMicros: 210_000,
                nominalFeeMicros: 11_000,
                collectedFeeMicros: 0,
                waivedFeeMicros: 11_000,
                operatorOverrunMicros: 10_000,
              }
            : {
                providerCostMicros: 204_000,
                customerProviderDebitMicros: 204_000,
                nominalFeeMicros: 10_200,
                collectedFeeMicros: 6_000,
                waivedFeeMicros: 4_200,
                operatorOverrunMicros: 0,
              }),
          customerTotalMicros: grossEstimateMicros,
        };
        expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({
          settledMicros: grossEstimateMicros,
          billing: { ...statement, costStatus: 'verified' },
        });
        const entries = await ledger();
        const privateEvidence = (
          await f.engine.pool.query('SELECT fee_cost_evidence FROM mr_jobs WHERE id=$1', [job.id])
        ).rows[0].fee_cost_evidence;
        expect(privateEvidence).toMatchObject({ workspaceId: f.workspaceId, jobId: job.id });
        expect(JSON.stringify(entries)).not.toContain(privateEvidence.credentialIdentity);
        expect(JSON.stringify(await f.engine.getJob(f.workspaceId, job.id))).not.toContain(
          privateEvidence.evidence.upstreamReference,
        );
        expect(entries.map((row) => row.kind).sort()).toEqual(['release', 'reserve', 'settle']);
        expect(entries.find((row) => row.kind === 'settle')).toMatchObject({
          amount_micros: String(grossEstimateMicros),
          details: { billingFee: statement },
        });
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: openingMicros - grossEstimateMicros,
          reservedMicros: 0,
        });
        expect(
          (
            await f.engine.pool.query(
              'SELECT gross_debit_micros,held_micros FROM mr_key_months WHERE key_id=$1',
              [key.id],
            )
          ).rows,
        ).toEqual([{ gross_debit_micros: String(grossEstimateMicros), held_micros: '0' }]);
        expect(f.submit).toHaveBeenCalledTimes(1);
      } finally {
        await f.close();
      }
    },
  );

  it('releases a fee reservation when durable cancellation proves dispatch never started', async () => {
    const f = await fixture();
    try {
      const key = await f.createKey(grossEstimateMicros);
      const accepted = expectAccepted(await f.generate(key.token, acceptedInput));
      const cancelled = await f.engine.cancel(f.workspaceId, accepted.id);
      expect(cancelled).toMatchObject({
        status: 'cancelled',
        settledMicros: 0,
        billing: {
          costStatus: 'no-upstream-charge',
          collectedFeeMicros: 0,
          customerTotalMicros: 0,
        },
      });
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: openingMicros,
        reservedMicros: 0,
      });
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each([
    { disabled: true, status: 503, code: 'fee_policy_unavailable', acceptance: feeAcceptance },
    {
      disabled: false,
      status: 409,
      code: 'fee_policy_mismatch',
      acceptance: { ...feeAcceptance, policyVersion: policy.version + 1 },
    },
  ])('rejects $code before any reservation or provider work', async (scenario) => {
    const f = await fixture({ disabled: scenario.disabled });
    try {
      const key = await f.createKey();
      expectError(
        await f.generate(key.token, { ...input, feeAcceptance: scenario.acceptance }),
        scenario.status,
        scenario.code,
      );
      await f.assertNoAdmission();
      expect((await f.engine.getBalance(f.workspaceId)).availableMicros).toBe(openingMicros);
    } finally {
      await f.close();
    }
  });

  it('keeps omitted acceptance compatible with unpinned BYOK and exact-route fallback requests', async () => {
    const f = await fixture();
    try {
      const key = await f.createKey();
      await f.engine.accounts.putConnection(f.workspaceId, deploymentId, {
        apiKey: 'fixture-byok-key',
        workspaceId: 'fixture-byok-workspace',
      });
      const byok: GenerateInput = { ...input, billing: 'byok' };
      const pinnedFallback: GenerateInput = { ...input, routeId, routing: { fallback: true } };
      for (const [request, expected] of [
        [byok, 0],
        [pinnedFallback, providerEstimateMicros],
      ] as const) {
        const response = await f.quote(key.token, request);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json<Quote>().selectedRouteId, response.body).toBe(routeId);
        expect(expectAccepted(await f.generate(key.token, request)).reservedMicros).toBe(expected);
      }
      expectError(await f.generate(key.token, { ...byok, feeAcceptance }), 422, 'fee_managed_only');
      expect(await f.engine.listJobs(f.workspaceId)).toHaveLength(2);
      expect((await f.engine.getBalance(f.workspaceId)).reservedMicros).toBe(
        providerEstimateMicros,
      );
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
