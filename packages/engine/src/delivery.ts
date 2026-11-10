import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { AssetStore } from './storage.js';
import {
  collectOutputBytes,
  detectedMediaType,
  outputLimitBytes,
  readPublicAsset,
} from './output.js';
import { inspectOutput, type OutputInspection } from './inspection.js';
import { verifyC2pa, type ProvenanceOptions } from './provenance.js';
import type { OutputAsset } from '@media-router/contracts';
import { projectOutputEvidence, type OutputEvidence } from './output-evidence.js';

/** Private recovery data. Never include in a Job DTO, event, trace or public error. */
export type DeliverySource =
  | { kind: 'url'; url: string; mediaType: string; expiresAt?: string; refreshable?: boolean }
  | { kind: 'inline'; bytes: Uint8Array; mediaType: string }
  | { kind: 'owned'; storageKey: string; mediaType: string };
export interface DeliveryScope {
  workspaceId: string;
  jobId: string;
  attempt: number;
  routeId: string;
  deploymentId: string;
  upstreamId: string | null;
  /** Trusted frozen credential connection identity; never a key or caller body value. */
  providerConnectionId?: string | null;
}
type Query = Pick<PoolClient, 'query'>;
export interface DeliveryDatabase extends Query {
  transaction<T>(operation: (client: Query) => Promise<T>): Promise<T>;
}
export function deliveryDatabase(pool: Pool): DeliveryDatabase {
  return {
    query: pool.query.bind(pool),
    async transaction(operation) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
export interface DeliveryStorage {
  read(key: string): Promise<Buffer | null>;
  /** Must preserve existing bytes. A duplicate write may not replace retained output. */
  putIfAbsent(key: string, bytes: Buffer, mediaType: string): Promise<void>;
}
export function deliveryStorage(storage: AssetStore): DeliveryStorage {
  return {
    async read(key) {
      try {
        const value = await storage.client.send(
          new GetObjectCommand({ Bucket: storage.bucket, Key: key }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );
        if (!value.Body || (value.ContentLength ?? 0) > outputLimitBytes)
          throw new Error('Invalid retained output.');
        return await collectOutputBytes(value.Body as AsyncIterable<Uint8Array>);
      } catch (error) {
        if (
          (error as { name?: string }).name === 'NoSuchKey' ||
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404
        )
          return null;
        throw new Error('Private output storage unavailable.');
      }
    },
    async putIfAbsent(key, bytes, mediaType) {
      try {
        await storage.writeCreateOnly(key, bytes, mediaType, AbortSignal.timeout(30_000));
      } catch (error) {
        if (
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412
        )
          throw new Error('Private output storage unavailable.');
      }
    },
  };
}
const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};
const maxSlots = 20;
export interface DeliveryReceipt {
  id: string;
  workspace_id: string;
  job_id: string;
  attempt: number;
  route_id: string;
  deployment_id: string;
  upstream_id: string | null;
  provider_connection_id: string | null;
  slot: number;
  kind: DeliverySource['kind'];
  media_type: string;
  source_url: string | null;
  source_key: string | null;
  inline_bytes: Buffer | null;
  source_expires_at: Date | null;
  refreshable: boolean;
  object_key: string;
  state: 'pending' | 'available' | 'failed' | 'expired';
  attempts: number;
  lease_token: string | null;
  lease_until: Date | null;
  next_attempt_at: Date;
  error_code: string | null;
  sha256: string | null;
  byte_length: number | null;
  evidence: unknown;
}
export interface DeliveryOptions {
  /** Trusted immutable runtime fence; disabled recovery never claims or changes a receipt. */
  recoveryEnabled?: boolean;
  storage?: DeliveryStorage;
  /** Authentication is resolved from the frozen attempt, never persisted in receipts. */
  download?: (
    source: Extract<DeliverySource, { kind: 'url' }>,
    scope: DeliveryScope,
  ) => Promise<Buffer>;
  /** Only look up the original upstream job; may never create another generation. */
  refresh?: (
    scope: DeliveryScope,
    slot: number,
  ) => Promise<Extract<DeliverySource, { kind: 'url' }>>;
  inspect?: (bytes: Buffer, mediaType: string, scope: DeliveryScope) => Promise<OutputInspection>;
  provenance?: ProvenanceOptions;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
}
const scopeOf = (row: DeliveryReceipt): DeliveryScope => ({
  workspaceId: row.workspace_id,
  jobId: row.job_id,
  attempt: row.attempt,
  routeId: row.route_id,
  deploymentId: row.deployment_id,
  upstreamId: row.upstream_id,
  ...(row.provider_connection_id ? { providerConnectionId: row.provider_connection_id } : {}),
});
const identity = (scope: DeliveryScope) => [
  scope.workspaceId,
  scope.jobId,
  scope.attempt,
  scope.routeId,
  scope.deploymentId,
  scope.upstreamId,
];
const matches = `j.workspace_id=$1 AND j.id=$2 AND j.attempt_count=$3 AND j.route_snapshot->>'id'=$4 AND j.deployment_snapshot->>'id'=$5 AND j.upstream_id IS NOT DISTINCT FROM $6`;
function safeError(code: string) {
  return Object.assign(new Error(code), { code });
}
function outputKey(scope: DeliveryScope, slot: number, mediaType: string) {
  const hex = createHash('sha256')
    .update(JSON.stringify([...identity(scope), slot]))
    .digest('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  return `outputs/${scope.jobId}/${id}.${extensions[mediaType]}`;
}
function sourceHash(source: DeliverySource): string {
  // Normalize optional fields/property order; retained descriptors never change on replay.
  const hash = createHash('sha256').update(JSON.stringify([source.kind, source.mediaType]));
  return source.kind === 'inline'
    ? hash.update(source.bytes).digest('hex')
    : hash
        .update(
          JSON.stringify(
            source.kind === 'owned'
              ? [source.storageKey]
              : [source.url, source.expiresAt ?? null, source.refreshable === true],
          ),
        )
        .digest('hex');
}
/** Recovery has no adapter.submit, reservation, settlement or event dependency. */
export class DeliveryStore {
  private readonly recoveryEnabled: boolean;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  constructor(
    readonly db: DeliveryDatabase,
    readonly options: DeliveryOptions = {},
  ) {
    if (options.recoveryEnabled !== undefined && typeof options.recoveryEnabled !== 'boolean')
      throw new Error('Invalid delivery recovery configuration.');
    this.recoveryEnabled = options.recoveryEnabled ?? true;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 120_000;
    this.maxAttempts = options.maxAttempts ?? 8;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 1000 ||
      this.leaseMs > 600_000 ||
      !Number.isSafeInteger(this.maxAttempts) ||
      this.maxAttempts < 1 ||
      this.maxAttempts > 20
    )
      throw new Error('Invalid delivery bounds.');
  }
  async capture(scope: DeliveryScope, sources: DeliverySource[]): Promise<void> {
    if (
      !Number.isInteger(scope.attempt) ||
      scope.attempt < 1 ||
      !sources.length ||
      sources.length > maxSlots
    )
      throw safeError('invalid_delivery_receipt');
    if (
      scope.providerConnectionId &&
      (scope.providerConnectionId.length > 200 ||
        !/^[a-zA-Z0-9_:-]+$/.test(scope.providerConnectionId))
    )
      throw safeError('invalid_delivery_receipt');
    let inlineSize = 0;
    for (const source of sources) {
      if (!extensions[source.mediaType]) throw safeError('invalid_delivery_receipt');
      if (source.kind === 'inline') {
        inlineSize += source.bytes.byteLength;
        if (
          !source.bytes.byteLength ||
          inlineSize > outputLimitBytes ||
          detectedMediaType(source.bytes) !== source.mediaType
        )
          throw safeError('invalid_delivery_receipt');
      } else if (source.kind === 'url') {
        const url = new URL(source.url);
        if (
          source.url.length > 8192 ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          (source.expiresAt && !Number.isFinite(Date.parse(source.expiresAt))) ||
          (source.refreshable && !scope.upstreamId)
        )
          throw safeError('invalid_delivery_receipt');
      } else if (
        !source.storageKey.startsWith(`outputs/${scope.jobId}/`) ||
        !/^outputs\/[a-f0-9-]+\/[a-f0-9-]+\.(png|jpg|webp|mp4)$/.test(source.storageKey)
      )
        throw safeError('invalid_delivery_receipt');
    }
    await this.db.transaction(async (client) => {
      const current = await client.query(
        `SELECT j.id FROM mr_jobs j WHERE ${matches} FOR UPDATE`,
        identity(scope),
      );
      if (!current.rows.length) throw safeError('delivery_attempt_mismatch');
      const existing = await client.query(
        'SELECT slot,source_hash,provider_connection_id FROM mr_output_receipts WHERE job_id=$1 AND attempt=$2 ORDER BY slot',
        [scope.jobId, scope.attempt],
      );
      if (
        existing.rows.length &&
        (existing.rows.length !== sources.length ||
          existing.rows.some(
            (row, slot) =>
              row.slot !== slot ||
              row.source_hash !== sourceHash(sources[slot]!) ||
              row.provider_connection_id !== (scope.providerConnectionId ?? null),
          ))
      )
        throw safeError('delivery_receipt_conflict');
      for (const [slot, source] of sources.entries()) {
        await client.query(
          `INSERT INTO mr_output_receipts(id,workspace_id,job_id,attempt,route_id,deployment_id,upstream_id,slot,kind,media_type,source_url,source_key,inline_bytes,source_expires_at,refreshable,object_key,source_hash,next_attempt_at,provider_connection_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) ON CONFLICT(job_id,attempt,slot) DO NOTHING`,
          [
            randomUUID(),
            ...identity(scope),
            slot,
            source.kind,
            source.mediaType,
            source.kind === 'url' ? source.url : null,
            source.kind === 'owned' ? source.storageKey : null,
            source.kind === 'inline' ? Buffer.from(source.bytes) : null,
            source.kind === 'url' ? (source.expiresAt ?? null) : null,
            source.kind === 'url' && source.refreshable === true,
            outputKey(scope, slot, source.mediaType),
            sourceHash(source),
            this.now(),
            scope.providerConnectionId ?? null,
          ],
        );
      }
    });
  }
  /** Private authorized view. Customer projection must use only owned object metadata. */
  async receipts(workspaceId: string, jobId: string): Promise<DeliveryReceipt[]> {
    const result = await this.db.query<DeliveryReceipt>(
      'SELECT r.* FROM mr_output_receipts r JOIN mr_jobs j ON j.id=r.job_id AND j.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.job_id=$2 ORDER BY r.attempt,r.slot',
      [workspaceId, jobId],
    );
    return result.rows;
  }
  /** Internal reconciliation result; sign after workspace authorization before customer delivery. */
  async result(scope: DeliveryScope): Promise<{
    deliveryStatus: 'pending' | 'available' | 'partial' | 'failed' | 'expired';
    outputs: OutputAsset[];
    deliveryErrors: { index: number; code: string }[];
    outputEvidence: OutputEvidence[];
  }> {
    const current = await this.db.query(
      `SELECT j.id FROM mr_jobs j WHERE ${matches}`,
      identity(scope),
    );
    if (!current.rows.length) throw safeError('delivery_attempt_mismatch');
    const receipts = (await this.receipts(scope.workspaceId, scope.jobId)).filter(
      (row) => row.attempt === scope.attempt,
    );
    const ready = receipts.filter((row) => row.state === 'available');
    const pending = receipts.some((row) => row.state === 'pending');
    return {
      deliveryStatus: !receipts.length
        ? 'pending'
        : ready.length === receipts.length
          ? 'available'
          : ready.length
            ? 'partial'
            : pending
              ? 'pending'
              : receipts.some((row) => row.state === 'expired')
                ? 'expired'
                : 'failed',
      outputs: ready.map((row) => ({
        outputIndex: row.slot,
        storageKey: row.object_key,
        url: '',
        mediaType: row.media_type,
        fidelity: 'unverified',
        sha256: row.sha256!,
        byteLength: row.byte_length!,
        c2pa: (row.evidence as { c2pa?: OutputAsset['c2pa'] } | null)?.c2pa,
      })),
      outputEvidence: projectOutputEvidence(
        receipts.map((row) => ({
          index: row.slot,
          state: row.state,
          outputIndex: row.state === 'available' ? ready.indexOf(row) : null,
          code: row.error_code ?? undefined,
          inspection: (row.evidence as { inspection?: unknown } | null)?.inspection,
        })),
      ),
      deliveryErrors: receipts
        .filter((row) => row.error_code)
        .map((row) => ({ index: row.slot, code: row.error_code! })),
    };
  }
  private async claim(): Promise<DeliveryReceipt | null> {
    return this.db.transaction(async (client) => {
      // Superseded work cannot be used to replace the current attempt's outputs.
      await client.query(
        `UPDATE mr_output_receipts r SET state='failed',error_code='attempt_changed',inline_bytes=NULL,source_url=NULL,lease_token=NULL,lease_until=NULL WHERE r.state='pending' AND NOT EXISTS(SELECT 1 FROM mr_jobs j WHERE j.id=r.job_id AND j.workspace_id=r.workspace_id AND j.attempt_count=r.attempt AND j.route_snapshot->>'id'=r.route_id AND j.deployment_snapshot->>'id'=r.deployment_id AND j.upstream_id IS NOT DISTINCT FROM r.upstream_id)`,
      );
      const result = await client.query<DeliveryReceipt>(
        `SELECT * FROM mr_output_receipts WHERE state='pending' AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until <= $1) ORDER BY next_attempt_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [this.now()],
      );
      const row = result.rows[0];
      if (!row) return null;
      const token = randomUUID();
      // 21 is the saturated exhaustion marker; source retrieval stops at maxAttempts.
      // Retained-object finalization stays possible across repeated database outages.
      const claimed = await client.query<DeliveryReceipt>(
        'UPDATE mr_output_receipts SET lease_token=$2,lease_until=$3,attempts=LEAST(attempts+1,21) WHERE id=$1 RETURNING *',
        [row.id, token, new Date(this.now().getTime() + this.leaseMs)],
      );
      return claimed.rows[0]!;
    });
  }
  async recoverOne(): Promise<boolean> {
    if (!this.recoveryEnabled) return false;
    const receipt = await this.claim();
    if (!receipt) return false;
    const scope = scopeOf(receipt);
    try {
      if (!this.options.storage) throw safeError('storage_unavailable');
      let bytes = await this.options.storage.read(receipt.object_key);
      // A crash after PUT can be committed from retained bytes without contacting the source again.
      if (!bytes) {
        if (receipt.attempts > this.maxAttempts) throw safeError('delivery_retry_exhausted');
        if (receipt.kind === 'inline') {
          if (!receipt.inline_bytes) throw safeError('inline_output_lost');
          bytes = Buffer.from(receipt.inline_bytes);
        } else if (receipt.kind === 'owned') {
          bytes = await this.options.storage.read(receipt.source_key!);
          if (!bytes) throw safeError('owned_output_missing');
        } else {
          let source: Extract<DeliverySource, { kind: 'url' }> = {
            kind: 'url',
            url: receipt.source_url!,
            mediaType: receipt.media_type,
            expiresAt: receipt.source_expires_at?.toISOString(),
            refreshable: receipt.refreshable,
          };
          if (receipt.refreshable && this.options.refresh) {
            // Providers often omit capability expiry. Re-query only the same upstream job.
            source = await this.options.refresh(scope, receipt.slot);
            if (
              source.kind !== 'url' ||
              source.mediaType !== receipt.media_type ||
              (source.expiresAt &&
                (!Number.isFinite(Date.parse(source.expiresAt)) ||
                  Date.parse(source.expiresAt) <= this.now().getTime()))
            )
              throw safeError('source_expired');
            const url = new URL(source.url);
            if (
              source.url.length > 8192 ||
              url.protocol !== 'https:' ||
              url.username ||
              url.password
            )
              throw safeError('source_expired');
          } else if (receipt.source_expires_at && receipt.source_expires_at <= this.now())
            throw safeError('source_expired');
          bytes = await (
            this.options.download ?? (async (source) => (await readPublicAsset(source.url)).bytes)
          )(source, scope);
        }
        this.validateBytes(bytes, receipt.media_type);
        await this.options.storage.putIfAbsent(receipt.object_key, bytes, receipt.media_type);
        // First retained bytes win if a lease expires while an earlier worker is uploading.
        const retained = await this.options.storage.read(receipt.object_key);
        if (!retained) throw safeError('storage_unavailable');
        bytes = retained;
      }
      this.validateBytes(bytes, receipt.media_type);
      const inspection = this.options.inspect
        ? await this.options.inspect(bytes, receipt.media_type, scope)
        : await inspectOutput(bytes, receipt.media_type);
      const c2pa = await verifyC2pa(bytes, receipt.media_type, this.options.provenance);
      const evidence = { inspection, c2pa };
      const unusable =
        inspection.decode.status === 'failed'
          ? 'output_decode_failed'
          : inspection.conformance.status === 'nonconformant'
            ? 'output_nonconformant'
            : null;
      await this.db.query(
        `UPDATE mr_output_receipts r SET state=$6,sha256=$3,byte_length=$4,evidence=$5,inline_bytes=NULL,source_url=NULL,lease_token=NULL,lease_until=NULL,error_code=$7 WHERE r.id=$1 AND r.lease_token=$2 AND r.state='pending' AND EXISTS(SELECT 1 FROM mr_jobs j WHERE j.id=r.job_id AND j.workspace_id=r.workspace_id AND j.attempt_count=r.attempt AND j.route_snapshot->>'id'=r.route_id AND j.deployment_snapshot->>'id'=r.deployment_id AND j.upstream_id IS NOT DISTINCT FROM r.upstream_id)`,
        [
          receipt.id,
          receipt.lease_token,
          createHash('sha256').update(bytes).digest('hex'),
          bytes.length,
          JSON.stringify(evidence),
          unusable ? 'failed' : 'available',
          unusable,
        ],
      );
    } catch (error) {
      const allowed = new Set([
        'source_expired',
        'inline_output_lost',
        'owned_output_missing',
        'delivery_retry_exhausted',
      ]);
      const code = allowed.has((error as { code?: string }).code ?? '')
        ? (error as { code: string }).code
        : 'output_delivery_failed';
      const terminal = allowed.has(code) || receipt.attempts >= this.maxAttempts;
      await this.db.query(
        `UPDATE mr_output_receipts SET state=$3,error_code=$4,next_attempt_at=$5,lease_token=NULL,lease_until=NULL,inline_bytes=CASE WHEN $3='pending' THEN inline_bytes ELSE NULL END,source_url=CASE WHEN $3='pending' THEN source_url ELSE NULL END WHERE id=$1 AND lease_token=$2 AND state='pending'`,
        [
          receipt.id,
          receipt.lease_token,
          terminal ? (code === 'source_expired' ? 'expired' : 'failed') : 'pending',
          code,
          new Date(this.now().getTime() + Math.min(3_600_000, 1000 * 2 ** receipt.attempts)),
        ],
      );
    }
    return true;
  }
  private validateBytes(bytes: Buffer, mediaType: string) {
    if (!bytes.length || bytes.length > outputLimitBytes || detectedMediaType(bytes) !== mediaType)
      throw safeError('output_delivery_failed');
  }
}
