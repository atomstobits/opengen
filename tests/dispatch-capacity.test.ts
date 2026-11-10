import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beginDispatchInTransaction,
  claimAcceptedWorkInTransaction,
  configurePoolInTransaction,
  enqueueDispatchInTransaction,
  expireQueuedDispatchInTransaction,
  markDispatchUnknownInTransaction,
  providerPoolId,
  releaseDispatchInTransaction,
  workspacePoolId,
  type DispatchIdentity,
} from '../packages/engine/src/dispatch-capacity.js';

// Real PostgreSQL SQL/constraints in an ephemeral single backend; multi-session races belong to native PG qualification.
const db = new PGlite();
const client = { query: async (sql: string, values?: unknown[]) => db.query(sql, values) } as Pick<
  PoolClient,
  'query'
>;
const ws = `execution_${randomUUID()}`;
const supply = providerPoolId({ mode: 'managed', supplyId: 'fixture-operator-account' });
async function configure(workspaceId = ws, poolId = supply, maxActive = 1, maxQueued = 4) {
  await db.query(
    'INSERT INTO mr_workspaces(id,available_micros) VALUES($1,9000) ON CONFLICT DO NOTHING',
    [workspaceId],
  );
  await configurePoolInTransaction(client, {
    id: workspacePoolId(workspaceId),
    kind: 'workspace',
    maxActive,
    maxQueued,
  });
  await configurePoolInTransaction(client, { id: poolId, kind: 'provider', maxActive, maxQueued });
}
async function job(
  workspaceId = ws,
  poolId = supply,
  startDeadlineAt?: string,
): Promise<DispatchIdentity> {
  const value = {
    jobId: randomUUID(),
    attemptNumber: 1,
    workspaceId,
    workspacePoolId: workspacePoolId(workspaceId),
    providerPoolId: poolId,
  };
  await db.query(
    `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros)
    VALUES($1,$2,$3,'fixture','{}','{}','{}','queued',100)`,
    [value.jobId, workspaceId, value.jobId],
  );
  await enqueueDispatchInTransaction(client, { ...value, startDeadlineAt });
  return value;
}
async function state(value: DispatchIdentity) {
  return (
    await db.query('SELECT * FROM mr_dispatch_slots WHERE job_id=$1 AND attempt_number=$2', [
      value.jobId,
      value.attemptNumber,
    ])
  ).rows[0];
}
beforeAll(async () => {
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/001.sql', import.meta.url), 'utf8'),
  );
  await db.exec(
    await readFile(new URL('../packages/engine/migrations/007.sql', import.meta.url), 'utf8'),
  );
  await db.exec(
    await readFile(
      new URL('../packages/engine/schema-proposals/execution.sql', import.meta.url),
      'utf8',
    ),
  );
}, 60_000);
afterAll(async () => db.close());

