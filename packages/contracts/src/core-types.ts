import type { Job, JobStatus } from './index';

/** Private workspace attribution. Null means unknown legacy history, never an inferred identity. */
export interface JobAttribution {
  kind: 'api' | 'browser' | 'oauth' | 'bootstrap' | 'unknown';
  keyId: string | null;
  membershipId: string | null;
  grantId: string | null;
  clientId: string | null;
}

/** Caller metadata is immutable under the workspace idempotency key and is never public. */
export interface GenerationMetadata {
  project?: string;
  tags?: Record<string, string>;
}

export type DeliveryStatus =
  'pending' | 'available' | 'partial' | 'failed' | 'expired' | 'unverified';
export interface JobError {
  code: string;
  category: 'invalid_input' | 'policy' | 'technical' | 'unknown';
  message: string;
  retryable: boolean;
  recovery: 'same_job' | 'edit_request' | 'operator' | 'none';
  field?: string;
  providerCode?: string;
}
export interface JobProgress {
  phase: 'queued' | 'submitting' | 'running' | 'delivery' | 'complete';
  percent: number | null;
  observedAt: string;
  source: 'provider' | 'gateway';
}

/** Compact private read model: no prompt, signed asset, upstream receipt or provider credential. */
export interface JobStatusView {
  id: string;
  status: JobStatus;
  deliveryStatus: DeliveryStatus | null;
  routeId: string;
  deploymentId: string;
  createdAt: string;
  updatedAt: string;
  reservedMicros: number;
  settledMicros: number | null;
  progress?: JobProgress | null;
  structuredError?: JobError | null;
  attribution?: JobAttribution | null;
}
export interface JobHistoryQuery {
  cursor?: string;
  limit?: number;
  modelId?: string;
  providerId?: string;
  deploymentId?: string;
  endpointRegion?: string;
  operation?: Job['input']['operation'];
  keyId?: string;
  status?: JobStatus;
  project?: string;
  since?: string;
  until?: string;
}
export interface JobHistoryPage {
  items: JobStatusView[];
  nextCursor: string | null;
}

/** These states describe owned bytes, independently of a model's supported input roles. */
export type OwnedAssetState =
  'prepared' | 'uploading' | 'processing' | 'ready' | 'failed' | 'expired' | 'deleted';

/** Workspace-owned input lifecycle; readiness is separate from a model's supported media roles. */
export interface OwnedAssetView {
  assetKey: string;
  state: OwnedAssetState;
  mediaType: string | null;
  byteLength: number | null;
  sha256: string | null;
  expiresAt: string | null;
  deletionPending: boolean;
}
