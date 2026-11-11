import { expect, test, type Page } from '@playwright/test';
import { BILLING_POLICY_DEFAULTS } from '../../../packages/engine/src/billing-policy';
import type { BillingCapabilities } from '../app/billing/policy-client';
import type { BillingSummary, PaymentOrder, PendingTopUp } from '../app/billing/billing-client';

const workspaceId = 'billing-fixture-studio';
const orderId = 'fb9b9f71-8a08-4df5-8888-000000000001';
const recoveryKey = `opengen.billing.v1:${workspaceId}`;
const checkoutUrl =
  'https://checkout.stripe.com/c/pay/billing_browser_fixture#opaque-provider-state';
const currentTopUp = (page: Page) => page.locator('section[aria-labelledby="current-top-up"]');
const payment = (status: PaymentOrder['status'] = 'created'): PaymentOrder => ({
  id: orderId,
  workspaceId,
  amountCents: 2500,
  creditMicros: 25_000_000,
  currency: 'USD',
  status,
  checkoutUrl: status === 'checkout_open' ? checkoutUrl : null,
  createdAt: '2026-11-03T12:00:00Z',
  updatedAt: '2026-11-03T12:00:00Z',
  creditedAt: status === 'credited' ? '2026-11-03T12:01:00Z' : null,
});

