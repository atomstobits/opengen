import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { BillingOperationsStore } from '../../../packages/engine/src/billing-operations.js';
import type { RechargeStore } from '../../../packages/engine/src/billing-recharge.js';
import type { RechargeTransport } from '../../../packages/engine/src/billing-customer.js';
import type { Principal } from '@media-router/engine';
const workspace = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const evidence = z
  .object({
    reference: z.string().min(1).max(200),
    note: z.string().min(1).max(2000),
    evidenceUrl: z.url().max(2000),
  })
  .strict();
const WORK_RATE_LIMIT_WINDOW_MS = 60_000;
const WORK_RATE_LIMIT_MAX = 60;

export async function registerBillingOperatorRoutes(
  app: FastifyInstance,
  options: {
    operations: BillingOperationsStore;
    recharge: RechargeStore;
    transport?: RechargeTransport;
    authenticate(request: FastifyRequest): Promise<Principal>;
    revalidateOperator?(client: PoolClient, principal: Principal): Promise<void>;
  },
) {
  let workWindowStart = 0;
  let workWindowCount = 0;
  const checkWorkRateLimit = () => {
    const now = Date.now();
    if (now - workWindowStart >= WORK_RATE_LIMIT_WINDOW_MS) {
      workWindowStart = now;
      workWindowCount = 0;
    }
    workWindowCount += 1;
    if (workWindowCount > WORK_RATE_LIMIT_MAX)
      throw Object.assign(new Error('Operator billing tick rate limit exceeded.'), {
        code: 'rate_limited',
        statusCode: 429,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((WORK_RATE_LIMIT_WINDOW_MS - (now - workWindowStart)) / 1000),
        ),
      });
  };
  const operator = async (request: FastifyRequest) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error('Use explicit installation operator bearer authority.'), {
        code: 'operator_required',
        statusCode: 403,
      });
    const p = await options.authenticate(request);
    if (!p.bootstrap)
      throw Object.assign(new Error('Installation operator authority is required.'), {
        code: 'operator_required',
        statusCode: 403,
      });
    return p;
  };
  const revalidate = (p: Principal) => (client: PoolClient) => {
    if (options.revalidateOperator) return options.revalidateOperator(client, p);
    if (!p.bootstrap)
      throw Object.assign(new Error('Operator authority changed.'), { statusCode: 403 });
    return Promise.resolve();
  };
  const audit = (p: Principal) => ({
    kind: 'installation-operator',
    workspaceId: p.workspaceId,
    keyId: p.keyId ?? null,
  });
  app.get('/v1/operator/billing', async (request, reply) => {
    const p = await operator(request),
      query = z
        .object({
          workspaceId: workspace.optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        })
        .strict()
        .parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ data: await options.operations.queue(revalidate(p), query) });
  });
  app.post('/v1/operator/billing/holds/resolve', async (request, reply) => {
    const p = await operator(request),
      input = evidence
        .extend({ workspaceId: workspace, eventId: z.string().min(1).max(200) })
        .strict()
        .parse(request.body);
    await options.operations.resolveHold(
      input.workspaceId,
      input.eventId,
      input,
      audit(p),
      revalidate(p),
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ workspaceId: input.workspaceId, resolved: true });
  });
  app.post('/v1/operator/billing/recharges/resolve', async (request, reply) => {
    const p = await operator(request),
      input = evidence
        .extend({
          workspaceId: workspace,
          id: z.uuid(),
          action: z.enum(['bind', 'confirmed-unpaid']),
          paymentIntentId: z
            .string()
            .regex(/^pi_[A-Za-z0-9_]+$/)
            .optional(),
        })
        .strict()
        .parse(request.body);
    if (!options.transport)
      throw Object.assign(new Error('Payment reconciliation transport is unavailable.'), {
        statusCode: 503,
        code: 'billing_not_configured',
      });
    const attempt = await options.recharge.resolve(
      input.workspaceId,
      input.id,
      input,
      audit(p),
      revalidate(p),
      options.transport,
    );
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ workspaceId: input.workspaceId, attempt });
  });
  app.post('/v1/operator/billing/work', async (request, reply) => {
    checkWorkRateLimit();
    const p = await operator(request);
    z.object({})
      .strict()
      .optional()
      .parse(request.body ?? {});
    if (!options.transport)
      throw Object.assign(new Error('Payment reconciliation transport is unavailable.'), {
        statusCode: 503,
        code: 'billing_not_configured',
      });
    await revalidate(p)({} as PoolClient);
    await options.recharge.workOnce(options.transport);
    return reply.header('Cache-Control', 'private, no-store').send({ ok: true });
  });
}
