import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BillingCustomerStore,
  registerBillingProcessorEnvironmentInTransaction,
  type BillingProcessorEnvironment,
  type CustomerActor,
  type CustomerRequest,
  type CustomerTransport,
  type CustomerStoreOptions,
  type DocumentPage,
  type SetupRequest,
  type SetupSession,
  type VerifiedSetupEvent,
} from '../packages/engine/src/billing-customer.js';
import { paymentFixture } from './payment-fixture.js';

const processorEnvironment = {
  id: 'fixture-stripe-environment',
  accountId: 'acct_fixture',
  livemode: false,
};
const configured = Boolean(process.env.TEST_DATABASE_URL);
async function fixture() {
  const f = await paymentFixture();
  await f.pool.query(
    await readFile(new URL('../docs/billing/customer-schema.sql', import.meta.url), 'utf8'),
  );
  const registerEnvironment = async (environment: BillingProcessorEnvironment) => {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await registerBillingProcessorEnvironmentInTransaction(client, environment);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  await registerEnvironment(processorEnvironment);
  const membershipId = randomUUID();
  await f.pool.query(
    "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,'https://fixture.example',$3,'admin',now())",
    [membershipId, f.workspace, membershipId],
  );
  const actor: CustomerActor = {
    workspaceId: f.workspace,
    keyKind: 'browser',
    membershipId,
    role: 'admin',
    scopes: ['billing:read', 'billing:manage'],
  };
  let now = Date.now();
  let ownerVersion = 1;
  let ownerApproved = true; // Explicit fixture proof; production uses B2 owner approval rows.
  const storeOptions: CustomerStoreOptions = {
    processorEnvironment,
    terms: {
      version: 'terms_fixture_v1',
      text: 'Fixture only: owner-approved payment frequency and amount policy; no live activation.',
    },
    now: () => now,
    allowPortal: true,
    lockExternalInTransaction: (client) => f.store.lockExternalInTransaction(client),
    admitExternalInTransaction: (client, workspace) =>
      f.store.admitExternalInTransaction(client, workspace),
    authorize: async (client, source, scope) => {
      if (!source.scopes.includes(scope))
        throw Object.assign(new Error('Billing permission required.'), {
          code: 'billing_access_denied',
          statusCode: 403,
        });
      if (source.keyKind === 'browser') {
        const member = (
          await client.query(
            'SELECT role FROM mr_memberships WHERE id=$1 AND workspace_id=$2 AND accepted_at IS NOT NULL AND removed_at IS NULL FOR UPDATE',
            [source.membershipId, source.workspaceId],
          )
        ).rows[0];
        if (!member)
          throw Object.assign(new Error('Membership removed.'), {
            code: 'authority_revoked',
            statusCode: 403,
          });
        return {
          principal: { ...source, role: member.role },
          delegation: null,
          owner: {
            workspaceId: f.workspace,
            membershipId,
            membershipEpoch: 'fixture-epoch',
            authorityVersion: ownerVersion,
            processorEnvironmentId: processorEnvironment.id,
            livemode: false,
            consentReference: 'fixture-owner-consent',
            approvalReference: 'fixture-owner-approval',
            rails: {
              allowsEnabled: true,
              maxThresholdMicros: 100000000,
              maxAmountCents: 100000,
              maxMonthlyCapCents: 1000000,
              maxAttemptsPerMonth: 100,
              minCooldownSeconds: 60,
              maxFailureLimit: 10,
            },
          },
          humanMembershipId:
            member.role === 'admin' && ownerApproved ? source.membershipId : undefined,
        };
      }
      return {
        principal: source,
        delegation: null,
        owner: {
          workspaceId: f.workspace,
          membershipId,
          membershipEpoch: 'fixture-epoch',
          authorityVersion: ownerVersion,
          processorEnvironmentId: processorEnvironment.id,
          livemode: false,
          consentReference: 'fixture-owner-consent',
          approvalReference: 'fixture-owner-approval',
          rails: {
            allowsEnabled: true,
            maxThresholdMicros: 100000000,
            maxAmountCents: 100000,
            maxMonthlyCapCents: 1000000,
            maxAttemptsPerMonth: 100,
            minCooldownSeconds: 60,
            maxFailureLimit: 10,
          },
        },
      };
    },
  };
  const store = new BillingCustomerStore(f.pool, storeOptions);
  const customerId = `cus_${membershipId.replaceAll('-', '')}`;
  const customerRequests: CustomerRequest[] = [],
    setupRequests: SetupRequest[] = [];
  const sessions = new Map<string, SetupSession>();
  let customerTimeout = false,
    setupTimeout = false;
  let documentPage: DocumentPage = { data: [], hasMore: false, nextCursor: null };
  const transport: CustomerTransport = {
    processorEnvironment,
    assertProcessorEnvironment() {}, // Explicit synthetic proof for the fake transport.
    async createCustomer(request) {
      customerRequests.push({ ...request });
      // Pool size one proves no client/transaction remains held over external I/O.
      await f.pool.query('SELECT 1');
      if (customerTimeout) {
        customerTimeout = false;
        throw new Error('Lost create response');
      }
      return { id: customerId, livemode: false };
    },
    async retrieveCustomer(id) {
      return { id, livemode: false };
    },
    async createSetup(request) {
      setupRequests.push({ ...request });
      await f.pool.query('SELECT 1');
      let session = [...sessions.values()].find((s) => s.client_reference_id === request.id);
      session ??= {
        id: `cs_${request.id.replaceAll('-', '')}`,
        customer: customerId,
        mode: 'setup',
        status: 'open',
        setup_intent: `seti_${request.id.replaceAll('-', '')}`,
        client_reference_id: request.id,
        livemode: false,
        url: 'https://checkout.stripe.com/c/setup/fixture',
      };
      sessions.set(session.id, session);
      if (setupTimeout) {
        setupTimeout = false;
        throw new Error('Lost setup response');
      }
      return { ...session };
    },
    async retrieveSetup(id) {
      const session = sessions.get(id);
      if (!session) throw new Error('Unknown session');
      return { ...session };
    },
    async retrieveSetupIntent(id) {
      return {
        id,
        customer: customerId,
        payment_method: `pm_${id.slice(5)}`,
        status: 'succeeded',
        livemode: false,
        usage: 'off_session',
      };
    },
    async retrievePaymentMethod(id) {
      return { id, customer: customerId, livemode: false };
    },
    async createPortal(id) {
      return { customerId: id, url: 'https://billing.stripe.com/p/session/fixture' };
    },
    async listDocuments() {
      return documentPage;
    },
  };
  const input = () => ({
    idempotencyKey: randomUUID(),
    consent: true,
    termsVersion: 'terms_fixture_v1',
  });
  return {
    ...f,
    store,
    actor,
    membershipId,
    customerId,
    transport,
    sessions,
    customerRequests,
    setupRequests,
    input,
    registerEnvironment,
    environmentStore(environment: BillingProcessorEnvironment) {
      return new BillingCustomerStore(f.pool, {
        ...storeOptions,
        processorEnvironment: environment,
        authorize: async (...args) => {
          const proof = await storeOptions.authorize(...args);
          return {
            ...proof,
            owner: {
              ...proof.owner,
              processorEnvironmentId: environment.id,
              livemode: environment.livemode,
            },
          };
        },
      });
    },
    changeOwnerVersion: () => {
      ownerVersion++;
    },
    newTermsStore: () =>
      new BillingCustomerStore(f.pool, {
        ...storeOptions,
        terms: { version: 'terms_fixture_v2', text: 'Changed fixture terms.' },
      }),
    ownerApproved: (value: boolean) => {
      ownerApproved = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    customerTimeout: () => {
      customerTimeout = true;
    },
    setupTimeout: () => {
      setupTimeout = true;
    },
    documents: (page: DocumentPage) => {
      documentPage = page;
    },
    complete(setupId: string) {
      const session = [...sessions.values()].find((s) => s.client_reference_id === setupId)!;
      session.status = 'complete';
      return session;
    },
    event(session: SetupSession, patch: Record<string, unknown> = {}): VerifiedSetupEvent {
      return {
        id: `evt_${randomUUID().replaceAll('-', '')}`,
        type: 'checkout.session.completed',
        processorEnvironment,
        livemode: false,
        data: { object: { ...session, ...patch } },
      };
    },
  };
}

describe.skipIf(!configured)('owned Stripe customer/setup/mandate SQL lifecycle', () => {
  it('refuses historical unbound setup before network admission or lease mutation', async () => {
    const f = await fixture();
    try {
      const input = f.input();
      f.setupTimeout();
      await expect(
        f.store.startSetup(f.actor, f.workspace, input, f.transport),
      ).rejects.toMatchObject({ code: 'setup_uncertain' });
      expect(f.setupRequests[0]!.requestVersion).toBe('setup_checkout_v2');
      await f.pool.query(
        "UPDATE mr_billing_setups SET request_version='setup_checkout_v1',stripe_idempotency_key='historical-setup-request' WHERE client_key=$1",
        [input.idempotencyKey],
      );
      const snapshot = async () => ({
        setup: (
          await f.pool.query('SELECT * FROM mr_billing_setups WHERE client_key=$1', [
            input.idempotencyKey,
          ])
        ).rows[0],
        workspace: (
          await f.pool.query(
            'SELECT payment_checkout_window,payment_checkout_count FROM mr_workspaces WHERE id=$1',
            [f.workspace],
          )
        ).rows[0],
        installation: (
          await f.pool.query(
            'SELECT payment_checkout_window,payment_checkout_count FROM mr_payment_rate_limits',
          )
        ).rows[0],
      });
      const before = await snapshot();
      f.advance(60001);
      let calls = 0;
      const unexpected = async (): Promise<never> => {
        calls++;
        throw new Error('Unexpected external request');
      };
      const transport: CustomerTransport = {
        ...f.transport,
        createCustomer: unexpected,
        retrieveCustomer: unexpected,
        createSetup: unexpected,
        retrieveSetup: unexpected,
      };
      await expect(
        f.store.startSetup(f.actor, f.workspace, input, transport),
      ).rejects.toMatchObject({ code: 'unsupported_setup_request', statusCode: 409 });
      expect(calls).toBe(0);
      expect(await snapshot()).toEqual(before);
      expect(f.customerRequests).toHaveLength(1);
      expect(f.setupRequests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('keeps known historical setup available to authoritative retrieval and signed completion', async () => {
    const f = await fixture();
    try {
      const input = f.input();
      const setup = await f.store.startSetup(f.actor, f.workspace, input, f.transport);
      await f.pool.query(
        "UPDATE mr_billing_setups SET request_version='setup_checkout_v1',stripe_idempotency_key='historical-bound-setup' WHERE id=$1",
        [setup.id],
      );
      expect((await f.store.startSetup(f.actor, f.workspace, input, f.transport)).id).toBe(
        setup.id,
      );
      const event = f.event(f.complete(setup.id), { ui_mode: 'hosted' });
      await f.store.reconcileSetup(event, f.transport);
      expect((await f.pool.query('SELECT status FROM mr_billing_mandates')).rows).toEqual([
        { status: 'active' },
      ]);
      expect(f.setupRequests).toHaveLength(1);
      expect(
        (
          await f.pool.query(
            'SELECT request_version,stripe_idempotency_key FROM mr_billing_setups WHERE id=$1',
            [setup.id],
          )
        ).rows[0],
      ).toEqual({
        request_version: 'setup_checkout_v1',
        stripe_idempotency_key: 'historical-bound-setup',
      });
    } finally {
      await f.close();
    }
  });
  it('rejects retargeting a processor namespace or aliasing its verified account and mode', async () => {
    const f = await fixture();
    try {
      await f.registerEnvironment(processorEnvironment);
      await expect(
        f.registerEnvironment({ ...processorEnvironment, accountId: 'acct_other' }),
      ).rejects.toMatchObject({ code: 'processor_environment_mismatch' });
      await expect(
        f.registerEnvironment({ ...processorEnvironment, livemode: true }),
      ).rejects.toMatchObject({ code: 'processor_environment_mismatch' });
      await expect(
        f.registerEnvironment({ ...processorEnvironment, id: 'fixture-alias' }),
      ).rejects.toMatchObject({ code: 'processor_environment_mismatch' });
      expect(
        (await f.pool.query('SELECT account_id,livemode FROM mr_billing_processor_environments'))
          .rows,
      ).toEqual([{ account_id: 'acct_fixture', livemode: false }]);
    } finally {
      await f.close();
    }
  });
  it('isolates customers, setup lookup, and signed contexts for two distinct Stripe account IDs in the same mode', async () => {
    const f = await fixture();
    try {
      const other = {
        ...processorEnvironment,
        id: 'fixture-other-sandbox',
        accountId: 'acct_other',
      };
      await f.registerEnvironment(other);
      const second = f.environmentStore(other);
      await expect(second.ensureCustomer(f.actor, f.workspace, f.transport)).rejects.toMatchObject({
        code: 'processor_environment_mismatch',
      });
      expect(f.customerRequests).toHaveLength(0);
      const original = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      await second.ensureCustomer(f.actor, f.workspace, {
        ...f.transport,
        processorEnvironment: other,
      });
      // Identical synthetic Stripe IDs are permitted across namespaces, never reused as ownership across them.
      expect(
        (
          await f.pool.query(
            'SELECT processor_environment_id,stripe_customer_id FROM mr_billing_customers ORDER BY processor_environment_id',
          )
        ).rows,
      ).toEqual([
        { processor_environment_id: other.id, stripe_customer_id: f.customerId },
        { processor_environment_id: processorEnvironment.id, stripe_customer_id: f.customerId },
      ]);
      await expect(second.getSetup(f.actor, f.workspace, original.id)).rejects.toMatchObject({
        code: 'not_found',
      });
      const completion = f.event(f.complete(original.id));
      await expect(
        f.store.reconcileSetup({ ...completion, processorEnvironment: other }, f.transport),
      ).rejects.toMatchObject({ code: 'invalid_setup_event' });
      expect((await f.store.getSetup(f.actor, f.workspace, original.id)).mandateId).toBeNull();
      await f.store.reconcileSetup(completion, f.transport);
      expect(
        (
          await f.pool.query(
            'SELECT processor_environment_id,processor_account_id FROM mr_billing_mandates',
          )
        ).rows,
      ).toEqual([
        {
          processor_environment_id: processorEnvironment.id,
          processor_account_id: processorEnvironment.accountId,
        },
      ]);
    } finally {
      await f.close();
    }
  });
  it('rejects document and setup customer bindings across workspace or processor environment at the SQL boundary', async () => {
    const f = await fixture();
    try {
      await f.store.ensureCustomer(f.actor, f.workspace, f.transport);
      const foreignWorkspace = `foreign-${randomUUID()}`;
      const foreignEnvironment = {
        id: 'fixture-other-sandbox',
        accountId: 'acct_other',
        livemode: false,
      };
      await f.registerEnvironment(foreignEnvironment);
      await f.pool.query('INSERT INTO mr_workspaces(id,available_micros) VALUES($1,0)', [
        foreignWorkspace,
      ]);
      for (const [workspace, environment] of [
        [foreignWorkspace, processorEnvironment],
        [f.workspace, foreignEnvironment],
      ] as const) {
        await expect(
          f.pool.query(
            "INSERT INTO mr_billing_documents(workspace_id,livemode,processor_environment_id,processor_account_id,type,id,customer_id,amount_cents,currency,status,document_created_at) VALUES($1,false,$2,$3,'receipt','ch_fixture',$4,1000,'usd','paid',now())",
            [workspace, environment.id, environment.accountId, f.customerId],
          ),
        ).rejects.toMatchObject({ code: '23503' });
      }
      await expect(
        f.pool.query(
          "INSERT INTO mr_billing_setups(id,workspace_id,livemode,processor_environment_id,processor_account_id,customer_id,client_key,stripe_idempotency_key,terms_version,terms_snapshot,authority_snapshot,human_membership_id,consent_reference,owner_authority_version,owner_consent_reference,owner_membership_epoch,started_at,expires_at) VALUES($1,$2,false,$3,$4,$5,'fixture-key','fixture-setup-key','v1','{}','{}',$6,'fixture-setup-consent',1,'fixture-consent','fixture-epoch',now(),now())",
          [
            randomUUID(),
            f.workspace,
            foreignEnvironment.id,
            foreignEnvironment.accountId,
            f.customerId,
            f.membershipId,
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await f.close();
    }
  });
  it('persists one customer per workspace/environment and replays the exact customer identity after timeout', async () => {
    const f = await fixture();
    try {
      f.customerTimeout();
      await expect(f.store.ensureCustomer(f.actor, f.workspace, f.transport)).rejects.toMatchObject(
        { code: 'customer_uncertain' },
      );
      const persisted = (await f.pool.query('SELECT * FROM mr_billing_customers')).rows[0];
      expect(persisted.stripe_customer_id).toBeNull();
      expect(await f.store.ensureCustomer(f.actor, f.workspace, f.transport)).toBe(f.customerId);
      expect(await f.store.ensureCustomer(f.actor, f.workspace, f.transport)).toBe(f.customerId);
      expect(f.customerRequests).toHaveLength(2);
      expect(f.customerRequests[1]).toEqual(f.customerRequests[0]);
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_customers')).rows[0]
          .count,
      ).toBe(1);
    } finally {
      await f.close();
    }
  });
  it('does not invent a new customer after the stable-key recovery window', async () => {
    const f = await fixture();
    try {
      f.customerTimeout();
      await expect(f.store.ensureCustomer(f.actor, f.workspace, f.transport)).rejects.toThrow();
      f.advance(21 * 3600000);
      await expect(f.store.ensureCustomer(f.actor, f.workspace, f.transport)).rejects.toMatchObject(
        { code: 'customer_review' },
      );
      expect(f.customerRequests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  it('requires a current human admin and exact server-owned terms, regardless of agent consent:true', async () => {
    const f = await fixture();
    try {
      await expect(
        f.store.startSetup({ ...f.actor, keyKind: 'api' }, f.workspace, f.input(), f.transport),
      ).rejects.toMatchObject({ code: 'human_admin_required' });
      await expect(
        f.store.startSetup(f.actor, f.workspace, { ...f.input(), consent: false }, f.transport),
      ).rejects.toMatchObject({ code: 'invalid_setup_consent' });
      await expect(
        f.store.startSetup(
          f.actor,
          f.workspace,
          { ...f.input(), termsVersion: 'agent-invented' },
          f.transport,
        ),
      ).rejects.toMatchObject({ code: 'invalid_setup_consent' });
      await f.pool.query("UPDATE mr_memberships SET role='member' WHERE id=$1", [f.membershipId]);
      await expect(
        f.store.startSetup(f.actor, f.workspace, f.input(), f.transport),
      ).rejects.toMatchObject({ code: 'human_admin_required' });
      expect(f.customerRequests).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it('replays setup after lost response and activates only from verified completion, not read/redirect', async () => {
    const f = await fixture();
    try {
      const input = f.input();
      f.setupTimeout();
      await expect(
        f.store.startSetup(f.actor, f.workspace, input, f.transport),
      ).rejects.toMatchObject({ code: 'setup_uncertain' });
      const external = [...f.sessions.values()][0]!;
      external.status = 'complete';
      await expect(f.store.reconcileSetup(f.event(external), f.transport)).rejects.toMatchObject({
        code: 'setup_unmatched',
      });
      const setup = await f.store.startSetup(f.actor, f.workspace, input, f.transport);
      expect(f.setupRequests).toHaveLength(2);
      expect(f.setupRequests[1]).toEqual(f.setupRequests[0]);
      expect((await f.store.getSetup(f.actor, f.workspace, setup.id)).mandateId).toBeNull();
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
      const event = f.event(external);
      await f.store.reconcileSetup(event, f.transport);
      expect(await f.store.reconcileSetup(event, f.transport)).toEqual({
        received: true,
        duplicate: true,
      });
      const mandate = (await f.pool.query('SELECT * FROM mr_billing_mandates')).rows[0];
      expect(mandate).toMatchObject({
        workspace_id: f.workspace,
        customer_id: f.customerId,
        status: 'active',
        terms_version: 'terms_fixture_v1',
        human_membership_id: f.membershipId,
        setup_id: setup.id,
        consent_reference: setup.consentReference,
      });
      expect(
        (
          await f.pool.query('SELECT available_micros FROM mr_workspaces WHERE id=$1', [
            f.workspace,
          ])
        ).rows[0].available_micros,
      ).toBe('0');
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_ledger')).rows[0].count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('preserves original terms and request shape when an uncertain setup is recovered after deployment', async () => {
    const f = await fixture();
    try {
      const input = f.input();
      f.setupTimeout();
      await expect(
        f.store.startSetup(f.actor, f.workspace, input, f.transport),
      ).rejects.toMatchObject({ code: 'setup_uncertain' });
      const deployed = f.newTermsStore();
      const recovered = await deployed.startSetup(f.actor, f.workspace, input, f.transport);
      expect(recovered.termsVersion).toBe('terms_fixture_v1');
      expect(f.setupRequests[1]).toEqual(f.setupRequests[0]);
      await expect(
        deployed.startSetup(
          f.actor,
          f.workspace,
          { ...input, termsVersion: 'terms_fixture_v2' },
          f.transport,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    } finally {
      await f.close();
    }
  });
  it('rejects foreign session/customer/environment and mismatched retrieved method ownership', async () => {
    const f = await fixture();
    try {
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const session = f.complete(setup.id);
      for (const patch of [
        { customer: 'cus_other' },
        { mode: 'payment' },
        { client_reference_id: randomUUID() },
        { livemode: true },
        { id: 'cs_arbitrary' },
      ])
        await expect(
          f.store.reconcileSetup(f.event(session, patch), f.transport),
        ).rejects.toThrow();
      const wrongMethod = {
        ...f.transport,
        retrievePaymentMethod: async (id: string) => ({
          id,
          customer: 'cus_other',
          livemode: false,
        }),
      };
      await expect(f.store.reconcileSetup(f.event(session), wrongMethod)).rejects.toMatchObject({
        code: 'method_mismatch',
      });
      const onSession = {
        ...f.transport,
        retrieveSetupIntent: async (id: string) => ({
          id,
          customer: f.customerId,
          payment_method: 'pm_fixture',
          livemode: false,
          status: 'succeeded',
          usage: 'on_session',
        }),
      };
      await expect(f.store.reconcileSetup(f.event(session), onSession)).rejects.toMatchObject({
        code: 'setup_intent_mismatch',
      });
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('blocks activation after admin removal and preserves abandoned setup without a mandate', async () => {
    const f = await fixture();
    try {
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const session = f.complete(setup.id);
      await f.pool.query('UPDATE mr_memberships SET removed_at=now() WHERE id=$1', [
        f.membershipId,
      ]);
      await expect(f.store.reconcileSetup(f.event(session), f.transport)).rejects.toMatchObject({
        code: 'setup_authority_revoked',
      });
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('requires explicit owner proof and rechecks its revocation after external setup', async () => {
    const f = await fixture();
    try {
      f.ownerApproved(false);
      await expect(
        f.store.startSetup(f.actor, f.workspace, f.input(), f.transport),
      ).rejects.toMatchObject({ code: 'human_admin_required' });
      f.ownerApproved(true);
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const session = f.complete(setup.id);
      f.ownerApproved(false);
      await expect(f.store.reconcileSetup(f.event(session), f.transport)).rejects.toMatchObject({
        code: 'setup_authority_revoked',
      });
      f.ownerApproved(true);
      await expect(f.store.reconcileSetup(f.event(session), f.transport)).rejects.toMatchObject({
        code: 'setup_review',
      });
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('rejects an old setup after the same human owner is revoked/reapproved with a new authority version', async () => {
    const f = await fixture();
    try {
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const session = f.complete(setup.id);
      f.changeOwnerVersion();
      await expect(f.store.reconcileSetup(f.event(session), f.transport)).rejects.toMatchObject({
        code: 'setup_authority_revoked',
      });
      expect(
        (await f.pool.query('SELECT status FROM mr_billing_setups WHERE id=$1', [setup.id])).rows[0]
          .status,
      ).toBe('review');
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('replaces a card by revoking the old mandate and cannot revive it with an old completion event', async () => {
    const f = await fixture();
    try {
      const first = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const firstEvent = f.event(f.complete(first.id));
      await f.store.reconcileSetup(firstEvent, f.transport);
      const second = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      await f.store.reconcileSetup(f.event(f.complete(second.id)), f.transport);
      await f.store.reconcileSetup(
        { ...firstEvent, id: `evt_${randomUUID().replaceAll('-', '')}` },
        f.transport,
      );
      const active = (await f.pool.query("SELECT * FROM mr_billing_mandates WHERE status='active'"))
        .rows;
      expect(active).toHaveLength(1);
      expect(active[0].setup_id).toBe(second.id);
      const old = (
        await f.pool.query('SELECT status FROM mr_billing_mandates WHERE setup_id=$1', [first.id])
      ).rows[0];
      expect(old.status).toBe('revoked');
    } finally {
      await f.close();
    }
  });
  it('records expiration without activation and handles late expiry and detached methods safely', async () => {
    const f = await fixture();
    try {
      const abandoned = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const expiredSession = [...f.sessions.values()].find(
        (session) => session.client_reference_id === abandoned.id,
      )!;
      expiredSession.status = 'expired';
      await f.store.reconcileSetup(
        { ...f.event(expiredSession), type: 'checkout.session.expired' },
        f.transport,
      );
      expect((await f.store.getSetup(f.actor, f.workspace, abandoned.id)).status).toBe('expired');
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const completed = f.complete(setup.id);
      await f.store.reconcileSetup(f.event(completed), f.transport);
      await f.store.reconcileSetup(
        { ...f.event(completed, { status: 'expired' }), type: 'checkout.session.expired' },
        f.transport,
      );
      const active = (await f.pool.query("SELECT * FROM mr_billing_mandates WHERE status='active'"))
        .rows[0];
      await f.store.reconcileSetup(
        {
          id: `evt_${randomUUID().replaceAll('-', '')}`,
          type: 'payment_method.detached',
          processorEnvironment,
          livemode: false,
          data: { object: { id: active.payment_method_id } },
        },
        {
          ...f.transport,
          retrievePaymentMethod: async (id) => ({ id, customer: null, livemode: false }),
        },
      );
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::integer AS count FROM mr_billing_mandates WHERE status='active'",
          )
        ).rows[0].count,
      ).toBe(0);
      await f.store.reconcileSetup(f.event(completed), f.transport);
      expect(
        (
          await f.pool.query(
            "SELECT count(*)::integer AS count FROM mr_billing_mandates WHERE status='active'",
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await f.close();
    }
  });
  it('journals detachment before mandate creation and blocks activation even after an earlier attached-method read', async () => {
    const f = await fixture();
    try {
      const setup = await f.store.startSetup(f.actor, f.workspace, f.input(), f.transport);
      const session = f.complete(setup.id);
      let detached = false;
      const raceTransport = {
        ...f.transport,
        retrievePaymentMethod: async (id: string) => {
          const originallyAttached = await f.transport.retrievePaymentMethod(id);
          if (!detached) {
            detached = true;
            await f.store.reconcileSetup(
              {
                id: `evt_${randomUUID().replaceAll('-', '')}`,
                type: 'payment_method.detached',
                processorEnvironment,
                livemode: false,
                data: { object: { id } },
              },
              f.transport,
            );
          }
          return originallyAttached;
        },
      };
      await expect(f.store.reconcileSetup(f.event(session), raceTransport)).rejects.toMatchObject({
        code: 'payment_method_detached',
      });
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_billing_mandates')).rows[0]
          .count,
      ).toBe(0);
      expect(
        (await f.pool.query('SELECT status FROM mr_billing_setups WHERE id=$1', [setup.id])).rows[0]
          .status,
      ).toBe('review');
      expect(
        (
          await f.pool.query(
            "SELECT setup_id FROM mr_billing_setup_events WHERE type='payment_method.detached'",
          )
        ).rows[0].setup_id,
      ).toBe(setup.id);
    } finally {
      await f.close();
    }
  });
  it('owns portal links and denies foreign workspace/customer and unsafe hosted URLs', async () => {
    const f = await fixture();
    try {
      await f.store.ensureCustomer(f.actor, f.workspace, f.transport);
      await expect(
        f.store.portal({ ...f.actor, workspaceId: 'other' }, f.workspace, f.transport),
      ).rejects.toMatchObject({ code: 'workspace_changed' });
      await expect(
        f.store.portal(f.actor, f.workspace, {
          ...f.transport,
          createPortal: async () => ({
            customerId: 'cus_other',
            url: 'https://billing.stripe.com/p/fixture',
          }),
        }),
      ).rejects.toMatchObject({ code: 'customer_mismatch' });
      await expect(
        f.store.portal(f.actor, f.workspace, {
          ...f.transport,
          createPortal: async (id) => ({ customerId: id, url: 'https://evil.example/private' }),
        }),
      ).rejects.toMatchObject({ code: 'unsafe_billing_link' });
      expect(await f.store.portal(f.actor, f.workspace, f.transport)).toEqual({
        url: 'https://billing.stripe.com/p/session/fixture',
      });
    } finally {
      await f.close();
    }
  });
  it('caches paginated invoice/receipt history without Stripe calls on reads or ledger credit', async () => {
    const f = await fixture();
    try {
      await f.store.ensureCustomer(f.actor, f.workspace, f.transport);
      f.documents({
        hasMore: true,
        nextCursor: 'in_fixture',
        data: [
          {
            type: 'invoice',
            id: 'in_fixture',
            customerId: f.customerId,
            livemode: false,
            amountCents: 1000,
            currency: 'usd',
            status: 'paid',
            createdAt: '2026-11-04T00:00:00.000Z',
            url: 'https://invoice.stripe.com/i/fixture',
            pdfUrl: 'https://pay.stripe.com/invoice/fixture/pdf',
          },
        ],
      });
      expect(
        await f.store.syncDocuments(f.actor, f.workspace, { type: 'invoice' }, f.transport),
      ).toEqual({ hasMore: true, nextCursor: 'in_fixture' });
      f.documents({
        hasMore: false,
        nextCursor: null,
        data: [
          {
            type: 'receipt',
            id: 'ch_fixture',
            customerId: f.customerId,
            livemode: false,
            amountCents: 1000,
            currency: 'usd',
            status: 'succeeded',
            createdAt: '2026-11-03T00:00:00.000Z',
            url: 'https://pay.stripe.com/receipts/fixture',
            pdfUrl: null,
          },
        ],
      });
      await f.store.syncDocuments(f.actor, f.workspace, { type: 'receipt' }, f.transport);
      const first = await f.store.documents(f.actor, f.workspace, { limit: 1 });
      expect(first.data[0]).toMatchObject({ type: 'invoice', id: 'in_fixture' });
      expect(first.nextCursor).toBe('in_fixture');
      const second = await f.store.documents(f.actor, f.workspace, {
        before: first.nextCursor!,
        limit: 1,
      });
      expect(second.data[0]).toMatchObject({ type: 'receipt', id: 'ch_fixture' });
      expect(JSON.stringify(first)).not.toContain(f.customerId);
      expect(
        (await f.pool.query('SELECT count(*)::integer AS count FROM mr_ledger')).rows[0].count,
      ).toBe(0);
      await expect(
        f.store.documents({ ...f.actor, scopes: ['read'] }, f.workspace),
      ).rejects.toMatchObject({ code: 'billing_access_denied' });
      f.documents({
        hasMore: false,
        nextCursor: null,
        data: [{ ...second.data[0]!, customerId: 'cus_other', livemode: false }],
      });
      await expect(
        f.store.syncDocuments(f.actor, f.workspace, { type: 'receipt' }, f.transport),
      ).rejects.toMatchObject({ code: 'document_mismatch' });
    } finally {
      await f.close();
    }
  });
});
