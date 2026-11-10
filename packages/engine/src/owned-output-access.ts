import type { Pool } from 'pg';
import type { DeliveryStatus, JobStatus } from '@media-router/contracts';

/** Private storage metadata. Never serialize this descriptor into a customer response. */
export interface OwnedOutputDescriptor {
  storageKey: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4';
  byteLength?: number;
}
export interface OwnedOutputJob {
  id: string;
  status: JobStatus;
  deliveryStatus: DeliveryStatus | undefined;
  outputs: OwnedOutputDescriptor[];
}
type PrivateOutputRow = {
  id: unknown;
  status: unknown;
  delivery_status: unknown;
  outputs: unknown;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set<JobStatus>([
  'queued',
  'submitting',
  'running',
  'submission-unknown',
  'succeeded',
  'failed',
  'cancelled',
]);
const deliveryStatuses = new Set<DeliveryStatus>([
  'pending',
  'available',
  'partial',
  'failed',
  'expired',
  'unverified',
]);
const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
} as const;
const maximumOutputs = 15;
const maximumStoredBytes = 100 * 1024 * 1024;

function descriptor(value: unknown, jobId: string): OwnedOutputDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = value as Record<string, unknown>;
  if (
    typeof output.mediaType !== 'string' ||
    !Object.hasOwn(extensions, output.mediaType) ||
    typeof output.storageKey !== 'string'
  )
    return null;
  const mediaType = output.mediaType as OwnedOutputDescriptor['mediaType'];
  const key = output.storageKey;
  const basename = key.slice(`outputs/${jobId}/`.length);
  if (
    !key.startsWith(`outputs/${jobId}/`) ||
    !basename.endsWith(`.${extensions[mediaType]}`) ||
    !uuid.test(basename.slice(0, -(extensions[mediaType].length + 1)))
  )
    return null;
  const byteLength = output.byteLength;
  if (
    byteLength !== undefined &&
    (typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > maximumStoredBytes)
  )
    return null;
  // Allowlist metadata only: no URL, inline bytes, provider receipts, prompt or credentials.
  return {
    storageKey: key,
    mediaType,
    ...(byteLength === undefined ? {} : { byteLength: byteLength as number }),
  };
}

/**
 * Server-internal byte-delivery lookup, separate from the key-free customer Job projection.
 * Caller supplies a trusted authenticated workspace after checking its read/generate scope.
 * This service does not mint URLs, fetch media, submit work, or mutate delivery/accounting.
 */
export class OwnedOutputAccess {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async getOwnedOutputJob(workspaceId: string, jobId: string): Promise<OwnedOutputJob | null> {
    if (
      typeof workspaceId !== 'string' ||
      !workspaceId ||
      typeof jobId !== 'string' ||
      !uuid.test(jobId)
    )
      return null;
    const { rows } = await this.pool.query<PrivateOutputRow>(
      `SELECT id,status,delivery_status,outputs FROM mr_jobs
       WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
      [workspaceId, jobId],
    );
    const row = rows[0];
    if (
      !row ||
      typeof row.id !== 'string' ||
      !uuid.test(row.id) ||
      row.id.toLowerCase() !== jobId.toLowerCase() ||
      !statuses.has(row.status as JobStatus)
    )
      return null;
    const status = row.status as JobStatus;
    const deliveryStatus = deliveryStatuses.has(row.delivery_status as DeliveryStatus)
      ? (row.delivery_status as DeliveryStatus)
      : undefined;
    let outputs: OwnedOutputDescriptor[] = [];
    if (
      status === 'succeeded' &&
      deliveryStatus === 'available' &&
      Array.isArray(row.outputs) &&
      row.outputs.length > 0 &&
      row.outputs.length <= maximumOutputs
    ) {
      const candidates = row.outputs.map((value) => descriptor(value, row.id as string));
      // Do not drop malformed slots and shift indexes onto a different output.
      if (candidates.every((output): output is OwnedOutputDescriptor => output !== null))
        outputs = candidates;
    }
    return { id: row.id, status, deliveryStatus, outputs };
  }
}
