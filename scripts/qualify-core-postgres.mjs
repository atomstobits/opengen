import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Unpaid, synthetic upgrade/restore qualification. Never targets a configured
// application database; no .env loader, provider configuration, or external HTTP.
// Usage: OPENGEN_CORE_QUALIFICATION=1 TEST_DATABASE_URL=<empty loopback fixture DB>
//   node --import tsx scripts/qualify-core-postgres.mjs
// Optional OPENGEN_CORE_QUALIFICATION_PG_BIN selects a matching pg_dump/pg_restore
// directory explicitly, without modifying the user's PATH or installation.
// The database name must start with opengen_core_qualification_. The supplied
// database is retained for inspection; only our UUID restore database is dropped.
const root = fileURLToPath(new URL('../', import.meta.url));
const filename = fileURLToPath(import.meta.url);
const baseline = 'fa825f054cd795b33316fb9486864539ffd32b5c';
const legacyChecksums = [
  'b9dfad12d57ac008293cbf50545448e79eefd5b1b33fbb221532b9b1f85337e8',
  'ef23085a0103e1323668eebab056b15c6455ca4e4f67bd5468d29bd8e4e6f055',
  'e3fadb90a30a16f878d249d22242ca7f952a300fc21e3e1379f2f5018857fe2c',
  '71336b7c6e81471fb43f986ac5b7d4533d16ff6bb359625e0a13faa50bf173aa',
  'f0e0770d17f3d44608a49c26fdeb45df8583388ae63d0e8886ce259af4074cfa',
  'e37803a0ffa9e7481cd81fa085dbf905f7a584fdf4deac8800274cc99837bff2',
  'bbcc4ee28746b2c67fac6fee668af502df5b7e9964338cb11b67a56fffca420a',
  'a515f9615c2eb8014684c225124899609d3ddc05607e65ed5cded58a4b0dc2b7',
  '59d2b67c8844a5e4444621dd1469e8d7de155b91bdaebfdf7de460d3076f2fc7',
  'ce3f0642439fec766989636f254693f25152e4fca570acecfdba44ca2ff810a6',
  '896ae05b21cc536c05167335592a885b30cab9603ef644a17a4180f6b95861b0',
  '4c07054174c755528443e0778752155f55344564c1a5e4154009bb1a0d424d57',
];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stableJson = (value) =>
  JSON.stringify(value, (_key, current) =>
    current && typeof current === 'object' && !Array.isArray(current)
      ? Object.fromEntries(
          Object.keys(current)
            .sort()
            .map((key) => [key, current[key]]),
        )
      : current,
  );
const identifier = (value) => {
  assert.match(value, /^[a-z][a-z0-9_]*$/, 'Unexpected fixture SQL identifier.');
  return `"${value}"`;
};

function configuration() {
  assert.equal(process.env.OPENGEN_CORE_QUALIFICATION, '1', 'Explicit fixture sentinel required.');
  const raw = process.env.TEST_DATABASE_URL;
  assert.ok(raw, 'TEST_DATABASE_URL is required; no application database default is used.');
  const url = new URL(raw);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required.');
  assert.ok(
    ['127.0.0.1', '[::1]'].includes(url.hostname),
    'Only a literal loopback host is allowed.',
  );
  assert.ok(
    Number(url.port) >= 1024 && Number(url.port) <= 65535,
    'Explicit fixture port required.',
  );
  assert.equal(url.search, '', 'Database URL query options are not accepted.');
  assert.equal(url.hash, '', 'Database URL fragments are not accepted.');
  assert.match(
    url.pathname,
    /^\/opengen_core_qualification_[a-z0-9_]{1,36}$/,
    'Dedicated fixture database name required.',
  );
  assert.ok(url.username, 'Explicit fixture database role required.');
  const pgBin = process.env.OPENGEN_CORE_QUALIFICATION_PG_BIN;
  if (pgBin) assert.ok(isAbsolute(pgBin), 'PostgreSQL tools directory must be absolute.');
  return { raw, url, pgBin };
}

