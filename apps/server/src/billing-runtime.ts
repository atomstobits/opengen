import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { KeyScope, Principal } from '@media-router/engine';
import { creditWorkspaceInTransaction } from '@media-router/engine';
import {
  projectBillingPrincipal,
  projectStoredBillingSetupPrincipal,
  revalidateBillingAuthority,
} from '../../../packages/engine/src/billing-authority.js';
import {
  assertBillingProcessorEnvironmentInTransaction,
  assertBillingProcessorTransport,
  BillingCustomerStore,
  validatedBillingProcessorEnvironment,
  type BillingProcessorEnvironment,
  type BillingProcessorTransport,
  type BillingTerms,
  type CustomerTransport,
  type RechargeRecoveryTransport,
  type RechargeTransport,
} from '../../../packages/engine/src/billing-customer.js';
import { BillingOperationsStore } from '../../../packages/engine/src/billing-operations.js';
import {
  BillingPolicyStore,
  readBillingOwnerInTransaction,
  type BillingPrincipal,
  type BillingScope,
} from '../../../packages/engine/src/billing-policy.js';
import { RechargeStore } from '../../../packages/engine/src/billing-recharge.js';
import { PaymentStore, type PaymentTransport } from '../../../packages/engine/src/payments.js';
import { registerBillingRoutes, requireBillingBrowserRecovery } from './billing.js';
import { registerBillingOperatorRoutes } from './billing-operator.js';
import { createBillingWebhookDispatcher } from './billing-webhook.js';
import { requireCurrentHumanTermsInTransaction } from './billing-terms-admission.js';
import type { HumanTermsPolicy } from './terms-login.js';
import type { PaymentsOptions } from './payments.js';

export interface BillingFixtureRuntimeOptions {
  activation: 'fixture' | 'sandbox' | 'manual';
  checkoutWritesEnabled?: boolean;
  /** Trusted source-only fixture/integration seam; never an HTTP or environment switch. */
  humanTermsPolicy?: () => HumanTermsPolicy;
  processorEnvironment: BillingProcessorEnvironment;
  terms: BillingTerms;
  manualTransport: PaymentTransport & BillingProcessorTransport;
  customerTransport: CustomerTransport;
  rechargeTransport: RechargeTransport;
  webhookVerifier: NonNullable<PaymentsOptions['webhookVerifier']>;
  webhookSecret: string;
  operatorBearer?: string;
  setupAvailable?: boolean;
  automaticChargesEnabled?: boolean;
  portalAvailable?: boolean;
  recovery?: { transport: RechargeRecoveryTransport; publishableKey: string };
}

type Authenticate = (
  request: Pick<FastifyRequest, 'headers' | 'cookies'>,
  scope: KeyScope | null,
) => Promise<Principal>;
const authorityError = (code: string, message: string, statusCode = 403) =>
  Object.assign(new Error(message), { code, statusCode });
const isDenied = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode === 403;

