import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
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
  BILLING_POLICY_DEFAULTS,
  BILLING_POLICY_LIMITS,
  BillingPolicyStore,
  readBillingOwnerInTransaction,
  type BillingDelegationRails,
  type BillingPrincipal,
  type BillingScope,
} from '../../../packages/engine/src/billing-policy.js';
import { RechargeStore } from '../../../packages/engine/src/billing-recharge.js';
import { revalidateGovernanceAuthority } from '../../../packages/engine/src/governance-authority.js';
import { PaymentStore, type PaymentTransport } from '../../../packages/engine/src/payments.js';
import { registerBillingRoutes, requireBillingBrowserRecovery } from './billing.js';
import { registerBillingOperatorRoutes } from './billing-operator.js';
import { createBillingWebhookDispatcher } from './billing-webhook.js';
import {
  requireCurrentHumanTermsInTransaction,
  verifyHumanIdentityTermsReceiptInTransaction,
} from './billing-terms-admission.js';
import type { HumanTermsPolicy } from './terms-login.js';
import type { PaymentsOptions } from './payments.js';

export const MANUAL_SELF_SERVE_OWNER_RAILS: Readonly<BillingDelegationRails> = Object.freeze({
  allowsEnabled: false,
  maxThresholdMicros: BILLING_POLICY_DEFAULTS.thresholdMicros,
  maxAmountCents: BILLING_POLICY_LIMITS.maxAmountCents,
  maxMonthlyCapCents: BILLING_POLICY_LIMITS.maxAmountCents,
  maxAttemptsPerMonth: BILLING_POLICY_DEFAULTS.maxAttemptsPerMonth,
  minCooldownSeconds: BILLING_POLICY_DEFAULTS.cooldownSeconds,
  maxFailureLimit: BILLING_POLICY_DEFAULTS.failureLimit,
});

export type BillingOwnerEnrollmentReason =
  | 'admin-required'
  | 'owner-already-active'
  | 'checkout-paused'
  | 'terms-required'
  | 'terms-inactive';

