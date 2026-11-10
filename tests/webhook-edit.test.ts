import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { EventStore, webhookSignature } from '../packages/engine/src/events.js';
import { webhookEditSchema } from '../apps/server/src/events.js';
import type { WebhookRequest, WebhookSender } from '../packages/engine/src/public-network.js';

// Reuse one WASM runtime; every fixture still owns a fresh SQL schema.
let localDb: PGlite | undefined;
afterAll(async () => {
  await localDb?.close();
});

async function fixture(
  run: (store: EventStore, pool: Pool, workspaceId: string) => Promise<void>,
  send: WebhookSender = async () => ({ statusCode: 204 }),
) {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const db = databaseUrl ? new Pool({ connectionString: databaseUrl }) : (localDb ??= new PGlite());
  const native = databaseUrl ? await (db as Pool).connect() : null;
  const schema = `webhook_edit_${randomUUID().replaceAll('-', '')}`;
  const query = native
    ? native.query.bind(native)
    : async (sql: string, params?: unknown[]) => {
        const result = await (db as PGlite).query(sql, params);
        return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
      };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  try {
    await query(`CREATE SCHEMA ${schema}`);
    await query(`SET search_path TO ${schema}`);
    const exec = native ? query : (sql: string) => (db as PGlite).exec(sql);
    for (const name of ['001', '002', '003'])
      await exec(
        await readFile(
          new URL(`../packages/engine/migrations/${name}.sql`, import.meta.url),
          'utf8',
        ),
      );
    const workspaceId = `hooks-${randomUUID()}`;
    await query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [workspaceId]);
    await run(
      new EventStore(pool, {
        vaultKey: 'ab'.repeat(32),
        resolve: async () => [{ address: '1.1.1.1', family: 4 }],
        send,
      }),
      pool,
      workspaceId,
    );
  } finally {
    await query('SET search_path TO public');
    await query(`DROP SCHEMA ${schema} CASCADE`);
    if (native) {
      native.release();
      await (db as Pool).end();
    }
  }
}
async function enqueue(
  store: EventStore,
  pool: Pool,
  workspaceId: string,
  type: 'generation.completed' | 'billing.settled' = 'generation.completed',
  dedupeKey = randomUUID(),
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await store.enqueue(client, {
      workspaceId,
      type,
      dedupeKey,
      data: { jobId: dedupeKey, status: 'succeeded' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const input = {
  name: 'Endpoint',
  url: 'https://hooks.example.com/original',
  eventTypes: ['generation.completed'] as ('generation.completed' | 'billing.settled')[],
};

describe('safe webhook configuration changes', () => {
  it('requires an explicit bounded edit and cancellation policy', () => {
    for (const invalid of [
      {},
      { pending: 'cancel' },
      { url: input.url },
      { eventTypes: [] },
      { name: 'x'.repeat(81) },
      { eventTypes: ['unknown'], pending: 'cancel' },
      { enabled: false, secret: 'injected' },
    ])
      expect(webhookEditSchema.safeParse(invalid).success).toBe(false);
    expect(webhookEditSchema.parse({ url: input.url, pending: 'cancel' })).toEqual({
      url: input.url,
      pending: 'cancel',
    });
  });
  it('cancels old queued events, preserves immutable old history, and routes only future selected events to the new endpoint', async () => {
    const sent: WebhookRequest[] = [];
    await fixture(
      async (store, pool, workspaceId) => {
        const sub = await store.createSubscription(workspaceId, input);
        const dedupeKey = randomUUID();
        await enqueue(store, pool, workspaceId, 'generation.completed', dedupeKey);
        await enqueue(store, pool, workspaceId, 'generation.completed', dedupeKey);
        expect(await store.deliveries(workspaceId)).toHaveLength(1);
        await expect(
          store.editSubscription(workspaceId, sub.id, { url: 'https://hooks.example.com/new' }),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
          store.editSubscription('different-workspace', sub.id, { name: 'Forbidden' }),
        ).rejects.toMatchObject({ statusCode: 404 });
        await expect(
          store.editSubscription(workspaceId, sub.id, {
            url: 'http://127.0.0.1',
            pending: 'cancel',
          }),
        ).rejects.toThrow();
        expect((await store.listSubscriptions(workspaceId))[0]?.url).toBe(input.url);
        await store.editSubscription(workspaceId, sub.id, {
          name: 'Billing',
          url: 'https://hooks.example.com/new',
          eventTypes: ['billing.settled'],
          pending: 'cancel',
        });
        expect((await store.deliveries(workspaceId))[0]?.status).toBe('cancelled');
        expect(await store.workOnce()).toBe(false);
        await enqueue(store, pool, workspaceId);
        expect(await store.deliveries(workspaceId)).toHaveLength(1);
        await enqueue(store, pool, workspaceId, 'billing.settled');
        expect(await store.workOnce()).toBe(true);
        expect(sent.map((request) => request.url)).toEqual(['https://hooks.example.com/new']);
        expect(JSON.stringify(await store.listSubscriptions(workspaceId))).not.toContain(
          sub.secret,
        );
      },
      async (request) => {
        sent.push(request);
        return { statusCode: 204 };
      },
    );
  });
  it('keeps an in-flight send at its original endpoint and prevents disable/re-enable from reviving retries', async () => {
    let started!: () => void;
    let finish!: (value: { statusCode: number }) => void;
    const sending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const completion = new Promise<{ statusCode: number }>((resolve) => {
      finish = resolve;
    });
    const sent: WebhookRequest[] = [];
    await fixture(
      async (store, pool, workspaceId) => {
        const sub = await store.createSubscription(workspaceId, input);
        await enqueue(store, pool, workspaceId);
        const work = store.workOnce();
        await sending;
        await expect(
          store.editSubscription(workspaceId, sub.id, {
            url: 'https://hooks.example.com/new',
            pending: 'cancel',
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        await store.setEnabled(workspaceId, sub.id, false);
        await store.setEnabled(workspaceId, sub.id, true);
        finish({ statusCode: 503 });
        await work;
        expect(sent[0]?.url).toBe(input.url);
        expect((await store.deliveries(workspaceId))[0]).toMatchObject({
          status: 'cancelled',
          attempt_count: 1,
        });
        expect(await store.workOnce()).toBe(false);
      },
      async (request) => {
        sent.push(request);
        started();
        return completion;
      },
    );
  });
  it('rotates the one-time secret for later attempts without changing event identity or body', async () => {
    const sent: WebhookRequest[] = [];
    await fixture(
      async (store, pool, workspaceId) => {
        const sub = await store.createSubscription(workspaceId, input);
        await enqueue(store, pool, workspaceId);
        await store.workOnce();
        const rotated = await store.rotateSecret(workspaceId, sub.id);
        expect(rotated.secret).not.toBe(sub.secret);
        await pool.query(
          'UPDATE mr_webhook_deliveries SET next_attempt_at=now() WHERE subscription_id=$1',
          [sub.id],
        );
        await store.workOnce();
        expect(sent[0]?.body).toBe(sent[1]?.body);
        expect(sent[0]?.headers['OpenGen-Event-Id']).toBe(sent[1]?.headers['OpenGen-Event-Id']);
        for (const [index, secret] of [sub.secret, rotated.secret].entries()) {
          const request = sent[index]!;
          expect(request.headers['OpenGen-Signature']).toBe(
            webhookSignature(
              secret,
              request.headers['OpenGen-Event-Timestamp']!,
              request.headers['OpenGen-Event-Id']!,
              request.body,
            ),
          );
        }
        const history = JSON.stringify(await store.deliveries(workspaceId));
        expect(history).not.toContain(sub.secret);
        expect(history).not.toContain(rotated.secret);
      },
      async (request) => {
        sent.push(request);
        return { statusCode: sent.length === 1 ? 503 : 204 };
      },
    );
  });
});
