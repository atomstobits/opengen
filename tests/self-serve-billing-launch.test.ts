import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import type Stripe from 'stripe';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AccountStore, TermsReceiptStore } from '@media-router/engine';
import { buildHostedLegalPublicationRecord } from '@media-router/contracts/hosted-legal-publication';
import { buildApp } from '../apps/server/src/app.js';
import {
  hostedBillingManual,
  readBillingManualConfiguration,
} from '../apps/server/src/billing-manual.js';
import {
  hostedBillingSandbox,
  readBillingSandboxConfiguration,
} from '../apps/server/src/billing-sandbox.js';
import {
  createBillingFixtureRuntime,
  startBillingRechargeWorker,
  type BillingFixtureRuntimeOptions,
} from '../apps/server/src/billing-runtime.js';
import { StripeBillingTransport } from '../apps/server/src/billing-stripe.js';
import { createStripeClient, STRIPE_API_VERSION } from '../apps/server/src/payments.js';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery.js';
import type { HumanTermsPolicy } from '../apps/server/src/terms-login.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import {
  calculateProcessingFee,
  computeStripeGrossUpFee,
} from '../packages/engine/src/payments.js';
import { registeredBackendPath } from '../apps/web/app/registered-http.js';
import { previewProcessingFee } from '../apps/web/app/billing/billing-client.js';
import {
  enrollBillingOwner,
  readBillingAccess,
  type BillingCapabilities,
  type BillingOwnerEnrollment,
} from '../apps/web/app/billing/policy-client.js';
import { validateRechargeAuthentication } from '../apps/web/app/billing/recharge-authentication.js';
import { legalSurfacePresentationFromPublication } from '../apps/web/app/legal/publication.js';

async function loadBillingUiBundle() {
  const result = await build({
    stdin: {
      contents: [
        `export { LegalPresentationProvider } from './apps/web/app/legal/presentation';`,
        `export { BillingPage, BillingOwnerEnrollmentCard } from './apps/web/app/billing/billing';`,
        `export { BillingPolicyPanel } from './apps/web/app/billing/policy-panel';`,
      ].join(' '),
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'next', 'next/*'],
    loader: { '.css': 'empty' },
    plugins: [
      {
        name: 'css-fixture',
        setup(builder) {
          builder.onLoad({ filter: /\.css$/ }, () => ({
            contents: 'export default {};',
            loader: 'js',
          }));
        },
      },
    ],
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx', target: 'ES2022', module: 'ESNext' } },
  });
  const mod = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', result.outputFiles[0]!.text)(
    createRequire(import.meta.url),
    mod,
    mod.exports,
  );
  return mod.exports as {
    LegalPresentationProvider: ComponentType<{
      presentation: ReturnType<typeof legalSurfacePresentationFromPublication>;
      children: ReactNode;
    }>;
    BillingPage: ComponentType;
    BillingOwnerEnrollmentCard: ComponentType<{
      workspaceId: string;
      recoveryScope: string;
      enrollment: BillingOwnerEnrollment;
      legal: ReturnType<typeof legalSurfacePresentationFromPublication>;
      onEnrolled: () => Promise<void>;
    }>;
    BillingPolicyPanel: ComponentType<{
      workspaceId: string;
      recoveryScope: string;
      capabilities: BillingCapabilities;
    }>;
  };
}

const migrationsDir = new URL('../packages/engine/migrations/', import.meta.url);

async function createPglitePool(): Promise<{ pool: Pool; close(): Promise<void> }> {
  const db = new PGlite();
  const files = (await readdir(migrationsDir)).filter((f) => /^\d{3}\.sql$/.test(f)).sort();
  expect(files.length).toBeGreaterThanOrEqual(32);
  for (const file of files) {
    await db.exec(await readFile(new URL(file, migrationsDir), 'utf8'));
  }
  let queue = Promise.resolve();
  const runQuery = async (
    text: string | { text: string; values?: unknown[] },
    values?: unknown[],
  ) => {
    const sql = typeof text === 'string' ? text : text.text;
    const params = typeof text === 'string' ? values : text.values;
    const trimmed = sql.trim().toUpperCase();
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') {
      await db.exec(sql);
      return { rows: [], rowCount: 0 } as unknown as QueryResult;
    }
    const res = await db.query(sql, params);
    return {
      rows: res.rows,
      rowCount: res.rows.length || (res.affectedRows ?? 0),
    } as unknown as QueryResult;
  };
  const pool = {
    ended: false,
    query: (text: string, values?: unknown[]) => runQuery(text, values),
    connect: async (): Promise<PoolClient> => {
      let releaseLock!: () => void;
      const previous = queue;
      queue = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previous;
      let released = false;
      return {
        query: (text: string, values?: unknown[]) => runQuery(text, values),
        release: () => {
          if (!released) {
            released = true;
            releaseLock();
          }
        },
      } as unknown as PoolClient;
    },
    end: async () => {
      pool.ended = true;
      await db.close();
    },
  };
  return {
    pool: pool as unknown as Pool,
    close: async () => {
      if (!pool.ended) await pool.end();
    },
  };
}

