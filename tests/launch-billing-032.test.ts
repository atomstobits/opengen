import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  activeMandateInTransaction,
  AgedCostReliefStore,
  BILLING_POLICY_DEFAULTS,
  BILLING_POLICY_LIMITS,
  BILLING_STRIPE_API_VERSION,
  BillingCustomerStore,
  BillingPolicyStore,
  calculateProcessingFee,
  centsToMicros,
  createEngine,
  creditWorkspaceInTransaction,
  MAX_TOPUP_CENTS,
  MIN_TOPUP_CENTS,
  PaymentStore,
  projectBillingPrincipal,
  projectStoredBillingSetupPrincipal,
  readBillingOwnerInTransaction,
  readBillingOwnerSummaryInTransaction,
  RechargeStore,
  registerBillingProcessorEnvironmentInTransaction,
  revalidateBillingAuthority,
  STAFF_REFUND_MAX_AMOUNT_CENTS,
  STAFF_REFUND_MAX_ELIGIBLE_MICROS,
  StaffRefundStore,
  staffRefundHash,
  STRIPE_DOMESTIC_FEE_BPS,
  STRIPE_FIXED_FEE_CENTS,
  STRIPE_INTERNATIONAL_FEE_BPS,
  type BillingProcessorEnvironment,
  type CheckoutOrder,
  type CheckoutSession,
  type CustomerTransport,
  type PaymentTransport,
  type RechargeAttemptRequest,
  type RechargePayment,
  type SetupSession,
} from '@media-router/engine';
import { normalizeStaffRefundEvidence } from '../packages/engine/src/staff-refund-evidence.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const migrationSql = (name: string) =>
  readFile(new URL(`../packages/engine/migrations/${name}`, import.meta.url), 'utf8');

describe('exact integer processing fee gross-up calculator', () => {
  it('exports launch limits and exact US vs non-US ceiling gross-up breakdowns', () => {
    expect(MIN_TOPUP_CENTS).toBe(500);
    expect(MAX_TOPUP_CENTS).toBe(999900);
    expect(BILLING_POLICY_LIMITS.maxAmountCents).toBe(999900);
    expect(STAFF_REFUND_MAX_AMOUNT_CENTS).toBe(999900);
    expect(STAFF_REFUND_MAX_ELIGIBLE_MICROS).toBe(9_999_000_000);
    expect(STRIPE_DOMESTIC_FEE_BPS).toBe(290);
    expect(STRIPE_INTERNATIONAL_FEE_BPS).toBe(440);
    expect(STRIPE_FIXED_FEE_CENTS).toBe(30);

    // $5.00
    expect(calculateProcessingFee(500)).toEqual({
      creditCents: 500,
      feeCents: 46,
      totalChargeCents: 546,
      feeRateBps: 290,
    });
    expect(calculateProcessingFee(500, 'US')).toEqual({
      creditCents: 500,
      feeCents: 46,
      totalChargeCents: 546,
      feeRateBps: 290,
    });
    expect(calculateProcessingFee(500, null)).toEqual({
      creditCents: 500,
      feeCents: 46,
      totalChargeCents: 546,
      feeRateBps: 290,
    });
    expect(calculateProcessingFee(500, 'GB')).toEqual({
      creditCents: 500,
      feeCents: 55,
      totalChargeCents: 555,
      feeRateBps: 440,
    });

    // $100.00
    expect(calculateProcessingFee(10000, 'US')).toEqual({
      creditCents: 10000,
      feeCents: 330,
      totalChargeCents: 10330,
      feeRateBps: 290,
    });
    expect(calculateProcessingFee(10000, 'DE')).toEqual({
      creditCents: 10000,
      feeCents: 492,
      totalChargeCents: 10492,
      feeRateBps: 440,
    });

    // $9,999.00
    expect(calculateProcessingFee(999900, 'US')).toEqual({
      creditCents: 999900,
      feeCents: 29895,
      totalChargeCents: 1029795,
      feeRateBps: 290,
    });
    expect(calculateProcessingFee(999900, 'SG')).toEqual({
      creditCents: 999900,
      feeCents: 46052,
      totalChargeCents: 1045952,
      feeRateBps: 440,
    });

    // Fallback to domestic 290 bps when cardCountry is absent or non-ISO-alpha-2
    for (const unknownCountry of [undefined, null, '', 'us', 'USA', '12']) {
      expect(calculateProcessingFee(2500, unknownCountry).feeRateBps).toBe(290);
    }
  });

  it('satisfies exact minimal integer ceiling across boundary and prime cent amounts', () => {
    for (const creditCents of [500, 501, 999, 1000, 2500, 10000, 100001, 543217, 999899, 999900]) {
      for (const [country, denom] of [
        ['US', 971],
        ['JP', 956],
      ] as const) {
        const breakdown = calculateProcessingFee(creditCents, country);
        expect(breakdown.totalChargeCents).toBe(breakdown.creditCents + breakdown.feeCents);
        expect(breakdown.totalChargeCents * denom).toBeGreaterThanOrEqual(
          (creditCents + 30) * 1000,
        );
        expect((breakdown.totalChargeCents - 1) * denom).toBeLessThan((creditCents + 30) * 1000);
      }
    }

    for (const invalid of [0, -500, 499, 999901, 1000.5, NaN, Infinity]) {
      expect(() => calculateProcessingFee(invalid)).toThrow(/\$5 and \$9,999/);
      expect(() => centsToMicros(invalid)).toThrow(/\$5 and \$9,999/);
    }
  });
});

