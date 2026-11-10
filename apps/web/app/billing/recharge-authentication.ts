/** Existing-payment card authentication only. No creation, method replacement,
 * amount change, storage, logging or wallet credit occurs in this module. */
import { BillingWaitError } from './policy-client';
class AuthenticationError extends Error {}
export interface RechargeAuthenticationResponse {
  workspaceId: string;
  attemptId: string;
  paymentIntentId: string;
  amountCents: number;
  clientSecret: string;
  publishableKey: string;
}
export interface CardAuthenticationClient {
  confirmCardPayment(clientSecret: string): Promise<{
    error?: unknown;
    paymentIntent?: { id: string; status: string };
  }>;
}
export type StripeAuthenticationFactory = (
  publishableKey: string,
) => Promise<CardAuthenticationClient>;
export interface AuthenticationAttempt {
  id: string;
  workspaceId: string;
  amountCents: number;
  status: string;
}
export interface AuthenticationVersions {
  expectedPolicyVersion: number;
  expectedAuthorityVersion: number;
}
export type AuthenticationResult = {
  attemptId: string;
  status: 'awaiting_webhook' | 'requires_authentication' | 'review' | 'in_progress';
};
const failure = () =>
  new AuthenticationError(
    'Authentication details could not be verified for this original recharge. Refresh its status or request operator review.',
  );
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateRechargeAuthentication(
  value: unknown,
  attempt: AuthenticationAttempt,
): RechargeAuthenticationResponse {
  if (!value || typeof value !== 'object') throw failure();
  const result = value as RechargeAuthenticationResponse;
  if (
    result.workspaceId !== attempt.workspaceId ||
    result.attemptId !== attempt.id ||
    !uuid.test(result.attemptId) ||
    result.amountCents !== attempt.amountCents ||
    !Number.isSafeInteger(result.amountCents) ||
    result.amountCents < 500 ||
    result.amountCents > 100000 ||
    typeof result.paymentIntentId !== 'string' ||
    !/^pi_[A-Za-z0-9]+$/.test(result.paymentIntentId) ||
    typeof result.clientSecret !== 'string' ||
    !result.clientSecret.startsWith(`${result.paymentIntentId}_secret_`) ||
    !/^[A-Za-z0-9]{8,256}$/.test(
      result.clientSecret.slice(`${result.paymentIntentId}_secret_`.length),
    ) ||
    typeof result.publishableKey !== 'string' ||
    !/^pk_(test|live)_[A-Za-z0-9_]{8,256}$/.test(result.publishableKey)
  )
    throw failure();
  return result;
}
let scriptLoading: Promise<void> | undefined;
type StripeWindow = Window & {
  Stripe?: (publishableKey: string) => CardAuthenticationClient | null;
};
/** Called only by an explicit enabled recovery action, never during render/load. */
export const loadStripeAuthentication: StripeAuthenticationFactory = async (publishableKey) => {
  if (!/^pk_(test|live)_[A-Za-z0-9_]{8,256}$/.test(publishableKey)) throw failure();
  if (typeof window === 'undefined' || typeof document === 'undefined') throw failure();
  const browser = window as StripeWindow;
  if (!browser.Stripe) {
    scriptLoading ??= new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      const timeout = window.setTimeout(() => {
        script.remove();
        reject(failure());
      }, 15000);
      script.onload = () => {
        window.clearTimeout(timeout);
        browser.Stripe ? resolve() : reject(failure());
      };
      script.onerror = () => {
        window.clearTimeout(timeout);
        script.remove();
        reject(failure());
      };
      document.head.appendChild(script);
    }).catch((error) => {
      scriptLoading = undefined;
      throw error;
    });
    await scriptLoading;
  }
  const client = browser.Stripe?.(publishableKey);
  if (!client || typeof client.confirmCardPayment !== 'function') throw failure();
  return client;
};
/** One in-flight confirmation per panel/attempt. Dependencies make every proof
 * fixture-only without loading Stripe or making a real network request. */
export function createRechargeAuthenticator(options: {
  enabled?: boolean;
  requestAuthentication(attemptId: string, versions: AuthenticationVersions): Promise<unknown>;
  stripeFactory?: StripeAuthenticationFactory;
  isCurrent?: () => boolean;
}) {
  const inFlight = new Set<string>();
  return async (
    attempt: AuthenticationAttempt,
    versions: AuthenticationVersions,
  ): Promise<AuthenticationResult> => {
    if (!options.enabled)
      throw new AuthenticationError(
        'Card authentication recovery is not active on this installation.',
      );
    if (
      attempt.status !== 'requires_authentication' ||
      !uuid.test(attempt.id) ||
      !Number.isSafeInteger(versions.expectedPolicyVersion) ||
      versions.expectedPolicyVersion < 1 ||
      !Number.isSafeInteger(versions.expectedAuthorityVersion) ||
      versions.expectedAuthorityVersion < 1
    )
      throw failure();
    if (inFlight.has(attempt.id)) return { attemptId: attempt.id, status: 'in_progress' };
    inFlight.add(attempt.id);
    let response: RechargeAuthenticationResponse | undefined;
    try {
      response = validateRechargeAuthentication(
        await options.requestAuthentication(attempt.id, versions),
        attempt,
      );
      if (options.isCurrent?.() === false)
        throw new AuthenticationError(
          'Your workspace authority changed. Refresh before continuing.',
        );
      const stripe = await (options.stripeFactory ?? loadStripeAuthentication)(
        response.publishableKey,
      );
      if (options.isCurrent?.() === false)
        throw new AuthenticationError(
          'Your workspace authority changed. Refresh before continuing.',
        );
      let result: Awaited<ReturnType<CardAuthenticationClient['confirmCardPayment']>>;
      try {
        // The original card is already attached. Passing only this secret cannot
        // replace its method or change amount/customer/mandate parameters here.
        result = await stripe.confirmCardPayment(response.clientSecret);
      } catch {
        throw new AuthenticationError(
          'Card authentication did not complete. Refresh this original recharge before trying again.',
        );
      }
      // Stripe error messages may contain private response data. Never surface or
      // persist the raw object, message, client secret or PaymentIntent here.
      if (result.error)
        throw new AuthenticationError(
          'Card authentication did not complete. Refresh this original recharge before trying again.',
        );
      if (!result.paymentIntent || result.paymentIntent.id !== response.paymentIntentId)
        throw failure();
      const status = ['succeeded', 'processing'].includes(result.paymentIntent.status)
        ? 'awaiting_webhook'
        : result.paymentIntent.status === 'requires_action'
          ? 'requires_authentication'
          : 'review';
      return { attemptId: attempt.id, status };
    } catch (error) {
      if (error instanceof BillingWaitError) throw new BillingWaitError(error.retryAfterSeconds);
      if (error instanceof AuthenticationError) throw error;
      throw failure();
    } finally {
      response = undefined;
      inFlight.delete(attempt.id);
    }
  };
}
