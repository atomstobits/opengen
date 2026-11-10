import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerBillingRoutes } from '../apps/server/src/billing.js';
import { openApiDocument } from '../apps/server/src/openapi.js';
import { BillingCustomerStore } from '../packages/engine/src/billing-customer.js';
import {
  BillingPolicyStore,
  type BillingPolicy,
  type BillingPrincipal,
} from '../packages/engine/src/billing-policy.js';
import { billingFixture } from './billing-fixture.js';

const specification = openApiDocument(true);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function responseValidator(path: string, method = 'get') {
  const operation = specification.paths[path]![method] as {
    responses: Record<string, { content: Record<string, { schema: object }> }>;
  };
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  return ajv.compile({
    ...operation.responses['200']!.content['application/json']!.schema,
    components: specification.components,
  });
}

async function fixture() {
  const f = await billingFixture();
  cleanup.push(() => f.close());
  // Source authentication is fixed for this fixture. The real stores recheck
  // its seeded membership, funding owner, mandate and versioned policy rows.
  const actor: BillingPrincipal = {
    workspaceId: f.workspace,
    keyKind: 'browser',
    keyId: randomUUID(),
    membershipId: f.memberId,
    role: 'admin',
    identity: { issuer: 'https://fixture.example', subject: 'fixture-billing-owner' },
    scopes: ['billing:read', 'billing:manage'],
  };
  const policies = new BillingPolicyStore(f.pool, {
    revalidateAuthority: async (_client, current) => ({ ...current }),
  });
  const customers = new BillingCustomerStore(f.pool, {
    processorEnvironment: f.processorEnvironment,
    terms: { version: 'fixture-v1', text: 'Fixture-only terms.' },
    authorize: policies.authorizeInTransaction.bind(policies),
    lockExternalInTransaction: (client) => f.store.lockExternalInTransaction(client),
    admitExternalInTransaction: (client, workspace) =>
      f.store.admitExternalInTransaction(client, workspace),
  });
  const app = Fastify();
  cleanup.push(() => app.close());
  await registerBillingRoutes(app, {
    pool: f.pool,
    policies,
    customers,
    recharge: f.recharge,
    authenticate: async () => actor,
    publicUrl: 'https://fixture.example',
    terms: null,
  });
  return { ...f, app };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('published billing response contracts', () => {
  it('describes the actual policy read and CAS update, including default and current versions', async () => {
    const f = await fixture();
    const read = await f.app.inject({ url: '/v1/billing/policy' });
    expect(read.statusCode, read.body).toBe(200);
    const state = read.json<{ policy: BillingPolicy; ownerAuthorityVersion: number }>();
    const validateRead = responseValidator('/v1/billing/policy');
    expect(validateRead(state), JSON.stringify(validateRead.errors)).toBe(true);
    expect(validateRead({ ...state, ownerAuthorityVersion: undefined })).toBe(false);
    expect(validateRead({ ...state, ownerAuthorityVersion: '1' })).toBe(false);
    expect(validateRead({ ...state, policy: { ...state.policy, version: undefined } })).toBe(false);
    expect(validateRead({ ...state, policy: { ...state.policy, version: '1' } })).toBe(false);

    const { workspaceId, version, ownerAuthorityVersion, updatedAt, ...values } = state.policy;
    const updated = await f.app.inject({
      method: 'PUT',
      url: '/v1/billing/policy',
      payload: {
        expectedVersion: version,
        expectedAuthorityVersion: state.ownerAuthorityVersion,
        policy: { ...values, enabled: false },
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const result = updated.json<{ workspaceId: string; policy: BillingPolicy }>();
    const validateUpdate = responseValidator('/v1/billing/policy', 'put');
    expect(validateUpdate(result), JSON.stringify(validateUpdate.errors)).toBe(true);
    expect(result.policy.version).toBe(version + 1);
    expect(result.policy.enabled).toBe(false);
    expect(validateUpdate({ ...result, policy: undefined })).toBe(false);
    expect(validateUpdate({ ...result, policy: { ...result.policy, version: -1 } })).toBe(false);

    await f.pool.query('DELETE FROM mr_billing_policies WHERE workspace_id=$1', [workspaceId]);
    const defaults = (await f.app.inject({ url: '/v1/billing/policy' })).json();
    expect(defaults.policy).toMatchObject({
      version: 0,
      ownerAuthorityVersion: null,
      updatedAt: null,
    });
    expect(validateRead(defaults), JSON.stringify(validateRead.errors)).toBe(true);
  });

  it('describes persisted recharge projections without dispatching payment work', async () => {
    const f = await fixture();
    const attempt = await f.recharge.admit(f.workspace);
    expect(attempt).not.toBeNull();
    const response = await f.app.inject({ url: '/v1/billing/recharges' });
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{ workspaceId: string; data: object[] }>();
    expect(result.data).toEqual([attempt]);
    expect(f.creates).toEqual([]);
    const validate = responseValidator('/v1/billing/recharges');
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...result, data: [{ ...attempt, status: 'charged' }] })).toBe(false);
    expect(validate({ ...result, data: [{ ...attempt, amountCents: -1 }] })).toBe(false);
    expect(validate({ ...result, data: [{ ...attempt, policyVersion: undefined }] })).toBe(false);
    expect(validate({ ...result, data: [{ ...attempt, createdAt: 'invalid' }] })).toBe(false);
    expect(validate({ ...result, data: [{ ...attempt, customerId: f.customerId }] })).toBe(false);
  });

  it('describes actual cached document pages and the next cursor used by the handler', async () => {
    const f = await fixture();
    for (const [type, id, date, url] of [
      [
        'invoice',
        'in_schema_fixture',
        '2030-01-14T00:00:00Z',
        'https://invoice.stripe.com/i/fixture',
      ],
      ['receipt', 'ch_schema_fixture', '2030-01-13T00:00:00Z', null],
    ])
      await f.pool.query(
        `INSERT INTO mr_billing_documents
         (workspace_id,livemode,processor_environment_id,processor_account_id,type,id,customer_id,
          amount_cents,currency,status,document_created_at,url,pdf_url)
         VALUES($1,false,$2,$3,$4,$5,$6,1000,'usd','paid',$7,$8,NULL)`,
        [
          f.workspace,
          f.processorEnvironment.id,
          f.processorEnvironment.accountId,
          type,
          id,
          f.customerId,
          date,
          url,
        ],
      );
    const first = await f.app.inject({ url: '/v1/billing/documents?limit=1' });
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json<{ workspaceId: string; data: object[]; nextCursor: string }>();
    const validate = responseValidator('/v1/billing/documents');
    expect(validate(page), JSON.stringify(validate.errors)).toBe(true);
    expect(page.nextCursor).toBe('in_schema_fixture');
    expect(validate({ ...page, nextCursor: undefined })).toBe(false);
    expect(validate({ ...page, nextCursor: 1 })).toBe(false);
    expect(validate({ ...page, data: [{ ...page.data[0], amountCents: '1000' }] })).toBe(false);
    expect(validate({ ...page, data: [{ ...page.data[0], customerId: f.customerId }] })).toBe(
      false,
    );
    const second = await f.app.inject({
      url: `/v1/billing/documents?limit=1&before=${encodeURIComponent(page.nextCursor)}`,
    });
    expect(second.statusCode, second.body).toBe(200);
    const last = second.json();
    expect(last).toMatchObject({
      data: [{ id: 'ch_schema_fixture', url: null, pdfUrl: null }],
      nextCursor: null,
    });
    expect(validate(last), JSON.stringify(validate.errors)).toBe(true);
  });
});
