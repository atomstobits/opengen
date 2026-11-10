import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import {
  registerBillingRoutes,
  billingOperationMetadata,
  billingPolicyInputSchema,
  billingSetupInputSchema,
  type BillingRouteOptions,
} from '../apps/server/src/billing.js';
import {
  BILLING_POLICY_DEFAULTS,
  type BillingPolicy,
  type BillingPrincipal,
  type BillingScope,
} from '../packages/engine/src/billing-policy.js';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery.js';
import { validateRechargeAuthentication } from '../apps/web/app/billing/recharge-authentication.js';
import { policyRequest, type BillingPolicyState } from '../apps/web/app/billing/policy-client.js';

const origin = 'https://opengen.example',
  workspaceId = 'billing-api-fixture';
const ids = {
  owner: randomUUID(),
  member: randomUUID(),
  reader: randomUUID(),
  manager: randomUUID(),
  ordinary: randomUUID(),
  admin: randomUUID(),
  apiCookie: randomUUID(),
  mandate: randomUUID(),
  attempt: randomUUID(),
  setup: randomUUID(),
};
const base = { workspaceId, authorityExpiresAt: '2099-01-01T00:00:00Z' };
const principals: Record<string, BillingPrincipal> = {
  owner: {
    ...base,
    keyKind: 'browser',
    keyId: ids.owner,
    membershipId: ids.member,
    role: 'admin',
    identity: { issuer: 'https://identity.fixture', subject: 'fixture-owner' },
    scopes: ['read', 'billing:read', 'billing:manage'],
  },
  reader: { ...base, keyKind: 'api', keyId: ids.reader, role: 'member', scopes: ['billing:read'] },
  manager: {
    ...base,
    keyKind: 'api',
    keyId: ids.manager,
    role: 'member',
    scopes: ['billing:manage'],
  },
  ordinary: { ...base, keyKind: 'api', keyId: ids.ordinary, scopes: ['read', 'generate'] },
  admin: {
    ...base,
    keyKind: 'api',
    keyId: ids.admin,
    role: 'admin',
    scopes: ['read', 'generate', 'keys:write', 'billing:manage'],
  },
  apiCookie: {
    ...base,
    keyKind: 'api',
    keyId: ids.apiCookie,
    membershipId: ids.member,
    role: 'admin',
    scopes: ['billing:read', 'billing:manage'],
  },
};
const denied = (code = 'billing_access_denied', statusCode = 403) =>
  Object.assign(new Error('Current approved billing authority is required.'), { code, statusCode });
