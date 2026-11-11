import { describe, expect, it } from 'vitest';
import {
  draftFromPolicy,
  enrollBillingOwner,
  finishSetupRecovery,
  exactUsdDisplay,
  exactUsdInput,
  hostedBillingUrl,
  policyFromDraft,
  policyRequest,
  prepareSetupRecovery,
  readBillingAccess,
  readSetupRecovery,
  readSetupStatus,
  rememberSetupResult,
  setupStatusId,
  syncDocumentPage,
  retrySeconds,
} from '../apps/web/app/billing/policy-client';
import { privateWorkspaceHeaders } from '../apps/web/app/dashboard/activity-view';
import { BILLING_POLICY_DEFAULTS } from '../packages/engine/src/billing-policy';
const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
};
describe('private billing policy browser helpers', () => {
  it('requires verified capability booleans from the current workspace and recovery scope', async () => {
    const authority = { workspaceId: 'workspace-a', recoveryScope: 'member-a-v1' };
    const capabilities = { read: true, manage: false, setup: false };
    const controller = new AbortController();
    await expect(
      readBillingAccess(authority, controller.signal, async (url, init) => {
        expect(url).toBe('/api/billing/access');
        expect(init?.headers).toEqual(privateWorkspaceHeaders(authority));
        expect(init?.credentials).toBe('same-origin');
        expect(init?.cache).toBe('no-store');
        expect(init?.signal).toBe(controller.signal);
        return Response.json({
          ...authority,
          capabilities: { ...capabilities, ignored: 'fixture' },
        });
      }),
    ).resolves.toEqual(capabilities);
    for (const result of [
      { ...authority, workspaceId: 'workspace-b', capabilities },
      { ...authority, recoveryScope: 'member-a-v2', capabilities },
      { ...authority, capabilities: { ...capabilities, setup: 1 } },
      { ...authority, capabilities: null },
    ])
      await expect(
        readBillingAccess(authority, undefined, async () => Response.json(result)),
      ).rejects.toThrow(/could not be verified/);
    await expect(
      readBillingAccess(authority, undefined, async () => new Response(null, { status: 404 })),
    ).resolves.toBeNull();
    await expect(
      readBillingAccess(authority, undefined, async () =>
        Response.json({
          ...authority,
          capabilities: { read: false, manage: false, setup: false },
          ownerEnrollment: {
            eligible: true,
            expectedAuthorityVersion: 0,
            terms: { version: 'manual-terms-v1', text: 'Prepaid non-recurring summary.' },
          },
        }),
      ),
    ).resolves.toEqual({
      read: false,
      manage: false,
      setup: false,
      ownerEnrollment: {
        eligible: true,
        expectedAuthorityVersion: 0,
        terms: { version: 'manual-terms-v1', text: 'Prepaid non-recurring summary.' },
      },
    });
    for (const invalidEnrollment of [
      { eligible: 'yes', expectedAuthorityVersion: 0, terms: { version: 'v1', text: 'text' } },
      { eligible: true, expectedAuthorityVersion: -1, terms: { version: 'v1', text: 'text' } },
      { eligible: true, expectedAuthorityVersion: 0, terms: { version: '', text: 'text' } },
      {
        eligible: false,
        expectedAuthorityVersion: 0,
        terms: { version: 'v1', text: 'text' },
        reason: 'unexpected-reason',
      },
    ])
      await expect(
        readBillingAccess(authority, undefined, async () =>
          Response.json({
            ...authority,
            capabilities: { read: false, manage: false, setup: false },
            ownerEnrollment: invalidEnrollment,
          }),
        ),
      ).rejects.toThrow(/could not be verified/);
    await expect(
      enrollBillingOwner({
        ...authority,
        expectedAuthorityVersion: 0,
        termsVersion: 'manual-terms-v1',
        request: async (url, init) => {
          expect(url).toBe('/api/billing/owner');
          expect(init?.method).toBe('POST');
          expect(new Headers(init?.headers).get('x-opengen-workspace')).toBe('workspace-a');
          expect(new Headers(init?.headers).get('x-opengen-recovery-scope')).toBe('member-a-v1');
          expect(JSON.parse(String(init?.body))).toEqual({
            expectedAuthorityVersion: 0,
            termsVersion: 'manual-terms-v1',
            acceptedTerms: true,
          });
          return Response.json({ workspaceId: 'workspace-a', authorityVersion: 1 });
        },
      }),
    ).resolves.toEqual({ workspaceId: 'workspace-a', authorityVersion: 1 });
    await expect(
      enrollBillingOwner({
        ...authority,
        expectedAuthorityVersion: 0,
        termsVersion: 'manual-terms-v1',
        request: async () => Response.json({ workspaceId: 'workspace-b', authorityVersion: 1 }),
      }),
    ).rejects.toThrow(/workspace changed/);
  });

  it('keeps exact six-decimal thresholds and whole-cent funding values without floating point money', () => {
    expect(exactUsdInput('1.000001', 6)).toBe(1_000_001);
    expect(exactUsdInput('25.01', 2)).toBe(2501);
    expect(exactUsdInput('1.001', 2)).toBeNull();
    expect(exactUsdInput('9007199254.740992', 6)).toBeNull();
    expect(exactUsdDisplay(Number.MAX_SAFE_INTEGER, 6)).toBe('9007199254.740991');
    expect(exactUsdInput('1e3', 2)).toBeNull();
    const policy = {
      ...BILLING_POLICY_DEFAULTS,
      workspaceId: 'workspace-a',
      version: 0,
      updatedAt: null,
      ownerAuthorityVersion: null,
    };
    expect(policyFromDraft(draftFromPolicy(policy), null)).toEqual(BILLING_POLICY_DEFAULTS);
    expect(() => policyFromDraft({ ...draftFromPolicy(policy), enabled: true }, null)).toThrow(
      /setup/,
    );
    expect(() => policyFromDraft({ ...draftFromPolicy(policy), maxAttempts: '1.5' }, null)).toThrow(
      /whole numbers/,
    );
  });
  it('keeps the same workspace setup identity and consent terms across timeouts and reloads', () => {
    const storage = memory();
    const first = prepareSetupRecovery(
      storage,
      'workspace-a',
      'member-a-v1',
      'terms-v1',
      () => 'fixture-key-12345',
    );
    expect(
      prepareSetupRecovery(storage, 'workspace-a', 'member-a-v1', 'terms-v1', () => {
        throw new Error('must not replace');
      }),
    ).toEqual(first);
    expect(readSetupRecovery(storage, 'workspace-b', 'member-a-v1')).toBeNull();
    expect(readSetupRecovery(storage, 'workspace-a', 'member-b-v1')).toBeNull();
    expect(() => prepareSetupRecovery(storage, 'workspace-a', 'member-a-v1', 'terms-v2')).toThrow(
      /terms changed/,
    );
    const malformed = memory();
    malformed.setItem('opengen.billing.setup.v1:["workspace-a","member-a-v1"]', 'broken');
    expect(() => prepareSetupRecovery(malformed, 'workspace-a', 'member-a-v1', 'terms-v1')).toThrow(
      /needs review/,
    );
  });
  it('carries workspace preconditions and rejects a switched-workspace response', async () => {
    await expect(
      policyRequest(
        'workspace-a',
        '/api/billing/policy',
        {
          headers: privateWorkspaceHeaders({
            workspaceId: 'workspace-a',
            recoveryScope: 'member-a-v1',
          }),
        },
        async (_url, init) => {
          expect(new Headers(init?.headers).get('x-opengen-workspace')).toBe('workspace-a');
          expect(init?.credentials).toBe('same-origin');
          expect(init?.cache).toBe('no-store');
          expect(new Headers(init?.headers).get('x-opengen-recovery-scope')).toBe('member-a-v1');
          return Response.json({ workspaceId: 'workspace-b' });
        },
      ),
    ).rejects.toThrow(/workspace changed/);
  });
  it('uses Retry-After to wait and never automatically retries a rate-limited mutation', async () => {
    let calls = 0;
    await expect(
      policyRequest(
        'workspace-a',
        '/api/billing/setup',
        { method: 'POST', headers: { 'x-opengen-recovery-scope': 'member-a-v1' } },
        async () => {
          calls++;
          return Response.json(
            { error: 'limited' },
            { status: 429, headers: { 'retry-after': '90' } },
          );
        },
      ),
    ).rejects.toMatchObject({ retryAfterSeconds: 90 });
    expect(calls).toBe(1);
    expect(retrySeconds('Fri, 01 Jan 2027 00:00:30 GMT', Date.parse('2027-01-01T00:00:00Z'))).toBe(
      30,
    );
    expect(retrySeconds(null)).toBe(60);
  });

  it('retains the workspace envelope on paginated native documents and rejects missing authority', async () => {
    const page = {
      workspaceId: 'workspace-a',
      data: [{ id: 'invoice-1' }],
      hasMore: false,
      nextCursor: null,
    };
    expect(
      await policyRequest(
        'workspace-a',
        '/api/billing/documents',
        { headers: { 'x-opengen-recovery-scope': 'member-a-v1' } },
        async () => Response.json(page),
      ),
    ).toEqual(page);
    expect(() => policyRequest('workspace-a', '/api/billing/policy')).toThrow(/browser session/);
  });
  it('reads an accepted setup by reference without re-posting consent or trusting a return URL', async () => {
    const storage = memory(),
      workspaceId = 'workspace-a',
      recoveryScope = 'member-a-v1';
    const id = '24250436-0606-4da0-9877-b65fe61d78de';
    const other = 'fef44d21-4fa9-413f-9c98-6c87568612ce';
    const saved = prepareSetupRecovery(
      storage,
      workspaceId,
      recoveryScope,
      'terms-v1',
      () => 'fixture-key-12345',
    );
    const original = {
      workspaceId,
      id,
      status: 'pending' as const,
      checkoutUrl: null,
      mandateId: null,
      termsVersion: 'terms-v1',
    };
    expect(setupStatusId(`?setup=success&request=${id}`)).toBe(id);
    expect(setupStatusId('?setup=success&request=not-a-reference')).toBeNull();
    const pending = await readSetupStatus({
      workspaceId,
      recoveryScope,
      setupId: id,
      request: async (url, init) => {
        expect(url).toBe(`/api/billing/setups/${id}`);
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        expect(new Headers(init?.headers).get('x-opengen-recovery-scope')).toBe(recoveryScope);
        return Response.json(original);
      },
    });
    expect(pending.status).toBe('pending');
    expect(
      finishSetupRecovery(storage, workspaceId, recoveryScope, { ...pending, status: 'complete' }),
    ).toBe(false);
    rememberSetupResult(storage, saved, original);
    expect(readSetupRecovery(storage, workspaceId, recoveryScope)?.setupId).toBe(id);
    expect(setupStatusId(`?setup=cancel&request=${other}`, id)).toBe(id);
    expect(
      finishSetupRecovery(storage, workspaceId, recoveryScope, {
        ...original,
        id: other,
        status: 'complete',
      }),
    ).toBe(false);
    await expect(
      readSetupStatus({
        workspaceId,
        recoveryScope,
        setupId: id,
        request: async () => Response.json({ ...original, id: other }),
      }),
    ).rejects.toThrow(/does not match/);
    const terminal = await readSetupStatus({
      workspaceId,
      recoveryScope,
      setupId: id,
      request: async () => Response.json({ ...original, status: 'complete' }),
    });
    expect(finishSetupRecovery(storage, workspaceId, recoveryScope, terminal)).toBe(true);
    expect(readSetupRecovery(storage, workspaceId, recoveryScope)).toBeNull();
  });
  it('forwards Stripe sync pagination separately from the cached document before cursor', async () => {
    const calls: unknown[] = [];
    const options = {
      workspaceId: 'workspace-a',
      recoveryScope: 'member-a-v1',
      type: 'invoice' as const,
      request: async (url: RequestInfo | URL, init?: RequestInit) => {
        expect(url).toBe('/api/billing/documents/sync');
        expect(init?.method).toBe('POST');
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({
          workspaceId: 'workspace-a',
          hasMore: calls.length === 1,
          nextCursor: calls.length === 1 ? 'in_original_page_end' : null,
        });
      },
    };
    const cursor = await syncDocumentPage(options);
    expect(cursor).toBe('in_original_page_end');
    expect(await syncDocumentPage({ ...options, cursor: cursor! })).toBeNull();
    expect(calls).toEqual([
      { type: 'invoice', limit: 20 },
      { type: 'invoice', limit: 20, cursor: 'in_original_page_end' },
    ]);
    await expect(syncDocumentPage({ ...options, cursor: 'ch_foreign_kind' })).rejects.toThrow(
      /original document sync cursor/,
    );
    expect(calls).toHaveLength(2);
  });
  it('uses the same fragment-preserving Checkout validation for payment-method setup links', () => {
    const checkout =
      'https://checkout.stripe.com/c/pay/cs_test_a1SetupFixture123#fidkdWxOYHwnPyd1blpxYHZxWjA0Fixture%2Fencoded%2Bstate%3D%3D';
    expect(hostedBillingUrl(checkout, 'checkout')).toBe(checkout);
    for (const unsafe of [
      checkout.replace('https:', 'http:'),
      checkout.replace('checkout.stripe.com', 'checkout.stripe.com.attacker.example'),
      checkout.replace('checkout.stripe.com', 'user:pass@checkout.stripe.com'),
      checkout.replace('checkout.stripe.com', 'checkout.stripe.com:444'),
      checkout.replace('/c/pay/', '/redirect/'),
    ])
      expect(() => hostedBillingUrl(unsafe, 'checkout')).toThrow();
    expect(() =>
      hostedBillingUrl('https://billing.stripe.com/p/session/fixture#state', 'portal'),
    ).toThrow();
    expect(() =>
      hostedBillingUrl('https://invoice.stripe.com/i/fixture#state', 'document'),
    ).toThrow();
  });

  it('allows only the expected hosted Stripe destinations', () => {
    expect(hostedBillingUrl('https://billing.stripe.com/p/session/fixture', 'portal')).toContain(
      'billing.stripe.com',
    );
    expect(hostedBillingUrl('https://invoice.stripe.com/i/fixture', 'document')).toContain(
      'invoice.stripe.com',
    );
    for (const bad of [
      'https://billing.stripe.com.attacker.example',
      'https://user:pass@billing.stripe.com',
      'http://billing.stripe.com',
      'https://checkout.stripe.com/',
    ])
      expect(() => hostedBillingUrl(bad, 'portal')).toThrow();
  });
});