let sharedDb: { pool: Pool; close(): Promise<void> } | undefined;
async function getSharedDb() {
  return (sharedDb ??= await createPglitePool());
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
afterAll(async () => {
  await sharedDb?.close();
});

describe('1. Multi-tenant public self-serve startup (manual & sandbox)', () => {
  const publicLiveEnv = {
    OPENGEN_BILLING_MANUAL: 'true',
    STRIPE_LIVEMODE: 'true',
    STRIPE_SECRET_KEY: ['rk', 'live', 'publiclaunchfixture123'].join('_'),
    STRIPE_WEBHOOK_SECRET: ['whsec', 'publiclaunchfixture123'].join('_'),
    OPENGEN_BILLING_PUBLISHABLE_KEY: ['pk', 'live', 'publiclaunchfixture123'].join('_'),
    OPENGEN_BILLING_PORTAL_CONFIGURATION: 'bpc_live_launch_123',
    OPENGEN_PUBLIC_URL: 'https://opengen.dev',
    DATABASE_URL: 'postgresql://localhost/opengen_prod',
    OPENGEN_BILLING_CHECKOUT: 'open',
    OPENGEN_BILLING_RECHARGE: 'open',
    OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: 'live-public-launch',
    OPENGEN_BILLING_PROCESSOR_ACCOUNT: 'acct_livefixture123',
    OPENGEN_BILLING_TERMS_VERSION: 'hosted-terms-2026-11-16',
    OPENGEN_BILLING_TERMS_TEXT: 'OpenGen Terms of Service credit and refund provisions.',
  } as const;

  const sandboxEnv = {
    OPENGEN_BILLING_SANDBOX: 'true',
    STRIPE_LIVEMODE: 'false',
    STRIPE_SECRET_KEY: ['rk', 'test', 'sandboxlaunchfixture123'].join('_'),
    STRIPE_WEBHOOK_SECRET: ['whsec', 'sandboxlaunchfixture123'].join('_'),
    OPENGEN_BILLING_PUBLISHABLE_KEY: ['pk', 'test', 'sandboxlaunchfixture123'].join('_'),
    OPENGEN_BILLING_PORTAL_CONFIGURATION: 'bpc_test_launch_123',
    OPENGEN_PUBLIC_URL: 'https://sandbox.opengen.example',
    DATABASE_URL: 'postgresql://localhost/opengen_billing_sandbox_launch',
    OPENGEN_BILLING_CHECKOUT: 'open',
    OPENGEN_BILLING_RECHARGE: 'open',
    OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: 'sandbox-public-launch',
    OPENGEN_BILLING_PROCESSOR_ACCOUNT: 'acct_sandboxfixture123',
  } as const;

  it('parses public multi-tenant live manual config without pre-existing workspace or approval env vars', () => {
    const config = readBillingManualConfiguration(publicLiveEnv)!;
    expect(config).toMatchObject({
      publicUrl: 'https://opengen.dev',
      checkoutWritesEnabled: true,
      rechargeEnabled: true,
      portalConfigurationId: 'bpc_live_launch_123',
      publishableKey: publicLiveEnv.OPENGEN_BILLING_PUBLISHABLE_KEY,
      environment: {
        id: 'live-public-launch',
        accountId: 'acct_livefixture123',
        livemode: true,
      },
    });
    expect(config.workspaceId).toBeUndefined();
    expect(config.approvalReference).toBeUndefined();

    // Empty strings from .env templates behave identically to omitted optional workspace/approval
    expect(
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_MANUAL_WORKSPACE: '',
        OPENGEN_BILLING_APPROVAL_REFERENCE: '',
      })?.workspaceId,
    ).toBeUndefined();

    // Pairing only one of workspace or approval reference fails closed
    expect(() =>
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_MANUAL_WORKSPACE: 'ws-only',
      }),
    ).toThrow();
    expect(() =>
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_APPROVAL_REFERENCE: 'approval-only',
      }),
    ).toThrow();

    // Rejects mismatched pk_test_ in live manual mode and malformed portal/recharge config
    expect(() =>
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_PUBLISHABLE_KEY: ['pk', 'test', 'wrongmode123'].join('_'),
      }),
    ).toThrow();
    expect(() =>
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_PORTAL_CONFIGURATION: 'invalid_portal',
      }),
    ).toThrow();
    expect(() =>
      readBillingManualConfiguration({
        ...publicLiveEnv,
        OPENGEN_BILLING_RECHARGE: 'invalid',
      }),
    ).toThrow();
  });

  it('parses sandbox config with setup, auto-recharge, portal and pk_test_ 3DS recovery', () => {
    const config = readBillingSandboxConfiguration(sandboxEnv)!;
    expect(config).toMatchObject({
      publicUrl: 'https://sandbox.opengen.example',
      checkoutWritesEnabled: true,
      rechargeEnabled: true,
      portalConfigurationId: 'bpc_test_launch_123',
      publishableKey: sandboxEnv.OPENGEN_BILLING_PUBLISHABLE_KEY,
    });
    expect(() =>
      readBillingSandboxConfiguration({
        ...sandboxEnv,
        OPENGEN_BILLING_PUBLISHABLE_KEY: ['pk', 'live', 'wrongmode123'].join('_'),
      }),
    ).toThrow();
  });

  it('verifies processor environment + installation rate limit + charges_enabled without a customer workspace', async () => {
    const db = await getSharedDb();
    const beforeRate = Number(
      (
        await db.pool.query(
          'SELECT payment_checkout_count FROM mr_payment_rate_limits WHERE singleton=true',
        )
      ).rows[0]!.payment_checkout_count,
    );
    const beforeWorkspaces = Number(
      (await db.pool.query('SELECT count(*)::int AS n FROM mr_workspaces')).rows[0]!.n,
    );

    const config = readBillingManualConfiguration({
      ...publicLiveEnv,
      OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: `live-public-${randomUUID().slice(0, 8)}`,
    })!;
    const stripe = createStripeClient('fixture-noncredential');
    const accountRetrieve = vi.spyOn(stripe.accounts, 'retrieve');

    // Unregistered processor environment fails before touching Stripe
    await expect(hostedBillingManual(db.pool, config, stripe)).rejects.toMatchObject({
      code: 'processor_environment_unverified',
    });
    expect(accountRetrieve).not.toHaveBeenCalled();

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await registerBillingProcessorEnvironmentInTransaction(client, config.environment);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    accountRetrieve.mockResolvedValueOnce({
      id: config.environment.accountId,
      charges_enabled: true,
    } as Stripe.Response<Stripe.Account>);

    const runtimeOptions = await hostedBillingManual(db.pool, config, stripe);
    expect(runtimeOptions).toMatchObject({
      activation: 'manual',
      liveRechargeApproved: true,
      checkoutWritesEnabled: true,
      setupAvailable: true,
      automaticChargesEnabled: true,
      portalAvailable: true,
      recovery: {
        publishableKey: publicLiveEnv.OPENGEN_BILLING_PUBLISHABLE_KEY,
      },
    });
    expect(() => createBillingFixtureRuntime(db.pool, runtimeOptions)).not.toThrow();

    const rateRow = (
      await db.pool.query(
        'SELECT payment_checkout_count FROM mr_payment_rate_limits WHERE singleton=true',
      )
    ).rows[0]!;
    expect(Number(rateRow.payment_checkout_count)).toBe(beforeRate + 1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mr_workspaces')).rows[0]!.n).toBe(
      beforeWorkspaces,
    );

    // Sandbox multi-tenant startup also works without pre-existing workspace
    const sandboxConfig = readBillingSandboxConfiguration({
      ...sandboxEnv,
      OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: `sandbox-public-${randomUUID().slice(0, 8)}`,
    })!;
    const sbxClient = await db.pool.connect();
    try {
      await sbxClient.query('BEGIN');
      await registerBillingProcessorEnvironmentInTransaction(sbxClient, sandboxConfig.environment);
      await sbxClient.query('COMMIT');
    } finally {
      sbxClient.release();
    }
    accountRetrieve.mockResolvedValueOnce({
      id: sandboxConfig.environment.accountId,
    } as Stripe.Response<Stripe.Account>);
    const sbxRuntime = await hostedBillingSandbox(db.pool, sandboxConfig, stripe);
    expect(sbxRuntime).toMatchObject({
      activation: 'sandbox',
      checkoutWritesEnabled: true,
      setupAvailable: true,
      automaticChargesEnabled: true,
      portalAvailable: true,
      recovery: { publishableKey: sandboxEnv.OPENGEN_BILLING_PUBLISHABLE_KEY },
    });
    expect(() => createBillingFixtureRuntime(db.pool, sbxRuntime)).not.toThrow();
  }, 60_000);
});

