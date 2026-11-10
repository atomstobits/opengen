import { describe, expect, it } from 'vitest';
import {
  createRechargeAuthenticator,
  type RechargeAuthenticationResponse,
} from '../apps/web/app/billing/recharge-authentication';
const attempt = {
  id: '24250436-0606-4da0-9877-b65fe61d78de',
  workspaceId: 'workspace-a',
  amountCents: 2500,
  status: 'requires_authentication',
};
const versions = { expectedPolicyVersion: 2, expectedAuthorityVersion: 1 };
const authorization = (): RechargeAuthenticationResponse => ({
  workspaceId: attempt.workspaceId,
  attemptId: attempt.id,
  amountCents: attempt.amountCents,
  paymentIntentId: 'pi_originalFixture',
  clientSecret: 'pi_originalFixture_secret_fixtureValue123',
  publishableKey: 'pk_test_fixturePublic123',
});
describe('original recharge card authentication fixtures', () => {
  it('confirms only the original attached payment and awaits a signed webhook without crediting', async () => {
    const calls: unknown[][] = [];
    const authenticate = createRechargeAuthenticator({
      enabled: true,
      requestAuthentication: async (id, body) => {
        expect(id).toBe(attempt.id);
        expect(body).toEqual(versions);
        return authorization();
      },
      stripeFactory: async (key) => {
        expect(key).toBe('pk_test_fixturePublic123');
        return {
          confirmCardPayment: async (...args) => {
            calls.push(args);
            return { paymentIntent: { id: 'pi_originalFixture', status: 'succeeded' } };
          },
        };
      },
    });
    expect(await authenticate(attempt, versions)).toEqual({
      attemptId: attempt.id,
      status: 'awaiting_webhook',
    });
    expect(calls).toEqual([['pi_originalFixture_secret_fixtureValue123']]);
  });
  it('suppresses a double click while the original request/confirmation is in flight', async () => {
    let complete!: () => void;
    const waiting = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let requests = 0,
      confirmations = 0;
    const authenticate = createRechargeAuthenticator({
      enabled: true,
      requestAuthentication: async () => {
        requests++;
        await waiting;
        return authorization();
      },
      stripeFactory: async () => ({
        confirmCardPayment: async () => {
          confirmations++;
          return { paymentIntent: { id: 'pi_originalFixture', status: 'processing' } };
        },
      }),
    });
    const first = authenticate(attempt, versions);
    expect(await authenticate(attempt, versions)).toEqual({
      attemptId: attempt.id,
      status: 'in_progress',
    });
    complete();
    await first;
    expect(requests).toBe(1);
    expect(confirmations).toBe(1);
  });
  it('rejects wrong workspace, attempt, amount, secret binding and publishable key before loading Stripe', async () => {
    for (const patch of [
      { workspaceId: 'other' },
      { attemptId: 'fef44d21-4fa9-413f-9c98-6c87568612ce' },
      { amountCents: 5000 },
      { paymentIntentId: 'pi_wrong' },
      { clientSecret: 'pi_foreign_secret_fixtureValue123' },
      { publishableKey: 'server-key-not-a-publishable-key' },
    ]) {
      let loaded = false;
      const authenticate = createRechargeAuthenticator({
        enabled: true,
        requestAuthentication: async () => ({ ...authorization(), ...patch }),
        stripeFactory: async () => {
          loaded = true;
          throw new Error('must not load');
        },
      });
      await expect(authenticate(attempt, versions)).rejects.toThrow(/could not be verified/);
      expect(loaded).toBe(false);
    }
  });
  it('does nothing while activation is disabled and stops after authority changes during fetch', async () => {
    let requests = 0,
      loaded = false;
    const inactive = createRechargeAuthenticator({
      requestAuthentication: async () => {
        requests++;
        return authorization();
      },
    });
    await expect(inactive(attempt, versions)).rejects.toThrow(/not active/);
    expect(requests).toBe(0);
    const stale = createRechargeAuthenticator({
      enabled: true,
      requestAuthentication: async () => authorization(),
      isCurrent: () => false,
      stripeFactory: async () => {
        loaded = true;
        throw new Error('must not load');
      },
    });
    await expect(stale(attempt, versions)).rejects.toThrow(/authority changed/);
    expect(loaded).toBe(false);
  });
  it('never echoes a Stripe exception or raw error containing a client secret', async () => {
    for (const throwing of [false, true]) {
      const authenticate = createRechargeAuthenticator({
        enabled: true,
        requestAuthentication: async () => authorization(),
        stripeFactory: async () => ({
          confirmCardPayment: async () => {
            if (throwing)
              throw new Error('private secret pi_originalFixture_secret_fixtureValue123');
            return {
              error: { message: 'private secret pi_originalFixture_secret_fixtureValue123' },
            };
          },
        }),
      });
      await expect(authenticate(attempt, versions)).rejects.toThrow(
        'Card authentication did not complete.',
      );
      try {
        await authenticate(attempt, versions);
      } catch (error) {
        expect(String(error)).not.toContain('_secret_');
      }
    }
  });
  it('sanitizes request/factory failures before they can expose a scoped secret', async () => {
    for (const stage of ['request', 'factory']) {
      const authenticate = createRechargeAuthenticator({
        enabled: true,
        requestAuthentication: async () => {
          if (stage === 'request') throw new Error('pi_originalFixture_secret_fixtureValue123');
          return authorization();
        },
        stripeFactory: async () => {
          throw new Error('pi_originalFixture_secret_fixtureValue123');
        },
      });
      try {
        await authenticate(attempt, versions);
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).toContain('could not be verified');
        expect(String(error)).not.toContain('_secret_');
      }
    }
  });
  it('rejects a mismatched returned payment and preserves still-required authentication/review', async () => {
    for (const status of ['requires_action', 'requires_payment_method']) {
      const authenticate = createRechargeAuthenticator({
        enabled: true,
        requestAuthentication: async () => authorization(),
        stripeFactory: async () => ({
          confirmCardPayment: async () => ({ paymentIntent: { id: 'pi_originalFixture', status } }),
        }),
      });
      expect((await authenticate(attempt, versions)).status).toBe(
        status === 'requires_action' ? 'requires_authentication' : 'review',
      );
    }
    const wrong = createRechargeAuthenticator({
      enabled: true,
      requestAuthentication: async () => authorization(),
      stripeFactory: async () => ({
        confirmCardPayment: async () => ({
          paymentIntent: { id: 'pi_foreign', status: 'succeeded' },
        }),
      }),
    });
    await expect(wrong(attempt, versions)).rejects.toThrow(/could not be verified/);
  });
});
