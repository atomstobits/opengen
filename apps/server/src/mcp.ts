import { readJobStatus } from './job-status.js';
import { canonicalModelId, type OperationId } from '@media-router/contracts';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  catalog,
  generationProfiles,
  getCompanyDetail,
  getSeriesDetail,
  getSeriesForModel,
  searchCatalog,
  catalogSearchFiltersSchema,
} from '@media-router/catalog';
import type { GenerateInput, Job, Quote } from '@media-router/contracts';
import type { EngineLike } from './app.js';
import { type Principal, type KeyScope } from '@media-router/engine';
import { generationSchema } from './validation.js';
import { callSchema, legacyCallSchema, operationRequest } from './operations.js';
import { jobResultHtml } from './mcp-job-preview.js';
import { billingOperationMetadata } from './billing.js';

interface Context {
  oauthEnabled?: boolean;
  billingAvailable?: boolean;
  publicUrl?: string;
  env: NodeJS.ProcessEnv;
  authenticate(header: string | undefined, scope?: KeyScope | null): Promise<Principal>;
  parseInput(input: unknown): GenerateInput;
  makeQuote(input: GenerateInput, principal?: Principal): Promise<Quote>;
  requireEngine(): EngineLike;
}
const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const billingToolOperations = Object.fromEntries(
  Object.entries(billingOperationMetadata).map(([id, operation]) => [
    id,
    {
      ...operation,
      annotations: operation.readOnly
        ? readOnly
        : {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
    },
  ]),
);
const result = (value: unknown) => ({
  structuredContent:
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { data: value },
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

const previewUri = 'ui://opengen/job-result';
const previewMimeType = 'text/html;profile=mcp-app';
const previewToolMeta = {
  ui: { resourceUri: previewUri, preferredModelDisplayMode: 'inline' },
  // Match the MCP Apps SDK's compatibility metadata for older hosts.
  'ui/resourceUri': previewUri,
};
const instructions =
  'When asked to show, play, download, or check a generation with a known job ID, first call job_get with that ID. If delivery is pending, follow the same job using call with jobs.status. Pass afterRevision from the previous status and waitMs up to 25000. When private delivery is available or partial, call job_get again to display the result card in hosts with MCP Apps. If the host cannot show a card, use the returned private URLs as Open or Download links in the authorized chat. To refresh an expired link, call job_get with the same ID. If you must respond before delivery, give the job ID and current state. For new generations, save the job ID and idempotency key. Never submit another generation to resume an existing job.';

function previewOrigins(env: NodeJS.ProcessEnv): string[] {
  if (env.S3_ENDPOINT) {
    try {
      const url = new URL(env.S3_ENDPOINT);
      return url.protocol === 'https:' && !url.username && !url.password ? [url.origin] : [];
    } catch {
      return [];
    }
  }
  const { S3_BUCKET: bucket, S3_REGION: region } = env;
  if (!bucket || !region || !/^[a-z0-9.-]+$/.test(bucket) || !/^[a-z0-9-]+$/.test(region))
    return [];
  const host = `s3.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
  return [`https://${bucket}.${host}`, `https://${host}`];
}

function jobResult(jobId: string, response: CallToolResult, origins: string[]): CallToolResult {
  if (response.isError) return response;
  const job = response.structuredContent as Partial<Job> | undefined;
  if (
    typeof job?.id !== 'string' ||
    job.id.toLowerCase() !== jobId.toLowerCase() ||
    !Array.isArray(job.outputs)
  )
    return response;
  const outputs = [];
  const delivered = job.deliveryStatus === 'available' || job.deliveryStatus === 'partial';
  const status =
    !delivered && (job.status === 'submission-unknown' || job.status === 'cancelled')
      ? job.status
      : (job.deliveryStatus ?? job.status ?? 'unavailable');
  for (const output of delivered ? job.outputs : []) {
    if (
      !['video/mp4', 'image/jpeg', 'image/png', 'image/webp'].includes(output.mediaType) ||
      !output.expiresAt ||
      !(Date.parse(output.expiresAt) > Date.now())
    )
      continue;
    try {
      const url = new URL(output.url);
      if (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        origins.includes(url.origin) &&
        url.pathname.includes(`/outputs/${job.id}/`) &&
        url.searchParams.has('X-Amz-Signature')
      )
        outputs.push({
          url: url.href,
          mediaType: output.mediaType,
          expiresAt: output.expiresAt,
        });
    } catch {
      // An invalid capability is never promoted to a link or preview.
    }
  }
  return {
    ...response,
    content: [
      ...response.content,
      ...outputs.map(({ url, mediaType }, index) => ({
        type: 'resource_link' as const,
        uri: url,
        name: `Open private ${mediaType.startsWith('video/') ? 'video' : 'image'} ${index + 1}`,
        mimeType: mediaType,
      })),
    ],
    _meta: {
      ...previewToolMeta,
      openGenPreview: {
        status,
        media: outputs,
      },
    },
  };
}

export async function registerMcp(app: FastifyInstance, context: Context) {
  const origins = previewOrigins(context.env);
  app.post('/mcp', async (request, reply) => {
    // The transport hijacks the socket, bypassing Fastify's onSend cache hook.
    reply.raw.setHeader('Cache-Control', 'no-store');
    if (context.oauthEnabled) {
      try {
        await context.authenticate(request.headers.authorization, null);
      } catch {
        return reply
          .code(401)
          .header(
            'WWW-Authenticate',
            `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource/mcp', context.publicUrl).href}", scope="read generate"`,
          )
          .send({ error: 'unauthorized' });
      }
    }
    const server = new McpServer(
      { name: 'opengen', version: '0.1.0' },
      {
        instructions,
        capabilities: {
          extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [previewMimeType] } },
        },
      },
    );
    server.registerResource(
      'Private generation result',
      previewUri,
      { mimeType: previewMimeType },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: previewMimeType,
            text: jobResultHtml,
            _meta: { ui: { csp: { resourceDomains: origins } } },
          },
        ],
      }),
    );
    const invoke = async (operationId: OperationId, input: unknown, idempotencyKey?: string) => {
      try {
        const { method, path, payload } = operationRequest(operationId, input);
        const response = await app.inject({
          method,
          url: path,
          headers: {
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
            ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
          },
          ...(payload === undefined ? {} : { payload }),
        });
        return {
          ...result(
            response.statusCode === 303
              ? { statusCode: 303, location: response.headers.location }
              : response.json(),
          ),
          ...(response.statusCode >= 400 ? { isError: true } : {}),
        };
      } catch {
        // The MCP SDK serializes thrown Error.message verbatim. Unexpected
        // transport/serialization errors must not disclose private diagnostics.
        return {
          ...result({
            error: {
              code: 'operation_failed',
              message: 'Service could not complete this request.',
            },
          }),
          isError: true,
        };
      }
    };
    server.registerTool(
      'catalog_search',
      {
        description:
          'Find exact image/video models and regional provider routes. Read-only; no generation.',
        annotations: readOnly,
        inputSchema: {
          query: z.string().max(200).default(''),
          ...catalogSearchFiltersSchema.shape,
        },
      },
      async ({ query, ...filters }) => result(searchCatalog(query, filters)),
    );
    server.registerTool(
      'catalog_get',
      {
        description:
          'Inspect a company, model series, exact variant, regional deployment or route. Models include canonical common/model-specific generationProfiles with JSON schemas, capabilities and sources. Series list variants and their separate providers; execution always uses an exact model ID.',
        annotations: readOnly,
        inputSchema: { id: z.string() },
      },
      async ({ id }) => {
        const model = catalog.models.find((item) => item.id === canonicalModelId(id));
        const series = getSeriesDetail(id);
        if (model && !series) {
          const routes = catalog.routes.filter((item) => item.modelId === model.id);
          const deploymentIds = new Set(routes.map((route) => route.deploymentId));
          return result({
            model: { ...model, generationProfiles: generationProfiles(model.id) },
            series: getSeriesForModel(model.id),
            routes,
            deployments: catalog.deployments.filter((item) => deploymentIds.has(item.id)),
          });
        }
        if (series)
          return result({
            ...series,
            models: series.models.map((model) => ({
              ...model,
              generationProfiles: generationProfiles(model.id),
            })),
          });
        const company = getCompanyDetail(id);
        if (company)
          return result({
            ...company,
            models: company.models.map((model) => ({
              ...model,
              generationProfiles: generationProfiles(model.id),
            })),
          });
        const route = catalog.routes.find((item) => item.id === id);
        const deployment = catalog.deployments.find((item) => item.id === id);
        return result(
          route
            ? {
                route,
                generationProfiles: generationProfiles(route.modelId).filter((profile) =>
                  route.operations.includes(profile.operation),
                ),
                deployment: catalog.deployments.find((item) => item.id === route.deploymentId),
              }
            : deployment
              ? {
                  deployment,
                  routes: catalog.routes.filter((item) => item.deploymentId === deployment.id),
                }
              : { error: 'not_found' },
        );
      },
    );
    server.registerTool(
      'quote',
      {
        description:
          'Compare documented estimates for an exact generation request and allowed regional routes. No credits spent.',
        annotations: readOnly,
        inputSchema: { input: generationSchema },
      },
      async ({ input }) => invoke('quotes.single', input),
    );
    server.registerTool(
      'call',
      {
        description:
          'Execute a registered OpenGen operation. media.generate is billable and requires a stable idempotencyKey. Other allowlisted operations manage private uploads, history, keys, policies, encrypted provider connections, webhooks and alerts. All use the same REST authorization; no arbitrary URL targets.' +
          (context.billingAvailable
            ? ' Delegated billing scopes and financial effects are listed in tool metadata.'
            : ''),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: context.billingAvailable ? callSchema : legacyCallSchema,
        ...(context.billingAvailable
          ? { _meta: { 'opengen/billing-operations': billingToolOperations } }
          : {}),
      },
      async (args: z.output<typeof callSchema>) => {
        // app.inject has no relationship to the outer MCP socket. Status waits
        // use the original transport so disconnect and repeated auth remain real.
        if (args.operationId === 'jobs.status') {
          try {
            return result(
              await readJobStatus(
                request,
                reply,
                context.requireEngine().jobStatus,
                () => context.authenticate(request.headers.authorization, null),
                args.input,
              ),
            );
          } catch (error) {
            const failure = error as { code?: string; statusCode?: number; message: string };
            if (failure.code === 'status_wait_aborted') throw error;
            // Match the native handler's safe error envelope while keeping the
            // original socket for disconnects and repeated authorization.
            return {
              ...result({
                error: {
                  code: failure.code ?? 'invalid_request',
                  message:
                    (failure.statusCode ?? 500) >= 500 &&
                    !['database_not_configured', 'authentication_not_configured'].includes(
                      failure.code ?? '',
                    )
                      ? 'Service could not complete this request.'
                      : failure.message,
                },
              }),
              isError: true,
            };
          }
        }
        return invoke(
          args.operationId,
          args.input,
          'idempotencyKey' in args ? args.idempotencyKey : undefined,
        );
      },
    );
    server.registerTool(
      'job_get',
      {
        description:
          'Show, play, download, or check an existing image or video generation by job ID. Call this read-only tool first when the ID is known. It displays the private result card in compatible chats and returns temporary download links. Call it with the same ID to refresh links. Never submit a new generation for an existing job.',
        annotations: readOnly,
        inputSchema: { id: z.string() },
        _meta: previewToolMeta,
      },
      async ({ id }) => jobResult(id, await invoke('jobs.get', { id }), origins),
    );
    server.registerTool(
      'job_cancel',
      {
        description:
          'Request cancellation. Only confirmed cancellation can release reserved funds; running tasks may not be cancellable.',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: { id: z.string() },
      },
      async ({ id }) => invoke('jobs.cancel', { id }),
    );
    server.registerTool(
      'balance',
      {
        description: 'Read the current workspace available and reserved USD balance.',
        annotations: readOnly,
        inputSchema: {},
      },
      async () => invoke('balance.get', {}),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.once('close', () => {
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.get('/mcp', async (_request, reply) =>
    reply.code(405).header('Allow', 'POST').send({ error: 'Use Streamable HTTP POST /mcp.' }),
  );
}
