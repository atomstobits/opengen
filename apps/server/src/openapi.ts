import { billingPolicyInputSchema } from './billing.js';
import { z } from 'zod';
import { generationSchema } from './validation.js';
import {
  operationTargets,
  callSchema,
  billingOperationDetails,
  publicOperationIds,
  idempotentOperationIds,
  operatorOperationIds,
} from './operations.js';
import { ledgerQuerySchema } from './operator.js';
import { sessionWorkspaceSchema } from './team-schemas.js';
import { comparisonQuoteRequestSchema } from './comparison.js';
import {
  compatibilityImageEditSchema,
  compatibilityEditMultipartLimit,
} from './compatibility-input.js';

type Schema = Record<string, unknown>;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const array = (items: Schema) => ({ type: 'array', items });
const object = (
  properties: Record<string, Schema>,
  required: string[] = Object.keys(properties),
): Schema => ({ type: 'object', properties, required });
const string = { type: 'string' },
  integer = { type: 'integer' },
  money = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableMoney = { ...money, type: ['integer', 'null'] };
const envelope = (items: Schema) => object({ data: array(items) });
const operationSummaries: Record<string, string> = {
  'catalog.list': 'Read the model and route catalog',
  'catalog.search': 'Search exact models and regional routes',
  'models.list': 'List exact model variants',
  'models.schema': 'Inspect effective model inputs',
  'routes.list': 'List documented regional routes',
  'operations.list': 'List registered operations',
  'quotes.single': 'Quote one canonical request',
  'quotes.batch': 'Quote several canonical requests',
  'media.generate': 'Submit one generation',
  'assets.prepare': 'Prepare a private upload',
  'assets.complete': 'Complete a private upload',
  'assets.get': 'Inspect an owned asset',
  'assets.reuse': 'Reuse an owned output as input',
  'jobs.list': 'List private generation jobs',
  'jobs.lookup': 'Recover a job by its idempotency key',
  'jobs.status': 'Wait for a private job status revision',
  'jobs.get': 'Read a private job and refresh delivery links',
  'jobs.cancel': 'Request cancellation of an existing job',
  'doctor.get': 'Diagnose configured access and execution',
  'images.generate': 'Generate an image with compatibility inputs',
  'images.edit': 'Edit owned image references with compatibility inputs',
  'videos.create': 'Submit a video with compatibility inputs',
  'videos.get': 'Read a private compatibility video',
  'videos.content': 'Retrieve owned video content',
};
const billingPolicyProperties = z.toJSONSchema(billingPolicyInputSchema.shape.policy)
  .properties as Record<string, Schema>;