async function main() {
  const config = configuration();
  if (process.argv[2] !== '--fixture-child') {
    assert.equal(process.argv.length, 2, 'No positional arguments are accepted.');
    // Re-exec with an explicit environment. No provider/storage/cloud settings,
    // credential paths, or application .env files reach the engine constructor.
    const child = spawnSync(process.execPath, ['--import', 'tsx', filename, '--fixture-child'], {
      cwd: root,
      env: {
        PATH: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
        TMPDIR: tmpdir(),
        TEST_DATABASE_URL: config.raw,
        OPENGEN_CORE_QUALIFICATION: '1',
        ...(config.pgBin ? { OPENGEN_CORE_QUALIFICATION_PG_BIN: config.pgBin } : {}),
      },
      stdio: 'inherit',
    });
    if (child.error) throw new Error('Unable to launch isolated qualification process.');
    process.exitCode = child.status ?? 1;
    return;
  }

  const { Pool } = await import('pg');
  const { createEngine } = await import('../packages/engine/src/index.ts');
  if (config.pgBin) {
    for (const binary of ['pg_dump', 'pg_restore']) {
      const path = join(config.pgBin, binary);
      assert.ok((await stat(path)).isFile(), `${binary} must be a regular executable file.`);
      await access(path, constants.X_OK);
    }
  }
  const pool = new Pool({ connectionString: config.raw, max: 8 });
  let engine;
  let competingEngine;
  let restoredEngine;
  let restoredPool;
  let restoreCreated = false;
  const restoreName = `opengen_core_qualification_r_${randomUUID().replaceAll('-', '')}`;
  const checks = [];
  const workspaceId = 'qualification-owner';
  const otherWorkspaceId = 'qualification-other';
  const ids = { accepted: randomUUID(), unknown: randomUUID(), held: randomUUID() };
  const input = {
    modelId: 'fixture/upgrade-video',
    operation: 'text-to-video',
    input: { prompt: 'Synthetic private upgrade fixture.', duration: 5, resolution: '720p' },
  };
  const source = { url: 'https://fixture.invalid/docs', checkedAt: '2026-11-04' };
  const deployment = {
    id: 'fixture/loopback-region',
    providerId: 'fixture',
    name: 'Fixture deployment',
    endpointRegion: 'fixture-region',
    scope: 'regional',
    processingRegions: ['fixture-region'],
    storageRegions: null,
    endpointTemplate: null,
    credentialEnv: null,
    source,
  };
  const route = {
    id: 'fixture/loopback-region/upgrade-video',
    modelId: input.modelId,
    deploymentId: deployment.id,
    upstreamModelId: 'fixture-immutable-revision',
    operations: ['text-to-video'],
    resolutions: ['720p'],
    durations: [5],
    fidelity: 'unknown',
    adapter: 'alibaba',
    status: 'documented',
    rates: [{ resolution: '720p', unit: 'output-second', usdMicros: 20 }],
    pricingSource: source,
    source,
  };
  const catalog = {
    providers: [{ id: 'fixture', name: 'Fixture', website: source.url }],
    deployments: [deployment],
    models: [
      {
        id: input.modelId,
        name: 'Upgrade fixture',
        creator: 'Fixture',
        authorProviderIds: [],
        familyId: 'fixture',
        modality: 'video',
        aliases: [],
        openness: 'closed',
        license: 'Synthetic',
        source,
        description: 'Never an executable real provider model.',
      },
    ],
    routes: [route],
  };
  let submits = 0;
  const polled = [];
  const storage = {
    // No S3 client or network. Proves ownership projection and persisted keys,
    // not storage bytes, object ACLs, signed transport, or actual media delivery.
    sign: async (storageKey, mediaType) => ({
      storageKey,
      mediaType,
      fidelity: 'unverified',
      url: `https://private.fixture.invalid/${encodeURIComponent(storageKey)}`,
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  };
  const options = (databaseUrl) => ({
    databaseUrl,
    publicUrl: 'https://gateway.fixture.invalid',
    poolSize: 8,
    vaultKey: '0'.repeat(64),
    catalog,
    storage,
    pollIntervalMs: 0,
    adapters: [
      {
        id: 'alibaba',
        isConfigured: () => true,
        submit: async () => {
          submits++;
          throw new Error('Qualification must never submit.');
        },
        poll: async ({
          upstreamId,
          route: snapshottedRoute,
          deployment: snapshottedDeployment,
        }) => {
          assert.deepEqual(snapshottedRoute, route);
          assert.deepEqual(snapshottedDeployment, deployment);
          polled.push(upstreamId);
          if (upstreamId === 'fixture-accepted-original')
            return {
              status: 'failed',
              failureCategory: 'technical',
              billedCostMicros: 40,
              error: 'Synthetic terminal recovery result.',
            };
          assert.equal(upstreamId, 'fixture-held-original', 'Unknown acceptance cannot be polled.');
          return { status: 'succeeded', billedCostMicros: 60 };
        },
      },
    ],
  });

  async function shape(db) {
    const { rows } = await db.query(`SELECT table_name,column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name LIKE 'mr_%' ORDER BY table_name,ordinal_position`);
    const tables = new Map();
    for (const { table_name: table, column_name: column } of rows)
      tables.set(table, [...(tables.get(table) ?? []), column]);
    return tables;
  }
  async function snapshot(db, tables, legacy = false) {
    const value = {};
    for (const [table, columns] of tables) {
      const filter = legacy && table === 'mr_migrations' ? " WHERE name<='012.sql'" : '';
      const { rows } =
        await db.query(`SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY to_jsonb(s)::text),'[]'::jsonb) AS data
        FROM (SELECT ${columns.map(identifier).join(',')} FROM ${identifier(table)}${filter}) s`);
      value[table] = rows[0].data;
    }
    return value;
  }
  async function validateMigrations(db) {
    const { rows } = await db.query('SELECT name,checksum FROM mr_migrations ORDER BY name');
    const files = (await readdir(new URL('../packages/engine/migrations/', import.meta.url)))
      .filter((name) => /^\d{3}\.sql$/.test(name))
      .sort();
    assert.deepEqual(
      rows.map((row) => row.name),
      files,
      'Every numbered migration must be registered.',
    );
    for (let i = 0; i < rows.length; i++) {
      assert.equal(
        rows[i].name,
        `${String(i + 1).padStart(3, '0')}.sql`,
        'Migrations must be contiguous.',
      );
      const sql = await readFile(
        new URL(`../packages/engine/migrations/${rows[i].name}`, import.meta.url),
      );
      assert.equal(rows[i].checksum, sha256(sql), 'Applied migration checksum must match source.');
      if (i < legacyChecksums.length) assert.equal(rows[i].checksum, legacyChecksums[i]);
    }
    return rows.map((row) => row.name);
  }
  function pgTool(binary, database, args, inputBytes) {
    try {
      return execFileSync(config.pgBin ? join(config.pgBin, binary) : binary, args, {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        input: inputBytes,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/local/bin:/usr/bin:/bin',
          PGHOST: config.url.hostname.replace(/^\[|\]$/g, ''),
          PGPORT: config.url.port,
          PGUSER: decodeURIComponent(config.url.username),
          PGPASSWORD: decodeURIComponent(config.url.password),
          PGDATABASE: database,
          PGCONNECT_TIMEOUT: '5',
        },
      });
    } catch {
      // Do not echo a connection string, database contents, or tool stderr.
      throw new Error(`${binary} failed for the disposable qualification database.`);
    }
  }

  try {
    const version = (await pool.query('SELECT version() AS version')).rows[0].version;
    assert.match(version, /^PostgreSQL /);
    assert.doesNotMatch(version, /pglite|emscripten/i, 'Native PostgreSQL is required.');
    const existing = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    assert.equal(
      existing.rowCount,
      0,
      'Fixture database must be empty; existing data is never reset.',
    );
    await pool.query(
      'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (let i = 0; i < legacyChecksums.length; i++) {
      const name = `${String(i + 1).padStart(3, '0')}.sql`;
      const sql = await readFile(
        new URL(`../packages/engine/migrations/${name}`, import.meta.url),
        'utf8',
      );
      assert.equal(sha256(sql), legacyChecksums[i], `Historical migration ${name} changed.`);
      await pool.query(sql);
      await pool.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [
        name,
        legacyChecksums[i],
      ]);
    }
    await pool.query(
      'INSERT INTO mr_workspaces(id,available_micros,reserved_micros) VALUES($1,700,300),($2,0,0)',
      [workspaceId, otherWorkspaceId],
    );
    await pool.query(
      "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,'opening',1000,1000,0)",
      [randomUUID(), workspaceId],
    );
    const outputs = [
      {
        storageKey: `outputs/${ids.held}/${randomUUID()}.mp4`,
        url: 'https://private.fixture.invalid/owned-output',
        mediaType: 'video/mp4',
        fidelity: 'unverified',
      },
    ];
    for (const [kind, id] of Object.entries(ids)) {
      const status = { accepted: 'running', unknown: 'submission-unknown', held: 'succeeded' }[
        kind
      ];
      const upstreamId =
        kind === 'unknown' ? null : `fixture-${kind === 'accepted' ? 'accepted' : 'held'}-original`;
      await pool.query(
        `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,
        reserved_micros,attempt_count,outputs,billing_poll_pending,completed_at,delivery_status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,100,1,$10,$11,CASE WHEN $11 THEN now() ELSE NULL END,$12)`,
        [
          id,
          workspaceId,
          `fixture-${kind}`,
          sha256(stableJson(input)),
          JSON.stringify(input),
          JSON.stringify(route),
          JSON.stringify(deployment),
          status,
          upstreamId,
          JSON.stringify(kind === 'held' ? outputs : []),
          kind === 'held',
          kind === 'held' ? 'available' : null,
        ],
      );
      await pool.query(
        'INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,$3,$4,$5)',
        [randomUUID(), id, route.id, deployment.id, status],
      );
      await pool.query(
        "INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,$3,'reserve',100,-100,100)",
        [randomUUID(), workspaceId, id],
      );
    }
    const keyId = randomUUID();
    await pool.query(
      'INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes) VALUES($1,$2,\'Synthetic API key\',$3,\'["read","generate"]\')',
      [keyId, workspaceId, sha256('non-credential-fixture-key')],
    );
    await pool.query(
      "INSERT INTO mr_mcp_oauth_clients(id,name,redirect_uris) VALUES('fixture-client','Synthetic client','[\"http://127.0.0.1/callback\"]')",
    );
    await pool.query(
      "INSERT INTO mr_mcp_oauth_grants(id,client_id,workspace_id,resource,source_key_id,scopes,expires_at) VALUES($1,'fixture-client',$2,'https://gateway.fixture.invalid/mcp',$3,'[\"read\"]',now()+interval '1 day')",
      [randomUUID(), workspaceId, keyId],
    );
    const eventId = randomUUID();
    const subscriptionId = randomUUID();
    await pool.query(
      "INSERT INTO mr_events(id,workspace_id,type,dedupe_key,data) VALUES($1,$2,'generation.completed','fixture-owned-output',$3)",
      [eventId, workspaceId, JSON.stringify({ jobId: ids.held, status: 'succeeded' })],
    );
    await pool.query(
      "INSERT INTO mr_webhook_subscriptions(id,workspace_id,name,url,event_types,secret_ciphertext) VALUES($1,$2,'Synthetic subscription','https://webhook.fixture.invalid','[\"generation.completed\"]','not-a-real-ciphertext')",
      [subscriptionId, workspaceId],
    );
    await pool.query(
      'INSERT INTO mr_webhook_deliveries(id,event_id,subscription_id) VALUES($1,$2,$3)',
      [randomUUID(), eventId, subscriptionId],
    );
    const orderId = randomUUID();
    await pool.query(
      "INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,stripe_idempotency_key,integration_identifier) VALUES($1,$2,'fixture-held-order',500,5000000,false,'review','fixture-stripe-idempotency','synthetic-qualification')",
      [orderId, workspaceId],
    );
    await pool.query(
      "INSERT INTO mr_payment_events(id,type,object_id,livemode,order_id,state) VALUES('fixture-risk-event','charge.dispute.created','fixture-object',false,$1,'processed')",
      [orderId],
    );
    await pool.query(
      "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES('fixture-risk-event',$1,$2,'Synthetic active billing hold')",
      [workspaceId, orderId],
    );
    const oldShape = await shape(pool);
    const before = await snapshot(pool, oldShape, true);
    checks.push('populated-001-through-012-with-immutable-checksums');

    engine = createEngine(options(config.raw));
    competingEngine = createEngine(options(config.raw));
    // Prove independent API/worker startups really wait on the same native
    // schema lock. Promise.all alone can pass without any overlapping DDL.
    const schemaLock = await pool.connect();
    let initializers = [];
    try {
      await schemaLock.query('BEGIN');
      await schemaLock.query("SELECT pg_advisory_xact_lock(hashtext('media-router-schema'))");
      const blockerPid = (await schemaLock.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      initializers = [engine.initialize(), competingEngine.initialize()];
      for (const initializing of initializers) void initializing.catch(() => {});
      let waiting = 0;
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        waiting = (
          await pool.query(
            `SELECT count(*)::int AS n FROM pg_locks waiting
            JOIN pg_locks held USING(locktype,database,classid,objid,objsubid)
            WHERE waiting.locktype='advisory' AND NOT waiting.granted
            AND held.granted AND held.pid=$1`,
            [blockerPid],
          )
        ).rows[0].n;
        if (waiting >= 2) break;
        await pool.query('SELECT pg_sleep(0.01)');
      }
      assert.equal(waiting, 2, 'Both native initializers must contend on the schema lock.');
      assert.deepEqual(
        await snapshot(pool, oldShape, true),
        before,
        'Waiting initializers cannot change legacy data before acquiring the lock.',
      );
      await schemaLock.query('COMMIT');
      await Promise.all(initializers);
    } finally {
      await schemaLock.query('ROLLBACK');
      schemaLock.release();
      await Promise.allSettled(initializers);
    }
    await competingEngine.close();
    competingEngine = undefined;
    checks.push('native-concurrent-initializers-serialize-before-forward-migrations');
    await engine.initialize();
    const migrations = await validateMigrations(pool);
    assert.deepEqual(
      await snapshot(pool, oldShape, true),
      before,
      'Upgrade must preserve all legacy columns and rows.',
    );
    checks.push('current-initializer-twice-preserves-legacy-data');
    const legacyUnknowns = await pool.query(`SELECT attribution,effective_policy,
      execution_progress,execution_error,execution_timings,queue_start_deadline_at,output_evidence
      FROM mr_jobs ORDER BY id`);
    assert.equal(legacyUnknowns.rows.length, Object.keys(ids).length);
    for (const row of legacyUnknowns.rows)
      assert.ok(
        Object.values(row).every((value) => value === null),
        'Forward migrations cannot invent attribution, policy or execution/output evidence.',
      );
    for (const table of [
      'mr_key_months',
      'mr_key_reservations',
      'mr_dispatch_slots',
      'mr_job_credentials',
      'mr_attempt_credentials',
      'mr_output_receipts',
    ])
      assert.equal(
        (await pool.query(`SELECT count(*)::int AS n FROM ${identifier(table)}`)).rows[0].n,
        0,
        'Legacy accounting, capacity and credential identity must remain unknown.',
      );
    checks.push('legacy-attribution-money-capacity-and-credential-unknowns-stay-explicit');
    for (const [kind, id] of Object.entries(ids)) {
      const replay = await engine.submit({ workspaceId, idempotencyKey: `fixture-${kind}`, input });
      assert.equal(replay.id, id, 'Old request idempotency must survive upgrade.');
      if (kind === 'held') {
        assert.equal(replay.outputs.length, 1);
        assert.equal(
          replay.outputs[0].storageKey,
          undefined,
          'Customer replays cannot expose storage keys.',
        );
        assert.equal(
          replay.outputs[0].url,
          (await storage.sign(outputs[0].storageKey, 'video/mp4')).url,
        );
        assert.notEqual(
          replay.outputs[0].url,
          outputs[0].url,
          'Customer output must use a fresh owned capability.',
        );
      }
      assert.equal(
        await engine.getJob(otherWorkspaceId, id),
        null,
        'Cross-workspace job access must fail.',
      );
    }
    await assert.rejects(
      engine.submit({
        workspaceId,
        idempotencyKey: 'fixture-accepted',
        input: { ...input, input: { ...input.input, prompt: 'Changed fixture.' } },
      }),
      (error) => error.code === 'idempotency_conflict',
    );
    checks.push('old-idempotency-and-private-workspace-projection');
    await engine.close();
    engine = undefined;
    engine = createEngine(options(config.raw));
    await engine.initialize();
    for (let i = 0; i < 5 && (await engine.workOnce()); i++) {
      /* Resume existing work only. */
    }
    assert.equal(submits, 0, 'Restart must never resubmit accepted or unresolved work.');
    assert.deepEqual(polled.sort(), ['fixture-accepted-original', 'fixture-held-original']);
    assert.equal((await engine.getJob(workspaceId, ids.unknown)).status, 'submission-unknown');
    const held = await engine.getJob(workspaceId, ids.held);
    assert.equal(held.outputs.length, 1);
    assert.equal(
      held.outputs[0].storageKey,
      undefined,
      'Internal keys remain private after restart.',
    );
    assert.equal(held.outputs[0].url, (await storage.sign(outputs[0].storageKey, 'video/mp4')).url);
    assert.equal(held.outputs[0].expiresAt, '2099-01-01T00:00:00.000Z');
    const storedHeld = (await pool.query('SELECT outputs FROM mr_jobs WHERE id=$1', [ids.held]))
      .rows[0];
    assert.equal(
      storedHeld.outputs[0].storageKey,
      outputs[0].storageKey,
      'Owned keys survive in the private database.',
    );
    assert.deepEqual(await engine.getBalance(workspaceId), {
      availableMicros: 800,
      reservedMicros: 100,
      currency: 'USD',
    });
    const beforeReplay = await snapshot(pool, await shape(pool));
    await Promise.all(
      Array.from({ length: 8 }, () =>
        engine.applyProviderResult(workspaceId, ids.accepted, {
          status: 'failed',
          failureCategory: 'technical',
          billedCostMicros: 40,
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: 8 }, () =>
        engine.applyProviderResult(workspaceId, ids.held, {
          status: 'succeeded',
          billedCostMicros: 60,
        }),
      ),
    );
    assert.deepEqual(
      await snapshot(pool, await shape(pool)),
      beforeReplay,
      'Duplicate terminal delivery cannot double settle or enqueue.',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM mr_billing_holds WHERE resolved_at IS NULL',
        )
      ).rows[0].n,
      1,
    );
    checks.push('restart-original-task-only-and-exactly-once-held-settlement');

    const backupShape = await shape(pool);
    const backupSnapshot = await snapshot(pool, backupShape);
    const backup = pgTool('pg_dump', config.url.pathname.slice(1), [
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ]);
    try {
      await pool.query(`CREATE DATABASE ${identifier(restoreName)}`);
      restoreCreated = true;
      pgTool(
        'pg_restore',
        restoreName,
        ['--dbname', restoreName, '--no-owner', '--no-acl', '--exit-on-error'],
        backup,
      );
    } finally {
      backup.fill(0);
    }
    const restoredUrl = new URL(config.raw);
    restoredUrl.pathname = `/${restoreName}`;
    restoredPool = new Pool({ connectionString: restoredUrl.href, max: 8 });
    assert.deepEqual(
      await snapshot(restoredPool, backupShape),
      backupSnapshot,
      'Backup/restore must preserve every core row and column.',
    );
    restoredEngine = createEngine(options(restoredUrl.href));
    await restoredEngine.initialize();
    await validateMigrations(restoredPool);
    assert.equal(
      await restoredEngine.workOnce(),
      false,
      'Restore must not dispatch unresolved or already settled work.',
    );
    assert.equal(submits, 0);
    assert.deepEqual(await restoredEngine.getBalance(workspaceId), {
      availableMicros: 800,
      reservedMicros: 100,
      currency: 'USD',
    });
    assert.equal(await restoredEngine.getJob(otherWorkspaceId, ids.held), null);
    const restoredHeld = await restoredEngine.getJob(workspaceId, ids.held);
    assert.equal(restoredHeld.outputs[0].storageKey, undefined);
    assert.equal(restoredHeld.outputs[0].url, held.outputs[0].url);
    assert.deepEqual(await snapshot(restoredPool, backupShape), backupSnapshot);
    checks.push('native-dump-restore-all-rows-and-restart-without-dispatch');
    let candidate = 'archive-without-git';
    try {
      candidate = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* Archive verification is supported. */
    }
    console.log(
      JSON.stringify(
        {
          result: 'passed',
          baseline,
          candidate,
          postgres: version.split('\n')[0],
          migrations,
          checks,
          providerSubmissions: submits,
          fixturePolls: polled.length,
          retainedFixtureDatabase: config.url.pathname.slice(1),
          limits: [
            'Synthetic provider/storage only; no live delivery or object ACL proof.',
            'Does not replace native admission/cap/capacity races, browser checks or hosted client qualification.',
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    if (competingEngine) await competingEngine.close();
    if (engine) await engine.close();
    if (restoredEngine) await restoredEngine.close();
    if (restoredPool) await restoredPool.end();
    if (restoreCreated) await pool.query(`DROP DATABASE ${identifier(restoreName)}`);
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `Core PostgreSQL qualification failed: ${error instanceof assert.AssertionError ? error.message : (error?.message ?? 'unknown failure')}`,
  );
  process.exitCode = 1;
}
