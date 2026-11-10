import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { KeyScope, Principal } from '@media-router/engine';
import type { EngineLike } from './app.js';

export const reconciliationSchema = z
  .object({
    action: z.enum(['resume', 'reject', 'settle']),
    reference: z.string().min(1).max(200),
    note: z.string().min(20).max(1000),
    evidenceUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }, 'Evidence must be an HTTPS URL without embedded credentials'),
    upstreamId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[^\s\u0000-\u001f]+$/)
      .optional(),
    billedCostMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    costBasis: z.literal('operator-audited').optional(),
  })
  .strict();
export const ledgerQuerySchema = z
  .object({
    after: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .strict();
export async function registerOperator(
  app: FastifyInstance,
  options: {
    engine?: EngineLike;
    authenticate: (
      request: Pick<FastifyRequest, 'headers' | 'cookies'>,
      scope?: KeyScope,
    ) => Promise<Principal>;
  },
) {
  const engine = () => {
    if (!options.engine)
      throw Object.assign(new Error('Database is not configured.'), { statusCode: 503 });
    return options.engine;
  };
  app.post<{ Params: { workspaceId: string; id: string } }>(
    '/v1/workspaces/:workspaceId/generations/:id/reconcile',
    async (request) => {
      const principal = await options.authenticate(request, 'keys:write');
      if (!principal.bootstrap)
        throw Object.assign(
          new Error('Only the installation operator can reconcile provider acceptance or cost.'),
          { statusCode: 403 },
        );
      const input = reconciliationSchema.parse(request.body);
      const backend = engine();
      if (!backend.reconcile)
        throw Object.assign(new Error('Reconciliation is unavailable.'), { statusCode: 503 });
      return backend.reconcile(
        z
          .string()
          .regex(/^[a-zA-Z0-9_-]{1,80}$/)
          .parse(request.params.workspaceId),
        z.uuid().parse(request.params.id),
        input,
        ...(input.costBasis ? [{ operatorId: 'installation-operator' }] : []),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string } }>(
    '/v1/workspaces/:workspaceId/generations/:id/reconciliations',
    async (request) => {
      const principal = await options.authenticate(request, 'keys:write');
      if (!principal.bootstrap)
        throw Object.assign(
          new Error('Only the installation operator can inspect reconciliation evidence.'),
          { statusCode: 403 },
        );
      return {
        data:
          (await engine().reconciliations?.(
            z
              .string()
              .regex(/^[a-zA-Z0-9_-]{1,80}$/)
              .parse(request.params.workspaceId),
            z.uuid().parse(request.params.id),
          )) ?? [],
      };
    },
  );
  app.get<{ Params: { workspaceId: string; id: string } }>(
    '/v1/workspaces/:workspaceId/generations/:id',
    async (request, reply) => {
      const principal = await options.authenticate(request, 'keys:write');
      if (!principal.bootstrap)
        throw Object.assign(
          new Error('Only the installation operator can inspect another workspace job.'),
          { statusCode: 403 },
        );
      const workspace = z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,80}$/)
        .parse(request.params.workspaceId);
      const backend = engine();
      const id = z.uuid().parse(request.params.id);
      const job = backend.inspectJob
        ? await backend.inspectJob(workspace, id)
        : await backend.getJob(workspace, id);
      return (
        job ??
        reply.code(404).send({ error: { code: 'not_found', message: 'Generation not found.' } })
      );
    },
  );
  app.get('/v1/ledger/export', async (request, reply) => {
    const principal = await options.authenticate(request);
    const schema = ledgerQuerySchema.extend({ format: z.enum(['json', 'csv']).default('csv') });
    const { format, ...query } = schema.parse(request.query);
    const rows = (await engine().ledger?.(principal.workspaceId, query)) as
      Record<string, unknown>[] | undefined;
    if (!rows) throw Object.assign(new Error('Ledger is unavailable.'), { statusCode: 503 });
    if (rows.length === query.limit) reply.header('X-Next-Cursor', String(rows.at(-1)!.id));
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Disposition', `attachment; filename="opengen-ledger.${format}"`);
    if (format === 'json') return { data: rows };
    const columns = [
      'id',
      'job_id',
      'kind',
      'amount_micros',
      'available_delta_micros',
      'reserved_delta_micros',
      'created_at',
      'details',
    ];
    const cell = (value: unknown) =>
      `"${(value instanceof Date ? value.toISOString() : typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).replaceAll('"', '""')}"`;
    return reply
      .type('text/csv; charset=utf-8')
      .send(
        [
          columns.join(','),
          ...rows.map((row) => columns.map((column) => cell(row[column])).join(',')),
        ].join('\r\n'),
      );
  });
}
