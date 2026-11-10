import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Principal } from '@media-router/engine';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { NotificationStore, notificationData } from '../packages/engine/src/notifications.js';
import { registerNotifications } from '../apps/server/src/notifications.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('notification projection and transport boundary', () => {
  it('drops arbitrary content and malformed amounts from existing event data', () => {
    expect(
      notificationData({
        kind: 'low_balance',
        alertKey: 'balance',
        thresholdMicros: 10,
        availableMicros: -1,
        spentMicros: 1.2,
        prompt: 'private prompt',
        token: 'secret',
        outputs: [{ url: 'https://private.example' }],
        expiresAt: 'not a date',
      }),
    ).toEqual({
      kind: 'low_balance',
      alertKey: 'balance',
      thresholdMicros: 10,
    });
  });
  it('requires the authenticated actor, rejects member overrides and cannot enable email', async () => {
    const calls: unknown[] = [];
    const actor: Principal = {
      workspaceId: 'workspace-a',
      membershipId: randomUUID(),
      scopes: ['read'],
    };
    const store = {
      list: async (...args: unknown[]) => {
        calls.push(args);
        return { items: [], nextCursor: null };
      },
      setPreferences: async () => {
        throw new Error('must not be called');
      },
    } as unknown as NotificationStore;
    const app = Fastify();
    await registerNotifications(app, {
      notifications: store,
      authenticate: async (_request, scope) => {
        expect(scope).toBe('read');
        return actor;
      },
    });
    try {
      const good = await app.inject('/v1/notifications?limit=2&unreadOnly=true');
      expect(good.statusCode).toBe(200);
      expect(good.headers['cache-control']).toBe('no-store');
      expect(calls).toEqual([[actor, { limit: 2, unreadOnly: true }]]);
      expect(
        (await app.inject('/v1/notifications?membershipId=someone-else')).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/v1/notifications/preferences',
            payload: {
              inApp: true,
              eventTypes: ['alert.triggered'],
              email: true,
            },
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      await app.close();
    }
  });
});

