import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { BillingPrincipal, BillingPolicyAuthority } from './billing-policy.js';

export const BILLING_STRIPE_API_VERSION = '2026-10-28.endive' as const;
export interface BillingProcessorEnvironment {
  id: string;
  accountId: string;
  livemode: boolean;
}
export interface BillingProcessorTransport {
  readonly processorEnvironment: Readonly<BillingProcessorEnvironment>;
  assertProcessorEnvironment(): void;
}
export function validatedBillingProcessorEnvironment(
  environment: BillingProcessorEnvironment,
): Readonly<BillingProcessorEnvironment> {
  if (
    !environment ||
    typeof environment.id !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(environment.id) ||
    typeof environment.accountId !== 'string' ||
    !/^acct_[A-Za-z0-9]+$/.test(environment.accountId) ||
    typeof environment.livemode !== 'boolean'
  )
    throw new BillingCustomerError(
      'processor_environment_not_configured',
      'A valid Stripe processor environment is required.',
      503,
    );
  return Object.freeze({
    id: environment.id,
    accountId: environment.accountId,
    livemode: environment.livemode,
  });
}
export function sameBillingProcessorEnvironment(
  expected: BillingProcessorEnvironment,
  actual: BillingProcessorEnvironment | undefined,
): boolean {
  return (
    actual !== undefined &&
    actual !== null &&
    expected.id === actual.id &&
    expected.accountId === actual.accountId &&
    expected.livemode === actual.livemode
  );
}
export async function registerBillingProcessorEnvironmentInTransaction(
  client: Pick<PoolClient, 'query'>,
  input: BillingProcessorEnvironment,
): Promise<void> {
  const environment = validatedBillingProcessorEnvironment(input);
  await client.query(
    'INSERT INTO mr_billing_processor_environments(id,account_id,livemode) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [environment.id, environment.accountId, environment.livemode],
  );
  await assertBillingProcessorEnvironmentInTransaction(client, environment);
}
export async function assertBillingProcessorEnvironmentInTransaction(
  client: Pick<PoolClient, 'query'>,
  environment: BillingProcessorEnvironment,
): Promise<void> {
  const row = (
    await client.query<{ account_id: string; livemode: boolean }>(
      'SELECT account_id,livemode FROM mr_billing_processor_environments WHERE id=$1 FOR SHARE',
      [environment.id],
    )
  ).rows[0];
  if (!row || row.account_id !== environment.accountId || row.livemode !== environment.livemode)
    throw new BillingCustomerError(
      'processor_environment_mismatch',
      'Stripe processor environment binding requires review.',
      409,
    );
}
export function assertBillingProcessorTransport(
  expected: BillingProcessorEnvironment,
  transport: BillingProcessorTransport,
): void {
  if (!sameBillingProcessorEnvironment(expected, transport.processorEnvironment))
    throw new BillingCustomerError(
      'processor_environment_mismatch',
      'Stripe transport is configured for a different environment.',
      409,
    );
  transport.assertProcessorEnvironment();
}

