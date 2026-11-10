import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEngine } from '@media-router/engine';
import { EventStore, webhookSignature } from '../packages/engine/src/events.js';
import {
  isPublicAddress,
  resolvePublicTarget,
  type WebhookRequest,
  type WebhookSender,
} from '../packages/engine/src/public-network.js';
import { sealVault, openVault } from '../packages/engine/src/vault.js';

const key = 'ab'.repeat(32);
const publicResolver = async () => [{ address: '1.1.1.1', family: 4 }];

describe('outbound webhook security contracts', () => {
  it('signs the exact timestamp, event ID and raw body, and binds vault ciphertext to its owner', () => {
    expect(
      webhookSignature(
        'example-signing-secret',
        '1700000000',
        'evt_example',
        '{"status":"succeeded"}',
      ),
    ).toBe('v1=54437f6c56fc887c2c51725e079db21df8bbe3778e49ad270420940b52be95a0');
    const encrypted = sealVault(
      { secret: 'synthetic webhook value' },
      key,
      'workspace-a:subscription',
    );
    expect(openVault(encrypted, key, 'workspace-a:subscription')).toEqual({
      secret: 'synthetic webhook value',
    });
    expect(() => openVault(encrypted, key, 'workspace-b:subscription')).toThrow();
    expect(() => openVault(encrypted, 'cd'.repeat(32), 'workspace-a:subscription')).toThrow();
    expect(
      sealVault({ secret: 'synthetic webhook value' }, key, 'workspace-a:subscription'),
    ).not.toBe(encrypted);
  });
  it('rejects private, mapped, link-local, documentation and transition addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '100.100.100.200',
      '192.168.1.2',
      '198.18.0.1',
      '203.0.113.5',
      '::1',
      '::ffff:127.0.0.1',
      'fd00::1',
      'fe80::1',
      '2001:0db8::1',
      '2002:7f00:0001::1',
    ])
      expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('1.1.1.1')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('rejects mixed DNS answers, URL user information, non-HTTPS and unusual ports', async () => {
    await expect(
      resolvePublicTarget('https://hooks.example.com', async () => [
        { address: '1.1.1.1', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ]),
    ).rejects.toThrow(/public/);
    for (const url of [
      'http://hooks.example.com',
      'https://user:password@hooks.example.com',
      'https://hooks.example.com:8443',
      'https://localhost',
      'https://2130706433',
      'https://hooks.example.com/#fragment',
    ])
      await expect(resolvePublicTarget(url, publicResolver)).rejects.toThrow();
    expect(
      (await resolvePublicTarget('https://hooks.example.com/events', publicResolver)).address
        .address,
    ).toBe('1.1.1.1');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
async function fixture<T>(
  send: WebhookSender,
  operation: (
    store: EventStore,
    engine: ReturnType<typeof createEngine>,
    workspaceId: string,
  ) => Promise<T>,
) {
  const engine = createEngine({ databaseUrl: databaseUrl! });
  await engine.initialize();
  const workspaceId = `events-${randomUUID()}`;
  await engine.ensureWorkspace(workspaceId, 0);
  const store = new EventStore(engine.pool, { vaultKey: key, resolve: publicResolver, send });
  try {
    return await operation(store, engine, workspaceId);
  } finally {
    await engine.pool.query(
      'DELETE FROM mr_webhook_deliveries WHERE event_id IN (SELECT id FROM mr_events WHERE workspace_id=$1)',
      [workspaceId],
    );
    await engine.pool.query('DELETE FROM mr_events WHERE workspace_id=$1', [workspaceId]);
    await engine.pool.query('DELETE FROM mr_webhook_subscriptions WHERE workspace_id=$1', [
      workspaceId,
    ]);
    await engine.pool.query('DELETE FROM mr_alert_state WHERE workspace_id=$1', [workspaceId]);
    await engine.pool.query('DELETE FROM mr_alert_settings WHERE workspace_id=$1', [workspaceId]);
    await engine.close();
  }
}

async function enqueue(
  store: EventStore,
  engine: ReturnType<typeof createEngine>,
  workspaceId: string,
  id = randomUUID(),
) {
  const client = await engine.pool.connect();
  try {
    await client.query('BEGIN');
    await store.enqueue(client, {
      workspaceId,
      type: 'generation.completed',
      dedupeKey: id,
      data: { jobId: id, status: 'succeeded' },
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!databaseUrl)('transactional events and delivery', () => {
  it('rolls back with the owning transaction and deduplicates repeated transitions', async () => {
    await fixture(
      async () => ({ statusCode: 204 }),
      async (store, engine, workspaceId) => {
        await store.createSubscription(workspaceId, {
          name: 'Production',
          url: 'https://hooks.example.com/events',
          eventTypes: ['generation.completed', 'billing.settled'],
        });
        const client = await engine.pool.connect();
        try {
          await client.query('BEGIN');
          await store.enqueue(client, {
            workspaceId,
            type: 'generation.completed',
            dedupeKey: 'rollback',
            data: { jobId: 'rollback' },
          });
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        expect(
          (
            await engine.pool.query(
              'SELECT count(*)::int AS count FROM mr_events WHERE workspace_id=$1',
              [workspaceId],
            )
          ).rows[0].count,
        ).toBe(0);
        const id = randomUUID();
        await enqueue(store, engine, workspaceId, id);
        await enqueue(store, engine, workspaceId, id);
        const transaction = await engine.pool.connect();
        try {
          await transaction.query('BEGIN');
          await store.enqueue(transaction, {
            workspaceId,
            type: 'billing.settled',
            dedupeKey: id,
            data: { jobId: id, chargedMicros: 10 },
          });
          await transaction.query('COMMIT');
        } finally {
          transaction.release();
        }
        expect((await store.deliveries(workspaceId)).map((row) => row.type).sort()).toEqual([
          'billing.settled',
          'generation.completed',
        ]);
      },
    );
  });
  it('encrypts the secret, retries with stable event/body, and records redacted delivery history', async () => {
    const sent: WebhookRequest[] = [];
    await fixture(
      async (input) => {
        sent.push(input);
        return { statusCode: sent.length === 1 ? 503 : 204 };
      },
      async (store, engine, workspaceId) => {
        const subscription = await store.createSubscription(workspaceId, {
          name: 'Production',
          url: 'https://hooks.example.com/events',
          eventTypes: ['generation.completed'],
        });
        const encrypted = (
          await engine.pool.query(
            'SELECT secret_ciphertext FROM mr_webhook_subscriptions WHERE id=$1',
            [subscription.id],
          )
        ).rows[0].secret_ciphertext;
        expect(encrypted).not.toContain(subscription.secret);
        await enqueue(store, engine, workspaceId);
        expect(await store.workOnce()).toBe(true);
        expect(await store.workOnce()).toBe(false);
        await engine.pool.query(
          'UPDATE mr_webhook_deliveries SET next_attempt_at=now() WHERE subscription_id=$1',
          [subscription.id],
        );
        expect(await store.workOnce()).toBe(true);
        expect(sent).toHaveLength(2);
        expect(sent[0]!.body).toBe(sent[1]!.body);
        expect(sent[0]!.headers['OpenGen-Event-Id']).toBe(sent[1]!.headers['OpenGen-Event-Id']);
        for (const request of sent)
          expect(request.headers['OpenGen-Signature']).toBe(
            webhookSignature(
              subscription.secret,
              request.headers['OpenGen-Event-Timestamp']!,
              request.headers['OpenGen-Event-Id']!,
              request.body,
            ),
          );
        const history = await store.deliveries(workspaceId);
        expect(history[0]).toMatchObject({
          status: 'delivered',
          attempt_count: 2,
          last_status_code: 204,
          last_error_code: null,
        });
        expect(JSON.stringify(history)).not.toContain(subscription.secret);
        expect(await store.listSubscriptions('different-workspace')).toEqual([]);
        await expect(store.rotateSecret('different-workspace', subscription.id)).rejects.toThrow(
          /not found/,
        );
      },
    );
  });
  it('stops after eight attempts and cancels pending deliveries when disabled', async () => {
    let sent = 0;
    await fixture(
      async () => {
        sent++;
        return { statusCode: 503 };
      },
      async (store, engine, workspaceId) => {
        const subscription = await store.createSubscription(workspaceId, {
          name: 'Failing',
          url: 'https://hooks.example.com/events',
          eventTypes: ['generation.completed'],
        });
        await enqueue(store, engine, workspaceId);
        for (let i = 0; i < 8; i++) {
          await engine.pool.query(
            'UPDATE mr_webhook_deliveries SET next_attempt_at=now() WHERE subscription_id=$1',
            [subscription.id],
          );
          await store.workOnce();
        }
        expect(sent).toBe(8);
        expect((await store.deliveries(workspaceId))[0]).toMatchObject({
          status: 'dead',
          attempt_count: 8,
        });
        expect(await store.workOnce()).toBe(false);
        await enqueue(store, engine, workspaceId);
        await store.setEnabled(workspaceId, subscription.id, false);
        expect(
          (await store.deliveries(workspaceId)).some((row) => row.status === 'cancelled'),
        ).toBe(true);
        expect(await store.workOnce()).toBe(false);
      },
    );
  });
  it('emits one alert per condition transition and an explicit resolution', async () => {
    await fixture(
      async () => ({ statusCode: 204 }),
      async (store, engine, workspaceId) => {
        await store.createSubscription(workspaceId, {
          name: 'Alerts',
          url: 'https://hooks.example.com/events',
          eventTypes: ['alert.triggered', 'alert.resolved'],
        });
        await store.configureAlerts(workspaceId, {
          enabled: true,
          lowBalanceMicros: 10,
          webhookFailures: false,
        });
        await store.scanAlerts(true);
        await store.scanAlerts(true);
        expect((await store.alerts(workspaceId))[0]).toMatchObject({
          alert_key: 'balance',
          active: true,
        });
        expect(await store.deliveries(workspaceId)).toHaveLength(1);
        await engine.pool.query('UPDATE mr_workspaces SET available_micros=20 WHERE id=$1', [
          workspaceId,
        ]);
        await store.scanAlerts(true);
        expect((await store.alerts(workspaceId))[0]).toMatchObject({ active: false });
        expect((await store.deliveries(workspaceId)).map((row) => row.type).sort()).toEqual([
          'alert.resolved',
          'alert.triggered',
        ]);
      },
    );
  });
  it('tracks rolling spending and key-expiry conditions through resolution', async () => {
    await fixture(
      async () => ({ statusCode: 204 }),
      async (store, engine, workspaceId) => {
        const keyId = randomUUID();
        await engine.pool.query(
          "INSERT INTO mr_api_keys(id,workspace_id,name,token_hash,scopes,expires_at) VALUES($1,$2,'Expiry fixture',$3,$4,now()+interval '30 minutes')",
          [keyId, workspaceId, randomUUID(), JSON.stringify(['read'])],
        );
        const ledgerId = randomUUID();
        await engine.pool.query(
          "INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros) VALUES($1,$2,'settle',15,0,0)",
          [ledgerId, workspaceId],
        );
        await store.configureAlerts(workspaceId, {
          enabled: true,
          spendingLimitMicros: 10,
          keyExpiryHours: 1,
          webhookFailures: false,
        });
        await store.scanAlerts(true);
        const active = (await store.alerts(workspaceId)).filter((row) => row.active);
        expect(active.map((row) => row.data.kind).sort()).toEqual(['key_expiry', 'spending']);
        await engine.pool.query('UPDATE mr_api_keys SET revoked_at=now() WHERE id=$1', [keyId]);
        await engine.pool.query(
          "UPDATE mr_ledger SET created_at=now()-interval '2 days' WHERE id=$1",
          [ledgerId],
        );
        await store.scanAlerts(true);
        expect((await store.alerts(workspaceId)).every((row) => row.active === false)).toBe(true);
        expect(
          (
            await engine.pool.query(
              'SELECT type,count(*)::int AS count FROM mr_events WHERE workspace_id=$1 GROUP BY type',
              [workspaceId],
            )
          ).rows,
        ).toEqual(
          expect.arrayContaining([
            { type: 'alert.triggered', count: 2 },
            { type: 'alert.resolved', count: 2 },
          ]),
        );
      },
    );
  });
});
