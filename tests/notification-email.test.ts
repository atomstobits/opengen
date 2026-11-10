import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { Principal } from '@media-router/engine';
import { isolatedEngineDatabase } from './helpers/isolated-engine';
import {
  NotificationEmailStore,
  notificationEmailConfiguration,
  notificationEmailIdentityFromVerifiedOidcClaims,
  createNotificationEmailHttpTransport,
  type NotificationEmailMessage,
  type NotificationEmailConfiguration,
  type VerifiedNotificationEmailIdentity,
} from '../packages/engine/src/notification-email.js';

const native = process.env.TEST_NATIVE_POSTGRES === '1' && !!process.env.TEST_DATABASE_URL;
const config: NotificationEmailConfiguration = {
  endpoint: 'https://email-relay.fixture.invalid/notifications',
  publicUrl: 'https://opengen.fixture.invalid',
  authToken: 'synthetic-relay-auth',
  idempotencyConfirmed: true,
};
const issuer = 'https://identity.fixture.invalid';
async function fixture(
  fn: (value: {
    pool: Pool;
    actor: Principal;
    clock: () => Date;
    advance: (ms?: number) => void;
    store: (
      send: (message: Readonly<NotificationEmailMessage>) => Promise<{ statusCode: number }>,
      configuration?: NotificationEmailConfiguration,
    ) => NotificationEmailStore;
    verify: (store: NotificationEmailStore, email?: string) => Promise<void>;
    event: (type?: 'alert.triggered' | 'alert.resolved', offset?: number) => Promise<string>;
  }) => Promise<void>,
) {
  const isolated = native
    ? await isolatedEngineDatabase(process.env.TEST_DATABASE_URL!, 'notification_email')
    : null;
  const pg = native ? new Pool({ connectionString: isolated!.databaseUrl, max: 4 }) : null;
  const lite = native ? null : new PGlite();
  const query = pg
    ? pg.query.bind(pg)
    : async (sql: string, params?: unknown[]) => {
        const result = await lite!.query(sql, params);
        return { ...result, rowCount: result.rows.length || result.affectedRows || 0 };
      };
  const exec = pg ? (sql: string) => pg.query(sql) : (sql: string) => lite!.exec(sql);
  const client = { query, release: () => {} };
  const pool = pg ?? ({ query, connect: async () => client } as unknown as Pool);
  let time = Date.now() + 1000;
  const clock = () => new Date(time);
  const advance = (ms = 1) => {
    time += ms;
  };
  try {
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
    await exec(
      await readFile(
        new URL('../packages/engine/schema-proposals/notification-email.sql', import.meta.url),
        'utf8',
      ),
    );
    if (isolated)
      expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(
        isolated.schema,
      );
    const workspaceId = `email-${randomUUID()}`,
      membershipId = randomUUID(),
      subject = `subject-${randomUUID()}`;
    await pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [workspaceId]);
    await pool.query(
      "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,$3,$4,'member',now())",
      [membershipId, workspaceId, issuer, subject],
    );
    const actor: Principal = {
      workspaceId,
      membershipId,
      scopes: ['read'],
      identity: { issuer, subject },
      role: 'member',
      keyKind: 'browser',
    };
    const store = (
      send: (message: Readonly<NotificationEmailMessage>) => Promise<{ statusCode: number }>,
      configuration: NotificationEmailConfiguration | undefined = config,
    ) =>
      new NotificationEmailStore(pool, {
        config: configuration,
        send,
        now: clock,
        leaseMs: 1000,
        maxAttempts: 3,
      });
    const verify = async (value: NotificationEmailStore, email = 'owner@example.test') => {
      await value.recordVerifiedRecipient(
        actor,
        notificationEmailIdentityFromVerifiedOidcClaims({
          iss: issuer,
          sub: subject,
          email,
          email_verified: true,
        })!,
      );
    };
    const event = async (
      type: 'alert.triggered' | 'alert.resolved' = 'alert.triggered',
      offset = 0,
    ) => {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO mr_events(id,workspace_id,type,dedupe_key,data,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          id,
          workspaceId,
          type,
          randomUUID(),
          JSON.stringify({
            prompt: 'NEVER INCLUDE PRIVATE PROMPT',
            token: 'NEVER INCLUDE PRIVATE TOKEN',
            outputs: [{ url: 'https://private.invalid/media' }],
            kind: 'low_balance',
            availableMicros: 123,
            keyId: randomUUID(),
          }),
          new Date(time + offset),
        ],
      );
      return id;
    };
    await fn({ pool, actor, clock, advance, store, verify, event });
  } finally {
    if (pg) await pg.end();
    if (lite) await lite.close();
    await isolated?.close();
  }
}
async function rows(pool: Pool) {
  return (await pool.query('SELECT * FROM mr_notification_email_deliveries ORDER BY created_at,id'))
    .rows;
}