export interface RechargeAttemptRequest {
  processorEnvironment: BillingProcessorEnvironment;
  requestVersion: 'recharge_pi_v1';
  apiVersion: typeof BILLING_STRIPE_API_VERSION;
  id: string;
  customerId: string;
  paymentMethodId: string;
  amountCents: number;
  stripeIdempotencyKey: string;
}
export interface RechargePayment {
  id: string;
  customer: string | null;
  payment_method: string | null;
  currency: string;
  amount: number;
  amount_received: number;
  /** Separate verified SCA signal; status remains the real Stripe status. */
  authentication_required?: boolean;
  status: string;
  livemode: boolean;
}
export interface RechargeTransport extends BillingProcessorTransport {
  createRecharge(attempt: RechargeAttemptRequest): Promise<RechargePayment>;
  retrieveRecharge(id: string): Promise<RechargePayment>;
}
export interface RechargeRecovery {
  payment: RechargePayment;
  /** Ephemeral owner-authorized response only: never persist, log or audit. */
  clientSecret: string;
  methodType: 'card';
}
export interface RechargeRecoveryTransport extends BillingProcessorTransport {
  retrieveRechargeRecovery(id: string): Promise<RechargeRecovery>;
}
export type CustomerActor = BillingPrincipal;
export interface BillingTerms {
  version: string;
  text: string;
}
export interface CustomerRequest {
  processorEnvironment: BillingProcessorEnvironment;
  requestVersion: 'customer_v1';
  apiVersion: typeof BILLING_STRIPE_API_VERSION;
  id: string;
  stripeIdempotencyKey: string;
}
export interface StripeCustomerReference {
  id: string;
  livemode: boolean;
  deleted?: boolean;
}
export interface SetupRequest {
  processorEnvironment: BillingProcessorEnvironment;
  requestVersion: 'setup_checkout_v1' | 'setup_checkout_v2';
  apiVersion: typeof BILLING_STRIPE_API_VERSION;
  id: string;
  customerId: string;
  stripeIdempotencyKey: string;
  expiresAt: number;
  integrationIdentifier: string;
}
export interface SetupSession {
  id: string;
  mode: string | null;
  customer: string | null;
  livemode: boolean;
  status: string | null;
  client_reference_id: string | null;
  setup_intent: string | null;
  url: string | null;
}
export interface SetupIntentReference {
  id: string;
  customer: string | null;
  payment_method: string | null;
  livemode: boolean;
  status: string;
  usage: string;
}
export interface PaymentMethodReference {
  id: string;
  customer: string | null;
  livemode: boolean;
}
export interface BillingDocument {
  type: 'receipt' | 'invoice';
  id: string;
  customerId: string;
  livemode: boolean;
  amountCents: number;
  currency: string;
  status: string;
  createdAt: string;
  url: string | null;
  pdfUrl: string | null;
}
export interface DocumentPage {
  data: BillingDocument[];
  hasMore: boolean;
  nextCursor: string | null;
}
export interface CustomerTransport extends BillingProcessorTransport {
  createCustomer(request: CustomerRequest): Promise<StripeCustomerReference>;
  retrieveCustomer(id: string): Promise<StripeCustomerReference>;
  createSetup(request: SetupRequest): Promise<SetupSession>;
  retrieveSetup(id: string): Promise<SetupSession>;
  retrieveSetupIntent(id: string): Promise<SetupIntentReference>;
  retrievePaymentMethod(id: string): Promise<PaymentMethodReference>;
  createPortal(customerId: string): Promise<{ customerId: string; url: string }>;
  listDocuments(
    customerId: string,
    input: { type: 'receipt' | 'invoice'; cursor?: string; limit: number },
  ): Promise<DocumentPage>;
}
export interface VerifiedSetupEvent {
  processorEnvironment: BillingProcessorEnvironment;
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}
export interface CustomerStoreOptions {
  processorEnvironment: BillingProcessorEnvironment;
  terms: BillingTerms;
  /** Revalidate the real source key/grant/membership on this client; never trust request JSON. */
  authorize(
    client: PoolClient,
    actor: CustomerActor,
    scope: 'billing:read' | 'billing:manage',
  ): Promise<BillingPolicyAuthority>;
  /** Re-authorize a durable setup from its stored row after verifying the original session.
   * A request-only browser proof cannot be reconstructed from serialized actor data. */
  authorizeStoredSetup?(
    client: PoolClient,
    workspaceId: string,
    setupId: string,
  ): Promise<BillingPolicyAuthority>;
  /** Required before external I/O: installation lock, workspace lock, durable shared payment quota. */
  lockExternalInTransaction(client: PoolClient): Promise<void>;
  admitExternalInTransaction(client: PoolClient, workspaceId: string): Promise<void>;
  /** Section11 portal capability is unresolved; deny unless the integrator opts in. */
  allowPortal?: boolean;
  now?: () => number;
}
export class BillingCustomerError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}
export interface SetupView {
  id: string;
  status: 'pending' | 'open' | 'complete' | 'expired' | 'review';
  checkoutUrl: string | null;
  termsVersion: string;
  consentReference: string;
  mandateId: string | null;
}
interface CustomerRow {
  processor_environment_id: string;
  processor_account_id: string;
  request_version: 'customer_v1';
  api_version: typeof BILLING_STRIPE_API_VERSION;
  id: string;
  workspace_id: string;
  livemode: boolean;
  stripe_customer_id: string | null;
  status: 'pending' | 'ready' | 'review';
  stripe_idempotency_key: string;
  started_at: Date;
  lease_until: Date | null;
}
interface SetupRow {
  processor_environment_id: string;
  processor_account_id: string;
  request_version: 'setup_checkout_v1' | 'setup_checkout_v2';
  api_version: typeof BILLING_STRIPE_API_VERSION;
  id: string;
  workspace_id: string;
  livemode: boolean;
  customer_id: string;
  client_key: string;
  stripe_idempotency_key: string;
  session_id: string | null;
  status: SetupView['status'];
  checkout_url: string | null;
  setup_intent_id: string | null;
  terms_version: string;
  terms_snapshot: BillingTerms;
  authority_snapshot: CustomerActor;
  owner_authority_version: number;
  owner_consent_reference: string;
  owner_membership_epoch: string;
  human_membership_id: string;
  consent_reference: string;
  mandate_id: string | null;
  expires_at: Date;
  started_at: Date;
  lease_until: Date | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const reference = (id: unknown, prefix: string): id is string =>
  typeof id === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id);
function setupView(row: SetupRow): SetupView {
  return {
    id: row.id,
    status: row.status,
    checkoutUrl: row.status === 'open' ? row.checkout_url : null,
    termsVersion: row.terms_version,
    consentReference: row.consent_reference,
    mandateId: row.mandate_id,
  };
}
function safeUrl(
  value: string | null,
  type: 'checkout' | 'portal' | 'receipt' | 'invoice',
): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    const hosts = {
      checkout: ['checkout.stripe.com'],
      portal: ['billing.stripe.com'],
      receipt: ['pay.stripe.com'],
      invoice: ['invoice.stripe.com', 'pay.stripe.com'],
    };
    if (
      url.protocol === 'https:' &&
      hosts[type].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.href;
  } catch {
    /* Reject untrusted link formats without echoing their values. */
  }
  throw new BillingCustomerError(
    'unsafe_billing_link',
    'The billing document or hosted link requires review.',
    502,
  );
}

