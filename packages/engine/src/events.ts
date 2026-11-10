import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sealVault, openVault } from './vault.js';
import {
  resolvePublicTarget,
  sendPublicWebhook,
  type WebhookSender,
  type PublicResolver,
} from './public-network.js';

export const eventTypes = [
  'generation.completed',
  'billing.settled',
  'alert.triggered',
  'alert.resolved',
] as const;
export type EventType = (typeof eventTypes)[number];
export interface OutboxEvent {
  workspaceId: string;
  type: EventType;
  dedupeKey: string;
  data: Record<string, unknown>;
}
export interface AlertSettings {
  enabled: boolean;
  lowBalanceMicros?: number | null;
  spendingLimitMicros?: number | null;
  keyExpiryHours?: number | null;
  webhookFailures: boolean;
}
export interface SubscriptionEdit {
  name?: string;
  url?: string;
  eventTypes?: EventType[];
  enabled?: boolean;
  /** Required for endpoint/event changes. Queued retries are cancelled, never rerouted. */
  pending?: 'cancel';
}
const retryDelays = [30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000];
export function webhookSignature(
  secret: string,
  timestamp: string,
  id: string,
  rawBody: string,
): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${id}.${rawBody}`).digest('hex')}`;
}
const notFound = () =>
  Object.assign(new Error('Webhook subscription not found.'), { statusCode: 404 });

export class EventStore {
  private lastAlertScan = 0;
  constructor(
    readonly pool: Pool,
    private options: { vaultKey?: string; send?: WebhookSender; resolve?: PublicResolver } = {},
  ) {}
  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Call with the same transaction that commits the job/ledger transition. */
  async enqueue(client: PoolClient, event: OutboxEvent): Promise<void> {
    const inserted = await client.query(
      `INSERT INTO mr_events(id,workspace_id,type,dedupe_key,data)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,type,dedupe_key) DO NOTHING RETURNING id`,
      [randomUUID(), event.workspaceId, event.type, event.dedupeKey, JSON.stringify(event.data)],
    );
    if (!inserted.rows[0]) return;
    // Serialize event selection with subscription edits/disable. The same transaction
    // owns both the event and its fan-out; no post-edit event can use an old filter.
    const subscriptions = await client.query(
      `SELECT id FROM mr_webhook_subscriptions WHERE workspace_id=$1 AND enabled=true AND event_types ? $2 FOR SHARE`,
      [event.workspaceId, event.type],
    );
    await client.query(
      `INSERT INTO mr_webhook_deliveries(id,event_id,subscription_id)
      SELECT gen_random_uuid(),$1,unnest($2::uuid[])
      ON CONFLICT(event_id,subscription_id) DO NOTHING`,
      [inserted.rows[0].id, subscriptions.rows.map((row) => row.id)],
    );
  }

  async createSubscription(
    workspaceId: string,
    input: { name: string; url: string; eventTypes: EventType[] },
  ) {
    await resolvePublicTarget(input.url, this.options.resolve);
    const id = randomUUID(),
      secret = `og_whsec_${randomBytes(32).toString('hex')}`;
    const ciphertext = sealVault(secret, this.options.vaultKey, `webhook:${workspaceId}:${id}`);
    const { rows } = await this.pool.query(
      `INSERT INTO mr_webhook_subscriptions(id,workspace_id,name,url,event_types,secret_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,url,event_types,enabled,created_at`,
      [
        id,
        workspaceId,
        input.name,
        input.url,
        JSON.stringify([...new Set(input.eventTypes)]),
        ciphertext,
      ],
    );
    return { ...rows[0], secret };
  }
  async listSubscriptions(workspaceId: string) {
    return (
      await this.pool.query(
        'SELECT id,name,url,event_types,enabled,created_at FROM mr_webhook_subscriptions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',
        [workspaceId],
      )
    ).rows;
  }
  async setEnabled(workspaceId: string, id: string, enabled: boolean) {
    return this.editSubscription(workspaceId, id, { enabled });
  }

