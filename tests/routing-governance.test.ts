import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '@media-router/contracts';
import { catalog } from '@media-router/catalog';
import {
  assertGovernedRoutes,
  constrainGovernedInput,
  constrainRoutingPolicy,
  intersectRoutingPolicies,
  loadBoundRoutingPolicy,
  materializeRoutingPolicy,
  RoutingPolicyStore,
  validateRoutingPolicy,
  type GovernedRoutingPolicy,
} from '../packages/engine/src/routing-governance.js';
import {
  revalidateGovernanceAuthority,
  type GovernancePrincipal,
} from '../packages/engine/src/governance-authority.js';
import { governanceFixture } from './governance-fixture.js';

const modelId = 'author/model';
const derivativeId = 'author/model-fast';
const synthetic: Catalog = {
  providers: ['author', 'reseller', 'other'].map((id) => ({ ...catalog.providers[0]!, id })),
  models: [
    { ...catalog.models[0]!, id: modelId, authorProviderIds: ['author'] },
    { ...catalog.models[0]!, id: derivativeId, authorProviderIds: ['other'] },
  ],
  deployments: [
    { id: 'author/eu', providerId: 'author', endpointRegion: 'eu', processingRegions: ['eu'] },
    { id: 'reseller/eu', providerId: 'reseller', endpointRegion: 'eu', processingRegions: ['eu'] },
    {
      id: 'author/global',
      providerId: 'author',
      endpointRegion: 'eu',
      processingRegions: ['eu', 'us'],
      scope: 'global' as const,
    },
    { id: 'author/unknown', providerId: 'author', endpointRegion: 'eu', processingRegions: null },
    { id: 'author/us', providerId: 'author', endpointRegion: 'us', processingRegions: ['us'] },
  ].map((item) => ({ ...catalog.deployments[0]!, scope: 'regional', ...item })),
  routes: [
    { id: 'author/eu/model', deploymentId: 'author/eu', modelId },
    { id: 'reseller/eu/model', deploymentId: 'reseller/eu', modelId },
    { id: 'author/global/model', deploymentId: 'author/global', modelId },
    { id: 'author/unknown/model', deploymentId: 'author/unknown', modelId },
    { id: 'author/us/model', deploymentId: 'author/us', modelId },
    { id: 'author/eu/fast', deploymentId: 'author/eu', modelId: derivativeId },
  ].map((item) => ({ ...catalog.routes[0]!, ...item, fidelity: 'native', status: 'documented' })),
};

