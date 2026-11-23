import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeyScope, PendingEmailCreditStore, Principal } from '@media-router/engine';

const createSchema = z
  .object({
    email: z.string().min(3).max(254),
    amountMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    reference: z.string().min(1).max(200),
    issuer: z.string().min(1).max(500).optional(),
    note: z.string().min(1).max(1000).optional(),
  })
  .strict();

const listQuerySchema = z
  .object({
    email: z.string().min(3).max(254).optional(),
    status: z.enum(['pending', 'claimed', 'revoked']).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

export async function registerPendingEmailCredits(
  app: FastifyInstance,
  options: {
    store?: PendingEmailCreditStore;
    defaultIssuer?: string;
    authenticate: (
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ) => Promise<Principal>;
  },
) {
  const requireOperator = async (request: FastifyRequest) => {
    if (!request.headers.authorization)
      throw Object.assign(new Error('Use explicit installation operator bearer authority.'), {
        code: 'operator_required',
        statusCode: 403,
      });
    const principal = await options.authenticate(request, 'keys:write');
    if (!principal.bootstrap)
      throw Object.assign(
        new Error('Only the installation operator can manage pending email credits.'),
        {
          code: 'operator_required',
          statusCode: 403,
        },
      );
    return principal;
  };
  const requireStore = () => {
    if (!options.store)
      throw Object.assign(new Error('Database is not configured.'), {
        code: 'database_not_configured',
        statusCode: 503,
      });
    return options.store;
  };

  app.post('/v1/operator/pending-email-credits', async (request, reply) => {
    await requireOperator(request);
    const input = createSchema.parse(request.body);
    const issuer = input.issuer ?? options.defaultIssuer;
    if (!issuer)
      throw Object.assign(
        new Error('Provide an HTTPS OIDC issuer or configure OIDC_ISSUER on the server.'),
        {
          code: 'issuer_required',
          statusCode: 400,
        },
      );
    const result = await requireStore().enqueue({
      issuer,
      email: input.email,
      amountMicros: input.amountMicros,
      reference: input.reference,
      ...(input.note !== undefined ? { note: input.note } : {}),
    });
    return reply
      .code(result.created ? 201 : 200)
      .header('Cache-Control', 'private, no-store')
      .send(result.credit);
  });

  app.get('/v1/operator/pending-email-credits', async (request, reply) => {
    await requireOperator(request);
    const query = listQuerySchema.parse(request.query);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ data: await requireStore().list(query) });
  });

  app.delete<{ Params: { id: string } }>(
    '/v1/operator/pending-email-credits/:id',
    async (request, reply) => {
      await requireOperator(request);
      const id = z.uuid().parse(request.params.id);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send(await requireStore().revoke(id));
    },
  );
}
