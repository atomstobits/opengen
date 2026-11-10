/** Populated 001–029 -> 030 LOCAL source qualification. No hosted database,
 * processor credentials, financial command, provider request or activation. */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEngine, creditWorkspaceInTransaction } from '@media-router/engine';
import {
  StaffRefundStore,
  staffRefundHash,
  type StaffRefundStoreOptions,
  type StaffRefundWorksheet,
} from '../packages/engine/src/staff-refunds.js';
import { normalizeStaffRefundEvidence } from '../packages/engine/src/staff-refund-evidence.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import { staffRefundTestDatabaseUrl } from './staff-refund-fixture.js';

const databaseUrl = process.env.TEST_DATABASE_URL
  ? staffRefundTestDatabaseUrl(process.env.TEST_DATABASE_URL)
  : undefined;
const native = !!databaseUrl && process.env.TEST_NATIVE_POSTGRES === '1';
const pgBin = process.env.OPENGEN_CORE_QUALIFICATION_PG_BIN;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const sql = (number: number) =>
  readFile(
    new URL(
      `../packages/engine/migrations/${String(number).padStart(3, '0')}.sql`,
      import.meta.url,
    ),
    'utf8',
  );
const identifier = (value: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unexpected LOCAL fixture identifier.');
  return `"${value}"`;
};
const noNetwork = vi.fn(async () => {
  throw new Error('LOCAL upgrade qualification forbids external requests.');
});
beforeEach(() => {
  vi.stubGlobal('fetch', noNetwork);
});
afterEach(() => {
  expect(noNetwork).not.toHaveBeenCalled();
  noNetwork.mockClear();
  vi.unstubAllGlobals();
});