describe('2. Self-serve workspace funding-owner enrollment, replacement, fee Checkout, BIN country & auto-recharge', () => {
  const publicUrl = 'https://opengen.dev';
  const webhookSecret = 'whsec_synthetic_launch_secret';

  async function launchFixture(livemode = true) {
    const db = await getSharedDb();
    const runTag = randomUUID().replaceAll('-', '').slice(0, 10);

    const accounts = new AccountStore(db.pool, 'ab'.repeat(32));
    const termsReceipts = new TermsReceiptStore(db.pool);
    const stripe = createStripeClient('fixture-noncredential');
    const environment = {
      id: `${livemode ? 'live' : 'sandbox'}-launch-${runTag}`,
      accountId: `acct_launch${runTag}`,
      livemode,
    };
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await registerBillingProcessorEnvironmentInTransaction(c, environment);
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
      id: environment.accountId,
      charges_enabled: true,
    } as Stripe.Response<Stripe.Account>);

    const stripeTransport = new StripeBillingTransport(stripe, {
      enabled: true,
      processorEnvironment: environment,
      publicUrl,
      portalConfigurationId: 'bpc_launch_portal',
    });
    await stripeTransport.verifyProcessorEnvironment(() => {});

    let humanPolicy: HumanTermsPolicy = {
      version: 'hosted-terms-2026-11-16',
      digest: 'f'.repeat(64),
      status: 'active',
      effectiveAt: '2026-11-16T00:00:00.000Z',
    };
    const sharedHumanTermsPolicy = () => humanPolicy;

    const runtimeConfig: BillingFixtureRuntimeOptions = {
      activation: livemode ? 'manual' : 'sandbox',
      liveRechargeApproved: livemode,
      processorEnvironment: environment,
      checkoutWritesEnabled: true,
      setupAvailable: true,
      automaticChargesEnabled: true,
      portalAvailable: true,
      recovery: {
        transport: stripeTransport,
        publishableKey: livemode ? 'pk_live_launchfixture123' : 'pk_test_launchfixture123',
      },
      terms: {
        version: 'hosted-terms-2026-11-16',
        text: 'OpenGen Terms of Service credit and refund provisions.',
      },
      ...(livemode ? { humanTermsPolicy: sharedHumanTermsPolicy } : {}),
      manualTransport: stripeTransport.verifiedLegacyCheckoutTransport(),
      customerTransport: stripeTransport,
      rechargeTransport: stripeTransport,
      webhookVerifier: stripe.webhooks,
      webhookSecret,
    };

    const engineStub = {
      pool: db.pool,
      accounts,
      getExecutableRouteIds: () => [],
      submit: async () => ({}),
      getJob: async () => null,
      listJobs: async () => [],
      cancel: async () => ({}),
      getBalance: async (workspaceId: string) => {
        const row = (
          await db.pool.query(
            'SELECT available_micros, reserved_micros FROM mr_workspaces WHERE id=$1',
            [workspaceId],
          )
        ).rows[0];
        return {
          availableMicros: Number(row?.available_micros ?? 0),
          reservedMicros: Number(row?.reserved_micros ?? 0),
          currency: 'USD',
        };
      },
      routeMetrics: async () => [],
    };

    const app = await buildApp({
      engine: engineStub as never,
      billingRuntime: runtimeConfig,
      ...(livemode ? { humanTermsPolicy: sharedHumanTermsPolicy } : {}),
      publicUrl,
      env: { MR_SESSION_SECRET: 's'.repeat(40) },
    });
    cleanups.push(async () => {
      await app.close();
    });

    const createBrowserUser = async (subject: string) => {
      const p = await accounts.identity(
        `https://idp.opengen.example/${runTag}`,
        `${subject}-${runTag}`,
      );
      const sessionCookie = await accounts.createSession(p);
      const resolved = (await accounts.session(sessionCookie))!;
      return {
        principal: resolved,
        cookie: sessionCookie,
        headers: {
          cookie: `og_session=${sessionCookie}`,
          'x-opengen-workspace': resolved.workspaceId,
          'x-opengen-recovery-scope': sessionRecoveryScope(resolved),
        },
      };
    };

    const acceptTerms = async (principal: { identity?: { issuer: string; subject: string } }) => {
      await termsReceipts.recordVerifiedAcceptance({
        issuer: principal.identity!.issuer,
        subject: principal.identity!.subject,
        policyVersion: humanPolicy.version,
        policyDigest: humanPolicy.digest,
      });
    };

    const signedWebhook = (type: string, object: Record<string, unknown>) => {
      const payload = JSON.stringify({
        id: `evt_${randomUUID().replaceAll('-', '')}`,
        object: 'event',
        livemode,
        type,
        data: { object },
      });
      return {
        method: 'POST' as const,
        url: '/webhooks/stripe',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': stripe.webhooks.generateTestHeaderString({
            payload,
            secret: webhookSecret,
          }),
        },
        payload,
      };
    };

    return {
      db,
      accounts,
      stripe,
      app,
      runtimeConfig,
      engineStub,
      createBrowserUser,
      acceptTerms,
      signedWebhook,
      setHumanPolicy: (next: HumanTermsPolicy) => {
        humanPolicy = next;
      },
    };
  }

  it('enforces browser session, Origin, recovery scope, admin role, 029 Terms receipt, CAS, single active owner replacement, and delegation revocation', async () => {
    const f = await launchFixture(true);
    const adminA = await f.createBrowserUser('alice-admin');
    const workspaceId = adminA.principal.workspaceId;

    // Create a second admin (Bob) and a non-admin member (Carol) in the same workspace
    const issuer = adminA.principal.identity!.issuer;
    const bobIdp = await f.accounts.identity(issuer, 'bob-admin');
    const carolIdp = await f.accounts.identity(issuer, 'carol-member');
    const carolMembershipId = randomUUID();
    await f.db.pool.query(
      `INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at)
       VALUES ($1,$2,$3,$4,'admin',now()), ($5,$2,$3,$6,'member',now())`,
      [
        randomUUID(),
        workspaceId,
        issuer,
        bobIdp.identity!.subject,
        carolMembershipId,
        carolIdp.identity!.subject,
      ],
    );
    const switchToWorkspace = async (subject: string) => {
      const base = await f.accounts.identity(issuer, subject);
      const rawCookie = await f.accounts.createSession(base);
      const resolved = await f.accounts.switchSession(rawCookie, base, workspaceId);
      return {
        principal: resolved,
        headers: {
          cookie: `og_session=${rawCookie}`,
          'x-opengen-workspace': workspaceId,
          'x-opengen-recovery-scope': sessionRecoveryScope(resolved),
        },
      };
    };
    const adminB = await switchToWorkspace('bob-admin');
    const memberC = await switchToWorkspace('carol-member');

    // Create an API key in workspace
    const apiKey = await f.accounts.createKey(workspaceId, {
      name: 'Agent Key',
      scopes: ['read', 'generate', 'billing:read'],
    });

    // 1. Before Terms acceptance: adminA sees ownerEnrollment with reason='terms-required'
    const initialAccess = await f.app.inject({
      url: '/v1/billing/access',
      headers: adminA.headers,
    });
    expect(initialAccess.statusCode).toBe(200);
    expect(initialAccess.json()).toEqual({
      workspaceId,
      recoveryScope: adminA.headers['x-opengen-recovery-scope'],
      capabilities: { read: false, manage: false, setup: false },
      ownerEnrollment: {
        eligible: false,
        expectedAuthorityVersion: 0,
        allowsAutoRecharge: true,
        terms: f.runtimeConfig.terms,
        reason: 'terms-required',
      },
    });

    // Non-admin member sees reason='admin-required'
    const memberAccess = await f.app.inject({
      url: '/v1/billing/access',
      headers: memberC.headers,
    });
    expect(memberAccess.statusCode).toBe(200);
    expect(memberAccess.json()).toMatchObject({
      capabilities: { read: false, manage: false, setup: false },
      ownerEnrollment: {
        eligible: false,
        expectedAuthorityVersion: 0,
        reason: 'admin-required',
      },
    });

    const enrollBody = {
      expectedAuthorityVersion: 0,
      acceptedTerms: true,
      termsVersion: f.runtimeConfig.terms!.version,
    };

    // 2. Rejects unauthenticated, API key bearer, ambiguous cookie+bearer, wrong Origin, stale recovery, non-admin member
    expect(
      (await f.app.inject({ method: 'POST', url: '/v1/billing/owner', payload: enrollBody }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { authorization: `Bearer ${apiKey.token}`, origin: publicUrl },
          payload: enrollBody,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: {
            ...adminA.headers,
            authorization: `Bearer ${apiKey.token}`,
            origin: publicUrl,
          },
          payload: enrollBody,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...adminA.headers, origin: 'https://evil.example' },
          payload: enrollBody,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...adminA.headers, 'x-opengen-recovery-scope': 'stale', origin: publicUrl },
          payload: enrollBody,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...memberC.headers, origin: publicUrl },
          payload: enrollBody,
        })
      ).statusCode,
    ).toBe(403);

    // 3. Rejects adminA in livemode BEFORE 029 Terms receipt is recorded
    const missingTerms = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/owner',
      headers: { ...adminA.headers, origin: publicUrl },
      payload: enrollBody,
    });
    expect(missingTerms.statusCode).toBe(403);
    expect(missingTerms.json().error.code).toBe('current_human_terms_required');

    // 4. Record 029 Terms receipt for adminA -> ownerEnrollment flips eligible = true, enrollment succeeds!
    await f.acceptTerms(adminA.principal);
    const readyAccess = await f.app.inject({
      url: '/v1/billing/access',
      headers: adminA.headers,
    });
    expect(readyAccess.json().ownerEnrollment).toEqual({
      eligible: true,
      expectedAuthorityVersion: 0,
      allowsAutoRecharge: true,
      terms: f.runtimeConfig.terms,
    });

    // Wrong termsVersion rejected with 409
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...adminA.headers, origin: publicUrl },
          payload: { ...enrollBody, termsVersion: 'wrong-version' },
        })
      ).statusCode,
    ).toBe(409);

    // Optimistic CAS mismatch rejected with 409
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...adminA.headers, origin: publicUrl },
          payload: { ...enrollBody, expectedAuthorityVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);

    const enrolledA = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/owner',
      headers: { ...adminA.headers, origin: publicUrl },
      payload: enrollBody,
    });
    expect(enrolledA.statusCode, enrolledA.body).toBe(200);
    expect(enrolledA.json()).toEqual({
      workspaceId,
      authorityVersion: 1,
    });

    // AdminA grants apiKey a billing:read delegation under authorityVersion 1
    const grantedDelegation = await f.app.inject({
      method: 'PUT',
      url: '/v1/billing/delegations',
      headers: { ...adminA.headers, origin: publicUrl },
      payload: {
        expectedVersion: 0,
        expectedAuthorityVersion: 1,
        target: { kind: 'key', id: apiKey.id },
        rails: {
          allowsEnabled: false,
          maxThresholdMicros: 5_000_000,
          maxAmountCents: 2_500,
          maxMonthlyCapCents: 10_000,
          maxAttemptsPerMonth: 4,
          minCooldownSeconds: 86_400,
          maxFailureLimit: 3,
        },
        permissions: ['billing:read'],
        consentReference: 'delegation-from-alice',
      },
    });
    expect(grantedDelegation.statusCode, grantedDelegation.body).toBe(200);
    expect(
      (
        await f.app.inject({
          url: '/v1/billing/policy',
          headers: { authorization: `Bearer ${apiKey.token}` },
        })
      ).statusCode,
    ).toBe(200);

    // AdminA now has full read/manage/setup capabilities and no pending ownerEnrollment
    const afterAccessA = await f.app.inject({
      url: '/v1/billing/access',
      headers: adminA.headers,
    });
    expect(afterAccessA.json()).toEqual({
      workspaceId,
      recoveryScope: adminA.headers['x-opengen-recovery-scope'],
      capabilities: { read: true, manage: true, setup: true },
    });

    // 5. AdminB sees replaceExistingOwner=true, expectedAuthorityVersion=1
    await f.acceptTerms(adminB.principal);
    const beforeAccessB = await f.app.inject({
      url: '/v1/billing/access',
      headers: adminB.headers,
    });
    expect(beforeAccessB.json()).toMatchObject({
      capabilities: { read: false, manage: false, setup: false },
      ownerEnrollment: {
        eligible: true,
        expectedAuthorityVersion: 1,
        allowsAutoRecharge: true,
        replaceExistingOwner: true,
      },
    });

    // Stale expectedAuthorityVersion=0 fails with 409
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...adminB.headers, origin: publicUrl },
          payload: { ...enrollBody, expectedAuthorityVersion: 0 },
        })
      ).statusCode,
    ).toBe(409);

    // AdminB replaces AdminA with expectedAuthorityVersion=1 -> authorityVersion=2 and revokes prior owner delegations!
    const enrolledB = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/owner',
      headers: { ...adminB.headers, origin: publicUrl },
      payload: { ...enrollBody, expectedAuthorityVersion: 1 },
    });
    expect(enrolledB.statusCode, enrolledB.body).toBe(200);
    expect(enrolledB.json()).toEqual({
      workspaceId,
      authorityVersion: 2,
    });

    // Verify strictly ONE row exists in mr_billing_owners, AdminA is superseded, and AdminA's delegation to Carol is revoked!
    const ownerRows = (
      await f.db.pool.query('SELECT * FROM mr_billing_owners WHERE workspace_id=$1', [workspaceId])
    ).rows;
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]!.membership_id).toBe(adminB.principal.membershipId);
    const activeDelegations = (
      await f.db.pool.query(
        'SELECT count(*)::int AS n FROM mr_billing_delegations WHERE workspace_id=$1 AND revoked_at IS NULL',
        [workspaceId],
      )
    ).rows[0]!.n;
    expect(activeDelegations).toBe(0);
    expect(
      (
        await f.app.inject({
          url: '/v1/billing/policy',
          headers: { authorization: `Bearer ${apiKey.token}` },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await f.app.inject({ url: '/v1/billing/access', headers: adminA.headers })).json(),
    ).toMatchObject({
      capabilities: { read: false, manage: false, setup: false },
      ownerEnrollment: {
        eligible: true,
        expectedAuthorityVersion: 2,
        replaceExistingOwner: true,
      },
    });
  });

  it('completes $9,999 fee Checkout (v3), non-US saved-card setup, 4.4%+$0.30 auto-recharge, and live 3DS recovery', async () => {
    const f = await launchFixture(true);
    const admin = await f.createBrowserUser('founder-admin');
    const workspaceId = admin.principal.workspaceId;
    await f.acceptTerms(admin.principal);
    const mutationHeaders = { ...admin.headers, origin: publicUrl };

    // Enroll as workspace funding owner
    const enrolled = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/owner',
      headers: mutationHeaders,
      payload: {
        expectedAuthorityVersion: 0,
        acceptedTerms: true,
        termsVersion: f.runtimeConfig.terms!.version,
      },
    });
    expect(enrolled.statusCode).toBe(200);

    // Summary exposes $5-$9,999 limits and 290/440/+30 fee constants
    const summaryRes = await f.app.inject({ url: '/v1/billing', headers: admin.headers });
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json()).toMatchObject({
      enabled: true,
      minAmountCents: 500,
      maxAmountCents: 999900,
      feeRateBps: 290,
      internationalFeeRateBps: 440,
      fixedFeeCents: 30,
    });

    // Create $9,999.00 (999900 cents) top-up order -> totalChargeCents = 1029795 ($10,297.95), feeCents = 29895
    const orderRes = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/orders',
      headers: { ...mutationHeaders, 'idempotency-key': 'topup-9999-launch' },
      payload: { amountCents: 999900 },
    });
    expect(orderRes.statusCode, orderRes.body).toBe(201);
    const createdOrder = orderRes.json();
    expect(createdOrder).toMatchObject({
      amountCents: 999900,
      feeCents: 29895,
      totalChargeCents: 1029795,
      feeRateBps: 290,
      creditMicros: 9_999_000_000,
    });

    const checkoutSession: Stripe.Checkout.Session = {
      id: 'cs_live_9999fixture',
      mode: 'payment',
      currency: 'usd',
      amount_subtotal: 1029795,
      amount_total: 1029795,
      payment_status: 'unpaid',
      status: 'open',
      client_reference_id: createdOrder.id,
      payment_intent: null,
      livemode: true,
      url: 'https://checkout.stripe.com/c/pay/cs_live_9999fixture',
    } as Stripe.Checkout.Session;

    const checkoutCreateSpy = vi
      .spyOn(f.stripe.checkout.sessions, 'create')
      .mockResolvedValueOnce(checkoutSession as never);
    vi.spyOn(f.stripe.checkout.sessions, 'retrieve').mockResolvedValueOnce({
      ...checkoutSession,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_live_9999topup',
    } as never);

    const openCheckout = await f.app.inject({
      method: 'POST',
      url: `/v1/billing/orders/${createdOrder.id}/checkout`,
      headers: mutationHeaders,
      payload: {},
    });
    expect(openCheckout.statusCode, openCheckout.body).toBe(200);
    expect(checkoutCreateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: 999900,
              product_data: { name: 'OpenGen prepaid service credit' },
            },
          },
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: 29895,
              product_data: { name: 'Payment processing fee' },
            },
          },
        ],
      }),
      expect.objectContaining({ apiVersion: STRIPE_API_VERSION }),
    );

    // Reconcile paid Checkout webhook -> credits ONLY principal 9,999,000,000 micro-USD ($9,999.00)
    const webhookTopup = await f.app.inject(
      f.signedWebhook('checkout.session.completed', {
        ...checkoutSession,
        status: 'complete',
        payment_status: 'paid',
        payment_intent: 'pi_live_9999topup',
      }),
    );
    expect(webhookTopup.statusCode, webhookTopup.body).toBe(200);
    expect((await f.engineStub.getBalance(workspaceId)).availableMicros).toBe(9_999_000_000);

    // Reset balance to 0 to trigger auto-recharge after saved-card setup
    await f.db.pool.query('UPDATE mr_workspaces SET available_micros=0 WHERE id=$1', [workspaceId]);

    // Saved-card setup with non-US ('gb' -> 'GB') card!
    vi.spyOn(f.stripe.customers, 'create').mockResolvedValueOnce({
      id: 'cus_live_uk',
      livemode: true,
    } as never);
    vi.spyOn(f.stripe.customers, 'retrieve').mockResolvedValue({
      id: 'cus_live_uk',
      livemode: true,
    } as never);
    let setupId = '';
    checkoutCreateSpy.mockImplementationOnce(
      async (params: Stripe.Checkout.SessionCreateParams) => {
        setupId = String(params.client_reference_id);
        return {
          id: 'cs_live_setup_uk',
          mode: 'setup',
          customer: 'cus_live_uk',
          livemode: true,
          status: 'open',
          client_reference_id: setupId,
          setup_intent: null,
          url: 'https://checkout.stripe.com/c/pay/cs_live_setup_uk',
        } as never;
      },
    );

    const startedSetup = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/setup',
      headers: { ...mutationHeaders, 'idempotency-key': 'setup-uk-card-1' },
      payload: { termsVersion: f.runtimeConfig.terms!.version, acceptedTerms: true },
    });
    expect(startedSetup.statusCode, startedSetup.body).toBe(200);

    vi.spyOn(f.stripe.checkout.sessions, 'retrieve').mockResolvedValueOnce({
      id: 'cs_live_setup_uk',
      mode: 'setup',
      customer: 'cus_live_uk',
      livemode: true,
      status: 'complete',
      client_reference_id: setupId,
      setup_intent: 'seti_live_uk',
      url: null,
    } as never);
    vi.spyOn(f.stripe.setupIntents, 'retrieve').mockResolvedValueOnce({
      id: 'seti_live_uk',
      customer: 'cus_live_uk',
      payment_method: 'pm_live_uk_card',
      livemode: true,
      status: 'succeeded',
      usage: 'off_session',
    } as never);
    vi.spyOn(f.stripe.paymentMethods, 'retrieve').mockResolvedValueOnce({
      id: 'pm_live_uk_card',
      customer: 'cus_live_uk',
      livemode: true,
      type: 'card',
      card: { country: 'gb' },
    } as never);

    const setupCompleteHook = await f.app.inject(
      f.signedWebhook('checkout.session.completed', {
        id: 'cs_live_setup_uk',
        mode: 'setup',
        customer: 'cus_live_uk',
        livemode: true,
        status: 'complete',
        client_reference_id: setupId,
        setup_intent: 'seti_live_uk',
      }),
    );
    expect(setupCompleteHook.statusCode, setupCompleteHook.body).toBe(200);

    // Policy endpoint returns mandate with cardCountry: 'GB'
    const policyRead = await f.app.inject({ url: '/v1/billing/policy', headers: admin.headers });
    expect(policyRead.statusCode).toBe(200);
    expect(policyRead.json().mandate).toEqual({
      id: expect.any(String),
      status: 'active',
      cardCountry: 'GB',
    });
    const mandateId = policyRead.json().mandate.id as string;

    // Enable auto-recharge for $100.00 (10000 cents) -> GB card fee = 492 cents, total = 10492 cents!
    const updatePolicy = await f.app.inject({
      method: 'PUT',
      url: '/v1/billing/policy',
      headers: mutationHeaders,
      payload: {
        expectedVersion: 0,
        expectedAuthorityVersion: 1,
        consentReference: 'browser-policy:uk-100',
        policy: {
          enabled: true,
          thresholdMicros: 10_000_000,
          amountCents: 10000,
          monthlyCapCents: 50000,
          maxAttemptsPerMonth: 5,
          cooldownSeconds: 60,
          failureLimit: 3,
          mandateId,
        },
      },
    });
    expect(updatePolicy.statusCode, updatePolicy.body).toBe(200);

    // Off-session PaymentIntent requires 3DS authentication at $104.92 (10492 cents)
    const piCreateSpy = vi.spyOn(f.stripe.paymentIntents, 'create').mockResolvedValueOnce({
      id: 'pi_live_uk_10492',
      customer: 'cus_live_uk',
      payment_method: 'pm_live_uk_card',
      currency: 'usd',
      amount: 10492,
      amount_received: 0,
      status: 'requires_action',
      livemode: true,
    } as never);

    const runner = createBillingFixtureRuntime(f.db.pool, f.runtimeConfig);
    await runner.workOnce();

    expect(piCreateSpy).toHaveBeenCalledOnce();
    expect(piCreateSpy.mock.calls[0]![0]).toMatchObject({
      amount: 10492,
      currency: 'usd',
      customer: 'cus_live_uk',
      payment_method: 'pm_live_uk_card',
      confirm: true,
      off_session: true,
      metadata: {
        opengen_credit_cents: '10000',
        opengen_fee_cents: '492',
      },
    });

    const rechargesList = await f.app.inject({
      url: '/v1/billing/recharges',
      headers: admin.headers,
    });
    expect(rechargesList.statusCode).toBe(200);
    const attempt = rechargesList.json().data[0];
    expect(attempt).toMatchObject({
      amountCents: 10000,
      feeCents: 492,
      totalChargeCents: 10492,
      feeRateBps: 440,
      status: 'requires_authentication',
    });

    // Live 3DS authentication recovery returns pk_live_...
    vi.spyOn(f.stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
      id: 'pi_live_uk_10492',
      customer: 'cus_live_uk',
      payment_method: {
        id: 'pm_live_uk_card',
        type: 'card',
        customer: 'cus_live_uk',
        livemode: true,
      },
      currency: 'usd',
      amount: 10492,
      amount_received: 0,
      status: 'requires_action',
      livemode: true,
      client_secret: ['pi_live_uk_10492', 'secret', 'a'.repeat(16)].join('_'),
    } as never);

    const authRes = await f.app.inject({
      method: 'POST',
      url: `/v1/billing/recharges/${attempt.id}/authentication`,
      headers: mutationHeaders,
      payload: { expectedPolicyVersion: 1, expectedAuthorityVersion: 1 },
    });
    expect(authRes.statusCode, authRes.body).toBe(200);
    expect(authRes.json().publishableKey).toBe('pk_live_launchfixture123');
    expect(authRes.json()).toMatchObject({
      workspaceId,
      attemptId: attempt.id,
      amountCents: 10000,
      feeCents: 492,
      totalChargeCents: 10492,
    });

    // Reconcile payment_intent.succeeded -> credits ONLY $100.00 principal (100_000_000 micro-USD)!
    vi.spyOn(f.stripe.paymentIntents, 'retrieve').mockResolvedValueOnce({
      id: 'pi_live_uk_10492',
      customer: 'cus_live_uk',
      payment_method: 'pm_live_uk_card',
      currency: 'usd',
      amount: 10492,
      amount_received: 10492,
      status: 'succeeded',
      livemode: true,
    } as never);

    const paidHook = await f.app.inject(
      f.signedWebhook('payment_intent.succeeded', {
        id: 'pi_live_uk_10492',
        customer: 'cus_live_uk',
        payment_method: 'pm_live_uk_card',
        currency: 'usd',
        amount: 10492,
        amount_received: 10492,
        status: 'succeeded',
        livemode: true,
      }),
    );
    expect(paidHook.statusCode, paidHook.body).toBe(200);
    expect((await f.engineStub.getBalance(workspaceId)).availableMicros).toBe(100_000_000);

    // Billing portal works in live manual mode when OPENGEN_BILLING_PORTAL_CONFIGURATION is set
    vi.spyOn(f.stripe.billingPortal.sessions, 'create').mockResolvedValueOnce({
      customer: 'cus_live_uk',
      url: 'https://billing.stripe.com/p/session/live_uk',
    } as never);
    const portalRes = await f.app.inject({
      method: 'POST',
      url: '/v1/billing/portal',
      headers: mutationHeaders,
      payload: {},
    });
    expect(portalRes.statusCode, portalRes.body).toBe(200);
    expect(portalRes.json().url).toBe('https://billing.stripe.com/p/session/live_uk');
  });
});