  async editSubscription(workspaceId: string, id: string, input: SubscriptionEdit) {
    if (input.url !== undefined) await resolvePublicTarget(input.url, this.options.resolve);
    const changesRouting = input.url !== undefined || input.eventTypes !== undefined;
    if (changesRouting && input.pending !== 'cancel')
      throw Object.assign(new Error('Endpoint/event edits require pending: cancel.'), {
        statusCode: 400,
        code: 'pending_behavior_required',
      });
    return this.transaction(async (client) => {
      const owned = await client.query(
        'SELECT id FROM mr_webhook_subscriptions WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [id, workspaceId],
      );
      if (!owned.rowCount) throw notFound();
      if (changesRouting) {
        const active = await client.query(
          "SELECT id FROM mr_webhook_deliveries WHERE subscription_id=$1 AND status='delivering' LIMIT 1",
          [id],
        );
        if (active.rowCount)
          throw Object.assign(
            new Error('Wait for the in-flight delivery before editing this endpoint.'),
            {
              statusCode: 409,
              code: 'webhook_delivery_in_flight',
            },
          );
      }
      const { rows } = await client.query(
        `UPDATE mr_webhook_subscriptions SET name=COALESCE($3,name),url=COALESCE($4,url),
        event_types=COALESCE($5::jsonb,event_types),enabled=COALESCE($6,enabled)
        WHERE id=$1 AND workspace_id=$2 RETURNING id,name,url,event_types,enabled,created_at`,
        [
          id,
          workspaceId,
          input.name ?? null,
          input.url ?? null,
          input.eventTypes ? JSON.stringify([...new Set(input.eventTypes)]) : null,
          input.enabled ?? null,
        ],
      );
      if (changesRouting || input.enabled === false)
        await client.query(
          `UPDATE mr_webhook_deliveries SET status='cancelled',lease_until=NULL,updated_at=now()
          WHERE subscription_id=$1 AND (status='pending' OR ($2 AND status='delivering'))`,
          [id, input.enabled === false],
        );
      return rows[0];
    });
  }
  async rotateSecret(workspaceId: string, id: string) {
    const secret = `og_whsec_${randomBytes(32).toString('hex')}`;
    const ciphertext = sealVault(secret, this.options.vaultKey, `webhook:${workspaceId}:${id}`);
    const { rowCount } = await this.pool.query(
      'UPDATE mr_webhook_subscriptions SET secret_ciphertext=$3 WHERE id=$1 AND workspace_id=$2',
      [id, workspaceId, ciphertext],
    );
    if (!rowCount) throw notFound();
    return { id, secret };
  }
  async deliveries(workspaceId: string) {
    return (
      await this.pool.query(
        `SELECT d.id,d.event_id,d.subscription_id,d.status,d.attempt_count,d.next_attempt_at,
      d.last_status_code,d.last_error_code,d.delivered_at,d.updated_at,e.type,e.created_at
      FROM mr_webhook_deliveries d JOIN mr_events e ON e.id=d.event_id
      WHERE e.workspace_id=$1 ORDER BY d.updated_at DESC LIMIT 100`,
        [workspaceId],
      )
    ).rows;
  }