/** Additive lifecycle store. No balance changes, automatic policy enablement or legacy-order edits. */
export class BillingCustomerStore {
  private readonly terms: BillingTerms;
  readonly processorEnvironment: Readonly<BillingProcessorEnvironment>;
  constructor(
    private readonly pool: Pool,
    private readonly options: CustomerStoreOptions,
  ) {
    if (
      !options.terms.version ||
      options.terms.version.length > 120 ||
      !options.terms.text ||
      options.terms.text.length > 20000
    )
      throw new Error('Billing setup requires a bounded, server-owned terms version and text.');
    this.processorEnvironment = validatedBillingProcessorEnvironment(options.processorEnvironment);
    this.terms = Object.freeze({ version: options.terms.version, text: options.terms.text });
  }
  private async lockMethod(client: PoolClient, methodId: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
      `opengen-billing-method:${this.processorEnvironment.id}`,
      methodId,
    ]);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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
  private async lock(client: PoolClient, workspaceId: string, external = false) {
    if (external) await this.options.lockExternalInTransaction(client);
    await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
    const result = await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [
      workspaceId,
    ]);
    if (!result.rowCount) throw new BillingCustomerError('not_found', 'Workspace not found.', 404);
  }
  private async authority(
    client: PoolClient,
    actor: CustomerActor,
    workspaceId: string,
    scope: 'billing:read' | 'billing:manage',
    human = false,
    setupId?: string,
  ) {
    if (actor.workspaceId !== workspaceId)
      throw new BillingCustomerError('workspace_changed', 'The selected workspace changed.', 409);
    const authorization =
      setupId && this.options.authorizeStoredSetup
        ? await this.options.authorizeStoredSetup(client, workspaceId, setupId)
        : await this.options.authorize(client, actor, scope);
    const current = authorization.principal;
    const owner = authorization.owner;
    if (
      !owner ||
      owner.workspaceId !== workspaceId ||
      owner.livemode !== this.processorEnvironment.livemode ||
      owner.processorEnvironmentId !== this.processorEnvironment.id ||
      !Number.isSafeInteger(owner.authorityVersion) ||
      owner.authorityVersion < 1 ||
      !owner.consentReference ||
      !owner.membershipEpoch
    )
      throw new BillingCustomerError(
        'billing_access_denied',
        'A current approved funding owner is required.',
        403,
      );
    if (current.workspaceId !== workspaceId || current.bootstrap || !current.scopes.includes(scope))
      throw new BillingCustomerError(
        'billing_access_denied',
        'Billing authority is required.',
        403,
      );
    if (
      human &&
      (actor.keyKind !== 'browser' ||
        current.keyKind !== 'browser' ||
        current.role !== 'admin' ||
        !current.membershipId ||
        current.membershipId !== actor.membershipId ||
        authorization.humanMembershipId !== current.membershipId ||
        owner.membershipId !== current.membershipId)
    )
      throw new BillingCustomerError(
        'human_admin_required',
        'A current workspace administrator must approve payment setup in the browser.',
        403,
      );
    return { ...current, billingOwner: owner };
  }
  private async customer(
    client: Pick<PoolClient, 'query'>,
    workspaceId: string,
  ): Promise<CustomerRow | undefined> {
    return (
      await client.query<CustomerRow>(
        'SELECT * FROM mr_billing_customers WHERE workspace_id=$1 AND processor_environment_id=$2',
        [workspaceId, this.processorEnvironment.id],
      )
    ).rows[0];
  }
  private checkCustomer(row: CustomerRow, customer: StripeCustomerReference) {
    if (
      !reference(customer.id, 'cus') ||
      customer.deleted ||
      customer.livemode !== row.livemode ||
      (row.stripe_customer_id && row.stripe_customer_id !== customer.id)
    )
      throw new BillingCustomerError(
        'customer_mismatch',
        'Billing customer identity requires review.',
        409,
      );
  }
  async ensureCustomer(
    actor: CustomerActor,
    workspaceId: string,
    transport: CustomerTransport,
  ): Promise<string> {
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    const row = await this.tx(async (client) => {
      await this.lock(client, workspaceId, true);
      await this.authority(client, actor, workspaceId, 'billing:manage', true);
      const existing = await this.customer(client, workspaceId);
      if (existing?.stripe_customer_id) return existing;
      const now = this.now();
      if (
        existing &&
        (existing.status === 'review' || now - existing.started_at.getTime() >= 20 * 3600000)
      )
        throw new BillingCustomerError(
          'customer_review',
          'Recover the original billing customer before retrying.',
          409,
        );
      if (existing?.lease_until && existing.lease_until.getTime() > now)
        throw new BillingCustomerError(
          'customer_in_progress',
          'Billing customer creation is in progress.',
          409,
        );
      await this.options.admitExternalInTransaction(client, workspaceId);
      if (existing)
        return (
          await client.query<CustomerRow>(
            'UPDATE mr_billing_customers SET lease_until=$2 WHERE id=$1 RETURNING *',
            [existing.id, new Date(now + 30000)],
          )
        ).rows[0]!;
      const id = randomUUID();
      return (
        await client.query<CustomerRow>(
          `INSERT INTO mr_billing_customers(id,workspace_id,livemode,stripe_idempotency_key,started_at,lease_until,processor_environment_id,processor_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            id,
            workspaceId,
            this.processorEnvironment.livemode,
            `opengen-customer-v1-${id}`,
            new Date(now),
            new Date(now + 30000),
            this.processorEnvironment.id,
            this.processorEnvironment.accountId,
          ],
        )
      ).rows[0]!;
    });
    if (row.stripe_customer_id) return row.stripe_customer_id;
    let external: StripeCustomerReference;
    try {
      external = await transport.createCustomer({
        processorEnvironment: {
          id: row.processor_environment_id,
          accountId: row.processor_account_id,
          livemode: row.livemode,
        },
        requestVersion: row.request_version,
        apiVersion: row.api_version,
        id: row.id,
        stripeIdempotencyKey: row.stripe_idempotency_key,
      });
    } catch {
      await this.pool.query('UPDATE mr_billing_customers SET lease_until=NULL WHERE id=$1', [
        row.id,
      ]);
      throw new BillingCustomerError(
        'customer_uncertain',
        'Retry this same billing customer request.',
        503,
      );
    }
    return this.tx(async (client) => {
      await this.lock(client, workspaceId);
      const current = (await this.customer(client, workspaceId))!;
      this.checkCustomer(current, external);
      await client.query(
        "UPDATE mr_billing_customers SET stripe_customer_id=$2,status='ready',lease_until=NULL WHERE id=$1",
        [row.id, external.id],
      );
      return external.id;
    });
  }
  async startSetup(
    actor: CustomerActor,
    workspaceId: string,
    input: { idempotencyKey: string; consent: boolean; termsVersion: string },
    transport: CustomerTransport,
  ): Promise<SetupView> {
    if (
      !/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey) ||
      input.consent !== true ||
      typeof input.termsVersion !== 'string' ||
      !input.termsVersion ||
      input.termsVersion.length > 120
    )
      throw new BillingCustomerError(
        'invalid_setup_consent',
        'Explicit approval of the current payment terms is required.',
      );
    // Validate the consent version before even creating an external Customer.
    // An existing uncertain setup may recover its original immutable terms after deployment.
    await this.tx(async (client) => {
      await this.lock(client, workspaceId);
      await this.authority(client, actor, workspaceId, 'billing:manage', true);
      const prior = (
        await client.query<SetupRow>(
          'SELECT * FROM mr_billing_setups WHERE workspace_id=$1 AND processor_environment_id=$2 AND client_key=$3',
          [workspaceId, this.processorEnvironment.id, input.idempotencyKey],
        )
      ).rows[0];
      if (
        prior &&
        !prior.session_id &&
        prior.status !== 'review' &&
        (prior.request_version !== 'setup_checkout_v2' ||
          prior.api_version !== BILLING_STRIPE_API_VERSION)
      )
        throw new BillingCustomerError(
          'unsupported_setup_request',
          'This historical payment setup requires operator review.',
          409,
        );
      if (input.termsVersion !== (prior?.terms_version ?? this.terms.version))
        throw new BillingCustomerError(
          prior ? 'idempotency_conflict' : 'invalid_setup_consent',
          'Approve the exact terms associated with this setup request.',
          prior ? 409 : 400,
        );
    });
    const customerId = await this.ensureCustomer(actor, workspaceId, transport);
    const row = await this.tx(async (client) => {
      await this.lock(client, workspaceId, true);
      const human = await this.authority(client, actor, workspaceId, 'billing:manage', true);
      if ((await this.customer(client, workspaceId))?.stripe_customer_id !== customerId)
        throw new BillingCustomerError('customer_mismatch', 'Billing customer changed.', 409);
      const prior = (
        await client.query<SetupRow>(
          'SELECT * FROM mr_billing_setups WHERE workspace_id=$1 AND processor_environment_id=$2 AND client_key=$3 FOR UPDATE',
          [workspaceId, this.processorEnvironment.id, input.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.terms_version !== input.termsVersion ||
          prior.human_membership_id !== human.membershipId
        )
          throw new BillingCustomerError(
            'idempotency_conflict',
            'Setup retry identity has different consent.',
            409,
          );
        if (prior.session_id || prior.status === 'review') return prior;
        if (
          prior.request_version !== 'setup_checkout_v2' ||
          prior.api_version !== BILLING_STRIPE_API_VERSION
        )
          throw new BillingCustomerError(
            'unsupported_setup_request',
            'This historical payment setup requires operator review.',
            409,
          );
        if (this.now() - prior.started_at.getTime() >= 20 * 3600000)
          throw new BillingCustomerError(
            'setup_review',
            'Recover the original setup before retrying.',
            409,
          );
        if (prior.lease_until && prior.lease_until.getTime() > this.now())
          throw new BillingCustomerError('setup_in_progress', 'Payment setup is in progress.', 409);
        await this.options.admitExternalInTransaction(client, workspaceId);
        return (
          await client.query<SetupRow>(
            'UPDATE mr_billing_setups SET lease_until=$2 WHERE id=$1 RETURNING *',
            [prior.id, new Date(this.now() + 30000)],
          )
        ).rows[0]!;
      }
      if (input.termsVersion !== this.terms.version)
        throw new BillingCustomerError(
          'invalid_setup_consent',
          'Explicit approval of the current payment terms is required.',
        );
      if (
        (
          await client.query(
            "SELECT 1 FROM mr_billing_setups WHERE workspace_id=$1 AND processor_environment_id=$2 AND status IN ('pending','open','review') LIMIT 1",
            [workspaceId, this.processorEnvironment.id],
          )
        ).rowCount
      )
        throw new BillingCustomerError(
          'setup_exists',
          'Finish or reconcile the existing payment setup.',
          409,
        );
      await this.options.admitExternalInTransaction(client, workspaceId);
      const id = randomUUID(),
        now = this.now();
      return (
        await client.query<SetupRow>(
          `INSERT INTO mr_billing_setups(id,workspace_id,livemode,customer_id,client_key,stripe_idempotency_key,terms_version,terms_snapshot,human_membership_id,consent_reference,started_at,expires_at,lease_until,authority_snapshot,owner_authority_version,owner_consent_reference,owner_membership_epoch,processor_environment_id,processor_account_id,request_version,api_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
          [
            id,
            workspaceId,
            this.processorEnvironment.livemode,
            customerId,
            input.idempotencyKey,
            `opengen-setup-v2-${id}`,
            this.terms.version,
            JSON.stringify(this.terms),
            human.membershipId,
            `billing-setup:${id}`,
            new Date(now),
            new Date(Math.floor(now / 1000) * 1000 + 23 * 3600000),
            new Date(now + 30000),
            JSON.stringify({
              workspaceId: human.workspaceId,
              scopes: human.scopes,
              keyKind: human.keyKind,
              keyId: human.keyId,
              keySecretVersion: human.keySecretVersion,
              membershipId: human.membershipId,
              role: human.role,
              grantId: human.grantId,
              clientId: human.clientId,
              oauthResource: human.oauthResource,
              identity: human.identity,
              authorityExpiresAt: human.authorityExpiresAt,
              bootstrap: human.bootstrap,
              externalOAuth: human.externalOAuth,
            }),
            human.billingOwner.authorityVersion,
            human.billingOwner.consentReference,
            human.billingOwner.membershipEpoch,
            this.processorEnvironment.id,
            this.processorEnvironment.accountId,
            'setup_checkout_v2',
            BILLING_STRIPE_API_VERSION,
          ],
        )
      ).rows[0]!;
    });
    if (row.session_id || row.status === 'review') return setupView(row);
    let session: SetupSession;
    try {
      session = await transport.createSetup({
        processorEnvironment: {
          id: row.processor_environment_id,
          accountId: row.processor_account_id,
          livemode: row.livemode,
        },
        requestVersion: row.request_version,
        apiVersion: row.api_version,
        id: row.id,
        customerId,
        stripeIdempotencyKey: row.stripe_idempotency_key,
        expiresAt: Math.floor(row.expires_at.getTime() / 1000),
        integrationIdentifier: `opengen_setup_${row.id
          .replaceAll('-', '')
          .slice(0, 8)
          .split('')
          .map((n) => String.fromCharCode(97 + parseInt(n, 16)))
          .join('')}`,
      });
    } catch {
      await this.pool.query('UPDATE mr_billing_setups SET lease_until=NULL WHERE id=$1', [row.id]);
      throw new BillingCustomerError(
        'setup_uncertain',
        'Retry this same payment setup request.',
        503,
      );
    }
    this.checkSetup(row, session);
    const url = safeUrl(session.url, 'checkout');
    return this.tx(async (client) => {
      await this.lock(client, workspaceId);
      const current = (
        await client.query<SetupRow>('SELECT * FROM mr_billing_setups WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0]!;
      this.checkSetup(current, session);
      // A late create replay cannot reopen a setup already reconciled by webhook.
      if (['complete', 'expired', 'review'].includes(current.status)) return setupView(current);
      const updated = (
        await client.query<SetupRow>(
          `UPDATE mr_billing_setups SET session_id=$2,setup_intent_id=$3,checkout_url=$4,status=$5,lease_until=NULL WHERE id=$1 AND (session_id IS NULL OR session_id=$2) RETURNING *`,
          [
            row.id,
            session.id,
            session.setup_intent,
            url,
            session.status === 'expired' ? 'expired' : 'open',
          ],
        )
      ).rows[0];
      if (!updated) throw new BillingCustomerError('setup_mismatch', 'Payment setup changed.', 409);
      return setupView(updated);
    });
  }
  private checkSetup(row: SetupRow, session: SetupSession) {
    if (
      !reference(session.id, 'cs') ||
      session.mode !== 'setup' ||
      session.customer !== row.customer_id ||
      session.livemode !== row.livemode ||
      session.client_reference_id !== row.id ||
      (row.session_id && session.id !== row.session_id) ||
      (row.setup_intent_id && session.setup_intent !== row.setup_intent_id)
    )
      throw new BillingCustomerError(
        'setup_mismatch',
        'Payment setup identity requires review.',
        409,
      );
  }
  async getSetup(actor: CustomerActor, workspaceId: string, id: string): Promise<SetupView> {
    if (!uuid.test(id))
      throw new BillingCustomerError('not_found', 'Payment setup not found.', 404);
    return this.tx(async (client) => {
      await this.lock(client, workspaceId);
      await this.authority(client, actor, workspaceId, 'billing:read');
      const row = (
        await client.query<SetupRow>(
          'SELECT * FROM mr_billing_setups WHERE workspace_id=$1 AND processor_environment_id=$2 AND id=$3',
          [workspaceId, this.processorEnvironment.id, id],
        )
      ).rows[0];
      if (!row) throw new BillingCustomerError('not_found', 'Payment setup not found.', 404);
      return setupView(row);
    });
  }
  /** The caller must verify the Stripe signature over the exact raw bytes first. */
  async reconcileSetup(
    event: VerifiedSetupEvent,
    transport: CustomerTransport,
  ): Promise<{ received: true; duplicate?: boolean }> {
    const object = event.data.object;
    if (
      !reference(event.id, 'evt') ||
      event.livemode !== this.processorEnvironment.livemode ||
      !sameBillingProcessorEnvironment(this.processorEnvironment, event.processorEnvironment) ||
      typeof object.id !== 'string'
    )
      throw new BillingCustomerError('invalid_setup_event', 'Unexpected setup event identity.');
    if (
      ![
        'checkout.session.completed',
        'checkout.session.expired',
        'payment_method.detached',
      ].includes(event.type)
    )
      return { received: true };
    if (event.type === 'payment_method.detached') {
      if (!reference(object.id, 'pm'))
        throw new BillingCustomerError(
          'invalid_setup_event',
          'Unexpected payment method identity.',
        );
      // Record even a pre-binding detachment. Signed object identity is sufficient
      // to stop future use; it never establishes customer/workspace ownership.
      await this.tx(async (client) => {
        await this.lockMethod(client, object.id as string);
        await assertBillingProcessorEnvironmentInTransaction(client, this.processorEnvironment);
        const prior = (
          await client.query(
            'SELECT * FROM mr_billing_setup_events WHERE id=$1 AND processor_environment_id=$2 FOR UPDATE',
            [event.id, this.processorEnvironment.id],
          )
        ).rows[0];
        if (
          prior &&
          (prior.type !== event.type ||
            prior.object_id !== object.id ||
            prior.livemode !== event.livemode)
        )
          throw new BillingCustomerError(
            'setup_event_conflict',
            'Payment method event identity conflicts with its journal.',
            409,
          );
        if (!prior)
          await client.query(
            'INSERT INTO mr_billing_setup_events(id,type,object_id,livemode,processor_environment_id,processor_account_id) VALUES($1,$2,$3,$4,$5,$6)',
            [
              event.id,
              event.type,
              object.id,
              event.livemode,
              this.processorEnvironment.id,
              this.processorEnvironment.accountId,
            ],
          );
      });
      // Query after the journal commit. A completion that won the method barrier
      // first is now visible; a completion that loses it must refuse activation.
      const active = await this.pool.query(
        "SELECT workspace_id,setup_id FROM mr_billing_mandates WHERE payment_method_id=$1 AND processor_environment_id=$2 AND status='active'",
        [object.id, this.processorEnvironment.id],
      );
      for (const row of active.rows)
        await this.tx(async (client) => {
          await this.lockMethod(client, object.id as string);
          await this.lock(client, row.workspace_id);
          await client.query(
            "UPDATE mr_billing_mandates SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND payment_method_id=$2 AND processor_environment_id=$3 AND status='active'",
            [row.workspace_id, object.id, this.processorEnvironment.id],
          );
          await client.query(
            'UPDATE mr_billing_setup_events SET setup_id=COALESCE(setup_id,$2) WHERE id=$1 AND processor_environment_id=$3',
            [event.id, row.setup_id, this.processorEnvironment.id],
          );
        });
      return { received: true };
    }
    // Session identity must already have been bound by the original create response
    // or its stable-key replay. Metadata/client_reference_id alone cannot bind it.
    const row = (
      await this.pool.query<SetupRow>(
        'SELECT * FROM mr_billing_setups WHERE session_id=$1 AND processor_environment_id=$2',
        [object.id, this.processorEnvironment.id],
      )
    ).rows[0];
    if (!row)
      throw new BillingCustomerError(
        'setup_unmatched',
        'Recover the original setup request before reconciling this event.',
        503,
      );
    if (row.status === 'complete' && event.type === 'checkout.session.expired') {
      if (
        object.customer !== row.customer_id ||
        object.mode !== 'setup' ||
        object.client_reference_id !== row.id ||
        object.livemode !== row.livemode
      )
        throw new BillingCustomerError(
          'setup_mismatch',
          'Setup event does not match the stored session.',
          409,
        );
      return { received: true };
    }
    const prior = (
      await this.pool.query(
        'SELECT * FROM mr_billing_setup_events WHERE id=$1 AND processor_environment_id=$2',
        [event.id, this.processorEnvironment.id],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.type !== event.type ||
        prior.object_id !== object.id ||
        prior.livemode !== event.livemode
      )
        throw new BillingCustomerError(
          'setup_event_conflict',
          'Setup event identity conflicts with its journal.',
          409,
        );
      return { received: true, duplicate: true };
    }
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    await this.tx(async (client) => {
      await this.lock(client, row.workspace_id, true);
      // Upper-bound the three authoritative reads before any external I/O.
      for (let i = 0; i < (event.type === 'checkout.session.completed' ? 3 : 1); i++)
        await this.options.admitExternalInTransaction(client, row.workspace_id);
    });
    const session = await transport.retrieveSetup(row.session_id!);
    this.checkSetup(row, session);
    if (
      object.customer !== row.customer_id ||
      object.mode !== 'setup' ||
      object.client_reference_id !== row.id ||
      object.livemode !== row.livemode ||
      object.setup_intent !== session.setup_intent
    )
      throw new BillingCustomerError(
        'setup_mismatch',
        'Setup event does not match the stored session.',
        409,
      );
    let intent: SetupIntentReference | undefined, method: PaymentMethodReference | undefined;
    if (event.type === 'checkout.session.completed') {
      if (
        session.status !== 'complete' ||
        object.status !== 'complete' ||
        !reference(session.setup_intent, 'seti')
      )
        throw new BillingCustomerError('setup_incomplete', 'Setup has not completed.', 409);
      intent = await transport.retrieveSetupIntent(session.setup_intent);
      if (
        intent.id !== session.setup_intent ||
        intent.customer !== row.customer_id ||
        intent.livemode !== row.livemode ||
        intent.status !== 'succeeded' ||
        intent.usage !== 'off_session' ||
        !reference(intent.payment_method, 'pm')
      )
        throw new BillingCustomerError(
          'setup_intent_mismatch',
          'Setup authorization requires review.',
          409,
        );
      method = await transport.retrievePaymentMethod(intent.payment_method);
      if (
        method.id !== intent.payment_method ||
        method.customer !== row.customer_id ||
        method.livemode !== row.livemode
      )
        throw new BillingCustomerError(
          'method_mismatch',
          'Saved payment method identity requires review.',
          409,
        );
    } else if (session.status !== 'expired' || object.status !== 'expired')
      throw new BillingCustomerError('setup_incomplete', 'The original setup is not expired.', 409);
    const outcome = await this.tx(async (client) => {
      if (method) await this.lockMethod(client, method.id);
      await this.lock(client, row.workspace_id);
      const current = (
        await client.query<SetupRow>('SELECT * FROM mr_billing_setups WHERE id=$1 FOR UPDATE', [
          row.id,
        ])
      ).rows[0]!;
      this.checkSetup(current, session);
      const duplicate = (
        await client.query(
          'SELECT * FROM mr_billing_setup_events WHERE id=$1 AND processor_environment_id=$2',
          [event.id, this.processorEnvironment.id],
        )
      ).rows[0];
      if (duplicate) {
        if (
          duplicate.type !== event.type ||
          duplicate.object_id !== object.id ||
          duplicate.livemode !== event.livemode
        )
          throw new BillingCustomerError(
            'setup_event_conflict',
            'Setup event identity conflicts with its journal.',
            409,
          );
        return { received: true as const, duplicate: true };
      }
      if (current.status === 'review')
        return new BillingCustomerError(
          'setup_review',
          'This setup requires explicit approved review before activation.',
          409,
        );
      if (method && current.status !== 'complete') {
        const detached = (
          await client.query(
            "SELECT id FROM mr_billing_setup_events WHERE type='payment_method.detached' AND object_id=$1 AND processor_environment_id=$2 LIMIT 1",
            [method.id, current.processor_environment_id],
          )
        ).rows[0];
        if (detached) {
          await client.query(
            "UPDATE mr_billing_setups SET status='review',checkout_url=NULL WHERE id=$1",
            [current.id],
          );
          // Bind through the verified SetupIntent/PaymentMethod/owned session,
          // never through webhook metadata or a caller-supplied Customer.
          await client.query(
            "UPDATE mr_billing_setup_events SET setup_id=COALESCE(setup_id,$3) WHERE type='payment_method.detached' AND object_id=$1 AND processor_environment_id=$2",
            [method.id, current.processor_environment_id, current.id],
          );
          return new BillingCustomerError(
            'payment_method_detached',
            'The saved method was detached; review this setup before new funding.',
            409,
          );
        }
        try {
          const human = await this.authority(
            client,
            current.authority_snapshot,
            current.workspace_id,
            'billing:manage',
            true,
            current.id,
          );
          if (
            human.billingOwner.authorityVersion !== current.owner_authority_version ||
            human.billingOwner.consentReference !== current.owner_consent_reference ||
            human.billingOwner.membershipEpoch !== current.owner_membership_epoch
          )
            throw new BillingCustomerError(
              'setup_authority_revoked',
              'Funding approval changed; review the original completed setup.',
              409,
            );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (
            status === 401 ||
            status === 403 ||
            (error as { code?: string }).code === 'setup_authority_revoked'
          ) {
            await client.query(
              "UPDATE mr_billing_setups SET status='review',checkout_url=NULL WHERE id=$1",
              [current.id],
            );
            return new BillingCustomerError(
              'setup_authority_revoked',
              'A currently approved human funding owner must review this completed setup.',
              409,
            );
          }
          throw error;
        }
        // Authority is checked again after setup; removal/demotion cannot activate
        // a mandate, even if the old Checkout page subsequently completes.
        const member = (
          await client.query(
            "SELECT id FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND role='admin' AND accepted_at IS NOT NULL AND removed_at IS NULL FOR UPDATE",
            [current.human_membership_id, current.workspace_id],
          )
        ).rows[0];
        if (!member)
          throw new BillingCustomerError(
            'setup_authority_revoked',
            'A workspace administrator must review this completed setup.',
            409,
          );
        const customer = await this.customer(client, current.workspace_id);
        if (customer?.stripe_customer_id !== current.customer_id || customer.status !== 'ready')
          throw new BillingCustomerError('customer_mismatch', 'Billing customer changed.', 409);
        await client.query(
          "UPDATE mr_billing_mandates SET status='revoked',revoked_at=now() WHERE workspace_id=$1 AND processor_environment_id=$2 AND status='active'",
          [current.workspace_id, current.processor_environment_id],
        );
        const id = randomUUID();
        await client.query(
          `INSERT INTO mr_billing_mandates(id,workspace_id,customer_id,payment_method_id,livemode,status,terms_version,terms_snapshot,consent_reference,human_membership_id,setup_id,owner_authority_version,owner_consent_reference,owner_membership_epoch,processor_environment_id,processor_account_id)
          VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            id,
            current.workspace_id,
            current.customer_id,
            method.id,
            current.livemode,
            current.terms_version,
            JSON.stringify(current.terms_snapshot),
            current.consent_reference,
            current.human_membership_id,
            current.id,
            current.owner_authority_version,
            current.owner_consent_reference,
            current.owner_membership_epoch,
            current.processor_environment_id,
            current.processor_account_id,
          ],
        );
        await client.query(
          "UPDATE mr_billing_setups SET status='complete',mandate_id=$2,checkout_url=NULL,setup_intent_id=$3 WHERE id=$1",
          [current.id, id, intent!.id],
        );
      } else if (!method && current.status !== 'complete')
        await client.query(
          "UPDATE mr_billing_setups SET status='expired',checkout_url=NULL WHERE id=$1",
          [current.id],
        );
      await client.query(
        'INSERT INTO mr_billing_setup_events(id,type,object_id,livemode,setup_id,processor_environment_id,processor_account_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          event.id,
          event.type,
          object.id,
          event.livemode,
          row.id,
          this.processorEnvironment.id,
          this.processorEnvironment.accountId,
        ],
      );
      return { received: true as const };
    });
    if (outcome instanceof BillingCustomerError) throw outcome;
    return outcome;
  }
  async revokeMandate(actor: CustomerActor, workspaceId: string, id: string): Promise<void> {
    if (!uuid.test(id)) throw new BillingCustomerError('not_found', 'Mandate not found.', 404);
    await this.tx(async (client) => {
      await this.lock(client, workspaceId);
      await this.authority(client, actor, workspaceId, 'billing:manage', true);
      const result = await client.query(
        "UPDATE mr_billing_mandates SET status='revoked',revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND processor_environment_id=$3 RETURNING id",
        [id, workspaceId, this.processorEnvironment.id],
      );
      if (!result.rowCount) throw new BillingCustomerError('not_found', 'Mandate not found.', 404);
    });
  }
  async portal(
    actor: CustomerActor,
    workspaceId: string,
    transport: CustomerTransport,
  ): Promise<{ url: string }> {
    if (!this.options.allowPortal)
      throw new BillingCustomerError(
        'portal_not_authorized',
        'Portal capability has not been approved for this installation.',
        403,
      );
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    const customerId = await this.tx(async (client) => {
      await this.lock(client, workspaceId, true);
      await this.authority(client, actor, workspaceId, 'billing:manage');
      const customer = await this.customer(client, workspaceId);
      if (!customer?.stripe_customer_id || customer.status !== 'ready')
        throw new BillingCustomerError(
          'customer_setup_required',
          'Set up billing before opening the portal.',
          409,
        );
      await this.options.admitExternalInTransaction(client, workspaceId);
      await this.options.admitExternalInTransaction(client, workspaceId);
      return customer.stripe_customer_id;
    });
    const customer = await transport.retrieveCustomer(customerId);
    if (
      customer.id !== customerId ||
      customer.deleted ||
      customer.livemode !== this.processorEnvironment.livemode
    )
      throw new BillingCustomerError('customer_mismatch', 'Billing customer requires review.', 409);
    const session = await transport.createPortal(customerId);
    if (session.customerId !== customerId)
      throw new BillingCustomerError('customer_mismatch', 'Portal customer mismatch.', 409);
    const url = safeUrl(session.url, 'portal');
    if (!url)
      throw new BillingCustomerError('unsafe_billing_link', 'Portal link unavailable.', 502);
    return { url };
  }
  /** Explicit authenticated POST sync; read-only history never dispatches Stripe requests. */
  async syncDocuments(
    actor: CustomerActor,
    workspaceId: string,
    input: { type: 'receipt' | 'invoice'; cursor?: string; limit?: number },
    transport: CustomerTransport,
  ): Promise<{ hasMore: boolean; nextCursor: string | null }> {
    const limit = input.limit ?? 20;
    if (
      !['receipt', 'invoice'].includes(input.type) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor && !reference(input.cursor, input.type === 'receipt' ? 'ch' : 'in'))
    )
      throw new BillingCustomerError(
        'invalid_document_page',
        'Choose a valid billing document page.',
      );
    assertBillingProcessorTransport(this.processorEnvironment, transport);
    const customerId = await this.tx(async (client) => {
      await this.lock(client, workspaceId, true);
      await this.authority(client, actor, workspaceId, 'billing:read');
      const row = await this.customer(client, workspaceId);
      if (!row?.stripe_customer_id || row.status !== 'ready')
        throw new BillingCustomerError(
          'customer_setup_required',
          'Billing customer is unavailable.',
          409,
        );
      await this.options.admitExternalInTransaction(client, workspaceId);
      return row.stripe_customer_id;
    });
    const page = await transport.listDocuments(customerId, {
      type: input.type,
      cursor: input.cursor,
      limit,
    });
    if (page.data.length > limit)
      throw new BillingCustomerError(
        'invalid_document_page',
        'Unexpected billing document page.',
        502,
      );
    for (const document of page.data) {
      if (
        document.type !== input.type ||
        document.customerId !== customerId ||
        document.livemode !== this.processorEnvironment.livemode ||
        !reference(document.id, document.type === 'receipt' ? 'ch' : 'in') ||
        !Number.isSafeInteger(document.amountCents) ||
        document.amountCents < 0 ||
        document.amountCents > 2147483647 ||
        !Number.isFinite(Date.parse(document.createdAt))
      )
        throw new BillingCustomerError(
          'document_mismatch',
          'Billing document identity requires review.',
          409,
        );
      safeUrl(document.url, document.type);
      safeUrl(document.pdfUrl, 'invoice');
    }
    await this.tx(async (client) => {
      await this.lock(client, workspaceId);
      await this.authority(client, actor, workspaceId, 'billing:read');
      if ((await this.customer(client, workspaceId))?.stripe_customer_id !== customerId)
        throw new BillingCustomerError('customer_mismatch', 'Billing customer changed.', 409);
      for (const d of page.data)
        await client.query(
          `INSERT INTO mr_billing_documents(workspace_id,livemode,type,id,customer_id,amount_cents,currency,status,document_created_at,url,pdf_url,processor_environment_id,processor_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(processor_environment_id,type,id) DO UPDATE SET status=EXCLUDED.status,url=EXCLUDED.url,pdf_url=EXCLUDED.pdf_url,synced_at=now() WHERE mr_billing_documents.workspace_id=EXCLUDED.workspace_id AND mr_billing_documents.customer_id=EXCLUDED.customer_id`,
          [
            workspaceId,
            this.processorEnvironment.livemode,
            d.type,
            d.id,
            customerId,
            d.amountCents,
            d.currency,
            d.status,
            d.createdAt,
            d.url,
            d.pdfUrl,
            this.processorEnvironment.id,
            this.processorEnvironment.accountId,
          ],
        );
    });
    return { hasMore: page.hasMore, nextCursor: page.nextCursor };
  }
  async documents(
    actor: CustomerActor,
    workspaceId: string,
    input: { type?: 'receipt' | 'invoice'; before?: string; limit?: number } = {},
  ): Promise<{
    data: Omit<BillingDocument, 'customerId' | 'livemode'>[];
    nextCursor: string | null;
  }> {
    const limit = input.limit ?? 20;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.type && !['receipt', 'invoice'].includes(input.type)) ||
      (input.before && !/^(ch|in)_[A-Za-z0-9_]+$/.test(input.before))
    )
      throw new BillingCustomerError(
        'invalid_document_page',
        'Choose a valid billing document page.',
      );
    return this.tx(async (client) => {
      await this.lock(client, workspaceId);
      await this.authority(client, actor, workspaceId, 'billing:read');
      if (
        input.before &&
        !(
          await client.query(
            'SELECT 1 FROM mr_billing_documents WHERE workspace_id=$1 AND processor_environment_id=$2 AND id=$3',
            [workspaceId, this.processorEnvironment.id, input.before],
          )
        ).rowCount
      )
        throw new BillingCustomerError('not_found', 'Billing document cursor not found.', 404);
      const rows = (
        await client.query(
          `SELECT * FROM mr_billing_documents WHERE workspace_id=$1 AND processor_environment_id=$2 AND ($3::text IS NULL OR type=$3)
        AND ($4::text IS NULL OR (document_created_at,id)<(SELECT document_created_at,id FROM mr_billing_documents WHERE workspace_id=$1 AND processor_environment_id=$2 AND id=$4)) ORDER BY document_created_at DESC,id DESC LIMIT $5`,
          [
            workspaceId,
            this.processorEnvironment.id,
            input.type ?? null,
            input.before ?? null,
            limit + 1,
          ],
        )
      ).rows;
      return {
        data: rows.slice(0, limit).map((row) => ({
          type: row.type,
          id: row.id,
          amountCents: row.amount_cents,
          currency: row.currency,
          status: row.status,
          createdAt: row.document_created_at.toISOString(),
          url: row.url,
          pdfUrl: row.pdf_url,
        })),
        nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
      };
    });
  }
}