const allApps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(allApps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
function browserHeaders(which: 'owner' | 'apiCookie' = 'owner') {
  return {
    cookie: `og_session=${which}`,
    'x-opengen-workspace': workspaceId,
    'x-opengen-recovery-scope': sessionRecoveryScope(principals[which] as never),
    origin,
  };
}
const bearer = (name: string) => ({ authorization: `Bearer ${name}` });
const policyInput = () => ({
  expectedVersion: 1,
  expectedAuthorityVersion: 3,
  policy: { ...BILLING_POLICY_DEFAULTS, mandateId: ids.mandate },
  consentReference: 'fixture-policy-consent',
});

/** These fakes retain domain authorization/CAS contracts. SQL race/ownership behavior
 * is tested separately; this suite crosses real Fastify parsing/auth/response boundaries. */
async function fixture(override: Partial<BillingRouteOptions> = {}) {
  let currentPolicy: BillingPolicy = {
    ...BILLING_POLICY_DEFAULTS,
    workspaceId,
    version: 1,
    ownerAuthorityVersion: 3,
    mandateId: ids.mandate,
    updatedAt: '2026-11-04T00:00:00.000Z',
  };
  const authorized = new Set<string>([ids.owner, ids.reader, ids.manager, ids.apiCookie]);
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT * FROM mr_billing_policies'))
        return {
          rows: [
            {
              workspace_id: workspaceId,
              enabled: currentPolicy.enabled,
              threshold_micros: String(currentPolicy.thresholdMicros),
              amount_cents: currentPolicy.amountCents,
              monthly_cap_cents: currentPolicy.monthlyCapCents,
              max_attempts_per_month: currentPolicy.maxAttemptsPerMonth,
              cooldown_seconds: currentPolicy.cooldownSeconds,
              failure_limit: currentPolicy.failureLimit,
              mandate_id: currentPolicy.mandateId,
              version: currentPolicy.version,
              owner_authority_version: currentPolicy.ownerAuthorityVersion,
              updated_at: new Date(currentPolicy.updatedAt!),
            },
          ],
          rowCount: 1,
        };
      if (sql.startsWith('SELECT id,status FROM mr_billing_mandates'))
        return { rows: [{ id: ids.mandate, status: 'active' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const authorize = vi.fn(
    async (_client: unknown, actor: BillingPrincipal, scope: BillingScope) => {
      if (
        !actor.keyId ||
        !authorized.has(actor.keyId) ||
        !actor.scopes.includes(scope) ||
        actor.workspaceId !== workspaceId
      )
        throw denied();
      return {
        principal: actor,
        delegation: null,
        owner: {
          workspaceId,
          membershipId: ids.member,
          membershipEpoch: 'fixture',
          authorityVersion: 3,
          livemode: false,
          rails: {},
          consentReference: 'owner-fixture',
          approvalReference: 'fixture',
        },
        ...(actor.keyKind === 'browser' && actor.keyId === ids.owner
          ? { humanMembershipId: ids.member }
          : {}),
      };
    },
  );
  const human = async (actor: BillingPrincipal) => {
    const proof = await authorize(client, actor, 'billing:manage');
    if (!proof.humanMembershipId) throw denied('human_billing_owner_required');
  };
  const policies = {
    authorizeInTransaction: authorize,
    getPolicy: vi.fn(async (actor: BillingPrincipal) => {
      await authorize(client, actor, 'billing:read');
      return currentPolicy;
    }),
    updatePolicy: vi.fn(async (actor: BillingPrincipal, input: ReturnType<typeof policyInput>) => {
      await authorize(client, actor, 'billing:manage');
      if (input.expectedVersion !== currentPolicy.version)
        throw denied('policy_version_conflict', 409);
      if (input.expectedAuthorityVersion !== 3) throw denied('billing_owner_changed', 409);
      currentPolicy = {
        ...input.policy,
        workspaceId,
        version: currentPolicy.version + 1,
        ownerAuthorityVersion: 3,
        updatedAt: '2026-11-04T00:00:01.000Z',
      };
      return currentPolicy;
    }),
    setDelegation: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
      return { version: 1 };
    }),
    revokeDelegation: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
    }),
  };
  const customer = {
    startSetup: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
      return {
        id: ids.setup,
        status: 'open',
        checkoutUrl: 'https://checkout.stripe.com/c/setup/fixture',
        termsVersion: 'fixture_terms_v1',
        consentReference: 'setup-fixture',
        mandateId: null,
      };
    }),
    getSetup: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
      return {
        id: ids.setup,
        status: 'pending',
        checkoutUrl: null,
        termsVersion: 'fixture_terms_v1',
        consentReference: 'setup-fixture',
        mandateId: null,
      };
    }),
    revokeMandate: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
    }),
    portal: vi.fn(async (actor: BillingPrincipal) => {
      await human(actor);
      return { url: 'https://billing.stripe.com/p/session/fixture' };
    }),
    documents: vi.fn(async (actor: BillingPrincipal) => {
      await authorize(client, actor, 'billing:read');
      return {
        data: [
          {
            type: 'invoice',
            id: 'in_fixture',
            amountCents: 2500,
            currency: 'usd',
            status: 'paid',
            createdAt: '2026-11-04T00:00:00.000Z',
            url: 'https://invoice.stripe.com/i/fixture',
            pdfUrl: null,
          },
        ],
        nextCursor: 'in_fixture',
      };
    }),
    syncDocuments: vi.fn(async (actor: BillingPrincipal) => {
      await authorize(client, actor, 'billing:read');
      return { hasMore: false, nextCursor: null };
    }),
  };
  const recharge = {
    listInTransaction: vi.fn(async () => [
      {
        id: ids.attempt,
        workspaceId,
        policyVersion: 1,
        amountCents: 2500,
        status: 'requires_authentication',
        admissionMonth: '2026-11-01',
        createdAt: '',
        updatedAt: '',
        creditedAt: null,
        failureCode: 'authentication_required',
      },
    ]),
    authentication: vi.fn(
      async (
        _workspace: string,
        _id: string,
        input: { expectedPolicyVersion: number; expectedAuthorityVersion: number },
        proof: (client: PoolClient) => Promise<unknown>,
      ) => {
        await proof(client as unknown as PoolClient);
        if (
          input.expectedPolicyVersion !== currentPolicy.version ||
          input.expectedAuthorityVersion !== 3
        )
          throw denied('recharge_policy_changed', 409);
        return {
          attemptId: ids.attempt,
          amountCents: 2500,
          clientSecret: 'pi_fixture_secret_ephemeral',
          paymentIntentId: 'pi_fixture',
        };
      },
    ),
  };
  const processorProof = {
    processorEnvironment: { id: 'fixture-processor', accountId: 'acct_fixture', livemode: false },
    assertProcessorEnvironment: vi.fn(),
  };
  const external = {
    ...processorProof,
    createCustomer: vi.fn(),
    retrieveCustomer: vi.fn(),
    createSetup: vi.fn(),
    retrieveSetup: vi.fn(),
    retrieveSetupIntent: vi.fn(),
    retrievePaymentMethod: vi.fn(),
    createPortal: vi.fn(),
    listDocuments: vi.fn(),
  };
  const recoveryTransport = { ...processorProof, retrieveRechargeRecovery: vi.fn() };
  const authenticate = vi.fn(
    async (request: { headers: Record<string, unknown>; cookies?: Record<string, string> }) => {
      const auth = request.headers.authorization;
      const name =
        typeof auth === 'string' ? auth.replace('Bearer ', '') : request.cookies?.og_session;
      const principal = name ? principals[name] : undefined;
      if (!principal) throw denied('unauthorized', 401);
      return principal;
    },
  );
  const app = Fastify();
  allApps.push(app);
  await app.register(cookie);
  app.setErrorHandler((cause, _request, reply) => {
    const e = cause as { name?: string; code?: string; statusCode?: number; message: string };
    const status = e.name === 'ZodError' ? 400 : (e.statusCode ?? 500);
    return reply.code(status).send({
      error: {
        code: e.name === 'ZodError' ? 'invalid_input' : e.code,
        message: status >= 500 ? 'Billing request could not complete.' : e.message,
      },
    });
  });
  await registerBillingRoutes(app, {
    pool,
    policies: policies as never,
    customers: customer as never,
    recharge: recharge as never,
    authenticate: authenticate as never,
    transport: external as never,
    publicUrl: origin,
    terms: { version: 'fixture_terms_v1', text: 'Fixture-only terms' },
    setupAvailable: true,
    automaticRechargeAvailable: false,
    portalAvailable: true,
    recoveryAvailable: true,
    recoveryTransport,
    publishableKey: 'pk_test_synthetic_fixture',
    ...override,
  });
  return {
    app,
    policies,
    customer,
    recharge,
    external,
    client,
    pool,
    authenticate,
    recoveryTransport,
    policy: () => currentPolicy,
  };
}