describe('durable execution capacity', () => {
  it('separates stable managed supply and workspace BYOK identities without credential versions', () => {
    expect(providerPoolId({ mode: 'managed', supplyId: 'operator' })).toBe(
      providerPoolId({ mode: 'managed', supplyId: 'operator' }),
    );
    expect(
      providerPoolId({ mode: 'byok', workspaceId: 'one', connectionId: 'connection' }),
    ).not.toBe(providerPoolId({ mode: 'byok', workspaceId: 'two', connectionId: 'connection' }));
    expect(
      providerPoolId({ mode: 'byok', workspaceId: 'one', connectionId: 'connection' }),
    ).not.toContain('connection');
  });
  it('persists unknown occupancy across worker lease expiry/restart; replay never permits another submit', async () => {
    await configure();
    const first = await job();
    const second = await job();
    expect(await beginDispatchInTransaction(client, first)).toBe('acquired');
    await db.query(
      `UPDATE mr_jobs SET lease_until=now()-interval '1 hour',status='submission-unknown' WHERE id=$1`,
      [first.jobId],
    );
    await markDispatchUnknownInTransaction(client, first);
    expect(await beginDispatchInTransaction(client, first)).toBe('already_started');
    expect(await beginDispatchInTransaction(client, second)).toBe('blocked');
    expect((await state(first)).state).toBe('unknown');
    await expect(
      enqueueDispatchInTransaction(client, { ...first, attemptNumber: 2 }),
    ).rejects.toMatchObject({ code: 'dispatch_identity_conflict' });
    expect(await releaseDispatchInTransaction(client, first, 'confirmed_terminal')).toBe(true);
    expect(await releaseDispatchInTransaction(client, first, 'confirmed_terminal')).toBe(false);
    expect(await beginDispatchInTransaction(client, second)).toBe('acquired');
    await releaseDispatchInTransaction(client, second, 'explicit_rejection');
  });
  it('bounds queued backlog, preserves replay, and rejects pool/deadline identity changes', async () => {
    const privateWs = `backlog_${randomUUID()}`;
    const privateSupply = providerPoolId({ mode: 'managed', supplyId: privateWs });
    await configure(privateWs, privateSupply, 1, 1);
    const first = await job(privateWs, privateSupply);
    expect(await enqueueDispatchInTransaction(client, first)).toEqual({
      state: 'queued',
      replay: true,
    });
    await expect(job(privateWs, privateSupply)).rejects.toMatchObject({
      code: 'dispatch_backpressure',
      statusCode: 429,
    });
    await expect(
      enqueueDispatchInTransaction(client, {
        ...first,
        startDeadlineAt: '2030-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'dispatch_identity_conflict' });
    await expect(
      enqueueDispatchInTransaction(client, { ...first, workspaceId: ws }),
    ).rejects.toMatchObject({ code: 'dispatch_identity_conflict' });
    await beginDispatchInTransaction(client, first);
    const second = await job(privateWs, privateSupply);
    expect(await beginDispatchInTransaction(client, second)).toBe('blocked');
    await releaseDispatchInTransaction(client, first, 'explicit_rejection');
    expect(await beginDispatchInTransaction(client, second)).toBe('acquired');
  });
  it('expires only never-submitted work at the start boundary; wait/runtime expiry cannot release accepted work', async () => {
    const privateWs = `deadline_${randomUUID()}`;
    const privateSupply = providerPoolId({ mode: 'managed', supplyId: privateWs });
    await configure(privateWs, privateSupply);
    const expired = await job(privateWs, privateSupply, '2000-01-01T00:00:00.000Z');
    expect(await beginDispatchInTransaction(client, expired)).toBe('expired');
    expect(await expireQueuedDispatchInTransaction(client, expired)).toBe(false);
    expect(await state(expired)).toMatchObject({
      state: 'expired',
      submission_intent_at: null,
      release_evidence: 'never_submitted_deadline',
    });
    const future = await job(privateWs, privateSupply, '2099-01-01T00:00:00.000Z');
    expect(await beginDispatchInTransaction(client, future)).toBe('acquired');
    await db.query(
      `UPDATE mr_dispatch_slots SET start_deadline_at=now()-interval '1 second' WHERE job_id=$1`,
      [future.jobId],
    );
    expect(await expireQueuedDispatchInTransaction(client, future)).toBe(false);
    expect(await beginDispatchInTransaction(client, future)).toBe('already_started');
    // This service never writes financial state or fabricates cancellation/refund.
    expect(
      (
        await db.query('SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1', [
          privateWs,
        ])
      ).rows[0],
    ).toEqual({ available_micros: 9000, reserved_micros: 0 });
    expect((await db.query('SELECT count(*)::int AS count FROM mr_ledger')).rows[0]).toEqual({
      count: 0,
    });
  });
  it('rechecks the deadline atomically after counting capacity before persisting submission intent', async () => {
    const privateWs = `boundary_${randomUUID()}`;
    const privateSupply = providerPoolId({ mode: 'managed', supplyId: privateWs });
    await configure(privateWs, privateSupply);
    const value = await job(privateWs, privateSupply, '2099-01-01T00:00:00.000Z');
    let counted = 0;
    const crossing = {
      query: async (sql: string, values?: unknown[]) => {
        const result = await db.query(sql, values);
        if (sql.includes('AS active') && ++counted === 2)
          await db.query(
            `UPDATE mr_dispatch_slots SET start_deadline_at=clock_timestamp() WHERE job_id=$1`,
            [value.jobId],
          );
        return result;
      },
    } as Pick<PoolClient, 'query'>;
    expect(await beginDispatchInTransaction(crossing, value)).toBe('expired');
    expect(await state(value)).toMatchObject({ state: 'expired', submission_intent_at: null });
  });

  it('shares managed supply across workspaces while BYOK uses its own pool', async () => {
    const a = `managed_a_${randomUUID()}`,
      b = `managed_b_${randomUUID()}`;
    const shared = providerPoolId({ mode: 'managed', supplyId: a });
    const byok = providerPoolId({
      mode: 'byok',
      workspaceId: b,
      connectionId: 'stable-fixture-connection',
    });
    await configure(a, shared);
    await configure(b, shared);
    await configure(b, byok);
    const first = await job(a, shared),
      second = await job(b, shared),
      own = await job(b, byok);
    expect(await beginDispatchInTransaction(client, first)).toBe('acquired');
    expect(await beginDispatchInTransaction(client, second)).toBe('blocked');
    expect(await beginDispatchInTransaction(client, own)).toBe('acquired');
    // Raising the provider limit still cannot bypass the independent workspace limit.
    await configurePoolInTransaction(client, {
      id: shared,
      kind: 'provider',
      maxActive: 3,
      maxQueued: 4,
    });
    expect(await beginDispatchInTransaction(client, second)).toBe('blocked');
  });
  it('polls accepted work and late billing under full capacity and blocked queued submits without consuming slots', async () => {
    const privateWs = `fairness_${randomUUID()}`;
    const privateSupply = providerPoolId({ mode: 'managed', supplyId: privateWs });
    await configure(privateWs, privateSupply);
    const accepted = await job(privateWs, privateSupply);
    await beginDispatchInTransaction(client, accepted);
    await db.query(`UPDATE mr_jobs SET status='running',upstream_id='same-upstream' WHERE id=$1`, [
      accepted.jobId,
    ]);
    const blocked = await job(privateWs, privateSupply);
    expect(await beginDispatchInTransaction(client, blocked)).toBe('blocked');
    const claimed = await claimAcceptedWorkInTransaction(client, 5000);
    expect(claimed).toMatchObject({ id: accepted.jobId, status: 'running', attempt_count: 0 });
    expect(await claimAcceptedWorkInTransaction(client, 5000)).toBeNull();
    await releaseDispatchInTransaction(client, accepted, 'confirmed_terminal');
    await db.query(
      `UPDATE mr_jobs SET status='succeeded',lease_until=NULL,billing_poll_pending=true WHERE id=$1`,
      [accepted.jobId],
    );
    expect(await claimAcceptedWorkInTransaction(client, 5000)).toMatchObject({
      id: accepted.jobId,
      status: 'succeeded',
    });
    expect((await state(accepted)).state).toBe('released');
  });
});