function pgTool(name: 'pg_dump' | 'pg_restore', args: string[], input?: Buffer): Buffer {
  const url = new URL(staffRefundTestDatabaseUrl(databaseUrl));
  if (!native || !pgBin) throw new Error('Explicit native LOCAL fixture tools are required.');
  const result = spawnSync(join(pgBin, name), args, {
    input,
    env: {
      PATH: process.env.PATH,
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGCONNECT_TIMEOUT: '5',
    },
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error('Native LOCAL staff refund fixture dump/restore failed.');
  return result.stdout;
}

async function qualifyPopulatedUpgrade(restore: boolean) {
  const isolated = await isolatedEngineDatabase(
    staffRefundTestDatabaseUrl(databaseUrl),
    'refund_live_upgrade',
  );
  const engine = isolated.bind(
    createEngine({
      databaseUrl: isolated.databaseUrl,
      poolSize: 1,
      statusPoolSize: 1,
      providerExecutionEnabled: false,
      adapters: [],
      providerEnv: {},
    }),
  );
  const db = engine.pool;
  let backup: Buffer | undefined;
  try {
    // Manually construct the exact old migration journal. initialize() must
    // apply only 030 to this already populated old state.
    await db.query(
      'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const oldFiles: Array<{ name: string; checksum: string }> = [];
    for (let number = 1; number <= 29; number++) {
      const name = `${String(number).padStart(3, '0')}.sql`;
      const source = await sql(number),
        checksum = sha256(source);
      oldFiles.push({ name, checksum });
      await db.query(source);
      await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
    }
    const workspace = `local-refund-upgrade-${randomUUID()}`;
    await engine.ensureWorkspace(workspace, 0);
    const environment = {
      id: `local-upgrade-false-${randomUUID()}`,
      accountId: `acct_local${randomUUID().replaceAll('-', '')}`,
      livemode: false,
    };
    await registerBillingProcessorEnvironmentInTransaction(db, environment);
    const memberId = randomUUID();
    await db.query(
      `INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at)
       VALUES($1,$2,'https://local-identity.invalid','local-upgrade-human','admin',clock_timestamp())`,
      [memberId, workspace],
    );
    const epoch = (
      await db.query(
        'SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1',
        [memberId],
      )
    ).rows[0].epoch;
    await db.query(
      `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,processor_environment_id,livemode,rails,consent_reference,approval_reference)
       VALUES($1,$2,$3,1,$4,false,
       '{"allowsEnabled":false,"maxThresholdMicros":100000000,"maxAmountCents":10000,"maxMonthlyCapCents":100000,"maxAttemptsPerMonth":100,"minCooldownSeconds":60,"maxFailureLimit":10}',
       'local-old-owner-consent','local-old-staff-approval')`,
      [workspace, memberId, epoch, environment.id],
    );
    await engine.accounts.createKey(workspace, {
      name: 'LOCAL old authority preserved',
      scopes: ['read', 'generate'],
    });
    await db.query(
      `INSERT INTO mr_terms_receipts(issuer,subject,policy_version,policy_digest)
       VALUES('https://local-identity.invalid','local-upgrade-human','local-source-terms-v1',$1)`,
      [sha256('synthetic LOCAL human assent; not hosted or published terms')],
    );
    const orderId = randomUUID(),
      paymentIntentId = 'pi_local_old_paid';
    await db.query(
      `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id,credited_at,processor_environment_id,processor_account_id)
       VALUES($1,$2,'local-old-original-order',500,5000000,false,'credited','local-old-checkout-key','local-upgrade-source','cs_test_local_upgrade',$3,clock_timestamp(),$4,$5)`,
      [orderId, workspace, paymentIntentId, environment.id, environment.accountId],
    );
    await db.query(
      `INSERT INTO mr_billing_payment_ownership(processor_environment_id,livemode,payment_intent_id,workspace_id,kind,local_id,manual_order_id,amount_cents,credit_reference)
       VALUES($1,false,$2,$3,'manual',$4,$4,500,$5)`,
      [environment.id, paymentIntentId, workspace, orderId, `stripe-topup:${orderId}`],
    );
    const fundingClient = await db.connect();
    try {
      await fundingClient.query('BEGIN');
      await creditWorkspaceInTransaction(
        fundingClient,
        workspace,
        5_000_000,
        `stripe-topup:${orderId}`,
      );
      await fundingClient.query('COMMIT');
    } finally {
      fundingClient.release();
    }

    const context = Object.freeze({ staff: 'local-old-installed-staff' });
    const authorized = { id: context.staff, kind: 'installation-operator' as const };
    const approvedPackets = new Set<string>();
    const authorize: StaffRefundStoreOptions['authorize'] = async (_client, supplied) => {
      if (supplied !== context) throw new Error('LOCAL current staff authority required.');
      return authorized;
    };
    const approveAllocation: NonNullable<StaffRefundStoreOptions['approveAllocation']> = async (
      _client,
      supplied,
      request,
    ) => {
      expect(supplied).toBe(context);
      expect(request).toMatchObject({
        workspaceId: workspace,
        orderId,
        paymentIntentId,
        processorEnvironmentId: environment.id,
        processorAccountId: environment.accountId,
        livemode: false,
        creditReference: `stripe-topup:${orderId}`,
        originalAmountCents: 500,
      });
      expect(
        approvedPackets.has(
          `${request.operation}/${request.worksheetHash}/${staffRefundHash(request.reaffirmation)}`,
        ),
      ).toBe(true);
      const { requestHash, ...body } = request;
      expect(requestHash).toBe(staffRefundHash(body));
      return { approvalReference: `local-old-approved-${request.operation}`, requestHash };
    };
    const store = new StaffRefundStore(db, {
      activation: 'fixture',
      processorEnvironment: environment,
      authorize,
      approveAllocation,
    });
    function evidence(refundId: string, amount: number, at: number, failed = false) {
      const result = normalizeStaffRefundEvidence(
        {
          id: `evt_local_old_${randomUUID().replaceAll('-', '')}`,
          type: 'refund.updated',
          created: at,
          livemode: false,
          processorEnvironment: environment,
          data: {
            object: {
              id: refundId,
              object: 'refund',
              payment_intent: paymentIntentId,
              charge: 'ch_local_old_original',
              amount,
              currency: 'usd',
              status: failed ? 'failed' : 'succeeded',
              ...(failed ? { failure_balance_transaction: 'txn_local_old_balance_returned' } : {}),
            },
          },
        },
        environment,
        {
          workspaceId: workspace,
          orderId,
          processorEnvironmentId: environment.id,
          processorAccountId: environment.accountId,
          livemode: false,
          paymentIntentId,
          chargeId: null,
          amountCents: 500,
          currency: 'USD',
        },
      );
      if (result.kind !== 'refund') throw new Error('Synthetic old refund evidence rejected.');
      return result.evidence;
    }
    async function packet(
      operation: string,
      amount: number,
      reaffirm?: ReturnType<typeof evidence>,
    ) {
      const worksheet: StaffRefundWorksheet = {
        snapshot: await store.snapshot(workspace, context),
        externalReturns: [],
        allocationReference: 'local-old-independent-allocation',
        originalPayerReference: 'local-old-original-payer',
        note: 'LOCAL old chronological paid allocation retained byte for byte.',
        allocation: [
          {
            fundingReference: `stripe-topup:${orderId}`,
            disposition: 'eligible-paid',
            amountMicros: amount,
          },
        ],
      };
      const worksheetHash = staffRefundHash(worksheet);
      const identity = reaffirm
        ? {
            eventId: reaffirm.eventId,
            payloadFingerprint: reaffirm.payloadFingerprint,
            eventCreated: reaffirm.eventCreated,
          }
        : null;
      approvedPackets.add(`${operation}/${worksheetHash}/${staffRefundHash(identity)}`);
      return { worksheet, worksheetHash };
    }
    const action = () => ({
      reference: randomUUID(),
      note: 'LOCAL old independently reviewed financial phase.',
      evidenceReference: 'local-old-evidence',
    });
    const at = Math.floor(Date.now() / 1000);
    // Debit + expense, retaining unresolved staff holds.
    const debitProof = evidence('re_local_old_debited', 100, at);
    const debited = await store.prepare(
      {
        workspaceId: workspace,
        orderId,
        reference: 'local-old-debited',
        origin: 'reconcile-existing',
        eligibleMicros: 999_999,
        existingRefundEvidence: debitProof,
        ...(await packet('prepare', 999_999)),
      },
      context,
    );
    await store.reconcile(
      debited.id,
      { action: 'apply-success', ...action(), ...(await packet('apply-success', 999_999)) },
      context,
    );
    // Dispatched, definitively failed, released without a wallet debit. Resolve
    // exactly this case's holds while leaving the first case protected.
    const released = await store.prepare(
      {
        workspaceId: workspace,
        orderId,
        reference: 'local-old-released',
        origin: 'new',
        eligibleMicros: 2_000_000,
        ...(await packet('prepare', 2_000_000)),
      },
      context,
    );
    await store.dispatch(
      released.id,
      { ...action(), ...(await packet('dispatch', 2_000_000)) },
      context,
    );
    const releaseProof = evidence('re_local_old_released', 200, at + 10, true);
    const releaseObserved = await store.observeVerifiedProcessorEvidence(
      released.id,
      releaseProof,
      action(),
      context,
    );
    await store.reconcile(
      released.id,
      {
        action: 'release-failed',
        ...action(),
        ...(await packet('release-failed', 2_000_000)),
        resolveHoldIds: releaseObserved.holdIds,
        holdResolutionEvidenceUrl: 'https://fixture.invalid/local-old-released',
      },
      context,
    );
    // Debit + restoration + expense offset, all with old false receipts.
    const originalProof = evidence('re_local_old_restored', 100, at + 20);
    const restored = await store.prepare(
      {
        workspaceId: workspace,
        orderId,
        reference: 'local-old-restored',
        origin: 'reconcile-existing',
        eligibleMicros: 999_999,
        existingRefundEvidence: originalProof,
        ...(await packet('prepare', 999_999)),
      },
      context,
    );
    await store.reconcile(
      restored.id,
      { action: 'apply-success', ...action(), ...(await packet('apply-success', 999_999)) },
      context,
    );
    await store.observeVerifiedProcessorEvidence(
      restored.id,
      evidence(originalProof.refundId, 100, at + 30, true),
      action(),
      context,
    );
    const reaffirm = evidence(originalProof.refundId, 100, at + 40, true);
    const restoredCase = await store.reconcile(
      restored.id,
      {
        action: 'restore-failed',
        ...action(),
        ...(await packet('restore-failed', 999_999, reaffirm)),
        reaffirmLatestEvidence: reaffirm,
      },
      context,
    );
    expect(restoredCase.financialState).toBe('restored');

    for (const [status, upstream] of [
      ['running', 'local-old-original-provider-task'],
      ['submission-unknown', null],
    ] as const) {
      const job = randomUUID();
      await db.query(
        `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,reserved_micros,attempt_count)
         VALUES($1,$2,$3,'local-old-frozen-hash','{}','{}','{}',$4,$5,1000000,1)`,
        [job, workspace, randomUUID(), status, upstream],
      );
      await db.query(
        "INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state) VALUES($1,$2,1,'local-old-route','local-old-deployment',$3)",
        [randomUUID(), job, status],
      );
      await db.query(
        'UPDATE mr_workspaces SET available_micros=available_micros-1000000,reserved_micros=reserved_micros+1000000 WHERE id=$1',
        [workspace],
      );
      await db.query(
        "INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,$3,'reserve',1000000,-1000000,1000000)",
        [randomUUID(), workspace, job],
      );
    }
    for (const suffix of ['unresolved', 'resolved']) {
      const eventId = `evt_local_old_${suffix}`;
      await db.query(
        `INSERT INTO mr_payment_events(id,type,object_id,payment_intent_id,livemode,order_id,state,processor_environment_id)
         VALUES($1,'refund.updated','re_local_old_history',$2,false,$3,'processed',$4)`,
        [eventId, paymentIntentId, orderId, environment.id],
      );
      await db.query(
        "INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason) VALUES($1,$2,$3,'refund.updated')",
        [eventId, workspace, orderId],
      );
      if (suffix === 'resolved') {
        await db.query(
          `INSERT INTO mr_billing_hold_resolutions(id,event_id,workspace_id,reference,note,evidence_url,actor)
           VALUES($1,$2,$3,'local-old-reviewed-stripe','LOCAL old individual processor review.','https://fixture.invalid/local-old-reviewed',$4)`,
          [randomUUID(), eventId, workspace, JSON.stringify(authorized)],
        );
        await db.query(
          "UPDATE mr_billing_holds SET resolved_at=clock_timestamp(),resolution_reference='local-old-reviewed-stripe' WHERE event_id=$1",
          [eventId],
        );
      }
    }

    expect((await db.query('SELECT DISTINCT livemode FROM mr_staff_refund_cases')).rows).toEqual([
      { livemode: false },
    ]);
    expect(
      (await db.query('SELECT financial_state FROM mr_staff_refund_cases ORDER BY reference')).rows,
    ).toEqual([
      { financial_state: 'debited' },
      { financial_state: 'released' },
      { financial_state: 'restored' },
    ]);
    expect(
      (await db.query('SELECT count(*)::text AS count FROM mr_staff_refund_financial_entries'))
        .rows[0].count,
    ).toBe('3');
    expect(
      (await db.query('SELECT count(*)::text AS count FROM mr_staff_refund_expenses')).rows[0]
        .count,
    ).toBe('3');
    const oldTables = (
      await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'mr_%' ORDER BY table_name`,
        [isolated.schema],
      )
    ).rows.map((row) => row.table_name);
    async function snapshot(includeJournal = false) {
      const rows: Record<string, unknown> = {};
      for (const table of oldTables) {
        if (!includeJournal && table === 'mr_migrations') continue;
        const value =
          table === 'mr_ledger' ? "(to_jsonb(t)-'posting_order')::text" : 'row_to_json(t)::text';
        rows[table] = (
          await db.query(
            `SELECT ${value} AS value FROM ${identifier(isolated.schema)}.${identifier(table)} t ORDER BY ${value} COLLATE "C"`,
          )
        ).rows;
      }
      return rows;
    }
    const before = await snapshot();
    const oldJournal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
    const oldBalance = await engine.getBalance(workspace);
    const oldConstraints = (
      await db.query<{ conname: string; definition: string }>(
        `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=$1::regnamespace ORDER BY conname,definition`,
        [isolated.schema],
      )
    ).rows;
    await engine.initialize();
    expect(await snapshot()).toEqual(before);
    const journal = (await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows;
    expect(journal.slice(0, 29)).toEqual(oldJournal);
    expect(journal.map((row) => row.name)).toEqual(
      Array.from({ length: 31 }, (_, i) => `${String(i + 1).padStart(3, '0')}.sql`),
    );
    expect(journal[29].checksum).toBe(sha256(await sql(30)));
    for (let i = 0; i < 29; i++) {
      expect({ name: journal[i].name, checksum: journal[i].checksum }).toEqual(oldFiles[i]);
      expect(sha256(await sql(i + 1))).toBe(oldFiles[i].checksum);
    }
    const constraints = (
      await db.query<{ conname: string; definition: string }>(
        `SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace=$1::regnamespace ORDER BY conname,definition`,
        [isolated.schema],
      )
    ).rows;
    const retainedConstraints = oldConstraints.filter(
      (row) =>
        !['mr_staff_refund_cases_livemode_check', 'mr_ledger_kind_check'].includes(row.conname),
    );
    const retainedNames = new Set(retainedConstraints.map((row) => row.conname));
    expect(constraints.filter((row) => retainedNames.has(row.conname))).toEqual(
      retainedConstraints,
    );
    const ledgerKinds = constraints.find(
      (row) => row.conname === 'mr_ledger_kind_check',
    )!.definition;
    for (const kind of [
      'opening',
      'reserve',
      'release',
      'settle',
      'credit',
      'refund',
      'refund-restore',
      'relief-offset',
    ])
      expect(ledgerKinds).toContain(`'${kind}'`);
    await engine.initialize();
    expect(await snapshot()).toEqual(before);
    expect((await db.query('SELECT * FROM mr_migrations ORDER BY name')).rows).toEqual(journal);
    expect(await engine.getBalance(workspace)).toEqual(oldBalance);

    if (restore) {
      const upgraded = await snapshot(true);
      backup = pgTool('pg_dump', [
        '--format=custom',
        `--schema=${isolated.schema}`,
        '--no-owner',
        '--no-acl',
        '--no-password',
      ]);
      // Only this generated, guarded fixture schema is replaced.
      await db.query(`DROP SCHEMA ${identifier(isolated.schema)} CASCADE`);
      pgTool(
        'pg_restore',
        [
          '--dbname',
          new URL(databaseUrl!).pathname.slice(1),
          '--no-owner',
          '--no-acl',
          '--no-password',
          '--exit-on-error',
        ],
        backup,
      );
      expect(await snapshot(true)).toEqual(upgraded);
      await engine.initialize();
      expect(await snapshot(true)).toEqual(upgraded);
      expect(await engine.getBalance(workspace)).toEqual(oldBalance);
      await expect(
        db.query("UPDATE mr_terms_receipts SET action='continue'"),
      ).rejects.toMatchObject({ code: '55000', message: 'terms_receipt_immutable' });
      await expect(db.query('DELETE FROM mr_staff_refund_financial_entries')).rejects.toMatchObject(
        { code: 'P0001', message: 'staff_refund_immutable' },
      );
      await expect(
        db.query("UPDATE mr_ledger SET details=details WHERE kind='refund'"),
      ).rejects.toMatchObject({ code: 'P0001', message: 'staff_refund_ledger_immutable' });
      expect(await snapshot(true)).toEqual(upgraded);
    }
  } finally {
    backup?.fill(0);
    try {
      await engine.close();
    } finally {
      await isolated.close();
    }
  }
}

it.skipIf(!databaseUrl)(
  'preserves every populated false 028/029 row, journal checksum, identity, hold, job, frozen request and receipt across 030 and restart',
  () => qualifyPopulatedUpgrade(false),
  60_000,
);
it.skipIf(!native || !pgBin)(
  'preserves the populated old false cohort through native 030 dump/restore and a no-op restart with immutable barriers',
  () => qualifyPopulatedUpgrade(true),
  60_000,
);
