import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import { AccountGovernanceStore, createEngine } from '@media-router/engine';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import { privateStorageFixture } from './helpers/private-storage';

const databaseUrl = process.env.TEST_DATABASE_URL;
const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  input: { prompt: 'Synthetic private lifecycle qualification.', resolution: '720p', duration: 2 },
};

/** Real admission, auth, worker and accounting services; no provider/network/media evidence. */
async function fixture(poolSize = 1) {
  const isolated = await isolatedEngineDatabase(databaseUrl!, 'money_lifecycle');
  const submit = vi.fn(async () => ({ upstreamId: 'synthetic-original-task' }));
  const poll = vi.fn(async () => ({ status: 'succeeded' as const }));
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      publicUrl: 'https://money.fixture.invalid',
      providerEnv: {},
      vaultKey: '0'.repeat(64),
      poolSize,
      storage: privateStorageFixture(),
      pollIntervalMs: 0,
      adapters: [
        { id: 'alibaba', isConfigured: (route) => route.id === input.routeId, submit, poll },
      ],
    }),
  );
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Network disabled in money lifecycle qualification.');
  });
  try {
    await engine.initialize();
    const workspaceId = `money-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, 2_000_000);
    const key = await engine.accounts.createKey(workspaceId, {
      name: 'Synthetic stable payer',
      scopes: ['read', 'generate'],
    });
    const governance = new AccountGovernanceStore(engine.pool);
    const admin = { workspaceId, bootstrap: true as const, scopes: ['keys:write' as const] };
    await governance.updateKey(admin, key.id, { monthlyCapMicros: 300_000 });
    const principal = (await engine.accounts.authenticate(key.token))!;
    const verifier = 'q'.repeat(43);
    const client = await engine.mcpOAuth.registerClient(
      {
        clientName: 'Synthetic lifecycle client',
        redirectUris: ['https://client.fixture.invalid/cb'],
      },
      'money-lifecycle-fixture',
    );
    const request = await engine.mcpOAuth.beginAuthorization(
      {
        clientId: client.client_id,
        redirectUri: client.redirect_uris[0]!,
        responseType: 'code',
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
        codeChallengeMethod: 'S256',
        resource: engine.mcpOAuth.resource,
        scope: 'read generate',
      },
      'money-lifecycle-fixture',
    );
    const approved = await engine.mcpOAuth.approve(request.requestId, principal, workspaceId, [
      'read',
      'generate',
    ]);
    const tokens = await engine.mcpOAuth.exchangeCode({
      clientId: client.client_id,
      code: new URL(approved.redirectTo).searchParams.get('code')!,
      redirectUri: client.redirect_uris[0]!,
      verifier,
      resource: engine.mcpOAuth.resource,
    });
    const oauth = (await engine.mcpOAuth.authenticate(tokens.access_token))!;
    return {
      engine,
      workspaceId,
      governance,
      admin,
      key,
      principal,
      oauth,
      client,
      tokens,
      submit,
      poll,
      async bucket() {
        return (
          await engine.pool.query(
            'SELECT key_id,gross_debit_micros,held_micros FROM mr_key_months WHERE workspace_id=$1 ORDER BY admission_month',
            [workspaceId],
          )
        ).rows;
      },
      async close() {
        try {
          expect(network).not.toHaveBeenCalled();
        } finally {
          network.mockRestore();
          await engine.close();
          await isolated.close();
        }
      },
    };
  } catch (error) {
    network.mockRestore();
    await engine.close();
    await isolated.close();
    throw error;
  }
}

describe.skipIf(!databaseUrl)('cross-layer stable payer and gross monthly exposure', () => {
  it('retains grant/rotation history and settles held cost once without topups replenishing quota', async () => {
    const f = await fixture();
    try {
      const refreshed = await f.engine.mcpOAuth.refresh({
        clientId: f.client.client_id,
        refreshToken: f.tokens.refresh_token,
        resource: f.engine.mcpOAuth.resource,
      });
      const actor = (await f.engine.mcpOAuth.authenticate(refreshed.access_token))!;
      expect(actor).toMatchObject({
        keyId: f.key.id,
        grantId: f.oauth.grantId,
        clientId: f.client.client_id,
        monthlyCapMicros: 300_000,
      });
      const idempotencyKey = randomUUID();
      const job = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey,
        input,
        principal: actor,
      });
      expect(job).toMatchObject({
        reservedMicros: 200_000,
        attribution: {
          kind: 'oauth',
          keyId: f.key.id,
          grantId: actor.grantId,
          clientId: actor.clientId,
        },
      });
      await workUntilJob(f.engine, f.workspaceId, job.id, (value) => value.status === 'succeeded');
      expect(await f.engine.getJob(f.workspaceId, job.id)).toMatchObject({ settledMicros: null });
      expect(await f.bucket()).toEqual([
        { key_id: f.key.id, gross_debit_micros: '0', held_micros: '200000' },
      ]);
      await expect(
        f.engine.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input,
          principal: actor,
        }),
      ).rejects.toMatchObject({ code: 'key_monthly_cap_exceeded' });
      const rotated = await f.governance.rotateKey(f.admin, f.key.id, 1);
      expect(await f.engine.accounts.authenticate(f.key.token)).toBeNull();
      expect(await f.engine.mcpOAuth.authenticate(refreshed.access_token)).toBeNull();
      const replacement = (await f.engine.accounts.authenticate(rotated.token))!;
      expect(replacement).toMatchObject({ keyId: f.key.id, keySecretVersion: 2 });
      for (let replay = 0; replay < 2; replay++)
        await f.engine.applyProviderResult(f.workspaceId, job.id, {
          status: 'succeeded',
          billedCostMicros: 150_000,
        });
      await f.engine.creditWorkspace(f.workspaceId, 1_000_000, 'synthetic-topup');
      await f.engine.creditWorkspace(f.workspaceId, 1_000_000, 'synthetic-topup');
      await expect(
        f.engine.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input,
          principal: replacement,
        }),
      ).rejects.toMatchObject({ code: 'key_monthly_cap_exceeded' });
      expect(await f.bucket()).toEqual([
        { key_id: f.key.id, gross_debit_micros: '150000', held_micros: '0' },
      ]);
      await f.governance.updateKey(f.admin, f.key.id, { monthlyCapMicros: 400_000 });
      const newJob = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input,
        principal: (await f.engine.accounts.authenticate(rotated.token))!,
      });
      await f.engine.cancel(f.workspaceId, newJob.id);
      expect(await f.bucket()).toEqual([
        { key_id: f.key.id, gross_debit_micros: '150000', held_micros: '0' },
      ]);
      expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
        availableMicros: 2_850_000,
        reservedMicros: 0,
      });
      const replay = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey,
        input,
        principal: (await f.engine.accounts.authenticate(rotated.token))!,
      });
      expect(replay.id).toBe(job.id);
      expect(replay.attribution).toEqual(job.attribution);
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(f.poll).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.engine.pool.query('SELECT count(*) FROM mr_jobs WHERE workspace_id=$1', [
            f.workspaceId,
          ])
        ).rows[0].count,
      ).toBe('2');
      expect(
        (
          await f.engine.pool.query(
            "SELECT count(*) FROM mr_ledger WHERE workspace_id=$1 AND reference='synthetic-topup'",
            [f.workspaceId],
          )
        ).rows[0].count,
      ).toBe('1');
      expect(
        (
          await f.engine.pool.query(
            'SELECT kind,count(*)::integer AS count FROM mr_ledger WHERE job_id=$1 GROUP BY kind ORDER BY kind',
            [job.id],
          )
        ).rows,
      ).toEqual([
        { kind: 'release', count: 1 },
        { kind: 'reserve', count: 1 },
        { kind: 'settle', count: 1 },
      ]);
    } finally {
      await f.close();
    }
  });
});

describe.skipIf(!databaseUrl || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native PostgreSQL cross-layer payer races',
  () => {
    it('shares one cap between concurrent API/OAuth admissions and settles one original task once', async () => {
      const f = await fixture(4);
      try {
        const results = await Promise.allSettled(
          [f.principal, f.oauth].map((principal) =>
            f.engine.submit({
              workspaceId: f.workspaceId,
              idempotencyKey: randomUUID(),
              input,
              principal,
            }),
          ),
        );
        const accepted = results.filter((value) => value.status === 'fulfilled');
        expect(accepted).toHaveLength(1);
        expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
        for (const value of results)
          if (value.status === 'rejected')
            expect(value.reason).toMatchObject({ code: 'key_monthly_cap_exceeded' });
        const job = accepted[0]!.value;
        expect(job.attribution?.keyId).toBe(f.key.id);
        await workUntilJob(
          f.engine,
          f.workspaceId,
          job.id,
          (value) => value.status === 'succeeded',
        );
        await Promise.all(
          Array.from({ length: 4 }, () =>
            f.engine.applyProviderResult(f.workspaceId, job.id, {
              status: 'succeeded',
              billedCostMicros: 150_000,
            }),
          ),
        );
        expect(await f.bucket()).toEqual([
          { key_id: f.key.id, gross_debit_micros: '150000', held_micros: '0' },
        ]);
        expect(await f.engine.getBalance(f.workspaceId)).toMatchObject({
          availableMicros: 1_850_000,
          reservedMicros: 0,
        });
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect(f.poll).toHaveBeenCalledTimes(1);
        expect((await f.engine.pool.query('SELECT count(*) FROM mr_jobs')).rows[0].count).toBe('1');
        expect(
          (
            await f.engine.pool.query(
              "SELECT count(*) FROM mr_ledger WHERE job_id=$1 AND kind='settle'",
              [job.id],
            )
          ).rows[0].count,
        ).toBe('1');
      } finally {
        await f.close();
      }
    });
  },
);
