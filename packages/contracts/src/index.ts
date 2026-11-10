export type {
  JobAttribution,
  GenerationMetadata,
  DeliveryStatus,
  JobError,
  JobProgress,
  JobStatusView,
  JobHistoryQuery,
  JobHistoryPage,
  OwnedAssetState,
  OwnedAssetView,
} from './core-types';
import type { GenerationRequest } from './generation-types';
export { canonicalModelId } from './model-identity';
export * from './feedback';
export const keyScopes = [
  'read',
  'generate',
  'keys:write',
  'policies:write',
  'connections:write',
  'webhooks:write',
  'members:write',
  'feedback:write',
] as const;
export type KeyScope = (typeof keyScopes)[number];
export type Operation =
  | 'text-to-image'
  | 'image-edit'
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'video-edit'
  | 'video-extend';
export type Fidelity = 'native' | 'upscaled' | 'unknown';
export type DeploymentScope =
  'regional' | 'mainland-china' | 'international' | 'global' | 'undisclosed';
export interface Source {
  url: string;
  checkedAt: string;
  note?: string;
}
export interface Provider {
  id: string;
  name: string;
  website: string;
}
export interface Deployment {
  id: string;
  providerId: string;
  name: string;
  endpointRegion: string;
  scope: DeploymentScope;
  processingRegions: string[] | null;
  storageRegions: string[] | null;
  endpointTemplate: string | null;
  credentialEnv: string | null;
  source: Source;
}
export interface Model {
  id: string;
  name: string;
  creator: string;
  /** Serving companies operated by this exact variant's author; independent of route verification. */
  authorProviderIds: string[];
  familyId: string;
  modality: 'image' | 'video';
  aliases: string[];
  openness: 'closed' | 'open-weights';
  license: string;
  source: Source;
  description: string;
}
/** Original model/series publisher. This is separate from a serving provider. */
export interface Company {
  id: string;
  name: string;
  website: string;
  description: string;
  parentCompanyId?: string;
}
/** Public series membership; exact model identities remain unchanged for execution. */
export interface ModelSeries {
  id: string;
  companyId: string;
  name: string;
  description: string;
  /** Ordered with the default variant first. */
  modelIds: string[];
}
export interface Rate {
  resolution: string;
  operation?: Operation;
  unit: 'image' | 'output-second';
  usdMicros: number;
  note?: string;
}
export interface Route {
  id: string;
  modelId: string;
  deploymentId: string;
  upstreamModelId: string;
  /** Provider-specific display label; exact variant identity remains modelId. */
  providerModelName?: string;
  operations: Operation[];
  resolutions: string[];
  durations: number[];
  fidelity: Fidelity;
  adapter:
    | 'alibaba'
    | 'byteplus'
    | 'fal'
    | 'replicate'
    | 'openai'
    | 'xai'
    | 'minimax'
    | 'google'
    | 'runway'
    | 'pika'
    | null;
  status: 'documented' | 'live-verified' | 'retired';
  /** Configuration covered by a live generation and delivery test. */
  liveVerification?: {
    checkedAt: string;
    /** Primary operation retained for clients reading the original single-operation field. */
    operation: Operation;
    /** Operations verified at this same resolution, duration and date. */
    operations?: [Operation, ...Operation[]];
    resolution: string;
    duration: number;
  };
  rates: Rate[];
  /** Informational provider tariff only; never participates in execution, quotes or settlement. */
  publishedPricing?: {
    summary: string;
    source: Source;
    conditions: string[];
    /** Published per-output prices for comparison only. */
    outputRates?: Array<Rate & { approximate?: true }>;
  };
  pricingSource: Source;
  source: Source;
}
export interface Catalog {
  providers: Provider[];
  deployments: Deployment[];
  models: Model[];
  routes: Route[];
}
export interface RoutingPolicy {
  modelIds?: string[];
  modelProviderExceptions?: { modelId: string; providerIds: string[] }[];
  authorOnly?: boolean;
  providerIds?: string[];
  deploymentIds?: string[];
  endpointRegions?: string[];
  processingRegions?: string[];
  processingScopes?: DeploymentScope[];
  fidelity?: 'any' | 'native';
  preference?: 'cost' | 'speed' | 'reliability';
  fallback?: boolean;
}
export interface GenerationFeeTerms {
  policyId: string;
  policyVersion: number;
  service: 'direct' | 'smart';
  basisPoints: number;
}
export interface GenerationFeeEstimate {
  providerEstimateMicros: number | null;
  nominalFeeEstimateMicros: number | null;
  customerEstimateMicros: number | null;
}
export interface GenerationFeeSettlement extends GenerationFeeTerms {
  costStatus: 'verified' | 'no-upstream-charge';
  providerCostMicros: number;
  customerProviderDebitMicros: number;
  nominalFeeMicros: number;
  collectedFeeMicros: number;
  waivedFeeMicros: number;
  operatorOverrunMicros: number;
  customerTotalMicros: number;
}
export type GenerationFeeView =
  (GenerationFeeTerms & { costStatus: 'pending' }) | GenerationFeeSettlement;