describe('private billing HTTP permission and closed-schema contracts', () => {
  it('denies ordinary or unapproved admin credentials and never treats manage as history read', async () => {
    const f = await fixture();
    for (const name of ['ordinary', 'admin', 'manager']) {
      expect(
        (await f.app.inject({ url: '/v1/billing/policy', headers: bearer(name) })).statusCode,
      ).toBe(403);
      expect(
        (await f.app.inject({ url: '/v1/billing/documents', headers: bearer(name) })).statusCode,
      ).toBe(403);
      expect(
        (await f.app.inject({ url: '/v1/billing/recharges', headers: bearer(name) })).statusCode,
      ).toBe(403);
    }
    for (const name of ['ordinary', 'admin', 'reader'])
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: '/v1/billing/policy',
            headers: bearer(name),
            payload: policyInput(),
          })
        ).statusCode,
      ).toBe(403);
    expect(f.recharge.listInTransaction).not.toHaveBeenCalled();
    expect(f.policy().version).toBe(1);
  });
  it('lets an explicit member billing manager edit policy without granting workspace/delegation administration', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'PUT',
      url: '/v1/billing/policy',
      headers: bearer('manager'),
      payload: policyInput(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ workspaceId, policy: { version: 2, enabled: false } });
    expect(f.policies.updatePolicy.mock.calls[0]![0]).toMatchObject({
      keyId: ids.manager,
      role: 'member',
      scopes: ['billing:manage'],
    });
    const body = {
      expectedVersion: 0,
      expectedAuthorityVersion: 3,
      target: { kind: 'key', id: randomUUID() },
      rails: {
        allowsEnabled: false,
        maxThresholdMicros: 10000000,
        maxAmountCents: 2500,
        maxMonthlyCapCents: 10000,
        maxAttemptsPerMonth: 4,
        minCooldownSeconds: 86400,
        maxFailureLimit: 3,
      },
      permissions: ['billing:read'],
      consentReference: 'fixture',
    };
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/v1/billing/delegations',
          headers: bearer('manager'),
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    expect(principals.manager!.role).toBe('member');
  });
  it('exposes cached private read pages to explicit readers with no outbound Stripe or worker action', async () => {
    const f = await fixture();
    for (const path of [
      '/v1/billing/policy',
      '/v1/billing/documents?type=invoice&limit=1',
      '/v1/billing/recharges',
    ]) {
      const response = await f.app.inject({ url: path, headers: bearer('reader') });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json().workspaceId).toBe(workspaceId);
    }
    for (const call of Object.values(f.external).filter(vi.isMockFunction))
      expect(call).not.toHaveBeenCalled();
    expect(f.recharge.authentication).not.toHaveBeenCalled();
    expect(f.customer.syncDocuments).not.toHaveBeenCalled();
    expect(f.policies.updatePolicy).not.toHaveBeenCalled();
    expect(f.client.query.mock.calls.map((args) => args[0])).not.toContain('ROLLBACK');
  });
  it('requires both expected browser bindings and the exact Origin for mutations', async () => {
    const f = await fixture();
    const correct = browserHeaders();
    for (const headers of [
      { cookie: 'og_session=owner' },
      { ...correct, 'x-opengen-workspace': 'other' },
      { ...correct, 'x-opengen-recovery-scope': 'stale' },
      { cookie: 'og_session=owner', 'x-opengen-workspace': workspaceId },
    ])
      expect(
        (await f.app.inject({ url: '/v1/billing/policy', headers: headers as never })).statusCode,
      ).toBe(409);
    for (const originValue of [undefined, 'https://evil.example', 'null'])
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: '/v1/billing/policy',
            headers: Object.fromEntries(
              Object.entries({ ...correct, origin: originValue }).filter(
                ([, v]) => v !== undefined,
              ),
            ) as never,
            payload: policyInput(),
          })
        ).statusCode,
      ).toBe(403);
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/v1/billing/policy',
          headers: correct,
          payload: policyInput(),
        })
      ).statusCode,
    ).toBe(200);
  });
  it('rejects cookie/bearer ambiguity, bootstrap, external OAuth and bearer workspace mismatch', async () => {
    const f = await fixture();
    expect(
      (
        await f.app.inject({
          url: '/v1/billing/policy',
          headers: { ...browserHeaders(), ...bearer('reader') },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.app.inject({
          url: '/v1/billing/policy',
          headers: { ...bearer('reader'), 'x-opengen-workspace': 'other' },
        })
      ).statusCode,
    ).toBe(409);
    for (const extra of [{ bootstrap: true }, { externalOAuth: true }]) {
      f.authenticate.mockResolvedValueOnce({ ...principals.reader!, ...extra } as never);
      expect(
        (await f.app.inject({ url: '/v1/billing/policy', headers: bearer('reader') })).statusCode,
      ).toBe(403);
    }
  });
  it('denies API-key-backed browser cookies for every human funding action', async () => {
    const f = await fixture();
    const requests = [
      {
        method: 'POST',
        url: '/v1/billing/setup',
        payload: { termsVersion: 'fixture_terms_v1', acceptedTerms: true },
      },
      { method: 'POST', url: '/v1/billing/portal', payload: {} },
      { method: 'DELETE', url: '/v1/billing/mandate', payload: { id: ids.mandate } },
      {
        method: 'POST',
        url: `/v1/billing/recharges/${ids.attempt}/authentication`,
        payload: { expectedPolicyVersion: 1, expectedAuthorityVersion: 3 },
      },
    ];
    for (const request of requests)
      expect(
        (
          await f.app.inject({
            ...request,
            method: request.method as never,
            headers: browserHeaders('apiCookie'),
          })
        ).statusCode,
      ).toBe(403);
    expect(f.customer.startSetup).not.toHaveBeenCalled();
    expect(f.customer.portal).not.toHaveBeenCalled();
    expect(f.customer.revokeMandate).not.toHaveBeenCalled();
    expect(f.recharge.authentication).not.toHaveBeenCalled();
  });
  it('requires an actual browser session even when a bearer resolves to an internal browser-key principal', async () => {
    const f = await fixture();
    for (const request of [
      {
        method: 'POST',
        url: '/v1/billing/setup',
        payload: { termsVersion: 'fixture_terms_v1', acceptedTerms: true },
      },
      { method: 'POST', url: '/v1/billing/portal', payload: {} },
      { method: 'DELETE', url: '/v1/billing/mandate', payload: { id: ids.mandate } },
      {
        method: 'POST',
        url: `/v1/billing/recharges/${ids.attempt}/authentication`,
        payload: { expectedPolicyVersion: 1, expectedAuthorityVersion: 3 },
      },
    ])
      expect(
        (
          await f.app.inject({
            ...request,
            method: request.method as never,
            headers: { ...bearer('owner'), 'idempotency-key': randomUUID() },
          })
        ).statusCode,
      ).toBe(403);
  });
  it('keeps financial serializers closed against actor/customer/amount/charge injection', async () => {
    const f = await fixture(),
      headers = browserHeaders();
    for (const extra of [
      { actor: principals.owner },
      { customerId: 'cus_arbitrary' },
      { amountCents: 100000 },
      { charge: true },
      { stripeSecret: 'fixture-untrusted' },
    ]) {
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: '/v1/billing/policy',
            headers,
            payload: { ...policyInput(), ...extra },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await f.app.inject({
            method: 'POST',
            url: '/v1/billing/setup',
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: { termsVersion: 'fixture_terms_v1', acceptedTerms: true, ...extra },
          })
        ).statusCode,
      ).toBe(400);
    }
    const nested = policyInput();
    expect(
      (
        await f.app.inject({
          method: 'PUT',
          url: '/v1/billing/policy',
          headers,
          payload: { ...nested, policy: { ...nested.policy, actor: principals.owner } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/portal',
          headers,
          payload: { customerId: 'cus_arbitrary' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: `/v1/billing/recharges/${ids.attempt}/authentication`,
          headers,
          payload: {
            expectedPolicyVersion: 1,
            expectedAuthorityVersion: 3,
            paymentIntentId: 'pi_arbitrary',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(f.customer.startSetup).not.toHaveBeenCalled();
    expect(f.policies.updatePolicy).not.toHaveBeenCalled();
  });
  it('retains stale policy/owner versions as conflicts rather than retrying financially effective changes', async () => {
    const f = await fixture();
    for (const change of [{ expectedVersion: 0 }, { expectedAuthorityVersion: 2 }])
      expect(
        (
          await f.app.inject({
            method: 'PUT',
            url: '/v1/billing/policy',
            headers: bearer('manager'),
            payload: { ...policyInput(), ...change },
          })
        ).statusCode,
      ).toBe(409);
    expect(f.policy().version).toBe(1);
    expect(f.policies.updatePolicy).toHaveBeenCalledTimes(2);
  });
  it('fails closed for unconfigured source gates before invoking hosted services', async () => {
    const f = await fixture({
      setupAvailable: false,
      portalAvailable: false,
      recoveryAvailable: false,
      automaticRechargeAvailable: false,
      transport: undefined,
      recoveryTransport: undefined,
    });
    const headers = { ...browserHeaders(), 'idempotency-key': randomUUID() };
    for (const request of [
      {
        method: 'POST',
        url: '/v1/billing/setup',
        payload: { termsVersion: 'fixture_terms_v1', acceptedTerms: true },
      },
      { method: 'POST', url: '/v1/billing/portal', payload: {} },
      {
        method: 'POST',
        url: `/v1/billing/recharges/${ids.attempt}/authentication`,
        payload: { expectedPolicyVersion: 1, expectedAuthorityVersion: 3 },
      },
    ])
      expect(
        (await f.app.inject({ ...request, method: request.method as never, headers })).statusCode,
      ).toBe(409);
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/v1/billing/documents/sync',
          headers,
          payload: { type: 'invoice', limit: 20 },
        })
      ).statusCode,
    ).toBe(503);
    expect(f.customer.startSetup).not.toHaveBeenCalled();
    expect(f.customer.portal).not.toHaveBeenCalled();
    expect(f.recharge.authentication).not.toHaveBeenCalled();
    expect(f.customer.syncDocuments).not.toHaveBeenCalled();
  });
  it('preserves native policy/document/recharge page shapes through the existing browser request helper', async () => {
    const f = await fixture();
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input), origin);
      const response = await f.app.inject({
        method: (init?.method ?? 'GET') as never,
        url: url.pathname.replace(/^\/api\//, '/v1/') + url.search,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: 'og_session=owner' },
        payload: init?.body as never,
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: response.headers as never,
      });
    };
    const init = {
      headers: { 'x-opengen-recovery-scope': browserHeaders()['x-opengen-recovery-scope'] },
    };
    const state = await policyRequest<BillingPolicyState>(
      workspaceId,
      '/api/billing/policy',
      init,
      request,
    );
    expect(state).toMatchObject({
      workspaceId,
      ownerAuthorityVersion: 3,
      automaticRechargeAvailable: false,
      setupAvailable: true,
      recoveryAvailable: true,
      mandate: { id: ids.mandate, status: 'active' },
    });
    const documents = await policyRequest<{
      workspaceId: string;
      data: unknown[];
      nextCursor: string;
    }>(workspaceId, '/api/billing/documents?type=invoice', init, request);
    expect(documents.data).toHaveLength(1);
    expect(documents.nextCursor).toBe('in_fixture');
    const recharges = await policyRequest<{ workspaceId: string; data: unknown[] }>(
      workspaceId,
      '/api/billing/recharges',
      init,
      request,
    );
    expect(recharges.data).toHaveLength(1);
  });
  it('returns the original owner-authorized authentication response in the real UI shape with no secret on history reads', async () => {
    const f = await fixture();
    const response = await f.app.inject({
      method: 'POST',
      url: `/v1/billing/recharges/${ids.attempt}/authentication`,
      headers: browserHeaders(),
      payload: { expectedPolicyVersion: 1, expectedAuthorityVersion: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(() =>
      validateRechargeAuthentication(response.json(), {
        id: ids.attempt,
        workspaceId,
        amountCents: 2500,
        status: 'requires_authentication',
      }),
    ).not.toThrow();
    const history = await f.app.inject({ url: '/v1/billing/recharges', headers: browserHeaders() });
    expect(history.body).not.toContain('secret_');
    expect(history.body).not.toContain('publishableKey');
    expect(f.recoveryTransport.retrieveRechargeRecovery).not.toHaveBeenCalled(); // Store owns this boundary; HTTP never creates a second payment.
  });
  it('keeps documented JSON examples executable and metadata clear about future charges', () => {
    expect(billingPolicyInputSchema.parse(policyInput())).toMatchObject({
      expectedVersion: 1,
      expectedAuthorityVersion: 3,
    });
    expect(
      billingSetupInputSchema.parse({ termsVersion: 'fixture_terms_v1', acceptedTerms: true }),
    ).toEqual({ termsVersion: 'fixture_terms_v1', acceptedTerms: true });
    expect(() => billingSetupInputSchema.parse({ consent: true, actor: 'owner' })).toThrow();
    expect(billingOperationMetadata['billing.policy.update']).toMatchObject({
      scope: 'billing:manage',
      financialEffects: true,
      readOnly: false,
    });
    for (const name of [
      'billing.policy.get',
      'billing.recharges.list',
      'billing.documents.list',
    ] as const)
      expect(billingOperationMetadata[name]).toMatchObject({
        scope: 'billing:read',
        financialEffects: false,
        readOnly: true,
      });
  });
});
