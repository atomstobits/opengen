import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eventTypes, type EventStore } from '@media-router/engine';
import type { KeyScope, Principal } from '@media-router/engine';

const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional();
export const webhookEditSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.url().max(2048).optional(),
    eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length).optional(),
    enabled: z.boolean().optional(),
    pending: z.literal('cancel').optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.url !== undefined ||
      value.eventTypes !== undefined ||
      value.enabled !== undefined,
    'Provide at least one subscription field.',
  )
  .refine(
    (value) =>
      (value.url === undefined && value.eventTypes === undefined) || value.pending === 'cancel',
    'Endpoint/event edits require pending: cancel.',
  );
export const alertSettingsSchema = z
  .object({
    enabled: z.boolean(),
    lowBalanceMicros: money,
    spendingLimitMicros: money,
    keyExpiryHours: z.number().int().min(1).max(720).nullable().optional(),
    webhookFailures: z.boolean(),
  })
  .strict();

export async function registerEvents(
  app: FastifyInstance,
  options: {
    events?: EventStore;
    authenticate: (
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ) => Promise<Principal>;
  },
) {
  const store = () => {
    if (!options.events)
      throw Object.assign(new Error('Event storage is not configured.'), { statusCode: 503 });
    return options.events;
  };
  const workspace = async (request: FastifyRequest) =>
    (await options.authenticate(request, 'webhooks:write')).workspaceId;
  app.get('/v1/webhooks', async (request) => ({
    data: await store().listSubscriptions(await workspace(request)),
  }));
  app.post('/v1/webhooks', async (request, reply) => {
    const id = await workspace(request);
    const input = z
      .object({
        name: z.string().min(1).max(80),
        url: z.url().max(2048),
        eventTypes: z.array(z.enum(eventTypes)).min(1).max(eventTypes.length),
      })
      .strict()
      .parse(request.body);
    reply.code(201).header('Cache-Control', 'no-store');
    return store().createSubscription(id, input);
  });
  app.patch<{ Params: { id: string } }>('/v1/webhooks/:id', async (request) => {
    const workspaceId = await workspace(request);
    const input = webhookEditSchema.parse(request.body);
    if (Object.keys(input).length === 1 && input.enabled !== undefined)
      return store().setEnabled(workspaceId, z.uuid().parse(request.params.id), input.enabled);
    return store().editSubscription(workspaceId, z.uuid().parse(request.params.id), input);
  });
  app.post<{ Params: { id: string } }>('/v1/webhooks/:id/rotate-secret', async (request, reply) => {
    const workspaceId = await workspace(request);
    reply.header('Cache-Control', 'no-store');
    return store().rotateSecret(workspaceId, z.uuid().parse(request.params.id));
  });
  app.get('/v1/webhook-deliveries', async (request) => ({
    data: await store().deliveries(await workspace(request)),
  }));
  app.get('/v1/alerts/settings', async (request) =>
    store().getAlertSettings(await workspace(request)),
  );
  app.put('/v1/alerts/settings', async (request) => {
    const id = await workspace(request);
    const input = alertSettingsSchema.parse(request.body);
    return store().configureAlerts(id, input);
  });
  app.get('/v1/alerts', async (request) => ({
    data: await store().alerts(await workspace(request)),
  }));
}