async function billingFixture(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error('Billing browser fixtures require the local Playwright base URL.');
  const origin = new URL(baseURL).origin;
  const state = {
    authenticated: true,
    oidcEnabled: false,
    recoveryScope: undefined as string | undefined,
    capabilities: null as BillingCapabilities | null,
    accessReads: [] as string[],
    privateReads: [] as string[],
    enabled: true,
    newFunding: undefined as BillingSummary['newFunding'],
    held: false,
    summaryIncludesOrders: true,
    abortNextCreate: false,
    checkoutStatus: 'checkout_open' as PaymentOrder['status'],
    orders: new Map<string, PaymentOrder>(),
    keys: new Map<string, string>(),
    creates: [] as { key: string; amountCents: number; persisted: PendingTopUp | null }[],
    checkouts: [] as string[],
    reads: [] as string[],
    summaries: 0,
    hostedVisits: 0,
    unexpected: [] as string[],
  };
  await page.context().addCookies([
    {
      name: 'og_session',
      value: 'fixture-billing-session',
      url: origin,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    // Hosted checkout is a static fixture: no Stripe scripts, card entry or external traffic.
    if (url.origin === 'https://checkout.stripe.com') {
      if (url.href !== checkoutUrl.split('#')[0] || !request.isNavigationRequest()) {
        await route.abort('blockedbyclient');
        return;
      }
      state.hostedVisits++;
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Fixture checkout</title><h1>Fixture hosted checkout</h1>',
      });
      return;
    }
    if (url.origin !== origin) {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.pathname === '/api/session') {
      await route.fulfill({
        json: {
          authenticated: state.authenticated,
          workspaceId,
          oidcEnabled: state.oidcEnabled,
          recoveryScope: state.recoveryScope,
        },
      });
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (!url.pathname.startsWith('/api/billing')) {
      state.unexpected.push(`${request.method()} ${url.pathname}`);
      await route.fulfill({
        status: 500,
        json: { error: 'Unexpected API request in billing fixture.' },
      });
      return;
    }
    const headers = await request.allHeaders();
    expect(state.authenticated).toBe(true);
    expect(headers['x-opengen-workspace']).toBe(workspaceId);
    expect(headers['cookie']).toContain('og_session=fixture-billing-session');
    expect(headers['authorization']).toBeUndefined();
    if (state.recoveryScope) expect(headers['x-opengen-recovery-scope']).toBe(state.recoveryScope);
    if (url.pathname === '/api/billing/access' && request.method() === 'GET') {
      state.accessReads.push(headers['x-opengen-recovery-scope'] ?? '');
      await route.fulfill(
        state.capabilities
          ? {
              json: {
                workspaceId,
                recoveryScope: state.recoveryScope,
                capabilities: {
                  read: state.capabilities.read,
                  manage: state.capabilities.manage,
                  setup: state.capabilities.setup,
                },
                ...(state.capabilities.ownerEnrollment
                  ? { ownerEnrollment: state.capabilities.ownerEnrollment }
                  : {}),
              },
            }
          : { status: 404, json: { error: 'Fixture runtime unavailable.' } },
      );
      return;
    }
    if (url.pathname === '/api/billing/owner' && request.method() === 'POST') {
      const payload = request.postDataJSON() as {
        expectedAuthorityVersion: number;
        termsVersion: string;
        acceptedTerms: boolean;
      };
      expect(payload).toEqual({
        expectedAuthorityVersion:
          state.capabilities?.ownerEnrollment?.expectedAuthorityVersion ?? 0,
        termsVersion: state.capabilities?.ownerEnrollment?.terms.version ?? '',
        acceptedTerms: true,
      });
      state.capabilities = { read: true, manage: true, setup: true };
      await route.fulfill({ json: { workspaceId, authorityVersion: 1 } });
      return;
    }
    if (
      state.capabilities?.read &&
      request.method() === 'GET' &&
      ['/api/billing/policy', '/api/billing/recharges', '/api/billing/documents'].includes(
        url.pathname,
      )
    ) {
      state.privateReads.push(url.pathname);
      await route.fulfill({
        json:
          url.pathname === '/api/billing/policy'
            ? {
                workspaceId,
                policy: {
                  ...BILLING_POLICY_DEFAULTS,
                  workspaceId,
                  version: 0,
                  ownerAuthorityVersion: null,
                  updatedAt: null,
                },
                automaticRechargeAvailable: false,
                setupAvailable: false,
                portalAvailable: false,
                recoveryAvailable: false,
                ownerAuthorityVersion: null,
                terms: null,
                mandate: null,
              }
            : { workspaceId, data: [], nextCursor: null },
      });
      return;
    }
    if (url.pathname === '/api/billing' && request.method() === 'GET') {
      state.summaries++;
      const summary: BillingSummary = {
        enabled: state.enabled,
        newFunding: state.newFunding,
        workspaceId,
        currency: 'USD',
        minAmountCents: 500,
        maxAmountCents: 100000,
        billingHold: state.held,
        orders: state.summaryIncludesOrders ? [...state.orders.values()] : [],
      };
      await route.fulfill({ json: summary });
      return;
    }
    if (url.pathname === '/api/billing/orders' && request.method() === 'POST') {
      const { amountCents } = request.postDataJSON() as { amountCents: number };
      const key = headers['idempotency-key'] ?? '';
      expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      const persisted = (await page.evaluate((name) => {
        const value = localStorage.getItem(name);
        return value ? JSON.parse(value) : null;
      }, recoveryKey)) as PendingTopUp | null;
      // Observe real browser storage at request interception, before the server accepts anything.
      expect(persisted).toMatchObject({
        version: 1,
        workspaceId,
        amountCents,
        idempotencyKey: key,
      });
      state.creates.push({ key, amountCents, persisted });
      let id = state.keys.get(key);
      if (!id) {
        id = `fb9b9f71-8a08-4df5-8888-${String(state.keys.size + 1).padStart(12, '0')}`;
        state.keys.set(key, id);
        state.orders.set(id, { ...payment(), id, amountCents, creditMicros: amountCents * 10000 });
      }
      if (state.abortNextCreate) {
        state.abortNextCreate = false;
        await route.abort('failed'); // The fixture accepted the order but the response was lost.
      } else await route.fulfill({ status: 201, json: state.orders.get(id) });
      return;
    }
    const match = /^\/api\/billing\/orders\/([0-9a-f-]+)(\/checkout)?$/.exec(url.pathname);
    const order = match ? state.orders.get(match[1]!) : undefined;
    if (order && match) {
      if (!match[2] && request.method() === 'GET') {
        state.reads.push(order.id);
        await route.fulfill({ json: order });
        return;
      }
      if (match[2] && request.method() === 'POST') {
        expect(request.postDataJSON()).toEqual({});
        state.checkouts.push(order.id);
        const next = {
          ...order,
          status: state.checkoutStatus,
          checkoutUrl: state.checkoutStatus === 'checkout_open' ? checkoutUrl : null,
        };
        state.orders.set(order.id, next);
        await route.fulfill({ json: next });
        return;
      }
    }
    state.unexpected.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({ status: 404, json: { error: 'Fixture order not found.' } });
  });
  return state;
}