describe('3. Bounded serial API recharge runner & Next.js fixed billing proxies', () => {
  it('runs workOnce serially without overlapping turns, redacts errors, and awaits in-flight turn on stop', async () => {
    const errors: { code: string; sqlState?: string }[] = [];
    let activeTurns = 0;
    let maxConcurrent = 0;
    let calls = 0;
    let releaseSlowTurn!: () => void;
    const slowTurnGate = new Promise<void>((resolve) => {
      releaseSlowTurn = resolve;
    });

    const loop = startBillingRechargeWorker(
      async () => {
        calls++;
        activeTurns++;
        maxConcurrent = Math.max(maxConcurrent, activeTurns);
        try {
          if (calls === 1) {
            throw new Error('rk_live_SHOULD_BE_REDACTED pi_123_secret_SENSITIVE');
          }
          if (calls === 2) {
            await slowTurnGate;
          }
        } finally {
          activeTurns--;
        }
      },
      {
        intervalMs: 100,
        onError: (err) => errors.push(err),
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(calls).toBe(2);
    expect(maxConcurrent).toBe(1);
    expect(errors).toEqual([{ code: 'operation_failed' }]);
    expect(JSON.stringify(errors)).not.toContain('rk_live_');
    expect(JSON.stringify(errors)).not.toContain('_secret_');

    let stoppedResolved = false;
    const stopPromise = loop.stop().then(() => {
      stoppedResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stoppedResolved).toBe(false);
    releaseSlowTurn();
    await stopPromise;
    expect(stoppedResolved).toBe(true);

    const callsAtStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(calls).toBe(callsAtStop);
  });

  it('registers /v1/billing/owner and relays headers, Retry-After, and private no-store through fixed Next route proxies', async () => {
    expect(registeredBackendPath('/v1/billing/owner', 'POST')).toBe(true);
    expect(registeredBackendPath('/v1/billing/owner', 'GET')).toBe(false);
    expect(registeredBackendPath('/v1/billing/delegations', 'PUT')).toBe(true);
    expect(registeredBackendPath('/v1/billing/delegations', 'DELETE')).toBe(true);
    expect(registeredBackendPath('/v1/operator/billing/work', 'POST')).toBe(true);

    const forwarded: { url: string; method: string; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        forwarded.push({
          url: String(input),
          method: init?.method ?? 'GET',
          headers: new Headers(init?.headers),
        });
        return Response.json(
          { error: { code: 'payment_rate_limited', message: 'Slow down.' } },
          { status: 429, headers: { 'Retry-After': '19' } },
        );
      }),
    );
    vi.resetModules();
    const { POST: ownerProxyPost } = await import('../apps/web/app/api/billing/owner/route.js');
    const { PUT: delegationsProxyPut, DELETE: delegationsProxyDelete } =
      await import('../apps/web/app/api/billing/delegations/route.js');

    const idemKey = ['idem', 'owner', '1'.repeat(8)].join('-');
    const reqHeaders = {
      cookie: 'og_session=browser-cookie',
      origin: 'https://opengen.dev',
      'idempotency-key': idemKey,
      'x-opengen-workspace': 'ws-proxy',
      'x-opengen-recovery-scope': 'scope-proxy',
      'content-type': 'application/json',
    };

    const ownerRes = await ownerProxyPost(
      new Request('https://opengen.dev/api/billing/owner', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify({
          expectedAuthorityVersion: 0,
          acceptedTerms: true,
          termsVersion: 'hosted-terms-2026-11-16',
        }),
      }),
    );
    expect(ownerRes.status).toBe(429);
    expect(ownerRes.headers.get('retry-after')).toBe('19');
    expect(ownerRes.headers.get('cache-control')).toBe('private, no-store');

    const delPutRes = await delegationsProxyPut(
      new Request('https://opengen.dev/api/billing/delegations', {
        method: 'PUT',
        headers: reqHeaders,
        body: '{}',
      }),
    );
    expect(delPutRes.headers.get('cache-control')).toBe('private, no-store');

    const delDeleteRes = await delegationsProxyDelete(
      new Request('https://opengen.dev/api/billing/delegations', {
        method: 'DELETE',
        headers: reqHeaders,
        body: '{}',
      }),
    );
    expect(delDeleteRes.headers.get('cache-control')).toBe('private, no-store');

    expect(forwarded.map((f) => `${f.method} ${new URL(f.url).pathname}`)).toEqual([
      'POST /v1/billing/owner',
      'PUT /v1/billing/delegations',
      'DELETE /v1/billing/delegations',
    ]);
    for (const call of forwarded) {
      expect(call.headers.get('cookie')).toBe('og_session=browser-cookie');
      expect(call.headers.get('origin')).toBe('https://opengen.dev');
      expect(call.headers.get('idempotency-key')).toBe(idemKey);
      expect(call.headers.get('x-opengen-workspace')).toBe('ws-proxy');
      expect(call.headers.get('x-opengen-recovery-scope')).toBe('scope-proxy');
    }
    vi.unstubAllGlobals();
  });
});