  async workOnce(): Promise<boolean> {
    // Finish stale final attempts in their own statement before taking subscription
    // locks; edits and claims consistently lock subscription before delivery.
    await this.pool.query(
      "UPDATE mr_webhook_deliveries SET status='dead',lease_until=NULL,last_error_code='worker_interrupted',updated_at=now() WHERE status='delivering' AND lease_until<now() AND attempt_count>=8",
    );
    const delivery = await this.transaction(async (client) => {
      const { rows } =
        await client.query(`SELECT d.id,d.event_id,d.subscription_id,d.attempt_count,e.workspace_id,e.type,e.data,e.created_at,s.url,s.secret_ciphertext
        FROM mr_webhook_deliveries d JOIN mr_events e ON e.id=d.event_id
        JOIN mr_webhook_subscriptions s ON s.id=d.subscription_id
        WHERE s.enabled=true AND d.attempt_count<8 AND d.next_attempt_at<=now() AND (d.status='pending' OR (d.status='delivering' AND d.lease_until<now()))
        ORDER BY d.next_attempt_at FOR UPDATE OF s SKIP LOCKED LIMIT 1`);
      if (!rows[0]) return null;
      const row = rows[0];
      const claimed = await client.query(
        `UPDATE mr_webhook_deliveries SET status='delivering',attempt_count=attempt_count+1,lease_until=now()+interval '2 minutes',updated_at=now()
        WHERE id=$1 AND attempt_count<8 AND next_attempt_at<=now() AND
        (status='pending' OR (status='delivering' AND lease_until<now())) RETURNING attempt_count`,
        [row.id],
      );
      if (!claimed.rows[0]) return null;
      return { ...row, attempt_count: claimed.rows[0].attempt_count };
    });
    if (!delivery) return false;
    let statusCode: number | null = null,
      errorCode: string | null = null;
    try {
      const secret = openVault<string>(
        delivery.secret_ciphertext,
        this.options.vaultKey,
        `webhook:${delivery.workspace_id}:${delivery.subscription_id}`,
      );
      const body = JSON.stringify({
        id: delivery.event_id,
        type: delivery.type,
        createdAt: delivery.created_at.toISOString(),
        data: delivery.data,
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const result = await (this.options.send ?? sendPublicWebhook)({
        url: delivery.url,
        body,
        headers: {
          'OpenGen-Event-Id': delivery.event_id,
          'OpenGen-Event-Timestamp': timestamp,
          'OpenGen-Signature': webhookSignature(secret, timestamp, delivery.event_id, body),
        },
      });
      statusCode =
        Number.isInteger(result.statusCode) && result.statusCode >= 100 && result.statusCode <= 599
          ? result.statusCode
          : null;
      if (!statusCode || statusCode < 200 || statusCode >= 300) errorCode = 'http_rejected';
    } catch {
      errorCode = 'delivery_failed';
    }
    const succeeded = errorCode === null;
    const dead = !succeeded && delivery.attempt_count >= 8;
    await this.pool.query(
      `UPDATE mr_webhook_deliveries SET status=$3,last_status_code=$4,last_error_code=$5,lease_until=NULL,
      delivered_at=CASE WHEN $6 THEN now() ELSE delivered_at END,next_attempt_at=now()+($7 * interval '1 millisecond'),updated_at=now()
      WHERE id=$1 AND attempt_count=$2 AND status='delivering'`,
      [
        delivery.id,
        delivery.attempt_count,
        succeeded ? 'delivered' : dead ? 'dead' : 'pending',
        statusCode,
        errorCode,
        succeeded,
        retryDelays[Math.min(delivery.attempt_count - 1, retryDelays.length - 1)]!,
      ],
    );
    return true;
  }

  async getAlertSettings(workspaceId: string) {
    return (
      (
        await this.pool.query(
          'SELECT enabled,low_balance_micros,spending_limit_micros,key_expiry_hours,webhook_failures FROM mr_alert_settings WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows[0] ?? {
        enabled: false,
        low_balance_micros: null,
        spending_limit_micros: null,
        key_expiry_hours: null,
        webhook_failures: false,
      }
    );
  }
  async configureAlerts(workspaceId: string, settings: AlertSettings) {
    await this.pool.query(
      `INSERT INTO mr_alert_settings(workspace_id,enabled,low_balance_micros,spending_limit_micros,key_expiry_hours,webhook_failures)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET enabled=EXCLUDED.enabled,low_balance_micros=EXCLUDED.low_balance_micros,
      spending_limit_micros=EXCLUDED.spending_limit_micros,key_expiry_hours=EXCLUDED.key_expiry_hours,webhook_failures=EXCLUDED.webhook_failures`,
      [
        workspaceId,
        settings.enabled,
        settings.lowBalanceMicros ?? null,
        settings.spendingLimitMicros ?? null,
        settings.keyExpiryHours ?? null,
        settings.webhookFailures,
      ],
    );
    return this.getAlertSettings(workspaceId);
  }
  async alerts(workspaceId: string) {
    return (
      await this.pool.query(
        'SELECT alert_key,active,data,updated_at FROM mr_alert_state WHERE workspace_id=$1 ORDER BY updated_at DESC LIMIT 100',
        [workspaceId],
      )
    ).rows;
  }
  private async transition(
    client: PoolClient,
    workspaceId: string,
    key: string,
    active: boolean,
    data: Record<string, unknown>,
  ) {
    await client.query(
      'INSERT INTO mr_alert_state(workspace_id,alert_key,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [workspaceId, key, JSON.stringify(data)],
    );
    const row = (
      await client.query(
        'SELECT active,change_count FROM mr_alert_state WHERE workspace_id=$1 AND alert_key=$2 FOR UPDATE',
        [workspaceId, key],
      )
    ).rows[0];
    if (row.active === active) return;
    const version = row.change_count + 1;
    await client.query(
      'UPDATE mr_alert_state SET active=$3,change_count=$4,data=$5,updated_at=now() WHERE workspace_id=$1 AND alert_key=$2',
      [workspaceId, key, active, version, JSON.stringify(data)],
    );
    await this.enqueue(client, {
      workspaceId,
      type: active ? 'alert.triggered' : 'alert.resolved',
      dedupeKey: `${key}:${version}`,
      data: { alertKey: key, ...data },
    });
  }

  /** At most once/minute per worker; DB state makes concurrent scans and restarts safe. */
  async scanAlerts(force = false): Promise<void> {
    if (!force && Date.now() - this.lastAlertScan < 60_000) return;
    this.lastAlertScan = Date.now();
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('opengen-alert-scan'))");
      const settings = (
        await client.query(
          'SELECT a.*,w.available_micros FROM mr_alert_settings a JOIN mr_workspaces w ON w.id=a.workspace_id',
        )
      ).rows;
      for (const setting of settings) {
        const conditions = new Map<string, Record<string, unknown>>();
        if (setting.enabled) {
          if (
            setting.low_balance_micros !== null &&
            Number(setting.available_micros) <= Number(setting.low_balance_micros)
          )
            conditions.set('balance', {
              kind: 'low_balance',
              availableMicros: Number(setting.available_micros),
              thresholdMicros: Number(setting.low_balance_micros),
            });
          if (setting.spending_limit_micros !== null) {
            const spent = Number(
              (
                await client.query(
                  "SELECT coalesce(sum(amount_micros),0) AS amount FROM mr_ledger WHERE workspace_id=$1 AND kind='settle' AND created_at>=now()-interval '24 hours'",
                  [setting.workspace_id],
                )
              ).rows[0].amount,
            );
            if (spent >= Number(setting.spending_limit_micros))
              conditions.set('spending', {
                kind: 'spending',
                window: 'rolling_24_hours',
                spentMicros: spent,
                thresholdMicros: Number(setting.spending_limit_micros),
              });
          }
          if (setting.key_expiry_hours !== null) {
            const keys = (
              await client.query(
                "SELECT id,expires_at FROM mr_api_keys WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at<=now()+($2 * interval '1 hour')",
                [setting.workspace_id, setting.key_expiry_hours],
              )
            ).rows;
            for (const key of keys)
              conditions.set(`key:${key.id}`, {
                kind: 'key_expiry',
                keyId: key.id,
                expiresAt: key.expires_at.toISOString(),
              });
          }
          if (setting.webhook_failures) {
            // Alert delivery failures never generate more alert-delivery-failure events.
            const failed = (
              await client.query(
                `SELECT DISTINCT ON (d.subscription_id) d.subscription_id,d.status
              FROM mr_webhook_deliveries d JOIN mr_events e ON e.id=d.event_id JOIN mr_webhook_subscriptions s ON s.id=d.subscription_id
              WHERE s.enabled=true AND e.workspace_id=$1 AND e.type IN ('generation.completed','billing.settled') AND d.status IN ('delivered','dead')
              ORDER BY d.subscription_id,d.updated_at DESC`,
                [setting.workspace_id],
              )
            ).rows;
            for (const delivery of failed)
              if (delivery.status === 'dead')
                conditions.set(`webhook:${delivery.subscription_id}`, {
                  kind: 'webhook_delivery',
                  subscriptionId: delivery.subscription_id,
                });
          }
        }
        for (const [key, data] of conditions)
          await this.transition(client, setting.workspace_id, key, true, data);
        const previous = (
          await client.query(
            'SELECT alert_key,data FROM mr_alert_state WHERE workspace_id=$1 AND active=true',
            [setting.workspace_id],
          )
        ).rows;
        for (const row of previous)
          if (!conditions.has(row.alert_key))
            await this.transition(client, setting.workspace_id, row.alert_key, false, {
              ...row.data,
              reason: setting.enabled ? 'condition_cleared' : 'alerts_disabled',
            });
      }
    });
  }
}
