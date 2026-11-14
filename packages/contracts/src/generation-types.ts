import type { Operation, RoutingPolicy, Source } from './index';

/** An owned upload or one external URL. The union prevents ambiguous precedence. */
export type AssetRef = { assetKey: string; url?: never } | { url: string; assetKey?: never };
export type ReferenceType = 'image' | 'video' | 'audio' | 'document';
export interface MediaReference {
  type: ReferenceType;
  asset: AssetRef;
}
export interface Keyframe {
  image: AssetRef;
  at?: number | 'start' | 'end';
}
export interface GenerationShot {
  prompt: string;
  duration: number;
}
export type GenerationElement =
  | { id: string; description?: string; images: AssetRef[]; video?: never; voice?: AssetRef }
  | { id: string; description?: string; video: AssetRef; images?: never; voice?: AssetRef };

/** Shared names plus typed model extensions. A model's effective schema narrows these fields. */
export interface GenerationArguments {
  prompt?: string;
  negativePrompt?: string;
  firstFrame?: AssetRef;
  lastFrame?: AssetRef;
  sourceVideo?: AssetRef;
  mask?: AssetRef;
  references?: MediaReference[];
  duration?: number | 'auto';
  resolution?: string;
  size?: { width: number; height: number };
  aspectRatio?: string;
  count?: number;
  quality?: string;
  outputFormat?: 'png' | 'jpeg' | 'webp' | 'mp4';
  outputCompression?: number;
  background?: 'auto' | 'opaque' | 'transparent';
  complexity?: 'low' | 'medium' | 'high';
  seed?: number;
  audio?: boolean;
  draft?: boolean;
  draftJobId?: string;
  codec?: 'auto' | 'H264' | 'H265';
  bitrateMode?: 'standard' | 'high';
  promptExpansion?: boolean | 'disabled' | 'none' | 'balanced' | 'quality';
  thinkingLevel?: 'minimal' | 'medium' | 'high';
  systemPrompt?: string;
  grounding?: boolean;
  targetAudio?: AssetRef;
  layers?: number;
  strength?: number;
  keyframes?: Keyframe[];
  shots?: GenerationShot[];
  elements?: GenerationElement[];
  watermark?: boolean;
  promptExtend?: boolean;
  thinking?: boolean;
}
export interface GenerationRequest {
  /** Bounded private labels outside provider model input; never authority. */
  metadata?: import('./core-types').GenerationMetadata;
  modelId: string;
  operation: Operation;
  input: GenerationArguments;
  billing?: 'managed' | 'byok';
  /** Explicit acknowledgement of a disclosed generation fee policy. */
  feeAcceptance?: { policyId: string; policyVersion: number };
  routing?: RoutingPolicy;
  routeId?: string;
  maxCostMicros?: number;
  /** Local queue-start boundary only; accepted provider work is never cancelled by this deadline. */
  queueStartDeadlineAt?: string;
  /** Owned stateful continuation; the executor pins the original regional deployment. */
  previousJobId?: string;
}
export interface GenerationIssue {
  code:
    | 'unsupported_operation'
    | 'unsupported_argument'
    | 'required_argument'
    | 'invalid_value'
    | 'too_many_references'
    | 'unsupported_reference_type'
    | 'incompatible_combination'
    | 'unsupported_resolution'
    | 'unsupported_duration'
    | 'unsupported_aspect_ratio'
    | 'route_model_mismatch'
    | 'unverified_capability';
  field: string;
  message: string;
  limit?: number | string;
  received?: number | string;
}
export interface GenerationCapabilities {
  resolutions: readonly string[];
  aspectRatios: readonly string[];
  duration?: { minimum: number; maximum: number; integer: boolean; auto: boolean };
  references: {
    types: readonly ReferenceType[];
    maximum: Partial<Record<ReferenceType, number>>;
    totalMaximum?: number;
  };
  frames: {
    first: boolean;
    last: boolean;
    lastOnly: boolean;
    keyframesMaximum: number;
    timed: boolean;
  };
  frameReferenceMix: boolean;
  audio: 'switchable' | 'always-on' | 'unsupported' | 'unverified';
  quality?: readonly string[];
  countMaximum: number;
}
export interface GenerationDefinition {
  modelId: string;
  operation: Operation;
  modality: 'image' | 'video';
  commonArguments: readonly (keyof GenerationArguments)[];
  modelSpecificArguments: readonly (keyof GenerationArguments)[];
  defaults: GenerationArguments;
  capabilities: GenerationCapabilities;
  promptRequired: boolean;
  promptMaximum: number | null;
  verification: 'documented' | 'model-guided-partial' | 'weights-only';
  sources: readonly Source[];
  notices: readonly string[];
}

export interface GenerationExamples {
  request: GenerationRequest;
  quote: { operationId: 'quotes.single'; input: GenerationRequest };
  cli: string;
  placeholders: string[];
  notices: string[];
}
export interface GenerationProfile extends GenerationDefinition {
  inputSchema: Record<string, unknown>;
  examples: GenerationExamples;
}
