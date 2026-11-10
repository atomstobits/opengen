import { jobStatusQuerySchema } from './job-status.js';
import {
  billingDocumentQuerySchema,
  billingOperationMetadata,
  billingPolicyInputSchema,
} from './billing.js';
import {
  governancePolicySchema,
  governanceKeyUpdateSchema,
  governanceKeyRotateSchema,
  governancePolicyUpdateSchema,
  governancePolicyArchiveSchema,
} from './governance.js';
import {
  assetKeySchema,
  assetUploadSchema,
  assetReuseSchema,
  assetImportSchema,
  assetMultipartPartSchema,
  assetMultipartCompleteSchema,
} from './owned-assets.js';
import { z } from 'zod';
import { feedbackInputSchema, operationTargets } from '@media-router/contracts';
import { catalogSearchQuerySchema } from '@media-router/catalog';
import { generationSchema, routingSchema } from './validation.js';
import { keyScopes, eventTypes } from '@media-router/engine';
import { compatibilityImageEditSchema } from './compatibility-input.js';
import { notificationPreferencesSchema } from './notifications.js';
import { alertSettingsSchema, webhookEditSchema } from './events.js';
import { imageSchema, videoSchema } from './compatibility.js';
import { ledgerQuerySchema, reconciliationSchema } from './operator.js';
import { teamCreateSchema, memberInviteSchema, memberRoleSchema } from './team-schemas.js';

export const modelSchemaQuerySchema = z
  .object({ modelId: generationSchema.shape.modelId, operation: generationSchema.shape.operation })
  .strict();

const keyId = z.uuid();
const name = z.string().min(1).max(80);
export const activityQuerySchema = z
  .object({
    modelId: z.string().min(1).max(200).optional(),
    providerId: z.string().min(1).max(200).optional(),
    deploymentId: z.string().min(1).max(200).optional(),
    endpointRegion: z.string().min(1).max(200).optional(),
    operation: z.string().min(1).max(200).optional(),
    keyId: z.string().min(1).max(200).optional(),
    status: z
      .enum([
        'queued',
        'submitting',
        'running',
        'submission-unknown',
        'succeeded',
        'failed',
        'cancelled',
      ])
      .optional(),
    project: z.string().min(1).max(200).optional(),
    since: z.string().max(50).optional(),
    until: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().max(2048).optional(),
  })
  .strict();
const body = <const T extends string, S extends z.ZodType>(operationId: T, input: S) =>
  z.object({ operationId: z.literal(operationId), input });
const empty = z.object({}).strict();
const namedId = z.object({ id: keyId }).strict();
const paid = <const T extends string, S extends z.ZodType>(operationId: T, input: S) =>
  z.object({
    operationId: z.literal(operationId),
    input,
    idempotencyKey: z.string().min(1).max(200),
  });
