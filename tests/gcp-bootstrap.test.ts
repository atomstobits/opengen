import { describe, expect, it } from 'vitest';
import {
  bootstrap,
  bootstrapCli,
  bootstrapPlan,
  bucketPolicy,
  configuration,
  validateSql,
} from '../infra/gcp-bootstrap.mjs';
import { setupVercelWif, vercelWifPlan } from '../infra/vercel-wif.mjs';

const options = {
  project: 'fixture-project',
  region: 'us-central1',
  bucket: 'fixture-opengen-private-assets',
  publicOrigin: 'https://opengen.example',
};
const c = configuration(options);
function sql() {
  return {
    name: c.instance,
    region: c.region,
    databaseVersion: 'POSTGRES_17',
    state: 'RUNNABLE',
    settings: {
      edition: 'ENTERPRISE',
      tier: 'db-f1-micro',
      availabilityType: 'ZONAL',
      dataDiskSizeGb: '10',
      storageAutoResize: false,
      connectorEnforcement: 'REQUIRED',
      deletionProtectionEnabled: true,
      ipConfiguration: { authorizedNetworks: [], sslMode: 'ENCRYPTED_ONLY' },
      backupConfiguration: {
        enabled: true,
        pointInTimeRecoveryEnabled: true,
        transactionLogRetentionDays: 7,
        backupRetentionSettings: { retainedBackups: 7 },
        startTime: '10:00',
      },
    },
  };
}
function bucket() {
  return {
    name: c.bucket,
    location: 'US-CENTRAL1',
    storageClass: 'STANDARD',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true },
      publicAccessPrevention: 'enforced',
    },
    ...bucketPolicy(c),
  };
}
function fixture(existing = false) {
  const calls: { args: string[]; input?: string }[] = [],
    rest: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const resources = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const users: { name: string }[] = [];
  let database = false,
    hmacCreated = false;
  const identity = (role: string) => ({ email: c.accounts[role] });
  const registry = {
    name: `projects/${c.project}/locations/${c.region}/repositories/opengen`,
    format: 'DOCKER',
    mode: 'STANDARD_REPOSITORY',
  };
  if (existing) {
    for (const role of Object.keys(c.accounts))
      resources.set(`sa:${c.accounts[role]}`, identity(role));
    resources.set('registry', registry);
    resources.set('bucket', bucket());
    resources.set('sql', sql());
  }
  const driver = {
    async command(args: string[], meta: { input?: string; absent?: boolean } = {}) {
      calls.push({ args, ...(meta.input ? { input: meta.input } : {}) });
      const key = args.slice(0, 3).join(' ');
      if (key === 'projects describe fixture-project')
        return { projectId: c.project, lifecycleState: 'ACTIVE' };
      if (key === 'projects get-iam-policy fixture-project') return { bindings: [] };
      if (key === 'billing projects describe') return { billingEnabled: true };
      if (key === 'iam service-accounts describe') return resources.get(`sa:${args[3]}`) ?? null;
      if (key === 'iam service-accounts create') {
        const role = args[3]!.slice('opengen-'.length);
        resources.set(`sa:${c.accounts[role]}`, identity(role));
        return {};
      }
      if (key === 'artifacts repositories describe') return resources.get('registry') ?? null;
      if (key === 'artifacts repositories create') {
        resources.set('registry', registry);
        return {};
      }
      if (key === 'storage buckets describe') return resources.get('bucket') ?? null;
      if (key === 'storage buckets create') {
        resources.set('bucket', bucket());
        return {};
      }
      if (key === 'sql instances describe') return resources.get('sql') ?? null;
      if (key === 'sql instances create') {
        resources.set('sql', sql());
        return {};
      }
      if (key === 'secrets describe ' + args[2])
        return secrets.has(args[2]!)
          ? {
              replication: { userManaged: { replicas: [{ location: c.region }] } },
              labels: { 'managed-by': 'opengen-bootstrap' },
            }
          : null;
      if (args[0] === 'secrets' && args[1] === 'create') return {};
      if (key === 'secrets versions list')
        return secrets.has(args[3]!)
          ? [{ name: `projects/${c.project}/secrets/${args[3]}/versions/1`, state: 'ENABLED' }]
          : [];
      if (key === 'secrets versions add') {
        secrets.set(args[3]!, meta.input!);
        return { name: `projects/${c.project}/secrets/${args[3]}/versions/1` };
      }
      if (key === 'sql databases describe') return database ? { name: c.database } : null;
      if (key === 'sql databases create') {
        database = true;
        return {};
      }
      if (key === 'sql users list') return users;
      if (key === 'storage hmac list')
        return hmacCreated || secrets.has('opengen-storage-bootstrap')
          ? [
              {
                accessId: 'fixtureAccessIdentifier1234',
                serviceAccountEmail: c.accounts.storage,
                state: 'ACTIVE',
              },
            ]
          : [];
      if (key === 'storage hmac create') {
        hmacCreated = true;
        return {
          metadata: { accessId: 'fixtureAccessIdentifier1234' },
          secret: 'fixture-'.repeat(5),
        };
      }
      if (key === 'sql operations wait' || args.includes('add-iam-policy-binding')) return {};
      throw new Error('Unexpected fixture command: ' + args.join(' '));
    },
    async secretAccess(_project: string, name: string) {
      return secrets.get(name)!;
    },
    async rest(method: string, url: string, body?: Record<string, unknown>) {
      rest.push({ method, url, body });
      if (url.includes('/users')) {
        users.push({ name: c.sqlUser });
        return { name: 'fixture-user-operation' };
      }
      if (method === 'PATCH') return {};
      if (url.includes('/hmacKeys?') && method === 'GET') return { items: [] };
      if (url.includes('/hmacKeys?') && method === 'POST') {
        hmacCreated = true;
        return {
          metadata: { accessId: 'fixtureAccessIdentifier1234' },
          secret: 'fixture-'.repeat(5),
        };
      }
      if (url.includes('/hmacKeys/'))
        return { serviceAccountEmail: c.accounts.storage, state: 'ACTIVE' };
      throw new Error('Unexpected fixture HTTP');
    },
    async sleep() {},
  };
  return {
    driver,
    calls,
    rest,
    resources,
    secrets,
    users,
    get hmacCreated() {
      return hmacCreated;
    },
  };
}
describe('reviewable GCP bootstrap without live cloud calls', () => {
  it('defaults to an offline plan, keeps project/billing creation out and never accepts inline secrets', async () => {
    let called = false;
    const plan = await bootstrap(options, {
      command: async () => {
        called = true;
      },
    });
    expect(plan.mode).toBe('plan');
    expect(called).toBe(false);
    expect(plan.creationCommands.some((args: string[]) => args.includes('projects'))).toBe(false);
    expect(plan.creationCommands.find((args: string[]) => args.includes('sql'))).toContain(
      'REQUIRED',
    );
    expect(
      await bootstrapCli(['--project', options.project, '--bucket', options.bucket]),
    ).toMatchObject({ mode: 'plan' });
    await expect(
      bootstrapCli([
        '--project',
        options.project,
        '--bucket',
        options.bucket,
        '--password',
        'private',
      ]),
    ).rejects.toThrow();
    expect(() =>
      bootstrapPlan({ ...options, publicOrigin: 'https://user:secret@example.com' }),
    ).toThrow('canonical');
  });
  it('stops before mutation on unsafe existing DB, bucket or account drift', async () => {
    for (const resource of ['sql', 'bucket', `sa:${c.accounts.worker}`]) {
      const f = fixture(true);
      f.resources.set(
        resource,
        resource === 'sql'
          ? {
              ...sql(),
              settings: {
                ...sql().settings,
                ipConfiguration: {
                  authorizedNetworks: [{ value: '0.0.0.0/0' }],
                  sslMode: 'ENCRYPTED_ONLY',
                },
              },
            }
          : resource === 'bucket'
            ? { ...bucket(), iamConfiguration: {} }
            : { email: c.accounts.worker, disabled: true },
      );
      await expect(
        bootstrap(
          {
            ...options,
            apply: true,
            receipt: '/private/tmp/nonexistent-fixture-opengen.json',
            saveReceipt: async () => {},
          },
          f.driver,
        ),
      ).rejects.toThrow('drift');
      expect(
        f.calls.every(
          ({ args }) => !args.includes('create') && !args.includes('add-iam-policy-binding'),
        ),
      ).toBe(true);
    }
    expect(() =>
      validateSql(
        { ...sql(), settings: { ...sql().settings, deletionProtectionEnabled: false } },
        c,
      ),
    ).toThrow('drift');
  });
  it('creates the approved footprint, sends secret bytes only through captured stdin/HTTP and reuses credentials on rerun', async () => {
    const f = fixture();
    const snapshots: unknown[] = [];
    const apply = {
      ...options,
      apply: true,
      receipt: '/private/tmp/nonexistent-fixture-opengen.json',
      saveReceipt: async (receipt: unknown) => {
        snapshots.push(structuredClone(receipt));
      },
    };
    const first = await bootstrap(apply, f.driver);
    expect(first.readiness.runtime).toBe('not-managed-by-bootstrap');
    expect(f.hmacCreated).toBe(true);
    const before = [...f.secrets];
    const created = f.calls.filter(({ args }) => args.includes('create')).length;
    const result = await bootstrap(apply, f.driver);
    expect([...f.secrets]).toEqual(before);
    expect(f.calls.filter(({ args }) => args.includes('create'))).toHaveLength(created);
    expect(
      f.rest.filter(({ method, url }) => method === 'POST' && url.includes('/users')),
    ).toHaveLength(1);
    expect(
      f.calls.filter(({ args }) => args.slice(0, 3).join(' ') === 'storage hmac create'),
    ).toHaveLength(1);
    const printable = JSON.stringify({
      first,
      result,
      snapshots,
      commands: f.calls.map(({ args }) => args),
    });
    for (const privateValue of [
      'fixture-'.repeat(5),
      ...[...f.secrets]
        .filter(([name]) => /token|secret|vault|database/.test(name))
        .map(([, value]) => value),
    ])
      expect(printable).not.toContain(privateValue);
    const workerBindings = f.calls.filter(({ args }) =>
      args.includes(`serviceAccount:${c.accounts.worker}`),
    );
    expect(JSON.stringify(workerBindings)).not.toMatch(
      /opengen-session-secret|opengen-installation-token|opengen-storage-bootstrap/,
    );
    expect(
      f.calls.some(({ args }) => args.includes('roles/owner') || args.includes('roles/editor')),
    ).toBe(false);
  });
  it('uses the installed-SDK adapter for SQL credentials when provided and never falls back to a duplicate REST create', async () => {
    const f = fixture(true);
    let sdkCalls = 0;
    const driver = {
      ...f.driver,
      async createSqlUser(project: string, instance: string, username: string, password: string) {
        sdkCalls++;
        expect({ project, instance, username }).toEqual({
          project: c.project,
          instance: c.instance,
          username: c.sqlUser,
        });
        expect(password).toMatch(/^[a-f0-9]{64}$/);
        f.users.push({ name: username });
        return { name: 'sdk-user-operation', passwordReset: false };
      },
    };
    await bootstrap(
      {
        ...options,
        apply: true,
        receipt: '/private/tmp/nonexistent-fixture-opengen.json',
        saveReceipt: async () => {},
      },
      driver,
    );
    expect(sdkCalls).toBe(1);
    expect(f.rest.some(({ url }) => url.includes('/users'))).toBe(false);
  });

  it('retries only acknowledged resource reads during propagation without duplicate creates', async () => {
    const f = fixture(),
      prior = f.driver.command;
    let delayed = false;
    f.driver.command = async (args, meta) => {
      if (
        !delayed &&
        args[0] === 'iam' &&
        args[1] === 'service-accounts' &&
        args[2] === 'describe' &&
        args[3] === c.accounts.worker &&
        f.resources.has(`sa:${c.accounts.worker}`)
      ) {
        delayed = true;
        return null;
      }
      return prior(args, meta);
    };
    await bootstrap(
      {
        ...options,
        apply: true,
        receipt: '/private/tmp/nonexistent-fixture-opengen.json',
        saveReceipt: async () => {},
      },
      f.driver,
    );
    expect(delayed).toBe(true);
    expect(
      f.calls.filter(
        ({ args }) => args[0] === 'iam' && args[2] === 'create' && args[3] === 'opengen-worker',
      ),
    ).toHaveLength(1);
  });

  it('rejects an existing runtime identity with project-wide secret or admin access before writes', async () => {
    const f = fixture(true),
      prior = f.driver.command;
    f.driver.command = async (args, meta) =>
      args[0] === 'projects' && args[1] === 'get-iam-policy'
        ? {
            bindings: [
              {
                role: 'roles/secretmanager.secretAccessor',
                members: [`serviceAccount:${c.accounts.worker}`],
              },
            ],
          }
        : prior(args, meta);
    await expect(
      bootstrap(
        {
          ...options,
          apply: true,
          receipt: '/private/tmp/nonexistent-fixture-opengen.json',
          saveReceipt: async () => {},
        },
        f.driver,
      ),
    ).rejects.toThrow('unexpected project-wide role');
    expect(
      f.calls.every(
        ({ args }) => !args.includes('create') && !args.includes('add-iam-policy-binding'),
      ),
    ).toBe(true);
  });

  it('never includes malformed private credential content in an error', async () => {
    const f = fixture(true);
    f.secrets.set('opengen-storage-bootstrap', 'PRIVATE_MALFORMED_SECRET_DO_NOT_PRINT');
    let message = '';
    try {
      await bootstrap(
        {
          ...options,
          apply: true,
          receipt: '/private/tmp/nonexistent-fixture-opengen.json',
          saveReceipt: async () => {},
        },
        f.driver,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('private payload suppressed');
    expect(message).not.toContain('PRIVATE_MALFORMED_SECRET_DO_NOT_PRINT');
  });

  it('refuses mismatched storage credentials rather than silently rotating or replacing them', async () => {
    const f = fixture(true);
    f.secrets.set(
      'opengen-storage-bootstrap',
      JSON.stringify({
        accessId: 'fixtureAccessIdentifier1234',
        secret: 'fixture-'.repeat(5),
      }),
    );
    f.secrets.set('opengen-storage-access', 'wrongExistingAccessId1234');
    await expect(
      bootstrap(
        {
          ...options,
          apply: true,
          receipt: '/private/tmp/nonexistent-fixture-opengen.json',
          saveReceipt: async () => {},
        },
        f.driver,
      ),
    ).rejects.toThrow('disagrees');
    expect(f.secrets.get('opengen-storage-access')).toBe('wrongExistingAccessId1234');
  });
});
const wifOptions = {
  ...options,
  projectNumber: '123456789012',
  teamSlug: 'fixture-team',
  teamId: 'team_fixture',
  projectName: 'opengen',
  vercelProjectId: 'prj_fixture',
};
describe('restricted Vercel federation plan', () => {
  it('pins issuer, stable team/project IDs and exact production subject with no wildcard grants', async () => {
    const plan = vercelWifPlan(wifOptions);
    expect(plan.condition).toContain("assertion.owner_id == 'team_fixture'");
    expect(plan.condition).toContain("assertion.project_id == 'prj_fixture'");
    expect(plan.condition).toContain("assertion.environment == 'production'");
    expect(plan.audience).toBe(`https://iam.googleapis.com/${plan.resource}`);
    expect(plan.issuer).toBe('https://oidc.vercel.com/fixture-team');
    expect(JSON.stringify(plan.commands)).not.toMatch(/allUsers|allAuthenticatedUsers|\*/);
    expect(() => vercelWifPlan({ ...wifOptions, teamSlug: '*' })).toThrow();
    expect(() => vercelWifPlan({ ...wifOptions, vercelProjectId: '' })).toThrow();
    let called = false;
    expect(
      await setupVercelWif(wifOptions, {
        command: async () => {
          called = true;
        },
      }),
    ).toMatchObject({ mode: 'plan' });
    expect(called).toBe(false);
  });
  it('refuses public API IAM or mismatched existing provider trust before federation writes', async () => {
    for (const publicApi of [true, false]) {
      const plan = vercelWifPlan(wifOptions),
        mutations: string[][] = [];
      const driver = {
        async command(args: string[]) {
          if (
            args.includes('add-iam-policy-binding') ||
            args.includes('create-oidc') ||
            args.includes('create')
          ) {
            mutations.push(args);
            return {};
          }
          if (args[0] === 'projects') return { projectNumber: wifOptions.projectNumber };
          if (args.includes('get-iam-policy'))
            return { bindings: publicApi ? [{ members: ['allUsers'] }] : [] };
          if (args[0] === 'run')
            return { status: { url: 'https://opengen-api-fixture-uc.a.run.app' } };
          if (args.includes('service-accounts')) return { email: plan.caller };
          if (args.includes('providers'))
            return { state: 'ACTIVE', oidc: { issuerUri: 'https://oidc.vercel.com/other-team' } };
          return { state: 'ACTIVE' };
        },
      };
      await expect(setupVercelWif({ ...wifOptions, apply: true }, driver)).rejects.toThrow(
        publicApi ? 'public IAM' : 'trust differs',
      );
      expect(mutations).toEqual([]);
    }
  });
});

it('never plans an age-only lifecycle deletion for pinned application inputs', () => {
  const policy = bucketPolicy(c);
  expect(policy.lifecycle.rule.flatMap((rule) => rule.condition.matchesPrefix)).toEqual([
    'outputs/',
  ]);
  expect(policy.cors[0].responseHeader).toEqual([
    'Content-Type',
    'ETag',
    'If-None-Match',
    'x-goog-if-generation-match',
  ]);
});
