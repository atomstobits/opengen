import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { Principal } from '@media-router/engine';
import { assertBrowserRecoveryScope } from './browser-recovery.js';
import {
  BillingPolicyStore,
  BILLING_POLICY_LIMITS as limits,
  type BillingPrincipal,
  type BillingPolicyAuthority,
  type BillingScope,
  parseBillingPolicyValues,
  readBillingPolicyInTransaction,
  parseBillingDelegationRails,
} from '../../../packages/engine/src/billing-policy.js';
import type {
  BillingCustomerStore,
  BillingTerms,
  CustomerTransport,
  RechargeRecoveryTransport,
} from '../../../packages/engine/src/billing-customer.js';
import type { RechargeStore } from '../../../packages/engine/src/billing-recharge.js';

const billingPolicyValuesSchema = z
  .object({
    enabled: z.boolean(),
    thresholdMicros: z.number().int().min(0).max(limits.maxThresholdMicros),
    amountCents: z.number().int().min(limits.minAmountCents).max(limits.maxAmountCents),
    monthlyCapCents: z.number().int().min(limits.minAmountCents).max(limits.maxMonthlyCapCents),
    maxAttemptsPerMonth: z.number().int().min(1).max(limits.maxAttemptsPerMonth),
    cooldownSeconds: z.number().int().min(limits.minCooldownSeconds).max(limits.maxCooldownSeconds),
    failureLimit: z.number().int().min(1).max(limits.maxFailureLimit),
    mandateId: z.uuid().nullable(),
  })
  .strict();
const billingDelegationRailsSchema = z
  .object({
    allowsEnabled: z.boolean().default(false),
    maxThresholdMicros: billingPolicyValuesSchema.shape.thresholdMicros,
    maxAmountCents: billingPolicyValuesSchema.shape.amountCents,
    maxMonthlyCapCents: billingPolicyValuesSchema.shape.monthlyCapCents,
    maxAttemptsPerMonth: billingPolicyValuesSchema.shape.maxAttemptsPerMonth,
    minCooldownSeconds: billingPolicyValuesSchema.shape.cooldownSeconds,
    maxFailureLimit: billingPolicyValuesSchema.shape.failureLimit,
  })
  .strict();
export const billingPolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().max(2147483646),
    expectedAuthorityVersion: z.number().int().positive().max(2147483646),
    policy: billingPolicyValuesSchema,
    consentReference: z.string().min(1).max(200).optional(),
  })
  .strict();
export const billingDelegationInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative().max(2147483646),
    expectedAuthorityVersion: z.number().int().positive().max(2147483646),
    target: z.object({ kind: z.enum(['key', 'grant']), id: z.uuid() }).strict(),
    rails: billingDelegationRailsSchema,
    permissions: z
      .array(z.enum(['billing:read', 'billing:manage']))
      .min(1)
      .max(2),
    consentReference: z.string().min(1).max(200),
  })
  .strict();
export const billingSetupInputSchema = z
  .object({ termsVersion: z.string().min(1).max(120), acceptedTerms: z.literal(true) })
  .strict();
