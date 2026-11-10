import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Engine, KeyScope, Principal } from '@media-router/engine';

export type ComparisonEngine = Pick<
  Engine,
  'quoteComparison' | 'submitComparison' | 'getComparison' | 'listComparisons'
>;

export const comparisonQuoteRequestSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    routeIds: z.tuple([z.string().min(1).max(200), z.string().min(1).max(200)]),
  })
  .strict();

export function registerComparison(
  app: FastifyInstance,
  authenticate: (request: FastifyRequest, scope?: KeyScope) => Promise<Principal>,
  comparison: Partial<ComparisonEngine> | undefined,
) {
  const requireComparison = () => {
    if (
      !comparison?.quoteComparison ||
      !comparison.submitComparison ||
      !comparison.getComparison ||
      !comparison.listComparisons
    )
      throw Object.assign(new Error('Private comparison is unavailable on this gateway.'), {
        code: 'comparison_unavailable',
        statusCode: 503,
      });
    return comparison as ComparisonEngine;
  };
  app.post('/v1/comparisons/quote', async (request, reply) => {
    const principal = await authenticate(request);
    const { prompt, routeIds } = comparisonQuoteRequestSchema.parse(request.body);
    const result = await requireComparison().quoteComparison(principal, prompt, routeIds);
    return reply.code(201).send(result);
  });
  app.get('/v1/comparisons', async (request) => {
    const principal = await authenticate(request);
    return { data: await requireComparison().listComparisons(principal.workspaceId) };
  });
  app.get<{ Params: { id: string } }>('/v1/comparisons/:id', async (request, reply) => {
    const principal = await authenticate(request);
    const run = await requireComparison().getComparison(principal.workspaceId, request.params.id);
    return (
      run ??
      reply.code(404).send({ error: { code: 'not_found', message: 'Comparison not found.' } })
    );
  });
  app.post<{ Params: { id: string } }>('/v1/comparisons/:id/approve', async (request, reply) => {
    const principal = await authenticate(request, 'generate');
    if (request.body !== undefined)
      return reply.code(400).send({
        error: {
          code: 'invalid_input',
          message: 'Approve the existing quote without a request body.',
        },
      });
    const run = await requireComparison().submitComparison(principal, request.params.id);
    return reply.code(202).send(run);
  });
}
