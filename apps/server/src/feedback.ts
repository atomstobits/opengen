import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { feedbackInputSchema } from '@media-router/contracts';
import type { FeedbackStore, KeyScope, Principal } from '@media-router/engine';

export async function registerFeedback(
  app: FastifyInstance,
  options: {
    feedback?: FeedbackStore;
    authenticate(
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ): Promise<Principal>;
  },
) {
  const store = () => {
    if (!options.feedback)
      throw Object.assign(new Error('Private report storage is not configured.'), {
        code: 'feedback_not_configured',
        statusCode: 503,
      });
    return options.feedback;
  };
  const submit =
    (kind?: 'catalog-request') =>
    async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
      const actor = await options.authenticate(request, 'feedback:write');
      const input = feedbackInputSchema.parse(request.body);
      if (kind && input.kind !== kind)
        throw Object.assign(new Error('Use kind catalog-request.'), {
          statusCode: 400,
          code: 'invalid_input',
        });
      reply.code(201).header('Cache-Control', 'no-store');
      return store().submit(actor.workspaceId, input);
    };
  app.post('/v1/feedback', submit());
  app.post('/v1/catalog/requests', submit('catalog-request'));
  app.get<{ Params: { id: string } }>('/v1/feedback/:id', async (request, reply) => {
    const actor = await options.authenticate(request);
    reply.header('Cache-Control', 'no-store');
    return store().get(actor.workspaceId, z.uuid().parse(request.params.id));
  });
}
