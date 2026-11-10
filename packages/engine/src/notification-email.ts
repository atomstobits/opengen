import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import type { Principal } from './accounts.js';
import { notificationTypes } from './notifications.js';
import { sendPublicWebhook, isPublicAddress, type WebhookSender } from './public-network.js';

type AlertType = (typeof notificationTypes)[number];
const verifiedClaim = Symbol('verified notification OIDC identity');
export interface VerifiedNotificationEmailIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly [verifiedClaim]: true;
}
const failure = (code: string, statusCode = 400) =>
  Object.assign(
    new Error(
      code === 'email_unavailable'
        ? 'Verified email delivery is not available for this member.'
        : 'The notification email operation could not be completed.',
    ),
    { code, statusCode },
  );
const readable = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
function emailAddress(value: unknown): string | null {
  if (
    !readable(value, 254) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  )
    return null;
  const [local, domain] = value.split('@');
  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !domain?.includes('.') ||
    domain.includes('..')
  )
    return null;
  return `${local}@${domain.toLowerCase()}`;
}
/** Call ONLY after the OIDC/JWT library verified signature, issuer, nonce/audience
 * and the signed claims. Never call with request JSON or unverified profile data. */
export function notificationEmailIdentityFromVerifiedOidcClaims(
  claims: Record<string, unknown>,
): VerifiedNotificationEmailIdentity | null {
  const email = emailAddress(claims.email);
  if (
    claims.email_verified !== true ||
    !email ||
    !readable(claims.iss, 500) ||
    !readable(claims.sub, 500)
  )
    return null;
  try {
    const issuer = new URL(claims.iss);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.hash)
      return null;
  } catch {
    return null;
  }
  return Object.freeze({
    issuer: claims.iss,
    subject: claims.sub,
    email,
    [verifiedClaim]: true as const,
  });
}
export interface NotificationEmailConfiguration {
  /** Fixed operator-owned relay; never a user/member supplied URL. */
  endpoint: string;
  publicUrl: string;
  authToken?: string;
  /** Explicit relay contract: same key+body is deduplicated across unknown outcomes. */
  idempotencyConfirmed?: boolean;
}
function configuration(value: NotificationEmailConfiguration): NotificationEmailConfiguration {
  try {
    if (value.endpoint.length > 2048 || value.publicUrl.length > 2048)
      throw failure('invalid_email_configuration', 503);
    const endpoint = new URL(value.endpoint),
      origin = new URL(value.publicUrl);
    if (
      [endpoint, origin].some(
        (url) =>
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.hash ||
          (url.port && url.port !== '443'),
      ) ||
      endpoint.search ||
      [endpoint, origin].some(
        (url) =>
          url.hostname === 'localhost' ||
          /\.(local|internal|localhost)$/i.test(url.hostname) ||
          (isIP(url.hostname.replace(/^\[|\]$/g, '')) &&
            !isPublicAddress(url.hostname.replace(/^\[|\]$/g, ''))),
      ) ||
      origin.pathname !== '/' ||
      origin.search ||
      (value.authToken !== undefined && !/^[\x21-\x7e]{1,4096}$/.test(value.authToken))
    )
      throw failure('invalid_email_configuration', 503);
    return { ...value, endpoint: endpoint.href, publicUrl: origin.origin };
  } catch {
    throw failure('invalid_email_configuration', 503);
  }
}
/** Absent runtime configuration stays unavailable; no provider or address fallback. */
export function notificationEmailConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): NotificationEmailConfiguration | undefined {
  if (!env.OPENGEN_NOTIFICATION_EMAIL_ENDPOINT) return undefined;
  if (!env.OPENGEN_PUBLIC_URL) throw failure('invalid_email_configuration', 503);
  return configuration({
    endpoint: env.OPENGEN_NOTIFICATION_EMAIL_ENDPOINT,
    publicUrl: env.OPENGEN_PUBLIC_URL,
    authToken: env.OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN || undefined,
    idempotencyConfirmed: env.OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED === '1',
  });
}
export interface NotificationEmailMessage {
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
  appUrl: string;
  eventType: AlertType;
}
export type NotificationEmailTransport = (
  message: Readonly<NotificationEmailMessage>,
) => Promise<{ statusCode: number }>;
/** Reuses DNS pinning, public-only HTTPS, TLS validation, timeout, bounded response
 * and no redirects. The response body is discarded and never persisted. */
