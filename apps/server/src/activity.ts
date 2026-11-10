import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { KeyScope, Principal } from '@media-router/engine';
import { ActivityStore, parseActivityFilters } from '../../../packages/engine/src/activity.js';

/** Registries/relay wiring remain an integration-owned hook. No workspace ID is accepted from query/body. */
export async function registerActivity(
  app: FastifyInstance,
  options: {
    activity?: ActivityStore;
    authenticate: (
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ) => Promise<Principal>;
  },
) {
  const store = () => {
    if (!options.activity)
      throw Object.assign(new Error('Activity is not configured.'), {
        statusCode: 503,
        code: 'database_not_configured',
      });
    return options.activity;
  };
  app.get('/v1/activity', async (request, reply) => {
    const principal = await options.authenticate(request, 'read');
    reply.header('Cache-Control', 'private, no-store');
    return store().list(principal.workspaceId, parseActivityFilters(request.query));
  });
  app.get('/v1/activity/analytics', async (request, reply) => {
    const principal = await options.authenticate(request, 'read');
    reply.header('Cache-Control', 'private, no-store');
    return store().analytics(principal.workspaceId, parseActivityFilters(request.query));
  });
}