/** Explicit transport injection for fixtures and scoped hosted manual billing. */
export function createBillingFixtureRuntime(pool: Pool, options: BillingFixtureRuntimeOptions) {
  const environment = validatedBillingProcessorEnvironment(options.processorEnvironment);
  if (
    !['fixture', 'sandbox', 'manual'].includes(options.activation) ||
    (options.activation === 'manual' ? !environment.livemode : environment.livemode) ||
    !options.webhookSecret ||
    (options.activation !== 'fixture' &&
      (options.setupAvailable ||
        options.automaticChargesEnabled ||
        options.portalAvailable ||
        options.recovery))
  )
    throw new Error(
      'Billing activation requires the matching environment and approved feature scope.',
    );
  assertBillingProcessorTransport(environment, options.manualTransport);
  assertBillingProcessorTransport(environment, options.customerTransport);
  assertBillingProcessorTransport(environment, options.rechargeTransport);
  if (options.recovery) {
    assertBillingProcessorTransport(environment, options.recovery.transport);
    if (!/^pk_test_[A-Za-z0-9]+$/.test(options.recovery.publishableKey))
      throw new Error('Billing fixture authentication requires a test publishable key.');
  }

  const setupAvailable = options.setupAvailable === true;
  const automaticChargesEnabled = options.automaticChargesEnabled === true;
  const portalAvailable = options.portalAvailable === true;
  const manual = new PaymentStore(pool, {
    livemode: environment.livemode,
    processorEnvironment: environment,
    creditInTransaction: creditWorkspaceInTransaction,
  });
  const externalLimits = {
    lockExternalInTransaction: (client: PoolClient) => manual.lockExternalInTransaction(client),
    admitExternalInTransaction: (client: PoolClient, workspaceId: string) =>
      manual.admitExternalInTransaction(client, workspaceId),
  };
  const policies = new BillingPolicyStore(pool, {
    revalidateAuthority: async (client, actor, scope) => {
      const current = await revalidateBillingAuthority(client, actor, scope);
      await assertBillingProcessorEnvironmentInTransaction(client, environment);
      const owner = await readBillingOwnerInTransaction(client, actor.workspaceId);
      if (
        owner?.processorEnvironmentId !== environment.id ||
        owner.livemode !== environment.livemode
      )
        throw authorityError('billing_access_denied', 'Current funding authority is required.');
      return current;
    },
  });
  const authorize = (client: PoolClient, actor: BillingPrincipal, scope: BillingScope) =>
    policies.authorizeInTransaction(client, actor, scope);
  const customers = new BillingCustomerStore(pool, {
    processorEnvironment: environment,
    terms: options.terms,
    authorize,
    authorizeStoredSetup: async (client, workspaceId, setupId) =>
      authorize(
        client,
        await projectStoredBillingSetupPrincipal(client, workspaceId, setupId),
        'billing:manage',
      ),
    allowPortal: portalAvailable,
    ...externalLimits,
  });
  const recharge = new RechargeStore(pool, {
    processorEnvironment: environment,
    automaticChargesEnabled,
    authenticationRecoveryEnabled: Boolean(options.recovery),
    creditInTransaction: creditWorkspaceInTransaction,
    ...externalLimits,
  });
  const operations = new BillingOperationsStore(pool);
  const reconcileVerifiedEvent = createBillingWebhookDispatcher({
    payments: manual,
    legacyTransport: options.manualTransport,
    customers,
    customerTransport: options.customerTransport,
    recharge,
    rechargeTransport: options.rechargeTransport,
    routeIntent: (event, intent) => manual.routeIntent(event, intent),
  });

  const capabilities = async (principal: Principal) => {
    const denied = {
      read: false,
      manage: false,
      setup: false,
      manual: false,
      newFunding: { allowed: false },
    };
    let actor: BillingPrincipal;
    try {
      actor = await projectBillingPrincipal(pool, principal, true);
    } catch (error) {
      if (isDenied(error)) return denied;
      throw error;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A scope's absence is expected. Denials do not run privileged queries or expose policy.
      const proof = async (scope: BillingScope) => {
        if (!actor.scopes.includes(scope)) return null;
        try {
          return await authorize(client, actor, scope);
        } catch (error) {
          if (isDenied(error)) return null;
          throw error;
        }
      };
      const read = Boolean(await proof('billing:read'));
      const manage = await proof('billing:manage');
      const human = Boolean(manage?.humanMembershipId);
      const manualEligible = read && human;
      let newFunding: { allowed: boolean; reason?: 'terms-required' | 'terms-inactive' } = {
        allowed: manualEligible,
      };
      if (environment.livemode && manualEligible && manage) {
        try {
          await requireCurrentHumanTermsInTransaction(
            client,
            manage,
            () => authorize(client, actor, 'billing:manage'),
            options.humanTermsPolicy,
          );
        } catch (error) {
          if (isDenied(error)) {
            const code = (error as { code?: string }).code;
            newFunding = {
              allowed: false,
              ...(code === 'current_human_terms_inactive'
                ? { reason: 'terms-inactive' as const }
                : code === 'current_human_terms_required'
                  ? { reason: 'terms-required' as const }
                  : {}),
            };
          } else throw error;
        }
      }
      await client.query('COMMIT');
      return {
        read,
        manage: Boolean(manage),
        // Owner actions also cover existing payment authorization and recovery.
        setup: human,
        manual: manualEligible,
        newFunding,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
  const operatorSecret = options.operatorBearer ? Buffer.from(options.operatorBearer) : null;
  const operatorPrincipal: Principal = { workspaceId: 'installation', scopes: [], bootstrap: true };
  const operator = async (request: FastifyRequest) => {
    const bearer = request.headers.authorization?.match(/^Bearer +([^\s]+)$/i)?.[1];
    const presented = bearer ? Buffer.from(bearer) : null;
    if (
      request.cookies?.og_session ||
      !operatorSecret ||
      !presented ||
      presented.length !== operatorSecret.length ||
      !timingSafeEqual(presented, operatorSecret)
    )
      throw authorityError(
        'operator_required',
        'Dedicated installation operator authority is required.',
      );
    return operatorPrincipal;
  };

  const payments: Omit<PaymentsOptions, 'authenticate' | 'publicUrl'> = {
    store: manual,
    livemode: environment.livemode,
    checkoutTransport: options.manualTransport,
    checkoutWritesEnabled: options.checkoutWritesEnabled,
    webhookVerifier: options.webhookVerifier,
    webhookSecret: options.webhookSecret,
    reconcileVerifiedEvent,
    scoped: {
      access: capabilities,
      authorize: async (principal, action) => {
        const actor = await projectBillingPrincipal(pool, principal, true);
        return async (client, context) => {
          await authorize(client, actor, 'billing:read');
          if (action === 'mutate') {
            const proof = await authorize(client, actor, 'billing:manage');
            if (!proof.humanMembershipId)
              throw authorityError(
                'human_billing_owner_required',
                'An approved human funding owner is required.',
              );
            if (environment.livemode) {
              if (!context || typeof context.newFunding !== 'boolean')
                throw authorityError(
                  'billing_access_denied',
                  'Funding admission context is required.',
                );
              if (context.newFunding)
                await requireCurrentHumanTermsInTransaction(
                  client,
                  proof,
                  () => authorize(client, actor, 'billing:manage'),
                  options.humanTermsPolicy,
                );
            }
          }
        };
      },
    },
  };
  return {
    payments,
    /** Runs known accepted retrieval even when automaticChargesEnabled is false. */
    workOnce: () => recharge.workOnce(options.rechargeTransport),
    register: async (app: FastifyInstance, authenticate: Authenticate, publicUrl: string) => {
      app.get('/v1/billing/access', async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        if (request.headers.authorization || !request.cookies?.og_session)
          throw authorityError(
            'browser_session_required',
            'Sign in in your browser to view billing access.',
            401,
          );
        const principal = await authenticate(request, null);
        const recoveryScope = requireBillingBrowserRecovery(principal, request.headers);
        const { read, manage, setup } = await capabilities(principal);
        return {
          workspaceId: principal.workspaceId,
          recoveryScope,
          capabilities: { read, manage, setup },
        };
      });
      await registerBillingRoutes(app, {
        pool,
        policies,
        customers,
        recharge,
        publicUrl,
        terms: options.terms,
        authenticate: async (request) => {
          const browserSession = Boolean(
            request.cookies?.og_session && !request.headers.authorization,
          );
          if (request.cookies?.og_session && request.headers.authorization)
            throw authorityError(
              'ambiguous_authority',
              'Use one authenticated authority per request.',
            );
          const principal = await authenticate(request, null);
          if (browserSession) requireBillingBrowserRecovery(principal, request.headers);
          return {
            principal,
            actor: await projectBillingPrincipal(pool, principal, browserSession),
          };
        },
        transport: options.customerTransport,
        setupAvailable,
        automaticRechargeAvailable: automaticChargesEnabled,
        portalAvailable,
        recoveryAvailable: Boolean(options.recovery),
        recoveryTransport: options.recovery?.transport,
        publishableKey: options.recovery?.publishableKey,
      });
      await registerBillingOperatorRoutes(app, {
        operations,
        recharge,
        transport: options.rechargeTransport,
        authenticate: operator,
        revalidateOperator: async (_client, principal) => {
          if (principal !== operatorPrincipal)
            throw authorityError('operator_required', 'Installation operator authority changed.');
        },
      });
    },
  };
}