export function createNotificationEmailHttpTransport(
  config: NotificationEmailConfiguration,
  send: WebhookSender = sendPublicWebhook,
): NotificationEmailTransport {
  const fixed = configuration(config);
  return (message) => {
    if (
      !/^[a-f0-9-]{36}$/.test(message.deliveryId) ||
      !emailAddress(message.to) ||
      !notificationTypes.includes(message.eventType) ||
      message.appUrl !== new URL('/app#activity', fixed.publicUrl).href
    )
      throw failure('invalid_email_message');
    const closed: NotificationEmailMessage = {
      deliveryId: message.deliveryId,
      to: message.to,
      eventType: message.eventType,
      appUrl: message.appUrl,
      subject:
        message.eventType === 'alert.resolved'
          ? 'OpenGen workspace alert resolved'
          : 'OpenGen workspace alert',
      text:
        message.eventType === 'alert.resolved'
          ? `An OpenGen workspace alert was resolved. Sign in to review your workspace: ${message.appUrl}`
          : `An OpenGen workspace alert needs attention. Sign in to review your workspace: ${message.appUrl}`,
    };
    return send({
      url: fixed.endpoint,
      body: JSON.stringify(closed),
      headers: {
        'Idempotency-Key': closed.deliveryId,
        ...(fixed.authToken ? { Authorization: `Bearer ${fixed.authToken}` } : {}),
      },
    });
  };
}
interface Recipient {
  issuer: string;
  subject: string;
  email: string;
  revision: number;
}
interface Preference {
  email_opt_in: boolean;
  email_opt_in_at: Date | null;
  email_recipient_revision: number | null;
  event_types: AlertType[];
}
interface Delivery {
  id: string;
  workspace_id: string;
  membership_id: string;
  event_id: string;
  recipient_revision: number;
  recipient_email: string;
  event_type: AlertType;
  app_url: string;
  transport_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  lease_token: string | null;
  lease_until: Date | null;
}
export interface NotificationEmailCapability {
  emailAvailable: boolean;
  email: boolean;
  recipientVerified: boolean;
  emailRecipient: string | null;
}
/** Email is an optional delivery view over existing alert events, not another event system. */
export class NotificationEmailStore {
  private readonly config?: NotificationEmailConfiguration;
  private readonly send?: NotificationEmailTransport;
  private readonly transportId: string | null;
  private readonly now: () => Date;
  private readonly databaseConsentClock: boolean;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  constructor(
    readonly pool: Pool,
    options: {
      config?: NotificationEmailConfiguration;
      send?: NotificationEmailTransport;
      now?: () => Date;
      leaseMs?: number;
      maxAttempts?: number;
    } = {},
  ) {
    this.config = options.config ? configuration(options.config) : undefined;
    this.send = this.config
      ? (options.send ?? createNotificationEmailHttpTransport(this.config))
      : undefined;
    this.transportId = this.config
      ? createHash('sha256')
          .update(
            JSON.stringify([
              this.config.endpoint,
              this.config.authToken ?? null,
              this.config.publicUrl,
            ]),
          )
          .digest('hex')
      : null;
    this.now = options.now ?? (() => new Date());
    this.databaseConsentClock = options.now === undefined;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    if (
      !Number.isInteger(this.leaseMs) ||
      this.leaseMs < 1000 ||
      this.leaseMs > 120_000 ||
      !Number.isInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 8
    )
      throw failure('invalid_email_configuration', 503);
  }
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async member(client: PoolClient, actor: Principal) {
    if (!actor.membershipId || !actor.scopes.includes('read'))
      throw failure('notification_member_required', 403);
    const row = (
      await client.query(
        'SELECT issuer,subject FROM mr_memberships WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NOT NULL AND removed_at IS NULL FOR SHARE',
        [actor.workspaceId, actor.membershipId],
      )
    ).rows[0];
    if (!row) throw failure('notification_member_required', 403);
    return row as { issuer: string; subject: string };
  }
  private async preferences(
    client: PoolClient,
    workspaceId: string,
    membershipId: string,
  ): Promise<Preference> {
    await client.query(
      'INSERT INTO mr_notification_preferences(workspace_id,membership_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [workspaceId, membershipId],
    );
    return (
      await client.query<Preference>(
        'SELECT email_opt_in,email_opt_in_at,email_recipient_revision,event_types FROM mr_notification_preferences WHERE workspace_id=$1 AND membership_id=$2 FOR UPDATE',
        [workspaceId, membershipId],
      )
    ).rows[0]!;
  }
  private async recipient(
    client: PoolClient,
    workspaceId: string,
    membershipId: string,
  ): Promise<Recipient | undefined> {
    return (
      await client.query<Recipient>(
        'SELECT issuer,subject,email,revision FROM mr_notification_email_recipients WHERE workspace_id=$1 AND membership_id=$2 FOR UPDATE',
        [workspaceId, membershipId],
      )
    ).rows[0];
  }
  private async cancel(
    client: PoolClient,
    workspaceId: string,
    membershipId: string,
    code: string,
  ) {
    await client.query(
      "UPDATE mr_notification_email_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error_code=$3,updated_at=now() WHERE workspace_id=$1 AND membership_id=$2 AND status IN ('pending','sending','unknown')",
      [workspaceId, membershipId, code],
    );
  }
  /** The branded claim comes only from the verified server authentication path. */
  async recordVerifiedRecipient(
    actor: Principal,
    identity: VerifiedNotificationEmailIdentity,
  ): Promise<void> {
    if (
      identity?.[verifiedClaim] !== true ||
      !actor.identity ||
      actor.identity.issuer !== identity.issuer ||
      actor.identity.subject !== identity.subject
    )
      throw failure('verified_identity_required', 403);
    await this.transaction(async (client) => {
      const member = await this.member(client, actor);
      if (member.issuer !== identity.issuer || member.subject !== identity.subject)
        throw failure('verified_identity_required', 403);
      await this.preferences(client, actor.workspaceId, actor.membershipId!);
      const prior = await this.recipient(client, actor.workspaceId, actor.membershipId!);
      if (
        prior?.email === identity.email &&
        prior.issuer === identity.issuer &&
        prior.subject === identity.subject
      )
        return;
      await client.query(
        `INSERT INTO mr_notification_email_recipients(workspace_id,membership_id,issuer,subject,email,verified_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,membership_id) DO UPDATE SET issuer=EXCLUDED.issuer,subject=EXCLUDED.subject,email=EXCLUDED.email,revision=mr_notification_email_recipients.revision+1,verified_at=EXCLUDED.verified_at`,
        [
          actor.workspaceId,
          actor.membershipId,
          identity.issuer,
          identity.subject,
          identity.email,
          this.now(),
        ],
      );
      await client.query(
        'UPDATE mr_notification_preferences SET email_opt_in=false,email_opt_in_at=NULL,email_recipient_revision=NULL WHERE workspace_id=$1 AND membership_id=$2',
        [actor.workspaceId, actor.membershipId],
      );
      await this.cancel(client, actor.workspaceId, actor.membershipId!, 'recipient_changed');
    });
  }
  /** Trusted fresh email-scoped authentication lost verification or changed to an
   * unverified address. Do not keep sending to a stale previously verified address. */
  async clearVerifiedRecipient(actor: Principal): Promise<void> {
    await this.transaction(async (client) => {
      const member = await this.member(client, actor);
      if (
        !actor.identity ||
        actor.identity.issuer !== member.issuer ||
        actor.identity.subject !== member.subject
      )
        throw failure('verified_identity_required', 403);
      await this.preferences(client, actor.workspaceId, actor.membershipId!);
      await this.recipient(client, actor.workspaceId, actor.membershipId!);
      await client.query(
        'DELETE FROM mr_notification_email_recipients WHERE workspace_id=$1 AND membership_id=$2',
        [actor.workspaceId, actor.membershipId],
      );
      await client.query(
        'UPDATE mr_notification_preferences SET email_opt_in=false,email_opt_in_at=NULL,email_recipient_revision=NULL WHERE workspace_id=$1 AND membership_id=$2',
        [actor.workspaceId, actor.membershipId],
      );
      await this.cancel(client, actor.workspaceId, actor.membershipId!, 'verification_unavailable');
    });
  }
  /** Same-client hooks let NotificationStore merge preferences without a nested pool checkout. */
  async getEmailOptInInTransaction(
    client: PoolClient,
    actor: Principal,
  ): Promise<NotificationEmailCapability> {
    const member = await this.member(client, actor),
      preferences = await this.preferences(client, actor.workspaceId, actor.membershipId!),
      recipient = await this.recipient(client, actor.workspaceId, actor.membershipId!);
    const verified =
      !!recipient && recipient.issuer === member.issuer && recipient.subject === member.subject;
    return {
      emailAvailable: !!this.config && verified,
      email:
        !!this.config &&
        verified &&
        preferences.email_opt_in &&
        preferences.email_recipient_revision === recipient!.revision,
      recipientVerified: verified,
      emailRecipient: verified ? recipient!.email : null,
    };
  }
  async getEmailOptIn(actor: Principal): Promise<NotificationEmailCapability> {
    return this.transaction((client) => this.getEmailOptInInTransaction(client, actor));
  }
  async setEmailOptInInTransaction(
    client: PoolClient,
    actor: Principal,
    enabled: boolean,
  ): Promise<NotificationEmailCapability> {
    if (typeof enabled !== 'boolean') throw failure('invalid_email_preference');
    const member = await this.member(client, actor),
      preferences = await this.preferences(client, actor.workspaceId, actor.membershipId!),
      recipient = await this.recipient(client, actor.workspaceId, actor.membershipId!);
    if (
      enabled &&
      (!this.config ||
        !recipient ||
        recipient.issuer !== member.issuer ||
        recipient.subject !== member.subject)
    )
      throw failure('email_unavailable', 409);
    const unchanged =
      enabled &&
      preferences.email_opt_in &&
      preferences.email_recipient_revision === recipient!.revision;
    await client.query(
      'UPDATE mr_notification_preferences SET email_opt_in=$3,email_opt_in_at=CASE WHEN NOT $3 THEN NULL WHEN $6 THEN email_opt_in_at ELSE COALESCE($4::timestamptz,clock_timestamp()) END,email_recipient_revision=$5 WHERE workspace_id=$1 AND membership_id=$2',
      [
        actor.workspaceId,
        actor.membershipId,
        enabled,
        enabled && !this.databaseConsentClock ? this.now() : null,
        enabled ? recipient!.revision : null,
        unchanged,
      ],
    );
    if (!enabled) await this.cancel(client, actor.workspaceId, actor.membershipId!, 'opted_out');
    return this.getEmailOptInInTransaction(client, actor);
  }
  async setEmailOptIn(actor: Principal, enabled: boolean): Promise<NotificationEmailCapability> {
    return this.transaction((client) => this.setEmailOptInInTransaction(client, actor, enabled));
  }
  /** Fan out committed alert rows only after explicit consent; no historical backfill. */
  async enqueueFromEvents(limit = 50): Promise<number> {
    if (!this.config) return 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('invalid_email_limit');
    const result = await this.pool.query(
      `INSERT INTO mr_notification_email_deliveries(id,workspace_id,membership_id,event_id,recipient_revision,recipient_email,event_type,app_url,transport_id,next_attempt_at)
      SELECT gen_random_uuid(),e.workspace_id,p.membership_id,e.id,r.revision,r.email,e.type,$1,$2,$3 FROM mr_events e
      JOIN mr_notification_preferences p ON p.workspace_id=e.workspace_id AND p.email_opt_in=true
      JOIN mr_notification_email_recipients r ON r.workspace_id=p.workspace_id AND r.membership_id=p.membership_id AND r.revision=p.email_recipient_revision
      JOIN mr_memberships m ON m.workspace_id=p.workspace_id AND m.id=p.membership_id AND m.accepted_at IS NOT NULL AND m.removed_at IS NULL AND m.issuer=r.issuer AND m.subject=r.subject
      WHERE e.type IN ('alert.triggered','alert.resolved') AND p.event_types ? e.type AND e.created_at>=p.email_opt_in_at AND e.created_at<=$3
      AND NOT EXISTS(SELECT 1 FROM mr_notification_email_deliveries d WHERE d.event_id=e.id AND d.membership_id=p.membership_id)
      ORDER BY e.created_at,e.id,p.membership_id LIMIT $4 ON CONFLICT(event_id,membership_id) DO NOTHING RETURNING id`,
      [new URL('/app#activity', this.config.publicUrl).href, this.transportId, this.now(), limit],
    );
    return result.rowCount ?? 0;
  }
  private async validateClaim(client: PoolClient, candidate: Delivery): Promise<boolean> {
    const member = (
      await client.query(
        'SELECT issuer,subject FROM mr_memberships WHERE workspace_id=$1 AND id=$2 AND accepted_at IS NOT NULL AND removed_at IS NULL FOR SHARE',
        [candidate.workspace_id, candidate.membership_id],
      )
    ).rows[0];
    if (!member) return false;
    const preferences = await this.preferences(
        client,
        candidate.workspace_id,
        candidate.membership_id,
      ),
      recipient = await this.recipient(client, candidate.workspace_id, candidate.membership_id);
    return (
      !!recipient &&
      recipient.issuer === member.issuer &&
      recipient.subject === member.subject &&
      recipient.email === candidate.recipient_email &&
      recipient.revision === candidate.recipient_revision &&
      preferences.email_opt_in &&
      preferences.email_recipient_revision === recipient.revision &&
      preferences.event_types.includes(candidate.event_type)
    );
  }
  private async claim(): Promise<Delivery | null> {
    const now = this.now();
    const candidates = (
      await this.pool.query<Delivery>(
        "SELECT * FROM mr_notification_email_deliveries WHERE (status IN ('pending','unknown') AND next_attempt_at<=$1) OR (status='sending' AND lease_until<=$1) ORDER BY created_at,id LIMIT 16",
        [now],
      )
    ).rows;
    for (const candidate of candidates) {
      const result = await this.transaction(async (client) => {
        // Match member/preference/recipient/delivery lock order used by opt-out and recipient changes.
        const allowed = await this.validateClaim(client, candidate);
        const row = (
          await client.query<Delivery>(
            'SELECT * FROM mr_notification_email_deliveries WHERE id=$1 FOR UPDATE SKIP LOCKED',
            [candidate.id],
          )
        ).rows[0];
        if (!row || !['pending', 'unknown', 'sending'].includes(row.status)) return null;
        if (!allowed) {
          await client.query(
            "UPDATE mr_notification_email_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error_code='recipient_not_authorized',updated_at=now() WHERE id=$1",
            [row.id],
          );
          return null;
        }
        if (row.transport_id !== this.transportId) {
          await client.query(
            "UPDATE mr_notification_email_deliveries SET status=CASE WHEN attempts=0 THEN 'cancelled' ELSE 'unknown' END,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='transport_changed',updated_at=now() WHERE id=$1",
            [row.id],
          );
          return null;
        }
        if (row.status === 'sending' && row.lease_until && row.lease_until > now) return null;
        const unknown = row.status === 'unknown' || row.status === 'sending';
        if (unknown && !this.config!.idempotencyConfirmed) {
          await client.query(
            "UPDATE mr_notification_email_deliveries SET status='unknown',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='acceptance_unknown',updated_at=now() WHERE id=$1",
            [row.id],
          );
          return null;
        }
        if (row.attempts >= this.maxAttempts) {
          await client.query(
            "UPDATE mr_notification_email_deliveries SET status=$2,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,last_error_code='retry_exhausted',updated_at=now() WHERE id=$1",
            [row.id, unknown ? 'unknown' : 'failed'],
          );
          return null;
        }
        if (row.status !== 'sending' && (!row.next_attempt_at || row.next_attempt_at > now))
          return null;
        return (
          await client.query<Delivery>(
            "UPDATE mr_notification_email_deliveries SET status='sending',attempts=attempts+1,lease_token=$2,lease_until=$3,next_attempt_at=NULL,updated_at=now() WHERE id=$1 RETURNING *",
            [row.id, randomUUID(), new Date(now.getTime() + this.leaseMs)],
          )
        ).rows[0]!;
      });
      if (result) return result;
    }
    return null;
  }
  async workOnce(): Promise<boolean> {
    if (!this.config || !this.send) return false;
    const enqueued = await this.enqueueFromEvents();
    const row = await this.claim();
    if (!row) return enqueued > 0;
    // Recheck immediately before outbound, outside any long-lived transaction.
    const authorized = await this.transaction(async (client) => {
      if (!(await this.validateClaim(client, row))) return false;
      return !!(
        await client.query(
          "SELECT id FROM mr_notification_email_deliveries WHERE id=$1 AND status='sending' AND lease_token=$2 FOR SHARE",
          [row.id, row.lease_token],
        )
      ).rowCount;
    });
    if (!authorized) {
      await this.pool.query(
        "UPDATE mr_notification_email_deliveries SET status='cancelled',lease_token=NULL,lease_until=NULL,last_error_code='recipient_not_authorized',updated_at=now() WHERE id=$1 AND status='sending' AND lease_token=$2",
        [row.id, row.lease_token],
      );
      return true;
    }
    const message: NotificationEmailMessage = {
      deliveryId: row.id,
      to: row.recipient_email,
      eventType: row.event_type,
      appUrl: row.app_url,
      subject:
        row.event_type === 'alert.resolved'
          ? 'OpenGen workspace alert resolved'
          : 'OpenGen workspace alert',
      text:
        row.event_type === 'alert.resolved'
          ? `An OpenGen workspace alert was resolved. Sign in to review your workspace: ${row.app_url}`
          : `An OpenGen workspace alert needs attention. Sign in to review your workspace: ${row.app_url}`,
    };
    let statusCode = 0;
    try {
      const response = await this.send(Object.freeze(message));
      if (
        Number.isInteger(response.statusCode) &&
        response.statusCode >= 100 &&
        response.statusCode <= 599
      )
        statusCode = response.statusCode;
    } catch {
      /* Unknown acceptance; never persist raw transport error/body. */
    }
    const accepted = statusCode >= 200 && statusCode < 300;
    const rejected = statusCode >= 300 && statusCode < 500 && statusCode !== 408;
    const retryableRejection = statusCode === 429;
    const unknown = !accepted && !rejected;
    const retry =
      (unknown ? this.config.idempotencyConfirmed : retryableRejection) &&
      row.attempts < this.maxAttempts;
    const status = accepted ? 'sent' : unknown ? 'unknown' : retry ? 'pending' : 'failed';
    const backoff = [30_000, 120_000, 600_000, 3_600_000, 21_600_000][
      Math.min(row.attempts - 1, 4)
    ]!;
    await this.pool.query(
      `UPDATE mr_notification_email_deliveries SET status=$3,next_attempt_at=$4,lease_token=NULL,lease_until=NULL,last_error_code=$5,accepted_at=CASE WHEN $3='sent' THEN $6::timestamptz ELSE NULL END,updated_at=now()
      WHERE id=$1 AND status='sending' AND lease_token=$2`,
      [
        row.id,
        row.lease_token,
        status,
        retry ? new Date(this.now().getTime() + backoff) : null,
        accepted
          ? null
          : unknown
            ? 'acceptance_unknown'
            : retry
              ? 'relay_rate_limited'
              : 'relay_rejected',
        this.now(),
      ],
    );
    return true;
  }
}