describe.skipIf(!databaseUrl)('migration 032 upgrade and launch billing domain contracts', () => {
  it('upgrades populated 031 schema to 032 preserving historical zero-fee orders, recharges and defaults', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'launch032_upg');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        statusPoolSize: 1,
        providerExecutionEnabled: false,
        adapters: [],
        providerEnv: {},
      }),
    );
    try {
      const db = engine.pool;
      await db.query(
        'CREATE TABLE mr_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const priorChecksums: { name: string; checksum: string }[] = [];
      for (let index = 1; index <= 31; index++) {
        const name = `${String(index).padStart(3, '0')}.sql`;
        const sql = await migrationSql(name);
        const checksum = sha256(sql);
        priorChecksums.push({ name, checksum });
        await db.query(sql);
        await db.query('INSERT INTO mr_migrations(name,checksum) VALUES($1,$2)', [name, checksum]);
      }

      const workspace = `ws_031_${randomUUID()}`;
      const env: BillingProcessorEnvironment = {
        id: 'sandbox-031-upgrade',
        accountId: 'acct_031upgrade',
        livemode: false,
      };
      await db.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [workspace]);
      await registerBillingProcessorEnvironmentInTransaction(db, env);

      const memberId = randomUUID();
      const customerRowId = randomUUID();
      const customerId = 'cus_031upgrade';
      const setupId = randomUUID();
      const mandateId = randomUUID();
      const v1OrderId = randomUUID();
      const v2OrderId = randomUUID();
      const v1AttemptId = randomUUID();

      await db.query(
        "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://issuer.invalid','sub-031','admin',now())",
        [memberId, workspace],
      );
      const epoch = (
        await db.query<{ epoch: string }>(
          'SELECT extract(epoch FROM accepted_at)::text AS epoch FROM mr_memberships WHERE id=$1',
          [memberId],
        )
      ).rows[0]!.epoch;
      await db.query(
        `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,processor_environment_id,livemode,rails,consent_reference,approval_reference)
         VALUES($1,$2,$3,1,$4,false,'{"allowsEnabled":true,"maxThresholdMicros":100000000,"maxAmountCents":10000,"maxMonthlyCapCents":100000,"maxAttemptsPerMonth":10,"minCooldownSeconds":60,"maxFailureLimit":3}','consent-031','approval-031')`,
        [workspace, memberId, epoch, env.id],
      );
      await db.query(
        `INSERT INTO mr_billing_customers(id,workspace_id,livemode,processor_environment_id,processor_account_id,stripe_customer_id,status,stripe_idempotency_key,started_at)
         VALUES($1,$2,false,$3,$4,$5,'ready','cust-key-031',now())`,
        [customerRowId, workspace, env.id, env.accountId, customerId],
      );
      await db.query(
        `INSERT INTO mr_billing_setups(id,workspace_id,livemode,processor_environment_id,processor_account_id,customer_id,client_key,stripe_idempotency_key,session_id,status,terms_version,terms_snapshot,authority_snapshot,human_membership_id,consent_reference,owner_authority_version,owner_consent_reference,owner_membership_epoch,started_at,expires_at)
         VALUES($1,$2,false,$3,$4,$5,'setup-031','setup-idem-031','cs_setup_031','complete','v4','{}','{}',$6,'setup-consent-031',1,'consent-031',$7,now(),now()+interval '1 hour')`,
        [setupId, workspace, env.id, env.accountId, customerId, memberId, epoch],
      );
      await db.query(
        `INSERT INTO mr_billing_mandates(id,workspace_id,customer_id,payment_method_id,livemode,status,processor_environment_id,processor_account_id,terms_version,terms_snapshot,consent_reference,human_membership_id,setup_id,owner_authority_version,owner_consent_reference,owner_membership_epoch)
         VALUES($1,$2,$3,'pm_031',false,'active',$4,$5,'v4','{}','setup-consent-031',$6,$7,1,'consent-031',$8)`,
        [mandateId, workspace, customerId, env.id, env.accountId, memberId, setupId, epoch],
      );
      await db.query(
        `INSERT INTO mr_billing_policies(workspace_id,enabled,threshold_micros,amount_cents,monthly_cap_cents,max_attempts_per_month,cooldown_seconds,failure_limit,mandate_id,owner_authority_version,version)
         VALUES($1,true,5000000,1000,10000,5,60,3,$2,1,1)`,
        [workspace, mandateId],
      );

      // Credited pre-032 order + ownership + ledger
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,stripe_idempotency_key,integration_identifier,session_id,payment_intent_id,credited_at,processor_environment_id,processor_account_id)
         VALUES($1,$2,'order-v1-031',2000,20000000,false,'credited','idem-v1-031','integ_v1','cs_v1_031','pi_v1_031',now(),$3,$4)`,
        [v1OrderId, workspace, env.id, env.accountId],
      );
      await db.query(
        `INSERT INTO mr_billing_payment_ownership(processor_environment_id,livemode,payment_intent_id,workspace_id,kind,local_id,manual_order_id,amount_cents,credit_reference)
         VALUES($1,false,'pi_v1_031',$2,'manual',$3,$3,2000,$4)`,
        [env.id, workspace, v1OrderId, `stripe-topup:${v1OrderId}`],
      );
      await creditWorkspaceInTransaction(
        db as never,
        workspace,
        20_000_000,
        `stripe-topup:${v1OrderId}`,
      );

      // In-flight v2 order before upgrade
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,status,stripe_idempotency_key,integration_identifier,checkout_request_version,processor_environment_id,processor_account_id)
         VALUES($1,$2,'order-v2-031',1500,15000000,false,'created','idem-v2-031','integ_v2','checkout_hosted_page_v2',$3,$4)`,
        [v2OrderId, workspace, env.id, env.accountId],
      );

      // Historical v1 recharge attempt
      await db.query(
        `INSERT INTO mr_billing_recharge_attempts(id,workspace_id,policy_version,policy_snapshot,mandate_id,customer_id,payment_method_id,livemode,processor_environment_id,processor_account_id,amount_cents,admission_month,status,stripe_idempotency_key,request_version)
         VALUES($1,$2,1,'{}',$3,$4,'pm_031',false,$5,$6,1000,'2026-11-01','queued','idem-rech-031','recharge_pi_v1')`,
        [v1AttemptId, workspace, mandateId, customerId, env.id, env.accountId],
      );

      // Run forward upgrade to 032
      await engine.initialize();

      const applied = (
        await db.query<{ name: string; checksum: string }>(
          'SELECT name,checksum FROM mr_migrations ORDER BY name',
        )
      ).rows;
      expect(applied).toHaveLength(32);
      expect(applied.slice(0, 31)).toEqual(priorChecksums);
      expect(applied[31]).toEqual({
        name: '032.sql',
        checksum: sha256(await migrationSql('032.sql')),
      });

      const upgradedOrders = (
        await db.query(
          'SELECT id,amount_cents,fee_cents,fee_rate_bps,total_charge_cents,checkout_request_version FROM mr_payment_orders ORDER BY amount_cents',
        )
      ).rows;
      expect(upgradedOrders).toEqual([
        {
          id: v2OrderId,
          amount_cents: 1500,
          fee_cents: 0,
          fee_rate_bps: 0,
          total_charge_cents: 1500,
          checkout_request_version: 'checkout_hosted_page_v2',
        },
        {
          id: v1OrderId,
          amount_cents: 2000,
          fee_cents: 0,
          fee_rate_bps: 0,
          total_charge_cents: 2000,
          checkout_request_version: 'checkout_hosted_v1',
        },
      ]);

      expect(
        (
          await db.query(
            'SELECT amount_cents,fee_cents,fee_rate_bps,total_charge_cents,request_version FROM mr_billing_recharge_attempts WHERE id=$1',
            [v1AttemptId],
          )
        ).rows[0],
      ).toEqual({
        amount_cents: 1000,
        fee_cents: 0,
        fee_rate_bps: 0,
        total_charge_cents: 1000,
        request_version: 'recharge_pi_v1',
      });

      expect(
        (
          await db.query(
            'SELECT amount_cents,fee_cents,total_charge_cents FROM mr_billing_payment_ownership WHERE payment_intent_id=$1',
            ['pi_v1_031'],
          )
        ).rows[0],
      ).toEqual({
        amount_cents: 2000,
        fee_cents: 0,
        total_charge_cents: 2000,
      });

      expect(
        (await db.query('SELECT card_country FROM mr_billing_mandates WHERE id=$1', [mandateId]))
          .rows[0]!.card_country,
      ).toBeNull();

      // Legacy writer safety: omitting fee/total_charge/request_version keeps v1 defaults
      const legacyId = randomUUID();
      await db.query(
        `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier)
         VALUES($1,$2,'legacy-writer-after-032',500,5000000,false,'legacy-idem-after-032','legacy_integ')`,
        [legacyId, workspace],
      );
      expect(
        (
          await db.query(
            'SELECT checkout_request_version,fee_cents,fee_rate_bps,total_charge_cents FROM mr_payment_orders WHERE id=$1',
            [legacyId],
          )
        ).rows[0],
      ).toEqual({
        checkout_request_version: 'checkout_hosted_v1',
        fee_cents: 0,
        fee_rate_bps: 0,
        total_charge_cents: 500,
      });

      // Mismatched total_charge_cents or invalid card_country fail CHECK constraints
      await expect(
        db.query(
          `INSERT INTO mr_payment_orders(id,workspace_id,client_key,amount_cents,fee_cents,fee_rate_bps,total_charge_cents,credit_micros,livemode,stripe_idempotency_key,integration_identifier)
           VALUES($1,$2,'bad-total',500,46,290,500,5000000,false,'bad-total-idem','bad_integ')`,
          [randomUUID(), workspace],
        ),
      ).rejects.toThrow();
      await expect(
        db.query("UPDATE mr_billing_mandates SET card_country='usa' WHERE id=$1", [mandateId]),
      ).rejects.toThrow();

      // In-flight v2 zero-fee order still dispatches and credits cleanly after upgrade
      const payments = new PaymentStore(db, {
        livemode: false,
        processorEnvironment: env,
        creditInTransaction: creditWorkspaceInTransaction,
      });
      const v2Session: CheckoutSession = {
        id: 'cs_test_v2_recovery',
        mode: 'payment',
        currency: 'usd',
        amount_subtotal: 1500,
        amount_total: 1500,
        payment_status: 'paid',
        status: 'complete',
        client_reference_id: v2OrderId,
        payment_intent: 'pi_v2_recovery',
        livemode: false,
        url: 'https://checkout.stripe.com/c/pay/v2_recovery',
      };
      const v2Transport: PaymentTransport = {
        processorEnvironment: env,
        assertProcessorEnvironment() {},
        createSession: async (order) => {
          expect(order.requestVersion).toBe('checkout_hosted_page_v2');
          expect(order.feeCents).toBe(0);
          expect(order.totalChargeCents).toBe(1500);
          return v2Session;
        },
        retrieveSession: async () => v2Session,
      };
      await payments.checkout(workspace, v2OrderId, v2Transport);
      await payments.reconcile(
        {
          id: 'evt_v2_paid',
          type: 'checkout.session.completed',
          livemode: false,
          processorEnvironment: env,
          data: { object: { ...v2Session } },
        },
        v2Transport,
      );
      expect((await engine.getBalance(workspace)).availableMicros).toBe(35_000_000);
    } finally {
      await engine.close();
      await isolated.close();
    }
  });

  it('supports owner summary across revocation, $9,999 Checkout v3, BIN country capture, US vs non-US recharge v2, 030 refund and 031 aged-cost relief', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'launch032_e2e');
    const routeId = 'xai-undisclosed/xai-grok-imagine-image-2.0';
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        poolSize: 1,
        statusPoolSize: 1,
        storage: privateStorageFixture(),
        vaultKey: 'ab'.repeat(32),
        providerEnv: {},
        pollIntervalMs: 0,
        adapters: [
          {
            id: 'xai',
            isConfigured: (route) => route.id === routeId,
            submit: async ({ jobId }) => ({ upstreamId: `up-${jobId}` }),
            poll: async () => ({ status: 'running' }),
          },
        ],
      }),
    );
    try {
      await engine.initialize();
      const db = engine.pool;
      const env: BillingProcessorEnvironment = {
        id: 'launch-sandbox-env',
        accountId: 'acct_launch032',
        livemode: false,
      };
      await registerBillingProcessorEnvironmentInTransaction(db, env);

      const adminA = await engine.accounts.identity('https://auth.fixture.invalid', 'admin-a');
      const workspaceId = adminA.workspaceId;

      // 1. Owner summary before enrollment, while active, and after revocation
      expect(await readBillingOwnerSummaryInTransaction(db as never, workspaceId, env)).toEqual({
        owner: null,
        hasActiveOwner: false,
        currentAuthorityVersion: 0,
      });

      const fullRails = {
        allowsEnabled: true,
        maxThresholdMicros: BILLING_POLICY_LIMITS.maxThresholdMicros,
        maxAmountCents: 999900,
        maxMonthlyCapCents: BILLING_POLICY_LIMITS.maxMonthlyCapCents,
        maxAttemptsPerMonth: BILLING_POLICY_LIMITS.maxAttemptsPerMonth,
        minCooldownSeconds: BILLING_POLICY_LIMITS.minCooldownSeconds,
        maxFailureLimit: BILLING_POLICY_LIMITS.maxFailureLimit,
      };
      const policies = new BillingPolicyStore(db, {
        revalidateAuthority: revalidateBillingAuthority,
        approveOwner: async (_client, actor) => ({
          principal: actor,
          approvalReference: `self-serve-approval:${actor.membershipId}`,
          processorEnvironmentId: env.id,
        }),
      });
      const enrolled1 = await policies.establishOwner(adminA, {
        expectedAuthorityVersion: 0,
        rails: fullRails,
        processorEnvironmentId: env.id,
        livemode: false,
        consentReference: 'owner-consent-v1',
      });
      expect(enrolled1.authorityVersion).toBe(1);
      expect(await readBillingOwnerSummaryInTransaction(db as never, workspaceId, env)).toEqual({
        owner: enrolled1,
        hasActiveOwner: true,
        currentAuthorityVersion: 1,
      });

      // Revoke owner and confirm currentAuthorityVersion remains 1 so re-enrollment uses 1 -> 2
      await db.query(
        'UPDATE mr_billing_owners SET revoked_at=clock_timestamp() WHERE workspace_id=$1',
        [workspaceId],
      );
      expect(await readBillingOwnerInTransaction(db as never, workspaceId)).toBeNull();
      expect(await readBillingOwnerSummaryInTransaction(db as never, workspaceId, env)).toEqual({
        owner: null,
        hasActiveOwner: false,
        currentAuthorityVersion: 1,
      });
      const enrolled2 = await policies.establishOwner(adminA, {
        expectedAuthorityVersion: 1,
        rails: fullRails,
        processorEnvironmentId: env.id,
        livemode: false,
        consentReference: 'owner-consent-v2',
      });
      expect(enrolled2.authorityVersion).toBe(2);

      // 2. $9,999.00 manual Checkout v3 order: charges $10,297.95, credits $9,999.00
      const payments = new PaymentStore(db, {
        livemode: false,
        processorEnvironment: env,
        creditInTransaction: creditWorkspaceInTransaction,
      });
      const maxOrder = await payments.createOrder(workspaceId, 999900, 'max-topup-9999');
      expect(maxOrder).toMatchObject({
        amountCents: 999900,
        feeCents: 29895,
        totalChargeCents: 1029795,
        feeRateBps: 290,
        creditMicros: 9_999_000_000,
      });

      let capturedCheckoutOrder: CheckoutOrder | undefined;
      const sessions = new Map<string, CheckoutSession>();
      const manualTransport: PaymentTransport = {
        processorEnvironment: env,
        assertProcessorEnvironment() {},
        createSession: async (order) => {
          capturedCheckoutOrder = order;
          const session: CheckoutSession = {
            id: `cs_test_${order.id.replaceAll('-', '')}`,
            mode: 'payment',
            currency: 'usd',
            amount_subtotal: order.totalChargeCents,
            amount_total: order.totalChargeCents,
            payment_status: 'unpaid',
            status: 'open',
            client_reference_id: order.id,
            payment_intent: null,
            livemode: false,
            url: 'https://checkout.stripe.com/c/pay/max_9999',
          };
          sessions.set(session.id, session);
          return { ...session };
        },
        retrieveSession: async (id) => ({ ...sessions.get(id)! }),
      };

      await payments.checkout(workspaceId, maxOrder.id, manualTransport);
      expect(capturedCheckoutOrder).toMatchObject({
        requestVersion: 'checkout_hosted_page_fee_v3',
        apiVersion: BILLING_STRIPE_API_VERSION,
        amountCents: 999900,
        feeCents: 29895,
        totalChargeCents: 1029795,
        feeRateBps: 290,
      });

      const maxSession = sessions.get(`cs_test_${maxOrder.id.replaceAll('-', '')}`)!;
      const maxPi = 'pi_max9999manual';
      Object.assign(maxSession, {
        status: 'complete',
        payment_status: 'paid',
        payment_intent: maxPi,
      });

      // Rejects webhook if Stripe session amount_total only equals principal instead of totalChargeCents
      await expect(
        payments.reconcile(
          {
            id: 'evt_wrong_subtotal',
            type: 'checkout.session.completed',
            livemode: false,
            processorEnvironment: env,
            data: { object: { ...maxSession, amount_subtotal: 999900, amount_total: 999900 } },
          },
          manualTransport,
        ),
      ).rejects.toMatchObject({ code: 'session_mismatch' });

      await payments.reconcile(
        {
          id: 'evt_max_9999_paid',
          type: 'checkout.session.completed',
          livemode: false,
          processorEnvironment: env,
          data: { object: { ...maxSession } },
        },
        manualTransport,
      );

      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(9_999_000_000);
      expect(
        (
          await db.query(
            'SELECT amount_cents,fee_cents,total_charge_cents FROM mr_billing_payment_ownership WHERE payment_intent_id=$1',
            [maxPi],
          )
        ).rows[0],
      ).toEqual({
        amount_cents: 999900,
        fee_cents: 29895,
        total_charge_cents: 1029795,
      });

      // 3. Saved-card setup with BIN country ('GB' non-US vs 'US') + Recharge v2
      const actor = await projectBillingPrincipal(db, adminA, true);
      let simulatedCardCountry: string | null = 'gb';
      const setupSessions = new Map<string, SetupSession>();
      const customerTransport: CustomerTransport = {
        processorEnvironment: env,
        assertProcessorEnvironment() {},
        createCustomer: async () => ({ id: 'cus_launch_e2e', livemode: false }),
        retrieveCustomer: async (id) => ({ id, livemode: false }),
        createSetup: async (req) => {
          const s: SetupSession = {
            id: `cs_setup_${req.id.replaceAll('-', '')}`,
            mode: 'setup',
            customer: req.customerId,
            livemode: false,
            status: 'open',
            client_reference_id: req.id,
            setup_intent: `seti_${req.id.replaceAll('-', '')}`,
            url: 'https://checkout.stripe.com/c/pay/setup_e2e',
          };
          setupSessions.set(s.id, s);
          return { ...s };
        },
        retrieveSetup: async (id) => ({ ...setupSessions.get(id)!, status: 'complete' }),
        retrieveSetupIntent: async (id) => ({
          id,
          customer: 'cus_launch_e2e',
          payment_method: `pm_${id.slice(5)}`,
          livemode: false,
          status: 'succeeded',
          usage: 'off_session',
        }),
        retrievePaymentMethod: async (id) => ({
          id,
          customer: 'cus_launch_e2e',
          livemode: false,
          cardCountry: simulatedCardCountry,
        }),
        createPortal: async (customerId) => ({
          customerId,
          url: 'https://billing.stripe.com/p/session/test',
        }),
        listDocuments: async () => ({ data: [], hasMore: false, nextCursor: null }),
      };

      const customers = new BillingCustomerStore(db, {
        processorEnvironment: env,
        terms: { version: 'hosted-terms-v5-2026-11-16', text: 'Launch terms v5.' },
        authorize: (client, a, scope) => policies.authorizeInTransaction(client, a, scope),
        authorizeStoredSetup: async (client, ws, setupId) =>
          policies.authorizeInTransaction(
            client,
            await projectStoredBillingSetupPrincipal(client, ws, setupId),
            'billing:manage',
          ),
        lockExternalInTransaction: (client) => payments.lockExternalInTransaction(client),
        admitExternalInTransaction: (client, ws) => payments.admitExternalInTransaction(client, ws),
      });

      const setup = await customers.startSetup(
        actor,
        workspaceId,
        {
          idempotencyKey: 'setup-intl-card-key',
          consent: true,
          termsVersion: 'hosted-terms-v5-2026-11-16',
        },
        customerTransport,
      );
      const storedSetupSession = [...setupSessions.values()][0]!;
      await customers.reconcileSetup(
        {
          id: 'evt_setup_intl_complete',
          type: 'checkout.session.completed',
          livemode: false,
          processorEnvironment: env,
          data: { object: { ...storedSetupSession, status: 'complete' } },
        },
        customerTransport,
      );

      const completedSetup = await customers.getSetup(actor, workspaceId, setup.id);
      expect(completedSetup.status).toBe('complete');
      expect(completedSetup.cardCountry).toBe('GB');
      const activeMandate = await customers.getMandate(actor, workspaceId);
      expect(activeMandate).toEqual({
        id: completedSetup.mandateId,
        status: 'active',
        cardCountry: 'GB',
      });
      expect(
        await activeMandateInTransaction(db, {
          workspaceId,
          owner: enrolled2,
          humanMembershipId: adminA.membershipId,
        }),
      ).toEqual(activeMandate);

      // Enable auto-recharge for $100.00 (10000 cents) when balance < $10,000.00 (10_000_000_000 micros)
      await policies.updatePolicy(actor, {
        expectedVersion: 0,
        expectedAuthorityVersion: 2,
        consentReference: 'enable-intl-autorecharge',
        policy: {
          ...BILLING_POLICY_DEFAULTS,
          enabled: true,
          thresholdMicros: 10_000_000_000,
          amountCents: 10000,
          monthlyCapCents: 999900,
          mandateId: activeMandate!.id,
        },
      });

      const recharge = new RechargeStore(db, {
        processorEnvironment: env,
        automaticChargesEnabled: true,
        authenticationRecoveryEnabled: true,
        creditInTransaction: creditWorkspaceInTransaction,
        lockExternalInTransaction: (client) => payments.lockExternalInTransaction(client),
        admitExternalInTransaction: (client, ws) => payments.admitExternalInTransaction(client, ws),
      });

      const intlAttempt = (await recharge.admit(workspaceId))!;
      expect(intlAttempt).toMatchObject({
        amountCents: 10000,
        feeCents: 492,
        totalChargeCents: 10492,
        feeRateBps: 440,
        status: 'queued',
      });

      let capturedRechargeReq: RechargeAttemptRequest | undefined;
      const rechargePayments = new Map<string, RechargePayment>();
      const rechargeTransport = {
        processorEnvironment: env,
        assertProcessorEnvironment() {},
        createRecharge: async (req: RechargeAttemptRequest) => {
          capturedRechargeReq = req;
          const pi: RechargePayment = {
            id: 'pi_intl100recharge',
            customer: req.customerId,
            payment_method: req.paymentMethodId,
            currency: 'usd',
            amount: req.totalChargeCents,
            amount_received: 0,
            status: 'processing',
            livemode: false,
          };
          rechargePayments.set(pi.id, pi);
          return { ...pi };
        },
        retrieveRecharge: async (id: string) => ({ ...rechargePayments.get(id)! }),
      };

      await recharge.dispatch(intlAttempt.id, rechargeTransport);
      expect(capturedRechargeReq).toMatchObject({
        requestVersion: 'recharge_pi_fee_v2',
        amountCents: 10000,
        feeCents: 492,
        totalChargeCents: 10492,
        feeRateBps: 440,
      });

      const succeededPi: RechargePayment = {
        ...rechargePayments.get('pi_intl100recharge')!,
        status: 'succeeded',
        amount_received: 10492,
      };
      rechargePayments.set(succeededPi.id, succeededPi);
      await recharge.reconcile(
        {
          id: 'evt_intl_recharge_succeeded',
          type: 'payment_intent.succeeded',
          livemode: false,
          processorEnvironment: env,
          data: { object: { ...succeededPi } },
        },
        rechargeTransport,
      );

      // Wallet received 10000 * 10000 = 100_000_000 micros (NOT 10492 * 10000!)
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(
        9_999_000_000 + 100_000_000,
      );

      // 4. Compatibility with 031 AgedCostReliefStore on fee-bearing manual + recharge credits
      const manualLedger = (
        await db.query<{ id: string }>(
          'SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
          [workspaceId, `stripe-topup:${maxOrder.id}`],
        )
      ).rows[0]!;
      const rechargeLedger = (
        await db.query<{ id: string }>(
          'SELECT id FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
          [workspaceId, `stripe-recharge:${intlAttempt.id}`],
        )
      ).rows[0]!;

      const submittedJob = await engine.submit({
        workspaceId,
        idempotencyKey: 'relief-fee-compat-job',
        input: {
          modelId: 'xai/grok-imagine-image-2.0',
          routeId,
          operation: 'text-to-image',
          billing: 'managed',
          routing: { fallback: false },
          input: { prompt: 'Synthetic relief check.', count: 1 },
        },
      });
      await engine.workOnce();
      await db.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-interval '25 hours' WHERE job_id=$1",
        [submittedJob.id],
      );

      const reservedMicros = submittedJob.reservedMicros;
      const half = Math.floor(reservedMicros / 2);
      const rest = reservedMicros - half;
      const reliefStore = new AgedCostReliefStore(db, {
        activation: 'staff-approved',
        policyVersion: 'refunds-v5-2026-11-16',
        authorize: async () => ({ kind: 'installation-operator', id: 'staff-relief-op' }),
        approveRelief: async (_client, _ctx, req) => ({
          approvalReference: 'relief-approval-032',
          requestHash: req.requestHash,
        }),
        creditInTransaction: creditWorkspaceInTransaction,
      });

      const reliefAllocation = [
        { ledgerId: manualLedger.id, amountMicros: half },
        { ledgerId: rechargeLedger.id, amountMicros: rest },
      ];
      const reviewed = await reliefStore.review(
        { workspaceId, jobId: submittedJob.id, allocation: reliefAllocation },
        {},
      );
      expect(reviewed.allocation.map((a) => a.originalPayment?.originalAmountCents)).toEqual([
        999900, 10000,
      ]);
      const granted = await reliefStore.grant(
        {
          workspaceId,
          jobId: submittedJob.id,
          allocation: reliefAllocation,
          reference: 'relief-grant-032',
          note: 'Synthetic aged cost relief over fee-bearing funding.',
          evidenceUrl: 'https://support.opengen.invalid/relief/032',
          snapshotHash: reviewed.snapshotHash,
        },
        {},
      );
      expect(granted.amountMicros).toBe(reservedMicros);

      // Settle the aged job cleanly so no reserved exposure blocks full $9,999 refund test
      await engine.applyProviderResult(workspaceId, submittedJob.id, {
        status: 'failed',
        failureCategory: 'technical',
        billedCostMicros: 0,
      });

      // 5. Compatibility with 030 StaffRefundStore at $9,999.00 credit principal
      const staffRefunds = new StaffRefundStore(db, {
        activation: 'sandbox',
        processorEnvironment: env,
        authorize: async () => ({ id: 'staff-refund-op', kind: 'installation-operator' }),
        approveAllocation: async (_client, _ctx, req) => ({
          approvalReference: `alloc-approve:${req.operation}`,
          requestHash: req.requestHash,
        }),
      });

      // Rejects eligibleMicros > $9,999.00 credit principal (processing fee is nonrefundable)
      const preSnap = await staffRefunds.snapshot(workspaceId, {});
      const overPrincipalWorksheet = {
        snapshot: preSnap,
        externalReturns: [],
        allocationReference: 'alloc-over',
        originalPayerReference: 'payer-over',
        note: 'Attempt to refund fee above credit principal.',
        allocation: [
          {
            fundingReference: `stripe-topup:${maxOrder.id}`,
            disposition: 'eligible-paid' as const,
            amountMicros: 9_999_010_000,
          },
        ],
      };
      await expect(
        staffRefunds.prepare(
          {
            workspaceId,
            orderId: maxOrder.id,
            reference: 'case-over-principal',
            origin: 'new',
            eligibleMicros: 9_999_010_000,
            worksheet: overPrincipalWorksheet,
            worksheetHash: staffRefundHash(overPrincipalWorksheet),
          },
          {},
        ),
      ).rejects.toThrow();

      // Full $9,999.00 (9,999,000,000 micros = 999,900 cents) unused credit principal refund succeeds
      const validSnap = await staffRefunds.snapshot(workspaceId, {});
      const validWorksheet = {
        snapshot: validSnap,
        externalReturns: [],
        allocationReference: 'alloc-9999',
        originalPayerReference: 'payer-9999',
        note: 'Full unused $9,999 credit principal refund; upfront fee retained.',
        allocation: [
          {
            fundingReference: `stripe-topup:${maxOrder.id}`,
            disposition: 'eligible-paid' as const,
            amountMicros: 9_999_000_000,
          },
        ],
      };
      const prepared = await staffRefunds.prepare(
        {
          workspaceId,
          orderId: maxOrder.id,
          reference: 'case-9999-principal',
          origin: 'new',
          eligibleMicros: 9_999_000_000,
          worksheet: validWorksheet,
          worksheetHash: staffRefundHash(validWorksheet),
        },
        {},
      );
      expect(prepared.cashCents).toBe(999900);
      expect(prepared.eligibleMicros).toBe(9_999_000_000);

      const dispatchSnap = await staffRefunds.snapshot(workspaceId, {});
      const dispatchWorksheet = { ...validWorksheet, snapshot: dispatchSnap };
      const dispatched = await staffRefunds.dispatch(
        prepared.id,
        {
          reference: 'dispatch-9999',
          note: 'Claim single refund dispatch.',
          evidenceReference: 'ticket-9999',
          worksheet: dispatchWorksheet,
          worksheetHash: staffRefundHash(dispatchWorksheet),
        },
        {},
      );
      expect(dispatched.dispatchClaimed).toBe(true);

      const normalized = normalizeStaffRefundEvidence(
        {
          id: 'evt_refund_9999_ok',
          type: 'refund.updated',
          created: 1_800_000_000,
          livemode: false,
          processorEnvironment: env,
          data: {
            object: {
              id: 're_9999principal',
              object: 'refund',
              payment_intent: maxPi,
              charge: 'ch_9999principal',
              amount: 999900,
              currency: 'usd',
              status: 'succeeded',
              livemode: false,
            },
          },
        },
        env,
        {
          workspaceId,
          orderId: maxOrder.id,
          processorEnvironmentId: env.id,
          processorAccountId: env.accountId,
          livemode: false,
          paymentIntentId: maxPi,
          chargeId: null,
          amountCents: 999900,
          currency: 'USD',
        },
      );
      expect(normalized.kind).toBe('refund');
      if (normalized.kind !== 'refund') throw new Error('Expected refund evidence.');

      await staffRefunds.observeVerifiedProcessorEvidence(
        prepared.id,
        normalized.evidence,
        {
          reference: 'observe-9999',
          note: 'Observed succeeded $9,999 principal refund.',
          evidenceReference: 'stripe-event:evt_refund_9999_ok',
        },
        {},
      );

      const applySnap = await staffRefunds.snapshot(workspaceId, {});
      const applyWorksheet = {
        ...validWorksheet,
        snapshot: applySnap,
        externalReturns: [
          {
            refundId: 're_9999principal',
            amountCents: 999900,
            status: 'succeeded' as const,
            evidenceReference: 'stripe-event:evt_refund_9999_ok',
          },
        ],
      };
      const applied = await staffRefunds.reconcile(
        prepared.id,
        {
          action: 'apply-success',
          reference: 'apply-9999',
          note: 'Debit $9,999 refunded credit principal.',
          evidenceReference: 'stripe-event:evt_refund_9999_ok',
          worksheet: applyWorksheet,
          worksheetHash: staffRefundHash(applyWorksheet),
          resolveHoldIds: dispatched.holdIds,
          holdResolutionEvidenceUrl: 'https://support.opengen.invalid/refunds/9999',
        },
        {},
      );
      expect(applied.state).toBe('succeeded');
      expect(applied.financialState).toBe('debited');
      expect((await engine.getBalance(workspaceId)).availableMicros).toBe(100_000_000);
    } finally {
      await engine.close();
      await isolated.close();
    }
  });
});
