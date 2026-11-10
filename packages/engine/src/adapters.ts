import type {
  Deployment,
  GenerateInput,
  Operation,
  OutputAsset,
  Route,
} from '@media-router/contracts';
import { isIP } from 'node:net';
import type { AssetRef, GenerationArguments, ReferenceType } from '@media-router/contracts';
import {
  assetUrl,
  assertHandledArguments,
  collectGenerationAssets,
} from '@media-router/contracts/generation';

export interface AdapterContext {
  jobId: string;
  /** Trusted immutable attempt context supplied by the engine, never generation JSON. */
  attempt?: number;
  providerConnectionId?: string | null;
  costEvidenceScope?: import('./generation-billing.js').GenerationCostScope;
  /** Stable caller identity for providers that require a privacy-preserving end-user ID. */
  workspaceId?: string;
  /** Engine-verified continuation ID from the same workspace and pinned regional route. */
  previousUpstreamId?: string;
  input: GenerateInput;
  route: Route;
  deployment: Deployment;
}

export interface ProviderResult {
  /** Qualified typed observations only; engine normalizes before persistence/projection. */
  progress?: import('./execution-telemetry.js').JobProgress | null;
  structuredError?: import('./execution-telemetry.js').JobError | null;
  timings?: import('./execution-telemetry.js').JobTimings | null;
  /** Explicit provider instruction to recheck terminal billing; never implies permission to resubmit. */
  retryAfterMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  outputs?: OutputAsset[];
  error?: string;
  failureCategory?: 'technical' | 'policy' | 'invalid' | 'unknown';
  /** Actual provider usage translated with the job's price snapshot, never a quote presented as actual usage. */
  billedCostMicros?: number | null;
  /** Private typed observation from a trusted adapter. The engine checks the attempt binding. */
  costEvidence?: import('./generation-billing.js').GenerationCostEvidence;
}

export interface ProviderAdapter {
  id: string;
  supportedOperations?: Operation[];
  /** Canonical argument names this qualified adapter actually honors, including checked fixed values. */
  inputFields?(context: Omit<AdapterContext, 'jobId'>): readonly (keyof GenerationArguments)[];
  isConfigured(route: Route, deployment: Deployment): boolean;
  /** Pure adapter-specific checks shared by quote eligibility and submission; never calls a provider. */
  preflight?(context: Omit<AdapterContext, 'jobId'>): string | null;
  submit(context: AdapterContext): Promise<ProviderSubmission>;
  poll(context: AdapterContext & { upstreamId: string }): Promise<ProviderResult>;
}

export function adapterInputIssue(
  context: Omit<AdapterContext, 'jobId'>,
  fields: readonly (keyof GenerationArguments)[],
): string | null {
  const supplied = { ...context.input.input };
  if (!supplied.references?.length) delete supplied.references;
  const issues = assertHandledArguments(supplied, fields);
  if (issues.length) return issues[0]!.message;
  try {
    for (const { asset } of collectGenerationAssets(supplied))
      if (!isPublicHttpsAssetUrl(assetUrl(asset))) throw new Error('Nonpublic or unresolved media');
  } catch {
    return 'Media must be resolved to public HTTPS URLs without embedded credentials before provider submission.';
  }
  return null;
}
export function referenceUrls(input: GenerateInput, type: ReferenceType = 'image'): string[] {
  return (input.input.references ?? [])
    .filter((reference) => reference.type === type)
    .map((reference) => assetUrl(reference.asset));
}
export function referenceTypeIssue(
  input: GenerateInput,
  allowed: readonly ReferenceType[] = ['image'],
): string | null {
  return input.input.references?.some((reference) => !allowed.includes(reference.type))
    ? `This adapter supports ${allowed.join('/')} references only.`
    : null;
}
export function frameUrl(input: GenerateInput, role: 'first' | 'last'): string | undefined {
  const asset = role === 'first' ? input.input.firstFrame : input.input.lastFrame;
  return asset ? assetUrl(asset) : undefined;
}
export function sourceVideoUrl(input: GenerateInput): string | undefined {
  return input.input.sourceVideo ? assetUrl(input.input.sourceVideo) : undefined;
}
export function assetReferenceUrl(asset: AssetRef | undefined): string | undefined {
  return asset ? assetUrl(asset) : undefined;
}
export function numericDuration(input: GenerateInput): number {
  return typeof input.input.duration === 'number' ? input.input.duration : NaN;
}

export type ProviderSubmission =
  | { upstreamId: string; immediateResult?: never }
  | {
      upstreamId?: never;
      immediateResult: ProviderResult & { status: 'succeeded' | 'failed' };
    };

export class SubmissionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionRejected';
  }
}

/** Only user-facing, redacted messages cross this boundary. Provider response bodies are never logged. */
export class SubmissionUnknown extends Error {
  constructor(
    message = 'The provider submission outcome is unknown. The request will not be submitted again automatically.',
  ) {
    super(message);
    this.name = 'SubmissionUnknown';
  }
}

