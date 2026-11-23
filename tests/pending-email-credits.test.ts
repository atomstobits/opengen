import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createEngine,
  keyScopes,
  pendingEmailCreditIdentityFromVerifiedOidcClaims,
  type VerifiedPendingEmailCreditIdentity,
} from '@media-router/engine';
import { buildApp } from '../apps/server/src/app';

const oidcFixture = vi.hoisted(() => ({
  claims: {
    iss: 'https://accounts.google.com',
    sub: 'google-sub-fixture',
    email: 'invitee@example.invalid',
    email_verified: true,
  } as Record<string, unknown>,
}));

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn((_config, params: Record<string, string>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    }),
    authorizationCodeGrant: vi.fn(async () => ({
      claims: () => oidcFixture.claims,
    })),
  };
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'https://opengen.fixture.invalid';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

const cookieParts = (headers: Record<string, unknown>): string[] => {
  const raw = headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => String(item).split(';')[0]!);
};
function cookieJar(...groups: string[][]) {
  const jar = new Map<string, string>();
  for (const item of groups.flat()) jar.set(item.slice(0, item.indexOf('=')), item);
  return [...jar.values()].join('; ');
}
function extractActionToken(html: string) {
  const match = html.match(/name="actionToken"[^>]*value="([^"]+)"/i);
  if (!match) throw new Error('Missing actionToken in /auth/login notice HTML.');
  return match[1]!;
}

