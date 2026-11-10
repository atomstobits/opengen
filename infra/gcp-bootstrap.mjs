#!/usr/bin/env node
// Provision only an explicitly selected existing OpenGen project. Default is an offline plan.
import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';
import { promisify, parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, rename, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const json = (value) => JSON.stringify(value, null, 2) + '\n';
const canonical = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
export function configuration(options) {
  const { project, region = 'us-central1', bucket, publicOrigin = 'https://opengen.dev' } = options;
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? '') ||
    !/^[a-z]+(-[a-z0-9]+)+[0-9]$/.test(region) ||
    !/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(bucket ?? '') ||
    bucket.includes('..')
  )
    throw new Error(
      'Supply valid explicit project, region and globally unique bucket identifiers.',
    );
  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    /* invalid */
  }
  if (
    !origin ||
    origin.protocol !== 'https:' ||
    origin.origin !== publicOrigin ||
    origin.username ||
    origin.password ||
    !origin.hostname.includes('.') ||
    isIP(origin.hostname) ||
    /(?:^|\.)(localhost|local|internal)$/.test(origin.hostname)
  )
    throw new Error('Supply a canonical public HTTPS origin without path, credentials or query.');
  return {
    project,
    region,
    bucket,
    publicOrigin,
    instance: 'opengen-db',
    database: 'opengen',
    sqlUser: 'opengen',
    repository: 'opengen',
    connection: `${project}:${region}:opengen-db`,
    accounts: Object.fromEntries(
      ['api', 'worker', 'storage', 'vercel'].map((role) => [
        role,
        `opengen-${role}@${project}.iam.gserviceaccount.com`,
      ]),
    ),
  };
}
export function bootstrapPlan(options) {
  const c = configuration(options),
    common = ['--project', c.project];
  const creation = [
    ...Object.keys(c.accounts).map((role) => [
      'iam',
      'service-accounts',
      'create',
      `opengen-${role}`,
      ...common,
      '--display-name',
      `OpenGen ${role}`,
    ]),
    [
      'artifacts',
      'repositories',
      'create',
      c.repository,
      ...common,
      '--location',
      c.region,
      '--repository-format',
      'docker',
    ],
    [
      'storage',
      'buckets',
      'create',
      `gs://${c.bucket}`,
      ...common,
      '--location',
      c.region,
      '--uniform-bucket-level-access',
      '--public-access-prevention',
    ],
    [
      'sql',
      'instances',
      'create',
      c.instance,
      ...common,
      '--region',
      c.region,
      '--database-version',
      'POSTGRES_17',
      '--edition',
      'ENTERPRISE',
      '--tier',
      'db-f1-micro',
      '--availability-type',
      'ZONAL',
      '--storage-size',
      '10',
      '--no-storage-auto-increase',
      '--backup-start-time',
      '10:00',
      '--retained-backups-count',
      '7',
      '--enable-point-in-time-recovery',
      '--retained-transaction-log-days',
      '7',
      '--deletion-protection',
      '--connector-enforcement',
      'REQUIRED',
      '--ssl-mode',
      'ENCRYPTED_ONLY',
      '--async',
    ],
  ];
  return {
    mode: 'plan',
    configuration: c,
    creationCommands: creation.map((args) => ['gcloud', ...args]),
    sharedSecrets: [
      'opengen-database-url',
      'opengen-vault-key',
      'opengen-storage-access',
      'opengen-storage-secret',
      'opengen-storage-bucket',
      'opengen-storage-endpoint',
      'opengen-storage-region',
    ],
    apiOnlySecrets: ['opengen-installation-token', 'opengen-session-secret'],
    privateBootstrapSecret: 'opengen-storage-bootstrap',
    notes: [
      'No cloud request or mutation in plan mode.',
      'Apply describes every existing resource and rejects incompatible settings; no automatic credential resets or key rotation.',
      'No provider credentials, OAuth client secrets, Vercel configuration, runtime deployment or project/billing creation.',
      'SQL public address is connector-only with no authorized networks; no VPC connector or NAT.',
      'A new Cloud SQL built-in user has broad default roles. After migrations, complete docs/RUNTIME-PERMISSIONS.md and verify reduced attributes before treating the runtime as qualified.',
      'Storage uses existing S3-compatible implementation via scoped HMAC kept in Secret Manager.',
    ],
  };
}
/** All subprocess and HTTP responses are captured. Never echo raw cloud errors or request bodies. */
export function cloudDriver() {
  let token;
  const command = async (args, { input, absent = false } = {}) => {
    try {
      const child = execFile('gcloud', [...args, '--quiet', '--format=json'], {
        encoding: 'utf8',
        maxBuffer: 4_000_000,
        env: { ...process.env, CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_VERBOSITY: 'error' },
      });
      child.stdin.on('error', () => {});
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
      return await new Promise((yes, no) => {
        let stdout = '',
          stderr = '';
        child.stdout.on('data', (part) => (stdout += part));
        child.stderr.on('data', (part) => (stderr += part));
        child.once('error', () => no(new Error('Google Cloud CLI could not start.')));
        child.once('close', (status) => {
          if (status === 0) {
            try {
              yes(stdout.trim() ? JSON.parse(stdout) : {});
            } catch {
              no(new Error('Google Cloud CLI returned invalid JSON.'));
            }
          } else if (
            absent &&
            /NOT_FOUND|not found|does not exist/i.test(stderr) &&
            !/PERMISSION_DENIED|permission|forbidden/i.test(stderr)
          )
            yes(null);
          else
            no(
              new Error(
                `Google Cloud command failed (${args.slice(0, 3).join(' ')}); inspect the private operator environment without printing secret payloads.`,
              ),
            );
        });
      });
    } catch {
      throw new Error(
        `Google Cloud command failed (${args.slice(0, 3).join(' ')}); private command output was suppressed.`,
      );
    }
  };
  return {
    command,
    async createSqlUser(project, instance, username, password) {
      let sdk;
      try {
        const metadata = await execute(
          'gcloud',
          ['info', '--format=value(installation.sdk_root,basic.python_location)'],
          { encoding: 'utf8', maxBuffer: 100_000 },
        );
        const [root, python] = metadata.stdout.trim().split('\t');
        if (!isAbsolute(root ?? '') || !isAbsolute(python ?? '')) throw new Error();
        sdk = { root, python };
      } catch {
        throw new Error('Installed Google SDK/Python discovery failed; private output suppressed.');
      }
      const child = execFile(
        sdk.python,
        [
          fileURLToPath(new URL('./gcp-create-sql-user.py', import.meta.url)),
          '--sdk-root',
          sdk.root,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 1_000_000,
          env: {
            ...process.env,
            CLOUDSDK_CORE_LOG_HTTP: 'false',
            CLOUDSDK_CORE_VERBOSITY: 'error',
          },
        },
      );
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ project, instance, username, password }));
      return new Promise((yes, no) => {
        let stdout = '';
        child.stdout.on('data', (part) => (stdout += part));
        child.stderr.on('data', () => {});
        child.once('error', () => no(new Error('Google SDK SQL-user adapter could not start.')));
        child.once('close', (status) => {
          if (status !== 0)
            return no(
              new Error(
                'SQL user acceptance is unknown or failed; reconcile the named user/operation read-only. Private payload suppressed.',
              ),
            );
          try {
            yes(JSON.parse(stdout));
          } catch {
            no(new Error('SQL-user adapter metadata invalid; reconcile read-only, without reset.'));
          }
        });
      });
    },
    async secretAccess(project, name, version) {
      try {
        const result = await execute(
          'gcloud',
          [
            'secrets',
            'versions',
            'access',
            String(version),
            '--secret',
            name,
            '--project',
            project,
            '--quiet',
          ],
          {
            encoding: 'utf8',
            maxBuffer: 1_000_000,
            env: {
              ...process.env,
              CLOUDSDK_CORE_LOG_HTTP: 'false',
              CLOUDSDK_CORE_VERBOSITY: 'error',
            },
          },
        );
        return result.stdout;
      } catch {
        throw new Error('Pinned Secret Manager version could not be read; output suppressed.');
      }
    },
    async rest(method, url, body) {
      if (!/^https:\/\/(?:sqladmin|storage)\.googleapis\.com\//.test(url))
        throw new Error('Unapproved Google API target.');
      if (!token) {
        try {
          token = (
            await execute('gcloud', ['auth', 'print-access-token', '--quiet'], {
              encoding: 'utf8',
              maxBuffer: 100_000,
            })
          ).stdout.trim();
        } catch {
          throw new Error('Google Cloud access-token acquisition failed.');
        }
      }
      let response;
      try {
        response = await fetch(url, {
          method,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        throw new Error(
          'Google storage transport failed; private URLs, request/response payloads suppressed.',
        );
      }
      if (!response.ok)
        throw new Error(
          `Google API returned HTTP ${response.status}; private payloads suppressed.`,
        );
      return response.json();
    },
    sleep: pause,
  };
}
function ensure(condition, message) {
  if (!condition)
    throw new Error(
      `Existing resource drift: ${message}. No automatic repair or credential reset.`,
    );
}
export function validateSql(value, c) {
  const s = value.settings ?? {},
    ip = s.ipConfiguration ?? {},
    backup = s.backupConfiguration ?? {};
  ensure(
    value.name === c.instance &&
      value.region === c.region &&
      value.databaseVersion === 'POSTGRES_17',
    'SQL identity, region or version',
  );
  ensure(
    s.edition === 'ENTERPRISE' &&
      s.tier === 'db-f1-micro' &&
      s.availabilityType === 'ZONAL' &&
      String(s.dataDiskSizeGb) === '10' &&
      s.storageAutoResize === false,
    'SQL size, edition or growth policy',
  );
  ensure(
    (ip.authorizedNetworks ?? []).length === 0 &&
      ip.sslMode === 'ENCRYPTED_ONLY' &&
      s.connectorEnforcement === 'REQUIRED',
    'SQL connector/TLS/network access',
  );
  ensure(
    s.deletionProtectionEnabled === true &&
      backup.enabled === true &&
      backup.pointInTimeRecoveryEnabled === true &&
      backup.transactionLogRetentionDays === 7 &&
      backup.backupRetentionSettings?.retainedBackups === 7 &&
      backup.startTime === '10:00',
    'SQL protection or backup retention',
  );
}
export const bucketPolicy = (c) => ({
  cors: [
    {
      origin: [c.publicOrigin],
      method: ['GET', 'HEAD', 'PUT'],
      responseHeader: ['Content-Type', 'ETag', 'If-None-Match', 'x-goog-if-generation-match'],
      maxAgeSeconds: 3600,
    },
  ],
  lifecycle: {
    // Inputs are application-managed: age-only deletion would bypass accepted-job pins.
    rule: ['outputs/'].map((prefix) => ({
      action: { type: 'Delete' },
      condition: { age: 7, matchesPrefix: [prefix] },
    })),
  },
});
export function validateBucket(value, c) {
  ensure(
    value.name === c.bucket &&
      value.location?.toLowerCase() === c.region &&
      value.storageClass === 'STANDARD',
    'bucket identity/location/class',
  );
  ensure(
    value.iamConfiguration?.uniformBucketLevelAccess?.enabled === true &&
      value.iamConfiguration?.publicAccessPrevention === 'enforced',
    'bucket uniform/private access',
  );
  const policy = bucketPolicy(c);
  ensure(
    canonical(value.cors ?? []) === canonical(policy.cors) &&
      canonical(value.lifecycle ?? {}) === canonical(policy.lifecycle),
    'bucket exact CORS/lifecycle',
  );
}
const specs = (c, plan) => [
  ...Object.entries(c.accounts).map(([role, email], index) => ({
    name: `account:${role}`,
    describe: ['iam', 'service-accounts', 'describe', email, '--project', c.project],
    create: plan.creationCommands[index].slice(1),
    validate: (v) =>
      ensure(v.email === email && !v.disabled, `service account ${role} identity/state`),
  })),
  {
    name: 'registry',
    describe: [
      'artifacts',
      'repositories',
      'describe',
      c.repository,
      '--project',
      c.project,
      '--location',
      c.region,
    ],
    create: plan.creationCommands[4].slice(1),
    validate: (v) =>
      ensure(
        v.name?.endsWith(`/locations/${c.region}/repositories/${c.repository}`) &&
          v.format === 'DOCKER' &&
          (!v.mode || v.mode === 'STANDARD_REPOSITORY'),
        'registry location/format',
      ),
  },
  {
    name: 'bucket',
    describe: [
      'storage',
      'buckets',
      'describe',
      `gs://${c.bucket}`,
      '--project',
      c.project,
      '--raw',
    ],
    create: plan.creationCommands[5].slice(1),
    validate: (v) => validateBucket(v, c),
  },
  {
    name: 'sql',
    describe: ['sql', 'instances', 'describe', c.instance, '--project', c.project],
    create: plan.creationCommands[6].slice(1),
    validate: (v) => validateSql(v, c),
  },
];
async function privateReceipt(path, value) {
  if (!isAbsolute(path)) throw new Error('Receipt path must be absolute.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new Error('Receipt parents must not be symlinks.');
  try {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 1_000_000)
      throw new Error('Receipt must be a bounded regular file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}
/** Does not execute unless explicitly selected. Injected driver supports complete fixture qualification. */
export async function bootstrap(options, driver = cloudDriver()) {
  const plan = bootstrapPlan(options),
    c = plan.configuration;
  if (!options.apply) return plan;
  if (!options.receipt || !isAbsolute(options.receipt))
    throw new Error('Apply requires an explicit absolute private receipt path.');
  const run = (args, metadata) => driver.command(args, metadata);
  const project = await run(['projects', 'describe', c.project]);
  ensure(
    project.projectId === c.project && project.lifecycleState === 'ACTIVE',
    'project identity/state',
  );
  const billing = await run(['billing', 'projects', 'describe', c.project]);
  if (!billing.billingEnabled)
    throw new Error('Billing is not enabled; this script never attaches it.');
  const projectPolicy = await run(['projects', 'get-iam-policy', c.project]);
  for (const [role, email] of Object.entries(c.accounts)) {
    const allowed = ['api', 'worker'].includes(role) ? ['roles/cloudsql.client'] : [];
    for (const binding of projectPolicy.bindings ?? [])
      if (binding.members?.includes(`serviceAccount:${email}`) && !allowed.includes(binding.role))
        throw new Error(
          `Existing resource drift: ${role} identity has an unexpected project-wide role; review IAM before apply.`,
        );
  }
  const resources = specs(c, plan),
    inventory = new Map();
  // Validate all existing resources before creating anything.
  for (const resource of resources) {
    const existing = await run(resource.describe, { absent: true });
    if (existing) resource.validate(existing);
    inventory.set(resource.name, existing);
  }
  let receipt = {
    schemaVersion: 1,
    project: c.project,
    region: c.region,
    bucket: c.bucket,
    connection: c.connection,
    resources: {},
    secrets: {},
  };
  try {
    const info = await lstat(options.receipt);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 1_000_000 ||
      info.mode & 0o077 ||
      (await realpath(options.receipt)) !== options.receipt
    )
      throw new Error('Receipt must be a bounded private regular file without symlinks.');
    const previous = JSON.parse(await readFile(options.receipt, 'utf8'));
    ensure(
      previous.project === c.project &&
        previous.bucket === c.bucket &&
        previous.connection === c.connection,
      'receipt target',
    );
    receipt = previous;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const checkpoint = () =>
    options.saveReceipt ? options.saveReceipt(receipt) : privateReceipt(options.receipt, receipt);
  for (const resource of resources) {
    if (!inventory.get(resource.name)) {
      options.onProgress?.(`${resource.name}: creating reviewed resource`);
      await run(resource.create);
      if (resource.name === 'bucket')
        await driver.rest(
          'PATCH',
          `https://storage.googleapis.com/storage/v1/b/${c.bucket}`,
          bucketPolicy(c),
        );
      receipt.resources[resource.name] = 'created';
      await checkpoint();
    }
    let value;
    for (let attempt = 0; attempt < 120; attempt++) {
      value = await run(resource.describe, { absent: true });
      if (!value) {
        await driver.sleep(1000);
        continue;
      }
      if (resource.name !== 'sql' || value.state === 'RUNNABLE') break;
      if (value.state === 'FAILED')
        throw new Error(
          'SQL provisioning failed; retain receipt and inspect the private operation.',
        );
      if (attempt % 6 === 0)
        options.onProgress?.(`${resource.name}: provisioning (${value.state})`);
      await driver.sleep(10_000);
    }
    if (!value)
      throw new Error(
        `Resource ${resource.name} is not readable yet; rerun the same bootstrap after propagation.`,
      );
    if (resource.name === 'sql' && value.state !== 'RUNNABLE')
      throw new Error('SQL is still provisioning; rerun the same bootstrap after it is ready.');
    resource.validate(value);
    receipt.resources[resource.name] ??= 'reused';
    await checkpoint();
    options.onProgress?.(`${resource.name}: ready`);
  }
  const secret = async (name, produce) => {
    const existing = await run(['secrets', 'describe', name, '--project', c.project], {
      absent: true,
    });
    if (existing)
      ensure(
        existing.replication?.userManaged?.replicas?.length === 1 &&
          existing.replication.userManaged.replicas[0].location === c.region,
        `secret ${name} replication`,
      );
    else
      await run([
        'secrets',
        'create',
        name,
        '--project',
        c.project,
        '--replication-policy',
        'user-managed',
        '--locations',
        c.region,
        '--labels',
        'managed-by=opengen-bootstrap',
      ]);
    const versions = await run(['secrets', 'versions', 'list', name, '--project', c.project]);
    const enabled = versions
      .filter((v) => v.state === 'ENABLED')
      .map((v) => v.name.split('/').at(-1));
    let version = receipt.secrets[name]?.version;
    if (version) ensure(enabled.includes(version), `secret ${name} pinned version`);
    else if (enabled.length === 1) version = enabled[0];
    else if (enabled.length > 1 || versions.length)
      throw new Error(
        `Secret ${name} needs an explicit reviewed version receipt; no automatic rotation.`,
      );
    else {
      if (existing && existing.labels?.['managed-by'] !== 'opengen-bootstrap')
        throw new Error(`Existing empty secret ${name} is not owned by this bootstrap.`);
      const bytes = await produce();
      const result = await run(
        ['secrets', 'versions', 'add', name, '--project', c.project, '--data-file=-'],
        { input: bytes },
      );
      version = result.name.split('/').at(-1);
    }
    if (!/^[1-9][0-9]*$/.test(version))
      throw new Error('Secret Manager returned an invalid version.');
    receipt.secrets[name] = { version };
    await checkpoint();
    options.onProgress?.(`${name}: pinned version ${version}`);
    return driver.secretAccess(c.project, name, version);
  };
  const dbUrl = await secret(
    'opengen-database-url',
    () =>
      `postgresql://${c.sqlUser}:${randomBytes(32).toString('hex')}@localhost/${c.database}?host=${encodeURIComponent(`/cloudsql/${c.connection}`)}`,
  );
  const parsedDb = new URL(dbUrl);
  ensure(
    parsedDb.protocol === 'postgresql:' &&
      parsedDb.username === c.sqlUser &&
      parsedDb.hostname === 'localhost' &&
      parsedDb.pathname === `/${c.database}` &&
      parsedDb.searchParams.get('host') === `/cloudsql/${c.connection}` &&
      /^[a-f0-9]{64}$/.test(parsedDb.password),
    'database URL target/credential shape',
  );
  const database = await run(
    ['sql', 'databases', 'describe', c.database, '--instance', c.instance, '--project', c.project],
    { absent: true },
  );
  if (!database)
    await run([
      'sql',
      'databases',
      'create',
      c.database,
      '--instance',
      c.instance,
      '--project',
      c.project,
    ]);
  const users = await run([
    'sql',
    'users',
    'list',
    '--instance',
    c.instance,
    '--project',
    c.project,
  ]);
  if (!users.some((user) => user.name === c.sqlUser)) {
    const operation = driver.createSqlUser
      ? await driver.createSqlUser(c.project, c.instance, c.sqlUser, parsedDb.password)
      : await driver.rest(
          'POST',
          `https://sqladmin.googleapis.com/sql/v1beta4/projects/${c.project}/instances/${c.instance}/users`,
          { name: c.sqlUser, password: parsedDb.password, type: 'BUILT_IN' },
        );
    if (operation.name)
      await run([
        'sql',
        'operations',
        'wait',
        operation.name,
        '--project',
        c.project,
        '--timeout',
        '600',
      ]);
  }
  for (const name of ['opengen-vault-key', 'opengen-installation-token', 'opengen-session-secret'])
    ensure(
      /^[a-f0-9]{64}$/.test(await secret(name, () => randomBytes(32).toString('hex'))),
      `secret ${name} format`,
    );
  let credentials;
  const encodedCredentials = await secret('opengen-storage-bootstrap', async () => {
    const keys = await run([
      'storage',
      'hmac',
      'list',
      '--project',
      c.project,
      '--service-account',
      c.accounts.storage,
      '--long',
    ]);
    if (
      keys.some((key) => key.serviceAccountEmail === c.accounts.storage && key.state !== 'DELETED')
    )
      throw new Error(
        'Storage HMAC exists without its bootstrap secret; reconcile it before creating another key.',
      );
    const key = await run([
      'storage',
      'hmac',
      'create',
      c.accounts.storage,
      '--project',
      c.project,
    ]);
    return JSON.stringify({ accessId: key.metadata.accessId, secret: key.secret });
  });
  try {
    credentials = JSON.parse(encodedCredentials);
  } catch {
    throw new Error(
      'Pinned storage bootstrap credentials are malformed; private payload suppressed.',
    );
  }
  if (
    !/^[A-Za-z0-9_-]{16,128}$/.test(credentials.accessId ?? '') ||
    !/^[A-Za-z0-9/+_-]{20,128}={0,2}$/.test(credentials.secret ?? '')
  )
    throw new Error('Invalid captured storage HMAC; private payload suppressed.');
  const hmacKeys = await run([
    'storage',
    'hmac',
    'list',
    '--project',
    c.project,
    '--service-account',
    c.accounts.storage,
    '--long',
  ]);
  const hmac = hmacKeys.find((key) => key.accessId === credentials.accessId);
  if (!hmac) throw new Error('Pinned storage HMAC was not found; no automatic replacement.');
  ensure(
    hmac.serviceAccountEmail === c.accounts.storage && hmac.state === 'ACTIVE',
    'storage HMAC identity/state',
  );
  for (const [name, expected] of [
    ['opengen-storage-access', credentials.accessId],
    ['opengen-storage-secret', credentials.secret],
    ['opengen-storage-bucket', c.bucket],
    ['opengen-storage-endpoint', 'https://storage.googleapis.com'],
    ['opengen-storage-region', 'auto'],
  ])
    ensure(
      (await secret(name, () => expected)) === expected,
      `secret ${name} disagrees with reviewed storage configuration`,
    );
  // Different secret resources can update independently; serialize the two principals
  // within each secret's policy to avoid etag races. Limit concurrent gcloud processes.
  for (let offset = 0; offset < plan.sharedSecrets.length; offset += 3) {
    await Promise.all(
      plan.sharedSecrets.slice(offset, offset + 3).map(async (name) => {
        for (const role of ['api', 'worker'])
          await run([
            'secrets',
            'add-iam-policy-binding',
            name,
            '--project',
            c.project,
            '--member',
            `serviceAccount:${c.accounts[role]}`,
            '--role',
            'roles/secretmanager.secretAccessor',
          ]);
      }),
    );
  }
  await Promise.all(
    plan.apiOnlySecrets.map((name) =>
      run([
        'secrets',
        'add-iam-policy-binding',
        name,
        '--project',
        c.project,
        '--member',
        `serviceAccount:${c.accounts.api}`,
        '--role',
        'roles/secretmanager.secretAccessor',
      ]),
    ),
  );
  for (const role of ['api', 'worker'])
    await run([
      'projects',
      'add-iam-policy-binding',
      c.project,
      '--member',
      `serviceAccount:${c.accounts[role]}`,
      '--role',
      'roles/cloudsql.client',
      '--condition=None',
    ]);
  await run([
    'storage',
    'buckets',
    'add-iam-policy-binding',
    `gs://${c.bucket}`,
    '--project',
    c.project,
    '--member',
    `serviceAccount:${c.accounts.storage}`,
    '--role',
    'roles/storage.objectAdmin',
    '--condition=None',
  ]);
  receipt.readiness = {
    database: 'provisioned-credentials-preserved-runtime-connectivity-unverified',
    bucket: 'private-HMAC-provisioned-signed-upload-read-unverified',
    identity: 'configured-and-qualified-separately',
    runtime: 'not-managed-by-bootstrap',
    vercel: 'configured-and-qualified-separately',
  };
  await checkpoint();
  return {
    mode: 'applied',
    ...receipt,
    next: 'Run migrations/runtime and signed storage qualification; supply the API-only human OAuth configuration and exact Vercel claims before deployment.',
  };
}
export async function bootstrapCli(args) {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: 'string' },
      region: { type: 'string' },
      bucket: { type: 'string' },
      'public-origin': { type: 'string' },
      receipt: { type: 'string' },
      apply: { type: 'boolean' },
      plan: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    return 'node infra/gcp-bootstrap.mjs --project EXISTING_PROJECT --region us-central1 --bucket UNIQUE_PRIVATE_BUCKET [--public-origin https://opengen.dev] [--apply --receipt /absolute/infra/.local/bootstrap.json]';
  if (values.apply && values.plan) throw new Error('Choose plan or apply.');
  return bootstrap({
    ...values,
    publicOrigin: values['public-origin'],
    onProgress: (event) => console.error(`OpenGen bootstrap: ${event}`),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(json(await bootstrapCli(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