const billingVersion = { type: 'integer', minimum: 1, maximum: 2147483647 };
const billingPolicy = {
  ...object({
    ...billingPolicyProperties,
    workspaceId: string,
    version: { ...billingVersion, minimum: 0 },
    ownerAuthorityVersion: { ...billingVersion, type: ['integer', 'null'] },
    updatedAt: { type: ['string', 'null'], format: 'date-time' },
  }),
  additionalProperties: false,
};
const billingRechargeAttempt = {
  ...object({
    id: { type: 'string', format: 'uuid' },
    workspaceId: string,
    policyVersion: billingVersion,
    amountCents: billingPolicyProperties.amountCents!,
    admissionMonth: { type: 'string', format: 'date' },
    status: {
      enum: [
        'queued',
        'submitting',
        'unknown',
        'processing',
        'requires_authentication',
        'review',
        'succeeded',
        'failed',
        'cancelled',
      ],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    creditedAt: { type: ['string', 'null'], format: 'date-time' },
    failureCode: { type: ['string', 'null'] },
  }),
  additionalProperties: false,
};
const billingDocument = {
  ...object({
    type: { enum: ['receipt', 'invoice'] },
    id: string,
    amountCents: { type: 'integer', minimum: 0, maximum: 2147483647 },
    currency: string,
    status: string,
    createdAt: { type: 'string', format: 'date-time' },
    url: { type: ['string', 'null'], format: 'uri' },
    pdfUrl: { type: ['string', 'null'], format: 'uri' },
  }),
  additionalProperties: false,
};
const balance = object({
  availableMicros: money,
  reservedMicros: money,
  currency: { const: 'USD' },
});
const jobProgress: Schema = {
  type: ['object', 'null'],
  properties: {
    phase: { enum: ['queued', 'submitting', 'running', 'delivery', 'complete'] },
    percent: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    source: { enum: ['provider', 'gateway'] },
    observedAt: { type: 'string', format: 'date-time' },
    providerPhase: { enum: ['queued', 'processing', null] },
    queuePosition: { type: ['integer', 'null'], minimum: 0 },
  },
  required: ['phase', 'percent', 'source', 'observedAt'],
  additionalProperties: false,
};
const structuredJobError: Schema = {
  type: ['object', 'null'],
  properties: {
    code: string,
    category: { enum: ['invalid_input', 'policy', 'technical', 'unknown'] },
    message: string,
    retryable: { type: 'boolean' },
    recovery: { enum: ['same_job', 'edit_request', 'operator', 'none'] },
    field: string,
    providerCode: string,
  },
  required: ['code', 'category', 'message', 'retryable', 'recovery'],
  additionalProperties: false,
};
const feeTermsProperties = {
  policyId: string,
  policyVersion: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  service: { enum: ['direct', 'smart'] },
  basisPoints: { type: 'integer', minimum: 0, maximum: 10_000 },
};
const generationFeeView = {
  oneOf: [
    object({ ...feeTermsProperties, costStatus: { const: 'pending' } }),
    object({
      ...feeTermsProperties,
      costStatus: { enum: ['verified', 'no-upstream-charge'] },
      providerCostMicros: money,
      customerProviderDebitMicros: money,
      nominalFeeMicros: money,
      collectedFeeMicros: money,
      waivedFeeMicros: money,
      operatorOverrunMicros: money,
      customerTotalMicros: money,
    }),
  ],
};
const job = object(
  {
    id: { type: 'string', format: 'uuid' },
    workspaceId: string,
    status: {
      enum: [
        'queued',
        'submitting',
        'running',
        'submission-unknown',
        'succeeded',
        'failed',
        'cancelled',
      ],
    },
    input: ref('GenerateInput'),
    routeId: string,
    deploymentId: string,
    upstreamId: {
      type: 'null',
      description: 'Provider task identifiers remain private recovery data.',
    },
    outputs: array(ref('OutputAsset')),
    error: { type: ['string', 'null'] },
    progress: jobProgress,
    structuredError: structuredJobError,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    reservedMicros: money,
    settledMicros: nullableMoney,
    billing: generationFeeView,
    attemptCount: { type: 'integer', minimum: 0 },
    attribution: {
      type: ['object', 'null'],
      properties: {
        kind: { enum: ['api', 'browser', 'oauth', 'bootstrap', 'unknown'] },
        ...Object.fromEntries(
          ['keyId', 'membershipId', 'grantId', 'clientId'].map((name) => [
            name,
            { type: ['string', 'null'] },
          ]),
        ),
      },
      additionalProperties: false,
    },
    metadata: object(
      {
        project: { type: 'string', maxLength: 80 },
        tags: {
          type: 'object',
          maxProperties: 16,
          additionalProperties: { type: 'string', maxLength: 160 },
        },
      },
      [],
    ),
    outputEvidence: array({
      type: 'object',
      description:
        'Bounded private per-file inspection/conformance summary; not a model-origin or moderation guarantee. ' +
        'index identifies the original receipt slot; outputIndex points into the current customer outputs array or is null.',
    }),
    deliveryStatus: {
      enum: ['pending', 'available', 'partial', 'failed', 'expired', 'unverified'],
    },
    deliveryErrors: array(object({ index: integer, code: string })),
  },
  [
    'id',
    'workspaceId',
    'status',
    'input',
    'routeId',
    'deploymentId',
    'upstreamId',
    'outputs',
    'error',
    'createdAt',
    'updatedAt',
    'reservedMicros',
    'settledMicros',
    'attemptCount',
  ],
);
const compactStatus = object({
  id: { type: 'string', format: 'uuid' },
  status: job.properties ? (job.properties as Record<string, Schema>).status! : string,
  deliveryStatus: { enum: ['pending', 'available', 'partial', 'failed', 'expired', 'unverified'] },
  routeId: string,
  deploymentId: string,
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
  reservedMicros: money,
  settledMicros: nullableMoney,
  revision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  progress: jobProgress,
  structuredError: structuredJobError,
  timings: {
    type: ['object', 'null'],
    properties: Object.fromEntries(
      ['queue', 'execution', 'delivery', 'endToEnd', 'firstPreview'].map((name) => [
        name,
        {
          type: ['object', 'null'],
          properties: {
            durationMs: { type: 'integer', minimum: 0 },
            source: { enum: ['provider', 'gateway'] },
            observedAt: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
      ]),
    ),
    additionalProperties: false,
  },
});
const routeMetrics = object(
  {
    routeId: string,
    sampleCount: {
      type: 'integer',
      minimum: 0,
      description: 'Provider-attempt observations, distinct from final-job delivery.',
    },
    succeeded: { type: 'integer', minimum: 0 },
    failed: { type: 'integer', minimum: 0 },
    unresolved: { type: 'integer', minimum: 0 },
    unclassifiedFailures: { type: 'integer', minimum: 0 },
    technicalOutcomeCount: { type: 'integer', minimum: 0 },
    technicalSuccessRate: {
      type: ['number', 'null'],
      minimum: 0,
      maximum: 1,
      description:
        'Provider-attempt technical success only; excludes output delivery and overall job outcome.',
    },
    ...Object.fromEntries(
      [
        'p50CompletionMs',
        'p75CompletionMs',
        'p90CompletionMs',
        'p95CompletionMs',
        'p99CompletionMs',
      ].map((name) => [
        name,
        {
          type: ['number', 'null'],
          minimum: 0,
          description:
            'Observed successful provider-attempt completion latency, independent of delivery.',
        },
      ]),
    ),
    jobSampleCount: {
      type: 'integer',
      minimum: 0,
      description: 'Final-route jobs admitted within the window, separate from provider attempts.',
    },
    deliveryAvailableJobCount: {
      type: 'integer',
      minimum: 0,
      description: 'Upstream-succeeded jobs with all current owned output receipts available.',
    },
    deliveryFailedJobCount: {
      type: 'integer',
      minimum: 0,
      description: 'Upstream-succeeded jobs whose delivery is failed or expired.',
    },
    deliveryUnresolvedJobCount: {
      type: 'integer',
      minimum: 0,
      description:
        'Upstream-succeeded jobs not fully confirmed available, including pending, partial and legacy unverified delivery.',
    },
    endToEndSampleCount: {
      type: 'integer',
      minimum: 0,
      description:
        'Receipt-confirmed available delivery with a recorded finite nonnegative creation-to-delivery span.',
    },
    p50EndToEndMs: {
      type: ['number', 'null'],
      minimum: 0,
      description:
        'Job creation to recorded available owned delivery; null without qualified delivery timing. Provider completion is never substituted.',
    },
    p95EndToEndMs: {
      type: ['number', 'null'],
      minimum: 0,
      description:
        'Job creation to recorded available owned delivery; null without qualified delivery timing.',
    },
    trafficProvenance: {
      const: 'mixed-unclassified',
      description:
        'No trusted customer/internal/benchmark traffic-kind assignment is inferred from actor or project.',
    },
    configuration: object(
      {
        operation: string,
        resolution: string,
        duration: { oneOf: [{ type: 'number' }, { const: 'auto' }] },
      },
      ['operation'],
    ),
    window: string,
    benchmarkOrigin: {
      type: 'string',
      description: 'Configured measurement origin/region, not a benchmark-traffic classification.',
    },
  },
  [
    'routeId',
    'sampleCount',
    'succeeded',
    'failed',
    'unresolved',
    'unclassifiedFailures',
    'technicalSuccessRate',
    'p50CompletionMs',
    'p75CompletionMs',
    'p90CompletionMs',
    'p95CompletionMs',
    'p99CompletionMs',
    'window',
    'benchmarkOrigin',
  ],
);
const quote = object(
  {
    modelId: string,
    operation: string,
    candidates: array(ref('QuoteCandidate')),
    selectedRouteId: { type: ['string', 'null'] },
    estimateOnly: { const: true },
    notices: array(string),
    reservationMicros: nullableMoney,
    billing: object(feeTermsProperties),
  },
  ['modelId', 'operation', 'candidates', 'selectedRouteId', 'estimateOnly', 'notices'],
);

const boolean = { type: 'boolean' };
const generationProfile = object({
  modelId: string,
  operation: z.toJSONSchema(generationSchema.shape.operation),
  modality: { enum: ['image', 'video'] },
  commonArguments: array(string),
  modelSpecificArguments: array(string),
  defaults: ref('GenerationArguments'),
  capabilities: object(
    {
      resolutions: array(string),
      aspectRatios: array(string),
      duration: object({
        minimum: { type: 'number' },
        maximum: { type: 'number' },
        integer: boolean,
        auto: boolean,
      }),
      references: object(
        {
          types: array({ enum: ['image', 'video', 'audio', 'document'] }),
          maximum: {
            type: 'object',
            properties: Object.fromEntries(
              ['image', 'video', 'audio', 'document'].map((type) => [
                type,
                { type: 'integer', minimum: 0 },
              ]),
            ),
            additionalProperties: false,
          },
          totalMaximum: { type: 'integer', minimum: 0 },
        },
        ['types', 'maximum'],
      ),
      frames: object({
        first: boolean,
        last: boolean,
        lastOnly: boolean,
        keyframesMaximum: { type: 'integer', minimum: 0 },
        timed: boolean,
      }),
      frameReferenceMix: boolean,
      audio: { enum: ['switchable', 'always-on', 'unsupported', 'unverified'] },
      quality: array(string),
      countMaximum: { type: 'integer', minimum: 1 },
    },
    [
      'resolutions',
      'aspectRatios',
      'references',
      'frames',
      'frameReferenceMix',
      'audio',
      'countMaximum',
    ],
  ),
  promptRequired: boolean,
  promptMaximum: { type: ['integer', 'null'] },
  verification: { enum: ['documented', 'model-guided-partial', 'weights-only'] },
  sources: array(ref('Source')),
  notices: array(string),
  examples: object({
    request: ref('GenerateInput'),
    quote: object({ operationId: { const: 'quotes.single' }, input: ref('GenerateInput') }),
    cli: string,
    placeholders: array(string),
    notices: array(string),
  }),
  inputSchema: {
    type: 'object',
    additionalProperties: true,
    description:
      'JSON Schema for the native generation request input object. It narrows common and model-specific fields for this exact variant and operation. Route/provider restrictions may narrow it further; documented support is not live execution availability.',
  },
});
const catalogModel = object(
  { id: string, name: string, generationProfiles: array(ref('GenerationProfile')) },
  ['id', 'generationProfiles'],
);

function responseSchema(id: string): Schema {
  if (id === 'billing.policy.get')
    return {
      ...object({
        workspaceId: string,
        policy: ref('BillingPolicy'),
        ownerAuthorityVersion: billingVersion,
        mandate: {
          type: ['object', 'null'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            status: { enum: ['active', 'revoked'] },
          },
          required: ['id', 'status'],
          additionalProperties: false,
        },
        automaticRechargeAvailable: { type: 'boolean' },
        setupAvailable: { type: 'boolean' },
        portalAvailable: { type: 'boolean' },
        recoveryAvailable: { type: 'boolean' },
        terms: {
          ...object({ version: string, text: string }),
          type: ['object', 'null'],
          additionalProperties: false,
        },
      }),
      additionalProperties: false,
    };
  if (id === 'billing.policy.update')
    return {
      ...object({ workspaceId: string, policy: ref('BillingPolicy') }),
      additionalProperties: false,
    };
  if (id === 'billing.recharges.list')
    return {
      ...object({
        workspaceId: string,
        data: { ...array(ref('BillingRechargeAttempt')), maxItems: 100 },
      }),
      additionalProperties: false,
    };
  if (id === 'billing.documents.list')
    return {
      ...object({
        workspaceId: string,
        data: { ...array(ref('BillingDocument')), maxItems: 100 },
        nextCursor: { type: ['string', 'null'] },
      }),
      additionalProperties: false,
    };
  if (id === 'operator.inspect')
    return {
      ...job,
      properties: {
        ...(job.properties as Record<string, Schema>),
        upstreamId: {
          type: ['string', 'null'],
          description: 'Installation operator only: original provider task identity.',
        },
      },
    };
  if (id === 'jobs.status')
    return object({
      job: compactStatus,
      changed: { type: 'boolean' },
      timedOut: { type: 'boolean' },
    });
  if (
    [
      'media.generate',
      'jobs.get',
      'jobs.lookup',
      'jobs.cancel',
      'operator.inspect',
      'operator.reconcile',
    ].includes(id)
  )
    return ref('Job');
  if (id === 'doctor.get') return ref('DoctorReport');
  if (id === 'jobs.list') return array(ref('Job'));
  if (id === 'metrics.list') return envelope(routeMetrics);
  if (id === 'quotes.single') return ref('Quote');
  if (id === 'quotes.batch') return envelope(ref('Quote'));
  if (id === 'balance.get' || id === 'workspaces.create' || id === 'workspaces.credit')
    return ref('Balance');
  if (
    [
      'assets.complete',
      'assets.get',
      'assets.import',
      'assets.reuse',
      'assets.multipart.complete',
    ].includes(id)
  )
    return ref('OwnedAsset');
  if (id === 'assets.delete' || id === 'assets.multipart.abort')
    return object({ state: { const: 'deleted' }, inUse: { type: 'boolean' } });
  if (id === 'assets.multipart.prepare')
    return object({
      key: string,
      partSize: { type: 'integer', minimum: 1, maximum: 100 * 1024 * 1024 },
      partCount: { type: 'integer', minimum: 1, maximum: 20 },
    });
  if (id === 'assets.multipart.part')
    return object({
      partNumber: { type: 'integer', minimum: 1, maximum: 20 },
      size: { type: 'integer', minimum: 1, maximum: 100 * 1024 * 1024 },
      uploadUrl: { type: 'string', format: 'uri' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      expiresAt: { type: 'string', format: 'date-time' },
    });
  if (id === 'assets.multipart.get')
    return {
      type: 'array',
      maxItems: 20,
      items: object({
        partNumber: { type: 'integer', minimum: 1, maximum: 20 },
        etag: string,
        size: { type: 'integer', minimum: 1, maximum: 100 * 1024 * 1024 },
      }),
    };
  if (id === 'assets.prepare')
    return object({
      key: string,
      uploadUrl: { type: 'string', format: 'uri' },
      headers: { type: 'object', additionalProperties: { type: 'string' } },
      expiresAt: { type: 'string', format: 'date-time' },
    });
  if (id === 'models.schema') return ref('GenerationProfile');
  if (id === 'models.list') return envelope(ref('CatalogModel'));
  if (id === 'companies.get' || id === 'series.get')
    return object({ models: array(ref('CatalogModel')) });
  if (id === 'catalog.search') return array({ type: 'object' });
  if (id === 'catalog.list')
    return object({
      models: array(ref('CatalogModel')),
      providers: array({ type: 'object' }),
      deployments: array({ type: 'object' }),
      routes: array({ type: 'object' }),
      companies: array({ type: 'object' }),
      series: array({ type: 'object' }),
    });
  if (['videos.create', 'videos.get'].includes(id)) return ref('CompatibleVideo');
  if (id === 'images.generate' || id === 'images.edit')
    return object({
      created: integer,
      data: array({
        oneOf: [object({ url: { type: 'string', format: 'uri' } }), object({ b64_json: string })],
      }),
      opengen: { type: 'object' },
    });
  if (
    id.endsWith('.list') ||
    ['webhooks.deliveries', 'ledger.export', 'operator.reconciliations'].includes(id)
  )
    return envelope({ type: 'object' });
  return { type: 'object' };
}

export function openApiDocument(billingAvailable = false) {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorResponses = Object.fromEntries(
    Object.entries({
      400: 'Invalid or unsupported input.',
      401: 'Authentication required.',
      402: 'Balance or request budget is insufficient.',
      403: 'Scope, origin or workspace policy denied.',
      404: 'Owned resource not found.',
      409: 'Idempotency conflict or operation unavailable in current state.',
      422: 'No compatible executable route or request cannot be fulfilled.',
      429: 'Backpressure or request limit; retry the same read or follow the admission error.',
      503: 'Required installation service is not configured.',
    }).map(([status, description]) => [
      status,
      {
        description,
        content: { 'application/json': { schema: ref('Error') } },
        ...(status === '429'
          ? {
              headers: {
                'Retry-After': {
                  description: 'Bounded delay in seconds, when supplied.',
                  schema: { type: 'integer', minimum: 1 },
                },
              },
            }
          : {}),
      },
    ]),
  );
  for (const [id, target] of Object.entries(operationTargets)) {
    const billing = billingOperationDetails(id);
    if (billing && !billingAvailable) continue;
    const input =
      id === 'ledger.export'
        ? ledgerQuerySchema.extend({ format: z.enum(['json', 'csv']).default('csv') })
        : id === 'billing.policy.update'
          ? billingPolicyInputSchema
          : callSchema.options.find((option) => option.shape.operationId.value === id)!.shape.input;
    const inputJson = z.toJSONSchema(input, { io: 'input' }) as Schema;
    const pathFields = [...target.path.matchAll(/:([a-zA-Z]+)/g)].map((match) => match[1]!);
    const properties = { ...(inputJson.properties as Record<string, Schema> | undefined) };
    const required = (inputJson.required as string[] | undefined) ?? [];
    const parameters: Schema[] = pathFields.map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: properties[name] ?? string,
    }));
    for (const name of pathFields) delete properties[name];
    let body: Schema | undefined;
    if (target.method === 'GET') {
      for (const [name, schema] of Object.entries(properties))
        parameters.push({ name, in: 'query', required: required.includes(name), schema });
    } else if (inputJson.type === 'array') body = inputJson;
    else if (Object.keys(properties).length)
      body = {
        ...inputJson,
        properties,
        required: required.filter((name) => !pathFields.includes(name)),
      };
    const requestContent: Record<string, Schema> = body
      ? { 'application/json': { schema: body } }
      : {};
    if (id === 'images.edit') {
      const imageReferences = compatibilityImageEditSchema.shape.image.options[1];
      requestContent['multipart/form-data'] = {
        schema: {
          ...body,
          description:
            `At most ${compatibilityEditMultipartLimit} bytes and 24 text parts. ` +
            'Upload assets first. Use one image text part containing a JSON owned reference or array, ' +
            'or ordered image[] text parts containing one JSON owned reference each. ' +
            'Do not mix image with image[]. Binary file parts and remote image URLs are unsupported.',
          properties: {
            ...properties,
            image: {
              type: 'string',
              contentMediaType: 'application/json',
              contentSchema: properties.image,
              description: 'One JSON assetKey reference or an array of owned references, as text.',
            },
            'image[]': {
              ...z.toJSONSchema(imageReferences),
              items: {
                type: 'string',
                contentMediaType: 'application/json',
                contentSchema: z.toJSONSchema(imageReferences.element),
              },
              description:
                'Repeat this text field in reference order, with one JSON assetKey object per part.',
            },
            n: {
              type: 'string',
              const: String(properties.n!.const),
              description: 'The decimal text 1. Only one output is supported.',
            },
            max_cost_micros: {
              type: 'string',
              pattern: '^(0|[1-9][0-9]*)$',
              contentMediaType: 'application/json',
              contentSchema: properties.max_cost_micros,
              description: 'Nonnegative safe decimal integer text, at most 9007199254740991.',
            },
          },
          required: required.filter((name) => name !== 'image'),
          oneOf: [{ required: ['image'] }, { required: ['image[]'] }],
        },
        encoding: {
          image: { contentType: 'text/plain' },
          'image[]': { contentType: 'text/plain' },
          max_cost_micros: { contentType: 'text/plain' },
        },
      };
    }
    if (idempotentOperationIds.has(id))
      parameters.push({ $ref: '#/components/parameters/IdempotencyKey' });
    const operatorOnly = operatorOperationIds.has(id);
    const successCode = [
      'feedback.submit',
      'catalog.request',
      'keys.create',
      'policies.create',
      'webhooks.create',
      'workspaces.create',
      'teams.create',
      'members.invite',
    ].includes(id)
      ? '201'
      : ['media.generate', 'videos.create'].includes(id)
        ? '202'
        : '200';
    const responses: Record<string, unknown> = {
      ...errorResponses,
      [successCode]: {
        description:
          successCode === '202'
            ? 'Job accepted. Persist the returned ID and poll it.'
            : 'Successful response.',
        content: { 'application/json': { schema: responseSchema(id) } },
      },
    };
    if (id === 'images.generate' || id === 'images.edit')
      responses['202'] = {
        description:
          'Slow or unresolved image creation. This explicit OpenGen extension returns the existing native job instead of a synchronous image response.',
        headers: { Location: { schema: string } },
        content: {
          'application/json': {
            schema: object({
              id: string,
              object: { const: 'generation' },
              status: string,
              opengen: object({ poll_url: string }),
            }),
          },
        },
      };
    if (id === 'images.edit')
      responses['413'] = {
        description: `Image edit request exceeds the ${compatibilityEditMultipartLimit} byte limit.`,
        content: { 'application/json': { schema: ref('Error') } },
      };
    if (id === 'videos.content') {
      delete responses['200'];
      responses['303'] = {
        description:
          'Redirect to the short-lived owned output URL. No gateway Authorization header should be forwarded to that destination.',
        headers: { Location: { required: true, schema: { type: 'string', format: 'uri' } } },
      };
    }
    if (id === 'videos.content') {
      parameters.push({
        name: 'Range',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'One bytes range over the authorized owned MP4; no arbitrary media URL.',
      });
      parameters.push({
        name: 'If-Range',
        in: 'header',
        required: false,
        schema: { type: 'string' },
        description: 'Strong ETag or HTTP date; a mismatch returns the full owned representation.',
      });
      const mediaHeaders = {
        'Accept-Ranges': { schema: { const: 'bytes' } },
        'Content-Length': { schema: integer },
        'Content-Range': { schema: string },
        ETag: { schema: string },
      };
      responses['200'] = {
        description: 'Full owned representation for a mismatched If-Range.',
        headers: mediaHeaders,
        content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } },
      };
      responses['206'] = {
        description: 'Single authorized owned video byte range.',
        headers: mediaHeaders,
        content: { 'video/mp4': { schema: { type: 'string', format: 'binary' } } },
      };
      responses['416'] = {
        description: 'Unsupported or unsatisfiable range.',
        headers: { 'Content-Range': { schema: string } },
        content: { 'application/json': { schema: ref('Error') } },
      };
    }
    if (id === 'ledger.export')
      responses['200'] = {
        description:
          'Private paginated accounting export. HTTP supports JSON or CSV; the MCP operation explicitly requests JSON.',
        headers: { 'X-Next-Cursor': { schema: string }, 'Content-Disposition': { schema: string } },
        content: {
          'application/json': { schema: envelope({ type: 'object' }) },
          'text/csv': { schema: string },
        },
      };
    const path = target.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    paths[path] ??= {};
    paths[path]![target.method.toLowerCase()] = {
      operationId: id,
      ...(billing
        ? {
            description: billing.description,
            'x-opengen-required-scope': billing.scope,
            'x-opengen-financial-effects': billing.financialEffects,
            'x-opengen-read-only': billing.readOnly,
          }
        : {}),
      summary: operationSummaries[id] ?? `${target.method} ${path}`,
      tags: [operatorOnly ? 'operator' : id.split('.')[0]!],
      ...(id === 'models.schema'
        ? {
            description:
              'Inspect canonical common and model-specific arguments, defaults, exact capability bounds, evidence sources and notices before quoting or submitting. The returned inputSchema describes the nested input object; generation still requires modelId and operation in the request envelope.',
          }
        : {}),
      security: publicOperationIds.has(id)
        ? []
        : operatorOnly
          ? [{ operatorToken: [] }]
          : [{ bearerAuth: [] }, { browserSession: [] }],
      ...(operatorOnly
        ? {
            'x-opengen-operator-only': true,
            description:
              'Installation operator only. Workspace API keys and external read/generate tokens cannot fund balances.',
          }
        : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(body ? { requestBody: { required: true, content: requestContent } } : {}),
      responses,
    };
  }
  const session = object(
    {
      authenticated: { type: 'boolean' },
      workspaceId: string,
      recoveryScope: string,
      membershipId: { type: 'string', format: 'uuid' },
      scopes: array(string),
      oidcEnabled: { type: 'boolean' },
      identity: object({ issuer: string, subject: string }),
      role: { enum: ['admin', 'member'] },
      canSwitchWorkspace: { type: 'boolean' },
      isOperator: { type: 'boolean' },
    },
    ['authenticated', 'oidcEnabled'],
  );
  paths['/v1/session'] = {
    get: {
      operationId: 'session.get',
      summary: 'Read the current browser session',
      tags: ['session'],
      security: [],
      responses: {
        200: {
          description: 'Current browser session state.',
          content: { 'application/json': { schema: session } },
        },
      },
    },
    post: {
      operationId: 'session.create',
      summary: 'Create a browser session from a workspace key',
      tags: ['session'],
      description: 'HTTP browser-session transport only; not an MCP call operation.',
      security: [],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: object({
              token: { type: 'string', writeOnly: true, minLength: 1, maxLength: 512 },
            }),
          },
        },
      },
      responses: {
        ...errorResponses,
        200: {
          description: 'Opaque HttpOnly cookie session created.',
          headers: { 'Set-Cookie': { schema: string } },
          content: { 'application/json': { schema: session } },
        },
      },
    },
    delete: {
      operationId: 'session.delete',
      summary: 'End the current browser session',
      tags: ['session'],
      security: [{ browserSession: [] }],
      responses: {
        200: {
          description: 'Browser session ended.',
          content: { 'application/json': { schema: session } },
        },
      },
    },
  };
  paths['/v1/session/workspace'] = {
    post: {
      operationId: 'session.workspace',
      summary: 'Select a browser session workspace',
      tags: ['session'],
      description:
        'Switch a verified browser session to an accepted workspace. Cookie-session transport only; not an MCP call operation.',
      security: [{ browserSession: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: z.toJSONSchema(sessionWorkspaceSchema, { io: 'input' }) },
        },
      },
      responses: {
        ...errorResponses,
        200: {
          description: 'Browser workspace selected.',
          content: { 'application/json': { schema: session } },
        },
      },
    },
  };
  const comparisonSecurity = [{ bearerAuth: [] }, { browserSession: [] }];
  const comparisonId = {
    name: 'id',
    in: 'path',
    required: true,
    schema: {
      type: 'string',
      pattern: '^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$',
    },
    description: 'Saved private comparison ID. A malformed or unavailable owned ID returns 404.',
  };
  paths['/v1/comparisons/quote'] = {
    post: {
      operationId: 'comparisons.quote',
      summary: 'Quote a private two-model image comparison',
      tags: ['comparisons'],
      description:
        'HTTP-only. Requires read scope. Persists a private quote for ten minutes without reserving funds or submitting jobs. ' +
        'The prompt is trimmed before checking its bounds. Select two different exact models with executable, known-priced text-to-image routes. ' +
        'Both children use the shared prompt, managed billing, pinned routes and no fallback. Inspect the returned inputs and total ceiling before approval.',
      security: comparisonSecurity,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: z.toJSONSchema(comparisonQuoteRequestSchema, { io: 'input' }),
          },
        },
      },
      responses: {
        ...errorResponses,
        201: {
          description: 'Private saved quote. Retain its ID for approval and recovery.',
          content: { 'application/json': { schema: ref('ComparisonRun') } },
        },
      },
    },
  };
  paths['/v1/comparisons'] = {
    get: {
      operationId: 'comparisons.list',
      summary: 'List recent private admitted comparisons',
      tags: ['comparisons'],
      description:
        'HTTP-only. Requires read scope. Returns at most 20 admitted comparisons in the current workspace, newest first. Unapproved quotes are excluded.',
      security: comparisonSecurity,
      responses: {
        ...errorResponses,
        200: {
          description: 'Recent admitted comparison summaries.',
          content: {
            'application/json': {
              schema: object({ data: { ...array(ref('ComparisonSummary')), maxItems: 20 } }),
            },
          },
        },
      },
    },
  };
  paths['/v1/comparisons/{id}'] = {
    get: {
      operationId: 'comparisons.get',
      summary: 'Read a private comparison and its original jobs',
      tags: ['comparisons'],
      description:
        'HTTP-only. Requires read scope. Read the saved ID to recover approval state and refresh retained private delivery links. ' +
        'Expired unapproved quotes return 404. Each admitted child keeps its own generation, delivery and settlement state.',
      security: comparisonSecurity,
      parameters: [comparisonId],
      responses: {
        ...errorResponses,
        200: {
          description: 'Private quote and any retained original child jobs.',
          content: { 'application/json': { schema: ref('ComparisonRun') } },
        },
      },
    },
  };
  paths['/v1/comparisons/{id}/approve'] = {
    post: {
      operationId: 'comparisons.approve',
      summary: 'Approve one saved private comparison',
      tags: ['comparisons'],
      description:
        'HTTP-only. Requires generate scope and authorization for the saved request, payer and total ceiling. Send no request body. ' +
        'Admission reserves both child jobs atomically. The saved comparison ID and server-owned child keys recover the same admission; no caller Idempotency-Key is required. ' +
        'After a lost response, read this comparison ID before taking further action. A repeated approval returns the same original jobs. An expired unapproved quote returns 409.',
      security: comparisonSecurity,
      parameters: [comparisonId],
      responses: {
        ...errorResponses,
        202: {
          description: 'Original private comparison admission and child jobs.',
          content: { 'application/json': { schema: ref('ComparisonRun') } },
        },
      },
    },
  };
  paths['/health'] = {
    get: {
      operationId: 'health',
      summary: 'Check gateway liveness',
      tags: ['health'],
      security: [],
      responses: {
        200: {
          description: 'Gateway liveness and configuration state.',
          content: {
            'application/json': {
              schema: object({
                status: { const: 'ok' },
                database: { type: 'boolean' },
                version: string,
              }),
            },
          },
        },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'OpenGen API',
      version: '0.1.1',
      description:
        'Self-hosted regional image/video generation router. Documented routes may not be executable; inspect quotes and notices. The explicit MCP call registry lists supported business operations. Private comparisons, browser sessions and OAuth transport/discovery are HTTP-only. Unknown provider acceptance must never trigger a blind paid retry.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    paths,
    components: {
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: true,
          description:
            'Persist this key with the exact original input before submission. Reuse it only for that request to recover the same accepted job.',
          schema: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
      schemas: {
        GenerationArguments: z.toJSONSchema(generationSchema.shape.input),
        GenerationProfile: generationProfile,
        CatalogModel: catalogModel,
        GenerateInput: z.toJSONSchema(generationSchema),
        Job: job,
        Quote: quote,
        ComparisonChildQuote: object({
          input: ref('GenerateInput'),
          endpointRegion: string,
          providerId: string,
          estimatedMicros: money,
          ceilingMicros: money,
          notices: array(string),
        }),
        ComparisonJob: {
          allOf: [
            ref('Job'),
            object({
              executionTiming: {
                type: ['object', 'null'],
                properties: {
                  durationMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
                  source: { enum: ['gateway', 'provider'] },
                },
                required: ['durationMs', 'source'],
                additionalProperties: false,
              },
            }),
          ],
        },
        ComparisonRun: object({
          id: { type: 'string', format: 'uuid' },
          expiresAt: { type: 'string', format: 'date-time' },
          admittedAt: { type: ['string', 'null'], format: 'date-time' },
          children: { ...array(ref('ComparisonChildQuote')), minItems: 2, maxItems: 2 },
          estimatedMicros: money,
          ceilingMicros: money,
          jobs: { ...array(ref('ComparisonJob')), maxItems: 2 },
        }),
        ComparisonSummary: object({
          id: { type: 'string', format: 'uuid' },
          admittedAt: { type: 'string', format: 'date-time' },
          routeIds: { ...array(string), minItems: 2, maxItems: 2 },
        }),
        DoctorReport: object(
          {
            authenticated: { const: true },
            authorized: {
              type: 'boolean',
              description:
                'Whether this credential has generate scope. Human quote/payer approval is separately required.',
            },
            account: { type: ['object', 'null'], properties: { issuer: string, subject: string } },
            payingWorkspace: object({ id: string, name: { type: ['string', 'null'] } }),
            scopes: array(string),
            policy: { type: ['object', 'null'] },
            maxCostMicros: nullableMoney,
            balance: ref('Balance'),
            billingHold: { type: ['boolean', 'null'] },
            executionScope: object({
              profile: { enum: ['unrestricted', 'qualification-sg-v1'] },
              queuedConflicts: { ...integer, minimum: 0 },
              transitionBlocked: { type: 'boolean' },
            }),
            executableRoutes: object({
              managed: array(string),
              byok: array(string),
              evidence: { const: 'configuration-only' },
              requestQuoteRequired: { const: true },
            }),
            blockers: array(object({ code: string, message: string, nextCommand: string })),
            nextBlocker: {
              type: ['object', 'null'],
              properties: { code: string, message: string, nextCommand: string },
            },
            nextCommand: string,
            notices: array(string),
          },
          [
            'authenticated',
            'authorized',
            'account',
            'payingWorkspace',
            'scopes',
            'policy',
            'maxCostMicros',
            'balance',
            'billingHold',
            'executableRoutes',
            'blockers',
            'nextBlocker',
            'nextCommand',
            'notices',
          ],
        ),
        Balance: balance,
        BillingPolicy: billingPolicy,
        BillingRechargeAttempt: billingRechargeAttempt,
        BillingDocument: billingDocument,
        QuoteCandidate: object(
          {
            billing: object({
              providerEstimateMicros: nullableMoney,
              nominalFeeEstimateMicros: nullableMoney,
              customerEstimateMicros: nullableMoney,
            }),
            routeId: string,
            deploymentId: string,
            providerId: string,
            endpointRegion: string,
            scope: {
              enum: ['regional', 'mainland-china', 'international', 'global', 'undisclosed'],
            },
            estimatedCostMicros: nullableMoney,
            currency: { const: 'USD' },
            executable: { type: 'boolean' },
            reason: { type: ['string', 'null'] },
            source: ref('Source'),
            notices: array(string),
          },
          [
            'routeId',
            'deploymentId',
            'providerId',
            'endpointRegion',
            'scope',
            'estimatedCostMicros',
            'currency',
            'executable',
            'reason',
            'source',
            'notices',
          ],
        ),
        Source: object(
          { url: { type: 'string', format: 'uri' }, checkedAt: string, note: string },
          ['url', 'checkedAt'],
        ),
        OwnedAsset: object({
          assetKey: string,
          state: {
            enum: ['prepared', 'uploading', 'processing', 'ready', 'failed', 'expired', 'deleted'],
          },
          mediaType: { type: ['string', 'null'] },
          byteLength: nullableMoney,
          sha256: { type: ['string', 'null'] },
          expiresAt: { type: ['string', 'null'], format: 'date-time' },
          deletionPending: { type: 'boolean' },
        }),
        OutputAsset: object(
          {
            outputIndex: {
              type: 'integer',
              minimum: 0,
              maximum: 19,
              description:
                'Stable original receipt slot for owned output reuse, independent of this output’s current array position. Use this value for assets.reuse.',
            },
            url: { type: 'string', format: 'uri' },
            mediaType: string,
            fidelity: { const: 'unverified' },
            expiresAt: { type: 'string', format: 'date-time' },
            sha256: string,
            byteLength: { type: 'integer', minimum: 1 },
            c2pa: object(
              {
                status: {
                  enum: ['trusted', 'valid', 'invalid', 'absent', 'unknown', 'unavailable'],
                },
                checkedAt: { type: 'string', format: 'date-time' },
                sha256: string,
                tool: { const: 'c2patool' },
                validationCodes: array(string),
                reason: string,
                manifestLabel: string,
                signer: string,
                reportSha256: string,
              },
              ['status', 'checkedAt', 'sha256', 'tool', 'validationCodes'],
            ),
          },
          ['url', 'mediaType', 'fidelity'],
        ),
        Error: object({
          error: object(
            {
              code: string,
              message: string,
              issues: array(
                object(
                  {
                    code: string,
                    field: string,
                    message: string,
                    limit: { type: ['number', 'string'] },
                    received: { type: ['number', 'string'] },
                  },
                  ['code', 'field', 'message'],
                ),
              ),
            },
            ['code', 'message'],
          ),
        }),
        CompatibleVideo: object({
          id: string,
          object: { const: 'video' },
          model: string,
          status: { enum: ['queued', 'in_progress', 'completed', 'failed'] },
          created_at: integer,
          seconds: string,
          error: { type: ['object', 'null'] },
          opengen: { type: 'object' },
        }),
      },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Workspace-scoped OpenGen API key or configured external resource token. Provider credentials are never OpenGen client credentials.',
        },
        browserSession: { type: 'apiKey', in: 'cookie', name: 'og_session' },
        operatorToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Privileged installation bootstrap credential. Never expose to customers or anonymous frontend requests.',
        },
      },
    },
  };
}