describe('4. Frontend /billing UI, fee preview math ($5/$100/$9,999), enrollment card & clean legal links', () => {
  it('matches engine gross-up math across $5, $100, and $9,999 for domestic and non-US cards', () => {
    expect(computeStripeGrossUpFee).toBe(calculateProcessingFee);
    for (const [credit, usTotal, intlTotal] of [
      [500, 546, 555],
      [10000, 10330, 10492],
      [999900, 1029795, 1045952],
    ] as const) {
      const usEngine = calculateProcessingFee(credit, 'US');
      const usUi = previewProcessingFee(credit, 'US')!;
      expect(usUi.totalChargeCents).toBe(usTotal);
      expect(usUi.feeCents).toBe(usTotal - credit);
      expect(usUi.feeRateBps).toBe(290);
      expect(usUi).toMatchObject(usEngine);

      const intlEngine = calculateProcessingFee(credit, 'GB');
      const intlUi = previewProcessingFee(credit, 'gb')!;
      expect(intlUi.totalChargeCents).toBe(intlTotal);
      expect(intlUi.feeCents).toBe(intlTotal - credit);
      expect(intlUi.feeRateBps).toBe(440);
      expect(intlUi).toMatchObject(intlEngine);
    }
    expect(previewProcessingFee(499)).toBeNull();
    expect(previewProcessingFee(999901)).toBeNull();
  });

  it('validates $9,999 3DS recovery responses with live publishable keys', () => {
    const id = '24250436-0606-4da0-9877-b65fe61d78de';
    const validated = validateRechargeAuthentication(
      {
        workspaceId: 'ws-live',
        attemptId: id,
        amountCents: 999900,
        feeCents: 46052,
        totalChargeCents: 1045952,
        paymentIntentId: 'pi_liveMax9999',
        clientSecret: ['pi_liveMax9999', 'secret', 'a'.repeat(16)].join('_'),
        publishableKey: 'pk_live_' + 'a'.repeat(16),
      },
      {
        id,
        workspaceId: 'ws-live',
        amountCents: 999900,
        feeCents: 46052,
        totalChargeCents: 1045952,
        status: 'requires_authentication',
      },
    );
    expect(validated.totalChargeCents).toBe(1045952);
  });

  it('parses ownerEnrollment metadata and posts self-serve owner enrollment from browser client', async () => {
    const authority = { workspaceId: 'ws-ui', recoveryScope: 'scope-ui' };
    const access = await readBillingAccess(authority, undefined, async () =>
      Response.json({
        ...authority,
        capabilities: { read: false, manage: false, setup: false },
        ownerEnrollment: {
          eligible: true,
          expectedAuthorityVersion: 2,
          allowsAutoRecharge: true,
          replaceExistingOwner: true,
          terms: { version: 'hosted-terms-2026-11-16', text: 'Terms text' },
        },
      }),
    );
    expect(access).toEqual({
      read: false,
      manage: false,
      setup: false,
      ownerEnrollment: {
        eligible: true,
        expectedAuthorityVersion: 2,
        allowsAutoRecharge: true,
        replaceExistingOwner: true,
        terms: { version: 'hosted-terms-2026-11-16', text: 'Terms text' },
      },
    });

    const enrolled = await enrollBillingOwner({
      workspaceId: 'ws-ui',
      recoveryScope: 'scope-ui',
      expectedAuthorityVersion: 2,
      termsVersion: 'hosted-terms-2026-11-16',
      request: async (url, init) => {
        expect(url).toBe('/api/billing/owner');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({
          expectedAuthorityVersion: 2,
          acceptedTerms: true,
          termsVersion: 'hosted-terms-2026-11-16',
        });
        return Response.json({
          workspaceId: 'ws-ui',
          authorityVersion: 3,
        });
      },
    });
    expect(enrolled).toEqual({ workspaceId: 'ws-ui', authorityVersion: 3 });
  });

  it('renders clean /terms, /terms#credits-and-refunds, and /privacy links with zero version numbers', async () => {
    const {
      LegalPresentationProvider,
      BillingPage,
      BillingOwnerEnrollmentCard,
      BillingPolicyPanel,
    } = await loadBillingUiBundle();

    const pub = buildHostedLegalPublicationRecord({
      publishedAt: '2026-11-16T00:00:00.000Z',
      effectiveAt: '2026-11-16T00:00:00.000Z',
      approvalReference: 'owner-approval-fixture',
      operatingRecordReference: 'operating-record-fixture',
    });
    const publishedLegal = legalSurfacePresentationFromPublication(
      pub,
      Date.parse('2026-11-16T01:00:00.000Z'),
    );

    const signedOutHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: publishedLegal,
        children: createElement(BillingPage),
      }),
    );
    const mainHtml = signedOutHtml.match(/<main[\s\S]*<\/main>/)?.[0] ?? signedOutHtml;
    expect(mainHtml).toContain('href="/terms"');
    expect(mainHtml).toContain('href="/terms#credits-and-refunds"');
    expect(mainHtml).toContain('credit &amp; refund terms');
    expect(mainHtml).toContain('href="/privacy"');
    expect(mainHtml).not.toContain('href="/refunds"');
    expect(mainHtml).not.toContain('Terms draft');
    expect(mainHtml).not.toContain('Not yet effective');
    expect(mainHtml).not.toContain('version ');

    const adminEnrollHtml = renderToStaticMarkup(
      createElement(BillingOwnerEnrollmentCard, {
        workspaceId: 'ws-1',
        recoveryScope: 'scope-1',
        legal: publishedLegal,
        onEnrolled: async () => {},
        enrollment: {
          eligible: true,
          expectedAuthorityVersion: 0,
          allowsAutoRecharge: true,
          terms: { version: 'hosted-terms-2026-11-16', text: 'Prepaid credit terms.' },
        },
      }),
    );
    expect(adminEnrollHtml).toContain('Enable prepaid billing →');
    expect(adminEnrollHtml).toContain('$5.00–$9,999.00');
    expect(adminEnrollHtml).toContain('<summary>Payment terms</summary>');
    expect(adminEnrollHtml).not.toContain('hosted-terms-2026-11-16');
    expect(adminEnrollHtml).not.toContain('Payment terms ·');

    const adminTermsRequiredHtml = renderToStaticMarkup(
      createElement(BillingOwnerEnrollmentCard, {
        workspaceId: 'ws-1',
        recoveryScope: 'scope-1',
        legal: publishedLegal,
        onEnrolled: async () => {},
        enrollment: {
          eligible: false,
          expectedAuthorityVersion: 0,
          reason: 'terms-required',
          terms: { version: 'hosted-terms-2026-11-16', text: 'Prepaid credit terms.' },
        },
      }),
    );
    expect(adminTermsRequiredHtml).toContain('Review Terms and sign in ↗');
    expect(adminTermsRequiredHtml).not.toContain('hosted-terms-2026-11-16');

    const adminReplaceHtml = renderToStaticMarkup(
      createElement(BillingOwnerEnrollmentCard, {
        workspaceId: 'ws-1',
        recoveryScope: 'scope-1',
        legal: publishedLegal,
        onEnrolled: async () => {},
        enrollment: {
          eligible: true,
          expectedAuthorityVersion: 2,
          allowsAutoRecharge: true,
          replaceExistingOwner: true,
          terms: { version: 'hosted-terms-2026-11-16', text: 'Prepaid credit terms.' },
        },
      }),
    );
    expect(adminReplaceHtml).toContain('Become workspace funding owner →');
    expect(adminReplaceHtml).toContain('<summary>Payment terms</summary>');
    expect(adminReplaceHtml).not.toContain('hosted-terms-2026-11-16');

    const memberReadOnlyHtml = renderToStaticMarkup(
      createElement(BillingPolicyPanel, {
        workspaceId: 'ws-1',
        recoveryScope: 'scope-1',
        capabilities: {
          read: false,
          manage: false,
          setup: false,
        },
      }),
    );
    expect(memberReadOnlyHtml).toContain('WORKSPACE WALLET');
  });
});