function regionalPrefix(region: string): string {
  return `ALIBABA_${region.toUpperCase().replaceAll('-', '_')}`;
}

export function alibabaCredentials(
  deployment: Deployment,
  env: NodeJS.ProcessEnv = process.env,
): { apiKey: string; workspaceId: string } | null {
  const prefix = regionalPrefix(deployment.endpointRegion);
  const apiKey =
    (deployment.credentialEnv ? env[deployment.credentialEnv] : undefined) ||
    env[`${prefix}_API_KEY`];
  const workspaceId = env[`${prefix}_WORKSPACE_ID`];
  if (apiKey && workspaceId && /^[a-zA-Z0-9-]+$/.test(workspaceId)) return { apiKey, workspaceId };
  if (env.ALIBABA_REGION !== deployment.endpointRegion) return null;
  const sharedKey = env.DASHSCOPE_API_KEY;
  const sharedWorkspace = env.ALIBABA_WORKSPACE_ID;
  return sharedKey && sharedWorkspace && /^[a-zA-Z0-9-]+$/.test(sharedWorkspace)
    ? { apiKey: sharedKey, workspaceId: sharedWorkspace }
    : null;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' ? (value as JsonObject) : {};
}

export function isPublicHttpsAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      host.includes('.') &&
      !isIP(host) &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

