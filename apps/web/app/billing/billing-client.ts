export type PaymentOrder = {
  id: string;
  workspaceId: string;
  amountCents: number;
  feeCents?: number;
  totalChargeCents?: number;
  feeRateBps?: 0 | 290 | 440;
  creditMicros: number;
  currency: 'USD';
  status:
    | 'created'
    | 'checkout_pending'
    | 'checkout_open'
    | 'payment_pending'
    | 'payment_failed'
    | 'expired'
    | 'credited'
    | 'review';
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
  creditedAt: string | null;
};
export type BillingSummary = {
  enabled: boolean;
  newFunding?: { allowed: boolean; reason?: 'terms-required' | 'terms-inactive' };
  workspaceId: string;
  currency: 'USD';
  minAmountCents: number;
  maxAmountCents: number;
  feeRateBps?: number;
  internationalFeeRateBps?: number;
  fixedFeeCents?: number;
  billingHold: boolean;
  orders: PaymentOrder[];
};
export type ProcessingFeePreview = {
  creditCents: number;
  feeCents: number;
  totalChargeCents: number;
  feeRateBps: 290 | 440;
  fixedFeeCents: 30;
};
export type PendingTopUp = {
  version: 1;
  workspaceId: string;
  amountCents: number;
  idempotencyKey: string;
  orderId: string | null;
};
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const orderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const recoveryKey = (workspaceId: string) => `opengen.billing.v1:${workspaceId}`;

/** Pure integer gross-up fee preview matching server/engine calculation. */
export function previewProcessingFee(
  creditCents: number,
  cardCountry?: string | null,
): ProcessingFeePreview | null {
  if (!Number.isSafeInteger(creditCents) || creditCents < 500 || creditCents > 999900) return null;
  const normalized =
    typeof cardCountry === 'string' && /^[A-Za-z]{2}$/.test(cardCountry)
      ? cardCountry.toUpperCase()
      : null;
  const international = normalized !== null && normalized !== 'US';
  const feeRateBps = international ? 440 : 290;
  const denom = international ? 956 : 971;
  const totalChargeCents = Math.floor(((creditCents + 30) * 1000 + (denom - 1)) / denom);
  const feeCents = totalChargeCents - creditCents;
  return { creditCents, feeCents, totalChargeCents, feeRateBps, fixedFeeCents: 30 };
}

/** Stores only order recovery data. Credentials remain in the HttpOnly session cookie. */
export function pendingTopUp(storage: Storage, workspaceId: string): PendingTopUp | null {
  const value = storage.getItem(recoveryKey(workspaceId));
  if (!value) return null;
  try {
    const saved = JSON.parse(value) as PendingTopUp;
    if (
      saved.version === 1 &&
      saved.workspaceId === workspaceId &&
      Number.isSafeInteger(saved.amountCents) &&
      saved.amountCents > 0 &&
      typeof saved.idempotencyKey === 'string' &&
      /^[A-Za-z0-9_-]{16,128}$/.test(saved.idempotencyKey) &&
      (saved.orderId === null || (typeof saved.orderId === 'string' && orderId.test(saved.orderId)))
    )
      return saved;
  } catch {
    // Invalid recovery data must never silently turn an uncertain request into a new payment.
  }
  throw new Error('The saved top-up needs review. Check payment history before trying again.');
}

export async function billingRequest<T>(
  workspaceId: string,
  path: string,
  init: RequestInit = {},
  request: typeof fetch = fetch,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-opengen-workspace', workspaceId);
  const response = await request(path, {
    ...init,
    cache: 'no-store',
    credentials: 'same-origin',
    headers,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result.error === 'string'
        ? result.error
        : (result.error?.message ?? 'Billing could not be loaded. Please try again.'),
    );
  const data = result.data ?? result;
  if (!data || data.workspaceId !== workspaceId)
    throw new Error('Your workspace changed. Reload this page before continuing.');
  return data as T;
}

function verifyOrder(order: PaymentOrder, saved: PendingTopUp): void {
  if (
    !orderId.test(order.id) ||
    order.workspaceId !== saved.workspaceId ||
    order.amountCents !== saved.amountCents ||
    order.currency !== 'USD' ||
    (saved.orderId !== null && saved.orderId !== order.id)
  )
    throw new Error('The top-up details do not match. Check payment history before continuing.');
}

/** The recovery record is durable before POST; every timeout retry reuses the same key and amount. */
export async function createOrRecoverOrder(options: {
  workspaceId: string;
  amountCents: number;
  storage: Storage;
  request?: typeof fetch;
  newKey?: () => string;
}): Promise<PaymentOrder> {
  const { workspaceId, amountCents, storage } = options;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new Error('Enter an amount in dollars and cents.');
  let saved = pendingTopUp(storage, workspaceId);
  if (saved && saved.amountCents !== amountCents)
    throw new Error('Resume your existing top-up before choosing another amount.');
  if (!saved) {
    saved = {
      version: 1,
      workspaceId,
      amountCents,
      idempotencyKey: (options.newKey ?? (() => crypto.randomUUID()))(),
      orderId: null,
    };
    storage.setItem(recoveryKey(workspaceId), JSON.stringify(saved));
    // Refuse to send if browser storage silently failed or was cleared during preparation.
    if (pendingTopUp(storage, workspaceId)?.idempotencyKey !== saved.idempotencyKey)
      throw new Error('Allow site storage so this top-up can be safely resumed.');
  }
  const order = saved.orderId
    ? await billingRequest<PaymentOrder>(
        workspaceId,
        `/api/billing/orders/${encodeURIComponent(saved.orderId)}`,
        {},
        options.request,
      )
    : await billingRequest<PaymentOrder>(
        workspaceId,
        '/api/billing/orders',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': saved.idempotencyKey },
          body: JSON.stringify({ amountCents: saved.amountCents }),
        },
        options.request,
      );
  verifyOrder(order, saved);
  storage.setItem(recoveryKey(workspaceId), JSON.stringify({ ...saved, orderId: order.id }));
  return order;
}

/** Clearing is permitted only after an authenticated read confirms the owned order is terminal. */
export function finishTopUp(storage: Storage, workspaceId: string, order: PaymentOrder): void {
  const saved = pendingTopUp(storage, workspaceId);
  if (!saved || saved.orderId !== order.id) return;
  verifyOrder(order, saved);
  if (!['credited', 'payment_failed', 'expired'].includes(order.status))
    throw new Error('This payment is still pending. Resume it or refresh its status.');
  storage.removeItem(recoveryKey(workspaceId));
}

/** Stripe owns the opaque Checkout fragment. Validate its destination and retain it. */
export function stripeCheckoutUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'checkout.stripe.com' ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/c\/pay\/[A-Za-z0-9_]+$/.test(url.pathname)
  )
    throw new Error('The payment link could not be verified. Refresh payment status.');
  return url.href;
}

export function dollarsToCents(value: string): number | null {
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}
