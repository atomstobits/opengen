import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createEngine } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';
import { privateStorageFixture } from './helpers/private-storage';

describe.skipIf(!process.env.TEST_DATABASE_URL)('workspace-shared private idempotency', () => {
  it('retains the original actor and metadata when a different authorized key replays admission', async () => {
    const providerSubmit = vi.fn(async () => ({ upstreamId: 'synthetic' }));
    const routeId = 'alibaba/ap-southeast-1/wan-3.0';
    const engine = createEngine({
      databaseUrl: process.env.TEST_DATABASE_URL!,
      poolSize: 1,
      storage: privateStorageFixture(),
      adapters: [
        { id: 'alibaba', isConfigured: (route) => route.id === routeId, submit: providerSubmit },
      ],
    });
    await engine.initialize();
    const workspaceId = `private-replay-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId, 2_000_000);
    const original = await engine.accounts.createKey(workspaceId, {
      name: 'Original synthetic actor',
      scopes: ['generate'],
    });
    const teammate = await engine.accounts.createKey(workspaceId, {
      name: 'Authorized synthetic teammate',
      scopes: ['generate'],
    });
    const app = await buildApp({ engine, env: {} });
    const payload = {
      modelId: 'alibaba/wan-3.0',
      operation: 'text-to-video',
      routeId,
      input: { prompt: 'Synthetic private replay.', resolution: '720p', duration: 2 },
      metadata: { project: 'Original project', tags: { feature: 'original' } },
    };
    const request = (token: string, body = payload) =>
      app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'same-private-request' },
        payload: body,
      });
    try {
      const first = await request(original.token);
      const replay = await request(teammate.token);
      expect(first.statusCode).toBe(202);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({
        id: first.json().id,
        attribution: { kind: 'api', keyId: original.id },
        metadata: payload.metadata,
      });
      const changed = await request(teammate.token, {
        ...payload,
        metadata: { project: 'Changed project', tags: { feature: 'changed' } },
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().error.code).toBe('idempotency_conflict');
      expect(
        (
          await engine.pool.query('SELECT count(*) FROM mr_jobs WHERE workspace_id=$1', [
            workspaceId,
          ])
        ).rows[0].count,
      ).toBe('1');
      expect(
        (
          await engine.pool.query(
            "SELECT count(*) FROM mr_ledger WHERE job_id=$1 AND kind='reserve'",
            [first.json().id],
          )
        ).rows[0].count,
      ).toBe('1');
      expect(providerSubmit).not.toHaveBeenCalled();
    } finally {
      await app.close();
      await engine.close();
    }
  });
});
