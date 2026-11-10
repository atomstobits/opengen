import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { constrainInput, type Principal, type KeyScope } from '@media-router/engine';
import type { GenerateInput, Job } from '@media-router/contracts';
import type { EngineLike } from './app.js';
import {
  compatibilityImageGenerationSchema,
  compatibilityEditMultipartLimit,
  parseCompatibilityImageGeneration,
  parseCompatibilityImageEdit,
  parseCompatibilityEditMultipart,
  type CompatibilityImageRequest,
} from './compatibility-input.js';
import { imageBase64, ownedVideoContent, type OwnedOutputJob } from './compatibility-media.js';

interface Context {
  authenticate(request: FastifyRequest, scope?: KeyScope): Promise<Principal>;
  requireEngine(): EngineLike;
  parseInput(input: unknown): GenerateInput;
}
// Integration injects private read access; customer jobs never regain object keys.
type OutputEngine = EngineLike & {
  ownedOutputAccess?: {
    getOwnedOutputJob(workspaceId: string, jobId: string): Promise<OwnedOutputJob | null>;
  };
};
async function privateOutputJob(engine: EngineLike, workspaceId: string, jobId: string) {
  const job = await (engine as OutputEngine).ownedOutputAccess?.getOwnedOutputJob(
    workspaceId,
    jobId,
  );
  if (!job)
    throw Object.assign(new Error('Owned output read access is unavailable.'), { statusCode: 409 });
  return job;
}
const mode = z.enum(['managed', 'byok']).optional();
const cap = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional();
const extension = { billing: mode, route_id: z.string().max(200).optional(), max_cost_micros: cap };
export const imageSchema = compatibilityImageGenerationSchema;
export const videoSchema = z
  .object({
    model: z.string(),
    prompt: z.string().min(1),
    seconds: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
    size: z.enum(['1280x720', '720x1280', '1920x1080', '1080x1920', '854x480', '480x854']),
    ...extension,
  })
  .strict();