describe('private routing governance controls', () => {
  it('validates exact identities, bounded unique exceptions and strict broker fields', () => {
    expect(
      validateRoutingPolicy(
        { modelIds: [modelId, modelId], providerIds: [], authorOnly: true },
        synthetic,
      ),
    ).toEqual({ modelIds: [modelId], providerIds: [], authorOnly: true });
    for (const value of [
      { actor: 'admin' },
      { authorOnly: 'true' },
      { fallback: 1 },
      { processingScopes: ['EU'] },
      { modelIds: ['wrong/model'] },
      { modelIds: [' author/model'] },
      { providerIds: ['missing'] },
      { deploymentIds: ['missing/eu'] },
      {
        modelProviderExceptions: [
          { modelId, providerIds: ['author'] },
          { modelId, providerIds: ['reseller'] },
        ],
      },
      { modelProviderExceptions: [{ modelId, providerIds: ['missing'] }] },
      { modelProviderExceptions: [{ modelId, providerIds: ['author'], deploymentIds: [] }] },
    ])
      expect(() => validateRoutingPolicy(value, synthetic)).toThrow();
  });

  it('uses explicit exact-model author IDs and intersects provider exceptions with other restrictions', () => {
    const policy = {
      providerIds: ['reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author', 'reseller'] }],
      authorOnly: true,
      endpointRegions: ['eu'],
      processingRegions: ['eu'],
      fidelity: 'native' as const,
      fallback: false,
    };
    expect(materializeRoutingPolicy(synthetic, policy, modelId)).toEqual({
      providerIds: ['author'],
      endpointRegions: ['eu'],
      processingRegions: ['eu'],
      fidelity: 'native',
      fallback: false,
    });
    expect(materializeRoutingPolicy(synthetic, policy, derivativeId).providerIds).toEqual([]);
    const missingAuthors = {
      ...synthetic,
      models: [{ ...synthetic.models[0]!, authorProviderIds: [] }],
    };
    expect(
      materializeRoutingPolicy(missingAuthors, { authorOnly: true }, modelId).providerIds,
    ).toEqual([]);
    expect(() =>
      materializeRoutingPolicy(synthetic, { modelIds: [modelId] }, derivativeId),
    ).toThrow('exact model');
  });

  it('keeps all restrictions under authority/snapshot intersection, including exact-model providers', () => {
    const a: GovernedRoutingPolicy = {
      modelIds: [modelId, derivativeId],
      providerIds: ['reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author', 'reseller'] }],
      endpointRegions: ['eu', 'us'],
      processingRegions: ['eu'],
      fidelity: 'native',
      fallback: false,
    };
    const b: GovernedRoutingPolicy = {
      modelIds: [modelId],
      providerIds: ['author', 'reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author'] }],
      endpointRegions: ['eu'],
      deploymentIds: ['author/eu'],
      authorOnly: true,
    };
    const merged = intersectRoutingPolicies(a, b)!;
    expect(merged).toMatchObject({
      modelIds: [modelId],
      providerIds: ['reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author'] }],
      endpointRegions: ['eu'],
      deploymentIds: ['author/eu'],
      processingRegions: ['eu'],
      fidelity: 'native',
      fallback: false,
      authorOnly: true,
    });
    expect(materializeRoutingPolicy(synthetic, merged, modelId).providerIds).toEqual(['author']);
    expect(intersectRoutingPolicies(undefined, undefined)).toBeUndefined();
    expect(
      intersectRoutingPolicies({ providerIds: ['author'] }, { providerIds: ['reseller'] }),
    ).toEqual({ providerIds: [] });
  });

  it('intersects omitted/current exceptions without treating a removed exception as global permission', () => {
    const old = {
      providerIds: ['reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author'] }],
    };
    const current = { providerIds: ['reseller'] };
    expect(
      materializeRoutingPolicy(synthetic, intersectRoutingPolicies(old, current)!, modelId)
        .providerIds,
    ).toEqual([]);
    const oldGlobal = { providerIds: ['author'] };
    const newException = { modelProviderExceptions: [{ modelId, providerIds: ['reseller'] }] };
    expect(
      materializeRoutingPolicy(
        synthetic,
        intersectRoutingPolicies(oldGlobal, newException)!,
        modelId,
      ).providerIds,
    ).toEqual([]);
  });

  it('allows omissions and narrower overrides while rejecting all explicit widening', () => {
    const base: GovernedRoutingPolicy = {
      modelIds: [modelId],
      providerIds: ['author'],
      endpointRegions: ['eu'],
      processingRegions: ['eu'],
      fidelity: 'native',
      authorOnly: true,
      fallback: false,
    };
    expect(constrainRoutingPolicy(base, { providerIds: [], modelIds: [] })).toMatchObject({
      providerIds: [],
      modelIds: [],
      endpointRegions: ['eu'],
      authorOnly: true,
    });
    for (const request of [
      { providerIds: ['reseller'] },
      { modelIds: [derivativeId] },
      { endpointRegions: ['us'] },
      { processingRegions: ['eu', 'us'] },
      { fidelity: 'any' as const },
      { authorOnly: false },
      { fallback: true },
      { modelProviderExceptions: [{ modelId, providerIds: ['reseller'] }] },
    ])
      expect(() => constrainRoutingPolicy(base, request)).toThrow();
  });

  it('rejects a global provider override that widens an exact-model exception', () => {
    const base = {
      providerIds: ['reseller'],
      modelProviderExceptions: [{ modelId, providerIds: ['author'] }],
    };
    expect(() => constrainRoutingPolicy(base, { providerIds: ['reseller'] })).toThrow('expands');
    expect(constrainRoutingPolicy(base, undefined)).toEqual(base);
    expect(
      constrainRoutingPolicy(base, { modelProviderExceptions: [{ modelId, providerIds: [] }] }),
    ).toMatchObject({ modelProviderExceptions: [{ modelId, providerIds: [] }] });
  });

  it('rechecks model/provider/deployment/endpoint/processing/fidelity on every fallback', () => {
    const policy: GovernedRoutingPolicy = {
      modelIds: [modelId],
      authorOnly: true,
      endpointRegions: ['eu'],
      processingRegions: ['eu'],
      fidelity: 'native',
    };
    expect(() =>
      assertGovernedRoutes(synthetic, policy, modelId, ['author/eu/model']),
    ).not.toThrow();
    for (const fallback of [
      'reseller/eu/model',
      'author/global/model',
      'author/unknown/model',
      'author/us/model',
      'author/eu/fast',
      'missing',
    ])
      expect(() =>
        assertGovernedRoutes(synthetic, policy, modelId, ['author/eu/model', fallback]),
      ).toThrow('fallback route');
    expect(() =>
      assertGovernedRoutes(synthetic, { deploymentIds: [] }, modelId, ['author/eu/model']),
    ).toThrow();
    expect(() =>
      assertGovernedRoutes(synthetic, { fallback: false }, modelId, [
        'author/eu/model',
        'reseller/eu/model',
      ]),
    ).toThrow('Fallback');
    const upscaled = {
      ...synthetic,
      routes: synthetic.routes.map((route) => ({ ...route, fidelity: 'upscaled' as const })),
    };
    expect(() => assertGovernedRoutes(upscaled, policy, modelId, ['author/eu/model'])).toThrow();
  });

  it('constrains explicit processing scope independently of endpoint and known locations', () => {
    const scoped: GovernedRoutingPolicy = {
      processingScopes: ['regional'],
      endpointRegions: ['eu'],
    };
    expect(validateRoutingPolicy(scoped).processingScopes).toEqual(['regional']);
    const materialized = materializeRoutingPolicy(synthetic, scoped, modelId);
    expect(materialized.deploymentIds).toEqual(
      synthetic.deployments
        .filter((deployment) => deployment.scope === 'regional')
        .map((deployment) => deployment.id)
        .sort(),
    );
    expect(
      materializeRoutingPolicy(synthetic, { ...scoped, deploymentIds: [] }, modelId).deploymentIds,
    ).toEqual([]);
    expect(() => validateRoutingPolicy({ processingScopes: ['eu'] })).toThrow('scope');
    expect(() => constrainRoutingPolicy(scoped, { processingScopes: ['global'] })).toThrow(
      'processingScopes',
    );
    expect(
      intersectRoutingPolicies({ processingScopes: ['regional', 'global'] }, scoped),
    ).toMatchObject({ processingScopes: ['regional'] });
    expect(intersectRoutingPolicies(scoped, { processingScopes: ['global'] })).toMatchObject({
      processingScopes: [],
    });
    expect(() =>
      assertGovernedRoutes(synthetic, scoped, modelId, ['author/eu/model']),
    ).not.toThrow();
    const globallyScoped = {
      ...synthetic,
      deployments: synthetic.deployments.map((deployment) => ({
        ...deployment,
        scope: 'global' as const,
        processingRegions: ['eu'],
      })),
    };
    expect(() =>
      assertGovernedRoutes(globallyScoped, scoped, modelId, ['author/eu/model']),
    ).toThrow('fallback route');
  });

  it('materializes only broker policy without mutating canonical model input', () => {
    const input = {
      modelId,
      operation: 'text-to-image' as const,
      input: { prompt: 'Synthetic fixture' },
      routing: { endpointRegions: ['eu'] },
    };
    const output = constrainGovernedInput(
      synthetic,
      { modelIds: [modelId], authorOnly: true },
      input,
    );
    expect(output.input).toBe(input.input);
    expect(output.routing).toEqual({ providerIds: ['author'], endpointRegions: ['eu'] });
    expect(input.routing).toEqual({ endpointRegions: ['eu'] });
    expect(JSON.stringify(output.input)).not.toContain('authorOnly');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)('transactional saved routing profile lifecycle', () => {
  async function setup(max = 1) {
    const f = await governanceFixture(max);
    const key = await f.accounts.createKey(f.workspaceId, {
      name: 'Profile administrator',
      scopes: ['read', 'generate', 'policies:write'],
    });
    const actor: GovernancePrincipal = {
      ...(await f.accounts.authenticate(key.token))!,
      keySecretVersion: 1,
    };
    const store = new RoutingPolicyStore(f.pool, catalog, revalidateGovernanceAuthority);
    return { ...f, actor, store, adminKey: key };
  }

  it('renames, updates and archives without unbinding keys or rewriting an accepted snapshot', async () => {
    const f = await setup();
    try {
      const created = await f.store.create(f.actor, {
        name: 'EU original',
        policy: { endpointRegions: ['eu'] },
        maxCostMicros: 100,
      });
      const bound = await f.accounts.createKey(f.workspaceId, {
        name: 'Bound',
        scopes: ['read', 'generate'],
        policyId: created.id,
      });
      const changed = await f.store.update(f.actor, created.id, 1, {
        name: 'EU revised',
        policy: { providerIds: ['fal'], authorOnly: true },
        maxCostMicros: 50,
      });
      expect(changed).toMatchObject({ name: 'EU revised', revision: 2, maxCostMicros: 50 });
      expect(created).toMatchObject({
        name: 'EU original',
        revision: 1,
        policy: { endpointRegions: ['eu'] },
        maxCostMicros: 100,
      });
      await expect(f.store.update(f.actor, created.id, 1, { name: 'Stale' })).rejects.toMatchObject(
        { code: 'policy_conflict' },
      );
      const archived = await f.store.archive(f.actor, created.id, 2);
      expect(archived.archivedAt).not.toBeNull();
      expect(await f.store.list(f.actor)).toEqual([]);
      expect((await f.store.list(f.actor, true))[0]?.revision).toBe(3);
      expect(
        (await f.pool.query('SELECT policy_id FROM mr_api_keys WHERE id=$1', [bound.id])).rows[0]
          .policy_id,
      ).toBe(created.id);
      await expect(
        f.tx((client) => loadBoundRoutingPolicy(client, f.workspaceId, created.id)),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await expect(
        f.store.update(f.actor, created.id, 3, { name: 'Restore silently' }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    } finally {
      await f.close();
    }
  });

  it('denies cross-workspace profiles, stale revoked administrators and restricted actors under the lock', async () => {
    const f = await setup();
    try {
      const created = await f.store.create(f.actor, { name: 'Private', policy: {} });
      const otherWorkspace = `other_${randomUUID()}`;
      await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
        otherWorkspace,
      ]);
      const otherKey = await f.accounts.createKey(otherWorkspace, {
        name: 'Other admin',
        scopes: ['read', 'policies:write'],
      });
      const other: GovernancePrincipal = {
        ...(await f.accounts.authenticate(otherKey.token))!,
        keySecretVersion: 1,
      };
      await expect(f.store.update(other, created.id, 1, { name: 'Foreign' })).rejects.toMatchObject(
        { code: 'policy_denied' },
      );
      expect(await f.store.list(other)).toEqual([]);
      const restricted = await f.accounts.createKey(f.workspaceId, {
        name: 'Restricted',
        scopes: ['read', 'policies:write'],
        policyId: created.id,
      });
      await expect(
        f.store.create(
          {
            ...(await f.accounts.authenticate(restricted.token))!,
            keySecretVersion: 1,
          } as GovernancePrincipal,
          {
            name: 'Escalation',
            policy: {},
          },
        ),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await f.pool.query('UPDATE mr_api_keys SET monthly_cap_micros=100 WHERE id=$1', [
        f.adminKey.id,
      ]);
      await expect(
        f.store.update(f.actor, created.id, 1, { name: 'Cap bypass' }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await f.pool.query('UPDATE mr_api_keys SET monthly_cap_micros=NULL WHERE id=$1', [
        f.adminKey.id,
      ]);
      await f.accounts.revokeKey(f.workspaceId, f.adminKey.id);
      await expect(
        f.store.create(f.actor, { name: 'Stale authorization', policy: {} }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      expect(
        (
          await f.pool.query('SELECT count(*)::int AS n FROM mr_policies WHERE workspace_id=$1', [
            f.workspaceId,
          ])
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });

  it('rejects prepared authority after archiving and intersects a lowered model policy before admission', async () => {
    const f = await setup();
    try {
      const models = catalog.models.slice(0, 2).map((model) => model.id);
      const created = await f.store.create(f.actor, {
        name: 'Mutable admission policy',
        policy: { modelIds: models },
      });
      const bound = await f.accounts.createKey(f.workspaceId, {
        name: 'Prepared',
        scopes: ['read', 'generate'],
        policyId: created.id,
      });
      const prepared: GovernancePrincipal = {
        ...(await f.accounts.authenticate(bound.token))!,
        keySecretVersion: 1,
      };
      await f.store.update(f.actor, created.id, 1, { policy: { modelIds: [models[0]!] } });
      const fresh = await f.tx((client) => revalidateGovernanceAuthority(client, prepared));
      expect(fresh.policy).toMatchObject({ modelIds: [models[0]] });
      expect(() => materializeRoutingPolicy(catalog, fresh.policy!, models[1]!)).toThrow(
        'exact model',
      );
      await f.store.archive(f.actor, created.id, 2);
      await expect(
        f.tx((client) => revalidateGovernanceAuthority(client, prepared)),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    } finally {
      await f.close();
    }
  });
  it.skipIf(process.env.TEST_NATIVE_POSTGRES !== '1')(
    'serializes simultaneous edits and revalidates prepared admissions behind a narrowing/archive lock',
    async () => {
      const f = await setup(3);
      try {
        const models = catalog.models.slice(0, 2).map((model) => model.id);
        const created = await f.store.create(f.actor, {
          name: 'Native race',
          policy: { modelIds: models },
        });
        const results = await Promise.allSettled([
          f.store.update(f.actor, created.id, 1, { name: 'First edit' }),
          f.store.update(f.actor, created.id, 1, { name: 'Second edit' }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.find((result) => result.status === 'rejected')).toMatchObject({
          reason: { code: 'policy_conflict' },
        });
        const bound = await f.accounts.createKey(f.workspaceId, {
          name: 'Preparing',
          scopes: ['read', 'generate'],
          policyId: created.id,
        });
        const prepared: GovernancePrincipal = {
          ...(await f.accounts.authenticate(bound.token))!,
          keySecretVersion: 1,
        };
        let locked!: () => void;
        let release!: () => void;
        let lockReady = new Promise<void>((resolve) => {
          locked = resolve;
        });
        let releaseEdit = new Promise<void>((resolve) => {
          release = resolve;
        });
        const editing = new RoutingPolicyStore(f.pool, catalog, async (client, actor, scope) => {
          const fresh = await revalidateGovernanceAuthority(client, actor, scope);
          locked();
          await releaseEdit;
          return fresh;
        });
        const lowering = editing.update(f.actor, created.id, 2, {
          policy: { modelIds: [models[0]!] },
          maxCostMicros: 10,
        });
        await lockReady;
        const admission = f.tx((client) => revalidateGovernanceAuthority(client, prepared));
        release();
        await lowering;
        const fresh = await admission;
        expect(fresh).toMatchObject({ policy: { modelIds: [models[0]] }, maxCostMicros: 10 });
        expect(() => materializeRoutingPolicy(catalog, fresh.policy!, models[1]!)).toThrow(
          'exact model',
        );
        lockReady = new Promise<void>((resolve) => {
          locked = resolve;
        });
        releaseEdit = new Promise<void>((resolve) => {
          release = resolve;
        });
        const archiving = editing.archive(f.actor, created.id, 3);
        await lockReady;
        // Install the rejection observer before allowing the lock holder to commit.
        const deniedAdmission = expect(
          f.tx((client) => revalidateGovernanceAuthority(client, prepared)),
        ).rejects.toMatchObject({ code: 'policy_denied' });
        release();
        await archiving;
        await deniedAdmission;
      } finally {
        await f.close();
      }
    },
  );
});
