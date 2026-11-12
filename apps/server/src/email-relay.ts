import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const validEmail = (value: string): boolean => {
  if (
    value.length === 0 ||
    value.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  )
    return false;
  const [local, domain] = value.split('@');
  return Boolean(
    local &&
    local.length <= 64 &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    domain?.includes('.') &&
    !domain.includes('..'),
  );
};

const validFromHeader = (value: string): boolean => {
  if (value.length === 0 || value.length > 320 || /[\u0000-\u001f\u007f\r\n]/.test(value))
    return false;
  const bracket = value.match(/^([^<>]{1,120})<([^<>]+)>$/);
  if (bracket) return validEmail(bracket[2]!.trim());
  return validEmail(value.trim());
};

export interface EmailRelayConfiguration {
  databaseUrl: string;
  publicOrigin: string;
  authToken: string;
  resendApiKey: string;
  fromAddress: string;
  resendEndpoint: string;
}

export function readEmailRelayConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): EmailRelayConfiguration {
  const databaseUrl = env.DATABASE_URL ?? '';
  const publicUrl = env.OPENGEN_PUBLIC_URL ?? '';
  const authToken = env.OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN ?? '';
  const resendApiKey = env.RESEND_API_KEY ?? '';
  const fromAddress = (env.RESEND_FROM_EMAIL ?? '').trim();
  const resendEndpoint = env.RESEND_API_ENDPOINT ?? 'https://api.resend.com/emails';

  if (
    !databaseUrl ||
    !publicUrl ||
    authToken.length < 32 ||
    authToken.length > 512 ||
    !/^[\x21-\x7e]+$/.test(authToken) ||
    resendApiKey.length < 16 ||
    resendApiKey.length > 512 ||
    !/^[\x21-\x7e]+$/.test(resendApiKey) ||
    authToken === resendApiKey ||
    !validFromHeader(fromAddress)
  ) {
    throw new Error(
      'Complete the reviewed notification email relay configuration with distinct credentials.',
    );
  }

  let db: URL;
  let origin: URL;
  let upstream: URL;
  try {
    db = new URL(databaseUrl);
    origin = new URL(publicUrl);
    upstream = new URL(resendEndpoint);
  } catch {
    throw new Error('Use valid PostgreSQL and HTTPS URLs for the notification email relay.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(db.protocol) ||
    origin.protocol !== 'https:' ||
    origin.pathname !== '/' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    upstream.protocol !== 'https:' ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash
  ) {
    throw new Error('Notification email relay requires canonical HTTPS origins and PostgreSQL.');
  }

  return {
    databaseUrl,
    publicOrigin: origin.origin,
    authToken,
    resendApiKey,
    fromAddress,
    resendEndpoint: upstream.href,
  };
}

export async function initializeEmailRelaySchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mr_email_relay_deliveries (
      delivery_id TEXT PRIMARY KEY,
      payload_sha256 TEXT NOT NULL,
      recipient_sha256 TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN ('alert.triggered', 'alert.resolved')),
      status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'rejected', 'retryable', 'unknown')),
      lease_until TIMESTAMPTZ,
      provider_message_id TEXT,
      last_status_code INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

export interface ResendSendInput {
  deliveryId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface ResendSendResult {
  statusCode: number;
  messageId?: string | null;
}

export type ResendTransport = (input: ResendSendInput) => Promise<ResendSendResult>;

export function createResendHttpTransport(options: {
  apiKey: string;
  endpoint?: string;
  timeoutMs?: number;
}): ResendTransport {
  const endpoint = options.endpoint ?? 'https://api.resend.com/emails';
  const timeoutMs = options.timeoutMs ?? 8_000;
  return async (input) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.deliveryId,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    let messageId: string | null = null;
    if (response.status >= 200 && response.status < 300) {
      try {
        const parsed = (await response.json()) as { id?: unknown };
        if (typeof parsed?.id === 'string' && parsed.id.length <= 200) messageId = parsed.id;
      } catch {
        /* Accepted 2xx without JSON id still counts as accepted by upstream. */
      }
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }
    return { statusCode: response.status, messageId };
  };
}

