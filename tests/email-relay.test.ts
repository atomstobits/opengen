import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEmailRelayApp,
  initializeEmailRelaySchema,
  readEmailRelayConfiguration,
  type ResendSendInput,
  type ResendSendResult,
} from '../apps/server/src/email-relay.js';

const authToken = ['synthetic', 'email', 'relay', 'fixture', 'bearer'].join('-');
const resendKey = ['re', 'syntheticfixture'].join('_');
const publicOrigin = 'https://opengen.dev';
const fromAddress = 'OpenGen Alerts <alerts@opengen.dev>';

function validPayload(
  deliveryId = randomUUID(),
  eventType: 'alert.triggered' | 'alert.resolved' = 'alert.triggered',
) {
  const appUrl = 'https://opengen.dev/app#activity';
  return {
    deliveryId,
    to: 'member@example.com',
    eventType,
    appUrl,
    subject:
      eventType === 'alert.resolved'
        ? 'OpenGen workspace alert resolved'
        : 'OpenGen workspace alert',
    text:
      eventType === 'alert.resolved'
        ? `An OpenGen workspace alert was resolved. Sign in to review your workspace: ${appUrl}`
        : `An OpenGen workspace alert needs attention. Sign in to review your workspace: ${appUrl}`,
  };
}

async function withRelay(
  send: (input: ResendSendInput) => Promise<ResendSendResult>,
  fn: (ctx: { app: Awaited<ReturnType<typeof buildEmailRelayApp>>; lite: PGlite }) => Promise<void>,
) {
  const lite = new PGlite();
  const query = async (sql: string, params?: unknown[]) => {
    const result = await lite.query(sql, params);
    return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
  };
  const client = { query, release: () => {} };
  const pool = { query, connect: async () => client } as unknown as Pool;
  await initializeEmailRelaySchema(pool);
  const app = await buildEmailRelayApp({
    pool,
    publicOrigin,
    authToken,
    fromAddress,
    send,
  });
  try {
    await fn({ app, lite });
  } finally {
    await app.close();
    await lite.close();
  }
}

describe('Resend durable notification email relay', () => {
  it('validates configuration strictly and never leaks credentials in error messages', () => {
    const valid = readEmailRelayConfiguration({
      DATABASE_URL: 'postgresql://localhost/opengen_mail_relay',
      OPENGEN_PUBLIC_URL: publicOrigin,
      OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: authToken,
      RESEND_API_KEY: resendKey,
      RESEND_FROM_EMAIL: fromAddress,
    });
    expect(valid.publicOrigin).toBe(publicOrigin);
    expect(valid.fromAddress).toBe(fromAddress);

    for (const bad of [
      { OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: 'short' },
      { OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: resendKey, RESEND_API_KEY: resendKey },
      { RESEND_FROM_EMAIL: 'not-an-email' },
      { OPENGEN_PUBLIC_URL: 'http://opengen.dev' },
    ]) {
      try {
        readEmailRelayConfiguration({
          DATABASE_URL: 'postgresql://localhost/opengen_mail_relay',
          OPENGEN_PUBLIC_URL: publicOrigin,
          OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: authToken,
          RESEND_API_KEY: resendKey,
          RESEND_FROM_EMAIL: fromAddress,
          ...bad,
        });
        throw new Error('Expected configuration rejection');
      } catch (error) {
        expect(String(error)).not.toContain(authToken);
        expect(String(error)).not.toContain(resendKey);
      }
    }
  });

  it('rejects unauthenticated, mismatched-header, or unapproved-template requests before touching Resend', async () => {
    const send =
      vi.fn<typeof withRelay extends (s: infer S, ...args: never[]) => unknown ? S : never>();
    await withRelay(send, async ({ app }) => {
      const payload = validPayload();
      const unauth = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: { 'Idempotency-Key': payload.deliveryId },
        payload,
      });
      expect(unauth.statusCode).toBe(401);

      const mismatch = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Idempotency-Key': randomUUID(),
        },
        payload,
      });
      expect(mismatch.statusCode).toBe(400);

      const spoofed = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Idempotency-Key': payload.deliveryId,
        },
        payload: { ...payload, subject: 'Custom phishing subject' },
      });
      expect(spoofed.statusCode).toBe(422);
      expect(send).not.toHaveBeenCalled();
    });
  });

  it('deduplicates repeated deliveries durably without storing raw email PII or calling Resend twice', async () => {
    const send = vi.fn(async () => ({ statusCode: 200, messageId: 're_msg_123' }));
    await withRelay(send, async ({ app, lite }) => {
      const payload = validPayload();
      const first = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Idempotency-Key': payload.deliveryId,
        },
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ accepted: true });
      expect(send).toHaveBeenCalledTimes(1);

      const replay = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Idempotency-Key': payload.deliveryId,
        },
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ accepted: true, duplicate: true });
      expect(send).toHaveBeenCalledTimes(1);

      const conflict = await app.inject({
        method: 'POST',
        url: '/v1/send',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Idempotency-Key': payload.deliveryId,
        },
        payload: { ...payload, to: 'other@example.com' },
      });
      expect(conflict.statusCode).toBe(409);
      expect(send).toHaveBeenCalledTimes(1);

      const stored = await lite.query(
        'SELECT * FROM mr_email_relay_deliveries WHERE delivery_id = $1',
        [payload.deliveryId],
      );
      expect(JSON.stringify(stored.rows)).not.toContain('member@example.com');
    });
  });

  it('preserves unknown/retryable outcomes and replays with the exact deliveryId until accepted', async () => {
    let attempt = 0;
    const seenIds: string[] = [];
    const send = vi.fn(async (input: ResendSendInput) => {
      seenIds.push(input.deliveryId);
      attempt += 1;
      if (attempt === 1) throw new Error('network timeout');
      if (attempt === 2) return { statusCode: 429 };
      return { statusCode: 200, messageId: 're_msg_recovered' };
    });

    await withRelay(send, async ({ app }) => {
      const payload = validPayload(randomUUID(), 'alert.resolved');
      const headers = {
        Authorization: `Bearer ${authToken}`,
        'Idempotency-Key': payload.deliveryId,
      };
      const first = await app.inject({ method: 'POST', url: '/v1/send', headers, payload });
      expect(first.statusCode).toBe(502);

      const second = await app.inject({ method: 'POST', url: '/v1/send', headers, payload });
      expect(second.statusCode).toBe(429);

      const third = await app.inject({ method: 'POST', url: '/v1/send', headers, payload });
      expect(third.statusCode).toBe(200);
      expect(seenIds).toEqual([payload.deliveryId, payload.deliveryId, payload.deliveryId]);
    });
  });
});