export const billingDocumentQuerySchema = z
  .object({
    type: z.enum(['receipt', 'invoice']).optional(),
    before: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export const billingDocumentSyncSchema = z
  .object({
    type: z.enum(['receipt', 'invoice']),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const billingOperationMetadata = {
  'billing.policy.get': {
    scope: 'billing:read',
    financialEffects: false,
    readOnly: true,
    description:
      'Read private recharge policy and approved funding limits. Does not charge a card.',
  },
  'billing.policy.update': {
    scope: 'billing:manage',
    financialEffects: true,
    readOnly: false,
    description:
      'Change the versioned automatic card-funding policy inside explicit owner-approved limits. Enabling may cause future worker-initiated saved-card charges; never creates a mandate or charges directly.',
  },
  'billing.recharges.list': {
    scope: 'billing:read',
    financialEffects: false,
    readOnly: true,
    description:
      'Read private existing recharge attempts and uncertainty. Never retries or dispatches a payment.',
  },
  'billing.documents.list': {
    scope: 'billing:read',
    financialEffects: false,
    readOnly: true,
    description: 'Read cached private receipts/invoices. A document is not wallet credit.',
  },
} as const;
export interface BillingRouteOptions {
  pool: Pool;
  policies: BillingPolicyStore;
  customers: BillingCustomerStore;
  recharge: RechargeStore;
  authenticate(
    request: FastifyRequest,
  ): Promise<BillingPrincipal | { actor: BillingPrincipal; principal: Principal }>;
  transport?: CustomerTransport;
  publicUrl: string;
  terms: BillingTerms | null;
  setupAvailable?: boolean;
  automaticRechargeAvailable?: boolean;
  portalAvailable?: boolean;
  recoveryAvailable?: boolean;
  recoveryTransport?: RechargeRecoveryTransport;
  publishableKey?: string;
}
const error = (code: string, message: string, statusCode = 403) =>
  Object.assign(new Error(message), { code, statusCode });

export function requireBillingBrowserRecovery(
  principal: Principal,
  headers: FastifyRequest['headers'],
): string {
  const recovery = headers['x-opengen-recovery-scope'];
  if (typeof recovery !== 'string' || typeof headers['x-opengen-workspace'] !== 'string')
    throw error(
      'browser_authority_changed',
      'Refresh the private billing page before continuing.',
      409,
    );
  assertBrowserRecoveryScope(principal, headers);
  return recovery;
}

/** A narrow router; human setup/owner delegation are deliberately outside MCP. */
export async function registerBillingRoutes(app: FastifyInstance, options: BillingRouteOptions) {
  const origin = new URL(options.publicUrl).origin;
  const actor = async (request: FastifyRequest, mutate = false) => {
    const identity = await options.authenticate(request);
    const current = 'actor' in identity ? identity.actor : identity;
    if (current.bootstrap || current.externalOAuth)
      throw error('billing_access_denied', 'Explicit local billing authority is required.');
    if (request.cookies?.og_session) {
      if (request.headers.authorization)
        throw error('ambiguous_authority', 'Use one authenticated authority per request.');
      const principal = 'actor' in identity ? identity.principal : (current as Principal);
      requireBillingBrowserRecovery(principal, request.headers);
      if (mutate && request.headers.origin !== origin)
        throw error('origin_denied', 'Billing mutations require the configured website origin.');
    } else if (
      request.headers['x-opengen-workspace'] !== undefined &&
      request.headers['x-opengen-workspace'] !== current.workspaceId
    )
      throw error('workspace_changed', 'The selected workspace changed.', 409);
    return current;
  };
  const withAuthority = async <T>(
    principal: BillingPrincipal,
    scope: BillingScope,
    fn: (client: PoolClient, proof: BillingPolicyAuthority) => Promise<T>,
  ): Promise<T> => {
    const client = await options.pool.connect();
    try {
      await client.query('BEGIN');
      const proof = await options.policies.authorizeInTransaction(client, principal, scope);
      const value = await fn(client, proof);
      await client.query('COMMIT');
      return value;
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
  };
  const transport = () => {
    if (!options.transport)
      throw error('billing_not_configured', 'Hosted billing is not configured.', 503);
    return options.transport;
  };
  const browserOwner = async (request: FastifyRequest, principal: BillingPrincipal) => {
    if (
      !request.cookies?.og_session ||
      request.headers.authorization ||
      principal.keyKind !== 'browser'
    )
      throw error(
        'human_browser_required',
        'Use the approved funding owner’s browser session for this action.',
      );
    return withAuthority(principal, 'billing:manage', async (_client, proof) => {
      if (!proof.humanMembershipId)
        throw error(
          'human_billing_owner_required',
          'A current approved human funding owner must complete this action.',
        );
    });
  };
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/v1/billing/')) reply.header('Cache-Control', 'private, no-store');
    return payload;
  });
  app.get('/v1/billing/policy', async (request) => {
    const p = await actor(request);
    const snapshot = await withAuthority(p, 'billing:read', async (client, proof) => {
      const policy = await readBillingPolicyInTransaction(client, p.workspaceId);
      const { owner, humanMembershipId } = proof;
      // The owner may bind a newly completed setup. Delegates see only the policy's mandate.
      const active = humanMembershipId
        ? (
            await client.query(
              `SELECT id,status FROM mr_billing_mandates
               WHERE workspace_id=$1 AND human_membership_id=$2 AND status='active'
                 AND livemode=$3 AND owner_authority_version=$4 AND owner_consent_reference=$5
                 AND owner_membership_epoch=$6 AND processor_environment_id=$7`,
              [
                p.workspaceId,
                humanMembershipId,
                owner.livemode,
                owner.authorityVersion,
                owner.consentReference,
                owner.membershipEpoch,
                owner.processorEnvironmentId,
              ],
            )
          ).rows[0]
        : null;
      const row =
        active ??
        (policy.mandateId
          ? (
              await client.query(
                'SELECT id,status FROM mr_billing_mandates WHERE workspace_id=$1 AND id=$2',
                [p.workspaceId, policy.mandateId],
              )
            ).rows[0]
          : null);
      return {
        policy,
        ownerAuthorityVersion: proof.owner.authorityVersion,
        mandate: row ? { id: row.id, status: row.status } : null,
      };
    });
    return {
      workspaceId: p.workspaceId,
      ...snapshot,
      automaticRechargeAvailable: options.automaticRechargeAvailable === true,
      setupAvailable: options.setupAvailable === true,
      portalAvailable: options.portalAvailable === true,
      recoveryAvailable: options.recoveryAvailable === true,
      terms: options.terms,
    };
  });
  app.put('/v1/billing/policy', async (request) => {
    const p = await actor(request, true),
      input = billingPolicyInputSchema.parse(request.body);
    const policy = await options.policies.updatePolicy(p, {
      ...input,
      policy: parseBillingPolicyValues(input.policy),
    });
    return { workspaceId: p.workspaceId, policy };
  });
  app.put('/v1/billing/delegations', async (request) => {
    const p = await actor(request, true),
      input = billingDelegationInputSchema.parse(request.body);
    const delegation = await options.policies.setDelegation(p, {
      ...input,
      rails: parseBillingDelegationRails(input.rails),
    });
    return { workspaceId: p.workspaceId, delegation };
  });
  app.delete('/v1/billing/delegations', async (request) => {
    const p = await actor(request, true),
      input = billingDelegationInputSchema
        .omit({ rails: true, permissions: true })
        .parse(request.body);
    await options.policies.revokeDelegation(
      p,
      input.target,
      input.expectedVersion,
      input.consentReference,
      input.expectedAuthorityVersion,
    );
    return { workspaceId: p.workspaceId, revoked: true };
  });
  app.post('/v1/billing/setup', async (request) => {
    const p = await actor(request, true);
    await browserOwner(request, p);
    if (!options.setupAvailable || !options.terms)
      throw error(
        'setup_not_activated',
        'Payment setup is awaiting explicit installation approval.',
        409,
      );
    const input = billingSetupInputSchema.parse(request.body),
      key = request.headers['idempotency-key'];
    if (typeof key !== 'string')
      throw error('idempotency_required', 'Use the original setup Idempotency-Key.', 400);
    const setup = await options.customers.startSetup(
      p,
      p.workspaceId,
      { idempotencyKey: key, termsVersion: input.termsVersion, consent: input.acceptedTerms },
      transport(),
    );
    return { workspaceId: p.workspaceId, ...setup };
  });
  app.get<{ Params: { id: string } }>('/v1/billing/setups/:id', async (request) => {
    const p = await actor(request);
    await browserOwner(request, p);
    return {
      workspaceId: p.workspaceId,
      ...(await options.customers.getSetup(p, p.workspaceId, z.uuid().parse(request.params.id))),
    };
  });
  app.delete('/v1/billing/mandate', async (request) => {
    const p = await actor(request, true);
    await browserOwner(request, p);
    const input = z.object({ id: z.uuid() }).strict().parse(request.body);
    await options.customers.revokeMandate(p, p.workspaceId, input.id);
    return { workspaceId: p.workspaceId, revoked: true };
  });
  app.post('/v1/billing/portal', async (request) => {
    const p = await actor(request, true);
    await browserOwner(request, p);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    if (!options.portalAvailable)
      throw error('portal_not_activated', 'Portal access awaits explicit approval.', 409);
    return {
      workspaceId: p.workspaceId,
      ...(await options.customers.portal(p, p.workspaceId, transport())),
    };
  });
  app.get('/v1/billing/documents', async (request) => {
    const p = await actor(request),
      input = billingDocumentQuerySchema.parse(request.query);
    return {
      workspaceId: p.workspaceId,
      ...(await options.customers.documents(p, p.workspaceId, input)),
    };
  });
  app.post('/v1/billing/documents/sync', async (request) => {
    const p = await actor(request, true),
      input = billingDocumentSyncSchema.parse(request.body);
    return {
      workspaceId: p.workspaceId,
      ...(await options.customers.syncDocuments(p, p.workspaceId, input, transport())),
    };
  });
  app.post<{ Params: { id: string } }>(
    '/v1/billing/recharges/:id/authentication',
    async (request) => {
      const p = await actor(request, true);
      await browserOwner(request, p);
      if (!options.recoveryAvailable || !options.recoveryTransport || !options.publishableKey)
        throw error('recovery_not_activated', 'Card authentication recovery is not enabled.', 409);
      const input = z
        .object({
          expectedPolicyVersion: z.number().int().positive(),
          expectedAuthorityVersion: z.number().int().positive(),
        })
        .strict()
        .parse(request.body);
      const recovery = await options.recharge.authentication(
        p.workspaceId,
        z.uuid().parse(request.params.id),
        input,
        async (client) => {
          const proof = await options.policies.authorizeInTransaction(client, p, 'billing:manage');
          if (!proof.humanMembershipId)
            throw error(
              'human_billing_owner_required',
              'A current funding owner must authenticate the original payment.',
            );
        },
        options.recoveryTransport,
      );
      return { workspaceId: p.workspaceId, ...recovery, publishableKey: options.publishableKey };
    },
  );
  app.get('/v1/billing/recharges', async (request) => {
    const p = await actor(request);
    z.object({}).strict().parse(request.query);
    return {
      workspaceId: p.workspaceId,
      data: await withAuthority(p, 'billing:read', (client) =>
        options.recharge.listInTransaction(client, p.workspaceId),
      ),
    };
  });
}
