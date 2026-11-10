import { privateStorageFixture } from './helpers/private-storage.js';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEngine, AccountGovernanceStore } from '@media-router/engine';
import { governanceFixture } from './governance-fixture.js';

const input = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video' as const,
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  input: { prompt: 'Synthetic private admission.', resolution: '720p', duration: 2 },
  metadata: { project: 'Fixture film', tags: { feature: 'preview' } },
};
describe.skipIf(!process.env.TEST_DATABASE_URL)('authoritative engine governance handoff', () => {
  async function fixture() {
    const f = await governanceFixture();
    const submit = vi.fn(async () => ({ upstreamId: 'fixture-only' }));
    const engine = createEngine({
      databaseUrl: process.env.TEST_DATABASE_URL!,
      storage: privateStorageFixture(),
      poolSize: 1,
      pollIntervalMs: 0,
      adapters: [
        {
          id: 'alibaba',
          isConfigured: (route) => route.id === input.routeId,
          submit,
          poll: async () => ({ status: 'succeeded', billedCostMicros: 100_000 }),
        },
      ],
    });
    await engine.pool.query(`SET search_path TO ${f.schema}`);
    await f.pool.query('UPDATE mr_workspaces SET available_micros=2000000 WHERE id=$1', [
      f.workspaceId,
    ]);
    const principal = (await f.accounts.authenticate(f.key.token))!;
    return {
      ...f,
      engine,
      submit,
      principal,
      async close() {
        await engine.close();
        await f.close();
      },
    };
  }
  it('commits actor, private tags, workspace money and key exposure together and never forwards tags upstream', async () => {
    const f = await fixture();
    try {
      const options = {
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input,
        principal: f.principal,
      };
      const job = await f.engine.submit(options);
      expect(job).toMatchObject({
        attribution: { kind: 'api', keyId: f.key.id, grantId: null, clientId: null },
        metadata: input.metadata,
        reservedMicros: 200_000,
      });
      expect(job.input.metadata).toBeUndefined();
      await f.engine.workOnce();
      await f.engine.workOnce();
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(
        (f.submit.mock.calls[0] as unknown as [{ input: { metadata?: unknown } }])[0].input
          .metadata,
      ).toBeUndefined();
      const replay = await f.engine.submit(options);
      expect(replay.id).toBe(job.id);
      await expect(
        f.engine.submit({ ...options, input: { ...input, metadata: { project: 'Different' } } }),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(
        (
          await f.pool.query(
            'SELECT gross_debit_micros,held_micros FROM mr_key_months WHERE key_id=$1',
            [f.key.id],
          )
        ).rows[0],
      ).toEqual({ gross_debit_micros: '100000', held_micros: '0' });
      expect(
        (
          await f.pool.query("SELECT count(*) FROM mr_ledger WHERE job_id=$1 AND kind='settle'", [
            job.id,
          ])
        ).rows[0].count,
      ).toBe('1');
    } finally {
      await f.close();
    }
  });
  it('preserves an exact-model provider exception through both preparation and final admission', async () => {
    const f = await fixture();
    try {
      const policy = await f.accounts.savePolicy(f.workspaceId, {
        name: 'Exact model exception',
        policy: {
          providerIds: ['fal'],
          modelProviderExceptions: [{ modelId: input.modelId, providerIds: ['alibaba'] }],
        },
      });
      await f.pool.query('UPDATE mr_api_keys SET policy_id=$2 WHERE id=$1', [f.key.id, policy.id]);
      const principal = (await f.accounts.authenticate(f.key.token))!;
      const job = await f.engine.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input,
        principal,
      });
      expect(job.routeId).toBe(input.routeId);
      expect(job.input.routing?.providerIds).toEqual(['alibaba']);
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
  it('refuses sourced OAuth consent from an API actor authenticated before rotation', async () => {
    const f = await fixture();
    try {
      const oauth = f.engine.mcpOAuth;
      const client = await oauth.registerClient(
        { clientName: 'Synthetic fixture', redirectUris: ['https://client.example/callback'] },
        'fixture',
      );
      const request = await oauth.beginAuthorization(
        {
          clientId: client.client_id,
          redirectUri: client.redirect_uris[0]!,
          responseType: 'code',
          codeChallenge: 'a'.repeat(43),
          codeChallengeMethod: 'S256',
          resource: oauth.resource,
        },
        'fixture',
      );
      await new AccountGovernanceStore(f.pool).rotateKey(
        { workspaceId: f.workspaceId, bootstrap: true, scopes: ['keys:write'] },
        f.key.id,
        1,
      );
      await expect(
        oauth.approve(request.requestId, f.principal, f.workspaceId, ['read', 'generate']),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        (
          await f.pool.query('SELECT count(*) FROM mr_mcp_oauth_grants WHERE source_key_id=$1', [
            f.key.id,
          ])
        ).rows[0].count,
      ).toBe('0');
    } finally {
      await f.close();
    }
  });
  it('rejects a key revoked during preparation before any workspace/key reserve or provider call', async () => {
    const f = await fixture();
    try {
      const resolve = f.engine.resolveInput.bind(f.engine);
      vi.spyOn(f.engine, 'resolveInput').mockImplementation(async (...args) => {
        const prepared = await resolve(...args);
        await f.accounts.revokeKey(f.workspaceId, f.key.id);
        return prepared;
      });
      await expect(
        f.engine.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input,
          principal: f.principal,
        }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(f.submit).not.toHaveBeenCalled();
      expect((await f.pool.query('SELECT count(*) FROM mr_jobs')).rows[0].count).toBe('0');
      expect((await f.pool.query('SELECT count(*) FROM mr_key_reservations')).rows[0].count).toBe(
        '0',
      );
      expect((await f.engine.getBalance(f.workspaceId)).reservedMicros).toBe(0);
    } finally {
      await f.close();
    }
  });
});
