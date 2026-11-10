import type { NotificationEmailStore } from './notification-email.js';
import type { Pool, PoolClient } from 'pg';
import type { Principal } from './accounts.js';

export const notificationTypes = ['alert.triggered', 'alert.resolved'] as const;
type NotificationType = (typeof notificationTypes)[number];
export interface NotificationPreferences {
  inApp: boolean;
  email?: boolean;
  eventTypes: NotificationType[];
}
export interface NotificationItem {
  id: string;
  type: NotificationType;
  createdAt: string;
  readAt: string | null;
  data: Record<string, string | number>;
}
const denied = () =>
  Object.assign(new Error('Active workspace membership with read permission is required.'), {
    statusCode: 403,
  });
const invalid = () =>
  Object.assign(new Error('Invalid notification cursor or limit.'), { statusCode: 400 });
const missing = () => Object.assign(new Error('Notification not found.'), { statusCode: 404 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const cursorTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Explicit projection: outbox data may never forward arbitrary prompt/media/token fields. */
export function notificationData(data: Record<string, unknown>): NotificationItem['data'] {
  const safe: NotificationItem['data'] = {};
  for (const name of ['availableMicros', 'thresholdMicros', 'spentMicros'])
    if (Number.isSafeInteger(data[name]) && Number(data[name]) >= 0)
      safe[name] = Number(data[name]);
  for (const name of ['alertKey', 'kind', 'reason', 'window'])
    if (typeof data[name] === 'string' && /^[a-zA-Z0-9_:\-]{1,100}$/.test(data[name]))
      safe[name] = data[name];
  for (const name of ['keyId', 'subscriptionId'])
    if (typeof data[name] === 'string' && uuid.test(data[name])) safe[name] = data[name];
  if (typeof data.expiresAt === 'string' && Number.isFinite(Date.parse(data.expiresAt)))
    safe.expiresAt = new Date(data.expiresAt).toISOString();
  return safe;
}

/** Notifications are a member-specific view of the existing transactional alert outbox. */
export class NotificationStore {
  constructor(
    readonly pool: Pool,
    private readonly email?: NotificationEmailStore,
  ) {}

  private async member<T>(
    actor: Principal,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!actor.membershipId || !actor.scopes.includes('read')) throw denied();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const member = await client.query(
        `SELECT id FROM mr_memberships WHERE id=$1 AND workspace_id=$2
        AND accepted_at IS NOT NULL AND removed_at IS NULL FOR SHARE`,
        [actor.membershipId, actor.workspaceId],
      );
      if (!member.rowCount) throw denied();
      const value = await operation(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async preferences(client: PoolClient, actor: Principal) {
    const { rows } = await client.query(
      'SELECT in_app,event_types FROM mr_notification_preferences WHERE workspace_id=$1 AND membership_id=$2',
      [actor.workspaceId, actor.membershipId],
    );
    return {
      inApp: rows[0]?.in_app ?? true,
      eventTypes: (rows[0]?.event_types ?? [...notificationTypes]) as NotificationType[],
      ...(this.email
        ? await this.email.getEmailOptInInTransaction(client, actor)
        : { email: false, emailAvailable: false }),
    };
  }

  async getPreferences(actor: Principal) {
    return this.member(actor, (client) => this.preferences(client, actor));
  }

  async setPreferences(actor: Principal, input: NotificationPreferences) {
    if (
      (input.email !== undefined && typeof input.email !== 'boolean') ||
      typeof input.inApp !== 'boolean' ||
      !Array.isArray(input.eventTypes) ||
      input.eventTypes.length > 2 ||
      input.eventTypes.some((type) => !notificationTypes.includes(type))
    )
      throw Object.assign(new Error('Invalid notification preferences.'), { statusCode: 400 });
    return this.member(actor, async (client) => {
      await client.query(
        `INSERT INTO mr_notification_preferences(workspace_id,membership_id,in_app,event_types) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,membership_id) DO UPDATE SET in_app=EXCLUDED.in_app,event_types=EXCLUDED.event_types`,
        [
          actor.workspaceId,
          actor.membershipId,
          input.inApp,
          JSON.stringify([...new Set(input.eventTypes)]),
        ],
      );
      if (input.email !== undefined) {
        if (this.email) await this.email.setEmailOptInInTransaction(client, actor, input.email);
        else if (input.email)
          throw Object.assign(
            new Error('Verified email delivery is not available for this member.'),
            { code: 'email_unavailable', statusCode: 409 },
          );
      }
      return this.preferences(client, actor);
    });
  }

  async list(
    actor: Principal,
    input: { limit?: number; cursor?: string; unreadOnly?: boolean } = {},
  ) {
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
    let cursor: { workspaceId: string; createdAt: string; id: string } | null = null;
    if (input.cursor) {
      try {
        if (input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid();
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (
          !cursor ||
          cursor.workspaceId !== actor.workspaceId ||
          !uuid.test(cursor.id) ||
          !cursorTime.test(cursor.createdAt) ||
          !Number.isFinite(Date.parse(cursor.createdAt)) ||
          new Date(cursor.createdAt).toISOString() !== `${cursor.createdAt.slice(0, 23)}Z`
        )
          throw invalid();
      } catch {
        throw invalid();
      }
    }
    return this.member(actor, async (client) => {
      const preferences = await this.preferences(client, actor);
      if (!preferences.inApp || !preferences.eventTypes.length)
        return { items: [] as NotificationItem[], nextCursor: null };
      const { rows } = await client.query(
        `SELECT e.id,e.type,e.created_at,e.data,r.read_at,
        to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
        FROM mr_events e LEFT JOIN mr_notification_reads r ON r.event_id=e.id AND r.workspace_id=e.workspace_id AND r.membership_id=$2
        WHERE e.workspace_id=$1 AND e.type IN ('alert.triggered','alert.resolved') AND e.type=ANY($3::text[])
        AND ($4::timestamptz IS NULL OR (e.created_at,e.id)<($4::timestamptz,$5::uuid))
        AND (NOT $6::boolean OR r.read_at IS NULL)
        ORDER BY e.created_at DESC,e.id DESC LIMIT $7`,
        [
          actor.workspaceId,
          actor.membershipId,
          preferences.eventTypes,
          cursor?.createdAt ?? null,
          cursor?.id ?? null,
          input.unreadOnly ?? false,
          limit + 1,
        ],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row): NotificationItem => ({
          id: row.id,
          type: row.type,
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
          data: notificationData(row.data),
        })),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(
                JSON.stringify({
                  workspaceId: actor.workspaceId,
                  createdAt: last.cursor_created_at,
                  id: last.id,
                }),
              ).toString('base64url')
            : null,
      };
    });
  }

  async markRead(actor: Principal, id: string) {
    if (!uuid.test(id)) throw missing();
    return this.member(actor, async (client) => {
      const result = await client.query(
        `INSERT INTO mr_notification_reads(workspace_id,membership_id,event_id)
        SELECT workspace_id,$2,id FROM mr_events WHERE workspace_id=$1 AND id=$3 AND type IN ('alert.triggered','alert.resolved')
        ON CONFLICT(workspace_id,membership_id,event_id) DO UPDATE SET read_at=mr_notification_reads.read_at
        RETURNING event_id,read_at`,
        [actor.workspaceId, actor.membershipId, id],
      );
      if (!result.rows[0]) throw missing();
      return { id: result.rows[0].event_id, readAt: result.rows[0].read_at.toISOString() };
    });
  }
}
