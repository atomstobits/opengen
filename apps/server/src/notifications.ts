import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeyScope, Principal } from '@media-router/engine';
import {
  NotificationStore,
  notificationTypes,
} from '../../../packages/engine/src/notifications.js';

export const notificationPreferencesSchema = z
  .object({
    inApp: z.boolean(),
    eventTypes: z.array(z.enum(notificationTypes)).max(2),
    email: z.boolean().optional(),
  })
  .strict();

/** Integrator registers this with the existing authenticator; no browser-supplied member IDs. */
export async function registerNotifications(
  app: FastifyInstance,
  options: {
    notifications?: NotificationStore;
    authenticate: (
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ) => Promise<Principal>;
  },
) {
  const store = () => {
    if (!options.notifications)
      throw Object.assign(new Error('Notifications are not configured.'), { statusCode: 503 });
    return options.notifications;
  };
  app.get('/v1/notifications', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await options.authenticate(request, 'read');
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        cursor: z.string().max(2048).optional(),
        unreadOnly: z
          .enum(['true', 'false'])
          .transform((value) => value === 'true')
          .optional(),
      })
      .strict()
      .parse(request.query);
    return store().list(actor, query);
  });
  app.get('/v1/notifications/preferences', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return store().getPreferences(await options.authenticate(request, 'read'));
  });
  app.put('/v1/notifications/preferences', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await options.authenticate(request, 'read');
    return store().setPreferences(actor, notificationPreferencesSchema.parse(request.body));
  });
  app.post<{ Params: { id: string } }>('/v1/notifications/:id/read', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const actor = await options.authenticate(request, 'read');
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return store().markRead(actor, z.uuid().parse(request.params.id));
  });
}