export interface QuoteCandidate {
  billing?: GenerationFeeEstimate;
  issues?: import('./generation-types').GenerationIssue[];
  routeId: string;
  deploymentId: string;
  providerId: string;
  endpointRegion: string;
  scope: DeploymentScope;
  estimatedCostMicros: number | null;
  currency: 'USD';
  executable: boolean;
  reason: string | null;
  source: Source;
  notices: string[];
}
export interface Quote {
  billing?: GenerationFeeTerms;
  reservationMicros?: number | null;
  modelId: string;
  operation: Operation;
  candidates: QuoteCandidate[];
  selectedRouteId: string | null;
  estimateOnly: true;
  notices: string[];
}
export interface C2paVerification {
  status: 'trusted' | 'valid' | 'invalid' | 'absent' | 'unknown' | 'unavailable';
  checkedAt: string;
  sha256: string;
  tool: 'c2patool';
  validationCodes: string[];
  reason?: string;
  manifestLabel?: string;
  signer?: string;
  reportSha256?: string;
}
export interface OutputAsset {
  /** Stable original receipt slot for owned reuse, independent of this output's array position. */
  outputIndex?: number;
  sha256?: string;
  byteLength?: number;
  c2pa?: C2paVerification;
  /** Private object key; authenticated job reads mint a fresh short-lived URL. */
  storageKey?: string;
  url: string;
  mediaType: string;
  fidelity: 'unverified';
  expiresAt?: string;
}
export type JobStatus =
  'queued' | 'submitting' | 'running' | 'submission-unknown' | 'succeeded' | 'failed' | 'cancelled';
export interface Job {
  billing?: GenerationFeeView;
  progress?: import('./core-types').JobProgress | null;
  structuredError?: import('./core-types').JobError | null;
  attribution?: import('./core-types').JobAttribution | null;
  metadata?: import('./core-types').GenerationMetadata;
  deliveryStatus?: import('./core-types').DeliveryStatus;
  deliveryErrors?: { index: number; code: string }[];
  id: string;
  workspaceId: string;
  status: JobStatus;
  input: GenerateInput;
  routeId: string;
  deploymentId: string;
  upstreamId: string | null;
  outputs: OutputAsset[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
  reservedMicros: number;
  settledMicros: number | null;
  attemptCount: number;
}
export interface RouteMetrics {
  /** Final-route job observations are separate from provider-attempt observations. */
  jobSampleCount?: number;
  /** Delivery counts consider upstream-succeeded final-route jobs only. */
  deliveryAvailableJobCount?: number;
  deliveryFailedJobCount?: number;
  /** Includes pending/partial/unverified or legacy available without current owned-receipt proof. */
  deliveryUnresolvedJobCount?: number;
  /** Receipt-confirmed complete owned delivery with a recorded finite, nonnegative creation-to-delivery span. */
  endToEndSampleCount?: number;
  /** No customer/internal/benchmark cohort is inferred from actor, project or labels. */
  trafficProvenance?: 'mixed-unclassified';
  /** Creation to recorded available owned delivery; never provider completion as a substitute. */
  p50EndToEndMs?: number | null;
  p95EndToEndMs?: number | null;
  technicalOutcomeCount?: number;
  configuration?: { operation: Operation; resolution?: string; duration?: number | 'auto' };
  routeId: string;
  /** Provider-attempt observations; distinct from final-job owned-delivery counts. */
  sampleCount: number;
  succeeded: number;
  failed: number;
  unresolved: number;
  unclassifiedFailures: number;
  /** Provider-attempt technical outcomes only; never output delivery or overall job success. */
  technicalSuccessRate: number | null;
  p50CompletionMs: number | null;
  p75CompletionMs: number | null;
  p90CompletionMs: number | null;
  p95CompletionMs: number | null;
  p99CompletionMs: number | null;
  window: string;
  /** Measurement origin/region only; this field does not establish benchmark traffic. */
  benchmarkOrigin: string;
}

export {
  billingOperationTargets,
  operationTargets,
  operationRequest,
  type OperationId,
} from './operations';

export { agentSkill, agentEntry, imageToVideoGuide } from './onboarding';

export type {
  AssetRef,
  ReferenceType,
  MediaReference,
  Keyframe,
  GenerationShot,
  GenerationElement,
  GenerationArguments,
  GenerationRequest,
  GenerationIssue,
  GenerationCapabilities,
  GenerationDefinition,
  GenerationProfile,
  GenerationExamples,
} from './generation-types';
export type GenerateInput = GenerationRequest;

export * from './catalog-discovery';

export type { DoctorReport, DoctorBlocker, WorkspaceReadiness } from './doctor';

export type * from './comparison';