const deliverySchema = z
  .object({
    deliveryId: z.string().regex(/^[a-f0-9-]{36}$/),
    to: z.string().min(3).max(254),
    eventType: z.enum(['alert.triggered', 'alert.resolved']),
    appUrl: z.string().min(1).max(2048),
    subject: z.string().min(1).max(200),
    text: z.string().min(1).max(2000),
  })
  .strict();

interface RelayRow {
  delivery_id: string;
  payload_sha256: string;
  status: 'sending' | 'sent' | 'rejected' | 'retryable' | 'unknown';
  lease_until: Date | null;
}

export async function buildEmailRelayApp(options: {
  pool: Pool;
  publicOrigin: string;
  authToken: string;
  fromAddress: string;
  send: ResendTransport;
  leaseSeconds?: number;
  maxRequestsPerMinute?: number;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 16_384 });
  const expectedToken = Buffer.from(options.authToken);
  const expectedAppUrl = new URL('/app#activity', options.publicOrigin).href;
  const leaseSeconds = options.leaseSeconds ?? 30;
  const maxRequestsPerMinute = options.maxRequestsPerMinute ?? 120;

  let windowStart = Date.now();
  let windowCount = 0;
  const allowRequest = (): boolean => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= maxRequestsPerMinute;
  };

  app.get('/health', async (_request, reply) => {
    await options.pool.query('SELECT 1');
    return reply
      .header('Cache-Control', 'no-store')
      .send({ status: 'ok', database: true, version: '0.1.1' });
  });

  app.post('/v1/send', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (!allowRequest()) {
      return reply.code(429).send({ error: { code: 'rate_limited' } });
    }

    const authHeader = request.headers.authorization;
    const bearer =
      typeof authHeader === 'string' ? authHeader.match(/^Bearer +([^\s]+)$/i)?.[1] : undefined;
    const presented = bearer ? Buffer.from(bearer) : null;
    if (
      !presented ||
      presented.length !== expectedToken.length ||
      !timingSafeEqual(presented, expectedToken)
    ) {
      return reply.code(401).send({ error: { code: 'unauthorized' } });
    }

    const parsed = deliverySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_payload' } });
    }
    const body = parsed.data;
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey !== body.deliveryId) {
      return reply.code(400).send({ error: { code: 'idempotency_key_mismatch' } });
    }
    if (!validEmail(body.to) || body.appUrl !== expectedAppUrl) {
      return reply.code(422).send({ error: { code: 'invalid_recipient_or_origin' } });
    }

    const expectedSubject =
      body.eventType === 'alert.resolved'
        ? 'OpenGen workspace alert resolved'
        : 'OpenGen workspace alert';
    const expectedText =
      body.eventType === 'alert.resolved'
        ? `An OpenGen workspace alert was resolved. Sign in to review your workspace: ${expectedAppUrl}`
        : `An OpenGen workspace alert needs attention. Sign in to review your workspace: ${expectedAppUrl}`;
    if (body.subject !== expectedSubject || body.text !== expectedText) {
      return reply.code(422).send({ error: { code: 'unapproved_template' } });
    }

    const recipientNormalized = body.to.toLowerCase();
    const payloadDigest = sha256(
      JSON.stringify([
        body.deliveryId,
        recipientNormalized,
        body.eventType,
        body.appUrl,
        body.subject,
        body.text,
      ]),
    );
    const recipientDigest = sha256(recipientNormalized);

    const claimClient = await options.pool.connect();
    try {
      await claimClient.query('BEGIN');
      const inserted = await claimClient.query<RelayRow>(
        `INSERT INTO mr_email_relay_deliveries (
           delivery_id, payload_sha256, recipient_sha256, event_type, status, lease_until, attempts
         ) VALUES ($1, $2, $3, $4, 'sending', now() + ($5 * interval '1 second'), 1)
         ON CONFLICT (delivery_id) DO NOTHING
         RETURNING delivery_id, payload_sha256, status, lease_until`,
        [body.deliveryId, payloadDigest, recipientDigest, body.eventType, leaseSeconds],
      );
      if (inserted.rowCount === 0) {
        const existing = (
          await claimClient.query<RelayRow>(
            `SELECT delivery_id, payload_sha256, status, lease_until,
                    (lease_until IS NOT NULL AND lease_until > now()) AS lease_active
             FROM mr_email_relay_deliveries
             WHERE delivery_id = $1
             FOR UPDATE`,
            [body.deliveryId],
          )
        ).rows[0] as (RelayRow & { lease_active: boolean }) | undefined;
        if (!existing) {
          await claimClient.query('ROLLBACK');
          return reply.code(503).send({ error: { code: 'claim_unavailable' } });
        }
        if (existing.payload_sha256 !== payloadDigest) {
          await claimClient.query('COMMIT');
          return reply.code(409).send({ error: { code: 'idempotency_conflict' } });
        }
        if (existing.status === 'sent') {
          await claimClient.query('COMMIT');
          return reply.code(200).send({ accepted: true, duplicate: true });
        }
        if (existing.status === 'rejected') {
          await claimClient.query('COMMIT');
          return reply.code(422).send({ error: { code: 'permanently_rejected' } });
        }
        if (existing.status === 'sending' && existing.lease_active) {
          await claimClient.query('COMMIT');
          return reply.code(429).send({ error: { code: 'delivery_in_progress' } });
        }
        await claimClient.query(
          `UPDATE mr_email_relay_deliveries
           SET status = 'sending',
               lease_until = now() + ($2 * interval '1 second'),
               attempts = attempts + 1,
               updated_at = now()
           WHERE delivery_id = $1`,
          [body.deliveryId, leaseSeconds],
        );
      }
      await claimClient.query('COMMIT');
    } catch (error) {
      await claimClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      claimClient.release();
    }

    let upstream: ResendSendResult;
    try {
      upstream = await options.send({
        deliveryId: body.deliveryId,
        from: options.fromAddress,
        to: body.to,
        subject: body.subject,
        text: body.text,
      });
    } catch {
      await options.pool.query(
        `UPDATE mr_email_relay_deliveries
         SET status = 'unknown', lease_until = NULL, last_status_code = NULL, updated_at = now()
         WHERE delivery_id = $1 AND status = 'sending'`,
        [body.deliveryId],
      );
      return reply.code(502).send({ error: { code: 'upstream_unknown' } });
    }

    if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
      await options.pool.query(
        `UPDATE mr_email_relay_deliveries
         SET status = 'sent',
             lease_until = NULL,
             provider_message_id = COALESCE($2, provider_message_id),
             last_status_code = $3,
             updated_at = now()
         WHERE delivery_id = $1`,
        [body.deliveryId, upstream.messageId ?? null, upstream.statusCode],
      );
      return reply.code(200).send({ accepted: true });
    }

    if (upstream.statusCode === 429) {
      await options.pool.query(
        `UPDATE mr_email_relay_deliveries
         SET status = 'retryable', lease_until = NULL, last_status_code = 429, updated_at = now()
         WHERE delivery_id = $1 AND status != 'sent'`,
        [body.deliveryId],
      );
      return reply.code(429).send({ error: { code: 'upstream_rate_limited' } });
    }

    if (upstream.statusCode >= 400 && upstream.statusCode < 500) {
      await options.pool.query(
        `UPDATE mr_email_relay_deliveries
         SET status = 'rejected', lease_until = NULL, last_status_code = $2, updated_at = now()
         WHERE delivery_id = $1 AND status != 'sent'`,
        [body.deliveryId, upstream.statusCode],
      );
      return reply.code(422).send({ error: { code: 'upstream_rejected' } });
    }

    await options.pool.query(
      `UPDATE mr_email_relay_deliveries
       SET status = 'unknown', lease_until = NULL, last_status_code = $2, updated_at = now()
       WHERE delivery_id = $1 AND status != 'sent'`,
      [body.deliveryId, upstream.statusCode],
    );
    return reply.code(502).send({ error: { code: 'upstream_unknown' } });
  });

  return app;
}