beforeEach(() => {
  vi.clearAllMocks();
  oidcFixture.claims = {
    iss: 'https://accounts.google.com',
    sub: `google-sub-${randomUUID()}`,
    email: `invitee-${randomUUID()}@example.invalid`,
    email_verified: true,
  };
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('verified OIDC email claim extraction for pending credits', () => {
  it('accepts strictly boolean email_verified === true and preserves exact HTTPS issuer', () => {
    const verified = pendingEmailCreditIdentityFromVerifiedOidcClaims({
      iss: 'https://accounts.google.com',
      sub: 'sub-fixture-00000000000000000001',
      email: '  Invitee.User@Example.INVALID ',
      email_verified: true,
    });
    expect(verified).toMatchObject({
      issuer: 'https://accounts.google.com',
      subject: 'sub-fixture-00000000000000000001',
      email: 'invitee.user@example.invalid',
    });
  });

  it('rejects unverified, string-coerced, HTTP-issuer, or malformed email claims', () => {
    const base = {
      iss: 'https://accounts.google.com',
      sub: 'sub-1',
      email: 'invitee@example.invalid',
    };
    expect(pendingEmailCreditIdentityFromVerifiedOidcClaims(base)).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({ ...base, email_verified: false }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({ ...base, email_verified: 'true' }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({ ...base, email_verified: 1 }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({
        ...base,
        iss: 'http://accounts.google.com',
        email_verified: true,
      }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({
        ...base,
        iss: 'https://user:pass@accounts.google.com',
        email_verified: true,
      }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({
        ...base,
        email: 'not-an-email',
        email_verified: true,
      }),
    ).toBeNull();
    expect(
      pendingEmailCreditIdentityFromVerifiedOidcClaims({
        ...base,
        sub: '',
        email_verified: true,
      }),
    ).toBeNull();
  });
});

describe.skipIf(!databaseUrl)('database-backed pending email credits', () => {
  async function setup() {
    const engine = createEngine({
      databaseUrl: databaseUrl!,
      vaultKey: 'ab'.repeat(32),
      publicUrl: origin,
    });
    await engine.initialize();
    return engine;
  }

  it('supports idempotent enqueue, conflict rejection, revocation, issuer isolation, and atomic one-time claim', async () => {
    const engine = await setup();
    try {
      const email = `invitee-${randomUUID()}@example.invalid`;
      const issuer = 'https://accounts.google.com';
      const ref1 = `invite-1-${randomUUID()}`;
      const ref2 = `invite-2-${randomUUID()}`;
      const refRevoked = `invite-revoked-${randomUUID()}`;
      const refOtherIssuer = `invite-other-issuer-${randomUUID()}`;

      // Enqueue with mixed-case email normalizes to lowercase.
      const first = await engine.pendingEmailCredits.enqueue({
        issuer,
        email: email.toUpperCase(),
        amountMicros: 100_000_000,
        reference: ref1,
        note: 'Initial $100 invite grant',
      });
      expect(first.created).toBe(true);
      expect(first.credit).toMatchObject({
        issuer,
        email,
        amountMicros: 100_000_000,
        reference: ref1,
        note: 'Initial $100 invite grant',
        status: 'pending',
        claimedAt: null,
        claimedWorkspaceId: null,
        claimedSubject: null,
        revokedAt: null,
      });

      // Exact replay is idempotent.
      const replay = await engine.pendingEmailCredits.enqueue({
        issuer,
        email,
        amountMicros: 100_000_000,
        reference: ref1,
        note: 'Initial $100 invite grant',
      });
      expect(replay.created).toBe(false);
      expect(replay.credit.id).toBe(first.credit.id);

      // Changed amount/email/issuer under same reference is rejected with 409.
      await expect(
        engine.pendingEmailCredits.enqueue({
          issuer,
          email,
          amountMicros: 50_000_000,
          reference: ref1,
          note: 'Initial $100 invite grant',
        }),
      ).rejects.toMatchObject({ code: 'pending_credit_conflict', statusCode: 409 });

      // Reserved Stripe ledger prefixes are rejected.
      await expect(
        engine.pendingEmailCredits.enqueue({
          issuer,
          email,
          amountMicros: 1_000_000,
          reference: `stripe-topup:${randomUUID()}`,
        }),
      ).rejects.toMatchObject({ code: 'invalid_reference', statusCode: 400 });

      // Second grant for the same email, one revoked grant, and one for another issuer.
      await engine.pendingEmailCredits.enqueue({
        issuer,
        email,
        amountMicros: 25_000_000,
        reference: ref2,
      });
      const toRevoke = await engine.pendingEmailCredits.enqueue({
        issuer,
        email,
        amountMicros: 10_000_000,
        reference: refRevoked,
      });
      const revoked = await engine.pendingEmailCredits.revoke(toRevoke.credit.id);
      expect(revoked.status).toBe('revoked');
      expect(revoked.revokedAt).toBeTruthy();
      // Repeat revoke is idempotent.
      expect((await engine.pendingEmailCredits.revoke(toRevoke.credit.id)).status).toBe('revoked');

      await engine.pendingEmailCredits.enqueue({
        issuer: 'https://other-idp.example',
        email,
        amountMicros: 99_000_000,
        reference: refOtherIssuer,
      });

      // Forged plain object without Symbol brand is rejected.
      const sub = `sub-${randomUUID()}`;
      const principal = await engine.accounts.identity(issuer, sub);
      await expect(
        engine.pendingEmailCredits.claimForVerifiedIdentity(principal.workspaceId, {
          issuer,
          subject: sub,
          email,
        } as unknown as VerifiedPendingEmailCreditIdentity),
      ).rejects.toMatchObject({ code: 'verified_email_required', statusCode: 403 });

      // Mismatched workspace fails closed.
      const verified = pendingEmailCreditIdentityFromVerifiedOidcClaims({
        iss: issuer,
        sub,
        email,
        email_verified: true,
      })!;
      const otherWorkspace = `other-${randomUUID()}`;
      await engine.ensureWorkspace(otherWorkspace, 0);
      await expect(
        engine.pendingEmailCredits.claimForVerifiedIdentity(otherWorkspace, verified),
      ).rejects.toMatchObject({ code: 'pending_credit_identity_mismatch', statusCode: 403 });

      // Concurrent claims credit exactly once ($100 + $25 = $125, skipping revoked & other issuer).
      const [claimA, claimB] = await Promise.all([
        engine.pendingEmailCredits.claimForVerifiedIdentity(principal.workspaceId, verified),
        engine.pendingEmailCredits.claimForVerifiedIdentity(principal.workspaceId, verified),
      ]);
      expect(claimA.length + claimB.length).toBe(2);
      expect(await engine.getBalance(principal.workspaceId)).toEqual({
        availableMicros: 125_000_000,
        reservedMicros: 0,
        currency: 'USD',
      });

      // Ledger omits raw email PII and uses noncash pending-email-credit:<id> reference.
      const ledgerRows = (
        await engine.pool.query(
          'SELECT kind,amount_micros,reference,details FROM mr_ledger WHERE workspace_id=$1 ORDER BY created_at ASC',
          [principal.workspaceId],
        )
      ).rows;
      expect(ledgerRows).toHaveLength(2);
      expect(ledgerRows[0]).toMatchObject({
        kind: 'credit',
        amount_micros: '100000000',
        reference: `pending-email-credit:${first.credit.id}`,
        details: {
          source: 'pending-email-credit',
          pendingCreditId: first.credit.id,
          operatorReference: ref1,
        },
      });
      expect(JSON.stringify(ledgerRows)).not.toContain(email);

      // Already-claimed credit cannot be revoked.
      await expect(engine.pendingEmailCredits.revoke(first.credit.id)).rejects.toMatchObject({
        code: 'pending_credit_already_claimed',
        statusCode: 409,
      });

      // Other issuer's grant remains pending and untouched.
      const stillPending = await engine.pendingEmailCredits.list({ email, status: 'pending' });
      expect(stillPending).toHaveLength(1);
      expect(stillPending[0]?.reference).toBe(refOtherIssuer);
    } finally {
      await engine.close();
    }
  });

  it('enforces operator bearer authority on HTTP endpoints and claims on verified /auth/callback only', async () => {
    const engine = await setup();
    const apiToken = 'fixture-operator-token';
    const localWorkspace = `op-${randomUUID()}`;
    await engine.ensureWorkspace(localWorkspace, 0);
    const app = await buildApp({
      engine,
      apiToken,
      workspaceId: localWorkspace,
      publicUrl: origin,
      env: {
        OPENGEN_PUBLIC_URL: origin,
        OIDC_ISSUER: 'https://accounts.google.com',
        OIDC_CLIENT_ID: 'fixture-client-id',
        OIDC_CLIENT_SECRET: 'fixture-client-secret',
        MR_SESSION_SECRET: 's'.repeat(40),
      },
    });
    apps.push(app);

    try {
      const email = `invitee-http-${randomUUID()}@example.invalid`;
      const reference = `operator-invite-${randomUUID()}`;

      // Non-operator callers are rejected.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/operator/pending-email-credits',
            payload: { email, amountMicros: 100_000_000, reference },
          })
        ).statusCode,
      ).toBe(403);

      const nonBootstrapKey = await engine.accounts.createKey(localWorkspace, {
        name: 'Workspace admin key',
        scopes: [...keyScopes],
      });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/operator/pending-email-credits',
            headers: { authorization: `Bearer ${nonBootstrapKey.token}` },
            payload: { email, amountMicros: 100_000_000, reference },
          })
        ).statusCode,
      ).toBe(403);

      // Even a bootstrap browser cookie without explicit Bearer authorization is rejected.
      const bootstrapSession = await app.inject({
        method: 'POST',
        url: '/v1/session',
        payload: { token: apiToken },
      });
      const bootstrapCookie = cookieParts(bootstrapSession.headers)[0]!;
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/operator/pending-email-credits',
            headers: { cookie: bootstrapCookie, origin },
            payload: { email, amountMicros: 100_000_000, reference },
          })
        ).statusCode,
      ).toBe(403);

      // Installation operator Bearer creates the $100 pending credit (issuer defaults to OIDC_ISSUER).
      const created = await app.inject({
        method: 'POST',
        url: '/v1/operator/pending-email-credits',
        headers: { authorization: `Bearer ${apiToken}` },
        payload: {
          email: email.toUpperCase(),
          amountMicros: 100_000_000,
          reference,
          note: 'Invite credit fixture',
        },
      });
      expect(created.statusCode).toBe(201);
      const pending = created.json();
      expect(pending).toMatchObject({
        issuer: 'https://accounts.google.com',
        email,
        amountMicros: 100_000_000,
        reference,
        status: 'pending',
      });

      // Exact replay returns 200 with same ID.
      const replay = await app.inject({
        method: 'POST',
        url: '/v1/operator/pending-email-credits',
        headers: { authorization: `Bearer ${apiToken}` },
        payload: {
          email,
          amountMicros: 100_000_000,
          reference,
          note: 'Invite credit fixture',
        },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().id).toBe(pending.id);

      // Helper to complete /auth/login -> POST /auth/login -> /auth/callback.
      async function signInWithOidc() {
        const notice = await app.inject({ method: 'GET', url: '/auth/login' });
        expect(notice.statusCode).toBe(200);
        const intentCookies = cookieParts(notice.headers);
        const actionToken = extractActionToken(notice.body);
        const handoff = await app.inject({
          method: 'POST',
          url: '/auth/login',
          headers: {
            origin,
            cookie: cookieJar(intentCookies),
            'content-type': 'application/x-www-form-urlencoded',
          },
          payload: new URLSearchParams({ action: 'continue', actionToken }).toString(),
        });
        expect(handoff.statusCode).toBe(200);
        const oidcCookies = cookieParts(handoff.headers);
        const cb = await app.inject({
          method: 'GET',
          url: '/auth/callback?code=fixture-code',
          headers: { cookie: cookieJar(intentCookies, oidcCookies) },
        });
        expect(cb.statusCode).toBe(302);
        expect(cb.headers.location).toBe(`${origin}/app#start`);
        return cookieParts(cb.headers).find((c) => c.startsWith('og_session='))!;
      }

      // 1. Unverified email claim MUST NOT claim the pending credit.
      const inviteeSub = `google-sub-${randomUUID()}`;
      oidcFixture.claims = {
        iss: 'https://accounts.google.com',
        sub: inviteeSub,
        email,
        email_verified: false,
      };
      const unverifiedSession = await signInWithOidc();
      const balanceBefore = await app.inject({
        method: 'GET',
        url: '/v1/balance',
        headers: { cookie: unverifiedSession },
      });
      expect(balanceBefore.statusCode).toBe(200);
      expect(balanceBefore.json()).toEqual({
        availableMicros: 0,
        reservedMicros: 0,
        currency: 'USD',
      });

      // 2. Verified email claim atomically credits $100 into the user's personal workspace.
      oidcFixture.claims = {
        iss: 'https://accounts.google.com',
        sub: inviteeSub,
        email,
        email_verified: true,
      };
      const verifiedSession = await signInWithOidc();
      const balanceAfter = await app.inject({
        method: 'GET',
        url: '/v1/balance',
        headers: { cookie: verifiedSession },
      });
      expect(balanceAfter.statusCode).toBe(200);
      expect(balanceAfter.json()).toEqual({
        availableMicros: 100_000_000,
        reservedMicros: 0,
        currency: 'USD',
      });

      // 3. Subsequent verified sign-in does not double-credit.
      const secondSession = await signInWithOidc();
      const balanceSecond = await app.inject({
        method: 'GET',
        url: '/v1/balance',
        headers: { cookie: secondSession },
      });
      expect(balanceSecond.json()).toEqual({
        availableMicros: 100_000_000,
        reservedMicros: 0,
        currency: 'USD',
      });

      // 4. Operator GET shows claimed metadata; DELETE returns 409.
      const listed = await app.inject({
        method: 'GET',
        url: `/v1/operator/pending-email-credits?email=${encodeURIComponent(email)}`,
        headers: { authorization: `Bearer ${apiToken}` },
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().data).toEqual([
        expect.objectContaining({
          id: pending.id,
          status: 'claimed',
          claimedSubject: inviteeSub,
          amountMicros: 100_000_000,
        }),
      ]);
      expect(
        (
          await app.inject({
            method: 'DELETE',
            url: `/v1/operator/pending-email-credits/${pending.id}`,
            headers: { authorization: `Bearer ${apiToken}` },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await engine.close();
    }
  });
});
