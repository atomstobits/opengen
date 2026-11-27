import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine, keyScopes } from '@media-router/engine';
import { catalog } from '@media-router/catalog';
import { buildApp } from '../apps/server/src/app.js';
import { createStripeClient } from '../apps/server/src/payments.js';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery.js';
import {
  MAX_TRIAL_CREDIT_MICROS,
  readTrialCreditConfig,
  StarterTrialCreditStore,
  TRIAL_CREDIT_REFERENCE_PREFIX,
  trialCreditLedgerReference,
} from '../apps/server/src/trial-credit.js';
import type { BillingFixtureRuntimeOptions } from '../apps/server/src/billing-runtime.js';
import type { HumanTermsPolicy } from '../apps/server/src/terms-login.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import {
  buildFeeBreakdownRows,
  buildPricingCatalogSummary,
  formatRoutePricingHighlight,
  pricingStructuredData,
  readWebTrialCreditOffer,
} from '../apps/web/app/pricing/pricing-data';
import sitemap from '../apps/web/app/sitemap';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const publicUrl = 'https://trial.fixture.invalid';
const activeTermsPolicy: HumanTermsPolicy = Object.freeze({
  version: 'hosted-terms-fixture-2026-11-16',
  digest: 'a'.repeat(64),
  status: 'active',
  effectiveAt: '2026-11-16T00:00:00.000Z',
});
const draftTermsPolicy: HumanTermsPolicy = Object.freeze({
  version: 'hosted-terms-draft-2026-11-16',
  digest: 'b'.repeat(64),
  status: 'draft',
  effectiveAt: null,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('starter trial credit configuration and public /pricing contract', () => {
  it('defaults to disabled (0) and enforces bounded integer micro-USD cap ($5.00 max)', () => {
    expect(readTrialCreditConfig({})).toEqual({ enabled: false, amountMicros: 0 });
    expect(readTrialCreditConfig({ OPENGEN_TRIAL_CREDIT_MICROS: '' })).toEqual({
      enabled: false,
      amountMicros: 0,
    });
    expect(readTrialCreditConfig({ OPENGEN_TRIAL_CREDIT_MICROS: '0' })).toEqual({
      enabled: false,
      amountMicros: 0,
    });
    expect(readTrialCreditConfig({ OPENGEN_TRIAL_CREDIT_MICROS: '1000000' })).toEqual({
      enabled: true,
      amountMicros: 1_000_000,
    });
    expect(
      readTrialCreditConfig({ OPENGEN_TRIAL_CREDIT_MICROS: String(MAX_TRIAL_CREDIT_MICROS) }),
    ).toEqual({
      enabled: true,
      amountMicros: 5_000_000,
    });

    for (const invalid of ['-1', '1.5', '1e6', '5000001', 'abc', '0x10']) {
      expect(() => readTrialCreditConfig({ OPENGEN_TRIAL_CREDIT_MICROS: invalid })).toThrow(
        /OPENGEN_TRIAL_CREDIT_MICROS/,
      );
      expect(readWebTrialCreditOffer({ OPENGEN_TRIAL_CREDIT_MICROS: invalid })).toEqual({
        enabled: false,
        amountMicros: 0,
        formattedUsd: null,
      });
    }
  });

  it('generates deterministic, PII-free, non-Stripe ledger references per verified identity', () => {
    const refA = trialCreditLedgerReference({
      issuer: 'https://accounts.google.com',
      subject: 'user-123',
    });
    const refB = trialCreditLedgerReference({
      issuer: 'https://accounts.google.com',
      subject: 'user-123',
    });
    const refOther = trialCreditLedgerReference({
      issuer: 'https://accounts.google.com',
      subject: 'user-456',
    });
    expect(refA).toBe(refB);
    expect(refA).not.toBe(refOther);
    expect(refA.startsWith(TRIAL_CREDIT_REFERENCE_PREFIX)).toBe(true);
    expect(refA).not.toMatch(/^stripe-(topup|recharge):/);
    expect(refA).not.toContain('accounts.google.com');
    expect(refA).not.toContain('user-123');
    expect(refA.length).toBeLessThanOrEqual(200);
  });

  it('includes /pricing in sitemap and renders truthful /pricing HTML without advertising disabled trial credit', () => {
    vi.stubEnv('OPENGEN_PUBLIC_URL', 'https://opengen.dev');
    vi.stubEnv('OPENGEN_TRIAL_CREDIT_MICROS', '');

    const entries = sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain('https://opengen.dev/pricing');
    expect(new Set(urls).size).toBe(urls.length);

    const feeRows = buildFeeBreakdownRows();
    expect(feeRows.find((r) => r.creditCents === 1000)?.domestic).toMatchObject({
      creditCents: 1000,
      feeCents: 61,
      totalChargeCents: 1061,
      feeRateBps: 290,
    });
    expect(feeRows.find((r) => r.creditCents === 10000)?.international).toMatchObject({
      creditCents: 10000,
      feeCents: 492,
      totalChargeCents: 10492,
      feeRateBps: 440,
    });

    const summary = buildPricingCatalogSummary();
    expect(summary.liveVerifiedHighlights.length).toBeGreaterThan(0);
    expect(summary.liveVerifiedHighlights.every((row) => row.status === 'live-verified')).toBe(
      true,
    );
    expect(summary.documentedHighlights.every((row) => row.status === 'documented')).toBe(true);

    // Unknown / unpriced routes must display "Price unavailable", never $0 or free.
    const sampleModel = catalog.models[0]!;
    const sampleRoute = catalog.routes.find((route) => route.modelId === sampleModel.id)!;
    const sampleDeployment = catalog.deployments.find((d) => d.id === sampleRoute.deploymentId)!;
    const sampleProvider = catalog.providers.find((p) => p.id === sampleDeployment.providerId)!;
    const unpricedRow = formatRoutePricingHighlight(
      { ...sampleRoute, rates: [], publishedPricing: undefined, status: 'documented' },
      sampleModel,
      sampleDeployment,
      sampleProvider,
    );
    expect(unpricedRow.priceAvailable).toBe(false);
    expect(unpricedRow.priceLabel).toBe('Price unavailable');
    expect(unpricedRow.priceLabel).not.toMatch(/\$0|free/i);

    // Disabled by default: web trial credit offer stays off.
    expect(readWebTrialCreditOffer({ OPENGEN_TRIAL_CREDIT_MICROS: '' })).toEqual({
      enabled: false,
      amountMicros: 0,
      formattedUsd: null,
    });
    expect(readWebTrialCreditOffer({ OPENGEN_TRIAL_CREDIT_MICROS: '0' })).toEqual({
      enabled: false,
      amountMicros: 0,
      formattedUsd: null,
    });

    // Enabled by operator: exposes exact bounded amount.
    expect(readWebTrialCreditOffer({ OPENGEN_TRIAL_CREDIT_MICROS: '1000000' })).toEqual({
      enabled: true,
      amountMicros: 1_000_000,
      formattedUsd: '$1.00',
    });

    // Structured data links canonical /pricing without fabricated offers or ratings.
    const ld = pricingStructuredData();
    expect(ld).toMatchObject({
      '@type': 'WebPage',
      url: 'https://opengen.dev/pricing',
    });
    expect(JSON.stringify(ld)).not.toMatch(/aggregateRating|ratingValue|priceCurrency|offers/);
  });
});

function fixtureBillingRuntime(
  processorEnvironment: { id: string; accountId: string; livemode: boolean },
  humanTermsPolicy?: () => HumanTermsPolicy,
): BillingFixtureRuntimeOptions {
  const stripe = createStripeClient('local-fixture-noncredential');
  const proof = { processorEnvironment, assertProcessorEnvironment() {} };
  const unused = async () => {
    throw new Error('Unexpected Stripe transport call in trial-credit fixture.');
  };
  return {
    activation: 'fixture',
    processorEnvironment,
    ...(humanTermsPolicy ? { humanTermsPolicy } : {}),
    terms: { version: 'terms-fixture', text: 'Fixture funding terms.' },
    webhookSecret: 'trial-fixture-webhook-secret',
    webhookVerifier: stripe.webhooks,
    manualTransport: { ...proof, createSession: unused, retrieveSession: unused },
    customerTransport: {
      ...proof,
      createCustomer: unused,
      retrieveCustomer: unused,
      createSetup: unused,
      retrieveSetup: unused,
      retrieveSetupIntent: unused,
      retrievePaymentMethod: unused,
      createPortal: unused,
      listDocuments: unused,
    },
    rechargeTransport: { ...proof, createRecharge: unused, retrieveRecharge: unused },
  };
}

describe.skipIf(!databaseUrl)('database-backed opt-in bounded starter trial credit', () => {
  async function setup(env: NodeJS.ProcessEnv = {}, humanTermsPolicy?: () => HumanTermsPolicy) {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'trial_credit');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        publicUrl,
        providerEnv: {},
        poolSize: Number(process.env.MR_DATABASE_POOL_SIZE ?? 4),
      }),
    );
    await engine.initialize();
    const processorEnvironment = {
      id: 'trial-runtime-fixture',
      accountId: 'acct_trialfixture',
      livemode: false,
    };
    await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
    const app = await buildApp({
      engine,
      publicUrl,
      env,
      ...(humanTermsPolicy ? { humanTermsPolicy } : {}),
      billingRuntime: fixtureBillingRuntime(processorEnvironment, humanTermsPolicy),
    });
    const issuer = 'https://accounts.google.com';
    const subject = `trial-sub-${randomUUID()}`;
    const identity = await engine.accounts.identity(issuer, subject);
    const sessionToken = await engine.accounts.createSession(identity);
    const principal = (await engine.accounts.session(sessionToken))!;
    const recoveryScope = sessionRecoveryScope(principal);
    const headers = {
      cookie: `og_session=${sessionToken}`,
      'x-opengen-workspace': principal.workspaceId,
      'x-opengen-recovery-scope': recoveryScope,
    };
    const recordTermsReceipt = async (policy: HumanTermsPolicy = activeTermsPolicy) => {
      await engine.pool.query(
        `INSERT INTO mr_terms_receipts(issuer,subject,policy_version,policy_digest,notice_version,action,method)
         VALUES($1,$2,$3,$4,'human-terms-continue-v1','continue','oidc-verified')
         ON CONFLICT(issuer,subject,policy_version) DO NOTHING`,
        [issuer, subject, policy.version, policy.digest],
      );
    };
    const close = async () => {
      try {
        await app.close();
      } finally {
        try {
          await engine.close();
        } finally {
          await isolated.close();
        }
      }
    };
    return {
      engine,
      app,
      issuer,
      subject,
      principal,
      sessionToken,
      recoveryScope,
      headers,
      recordTermsReceipt,
      close,
    };
  }

  it('stays completely disabled by default and omits trialCredit from /v1/billing/access', async () => {
    const f = await setup({});
    try {
      await f.recordTermsReceipt();
      const access = await f.app.inject({ url: '/v1/billing/access', headers: f.headers });
      expect(access.statusCode).toBe(200);
      expect(access.json()).toEqual({
        workspaceId: f.principal.workspaceId,
        recoveryScope: f.recoveryScope,
        capabilities: { read: false, manage: false, setup: false },
      });
      expect('trialCredit' in access.json()).toBe(false);

      const status = await f.app.inject({ url: '/v1/billing/trial-credit', headers: f.headers });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        workspaceId: f.principal.workspaceId,
        enabled: false,
        amountMicros: 0,
        claimed: false,
        eligible: false,
        reason: 'disabled',
      });

      const claim = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...f.headers, origin: publicUrl },
        payload: {},
      });
      expect(claim.statusCode).toBe(403);
      expect(claim.json().error.code).toBe('trial_credit_disabled');
      expect(await f.engine.getBalance(f.principal.workspaceId)).toEqual({
        availableMicros: 0,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await f.close();
    }
  });

  it('enforces active Terms receipt (029), personal workspace, browser session, origin, and billing-hold guards', async () => {
    let policy: HumanTermsPolicy = draftTermsPolicy;
    const f = await setup({ OPENGEN_TRIAL_CREDIT_MICROS: '1000000' }, () => policy);
    try {
      // 1. Draft / inactive Terms policy blocks claim.
      const accessInactive = await f.app.inject({ url: '/v1/billing/access', headers: f.headers });
      expect(accessInactive.json().trialCredit).toEqual({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: false,
        eligible: false,
        reason: 'terms-inactive',
      });
      const claimInactive = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...f.headers, origin: publicUrl },
        payload: {},
      });
      expect(claimInactive.statusCode).toBe(403);
      expect(claimInactive.json().error.code).toBe('current_human_terms_inactive');

      // 2. Active Terms policy without recorded 029 receipt blocks claim.
      policy = activeTermsPolicy;
      const accessMissingReceipt = await f.app.inject({
        url: '/v1/billing/access',
        headers: f.headers,
      });
      expect(accessMissingReceipt.json().trialCredit).toEqual({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: false,
        eligible: false,
        reason: 'terms-required',
      });
      const claimMissingReceipt = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...f.headers, origin: publicUrl },
        payload: {},
      });
      expect(claimMissingReceipt.statusCode).toBe(403);
      expect(claimMissingReceipt.json().error.code).toBe('current_human_terms_required');

      // 3. Record 029 receipt -> still rejects cross-origin, API keys, and team workspaces.
      await f.recordTermsReceipt(activeTermsPolicy);

      const badOrigin = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...f.headers, origin: 'https://attacker.invalid' },
        payload: {},
      });
      expect(badOrigin.statusCode).toBe(403);
      expect(badOrigin.json().error.code).toBe('origin_denied');

      const apiKey = await f.engine.accounts.createKey(f.principal.workspaceId, {
        name: 'API key cannot claim trial',
        scopes: [...keyScopes],
      });
      const apiKeyClaim = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: {
          authorization: `Bearer ${apiKey.token}`,
          origin: publicUrl,
          'x-opengen-workspace': f.principal.workspaceId,
          'x-opengen-recovery-scope': f.recoveryScope,
        },
        payload: {},
      });
      expect(apiKeyClaim.statusCode).toBe(401);
      expect(apiKeyClaim.json().error.code).toBe('browser_session_required');

      // Direct store call with API key principal also fails closed.
      const apiPrincipal = (await f.engine.accounts.authenticate(apiKey.token))!;
      const store = new StarterTrialCreditStore(f.engine.pool, {
        amountMicros: 1_000_000,
        humanTermsPolicy: () => policy,
      });
      await expect(store.claim(apiPrincipal)).rejects.toMatchObject({
        code: 'verified_human_required',
        statusCode: 403,
      });

      // Team workspace cannot claim starter trial credit.
      const team = await f.engine.accounts.createTeam(f.principal, 'Trial Team');
      const teamPrincipal = await f.engine.accounts.switchSession(
        f.sessionToken,
        f.principal,
        team.id,
      );
      const teamHeaders = {
        cookie: f.headers.cookie,
        'x-opengen-workspace': team.id,
        'x-opengen-recovery-scope': sessionRecoveryScope(teamPrincipal),
      };
      const teamAccess = await f.app.inject({ url: '/v1/billing/access', headers: teamHeaders });
      expect(teamAccess.json().trialCredit).toEqual({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: false,
        eligible: false,
        reason: 'personal-workspace-required',
      });
      const teamClaim = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...teamHeaders, origin: publicUrl },
        payload: {},
      });
      expect(teamClaim.statusCode).toBe(403);
      expect(teamClaim.json().error.code).toBe('personal_workspace_required');

      // Switch back to personal workspace and apply an active billing hold -> blocked.
      const backPrincipal = await f.engine.accounts.switchSession(
        f.sessionToken,
        teamPrincipal,
        f.principal.workspaceId,
      );
      const backHeaders = {
        cookie: f.headers.cookie,
        'x-opengen-workspace': backPrincipal.workspaceId,
        'x-opengen-recovery-scope': sessionRecoveryScope(backPrincipal),
      };
      const holdOrderId = randomUUID();
      await f.engine.pool.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier)
         VALUES($1,$2,'hold-order-fixture',500,5000000,false,'hold-idem-fixture','hold_integ')`,
        [holdOrderId, f.principal.workspaceId],
      );
      await f.engine.pool.query(
        `INSERT INTO mr_payment_events(id,type,object_id,livemode,order_id,state)
         VALUES('evt_trial_hold','charge.dispute.created','dp_fixture',false,$1,'processed')`,
        [holdOrderId],
      );
      await f.engine.pool.query(
        `INSERT INTO mr_billing_holds(event_id,workspace_id,order_id,reason)
         VALUES('evt_trial_hold',$1,$2,'dispute')`,
        [f.principal.workspaceId, holdOrderId],
      );
      const heldAccess = await f.app.inject({ url: '/v1/billing/access', headers: backHeaders });
      expect(heldAccess.statusCode).toBe(200);
      expect(heldAccess.json().trialCredit).toEqual({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: false,
        eligible: false,
        reason: 'billing-hold',
      });
      const heldClaim = await f.app.inject({
        method: 'POST',
        url: '/v1/billing/trial-credit',
        headers: { ...backHeaders, origin: publicUrl },
        payload: {},
      });
      expect(heldClaim.statusCode).toBe(403);
      expect(heldClaim.json().error.code).toBe('billing_hold');
      expect(await f.engine.getBalance(f.principal.workspaceId)).toEqual({
        availableMicros: 0,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await f.close();
    }
  });

  it('credits atomically once under concurrency, stays idempotent across config changes, and is isolated from cash refunds (028/030/031)', async () => {
    const f = await setup({ OPENGEN_TRIAL_CREDIT_MICROS: '1000000' }, () => activeTermsPolicy);
    try {
      await f.recordTermsReceipt(activeTermsPolicy);

      const accessBefore = await f.app.inject({ url: '/v1/billing/access', headers: f.headers });
      expect(accessBefore.statusCode).toBe(200);
      expect(accessBefore.json().trialCredit).toEqual({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: false,
        eligible: true,
      });

      // Concurrent HTTP claims race simultaneously; exactly one mints credit and all observe one ledger row.
      const responses = await Promise.all(
        Array.from({ length: 4 }, () =>
          f.app.inject({
            method: 'POST',
            url: '/v1/billing/trial-credit',
            headers: { ...f.headers, origin: publicUrl },
            payload: {},
          }),
        ),
      );
      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 201]);
      const bodies = responses.map((r) => r.json());
      const createdCount = bodies.filter((b) => b.alreadyClaimed === false).length;
      expect(createdCount).toBe(1);
      const expectedRef = trialCreditLedgerReference({ issuer: f.issuer, subject: f.subject });
      for (const body of bodies) {
        expect(body).toMatchObject({
          workspaceId: f.principal.workspaceId,
          claimed: true,
          amountMicros: 1_000_000,
          reference: expectedRef,
          promotional: true,
          refundable: false,
        });
      }
      expect(new Set(bodies.map((b) => b.ledgerId)).size).toBe(1);

      // Wallet balance is strictly $1.00 (1,000,000 micros), never double-credited.
      expect(await f.engine.getBalance(f.principal.workspaceId)).toEqual({
        availableMicros: 1_000_000,
        reservedMicros: 0,
        currency: 'USD',
      });

      // Ledger entry records non-refundable promotional provenance with zero raw identity PII.
      const ledgerRows = (
        await f.engine.pool.query<{
          id: string;
          kind: string;
          amount_micros: string;
          available_delta_micros: string;
          reserved_delta_micros: string;
          reference: string;
          details: Record<string, unknown>;
        }>(
          'SELECT id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details FROM mr_ledger WHERE workspace_id=$1',
          [f.principal.workspaceId],
        )
      ).rows;
      expect(ledgerRows).toHaveLength(1);
      const trialLedger = ledgerRows[0]!;
      expect(trialLedger).toMatchObject({
        kind: 'credit',
        amount_micros: '1000000',
        available_delta_micros: '1000000',
        reserved_delta_micros: '0',
        reference: expectedRef,
        details: {
          source: 'starter-trial-credit',
          promotional: true,
          refundable: false,
          termsPolicyVersion: activeTermsPolicy.version,
        },
      });
      expect(JSON.stringify(trialLedger)).not.toContain(f.subject);
      expect(JSON.stringify(trialLedger)).not.toContain(f.issuer);

      // Access endpoint now reports claimed=true, eligible=false.
      const accessAfter = await f.app.inject({ url: '/v1/billing/access', headers: f.headers });
      expect(accessAfter.json().trialCredit).toMatchObject({
        enabled: true,
        amountMicros: 1_000_000,
        claimed: true,
        eligible: false,
        claimedAmountMicros: 1_000_000,
        reason: 'already-claimed',
      });

      // Even if operator raises OPENGEN_TRIAL_CREDIT_MICROS to $2.50 later, the same identity stays idempotent at $1.00.
      const higherStore = new StarterTrialCreditStore(f.engine.pool, {
        amountMicros: 2_500_000,
        humanTermsPolicy: () => activeTermsPolicy,
      });
      const replay = await higherStore.claim(f.principal);
      expect(replay).toMatchObject({
        claimed: true,
        alreadyClaimed: true,
        amountMicros: 1_000_000,
        ledgerId: trialLedger.id,
        promotional: true,
        refundable: false,
      });
      expect(await f.engine.getBalance(f.principal.workspaceId)).toEqual({
        availableMicros: 1_000_000,
        reservedMicros: 0,
        currency: 'USD',
      });

      // Non-refundability DB guard (028/030): PostgreSQL rejects binding a staff cash refund case to a trial-credit reference.
      await expect(
        f.engine.pool.query(
          `INSERT INTO mr_staff_refund_cases(
            id,workspace_id,order_id,processor_environment_id,processor_account_id,livemode,
            payment_intent_id,credit_reference,original_amount_cents,origin,request_version,
            conversion_version,reference,request_hash,frozen_body,worksheet,worksheet_hash,
            external_other_returns_cents,eligible_micros,cash_cents,principal_claim_cents,
            rounding_expense_micros,state,dispatch_key
          ) VALUES(
            $1,$2,$3,'trial-runtime-fixture','acct_trialfixture',false,
            'pi_trial_forged',$4,500,'new','staff-refund-original-v1',
            'usd-ceil-cent-v1','refund-trial-attempt',$5,'{}','{}',$5,
            0,1000000,100,100,0,'prepared','dispatch-trial-forged'
          )`,
          [randomUUID(), f.principal.workspaceId, randomUUID(), expectedRef, 'c'.repeat(64)],
        ),
      ).rejects.toThrow(/check constraint|foreign key/i);

      // 031 aged-cost-relief guard: trial credit is strictly classified as noncash (originalPayment: null) and rejected if claimed as paid.
      const agedJobId = randomUUID();
      await f.engine.pool.query(
        `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,attempt_count)
         VALUES($1,$2,'aged-trial-job','hash-aged','{"billing":"managed"}','{"id":"r"}','{"id":"d"}','submission-unknown',1000000,1)`,
        [agedJobId, f.principal.workspaceId],
      );
      const liabilitySince = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await f.engine.pool.query(
        `INSERT INTO mr_attempts(id,job_id,number,route_id,deployment_id,state,started_at)
         VALUES($1,$2,1,'r','d','submission-unknown',$3)`,
        [randomUUID(), agedJobId, liabilitySince],
      );
      const reserveRow = (
        await f.engine.pool.query<{ posting_order: string }>(
          `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
           VALUES($1,$2,$3,'reserve',1000000,-1000000,1000000) RETURNING posting_order::text`,
          [randomUUID(), f.principal.workspaceId, agedJobId],
        )
      ).rows[0]!;
      const trialPostingOrder = (
        await f.engine.pool.query<{ posting_order: string }>(
          'SELECT posting_order::text FROM mr_ledger WHERE id=$1',
          [trialLedger.id],
        )
      ).rows[0]!.posting_order;
      const fakePaidAllocation = [
        {
          sourceLedgerId: trialLedger.id,
          sourceReference: expectedRef,
          amountMicros: 1_000_000,
          sourceAmountMicros: 1_000_000,
          sourcePostingOrder: trialPostingOrder,
          reservationPostingOrder: reserveRow.posting_order,
          chronologyBasis: 'recorded-posting-order',
          character: 'paid',
          originalPayment: null,
        },
      ];
      await expect(
        f.engine.pool.query(
          `INSERT INTO mr_aged_cost_reliefs(
            job_id,workspace_id,reference,request_hash,policy_version,snapshot_hash,snapshot,
            allocation,amount_micros,credit_ledger_id,approval_reference,approval_hash,actor,note,evidence_url,liability_since
          ) VALUES($1,$2,'relief-paid-forged',$3,'v1',$3,$4,$5,1000000,$6,'app-ref',$3,'{"id":"op"}','note','https://example.invalid/e',$7)`,
          [
            agedJobId,
            f.principal.workspaceId,
            'd'.repeat(64),
            JSON.stringify({ allocation: fakePaidAllocation }),
            JSON.stringify(fakePaidAllocation),
            trialLedger.id,
            liabilitySince,
          ],
        ),
      ).rejects.toThrow(/aged_cost_relief_noncash_identity/);
    } finally {
      await f.close();
    }
  });
});
