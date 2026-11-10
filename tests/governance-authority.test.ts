import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createEngine, keyScopes } from '@media-router/engine';
import {
  attributionForPrincipal,
  parseGenerationMetadata,
  revalidateGovernanceAuthority,
  requireGovernanceAdmin,
  rotateKeySecretInTransaction,
  type GovernancePrincipal,
} from '../packages/engine/src/governance-authority.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const native = process.env.TEST_NATIVE_POSTGRES === '1' && Boolean(databaseUrl);
describe('trusted attribution and bounded private metadata', () => {
  it('preserves stable source key/member/grant/client and leaves legacy attribution unknown', () => {
    expect(attributionForPrincipal()).toEqual({
      kind: 'unknown',
      keyId: null,
      membershipId: null,
      grantId: null,
      clientId: null,
    });
    expect(
      attributionForPrincipal({
        workspaceId: 'private',
        scopes: ['generate'],
        keyKind: 'oauth',
        keyId: 'source',
        membershipId: 'member',
        grantId: 'grant',
        clientId: 'client',
      }),
    ).toEqual({
      kind: 'oauth',
      keyId: 'source',
      membershipId: 'member',
      grantId: 'grant',
      clientId: 'client',
    });
  });
  it('canonicalizes private tags without accepting attribution or model fields', () => {
    expect(
      parseGenerationMetadata({
        project: 'Film A',
        tags: { feature: 'preview', environment: 'staging' },
      }),
    ).toEqual({
      project: 'Film A',
      tags: { environment: 'staging', feature: 'preview' },
    });
    expect(JSON.stringify(parseGenerationMetadata({ tags: { z: 'last', a: 'first' } }))).toBe(
      '{"tags":{"a":"first","z":"last"}}',
    );
    for (const value of [
      null,
      [],
      { keyId: 'forged' },
      { prompt: 'private' },
      { project: ' a' },
      { project: 'x'.repeat(81) },
      { tags: { a: 'x\n' } },
      { tags: { a: 1 } },
      { tags: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`tag${i}`, 'x'])) },
      { tags: JSON.parse('{"__proto__":"bad"}') },
      { tags: { constructor: 'bad' } },
      { tags: { a: 'x'.repeat(161) } },
      { tags: { ['x'.repeat(65)]: 'x' } },
      new Date(),
    ])
      expect(() => parseGenerationMetadata(value)).toThrow();
    expect(parseGenerationMetadata({ tags: {} })).toEqual({});
  });
});

async function fixture(poolSize = 1) {
  const engine = createEngine({ databaseUrl: databaseUrl!, poolSize });
  await engine.initialize();
  for (const name of ['governance-authority.sql', 'governance-routing.sql', 'governance-caps.sql'])
    await engine.pool.query(
      await readFile(
        new URL(`../packages/engine/schema-proposals/${name}`, import.meta.url),
        'utf8',
      ),
    );
  const workspaceId = `authority-${randomUUID()}`;
  await engine.ensureWorkspace(workspaceId);
  const admin: GovernancePrincipal = { workspaceId, bootstrap: true, scopes: [...keyScopes] };
  const key = await engine.accounts.createKey(workspaceId, {
    name: 'Synthetic API',
    scopes: [...keyScopes],
  });
  const actor: GovernancePrincipal = {
    ...(await engine.accounts.authenticate(key.token))!,
    keySecretVersion: 1,
  };
  async function transaction<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await engine.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async function grant(
    options: {
      membershipId?: string;
      epoch?: string;
      sourceKeyId?: string;
      scopes?: string[];
    } = {},
  ) {
    const clientId = `fixture-${randomUUID()}`,
      id = randomUUID();
    await engine.pool.query(
      "INSERT INTO mr_mcp_oauth_clients(id,name,redirect_uris) VALUES($1,'Synthetic client','[]')",
      [clientId],
    );
    await engine.pool.query(
      `INSERT INTO mr_mcp_oauth_grants(id,client_id,workspace_id,resource,source_key_id,membership_id,membership_epoch,scopes,expires_at)
      VALUES($1,$2,$3,'https://opengen.example/mcp',$4,$5,$6,$7,clock_timestamp()+interval '1 day')`,
      [
        id,
        clientId,
        workspaceId,
        options.sourceKeyId ?? (options.membershipId ? null : key.id),
        options.membershipId ?? null,
        options.epoch ?? null,
        JSON.stringify(options.scopes ?? ['read', 'generate']),
      ],
    );
    return {
      ...actor,
      keyKind: 'oauth' as const,
      keyId:
        options.membershipId && !options.sourceKeyId ? undefined : (options.sourceKeyId ?? key.id),
      membershipId: options.membershipId,
      grantId: id,
      clientId,
      oauthResource: 'https://opengen.example/mcp',
      scopes: ['read', 'generate'] as const,
    };
  }
  return { engine, workspaceId, key, admin, actor, transaction, grant };
}