describe('optional configured member email notifications', () => {
  it('requires signed true email verification, active identity binding and explicit configuration', async () => {
    expect(notificationEmailConfiguration({} as NodeJS.ProcessEnv)).toBeUndefined();
    for (const bad of [
      { email_verified: false },
      { email_verified: 'true' },
      { email: 'bad\r\naddress@example.test' },
      { iss: 'http://identity.fixture.invalid' },
    ])
      expect(
        notificationEmailIdentityFromVerifiedOidcClaims({
          iss: issuer,
          sub: 'owner',
          email: 'owner@example.test',
          email_verified: true,
          ...bad,
        }),
      ).toBeNull();
    for (const endpoint of [
      'http://relay.example.test',
      'https://127.0.0.1/send',
      'https://user:secret@relay.example.test/send',
      'https://relay.example.test/send?token=secret',
    ])
      expect(() =>
        notificationEmailConfiguration({
          OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
          OPENGEN_PUBLIC_URL: config.publicUrl,
        } as NodeJS.ProcessEnv),
      ).toThrow();
    await fixture(async ({ pool, actor, verify }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 });
      const disabled = new NotificationEmailStore(pool, { send });
      expect(await disabled.getEmailOptIn(actor)).toMatchObject({
        emailAvailable: false,
        email: false,
        recipientVerified: false,
        emailRecipient: null,
      });
      await expect(disabled.setEmailOptIn(actor, true)).rejects.toMatchObject({
        code: 'email_unavailable',
      });
      await expect(
        disabled.recordVerifiedRecipient(actor, {
          issuer,
          subject: actor.identity!.subject,
          email: 'owner@example.test',
          email_verified: true,
        } as unknown as VerifiedNotificationEmailIdentity),
      ).rejects.toMatchObject({ code: 'verified_identity_required' });
      await expect(
        disabled.recordVerifiedRecipient(
          actor,
          notificationEmailIdentityFromVerifiedOidcClaims({
            iss: issuer,
            sub: 'someone-else',
            email: 'other@example.test',
            email_verified: true,
          })!,
        ),
      ).rejects.toMatchObject({ code: 'verified_identity_required' });
      await verify(disabled);
      expect(await disabled.getEmailOptIn(actor)).toMatchObject({
        emailAvailable: false,
        email: false,
        recipientVerified: true,
        emailRecipient: 'owner@example.test',
      });
      await expect(disabled.setEmailOptIn(actor, true)).rejects.toMatchObject({
        code: 'email_unavailable',
      });
      expect(await disabled.workOnce()).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(await rows(pool)).toEqual([]);
    });
  }, 60_000);

  it('records production consent after the database lock using the same database clock as alert events', async () => {
    await fixture(async ({ pool, actor, verify }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 });
      const email = new NotificationEmailStore(pool, { config, send });
      await verify(email);
      const before = (await pool.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
      await email.setEmailOptIn(actor, true);
      const optedIn = (
        await pool.query(
          'SELECT email_opt_in_at FROM mr_notification_preferences WHERE workspace_id=$1 AND membership_id=$2',
          [actor.workspaceId, actor.membershipId],
        )
      ).rows[0].email_opt_in_at as Date;
      const after = (await pool.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
      expect(optedIn.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(optedIn.getTime()).toBeLessThanOrEqual(after.getTime());
      const precision = (
        await pool.query(
          'SELECT email_opt_in_at::text AS at FROM mr_notification_preferences WHERE workspace_id=$1 AND membership_id=$2',
          [actor.workspaceId, actor.membershipId],
        )
      ).rows[0].at;
      await email.setEmailOptIn(actor, true);
      expect(
        (
          await pool.query(
            'SELECT email_opt_in_at::text AS at FROM mr_notification_preferences WHERE workspace_id=$1 AND membership_id=$2',
            [actor.workspaceId, actor.membershipId],
          )
        ).rows[0].at,
      ).toBe(precision);
      expect(send).not.toHaveBeenCalled();
    });
  }, 60_000);

  it('uses existing post-consent alert events once and sends only the closed operational template', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await event('alert.triggered', -1000);
      expect(await email.getEmailOptIn(actor)).toMatchObject({
        emailAvailable: true,
        email: false,
      });
      await email.setEmailOptIn(actor, true);
      advance();
      const eventId = await event();
      expect(await email.enqueueFromEvents()).toBe(1);
      expect(await email.enqueueFromEvents()).toBe(0);
      await email.workOnce();
      expect(send).toHaveBeenCalledTimes(1);
      const message = send.mock.calls[0]![0] as NotificationEmailMessage;
      expect(Object.keys(message).sort()).toEqual([
        'appUrl',
        'deliveryId',
        'eventType',
        'subject',
        'text',
        'to',
      ]);
      expect(message).toMatchObject({
        to: 'owner@example.test',
        eventType: 'alert.triggered',
        appUrl: 'https://opengen.fixture.invalid/app#activity',
        subject: 'OpenGen workspace alert',
      });
      expect(JSON.stringify(message)).not.toMatch(
        /PRIVATE|private\.invalid|availableMicros|keyId|token|prompt/,
      );
      expect(await rows(pool)).toMatchObject([
        { id: message.deliveryId, event_id: eventId, status: 'sent', attempts: 1 },
      ]);
      expect(await email.workOnce()).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('deduplicates each event per opted-in member without sharing recipients or preference state', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      const membershipId = randomUUID(),
        subject = 'second-' + randomUUID();
      await pool.query(
        "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,$3,$4,'member',now())",
        [membershipId, actor.workspaceId, issuer, subject],
      );
      const other: Principal = { ...actor, membershipId, identity: { issuer, subject } };
      await email.recordVerifiedRecipient(
        other,
        notificationEmailIdentityFromVerifiedOidcClaims({
          iss: issuer,
          sub: subject,
          email: 'second@example.test',
          email_verified: true,
        })!,
      );
      expect(await email.getEmailOptIn(other)).toMatchObject({
        email: false,
        emailRecipient: 'second@example.test',
      });
      await email.setEmailOptIn(other, true);
      advance();
      const eventId = await event();
      expect(await email.enqueueFromEvents()).toBe(2);
      expect(await email.enqueueFromEvents()).toBe(0);
      await email.workOnce();
      await email.workOnce();
      expect(
        send.mock.calls.map((call) => (call[0] as NotificationEmailMessage).to).sort(),
      ).toEqual(['owner@example.test', 'second@example.test']);
      expect((await rows(pool)).map((row) => row.event_id)).toEqual([eventId, eventId]);
      await email.setEmailOptIn(other, false);
      expect(await email.getEmailOptIn(actor)).toMatchObject({
        email: true,
        emailRecipient: 'owner@example.test',
      });
    });
  }, 60_000);

  it('retries a rejected relay response with the same delivery ID and exact body', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi
          .fn()
          .mockResolvedValueOnce({ statusCode: 429 })
          .mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.workOnce();
      expect(await rows(pool)).toMatchObject([
        { status: 'pending', attempts: 1, last_error_code: 'relay_rate_limited' },
      ]);
      expect(await email.workOnce()).toBe(false);
      advance(30_001);
      await email.workOnce();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toEqual(send.mock.calls[0]![0]);
      expect(await rows(pool)).toMatchObject([{ status: 'sent', attempts: 2 }]);
    });
  }, 60_000);

  it('retains unknown acceptance without blind retry when relay idempotency is unconfirmed', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockRejectedValue(new Error('NEVER PERSIST TRANSPORT SECRET'));
      const email = store(send, { ...config, idempotencyConfirmed: false });
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.workOnce();
      expect(await rows(pool)).toMatchObject([
        {
          status: 'unknown',
          next_attempt_at: null,
          last_error_code: 'acceptance_unknown',
          attempts: 1,
        },
      ]);
      advance(86_400_000);
      expect(await email.workOnce()).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(await rows(pool))).not.toContain('TRANSPORT SECRET');
    });
  }, 60_000);

  it('retries unknown outcomes only under the confirmed deduplication contract and never changes their body', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const accepted = new Set<string>();
      let physicalEmails = 0;
      const send = vi.fn(async (message: Readonly<NotificationEmailMessage>) => {
        if (!accepted.has(message.deliveryId)) {
          accepted.add(message.deliveryId);
          physicalEmails++;
          throw new Error('Response lost after synthetic relay acceptance.');
        }
        return { statusCode: 202 };
      });
      const email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.workOnce();
      expect(await rows(pool)).toMatchObject([{ status: 'unknown', attempts: 1 }]);
      advance(30_001);
      await email.workOnce();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
      expect(physicalEmails).toBe(1);
      expect(await rows(pool)).toMatchObject([{ status: 'sent', attempts: 2 }]);
    });
  }, 60_000);

  it('cancels queued work on opt-out, recipient change and membership removal without rerouting old events', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.enqueueFromEvents();
      await email.setEmailOptIn(actor, false);
      await email.workOnce();
      expect(await rows(pool)).toMatchObject([
        { status: 'cancelled', last_error_code: 'opted_out' },
      ]);
      expect(send).not.toHaveBeenCalled();
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.enqueueFromEvents();
      await verify(email, 'new-owner@example.test');
      expect(await email.getEmailOptIn(actor)).toMatchObject({
        email: false,
        emailRecipient: 'new-owner@example.test',
      });
      expect((await rows(pool)).every((row) => row.status === 'cancelled')).toBe(true);
      await email.setEmailOptIn(actor, true);
      advance();
      await event('alert.resolved');
      await email.enqueueFromEvents();
      await expect(email.getEmailOptIn({ ...actor, workspaceId: 'foreign' })).rejects.toMatchObject(
        { statusCode: 403 },
      );
      await pool.query('UPDATE mr_memberships SET removed_at=now() WHERE id=$1', [
        actor.membershipId,
      ]);
      await email.workOnce();
      expect(send).not.toHaveBeenCalled();
      expect((await rows(pool)).every((row) => row.status === 'cancelled')).toBe(true);
      await expect(email.getEmailOptIn(actor)).rejects.toMatchObject({ statusCode: 403 });
      await expect(email.getEmailOptIn({ ...actor, workspaceId: 'foreign' })).rejects.toMatchObject(
        { statusCode: 403 },
      );
    });
  }, 60_000);

  it('clears stale verification and consent from a fresh trusted identity without falling back to an old address', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.enqueueFromEvents();
      await email.clearVerifiedRecipient(actor);
      expect(await email.getEmailOptIn(actor)).toMatchObject({
        emailAvailable: false,
        email: false,
        recipientVerified: false,
        emailRecipient: null,
      });
      await email.workOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await rows(pool)).toMatchObject([
        { status: 'cancelled', last_error_code: 'verification_unavailable' },
      ]);
    });
  }, 60_000);

  it('holds an expired claimed request as unknown instead of assuming it was never accepted', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance, clock }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send, { ...config, idempotencyConfirmed: false });
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.enqueueFromEvents();
      await pool.query(
        "UPDATE mr_notification_email_deliveries SET status='sending',attempts=1,lease_token=$1,lease_until=$2,next_attempt_at=NULL",
        [randomUUID(), new Date(clock().getTime() - 1)],
      );
      await email.workOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await rows(pool)).toMatchObject([
        {
          status: 'unknown',
          attempts: 1,
          next_attempt_at: null,
          last_error_code: 'acceptance_unknown',
        },
      ]);
    });
  }, 60_000);

  it('does not revive a cancelled claimed request after opt-out while the relay response is in flight', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      let release!: (value: { statusCode: number }) => void, entered!: () => void;
      const gate = new Promise<{ statusCode: number }>((resolve) => {
          release = resolve;
        }),
        started = new Promise<void>((resolve) => {
          entered = resolve;
        });
      const send = vi.fn(async () => {
          entered();
          return gate;
        }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      const running = email.workOnce();
      await started;
      await email.setEmailOptIn(actor, false);
      release({ statusCode: 202 });
      await running;
      expect(await rows(pool)).toMatchObject([
        { status: 'cancelled', attempts: 1, accepted_at: null },
      ]);
      advance(86_400_000);
      await email.workOnce();
      expect(send).toHaveBeenCalledTimes(1);
    });
  }, 60_000);

  it('pins pending delivery to its configured relay and never sends old work through a replacement', async () => {
    await fixture(async ({ pool, actor, store, verify, event, advance }) => {
      const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
        email = store(send);
      await verify(email);
      await email.setEmailOptIn(actor, true);
      advance();
      await event();
      await email.enqueueFromEvents();
      const replacement = store(send, {
        ...config,
        endpoint: 'https://replacement.fixture.invalid/notifications',
      });
      await replacement.workOnce();
      expect(send).not.toHaveBeenCalled();
      expect(await rows(pool)).toMatchObject([
        { status: 'cancelled', last_error_code: 'transport_changed' },
      ]);
    });
  }, 60_000);

  it('fixed HTTP transport projects the template, header secret and idempotency key without an arbitrary payload proxy', async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 202 });
    const transport = createNotificationEmailHttpTransport(config, send);
    const id = randomUUID();
    await transport({
      deliveryId: id,
      to: 'owner@example.test',
      eventType: 'alert.triggered',
      appUrl: 'https://opengen.fixture.invalid/app#activity',
      subject: 'NEVER SEND PRIVATE SUBJECT',
      text: 'NEVER SEND PRIVATE TEXT',
      prompt: 'NEVER SEND PRIVATE PROMPT',
    } as NotificationEmailMessage);
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0]![0];
    expect(request.url).toBe(config.endpoint);
    expect(request.headers).toEqual({
      'Idempotency-Key': id,
      Authorization: 'Bearer synthetic-relay-auth',
    });
    expect(JSON.stringify(JSON.parse(request.body))).not.toContain('PRIVATE');
    expect(request.body).not.toContain('synthetic-relay-auth');
    await expect(async () =>
      transport({
        deliveryId: id,
        to: 'owner@example.test',
        eventType: 'alert.triggered',
        appUrl: 'https://attacker.invalid',
        subject: '',
        text: '',
      }),
    ).rejects.toMatchObject({ code: 'invalid_email_message' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!native)(
    'native PostgreSQL workers deduplicate concurrent fan-out and claims',
    async () => {
      await fixture(async ({ pool, actor, store, verify, event, advance }) => {
        const send = vi.fn().mockResolvedValue({ statusCode: 202 }),
          a = store(send),
          b = store(send);
        await verify(a);
        await a.setEmailOptIn(actor, true);
        advance();
        await event();
        await Promise.all([a.enqueueFromEvents(), b.enqueueFromEvents()]);
        await Promise.all([a.workOnce(), b.workOnce()]);
        expect(send).toHaveBeenCalledTimes(1);
        expect(await rows(pool)).toMatchObject([{ status: 'sent', attempts: 1 }]);
      });
    },
    60_000,
  );
});

it('treats the documented blank optional relay auth environment as absent', () => {
  const configured = notificationEmailConfiguration({
    OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: config.endpoint,
    OPENGEN_PUBLIC_URL: config.publicUrl,
    OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: '',
  });
  expect(configured?.endpoint).toBe(config.endpoint);
  expect(configured?.authToken).toBeUndefined();
  expect(configured?.idempotencyConfirmed).toBe(false);
});