// `available` is issued by the engine only after owned archival and authorized URL
// issuance. Private storage keys may be omitted by that customer projection.
type DeliveryStatus = 'pending' | 'available' | 'partial' | 'failed' | 'expired' | 'unverified';
function delivery(value: Job) {
  const outputs = value.outputs.filter((output) => {
    const mediaPrefix = value.input.operation.includes('video') ? 'video/' : 'image/';
    if (!output.mediaType.startsWith(mediaPrefix)) return false;
    if (output.storageKey && !output.storageKey.startsWith(`outputs/${value.id}/`)) return false;
    try {
      const url = new URL(output.url);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        (!output.expiresAt ||
          (Number.isFinite(Date.parse(output.expiresAt)) &&
            Date.parse(output.expiresAt) > Date.now()))
      );
    } catch {
      return false;
    }
  });
  const declared = value.deliveryStatus as DeliveryStatus | undefined;
  const status: DeliveryStatus =
    value.status !== 'succeeded'
      ? 'pending'
      : declared === 'available'
        ? outputs.length === value.outputs.length && outputs.length > 0
          ? 'available'
          : value.outputs.some(
                (output) => output.expiresAt && Date.parse(output.expiresAt) <= Date.now(),
              )
            ? 'expired'
            : 'failed'
        : (declared ?? 'unverified');
  return { status, outputs: ['available', 'partial'].includes(status) ? outputs : [] };
}
function recovery(value: Job, status: DeliveryStatus) {
  return value.status === 'submission-unknown'
    ? 'operator'
    : value.status === 'failed' || value.status === 'cancelled'
      ? 'none'
      : ['pending', 'partial'].includes(status)
        ? 'same_job'
        : status === 'available'
          ? 'none'
          : 'operator';
}
function metadata(value: Job, status: DeliveryStatus) {
  return {
    job_id: value.id,
    status: value.status,
    delivery_status: status,
    recovery: recovery(value, status),
    poll_url: `/v1/generations/${value.id}`,
    ...(value.status === 'submission-unknown'
      ? {
          requires_reconciliation: true,
          notice: 'Provider acceptance is unknown. Do not submit another paid generation.',
        }
      : {}),
    route_id: value.routeId,
    deployment_id: value.deploymentId,
    reserved_micros: value.reservedMicros,
    settled_micros: value.settledMicros,
  };
}
function deliveryError(status: DeliveryStatus) {
  return {
    code: status === 'expired' ? 'output_expired' : 'output_delivery_unavailable',
    message:
      status === 'expired'
        ? 'Output delivery has expired. Inspect the existing job; do not create a replacement generation.'
        : 'Output is not available. Inspect the existing job; do not create a replacement generation.',
  };
}
function video(value: Job) {
  const retained = delivery(value);
  const terminalDelivery = ['failed', 'expired', 'unverified'].includes(retained.status);
  const generationFailed = ['failed', 'cancelled'].includes(value.status);
  return {
    id: value.id,
    object: 'video',
    model: value.input.modelId,
    status:
      value.status === 'succeeded' && retained.status === 'available'
        ? 'completed'
        : generationFailed || (value.status === 'succeeded' && terminalDelivery)
          ? 'failed'
          : value.status === 'queued'
            ? 'queued'
            : 'in_progress',
    created_at: Math.floor(Date.parse(value.createdAt) / 1000),
    seconds: String(value.input.input.duration),
    error: generationFailed
      ? { code: 'generation_failed', message: 'Generation did not complete.' }
      : value.status === 'succeeded' && terminalDelivery
        ? deliveryError(retained.status)
        : null,
    opengen: metadata(value, retained.status),
  };
}
export async function registerCompatibility(app: FastifyInstance, context: Context) {
  const reauthorize = async (request: FastifyRequest, owner: Principal, scope: KeyScope) => {
    const current = await context.authenticate(request, scope);
    if (current.workspaceId !== owner.workspaceId)
      throw Object.assign(new Error('Authorization workspace changed.'), {
        statusCode: 403,
        code: 'policy_denied',
      });
  };
  const submit = async (request: FastifyRequest, input: GenerateInput) => {
    const principal = await context.authenticate(request, 'generate');
    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || !idempotencyKey || idempotencyKey.length > 200)
      throw Object.assign(new Error('A stable Idempotency-Key header is required.'), {
        statusCode: 400,
        code: 'idempotency_key_required',
      });
    return {
      job: (await context.requireEngine().submit({
        workspaceId: principal.workspaceId,
        idempotencyKey,
        input: context.parseInput(input),
        principal,
      })) as Job,
      principal,
    };
  };
  const imageResponse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    parsed: CompatibilityImageRequest,
  ) => {
    let { job, principal: owner } = await submit(request, parsed.input);
    const deadline = Date.now() + 25_000;
    while (
      !['succeeded', 'failed', 'cancelled', 'submission-unknown'].includes(job.status) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Admission/imports and the wait can outlive the original authority.
      await reauthorize(request, owner, 'generate');
      job = (await context.requireEngine().getJob(owner.workspaceId, job.id)) as Job;
    }
    await reauthorize(request, owner, 'generate');
    const retained = delivery(job);
    reply.header('Cache-Control', 'no-store');
    reply.header('Location', `/v1/generations/${job.id}`);
    if (job.status === 'succeeded' && retained.status === 'available') {
      let data: ({ url: string } | { b64_json: string })[];
      try {
        data =
          parsed.responseFormat === 'b64_json'
            ? [
                await imageBase64(
                  await privateOutputJob(context.requireEngine(), owner.workspaceId, job.id),
                  context.requireEngine().storage,
                ),
              ]
            : retained.outputs.map((output) => ({ url: output.url }));
      } catch (error) {
        await reauthorize(request, owner, 'generate');
        const e = error as { statusCode?: number; code?: string };
        // Representation failure must retain the charged job and safe recovery metadata.
        return reply.code(e.statusCode === 413 ? 413 : 409).send({
          error: {
            code: e.statusCode === 413 ? 'response_too_large' : 'output_unavailable',
            message:
              'This response format is unavailable. Retrieve the existing job for URL delivery.',
          },
          opengen: { ...metadata(job, retained.status), recovery: 'same_job' },
        });
      }
      // Owned byte retrieval is also bounded asynchronous work. Keep this
      // outside representation error handling so revoked auth remains 401/403.
      await reauthorize(request, owner, 'generate');
      return {
        created: Math.floor(Date.parse(job.createdAt) / 1000),
        data,
        opengen: metadata(job, retained.status),
      };
    }
    if (job.status === 'failed' || job.status === 'cancelled')
      return reply.code(422).send({
        error: {
          code: 'generation_failed',
          message: 'Generation did not complete.',
        },
        opengen: metadata(job, retained.status),
      });
    if (job.status === 'succeeded' && ['failed', 'expired', 'unverified'].includes(retained.status))
      return reply.code(409).send({
        error: deliveryError(retained.status),
        opengen: metadata(job, retained.status),
      });
    // Delivery retries and slow upstream work retain the original job and reservation.
    return reply
      .code(202)
      .header('Location', `/v1/generations/${job.id}`)
      .send({
        id: job.id,
        object: 'generation',
        status: job.status,
        opengen: metadata(job, retained.status),
      });
  };
  app.post('/v1/images/generations', async (request, reply) =>
    imageResponse(
      request,
      reply,
      parseCompatibilityImageGeneration(request.body, context.parseInput),
    ),
  );
  app.addContentTypeParser(
    /^multipart\/form-data(?:\s*;.*)?$/i,
    { parseAs: 'buffer', bodyLimit: compatibilityEditMultipartLimit },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/v1/images/edits',
    { bodyLimit: compatibilityEditMultipartLimit },
    async (request, reply) => {
      const parsed = Buffer.isBuffer(request.body)
        ? await parseCompatibilityEditMultipart(
            request.body,
            request.headers['content-type'] ?? '',
            context.parseInput,
          )
        : parseCompatibilityImageEdit(request.body, context.parseInput);
      return imageResponse(request, reply, parsed);
    },
  );
  app.post('/v1/videos', async (request, reply) => {
    const body = videoSchema.parse(request.body);
    const [width, height] = body.size.split('x').map(Number);
    const max = Math.max(width!, height!);
    const { job } = await submit(request, {
      modelId: body.model,
      operation: 'text-to-video',
      input: {
        prompt: body.prompt,
        resolution: max === 1920 ? '1080p' : max === 1280 ? '720p' : '480p',
        aspectRatio: width! > height! ? '16:9' : '9:16',
        duration: Number(body.seconds),
      },
      billing: body.billing,
      routeId: body.route_id,
      maxCostMicros: body.max_cost_micros,
    });
    return reply
      .code(202)
      .header('Cache-Control', 'no-store')
      .header('Location', `/v1/videos/${job.id}`)
      .send(video(job));
  });
  app.get<{ Params: { id: string } }>('/v1/videos/:id', async (request, reply) => {
    const owner = await context.authenticate(request);
    const job = (await context
      .requireEngine()
      .getJob(owner.workspaceId, request.params.id)) as Job | null;
    if (!job || !job.input.operation.includes('video'))
      return reply.code(404).send({ error: { code: 'not_found', message: 'Video not found.' } });
    await reauthorize(request, owner, 'read');
    reply.header('Cache-Control', 'no-store');
    return video(job);
  });
  app.get<{ Params: { id: string } }>('/v1/videos/:id/content', async (request, reply) => {
    const owner = await context.authenticate(request);
    const job = (await context
      .requireEngine()
      .getJob(owner.workspaceId, request.params.id)) as Job | null;
    if (!job || !job.input.operation.includes('video'))
      return reply.code(404).send({ error: { code: 'not_found', message: 'Video not found.' } });
    await reauthorize(request, owner, 'read');
    reply.header('Cache-Control', 'no-store');
    reply.header('Location', `/v1/generations/${job.id}`);
    const retained = delivery(job);
    if (job.status !== 'succeeded' || retained.status !== 'available')
      return reply.code(409).send({
        error: { code: 'not_ready', message: 'Video output is not available.' },
        opengen: metadata(job, retained.status),
      });
    if (request.headers.range !== undefined) {
      let content: Awaited<ReturnType<typeof ownedVideoContent>>;
      try {
        content = await ownedVideoContent(
          await privateOutputJob(context.requireEngine(), owner.workspaceId, job.id),
          request.headers.range,
          context.requireEngine().storage,
          request.headers['if-range']?.toString(),
        );
      } catch (error) {
        await reauthorize(request, owner, 'read');
        const e = error as { statusCode?: number; contentRange?: string };
        if (e.statusCode === 416 && e.contentRange) {
          return reply
            .code(416)
            .header('Content-Range', e.contentRange)
            .send({
              error: {
                code: 'range_not_satisfiable',
                message: 'Requested byte range is not satisfiable.',
              },
              opengen: metadata(job, retained.status),
            });
        }
        return reply.code(e.statusCode === 413 ? 413 : 409).send({
          error: {
            code: 'output_unavailable',
            message: 'Owned video bytes are unavailable. Retrieve the existing job.',
          },
          opengen: { ...metadata(job, retained.status), recovery: 'same_job' },
        });
      }
      await reauthorize(request, owner, 'read');
      return reply.code(content.statusCode).headers(content.headers).send(content.bytes);
    }
    // No Range: preserve the structured capability redirect used by MCP videos.content.
    return reply.redirect(retained.outputs[0]!.url, 303);
  });
}