describe.skipIf(!databaseUrl)(
  'transactional trusted authority, rotation and tenant boundaries',
  () => {
    it('prevents a monthly-capped administrative key from escaping its governance limit', async () => {
      const f = await fixture();
      try {
        await f.engine.pool.query('UPDATE mr_api_keys SET monthly_cap_micros=100 WHERE id=$1', [
          f.key.id,
        ]);
        expect(
          await f.transaction((client) => revalidateGovernanceAuthority(client, f.actor)),
        ).toMatchObject({ monthlyCapMicros: 100 });
        await expect(
          f.transaction((client) => requireGovernanceAdmin(client, f.actor)),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.transaction((client) => rotateKeySecretInTransaction(client, f.actor, f.key.id, 1)),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.transaction((client) => rotateKeySecretInTransaction(client, f.admin, f.key.id, 1));
        const row = (
          await f.engine.pool.query(
            'SELECT monthly_cap_micros,secret_version FROM mr_api_keys WHERE id=$1',
            [f.key.id],
          )
        ).rows[0];
        expect(row).toEqual({ monthly_cap_micros: '100', secret_version: 2 });
      } finally {
        await f.engine.close();
      }
    });
    it('rotates once on a stable ID, invalidates old secret/session/sourced grants and rejects stale prepared authority', async () => {
      const f = await fixture();
      try {
        const session = await f.engine.accounts.createSession(f.actor);
        const oauth = await f.grant();
        const authenticated = await f.transaction((client) =>
          revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
        );
        expect(attributionForPrincipal(authenticated)).toMatchObject({
          keyId: f.key.id,
          grantId: oauth.grantId,
          clientId: oauth.clientId,
        });
        const changed = await f.transaction((client) =>
          rotateKeySecretInTransaction(client, f.admin, f.key.id, 1),
        );
        expect(changed).toMatchObject({ id: f.key.id, secretVersion: 2 });
        expect(await f.engine.accounts.authenticate(f.key.token)).toBeNull();
        expect(await f.engine.accounts.session(session)).toBeNull();
        expect((await f.engine.accounts.authenticate(changed.token))?.keyId).toBe(f.key.id);
        expect(JSON.stringify(await f.engine.accounts.listKeys(f.workspaceId))).not.toContain(
          changed.token,
        );
        await expect(
          f.transaction((client) => revalidateGovernanceAuthority(client, f.actor)),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.transaction((client) => rotateKeySecretInTransaction(client, f.admin, f.key.id, 1)),
        ).rejects.toMatchObject({ code: 'key_rotation_conflict' });
        expect(
          await f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...f.actor, keySecretVersion: 2 }),
          ),
        ).toMatchObject({ keyId: f.key.id, keySecretVersion: 2 });
        const row = (
          await f.engine.pool.query(
            'SELECT token_hash,secret_version,rotated_at FROM mr_api_keys WHERE id=$1',
            [f.key.id],
          )
        ).rows[0];
        expect(row.token_hash).not.toContain(changed.token);
        expect(row.rotated_at).not.toBeNull();
        expect(row.secret_version).toBe(2);
      } finally {
        await f.engine.close();
      }
    });
    it('rolls secret and grant revocation back together and rejects cross-workspace rotation', async () => {
      const f = await fixture();
      try {
        const oauth = await f.grant();
        await expect(
          f.transaction(async (client) => {
            await rotateKeySecretInTransaction(client, f.admin, f.key.id, 1);
            throw new Error('synthetic transaction failure');
          }),
        ).rejects.toThrow('synthetic');
        expect(await f.engine.accounts.authenticate(f.key.token)).not.toBeNull();
        expect(
          await f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).toMatchObject({ grantId: oauth.grantId });
        const other = `other-${randomUUID()}`;
        await f.engine.ensureWorkspace(other);
        await expect(
          f.transaction((client) =>
            rotateKeySecretInTransaction(client, { ...f.admin, workspaceId: other }, f.key.id, 1),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(await f.engine.accounts.authenticate(f.key.token)).not.toBeNull();
      } finally {
        await f.engine.close();
      }
    });
    it('narrows final policy, rechecks archived/source authority and does not turn tags into permissions', async () => {
      const f = await fixture();
      try {
        const policy = await f.engine.accounts.savePolicy(f.workspaceId, {
          name: 'Region policy',
          policy: { endpointRegions: ['eu', 'us'] },
          maxCostMicros: 100,
        });
        await f.engine.pool.query('UPDATE mr_api_keys SET policy_id=$2 WHERE id=$1', [
          f.key.id,
          policy.id,
        ]);
        const actor: GovernancePrincipal = {
          ...f.actor,
          policy: { endpointRegions: ['eu', 'us'] },
          maxCostMicros: 100,
        };
        const oauth = await f.grant();
        await f.engine.pool.query(
          "UPDATE mr_policies SET policy='{" +
            '"endpointRegions":["eu"]' +
            "}',max_cost_micros=50 WHERE id=$1",
          [policy.id],
        );
        expect(
          await f.transaction((client) => revalidateGovernanceAuthority(client, actor)),
        ).toMatchObject({ policy: { endpointRegions: ['eu'] }, maxCostMicros: 50 });
        await expect(
          f.transaction((client) => requireGovernanceAdmin(client, actor)),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.engine.pool.query(
          'UPDATE mr_policies SET archived_at=clock_timestamp() WHERE id=$1',
          [policy.id],
        );
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...f.actor, keySecretVersion: undefined }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await f.engine.close();
      }
    });
    it('keeps member grants independent of key rotation and rejects removal, reinvitation and identity mismatch', async () => {
      const f = await fixture();
      try {
        const memberId = randomUUID();
        await f.engine.pool.query(
          "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://issuer.example','fixture','admin',clock_timestamp())",
          [memberId, f.workspaceId],
        );
        const epoch = (
          await f.engine.pool.query(
            'SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1',
            [memberId],
          )
        ).rows[0].epoch;
        const oauth = await f.grant({ membershipId: memberId, epoch });
        await f.transaction((client) => rotateKeySecretInTransaction(client, f.admin, f.key.id, 1));
        const revalidated = await f.transaction((client) =>
          revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
        );
        expect(revalidated).toMatchObject({ membershipId: memberId, grantId: oauth.grantId });
        expect(revalidated.keyId).toBeUndefined();
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, {
              ...oauth,
              clientId: 'foreign-client',
              scopes: [...oauth.scopes],
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.engine.pool.query(
          'UPDATE mr_memberships SET removed_at=clock_timestamp() WHERE id=$1',
          [memberId],
        );
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.engine.pool.query(
          "UPDATE mr_memberships SET removed_at=NULL,accepted_at=accepted_at+interval '1 second' WHERE id=$1",
          [memberId],
        );
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await f.engine.close();
      }
    });
    it('rechecks source-key membership and source/grant identity rather than trusting the original principal', async () => {
      const f = await fixture();
      try {
        const memberId = randomUUID();
        await f.engine.pool.query(
          "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://issuer.example','fixture-source','admin',clock_timestamp())",
          [memberId, f.workspaceId],
        );
        await f.engine.pool.query('UPDATE mr_api_keys SET membership_id=$2 WHERE id=$1', [
          f.key.id,
          memberId,
        ]);
        const oauth = { ...(await f.grant()), membershipId: memberId };
        expect(
          await f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).toMatchObject({ keyId: f.key.id, membershipId: memberId });
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, {
              ...oauth,
              keyId: randomUUID(),
              scopes: [...oauth.scopes],
            }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await f.engine.pool.query(
          'UPDATE mr_memberships SET removed_at=clock_timestamp() WHERE id=$1',
          [memberId],
        );
        await expect(
          f.transaction((client) =>
            revalidateGovernanceAuthority(client, { ...oauth, scopes: [...oauth.scopes] }),
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await f.engine.close();
      }
    });
    it('revalidates explicitly verified external OAuth members without inventing native grants or source keys', async () => {
      const f = await fixture();
      try {
        const memberId = randomUUID();
        await f.engine.pool.query(
          "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://issuer.example','external-fixture','admin',clock_timestamp())",
          [memberId, f.workspaceId],
        );
        const actor: GovernancePrincipal = {
          workspaceId: f.workspaceId,
          keyKind: 'oauth',
          externalOAuth: true,
          authorityExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          membershipId: memberId,
          scopes: ['read', 'generate'],
          identity: { issuer: 'https://issuer.example', subject: 'external-fixture' },
        };
        expect(
          await f.transaction((client) => revalidateGovernanceAuthority(client, actor)),
        ).toMatchObject({
          externalOAuth: true,
          membershipId: memberId,
          scopes: ['read', 'generate'],
        });
        expect(attributionForPrincipal(actor)).toEqual({
          kind: 'oauth',
          keyId: null,
          membershipId: memberId,
          grantId: null,
          clientId: null,
        });
        for (const altered of [
          { ...actor, externalOAuth: undefined },
          { ...actor, authorityExpiresAt: undefined },
          { ...actor, authorityExpiresAt: 'not-a-date' },
          { ...actor, authorityExpiresAt: new Date(Date.now() - 1000).toISOString() },
          { ...actor, identity: { ...actor.identity!, subject: 'different-user' } },
          { ...actor, keyId: f.key.id },
          { ...actor, grantId: randomUUID() },
        ])
          await expect(
            f.transaction((client) => revalidateGovernanceAuthority(client, altered)),
          ).rejects.toMatchObject({ statusCode: 403 });
        await f.engine.pool.query(
          'UPDATE mr_memberships SET removed_at=clock_timestamp() WHERE id=$1',
          [memberId],
        );
        await expect(
          f.transaction((client) => revalidateGovernanceAuthority(client, actor)),
        ).rejects.toMatchObject({ statusCode: 403 });
      } finally {
        await f.engine.close();
      }
    });
  },
);

describe.skipIf(!native)('native PostgreSQL authority races', () => {
  it('rejects authority authenticated before rotation after waiting for the workspace transaction', async () => {
    const f = await fixture(3);
    const rotation = await f.engine.pool.connect(),
      admission = await f.engine.pool.connect();
    let result: Promise<unknown> | undefined;
    try {
      await rotation.query('BEGIN');
      await rotateKeySecretInTransaction(rotation, f.admin, f.key.id, 1);
      await admission.query('BEGIN');
      result = revalidateGovernanceAuthority(admission, f.actor);
      // Result is observed immediately so rejection cannot become unhandled while committing.
      const checked = expect(result).rejects.toMatchObject({ statusCode: 403 });
      await rotation.query('COMMIT');
      await checked;
    } finally {
      await rotation.query('ROLLBACK');
      await admission.query('ROLLBACK');
      rotation.release();
      admission.release();
      await f.engine.close();
    }
  });
});
