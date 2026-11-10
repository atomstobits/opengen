import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Principal, KeyScope } from '@media-router/engine';
import type { OwnedAssetService } from '../../../packages/engine/src/owned-assets.js';

export const assetKeySchema = z.object({ key: z.string().min(1).max(300) }).strict();
export const assetUploadSchema = z
  .object({
    mediaType: z.string().min(1).max(100),
    size: z
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
  })
  .strict();
export const assetReuseSchema = z
  .object({ sourceJobId: z.uuid(), outputIndex: z.number().int().min(0).max(63) })
  .strict();
export const assetImportSchema = z
  .object({ url: z.string().min(1).max(8192), type: z.enum(['image', 'video', 'audio']) })
  .strict();
export const assetMultipartPartSchema = assetKeySchema
  .extend({ partNumber: z.number().int().min(1).max(20) })
  .strict();
export const assetMultipartCompleteSchema = assetKeySchema
  .extend({
    parts: z
      .array(
        z
          .object({ partNumber: z.number().int().min(1).max(20), etag: z.string().min(1).max(256) })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
type Assets = Pick<
  OwnedAssetService,
  | 'get'
  | 'prepareUpload'
  | 'completeUpload'
  | 'delete'
  | 'reuse'
  | 'importAsset'
  | 'prepareMultipart'
  | 'signMultipartPart'
  | 'resumeMultipart'
  | 'completeMultipart'
  | 'abortMultipart'
>;

/** Integration replaces the three legacy raw-storage routes before registering this module. */
export function registerOwnedAssetRoutes(
  app: FastifyInstance,
  options: {
    assets?: Assets;
    authenticate: (request: FastifyRequest, scope: KeyScope) => Promise<Principal>;
  },
) {
  const auth = options.authenticate;
  const store = () => {
    if (!options.assets)
      throw Object.assign(new Error('Private object storage is not configured.'), {
        code: 'storage_not_configured',
        statusCode: 503,
      });
    return options.assets;
  };
  const key = (request: FastifyRequest) => {
    const value = request.headers['idempotency-key'];
    return z.string().min(1).max(200).parse(value);
  };
  // Encapsulation is supplied by app.register at integration; do not install a global public-cache policy.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.split('?')[0]?.startsWith('/v1/assets'))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  app.post('/v1/assets', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetUploadSchema.parse(request.body);
    return store().prepareUpload(p.workspaceId, input.mediaType, input.size);
  });
  app.get('/v1/assets', async (request) => {
    const p = await auth(request, 'read');
    const input = assetKeySchema.parse(request.query);
    return store().get(p.workspaceId, input.key);
  });
  app.post('/v1/assets/complete', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetKeySchema.parse(request.body);
    return store().completeUpload(p.workspaceId, input.key);
  });
  app.delete('/v1/assets', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetKeySchema.parse(request.body);
    return store().delete(p.workspaceId, input.key);
  });
  app.post('/v1/assets/import', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetImportSchema.parse(request.body);
    return store().importAsset(p.workspaceId, input.url, input.type, key(request));
  });
  app.post('/v1/assets/reuse', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetReuseSchema.parse(request.body);
    return store().reuse(p.workspaceId, input.sourceJobId, input.outputIndex, key(request));
  });
  app.post('/v1/assets/multipart', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetUploadSchema.parse(request.body);
    return store().prepareMultipart(p.workspaceId, input.mediaType, input.size);
  });
  app.post('/v1/assets/multipart/part', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetMultipartPartSchema.parse(request.body);
    return store().signMultipartPart(p.workspaceId, input.key, input.partNumber);
  });
  app.get('/v1/assets/multipart', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetKeySchema.parse(request.query);
    return store().resumeMultipart(p.workspaceId, input.key);
  });
  app.post('/v1/assets/multipart/complete', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetMultipartCompleteSchema.parse(request.body);
    return store().completeMultipart(p.workspaceId, input.key, input.parts);
  });
  app.post('/v1/assets/multipart/abort', async (request) => {
    const p = await auth(request, 'generate');
    const input = assetKeySchema.parse(request.body);
    return store().abortMultipart(p.workspaceId, input.key);
  });
}
