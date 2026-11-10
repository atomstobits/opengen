import { describe, expect, it } from 'vitest';
import {
  billingRequest,
  createOrRecoverOrder,
  dollarsToCents,
  finishTopUp,
  pendingTopUp,
  recoveryKey,
  stripeCheckoutUrl,
  type PaymentOrder,
} from '../apps/web/app/billing/billing-client';

const id = 'f7c6c73f-781c-42cf-bf77-fa7580dc7a24';
const order = (workspaceId = 'workspace-a'): PaymentOrder => ({
  id,
  workspaceId,
  amountCents: 2500,
  creditMicros: 25_000_000,
  currency: 'USD',
  status: 'created',
  checkoutUrl: null,
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
  creditedAt: null,
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

describe('billing order recovery', () => {
  it('persists recovery before a timeout and replays the same key, amount and workspace after reload', async () => {
    const saved = storage();
    const calls: { headers: Headers; body: string }[] = [];
    const request: typeof fetch = async (_url, init) => {
      expect(pendingTopUp(saved, 'workspace-a')?.idempotencyKey).toBe('stable-client-key-123');
      calls.push({ headers: new Headers(init?.headers), body: String(init?.body) });
      if (calls.length === 1) throw new Error('fixture timeout after server accepted');
      return Response.json(order());
    };
    const input = {
      workspaceId: 'workspace-a',
      amountCents: 2500,
      storage: saved,
      request,
      newKey: () => 'stable-client-key-123',
    };
    await expect(createOrRecoverOrder(input)).rejects.toThrow('fixture timeout');
    await expect(
      createOrRecoverOrder({
        ...input,
        newKey: () => {
          throw new Error('must not create a new key');
        },
      }),
    ).resolves.toMatchObject({ id });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toBe(calls[1]!.body);
    expect(calls[1]!.headers.get('idempotency-key')).toBe('stable-client-key-123');
    expect(calls[1]!.headers.get('x-opengen-workspace')).toBe('workspace-a');
    expect(pendingTopUp(saved, 'workspace-a')?.orderId).toBe(id);
    const reads: string[] = [];
    await createOrRecoverOrder({
      ...input,
      request: async (url, init) => {
        reads.push(String(url));
        expect(init?.method).toBeUndefined();
        return Response.json(order());
      },
    });
    expect(reads).toEqual([`/api/billing/orders/${id}`]);
  });

  it('keeps uncertain orders through amount changes, malformed responses and unavailable storage', async () => {
    const saved = storage();
    let calls = 0;
    const request: typeof fetch = async () => {
      calls++;
      throw new Error('timeout');
    };
    const input = {
      workspaceId: 'workspace-a',
      amountCents: 2500,
      storage: saved,
      request,
      newKey: () => 'recovery-key-123456',
    };
    await expect(createOrRecoverOrder(input)).rejects.toThrow('timeout');
    await expect(createOrRecoverOrder({ ...input, amountCents: 5000 })).rejects.toThrow(
      'Resume your existing',
    );
    expect(calls).toBe(1);
    await expect(
      createOrRecoverOrder({
        ...input,
        request: async () => Response.json({ ...order(), amountCents: 5000 }),
      }),
    ).rejects.toThrow('details do not match');
    expect(pendingTopUp(saved, 'workspace-a')?.orderId).toBeNull();
    await expect(
      createOrRecoverOrder({
        ...input,
        storage: {
          ...storage(),
          setItem() {
            throw new Error('storage disabled');
          },
        },
      }),
    ).rejects.toThrow('storage disabled');
    expect(calls).toBe(1);
    saved.setItem(recoveryKey('workspace-b'), 'broken json');
    expect(() => pendingTopUp(saved, 'workspace-b')).toThrow('saved top-up needs review');
  });

  it('isolates workspace recovery and refuses cross-workspace results before saving an order', async () => {
    const saved = storage();
    await expect(
      createOrRecoverOrder({
        workspaceId: 'workspace-a',
        amountCents: 2500,
        storage: saved,
        newKey: () => 'workspace-a-key-123',
        request: async () => Response.json(order('workspace-b')),
      }),
    ).rejects.toThrow('workspace changed');
    expect(pendingTopUp(saved, 'workspace-a')?.orderId).toBeNull();
    expect(pendingTopUp(saved, 'workspace-b')).toBeNull();
    await expect(
      billingRequest('workspace-a', '/api/billing', {}, async () =>
        Response.json({ workspaceId: 'workspace-b' }),
      ),
    ).rejects.toThrow('workspace changed');
  });

  it('requires an authenticated terminal order before releasing the stored recovery key', async () => {
    const saved = storage();
    await createOrRecoverOrder({
      workspaceId: 'workspace-a',
      amountCents: 2500,
      storage: saved,
      newKey: () => 'workspace-a-key-123',
      request: async () => Response.json(order()),
    });
    expect(() =>
      finishTopUp(saved, 'workspace-a', { ...order(), status: 'payment_pending' }),
    ).toThrow('still pending');
    expect(() =>
      finishTopUp(saved, 'workspace-a', { ...order('workspace-b'), status: 'credited' }),
    ).toThrow('details do not match');
    expect(pendingTopUp(saved, 'workspace-a')).not.toBeNull();
    finishTopUp(saved, 'workspace-a', { ...order(), status: 'credited' });
    expect(pendingTopUp(saved, 'workspace-a')).toBeNull();
  });

  it('preserves the complete provider-issued Checkout URL including its opaque fragment', () => {
    // Stripe's Checkout Session response uses /c/pay/<session>#<opaque state>.
    const checkout =
      'https://checkout.stripe.com/c/pay/cs_test_a1HostedFixture123#fidkdWxOYHwnPyd1blpxYHZxWjA0Fixture%2Fencoded%2Bstate%3D%3D';
    expect(stripeCheckoutUrl(checkout)).toBe(checkout);
    const localized = checkout.replace('#', '?locale=en#');
    expect(stripeCheckoutUrl(localized)).toBe(localized);
  });

  it('parses decimal USD exactly and allows only hosted Stripe checkout redirects', () => {
    expect(dollarsToCents('25.01')).toBe(2501);
    expect(dollarsToCents('0.29')).toBe(29);
    expect(dollarsToCents('5')).toBe(500);
    for (const value of ['2.001', '1e3', '-5', '0x10', 'Infinity', '', '9999999999'])
      expect(dollarsToCents(value)).toBeNull();
    expect(stripeCheckoutUrl('https://checkout.stripe.com/c/pay/fixture')).toBe(
      'https://checkout.stripe.com/c/pay/fixture',
    );
    for (const url of [
      'javascript:alert(1)',
      'https://checkout.stripe.com.attacker.example/pay',
      'http://checkout.stripe.com/pay',
      'https://checkout.stripe.com@attacker.example/pay',
      'https://user@checkout.stripe.com/pay',
      'https://user:pass@checkout.stripe.com/c/pay/cs_test_fixture#fidfixture',
      'https://checkout.stripe.com:444/c/pay/cs_test_fixture#fidfixture',
      'https://checkout.stripe.com./c/pay/cs_test_fixture#fidfixture',
      'https://checkout.stripe.com/c/pay/cs_test_fixture/redirect#fidfixture',
      'https://checkout.stripe.com/c/pay/cs_test_fixture%2Fredirect#fidfixture',
      'https://checkout.stripe.com/redirect?url=https://attacker.example#fidfixture',
    ])
      expect(() => stripeCheckoutUrl(url)).toThrow();
  });
});