export interface BillingOwnerEnrollmentState {
  eligible: boolean;
  expectedAuthorityVersion: number;
  terms: BillingTerms;
  reason?: BillingOwnerEnrollmentReason;
}

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
  type BrowserCandidate = BillingPrincipal & {
    keyKind: 'browser';
    keyId: string;
    keySecretVersion: number;
    membershipId: string;
    role: 'admin' | 'member';
    identity: { issuer: string; subject: string };
  };
  const revalidatedBrowserCandidate = async (
    client: PoolClient,
    actor: Principal,
  ): Promise<BrowserCandidate> => {
    if (
      actor.bootstrap ||
      actor.externalOAuth ||
      actor.keyKind !== 'browser' ||
      !actor.keyId ||
      actor.keySecretVersion === undefined ||
      !actor.membershipId ||
      !actor.identity?.issuer ||
      !actor.identity.subject ||
      actor.grantId ||
      actor.clientId ||
      actor.oauthResource
    )
      throw authorityError(
        'human_browser_required',
        'Sign in in your browser with an active workspace membership.',
      );
    const current = await revalidateGovernanceAuthority(client, actor, null);
    if (
      current.bootstrap ||
      current.externalOAuth ||
      current.keyKind !== 'browser' ||
      !current.keyId ||
      current.keySecretVersion === undefined ||
      !current.membershipId ||
      !current.role ||
      !current.identity?.issuer ||
      !current.identity.subject ||
      current.grantId ||
      current.clientId ||
      current.oauthResource ||
      current.policy ||
      current.maxCostMicros !== undefined ||
      current.monthlyCapMicros !== undefined
    )
      throw authorityError(
        'human_browser_required',
        'Use an unrestricted browser session for workspace billing enrollment.',
      );
    return current as BrowserCandidate;
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
    ...(options.activation === 'manual'
      ? {
          approveOwner: async (client, actor, request) => {
            if (options.checkoutWritesEnabled === false)
              throw authorityError('checkout_paused', 'New Checkout requests are paused.', 503);
            const candidate = await revalidatedBrowserCandidate(client, actor as Principal);
            if (candidate.role !== 'admin')
              throw authorityError(
                'admin_required',
                'A workspace administrator must enable prepaid billing.',
              );
            await assertBillingProcessorEnvironmentInTransaction(client, environment);
            if (
              request.processorEnvironmentId !== environment.id ||
              request.livemode !== true ||
              request.rails.allowsEnabled !== false ||
              request.rails.maxThresholdMicros !==
                MANUAL_SELF_SERVE_OWNER_RAILS.maxThresholdMicros ||
              request.rails.maxAmountCents !== MANUAL_SELF_SERVE_OWNER_RAILS.maxAmountCents ||
              request.rails.maxMonthlyCapCents !==
                MANUAL_SELF_SERVE_OWNER_RAILS.maxMonthlyCapCents ||
              request.rails.maxAttemptsPerMonth !==
                MANUAL_SELF_SERVE_OWNER_RAILS.maxAttemptsPerMonth ||
              request.rails.minCooldownSeconds !==
                MANUAL_SELF_SERVE_OWNER_RAILS.minCooldownSeconds ||
              request.rails.maxFailureLimit !== MANUAL_SELF_SERVE_OWNER_RAILS.maxFailureLimit
            )
              throw authorityError(
                'billing_access_denied',
                'Manual prepaid enrollment uses fixed non-recurring rails.',
              );
            const activeOwner = await readBillingOwnerInTransaction(client, candidate.workspaceId);
            if (activeOwner)
              throw authorityError(
                'billing_owner_already_active',
                'This workspace already has an active funding owner.',
                409,
              );
            const policy = await verifyHumanIdentityTermsReceiptInTransaction(
              client,
              candidate.identity,
              options.humanTermsPolicy,
            );
            const current = await revalidatedBrowserCandidate(client, actor as Principal);
            if (
              current.role !== 'admin' ||
              current.membershipId !== candidate.membershipId ||
              current.keyId !== candidate.keyId ||
              current.keySecretVersion !== candidate.keySecretVersion ||
              current.identity.issuer !== candidate.identity.issuer ||
              current.identity.subject !== candidate.identity.subject
            )
              throw authorityError(
                'billing_access_denied',
                'Workspace administrator authority changed; sign in again.',
              );
            return {
              principal: current,
              processorEnvironmentId: environment.id,
              approvalReference:
                `self-serve-manual-v1:${current.membershipId}:${policy.version}`.slice(0, 200),
            };
          },
        }
      : {}),
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
  const ownerEnrollmentState = async (
    principal: Principal,
  ): Promise<BillingOwnerEnrollmentState | null> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let candidate: BrowserCandidate;
      try {
        candidate = await revalidatedBrowserCandidate(client, principal);
      } catch (error) {
        if (isDenied(error)) {
          await client.query('COMMIT');
          return null;
        }
        throw error;
      }
      await assertBillingProcessorEnvironmentInTransaction(client, environment);
      const row = (
        await client.query<{ authority_version: number }>(
          'SELECT authority_version FROM mr_billing_owners WHERE workspace_id=$1 FOR SHARE',
          [candidate.workspaceId],
        )
      ).rows[0];
      const expectedAuthorityVersion = row?.authority_version ?? 0;
      const activeOwner = await readBillingOwnerInTransaction(client, candidate.workspaceId);
      if (activeOwner) {
        await client.query('COMMIT');
        return {
          eligible: false,
          expectedAuthorityVersion,
          terms: options.terms,
          reason: 'owner-already-active',
        };
      }
      if (candidate.role !== 'admin') {
        await client.query('COMMIT');
        return {
          eligible: false,
          expectedAuthorityVersion,
          terms: options.terms,
          reason: 'admin-required',
        };
      }
      if (options.checkoutWritesEnabled === false) {
        await client.query('COMMIT');
        return {
          eligible: false,
          expectedAuthorityVersion,
          terms: options.terms,
          reason: 'checkout-paused',
        };
      }
      try {
        await verifyHumanIdentityTermsReceiptInTransaction(
          client,
          candidate.identity,
          options.humanTermsPolicy,
        );
      } catch (error) {
        if (isDenied(error)) {
          const code = (error as { code?: string }).code;
          await client.query('COMMIT');
          return {
            eligible: false,
            expectedAuthorityVersion,
            terms: options.terms,
            reason: code === 'current_human_terms_inactive' ? 'terms-inactive' : 'terms-required',
          };
        }
        throw error;
      }
      await client.query('COMMIT');
      return {
        eligible: true,
        expectedAuthorityVersion,
        terms: options.terms,
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
        const ownerEnrollment =
          options.activation === 'manual' && !read ? await ownerEnrollmentState(principal) : null;
        return {
          workspaceId: principal.workspaceId,
          recoveryScope,
          capabilities: { read, manage, setup },
          ...(ownerEnrollment ? { ownerEnrollment } : {}),
        };
      });
      if (options.activation === 'manual') {
        const origin = new URL(publicUrl).origin;
        const ownerInputSchema = z
          .object({
            expectedAuthorityVersion: z.number().int().nonnegative().max(2147483646),
            termsVersion: z.string().min(1).max(120),
            acceptedTerms: z.literal(true),
          })
          .strict();
        app.post('/v1/billing/owner', async (request, reply) => {
          reply.header('Cache-Control', 'private, no-store');
          if (request.headers.authorization || !request.cookies?.og_session)
            throw authorityError(
              'browser_session_required',
              'Sign in in your browser to enable prepaid billing.',
              401,
            );
          if (request.headers.origin !== origin)
            throw authorityError(
              'origin_denied',
              'Billing mutations require the configured website origin.',
            );
          const principal = await authenticate(request, null);
          requireBillingBrowserRecovery(principal, request.headers);
          const input = ownerInputSchema.parse(request.body);
          if (options.checkoutWritesEnabled === false)
            throw authorityError('checkout_paused', 'New Checkout requests are paused.', 503);
          if (input.termsVersion !== options.terms.version)
            throw authorityError(
              'billing_terms_changed',
              'The payment terms version changed. Review the current terms before continuing.',
              409,
            );
          if (
            principal.keyKind !== 'browser' ||
            !principal.membershipId ||
            !principal.keyId ||
            !principal.identity?.issuer ||
            !principal.identity.subject ||
            principal.bootstrap ||
            principal.externalOAuth
          )
            throw authorityError(
              'human_browser_required',
              'Sign in in your browser with an active workspace administrator account.',
            );
          const owner = await policies.establishOwner(principal, {
            expectedAuthorityVersion: input.expectedAuthorityVersion,
            rails: { ...MANUAL_SELF_SERVE_OWNER_RAILS },
            processorEnvironmentId: environment.id,
            livemode: environment.livemode,
            consentReference:
              `manual-prepaid:${options.terms.version}:${principal.membershipId}`.slice(0, 200),
          });
          return {
            workspaceId: principal.workspaceId,
            authorityVersion: owner.authorityVersion,
          };
        });
      }
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