describe('member notifications against the alert outbox', () => {
  let engine: { pool: Pool };
  let dispose: () => Promise<void>;
  let store: NotificationStore;
  const workspaceId = `notifications-${randomUUID()}`;
  const otherWorkspaceId = `notifications-other-${randomUUID()}`;
  const memberA = randomUUID(),
    memberB = randomUUID(),
    removed = randomUUID();
  const actor = (membershipId: string): Principal => ({
    workspaceId,
    membershipId,
    scopes: ['read'],
  });
  beforeAll(async () => {
    const db = databaseUrl ? new Pool({ connectionString: databaseUrl }) : new PGlite();
    const nativeClient = databaseUrl ? await (db as Pool).connect() : null;
    const schema = `notifications_${randomUUID().replaceAll('-', '')}`;
    const query = nativeClient
      ? nativeClient.query.bind(nativeClient)
      : async (sql: string, params?: unknown[]) => {
          const result = await (db as PGlite).query(sql, params);
          return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
        };
    const client = { query, release: () => {} };
    engine = { pool: { query, connect: async () => client } as unknown as Pool };
    if (nativeClient) {
      await query(`CREATE SCHEMA ${schema}`);
      await query(`SET search_path TO ${schema}`);
    }
    const exec = nativeClient ? query : (sql: string) => (db as PGlite).exec(sql);
    for (const name of ['001', '002', '003', '010'])
      await exec(
        await readFile(
          new URL(`../packages/engine/migrations/${name}.sql`, import.meta.url),
          'utf8',
        ),
      );
    await exec(
      await readFile(
        new URL(
          '../packages/engine/schema-proposals/operations-notifications.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    dispose = async () => {
      if (nativeClient) {
        await query('SET search_path TO public');
        await query(`DROP SCHEMA ${schema} CASCADE`);
        nativeClient.release();
        await (db as Pool).end();
      } else await (db as PGlite).close();
    };
    await query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0),($2,0)', [
      workspaceId,
      otherWorkspaceId,
    ]);
    for (const id of [memberA, memberB, removed])
      await engine.pool.query(
        `INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at,removed_at)
      VALUES($1,$2,'https://identity.example',$4,'member',now(),CASE WHEN $3 THEN now() ELSE NULL END)`,
        [id, workspaceId, id === removed, id],
      );
    store = new NotificationStore(engine.pool);
  });
  afterAll(async () => {
    if (dispose) await dispose();
  });
  async function alert(
    type = 'alert.triggered',
    time = '2026-11-04T12:00:00.000001Z',
    owner = workspaceId,
  ) {
    const id = randomUUID();
    await engine.pool.query(
      'INSERT INTO mr_events(id,workspace_id,type,dedupe_key,data,created_at) VALUES($1,$2,$3,$6,$4,$5)',
      [
        id,
        owner,
        type,
        JSON.stringify({
          kind: 'low_balance',
          alertKey: 'balance',
          thresholdMicros: 10,
          prompt: 'never return me',
        }),
        time,
        id,
      ],
    );
    return id;
  }
  it('isolates unread state, keeps repeat reads stable, and rejects foreign or removed members', async () => {
    const id = await alert();
    const foreignId = await alert('alert.triggered', undefined, otherWorkspaceId);
    const firstRead = await store.markRead(actor(memberA), id);
    expect(await store.markRead(actor(memberA), id)).toEqual(firstRead);
    expect((await store.list(actor(memberA), { unreadOnly: true })).items).toEqual([]);
    expect(
      (await store.list(actor(memberB), { unreadOnly: true })).items.map((row) => row.id),
    ).toEqual([id]);
    await expect(store.markRead(actor(memberA), foreignId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      store.list({ ...actor(memberA), workspaceId: otherWorkspaceId }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(store.list(actor(removed))).rejects.toMatchObject({ statusCode: 403 });
    await expect(store.list({ workspaceId, scopes: ['read'] })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(store.list({ ...actor(memberA), scopes: [] })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(JSON.stringify(await store.list(actor(memberB)))).not.toContain('never return me');
  });
  it('paginates equal and microsecond timestamps exactly, excludes newer inserts, and binds cursors to the workspace', async () => {
    await alert('generation.completed', '2026-11-04T13:00:00.999999Z');
    const ids = [
      await alert('alert.resolved', '2026-11-04T13:00:00.000001Z'),
      await alert('alert.triggered', '2026-11-04T13:00:00.000001Z'),
      await alert('alert.resolved', '2026-11-04T13:00:00.000002Z'),
    ];
    const first = await store.list(actor(memberB), { limit: 1 });
    expect(first.items[0]?.id).toBe(ids[2]);
    expect(first.nextCursor).not.toBeNull();
    const newest = await alert('alert.triggered', '2026-11-04T14:00:00.000000Z');
    const second = await store.list(actor(memberB), { limit: 1, cursor: first.nextCursor! });
    const third = await store.list(actor(memberB), { limit: 1, cursor: second.nextCursor! });
    expect([second.items[0]?.id, third.items[0]?.id].sort()).toEqual(ids.slice(0, 2).sort());
    expect([second, third].flatMap((page) => page.items.map((item) => item.id))).not.toContain(
      newest,
    );
    await expect(
      store.list(
        { ...actor(memberB), workspaceId: otherWorkspaceId },
        { cursor: first.nextCursor! },
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.list(actor(memberB), { cursor: 'garbage' })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(store.list(actor(memberB), { limit: 101 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
  it('keeps per-member opt-outs/preferences separate and explicitly reports unavailable email', async () => {
    expect(
      await store.setPreferences(actor(memberA), { inApp: false, eventTypes: ['alert.triggered'] }),
    ).toEqual({
      inApp: false,
      eventTypes: ['alert.triggered'],
      email: false,
      emailAvailable: false,
    });
    expect((await store.list(actor(memberA))).items).toEqual([]);
    expect((await store.getPreferences(actor(memberB))).inApp).toBe(true);
    expect((await store.list(actor(memberB))).items.length).toBeGreaterThan(0);
    await store.setPreferences(actor(memberA), { inApp: true, eventTypes: ['alert.resolved'] });
    expect(
      (await store.list(actor(memberA))).items.every((item) => item.type === 'alert.resolved'),
    ).toBe(true);
  });
});
