import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JobStatusStore, KeyScope, Principal } from '@media-router/engine';

export const jobStatusQuerySchema = z
  .object({
    id: z.uuid(),
    afterRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    waitMs: z.coerce.number().int().min(0).max(25000).optional(),
  })
  .strict();
type Auth = (
  request: Pick<FastifyRequest, 'headers' | 'cookies'>,
  scope?: KeyScope | null,
) => Promise<Principal>;

/** Used by native HTTP and the MCP call adapter, tied to their ORIGINAL transport.
 * A cached Principal is deliberately never accepted by this boundary. */
export async function readJobStatus(
  request: FastifyRequest,
  reply: FastifyReply,
  store: Pick<JobStatusStore, 'wait'> | undefined,
  reauthorize: () => Promise<Principal>,
  input: z.infer<typeof jobStatusQuerySchema>,
) {
  reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization, Cookie');
  if (!store)
    throw Object.assign(new Error('Compact status is not configured.'), {
      code: 'database_not_configured',
      statusCode: 503,
    });
  const controller = new AbortController();
  const aborted = () => controller.abort();
  const closed = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  request.raw.once('aborted', aborted);
  reply.raw.once('close', closed);
  if (request.raw.aborted || reply.raw.destroyed) controller.abort();
  try {
    return await store.wait(
      async () => {
        try {
          return await reauthorize();
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode === 401) return null;
          throw error;
        }
      },
      input.id,
      { afterRevision: input.afterRevision, waitMs: input.waitMs, signal: controller.signal },
    );
  } finally {
    request.raw.removeListener('aborted', aborted);
    reply.raw.removeListener('close', closed);
  }
}

export async function registerJobStatus(
  app: FastifyInstance,
  options: { store?: Pick<JobStatusStore, 'wait'>; authenticate: Auth },
) {
  app.get<{ Params: { id: string } }>('/v1/generations/:id/status', async (request, reply) => {
    const input = jobStatusQuerySchema.parse({
      ...jobStatusQuerySchema.omit({ id: true }).parse(request.query),
      id: request.params.id,
    });
    try {
      return await readJobStatus(
        request,
        reply,
        options.store,
        () => options.authenticate(request, null),
        input,
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'status_wait_aborted') {
        reply.hijack();
        return reply;
      }
      throw error;
    }
  });
}
