import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AccountGovernanceStore } from '../../../packages/engine/src/account-governance.js';
import type { GovernancePrincipal } from '../../../packages/engine/src/governance-authority.js';
import type { RoutingPolicyStore } from '../../../packages/engine/src/routing-governance.js';
import { routingSchema } from './validation.js';

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ids = z.array(z.string().min(1).max(160)).max(100);
/** Admin profiles permit explicit empty denial. Generation overrides retain their own schema. */
export const governancePolicySchema = routingSchema.safeExtend({
  modelIds: ids.optional(),
  modelProviderExceptions: z
    .array(z.object({ modelId: z.string().min(1).max(160), providerIds: ids }).strict())
    .max(100)
    .optional(),
  providerIds: ids.optional(),
  deploymentIds: ids.optional(),
  endpointRegions: ids.optional(),
  processingRegions: ids.optional(),
  processingScopes: z
    .array(z.enum(['regional', 'mainland-china', 'international', 'global', 'undisclosed']))
    .max(100)
    .optional(),
});
export const governanceKeyUpdateSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    monthlyCapMicros: money.nullable().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.monthlyCapMicros !== undefined, {
    message: 'Provide a key name or monthly cap.',
  });
export const governanceKeyRotateSchema = z
  .object({ expectedSecretVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();
export const governancePolicyUpdateSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    name: z.string().min(1).max(80).optional(),
    policy: governancePolicySchema.optional(),
    maxCostMicros: money.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.policy !== undefined || value.maxCostMicros !== undefined,
    { message: 'Provide a routing profile change.' },
  );
export const governancePolicyArchiveSchema = z
  .object({ expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

/** Integrator mounts this once after auth. Authority always comes from the authenticator. */
export async function registerGovernance(
  app: FastifyInstance,
  context: {
    authenticate(
      request: FastifyRequest,
      scope: 'read' | 'keys:write' | 'policies:write',
    ): Promise<GovernancePrincipal>;
    keys?: Pick<AccountGovernanceStore, 'listKeys' | 'updateKey' | 'rotateKey'>;
    policies?: Pick<RoutingPolicyStore, 'list' | 'update' | 'archive'>;
  },
) {
  const id = z.object({ id: z.uuid() }).strict();
  const missing = () =>
    Object.assign(new Error('Governance is not configured.'), {
      code: 'database_not_configured',
      statusCode: 503,
    });
  const keys = () => {
    if (!context.keys) throw missing();
    return context.keys;
  };
  const policies = () => {
    if (!context.policies) throw missing();
    return context.policies;
  };
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      /^\/v1\/(?:governance(?:\/|$)|keys(?:\/|$)|policies(?:\/|$))/.test(request.url.split('?')[0]!)
    )
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.get('/v1/governance/keys', async (request) => {
    const actor = await context.authenticate(request, 'keys:write');
    z.object({}).strict().parse(request.query);
    return { data: await keys().listKeys(actor) };
  });
  app.get('/v1/governance/policies', async (request) => {
    const actor = await context.authenticate(request, 'read');
    const query = z
      .object({ includeArchived: z.enum(['true', 'false']).optional() })
      .strict()
      .parse(request.query);
    return { data: await policies().list(actor, query.includeArchived === 'true') };
  });
  app.patch('/v1/keys/:id', async (request) => {
    const actor = await context.authenticate(request, 'keys:write');
    return keys().updateKey(
      actor,
      id.parse(request.params).id,
      governanceKeyUpdateSchema.parse(request.body),
    );
  });
  app.post('/v1/keys/:id/rotate', async (request) => {
    const actor = await context.authenticate(request, 'keys:write');
    return keys().rotateKey(
      actor,
      id.parse(request.params).id,
      governanceKeyRotateSchema.parse(request.body).expectedSecretVersion,
    );
  });
  app.patch('/v1/policies/:id', async (request) => {
    const actor = await context.authenticate(request, 'policies:write');
    const { expectedRevision, ...patch } = governancePolicyUpdateSchema.parse(request.body);
    return policies().update(actor, id.parse(request.params).id, expectedRevision, patch);
  });
  app.post('/v1/policies/:id/archive', async (request) => {
    const actor = await context.authenticate(request, 'policies:write');
    return policies().archive(
      actor,
      id.parse(request.params).id,
      governancePolicyArchiveSchema.parse(request.body).expectedRevision,
    );
  });
}
