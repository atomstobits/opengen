import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createEngine, keyScopes } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';

describe.skipIf(!process.env.TEST_DATABASE_URL)('operator evidence authorization', () => {
  it('denies workspace admins financial reconciliation and permits only the installation operator', async () => {
    const engine = createEngine({ databaseUrl: process.env.TEST_DATABASE_URL! });
    await engine.initialize();
    const own = `operator-${randomUUID()}`,
      other = `customer-${randomUUID()}`;
    await engine.ensureWorkspace(own);
    await engine.ensureWorkspace(other);
    const key = await engine.accounts.createKey(own, {
      name: 'Workspace administrator',
      scopes: [...keyScopes],
    });
    const app = await buildApp({
      engine,
      workspaceId: own,
      apiToken: 'synthetic-installation-operator',
    });
    const id = randomUUID(),
      path = `/v1/workspaces/${other}/generations/${id}`;
    try {
      const payload = {
        action: 'reject',
        reference: 'support-case',
        note: 'Checked provider and verified no upstream acceptance.',
        evidenceUrl: 'https://provider.example/evidence',
      };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: path + '/reconcile',
            headers: { authorization: `Bearer ${key.token}` },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ url: path, headers: { authorization: `Bearer ${key.token}` } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: path,
            headers: { authorization: 'Bearer synthetic-installation-operator' },
          })
        ).statusCode,
      ).toBe(404);
      await engine.pool.query(
        `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,reserved_micros)
         VALUES($1,$2,'operator-inspection','synthetic',$3,$4,$5,'failed','synthetic-private-upstream',0)`,
        [
          id,
          other,
          JSON.stringify({
            modelId: 'fixture/image',
            operation: 'text-to-image',
            input: { prompt: 'Synthetic private fixture.' },
          }),
          JSON.stringify({ id: 'fixture-route' }),
          JSON.stringify({ id: 'fixture-region' }),
        ],
      );
      expect((await engine.getJob(other, id))?.upstreamId).toBeNull();
      const inspected = await app.inject({
        url: path,
        headers: { authorization: 'Bearer synthetic-installation-operator' },
      });
      expect(inspected.statusCode).toBe(200);
      expect(inspected.json().upstreamId).toBe('synthetic-private-upstream');
      const exported = await app.inject({
        url: '/v1/ledger/export?format=csv&limit=1',
        headers: { authorization: `Bearer ${key.token}` },
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('text/csv');
      expect(exported.body).toContain('amount_micros');
      expect(exported.headers['cache-control']).toContain('no-store');
    } finally {
      await app.close();
      await engine.close();
    }
  });
});
