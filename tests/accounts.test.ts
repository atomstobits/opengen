import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEngine, constrainInput, keyScopes } from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';

const databaseUrl = process.env.TEST_DATABASE_URL;
const input = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video' as const,
  input: { prompt: 'The sea.', resolution: '720p', duration: 5 },
};
describe('key policy composition', () => {
  it('rejects an expanded region and carries the stricter spending limit', () => {
    const p = {
      workspaceId: 'a',
      scopes: ['generate' as const],
      policy: { endpointRegions: ['eu-central-1'], fidelity: 'native' as const },
      maxCostMicros: 100,
    };
    expect(() =>
      constrainInput(p, { ...input, routing: { endpointRegions: ['us-east-1'] } }),
    ).toThrow('expands');
    expect(constrainInput(p, { ...input, maxCostMicros: 50 })).toMatchObject({
      maxCostMicros: 50,
      routing: { endpointRegions: ['eu-central-1'], fidelity: 'native' },
    });
    expect(constrainInput(p, input).maxCostMicros).toBe(100);
  });
});
describe.skipIf(!databaseUrl)('database-backed account boundaries', () => {
  async function setup() {
    const engine = createEngine({
      databaseUrl: databaseUrl!,
      vaultKey: 'ab'.repeat(32),
      publicUrl: 'https://opengen.example',
    });
    await engine.initialize();
    const workspaceId = `account-${randomUUID()}`;
    await engine.ensureWorkspace(workspaceId);
    return { engine, workspaceId };
  }
  it('returns a key once, isolates its policy and invalidates existing sessions on revocation', async () => {
    const { engine, workspaceId } = await setup();
    try {
      const policy = await engine.accounts.savePolicy(workspaceId, {
        name: 'EU',
        policy: { endpointRegions: ['eu-central-1'] },
        maxCostMicros: 500,
      });
      const key = await engine.accounts.createKey(workspaceId, {
        name: 'Agent',
        scopes: ['read', 'generate'],
        policyId: policy.id,
      });
      const principal = await engine.accounts.authenticate(key.token);
      expect(principal).toMatchObject({
        workspaceId,
        scopes: ['read', 'generate'],
        maxCostMicros: 500,
        policy: { endpointRegions: ['eu-central-1'] },
      });
      expect(JSON.stringify(await engine.accounts.listKeys(workspaceId))).not.toContain(key.token);
      const session = await engine.accounts.createSession(principal!);
      expect((await engine.accounts.session(session))?.workspaceId).toBe(workspaceId);
      expect(await engine.accounts.revokeKey('other', key.id)).toBe(false);
      await engine.accounts.revokeKey(workspaceId, key.id);
      expect(await engine.accounts.authenticate(key.token)).toBeNull();
      expect(await engine.accounts.session(session)).toBeNull();
      expect(await engine.accounts.authenticate(key.token + 'x')).toBeNull();
    } finally {
      await engine.close();
    }
  });
  it('encrypts workspace-bound connections and rejects ciphertext moved to another workspace', async () => {
    const { engine, workspaceId } = await setup();
    try {
      await engine.accounts.putConnection(workspaceId, 'fal/global', {
        apiKey: 'fixture-private-provider-value',
      });
      expect(await engine.accounts.getConnection(workspaceId, 'fal/global')).toEqual({
        apiKey: 'fixture-private-provider-value',
      });
      expect(await engine.accounts.getConnection('other', 'fal/global')).toBeNull();
      const row = (
        await engine.pool.query('SELECT ciphertext FROM mr_connections WHERE workspace_id=$1', [
          workspaceId,
        ])
      ).rows[0];
      expect(row.ciphertext).not.toContain('fixture-private');
      const other = `account-${randomUUID()}`;
      await engine.ensureWorkspace(other);
      await engine.pool.query(
        'INSERT INTO mr_connections(workspace_id,deployment_id,ciphertext) VALUES($1,$2,$3)',
        [other, 'fal/global', row.ciphertext],
      );
      await expect(engine.accounts.getConnection(other, 'fal/global')).rejects.toThrow();
    } finally {
      await engine.close();
    }
  });
  it('uses HttpOnly sessions, rejects cross-origin writes and prevents restricted keys from granting authority', async () => {
    const { engine, workspaceId } = await setup();
    const app = await buildApp({
      engine,
      workspaceId,
      apiToken: 'fixture-operator',
      publicUrl: 'https://opengen.example',
    });
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { token: 'fixture-operator' },
      });
      expect(login.statusCode).toBe(200);
      const setCookie = String(login.headers['set-cookie']);
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      const cookie = setCookie.split(';')[0]!;
      expect((await app.inject({ url: '/v1/session', headers: { cookie } })).json()).toMatchObject({
        authenticated: true,
        workspaceId,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/keys',
            headers: { cookie, origin: 'https://attacker.example' },
            payload: { name: 'Escape', scopes: ['read'] },
          })
        ).statusCode,
      ).toBe(403);
      const policy = await engine.accounts.savePolicy(workspaceId, {
        name: 'Restricted',
        policy: { endpointRegions: ['eu-central-1'] },
      });
      const key = await engine.accounts.createKey(workspaceId, {
        name: 'Limited admin',
        scopes: [...keyScopes],
        policyId: policy.id,
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/keys',
            headers: { authorization: `Bearer ${key.token}` },
            payload: { name: 'Escape', scopes: ['read'] },
          })
        ).statusCode,
      ).toBe(403);
      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/quotes',
        headers: { authorization: `Bearer ${key.token}` },
        payload: { ...input, routing: { endpointRegions: ['us-east-1'] } },
      });
      expect(rejected.statusCode).toBe(403);
      await app.inject({ method: 'DELETE', url: '/v1/session', headers: { cookie } });
      expect(
        (await app.inject({ url: '/v1/session', headers: { cookie } })).json().authenticated,
      ).toBe(false);
    } finally {
      await app.close();
      await engine.close();
    }
  });
});