export function createAlibabaAdapter(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {},
): ProviderAdapter {
  const env = options.env ?? process.env;
  const request = options.fetch ?? fetch;
  const supportedOperations: Operation[] = [
    'text-to-video',
    'image-to-video',
    'reference-to-video',
  ];
  const fields: (keyof GenerationArguments)[] = [
    'prompt',
    'resolution',
    'duration',
    'aspectRatio',
    'firstFrame',
    'lastFrame',
    'references',
    'audio',
    'seed',
    'promptExtend',
    'watermark',
    'count',
  ];
  function preflight(context: Omit<AdapterContext, 'jobId'>): string | null {
    if (
      !/^(cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)$/.test(
        context.deployment.endpointRegion,
      )
    ) {
      return 'Unsupported Alibaba regional deployment.';
    }
    if (!['wan3.0-video', 'wan3.0-video-prime'].includes(context.route.upstreamModelId))
      return 'Unsupported Alibaba model.';
    if (!supportedOperations.includes(context.input.operation))
      return 'This Wan adapter executes text, frame and omni reference video generation.';
    const args = context.input.input;
    const issue = adapterInputIssue(context, fields);
    if (issue) return issue;
    if ((args.prompt ?? '').length > 20000)
      return 'Wan prompt exceeds 20,000 characters; it will not be truncated.';
    if (!['480p', '720p', '1080p'].includes(args.resolution?.toLowerCase() ?? ''))
      return 'Unsupported Wan output resolution.';
    if (
      args.duration !== 'auto' &&
      (!Number.isInteger(numericDuration(context.input)) ||
        numericDuration(context.input) < 2 ||
        numericDuration(context.input) > 30)
    )
      return 'Wan duration must be 2–30 seconds or auto.';
    if (
      args.seed !== undefined &&
      (!Number.isInteger(args.seed) || args.seed < -1 || args.seed > 2147483647)
    )
      return 'Wan seed must be -1 through 2147483647.';
    if (args.count !== undefined && args.count !== 1)
      return 'This Wan adapter produces one video per job.';
    if (
      context.input.operation === 'text-to-video' &&
      (args.firstFrame || args.lastFrame || args.references?.length)
    )
      return 'Text-to-video does not accept media.';
    if (
      context.input.operation === 'image-to-video' &&
      (!args.firstFrame || args.references?.length)
    )
      return 'Wan frame generation requires firstFrame and cannot mix omni references.';
    if (
      context.input.operation === 'reference-to-video' &&
      (args.firstFrame || args.lastFrame || !args.references?.length)
    )
      return 'Wan omni generation requires references without first/last frames.';
    if (args.references?.some((ref) => ref.type === 'document'))
      return 'This Wan adapter does not execute document mode.';
    for (const [type, max] of [
      ['image', 10],
      ['video', 5],
      ['audio', 5],
    ] as const)
      if ((args.references ?? []).filter((ref) => ref.type === type).length > max)
        return `Wan supports at most ${max} ${type} references.`;
    if (
      args.aspectRatio &&
      args.aspectRatio !== 'source' &&
      !['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'auto'].includes(args.aspectRatio)
    )
      return 'Unsupported Wan aspect ratio.';
    if (args.aspectRatio === 'source' && !args.firstFrame)
      return 'Source ratio requires a first frame.';
    return null;
  }
  function credentials(context: AdapterContext) {
    const value = alibabaCredentials(context.deployment, env);
    if (!value)
      throw new SubmissionRejected(
        `Configure credentials for Alibaba ${context.deployment.endpointRegion}.`,
      );
    // The host is reconstructed from fixed deployment metadata, not accepted from a generation request.
    return {
      ...value,
      base: `https://${value.workspaceId}.${context.deployment.endpointRegion}.maas.aliyuncs.com/api/v1`,
    };
  }
  return {
    id: 'alibaba',
    supportedOperations,
    inputFields: () => fields,
    preflight,
    isConfigured: (route, deployment) =>
      route.adapter === 'alibaba' && alibabaCredentials(deployment, env) !== null,
    async submit(context) {
      const issue = preflight(context);
      if (issue) throw new SubmissionRejected(issue);
      const auth = credentials(context);
      const args = context.input.input;
      const media = [
        ...(args.firstFrame ? [{ type: 'first_frame', url: assetUrl(args.firstFrame) }] : []),
        ...(args.lastFrame ? [{ type: 'last_frame', url: assetUrl(args.lastFrame) }] : []),
        ...(args.references ?? []).map((reference) => ({
          type: `reference_${reference.type}`,
          url: assetUrl(reference.asset),
        })),
      ];
      let response: Response;
      try {
        response = await request(`${auth.base}/services/aigc/video-generation/video-synthesis`, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${auth.apiKey}`,
            'Content-Type': 'application/json',
            'X-DashScope-Async': 'enable',
          },
          body: JSON.stringify({
            model: context.route.upstreamModelId,
            input: {
              ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
              ...(media.length ? { media } : {}),
            },
            parameters: {
              resolution: args.resolution?.toUpperCase(),
              duration: args.duration === 'auto' ? -1 : args.duration,
              ratio:
                args.aspectRatio === 'source'
                  ? 'adaptive'
                  : args.aspectRatio === 'auto'
                    ? 'adaptive'
                    : args.aspectRatio,
              audio: args.audio ?? true,
              ...(args.seed === undefined ? {} : { seed: args.seed }),
              ...(args.promptExtend === undefined ? {} : { prompt_extend: args.promptExtend }),
              ...(args.watermark === undefined ? {} : { watermark: args.watermark }),
            },
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new SubmissionUnknown();
      }
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        throw new SubmissionRejected(
          `Alibaba rejected submission (HTTP ${response.status}). No automatic retry was sent.`,
        );
      }
      if (!response.ok)
        throw new SubmissionUnknown(
          `Alibaba submission returned HTTP ${response.status}; acceptance could not be confirmed.`,
        );
      let body: JsonObject;
      try {
        body = object(await response.json());
      } catch {
        throw new SubmissionUnknown();
      }
      const upstreamId = object(body.output).task_id;
      if (typeof upstreamId !== 'string' || !upstreamId) throw new SubmissionUnknown();
      return { upstreamId };
    },
    async poll(context) {
      const auth = credentials(context);
      const response = await request(
        `${auth.base}/tasks/${encodeURIComponent(context.upstreamId)}`,
        {
          headers: { Authorization: `Bearer ${auth.apiKey}` },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) throw new Error(`Alibaba status request failed (HTTP ${response.status}).`);
      const body = object(await response.json());
      const output = object(body.output);
      const state = output.task_status;
      if (state === 'PENDING' || state === 'RUNNING') return { status: 'running' };
      if (state === 'UNKNOWN')
        return {
          status: 'unknown',
          error: 'The provider cannot resolve this task. Keep its ID for reconciliation.',
        };
      if (state === 'FAILED')
        return {
          status: 'failed',
          failureCategory: 'unknown',
          error: 'Provider generation failed; billing requires reconciliation.',
          billedCostMicros: null,
        };
      // A provider cancellation response does not itself establish refundability.
      if (state === 'CANCELED')
        return {
          status: 'cancelled',
          error: 'Provider cancelled the task; billing requires reconciliation.',
        };
      if (
        state !== 'SUCCEEDED' ||
        typeof output.video_url !== 'string' ||
        !isPublicHttpsAssetUrl(output.video_url)
      ) {
        throw new Error('Provider returned an unrecognized task status.');
      }
      const usage = object(body.usage);
      const duration = usage.duration;
      const rate = context.route.rates.find(
        (rate) =>
          rate.resolution.toLowerCase() === (context.input.input.resolution ?? '').toLowerCase() &&
          rate.unit === 'output-second' &&
          (!rate.operation || rate.operation === context.input.operation),
      );
      const billedCostMicros =
        !(context.input.input.references ?? []).some((reference) => reference.type === 'video') &&
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration >= 0 &&
        rate
          ? Math.ceil(duration * rate.usdMicros)
          : null;
      return {
        status: 'succeeded',
        billedCostMicros,
        // The provider documents temporary URLs but does not return their precise expiry timestamp here.
        outputs: [
          {
            url: output.video_url,
            mediaType: 'video/mp4',
            fidelity: 'unverified',
          },
        ],
      };
    },
  };
}