async function seedRecovery(page: Page, baseURL: string | undefined) {
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(
    ({ origin, key, saved }) => {
      if (location.origin === origin && !localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify(saved));
    },
    {
      origin,
      key: recoveryKey,
      saved: {
        version: 1,
        workspaceId,
        amountCents: 2500,
        idempotencyKey: 'fixture-existing-topup-key',
        orderId,
      },
    },
  );
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`billing on ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('signed-out visitors cannot initiate a payment', async ({ page, baseURL }) => {
      const f = await billingFixture(page, baseURL);
      f.authenticated = false;
      await page.goto('/billing');
      await expect(
        page.getByRole('heading', { name: 'Keep your next idea moving.' }),
      ).toBeVisible();
      await expect(
        page.getByText('Sign in to add credit and see your payment history.'),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Open your workspace', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue to Stripe/ })).toHaveCount(0);
      expect(f.summaries).toBe(0);
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('an absent policy runtime keeps legacy manual funding available', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.recoveryScope = 'fixture-legacy-browser-authority';
      await page.goto('/billing');
      await expect.poll(() => f.accessReads).toContain(f.recoveryScope);
      await expect(page.getByRole('button', { name: /Continue to Stripe/ })).toBeEnabled();
      await expect(page.getByRole('heading', { name: /Keep creating.*Keep control/ })).toHaveCount(
        0,
      );
      expect(f.privateReads).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('verified billing access is refreshed when the current browser authority changes', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.recoveryScope = 'fixture-readonly-browser-authority';
      f.capabilities = { read: true, manage: false, setup: false };
      await page.goto('/billing');
      const panel = page.getByRole('region', { name: /Keep creating.*Keep control/ });
      await expect(panel).toContainText('Automatic charging is not active on this installation.');
      await expect(panel.getByRole('checkbox', { name: /Automatic recharge/ })).toBeDisabled();
      await expect
        .poll(() => new Set(f.privateReads))
        .toEqual(
          new Set(['/api/billing/policy', '/api/billing/recharges', '/api/billing/documents']),
        );
      const previousReads = f.privateReads.length;
      await page.evaluate(
        ({ key, workspace, id }) => {
          localStorage.setItem(
            key,
            JSON.stringify({
              version: 1,
              workspaceId: workspace,
              amountCents: 12345,
              idempotencyKey: 'fixture-prior-actor-order',
              orderId: id,
            }),
          );
        },
        { key: recoveryKey, workspace: workspaceId, id: orderId },
      );
      const previousSummaries = f.summaries;
      f.recoveryScope = 'fixture-limited-browser-authority';
      f.capabilities = { read: false, manage: false, setup: false };
      await page.evaluate(() => window.dispatchEvent(new Event('opengen:session-changed')));
      await expect(page.getByRole('region', { name: 'Billing access' })).toBeVisible();
      await expect(panel).toHaveCount(0);
      expect(f.accessReads).toContain(f.recoveryScope);
      expect(f.privateReads).toHaveLength(previousReads);
      expect(f.summaries).toBe(previousSummaries);
      expect(f.reads).toEqual([]);
      await expect(currentTopUp(page)).toHaveCount(0);
      await expect(page.getByText('$123.45', { exact: true })).toHaveCount(0);
      expect(f.unexpected).toEqual([]);
    });

    test('unconfigured installations show history and disable top-ups', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.enabled = false;
      f.orders.set(orderId, payment('credited'));
      await page.goto('/billing');
      await expect(
        page.getByText(/Online top-ups are unavailable on this installation/),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue to Stripe/ })).toBeDisabled();
      await expect(page.getByRole('table')).toContainText('Credit added');
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('current Terms gate new funding while accepted checkout remains resumable', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.newFunding = { allowed: false, reason: 'terms-required' };
      f.orders.set(orderId, payment('checkout_pending'));
      await page.goto('/billing');
      await expect(page.getByRole('link', { name: 'Review Terms and sign in' })).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue to Stripe/ })).toBeDisabled();
      const resume = page.getByRole('button', { name: 'Resume ↗', exact: true });
      await expect(resume).toBeEnabled();
      await resume.click();
      await expect.poll(() => f.hostedVisits).toBe(1);
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([orderId]);
      expect(f.unexpected).toEqual([]);
    });

    test('a held workspace cannot create or resume a top-up', async ({ page, baseURL }) => {
      const f = await billingFixture(page, baseURL);
      f.held = true;
      f.orders.set(orderId, payment('checkout_open'));
      await page.goto('/billing');
      await expect(
        page.getByRole('alert').filter({ hasText: 'New spending and top-ups are paused.' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Continue to Stripe/ })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Resume ↗', exact: true })).toBeDisabled();
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('a lost create response survives reload and retries the same persisted order key', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.abortNextCreate = true;
      f.checkoutStatus = 'checkout_pending';
      await page.goto('/billing');
      await page.getByRole('button', { name: /Continue to Stripe/ }).click();
      await expect(
        page
          .getByRole('alert')
          .filter({ hasText: 'Resume or refresh this top-up before starting another.' }),
      ).toBeVisible();
      expect(f.creates).toHaveLength(1);
      const first = f.creates[0]!;
      expect(first.persisted?.orderId).toBeNull();
      expect(f.checkouts).toEqual([]);
      await page.reload();
      await expect(page.getByLabel('Choose your amount')).toHaveValue('25.00');
      await expect(page.getByLabel('Choose your amount')).toBeDisabled();
      await page.getByRole('button', { name: /Resume this top-up/ }).click();
      await expect(currentTopUp(page)).toContainText('Checking checkout');
      expect(f.creates).toHaveLength(2);
      expect(f.creates[1]!.key).toBe(first.key);
      expect(f.creates[1]!.amountCents).toBe(first.amountCents);
      expect(f.orders.size).toBe(1);
      expect(f.checkouts).toEqual([orderId]);
      const saved = await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!),
        recoveryKey,
      );
      expect(saved).toMatchObject({ workspaceId, idempotencyKey: first.key, orderId });
      expect(JSON.stringify(saved)).not.toContain('checkout.stripe.com');
      expect(f.unexpected).toEqual([]);
    });

    test('a success return never grants credit before an authenticated owned-order read confirms it', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.summaryIncludesOrders = false;
      f.orders.set(orderId, payment('payment_pending'));
      await page.goto(`/billing?checkout=success&order=${orderId}`);
      await expect(
        page.getByText(
          'You’re back from Checkout. Credit appears once your payment is confirmed below.',
        ),
      ).toBeVisible();
      await expect(currentTopUp(page)).toContainText('Payment pending');
      await expect(currentTopUp(page)).not.toContainText('Credit added');
      expect(f.reads.length).toBeGreaterThanOrEqual(1);
      expect(f.reads.every((id) => id === orderId)).toBe(true);
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      f.orders.set(orderId, payment('credited'));
      await page.getByRole('button', { name: 'Refresh status ↻', exact: true }).click();
      await expect(currentTopUp(page)).toContainText(
        'Payment confirmed. This credit has been added to your workspace.',
      );
      expect(f.reads.length).toBeGreaterThanOrEqual(2);
      expect(f.reads.every((id) => id === orderId)).toBe(true);
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('a cancel return resumes the original order and navigates only to fixture hosted checkout', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.orders.set(orderId, payment('checkout_open'));
      await seedRecovery(page, baseURL);
      await page.goto(`/billing?checkout=cancel&order=${orderId}`);
      await expect(
        page.getByText(
          'You returned from Checkout. Review the order status below; you can resume an open checkout.',
        ),
      ).toBeVisible();
      await expect(currentTopUp(page)).toContainText(orderId);
      await page.getByRole('button', { name: /Resume this top-up/ }).click();
      await expect(page).toHaveURL(checkoutUrl);
      await expect(page.getByRole('heading', { name: 'Fixture hosted checkout' })).toBeVisible();
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([orderId]);
      expect(f.hostedVisits).toBe(1);
      await page.goto(`/billing?checkout=cancel&order=${orderId}`);
      await expect(currentTopUp(page)).toContainText('Checkout open');
      await expect(page.getByRole('button', { name: /Resume this top-up/ })).toBeEnabled();
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([orderId]);
      expect(f.unexpected).toEqual([]);
    });

    test('pending payments poll read-only status until the fixture confirms credit', async ({
      page,
      baseURL,
    }) => {
      await page.clock.install();
      const f = await billingFixture(page, baseURL);
      f.summaryIncludesOrders = false;
      f.orders.set(orderId, payment('payment_pending'));
      await page.goto(`/billing?order=${orderId}`);
      await expect(currentTopUp(page)).toContainText('Payment pending');
      await page.clock.runFor(50);
      f.orders.set(orderId, payment('credited'));
      await page.clock.fastForward(10001);
      await expect(currentTopUp(page)).toContainText('Credit added');
      expect(f.summaries).toBeGreaterThanOrEqual(2);
      expect(f.reads.length).toBeGreaterThanOrEqual(2);
      expect(f.creates).toEqual([]);
      expect(f.checkouts).toEqual([]);
      expect(f.unexpected).toEqual([]);
    });

    test('a brand-new workspace admin can self-serve enable manual prepaid billing and start checkout', async ({
      page,
      baseURL,
    }) => {
      const f = await billingFixture(page, baseURL);
      f.recoveryScope = 'member-fresh-signup-v1';
      f.capabilities = {
        read: false,
        manage: false,
        setup: false,
        ownerEnrollment: {
          eligible: true,
          expectedAuthorityVersion: 0,
          terms: {
            version: 'hosted-manual-prepaid-v1-2026-11-11',
            text: 'Manual prepaid USD top-ups only; no automatic recurring charges.',
          },
        },
      };
      await page.goto('/billing');
      await expect(
        page.getByRole('heading', { name: /Enable prepaid workspace credit/i }),
      ).toBeVisible();
      const enableButton = page.getByRole('button', { name: 'Enable prepaid billing →' });
      await expect(enableButton).toBeDisabled();
      await page.getByRole('checkbox').check();
      await expect(enableButton).toBeEnabled();
      await enableButton.click();
      await expect(
        page.getByText(
          'Prepaid billing is enabled for this workspace. Choose an amount below to add credit.',
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Continue to Stripe ↗' }).click();
      await expect(page).toHaveURL(checkoutUrl);
      await expect(page.getByRole('heading', { name: 'Fixture hosted checkout' })).toBeVisible();
      expect(f.creates.length).toBe(1);
      expect(f.creates[0]?.amountCents).toBe(2500);
      expect(f.hostedVisits).toBe(1);
      expect(f.unexpected).toEqual([]);
    });
  });
}