/** Explicit allowlist. No caller-controlled method, origin, headers or URL can become a proxy target. */
const coreCallOptions = [
  z.object({
    operationId: z.literal('media.generate'),
    input: generationSchema,
    idempotencyKey: z.string().min(1).max(200),
  }),
  body('catalog.list', empty),
  body('catalog.search', catalogSearchQuerySchema),
  body('doctor.get', empty),
  body('companies.list', empty),
  body('companies.get', z.object({ company: z.string().min(1).max(160) }).strict()),
  body('series.list', empty),
  body(
    'series.get',
    z.object({ company: z.string().min(1).max(160), slug: z.string().min(1).max(160) }).strict(),
  ),
  body('models.list', empty),
  body('models.schema', modelSchemaQuerySchema),
  body('providers.list', empty),
  body('deployments.list', empty),
  body('routes.list', z.object({ modelId: z.string().max(160).optional() }).strict()),
  body('metrics.list', empty),
  body('operations.list', empty),
  body('quotes.single', generationSchema),
  body('quotes.batch', z.array(generationSchema).min(1).max(20)),
  body('assets.prepare', assetUploadSchema),
  body('assets.get', assetKeySchema),
  paid('assets.import', assetImportSchema),
  paid('assets.reuse', assetReuseSchema),
  body('assets.multipart.prepare', assetUploadSchema),
  body('assets.multipart.part', assetMultipartPartSchema),
  body('assets.multipart.get', assetKeySchema),
  body('assets.multipart.complete', assetMultipartCompleteSchema),
  body('assets.multipart.abort', assetKeySchema),
  body('assets.complete', assetKeySchema),
  body('assets.delete', assetKeySchema),
  body('activity.list', activityQuerySchema),
  body('activity.analytics', activityQuerySchema.omit({ cursor: true, limit: true })),
  body(
    'notifications.list',
    z
      .object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(2048).optional(),
        unreadOnly: z.boolean().optional(),
      })
      .strict(),
  ),
  body('notifications.preferences.get', empty),
  body('notifications.preferences.put', notificationPreferencesSchema),
  body('notifications.read', namedId),
  body('jobs.list', z.object({}).strict()),
  body('jobs.get', namedId),
  body('jobs.status', jobStatusQuerySchema),
  body('jobs.lookup', z.object({ idempotencyKey: z.string().min(1).max(200) }).strict()),
  body('jobs.cancel', namedId),
  body('balance.get', empty),
  body('feedback.submit', feedbackInputSchema),
  body('feedback.get', namedId),
  body('catalog.request', feedbackInputSchema.extend({ kind: z.literal('catalog-request') })),
  body('ledger.list', ledgerQuerySchema),
  body('ledger.export', ledgerQuerySchema.extend({ format: z.literal('json').default('json') })),
  body(
    'operator.inspect',
    z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), id: keyId }).strict(),
  ),
  body(
    'operator.reconcile',
    reconciliationSchema.extend({
      workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
      id: keyId,
    }),
  ),
  body(
    'operator.reconciliations',
    z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), id: keyId }).strict(),
  ),
  body('keys.governance', empty),
  body('keys.update', governanceKeyUpdateSchema.safeExtend({ id: keyId })),
  body('keys.rotate', governanceKeyRotateSchema.extend({ id: keyId })),
  body('policies.governance', z.object({ includeArchived: z.boolean().optional() }).strict()),
  body('policies.update', governancePolicyUpdateSchema.safeExtend({ id: keyId })),
  body('policies.archive', governancePolicyArchiveSchema.extend({ id: keyId })),
  body('keys.list', z.object({}).strict()),
  body(
    'keys.create',
    z
      .object({
        name,
        scopes: z.array(z.enum(keyScopes)).min(1),
        policyId: keyId.optional(),
        expiresAt: z.iso.datetime().optional(),
        monthlyCapMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
  ),
  body('keys.revoke', z.object({ id: keyId }).strict()),
  body('policies.list', z.object({}).strict()),
  body(
    'policies.create',
    z
      .object({
        name,
        policy: governancePolicySchema,
        maxCostMicros: z.number().int().nonnegative().optional(),
      })
      .strict(),
  ),
  body('connections.list', z.object({}).strict()),
  body(
    'connections.put',
    z
      .object({
        deploymentId: z.string().min(1).max(200),
        apiKey: z.string().min(1).max(2000),
        workspaceId: z.string().optional(),
      })
      .strict(),
  ),
  body('connections.delete', z.object({ deploymentId: z.string().min(1).max(200) }).strict()),
  body('webhooks.list', z.object({}).strict()),
  body(
    'webhooks.create',
    z.object({ name, url: z.url(), eventTypes: z.array(z.enum(eventTypes)).min(1) }).strict(),
  ),
  body('webhooks.deliveries', z.object({}).strict()),
  body('alerts.list', z.object({}).strict()),
  body('alerts.settings.get', empty),
  body('alerts.settings.put', alertSettingsSchema),
  body('webhooks.update', webhookEditSchema.safeExtend({ id: keyId })),
  body('webhooks.rotate', namedId),
  body('workspaces.list', empty),
  body('teams.create', teamCreateSchema),
  body('members.list', empty),
  body('members.invite', memberInviteSchema),
  body('members.update', memberRoleSchema.extend({ id: keyId })),
  body('members.remove', namedId),
  body(
    'workspaces.acceptInvite',
    z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/) }).strict(),
  ),
  body(
    'workspaces.create',
    z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        openingBalanceMicros: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .optional(),
      })
      .strict(),
  ),
  body(
    'workspaces.credit',
    z
      .object({
        id: z.string().min(1).max(80),
        amountMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        reference: z.string().min(1).max(200),
      })
      .strict(),
  ),
  paid('images.generate', imageSchema),
  paid('images.edit', compatibilityImageEditSchema),
  paid('videos.create', videoSchema),
  body('videos.get', namedId),
  body('videos.content', namedId),
] as const;
const billingCallOptions = [
  body('billing.policy.get', empty).describe(
    billingOperationMetadata['billing.policy.get'].description,
  ),
  body('billing.policy.update', billingPolicyInputSchema.omit({ consentReference: true })).describe(
    billingOperationMetadata['billing.policy.update'].description,
  ),
  body('billing.recharges.list', empty).describe(
    billingOperationMetadata['billing.recharges.list'].description,
  ),
  body('billing.documents.list', billingDocumentQuerySchema).describe(
    billingOperationMetadata['billing.documents.list'].description,
  ),
] as const;
export const legacyCallSchema = z.discriminatedUnion('operationId', coreCallOptions);
export const callSchema = z.discriminatedUnion('operationId', [
  ...coreCallOptions,
  ...billingCallOptions,
]);
export { operationTargets, operationRequest } from '@media-router/contracts';

export function billingOperationDetails(id: string) {
  return Object.hasOwn(billingOperationMetadata, id)
    ? billingOperationMetadata[id as keyof typeof billingOperationMetadata]
    : undefined;
}

export function describeOperations(billingAvailable = false) {
  return Object.entries(operationTargets).flatMap(([id, target]) => {
    const billing = billingOperationDetails(id);
    if (billing && !billingAvailable) return [];
    return [{ id, ...target, ...billing }];
  });
}

export const publicOperationIds = new Set<string>([
  'catalog.list',
  'catalog.search',
  'companies.list',
  'companies.get',
  'series.list',
  'series.get',
  'models.list',
  'models.schema',
  'providers.list',
  'deployments.list',
  'routes.list',
  'metrics.list',
  'operations.list',
  'quotes.single',
  'quotes.batch',
]);
export const idempotentOperationIds = new Set<string>([
  'media.generate',
  'assets.import',
  'assets.reuse',
  'images.generate',
  'images.edit',
  'videos.create',
]);
export const operatorOperationIds = new Set<string>([
  'workspaces.create',
  'workspaces.credit',
  'operator.inspect',
  'operator.reconcile',
  'operator.reconciliations',
]);
