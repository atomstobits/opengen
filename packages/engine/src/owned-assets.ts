import type { OwnedAssetView } from '@media-router/contracts';
export type { OwnedAssetView } from '@media-router/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { GenerateInput, ReferenceType } from '@media-router/contracts';
import { collectGenerationAssets, mapGenerationAssets } from '@media-router/contracts/generation';
import { AssetStore, type MultipartUploadSession } from './storage.js';
import { createInputKey } from './input-media.js';
import { downloadInput } from './input-download.js';
import { originalOutputSlot, projectOutputEvidence } from './output-evidence.js';

export class AssetError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 409,
  ) {
    super(message);
    this.name = 'AssetError';
  }
}
export type OwnedAssetState =
  'prepared' | 'uploading' | 'processing' | 'ready' | 'failed' | 'expired' | 'deleted';
interface AssetRow {
  asset_key: string;
  workspace_id: string;
  state: OwnedAssetState;
  media_type: string | null;
  expected_media_type: string | null;
  expected_size: string | null;
  byte_length: string | null;
  sha256: string | null;
  upload_key: string | null;
  import_started: boolean;
  multipart_session: MultipartUploadSession | null;
  upload_expires_at: Date | null;
  staging_purged_at: Date | null;
  content_revision: string;
  source_job_id: string | null;
  source_output_index: number | null;
  expires_at: Date | null;
  delete_requested_at: Date | null;
  purged_at: Date | null;
}

export interface InputManifestEntry {
  assetKey: string;
  path: string;
  type: ReferenceType;
  sha256: string;
  byteLength: number;
  mediaType: string;
}
export interface PreparedInputs {
  id: string;
  input: GenerateInput;
  manifest: InputManifestEntry[];
  jobId: string | null;
}
export interface JobPreparedInputs extends PreparedInputs {
  /** These are current private bytes, not evidence of their contents at original admission. */
  legacyCutover?: {
    basis: 'current_private_bytes';
    originalAdmissionBytes: 'unknown';
    frozenAt: string;
  };
}
interface LegacyInputJob {
  id: string;
  request_hash: string;
  input: GenerateInput;
  status: string;
  attempt_count: number;
  upstream_id: string | null;
  created_at: Date;
}
interface PreparationRow {
  id: string;
  idempotency_key: string;
  updated_at: Date;
  request_hash: string;
  canonical_hash: string;
  state: 'processing' | 'ready' | 'failed' | 'admitted';
  input: GenerateInput | null;
  manifest: InputManifestEntry[];
  job_id: string | null;
  owner_token: string;
  lease_until: Date;
}
export function inputPreparationHash(input: unknown): string {
  const json = JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, (value as Record<string, unknown>)[key]]),
        )
      : value,
  );
  return createHash('sha256').update(json).digest('hex');
}
function notFound(): never {
  throw new AssetError('asset_not_found', 'Asset not found.', 404);
}
function view(row: AssetRow): OwnedAssetView {
  const expired = row.state === 'ready' && row.expires_at && row.expires_at.getTime() <= Date.now();
  return {
    assetKey: row.asset_key,
    state: expired ? 'expired' : row.state,
    mediaType: row.media_type,
    byteLength: row.byte_length === null ? null : Number(row.byte_length),
    sha256: row.sha256,
    expiresAt: row.expires_at?.toISOString() ?? null,
    deletionPending: row.delete_requested_at !== null && row.purged_at === null,
  };
}
function matchesRole(mediaType: string, role: ReferenceType): boolean {
  return role === 'document'
    ? /^(application|text)\//.test(mediaType)
    : mediaType.startsWith(`${role}/`);
}
function requireUsable(row: AssetRow | undefined): asserts row is AssetRow {
  if (!row) notFound();
  if (view(row).state !== 'ready' || row.delete_requested_at)
    throw new AssetError('asset_not_ready', 'The owned asset is not ready for a new generation.');
}

/** Private application service. Caller supplies a trusted authenticated workspace; no principal fields are accepted in request bodies. */
export class OwnedAssetService {
  constructor(
    readonly pool: Pool,
    readonly storage: AssetStore,
    private readonly options: {
      download?: typeof downloadInput;
      /** No hosted retention promise is implied when unset. */
      retainedInputMs?: number;
    } = {},
  ) {
    if (
      options.retainedInputMs !== undefined &&
      (!Number.isSafeInteger(options.retainedInputMs) || options.retainedInputMs < 60_000)
    )
      throw new Error('Input retention must be a positive duration of at least one minute.');
  }
  private expiry(): Date | null {
    return this.options.retainedInputMs === undefined
      ? null
      : new Date(Date.now() + this.options.retainedInputMs);
  }
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  private async claimWrite(workspaceId: string, assetKey: string): Promise<string> {
    const owner = randomUUID();
    const claimed = await this.pool.query(
      `UPDATE mr_owned_assets SET write_owner_token=$3,write_lease_until=now()+interval '300 seconds'
       WHERE workspace_id=$1 AND asset_key=$2 AND state IN ('uploading','processing')
       AND delete_requested_at IS NULL AND (write_lease_until IS NULL OR write_lease_until<=now()) RETURNING asset_key`,
      [workspaceId, assetKey, owner],
    );
    if (!claimed.rowCount)
      throw new AssetError(
        'asset_write_in_progress',
        'Asset preparation is already active or no longer available.',
      );
    return owner;
  }
  private async releaseWrite(workspaceId: string, assetKey: string, owner: string): Promise<void> {
    await this.pool.query(
      `UPDATE mr_owned_assets SET
       write_owner_token=CASE WHEN write_owner_token=$3 THEN NULL ELSE write_owner_token END,
       write_lease_until=CASE WHEN write_owner_token=$3 THEN NULL ELSE write_lease_until END,
       content_revision=content_revision+1,
       purged_at=CASE WHEN state IN ('deleted','expired','failed') THEN NULL ELSE purged_at END
       WHERE workspace_id=$1 AND asset_key=$2`,
      [workspaceId, assetKey, owner],
    );
  }
  async get(workspaceId: string, assetKey: string): Promise<OwnedAssetView> {
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2',
        [workspaceId, assetKey],
      )
    ).rows[0];
    return view(row ?? notFound());
  }
  /** Staging PUT credentials never address the eventual immutable ready object. */
  async prepareUpload(workspaceId: string, mediaType: string, size: number) {
    const upload = await this.storage.prepareUpload(workspaceId, mediaType, size);
    const assetKey = createInputKey(workspaceId, mediaType);
    await this.pool.query(
      `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,expected_media_type,expected_size,upload_key,upload_expires_at,expires_at)
       VALUES($1,$2,'uploading',$3,$4,$5,$6,now()+interval '1 day')`,
      [assetKey, workspaceId, mediaType, size, upload.key, upload.expiresAt],
    );
    return { ...upload, key: assetKey };
  }
  async completeUpload(workspaceId: string, assetKey: string): Promise<OwnedAssetView> {
    return this.finishUpload(workspaceId, assetKey);
  }
  private async finishUpload(
    workspaceId: string,
    assetKey: string,
    existingWriteOwner?: string,
  ): Promise<OwnedAssetView> {
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2',
        [workspaceId, assetKey],
      )
    ).rows[0];
    if (!row) notFound();
    if (row.state === 'ready') {
      requireUsable(row);
      return view(row);
    }
    if (
      !['uploading', 'processing'].includes(row.state) ||
      !row.upload_key ||
      (row.expires_at && row.expires_at.getTime() <= Date.now())
    )
      throw new AssetError('asset_not_ready', 'This upload can no longer be completed.');
    const writeOwner = existingWriteOwner ?? (await this.claimWrite(workspaceId, assetKey));
    await this.pool.query(
      `UPDATE mr_owned_assets SET state='processing',updated_at=now() WHERE workspace_id=$1 AND asset_key=$2 AND state='uploading'`,
      [workspaceId, assetKey],
    );
    try {
      // A retry after PUT-before-DB-commit uses the frozen object, never a later staging overwrite.
      let bytes = await this.storage.readInputIfExists(workspaceId, assetKey);
      bytes ??= await this.storage.readInput(workspaceId, row.upload_key);
      if (bytes.mediaType !== row.expected_media_type || bytes.size !== Number(row.expected_size))
        throw new AssetError(
          'upload_mismatch',
          'Uploaded content does not match its declared type and size.',
          400,
        );
      const frozen = await this.storage.writeInput(
        workspaceId,
        assetKey,
        bytes.bytes,
        bytes.mediaType,
      );
      const ready = await this.pool.query<AssetRow>(
        `UPDATE mr_owned_assets SET state='ready',media_type=$3,byte_length=$4,sha256=$5,expires_at=$6,updated_at=now()
         WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND delete_requested_at IS NULL
         AND write_owner_token=$7 AND write_lease_until>now() RETURNING *`,
        [
          workspaceId,
          assetKey,
          frozen.mediaType,
          frozen.size,
          frozen.sha256,
          this.expiry(),
          writeOwner,
        ],
      );
      if (!ready.rows[0]) return this.get(workspaceId, assetKey);
      return view(ready.rows[0]);
    } catch (error) {
      // Transient read/PUT errors remain resumable; validation failures require a new upload.
      if (error instanceof AssetError && error.code === 'upload_mismatch')
        await this.pool.query(
          `UPDATE mr_owned_assets SET state='failed',failure_code='upload_mismatch',updated_at=now() WHERE workspace_id=$1 AND asset_key=$2 AND state='processing'`,
          [workspaceId, assetKey],
        );
      throw error;
    } finally {
      if (!existingWriteOwner) await this.releaseWrite(workspaceId, assetKey, writeOwner);
    }
  }
  async prepareMultipart(workspaceId: string, mediaType: string, size: number) {
    const session = await this.storage.initiateMultipart(workspaceId, mediaType, size);
    const assetKey = createInputKey(workspaceId, mediaType);
    try {
      await this.pool.query(
        `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,expected_media_type,expected_size,upload_key,multipart_session,upload_expires_at,expires_at)
         VALUES($1,$2,'uploading',$3,$4,$5,$6,now()+interval '10 minutes',now()+interval '1 day')`,
        [assetKey, workspaceId, mediaType, size, session.key, JSON.stringify(session)],
      );
    } catch (error) {
      await this.storage.abortMultipart(workspaceId, session);
      throw error;
    }
    return { key: assetKey, partSize: session.partSize, partCount: session.partCount };
  }
  private async multipartSession(
    workspaceId: string,
    assetKey: string,
  ): Promise<MultipartUploadSession> {
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2',
        [workspaceId, assetKey],
      )
    ).rows[0];
    if (!row) notFound();
    if (
      !['uploading', 'processing'].includes(row.state) ||
      !row.multipart_session ||
      (row.expires_at && row.expires_at.getTime() <= Date.now())
    )
      throw new AssetError('upload_not_active', 'This multipart upload is no longer active.');
    return row.multipart_session;
  }
  async signMultipartPart(workspaceId: string, assetKey: string, partNumber: number) {
    const result = await this.storage.signUploadPart(
      workspaceId,
      await this.multipartSession(workspaceId, assetKey),
      partNumber,
    );
    await this.pool.query(
      'UPDATE mr_owned_assets SET upload_expires_at=GREATEST(upload_expires_at,$3) WHERE workspace_id=$1 AND asset_key=$2',
      [workspaceId, assetKey, result.expiresAt],
    );
    return result;
  }
  async resumeMultipart(workspaceId: string, assetKey: string) {
    return this.storage.resumeMultipart(
      workspaceId,
      await this.multipartSession(workspaceId, assetKey),
    );
  }
  async completeMultipart(
    workspaceId: string,
    assetKey: string,
    parts: { partNumber: number; etag: string }[],
  ) {
    const current = await this.get(workspaceId, assetKey);
    if (current.state === 'ready') return this.requireReady(workspaceId, assetKey);
    const session = await this.multipartSession(workspaceId, assetKey);
    const writeOwner = await this.claimWrite(workspaceId, assetKey);
    try {
      await this.storage.completeMultipart(workspaceId, session, parts);
      return await this.finishUpload(workspaceId, assetKey, writeOwner);
    } finally {
      await this.releaseWrite(workspaceId, assetKey, writeOwner);
    }
  }
  async abortMultipart(workspaceId: string, assetKey: string) {
    const current = await this.get(workspaceId, assetKey);
    if (current.state === 'deleted') return this.delete(workspaceId, assetKey);
    const session = await this.multipartSession(workspaceId, assetKey);
    const result = await this.delete(workspaceId, assetKey);
    await this.storage.abortMultipart(workspaceId, session);
    return result;
  }
  async requireReady(
    workspaceId: string,
    assetKey: string,
    role?: ReferenceType,
  ): Promise<OwnedAssetView> {
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2',
        [workspaceId, assetKey],
      )
    ).rows[0];
    requireUsable(row);
    if (role && !matchesRole(row.media_type!, role))
      throw new AssetError(
        'invalid_reference_type',
        'The owned asset does not match its requested media role.',
        400,
      );
    return view(row);
  }
  async importAsset(
    workspaceId: string,
    url: string,
    type: 'image' | 'video' | 'audio',
    idempotencyKey: string,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new AssetError(
        'idempotency_required',
        'Provide an Idempotency-Key of 1–200 characters.',
        400,
      );
    const prepared = await this.prepare({
      workspaceId,
      idempotencyKey: `asset-import:${createHash('sha256').update(idempotencyKey).digest('hex')}`,
      input: {
        modelId: 'opengen/input-import',
        operation: 'image-edit',
        input: { references: [{ type, asset: { url } }] },
      },
    });
    return this.requireReady(workspaceId, prepared.manifest[0]!.assetKey, type);
  }
  /** Existing accepted uses may resolve tombstoned/expired bytes until their pin is released. */
  async signForJob(workspaceId: string, jobId: string, assetKey: string) {
    const row = (
      await this.pool.query<AssetRow>(
        `SELECT a.* FROM mr_owned_assets a JOIN mr_asset_pins p USING(asset_key,workspace_id)
       WHERE a.workspace_id=$1 AND p.job_id=$2 AND a.asset_key=$3`,
        [workspaceId, jobId, assetKey],
      )
    ).rows[0];
    if (!row || row.purged_at || !row.sha256 || !row.media_type) notFound();
    return this.storage.sign(assetKey, row.media_type, 3600);
  }
  /** Read an already-admitted package only; never adopt, import or rewrite legacy input. */
  async admittedInputForJob(
    workspaceId: string,
    original: { jobId: string; requestHash: string; input: GenerateInput },
    query: Pick<PoolClient, 'query'> = this.pool,
  ): Promise<JobPreparedInputs | null> {
    const rows = (
      await query.query<PreparationRow>(
        `SELECT * FROM mr_input_preparations WHERE workspace_id=$1 AND job_id=$2 AND state='admitted' ORDER BY created_at,id LIMIT 2`,
        [workspaceId, original.jobId],
      )
    ).rows;
    if (!rows.length) return null;
    const row = rows[0]!;
    if (rows.length !== 1 || row.request_hash !== original.requestHash || !row.input)
      throw new AssetError(
        'legacy_input_conflict',
        'The existing job has an ambiguous prepared input package.',
      );
    return {
      id: row.id,
      // The accepted job owns routing/payer/operation; the package owns frozen media references.
      input: { ...original.input, input: row.input.input },
      manifest: row.manifest,
      jobId: original.jobId,
      ...(row.idempotency_key === `legacy-cutover-job:${original.jobId}`
        ? {
            legacyCutover: {
              basis: 'current_private_bytes' as const,
              originalAdmissionBytes: 'unknown' as const,
              frozenAt: row.updated_at.toISOString(),
            },
          }
        : {}),
    };
  }
  /** Resolve a job's frozen package before its first submit. This is not dispatch authority.
   * Old accepted inputs are copied once at migration cutover; original job history is never rewritten.
   * Existing upstream tasks must keep polling without calling this method. */
  async preparedInputForJob(
    workspaceId: string,
    jobId: string,
    originalInput: GenerateInput,
    options: { allowLegacyCutover?: boolean } = {},
  ): Promise<JobPreparedInputs> {
    if (
      !/^[a-zA-Z0-9_-]+$/.test(workspaceId) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(jobId)
    )
      notFound();
    const preparationKey = `legacy-cutover-job:${jobId}`;
    const sourcePrefix = `legacy-cutover:${jobId}:`;
    const unavailable = () =>
      new AssetError(
        'legacy_input_unavailable',
        'Original input bytes are unavailable or uncertain. Inspect this existing job with the operator; do not regenerate automatically.',
      );
    const readJob = async (query: Pick<PoolClient, 'query'>, lock = false) => {
      const row = (
        await query.query<LegacyInputJob>(
          `SELECT j.id,j.request_hash,j.input,j.status,j.attempt_count,j.upstream_id,j.created_at
         FROM mr_jobs j WHERE j.workspace_id=$1 AND j.id=$2${lock ? ' FOR UPDATE OF j' : ''}`,
          [workspaceId, jobId],
        )
      ).rows[0];
      if (!row) notFound();
      return row;
    };
    const initial = await readJob(this.pool);
    const originalFingerprint = inputPreparationHash(originalInput);
    if (inputPreparationHash(initial.input) !== originalFingerprint)
      throw new AssetError(
        'legacy_input_conflict',
        'The existing job input does not match this preparation.',
      );
    const sameJob = (row: LegacyInputJob) => {
      if (
        row.request_hash !== initial.request_hash ||
        inputPreparationHash(row.input) !== originalFingerprint
      )
        throw new AssetError(
          'legacy_input_conflict',
          'The existing job history changed during input cutover.',
        );
    };
    const eligible = (row: LegacyInputJob) => {
      sameJob(row);
      if (row.status !== 'queued' || row.attempt_count !== 0 || row.upstream_id !== null)
        throw new AssetError(
          'job_not_dispatchable',
          'This job is no longer awaiting its original first submission.',
        );
      if (
        !cutoverAt ||
        row.created_at.getTime() >= cutoverAt.getTime() ||
        !/^[a-f0-9]{64}$/.test(row.request_hash)
      )
        throw unavailable();
    };
    const linked = (query: Pick<PoolClient, 'query'>, job: LegacyInputJob) =>
      this.admittedInputForJob(
        workspaceId,
        {
          jobId,
          requestHash: job.request_hash,
          input: job.input,
        },
        query,
      );
    const existing = await linked(this.pool, initial);
    if (existing) return existing;
    if (options.allowLegacyCutover === false) throw unavailable();
    // Normal admitted packages do not depend on a historical migration lookup.
    // Missing cutover evidence can never authorize adoption of a newer job.
    const cutoverAt =
      (
        await this.pool.query<{ applied_at: Date }>(
          "SELECT applied_at FROM mr_migrations WHERE name='015.sql'",
        )
      ).rows[0]?.applied_at ?? null;
    eligible(initial);
    const assets = collectGenerationAssets(originalInput.input);
    if (assets.length > 64) throw unavailable();
    // A URL is not retained admission bytes. Never re-fetch it for an accepted legacy job.
    for (const { asset } of assets)
      if (!asset.assetKey || asset.url || !asset.assetKey.startsWith(`inputs/${workspaceId}/`))
        throw unavailable();
    const bySource = new Map<string, string>();
    for (const { asset, type } of assets) {
      const sourceKey = asset.assetKey!;
      const known = bySource.get(sourceKey);
      if (known) {
        const copied = await this.get(workspaceId, known);
        if (!copied.mediaType || !matchesRole(copied.mediaType, type)) throw unavailable();
        continue;
      }
      const identity = sourcePrefix + createHash('sha256').update(sourceKey).digest('hex');
      const row = await this.transaction(async (client) => {
        await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
        eligible(await readJob(client, true));
        await client.query(
          `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,source_job_id,reuse_idempotency_key,expires_at)
           VALUES($1,$2,'processing',$3,$4,now()+interval '1 day')
           ON CONFLICT(workspace_id,reuse_idempotency_key) DO NOTHING`,
          [createInputKey(workspaceId), workspaceId, jobId, identity],
        );
        return (
          await client.query<AssetRow>(
            'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND reuse_idempotency_key=$2 FOR UPDATE',
            [workspaceId, identity],
          )
        ).rows[0]!;
      });
      if (
        row.source_job_id !== jobId ||
        row.source_output_index !== null ||
        !['processing', 'ready'].includes(view(row).state) ||
        row.delete_requested_at ||
        row.purged_at
      )
        throw unavailable();
      if (row.state === 'ready') {
        const retained = await this.storage.readInputIfExists(workspaceId, row.asset_key);
        if (
          !row.import_started ||
          !retained ||
          retained.sha256 !== row.sha256 ||
          retained.size !== Number(row.byte_length) ||
          retained.mediaType !== row.media_type ||
          !matchesRole(retained.mediaType, type)
        )
          throw unavailable();
        bySource.set(sourceKey, row.asset_key);
        continue;
      }
      const owner = await this.claimWrite(workspaceId, row.asset_key);
      try {
        let frozen = await this.storage.readInputIfExists(workspaceId, row.asset_key);
        if (!frozen) {
          if (row.import_started) throw unavailable();
          const claimed = await this.pool.query(
            `UPDATE mr_owned_assets SET import_started=true,updated_at=now()
             WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND import_started=false
             AND delete_requested_at IS NULL AND write_owner_token=$3 AND write_lease_until>now()
             AND EXISTS(SELECT 1 FROM mr_jobs WHERE workspace_id=$1 AND id=$4 AND status='queued'
               AND attempt_count=0 AND upstream_id IS NULL AND request_hash=$5 AND input=$6::jsonb) RETURNING asset_key`,
            [
              workspaceId,
              row.asset_key,
              owner,
              jobId,
              initial.request_hash,
              JSON.stringify(initial.input),
            ],
          );
          if (!claimed.rowCount)
            throw new AssetError(
              'job_not_dispatchable',
              'Input cutover ownership or queued job state changed.',
            );
          let source;
          try {
            source = await this.storage.readInput(workspaceId, sourceKey);
          } catch {
            throw unavailable();
          }
          if (!matchesRole(source.mediaType, type)) throw unavailable();
          // Persist current-copy facts before PUT so retained-byte recovery can verify them.
          const facts = await this.pool.query(
            `UPDATE mr_owned_assets SET media_type=$4,byte_length=$5,sha256=$6,updated_at=now()
             WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND delete_requested_at IS NULL
             AND write_owner_token=$3 AND write_lease_until>now() RETURNING asset_key`,
            [workspaceId, row.asset_key, owner, source.mediaType, source.size, source.sha256],
          );
          if (!facts.rowCount)
            throw new AssetError('preparation_lease_lost', 'Input cutover ownership changed.');
          frozen = await this.storage.writeInput(
            workspaceId,
            row.asset_key,
            source.bytes,
            source.mediaType,
          );
        } else if (
          !row.import_started ||
          !row.sha256 ||
          !row.media_type ||
          row.byte_length === null ||
          frozen.sha256 !== row.sha256 ||
          frozen.mediaType !== row.media_type ||
          frozen.size !== Number(row.byte_length)
        )
          throw unavailable();
        if (!matchesRole(frozen.mediaType, type)) throw unavailable();
        const ready = await this.pool.query(
          `UPDATE mr_owned_assets SET state='ready',media_type=$4,byte_length=$5,sha256=$6,updated_at=now()
           WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND delete_requested_at IS NULL
           AND write_owner_token=$3 AND write_lease_until>now()
           AND EXISTS(SELECT 1 FROM mr_jobs WHERE workspace_id=$1 AND id=$7 AND status='queued'
             AND attempt_count=0 AND upstream_id IS NULL AND request_hash=$8 AND input=$9::jsonb) RETURNING asset_key`,
          [
            workspaceId,
            row.asset_key,
            owner,
            frozen.mediaType,
            frozen.size,
            frozen.sha256,
            jobId,
            initial.request_hash,
            JSON.stringify(initial.input),
          ],
        );
        if (!ready.rowCount)
          throw new AssetError(
            'job_not_dispatchable',
            'Input cutover ownership or queued job state changed.',
          );
        bySource.set(sourceKey, row.asset_key);
      } finally {
        await this.releaseWrite(workspaceId, row.asset_key, owner);
      }
    }
    const frozenInput = {
      ...originalInput,
      input: await mapGenerationAssets(originalInput.input, async (asset) => ({
        assetKey: bySource.get(asset.assetKey!)!,
      })),
    };
    const prepared = await this.prepare({
      workspaceId,
      idempotencyKey: preparationKey,
      input: frozenInput,
      requestHash: initial.request_hash,
    });
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const current = await readJob(client, true);
      eligible(current);
      await this.finalizeInTransaction(
        client,
        workspaceId,
        prepared.id,
        jobId,
        initial.request_hash,
      );
      if (bySource.size)
        await client.query(
          'UPDATE mr_owned_assets SET expires_at=$4 WHERE workspace_id=$1 AND source_job_id=$2 AND asset_key=ANY($3::text[])',
          [workspaceId, jobId, [...bySource.values()], this.expiry()],
        );
      return (await linked(client, current))!;
    });
  }
  async prepare(options: {
    workspaceId: string;
    idempotencyKey: string;
    input: GenerateInput;
    requestHash?: string;
  }): Promise<PreparedInputs> {
    const { workspaceId, idempotencyKey, input } = options;
    if (!idempotencyKey || idempotencyKey.length > 200)
      throw new AssetError(
        'idempotency_required',
        'Provide an Idempotency-Key of 1–200 characters.',
        400,
      );
    const canonicalHash = inputPreparationHash(input);
    // Trusted engine supplies its ORIGINAL request/metadata hash before canonical normalization.
    // Public handlers never accept this option from a caller body.
    const hash = options.requestHash ?? canonicalHash;
    if (!/^[a-f0-9]{64}$/.test(hash))
      throw new AssetError(
        'preparation_hash_mismatch',
        'Preparation requires a complete request hash.',
        400,
      );
    const assets = collectGenerationAssets(input.input);
    if (assets.length > 64)
      throw new AssetError(
        'too_many_assets',
        'An input package supports at most 64 asset positions.',
        400,
      );
    const id = randomUUID(),
      owner = randomUUID();
    const inserted = await this.pool.query<PreparationRow>(
      `INSERT INTO mr_input_preparations(id,workspace_id,idempotency_key,request_hash,canonical_hash,state,owner_token,lease_until)
       VALUES($1,$2,$3,$4,$6,'processing',$5,now()+interval '120 seconds') ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,
      [id, workspaceId, idempotencyKey, hash, owner, canonicalHash],
    );
    let preparation = inserted.rows[0];
    if (!preparation) {
      const previous = (
        await this.pool.query<PreparationRow>(
          'SELECT * FROM mr_input_preparations WHERE workspace_id=$1 AND idempotency_key=$2',
          [workspaceId, idempotencyKey],
        )
      ).rows[0]!;
      if (previous.request_hash !== hash || previous.canonical_hash !== canonicalHash)
        throw new AssetError(
          'idempotency_conflict',
          'This idempotency key belongs to a different request.',
        );
      if (previous.state === 'ready' || previous.state === 'admitted')
        return {
          id: previous.id,
          input: previous.input!,
          manifest: previous.manifest,
          jobId: previous.job_id,
        };
      if (previous.state === 'failed')
        throw new AssetError(
          'input_preparation_failed',
          'Input preparation failed. No generation was admitted.',
        );
      preparation = (
        await this.pool.query<PreparationRow>(
          `UPDATE mr_input_preparations SET owner_token=$3,lease_until=now()+interval '120 seconds',updated_at=now()
         WHERE workspace_id=$1 AND id=$2 AND state='processing' AND lease_until<=now() RETURNING *`,
          [workspaceId, previous.id, owner],
        )
      ).rows[0];
      if (!preparation)
        throw new AssetError(
          'input_preparation_in_progress',
          'The same request is preparing inputs. Resume with the same idempotency key.',
        );
    }
    const preparationId = preparation.id;
    try {
      const manifest: InputManifestEntry[] = [];
      // Sequential imports bound memory and preserve role/order. No transaction surrounds external I/O.
      const byPath = new Map<string, string>();
      for (const { asset, path, type } of assets) {
        await this.refreshLease(workspaceId, preparationId, owner);
        let ready: OwnedAssetView;
        if ('assetKey' in asset && asset.assetKey) {
          ready = await this.requireReady(workspaceId, asset.assetKey, type);
        } else if ('url' in asset && asset.url) {
          const candidateKey = createInputKey(workspaceId);
          const urlHash = createHash('sha256').update(asset.url).digest('hex');
          // Unknown-type import keys are opaque; actual content facts come from bytes.
          await this.pool.query(
            `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,preparation_id,preparation_path,source_url_hash)
             VALUES($1,$2,'processing',$3,$4,$5) ON CONFLICT(preparation_id,source_url_hash) DO NOTHING`,
            [candidateKey, workspaceId, preparationId, path, urlHash],
          );
          const row = (
            await this.pool.query<AssetRow>(
              'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND preparation_id=$2 AND source_url_hash=$3',
              [workspaceId, preparationId, urlHash],
            )
          ).rows[0]!;
          if (row.state === 'ready')
            ready = await this.requireReady(workspaceId, row.asset_key, type);
          else {
            const writeOwner = await this.claimWrite(workspaceId, row.asset_key);
            try {
              let frozen = await this.storage.readInputIfExists(workspaceId, row.asset_key);
              if (!frozen) {
                if (row.import_started)
                  throw new AssetError(
                    'import_outcome_unknown',
                    'An interrupted import has no frozen bytes. It cannot be fetched again under this preparation.',
                  );
                const claimed = await this.pool.query(
                  `UPDATE mr_owned_assets SET import_started=true,updated_at=now()
                 WHERE asset_key=$1 AND import_started=false AND state='processing' AND delete_requested_at IS NULL
                 AND write_owner_token=$5 AND write_lease_until>now() AND EXISTS(
                 SELECT 1 FROM mr_input_preparations WHERE id=$2 AND workspace_id=$3
                 AND owner_token=$4 AND state='processing' AND lease_until>now()) RETURNING asset_key`,
                  [row.asset_key, preparationId, workspaceId, owner, writeOwner],
                );
                if (!claimed.rowCount)
                  throw new AssetError(
                    'import_already_claimed',
                    'The input import is already claimed.',
                  );
                const source = await (this.options.download ?? downloadInput)(asset.url);
                if (!matchesRole(source.mediaType, type))
                  throw new AssetError(
                    'invalid_reference_type',
                    'Imported content does not match its requested media role.',
                    400,
                  );
                frozen = await this.storage.writeInput(
                  workspaceId,
                  row.asset_key,
                  source.bytes,
                  source.mediaType,
                );
              }
              if (!matchesRole(frozen.mediaType, type))
                throw new AssetError(
                  'invalid_reference_type',
                  'Imported content does not match its requested media role.',
                  400,
                );
              await this.refreshLease(workspaceId, preparationId, owner);
              await this.pool.query(
                `UPDATE mr_owned_assets SET state='ready',media_type=$3,byte_length=$4,sha256=$5,expires_at=$6,updated_at=now()
               WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND delete_requested_at IS NULL
               AND write_owner_token=$7 AND write_lease_until>now()`,
                [
                  workspaceId,
                  row.asset_key,
                  frozen.mediaType,
                  frozen.size,
                  frozen.sha256,
                  this.expiry(),
                  writeOwner,
                ],
              );
              ready = await this.requireReady(workspaceId, row.asset_key, type);
            } finally {
              await this.releaseWrite(workspaceId, row.asset_key, writeOwner);
            }
          }
        } else
          throw new AssetError(
            'invalid_asset',
            'Media requires one owned asset key or a public HTTPS URL.',
            400,
          );
        byPath.set(path, ready.assetKey);
        manifest.push({
          assetKey: ready.assetKey,
          path,
          type,
          sha256: ready.sha256!,
          byteLength: ready.byteLength!,
          mediaType: ready.mediaType!,
        });
      }
      const frozenInput = {
        ...input,
        input: await mapGenerationAssets(input.input, async (_asset, context) => ({
          assetKey: byPath.get(context.path)!,
        })),
      };
      const updated = await this.pool.query(
        `UPDATE mr_input_preparations SET state='ready',input=$4,manifest=$5,updated_at=now()
         WHERE workspace_id=$1 AND id=$2 AND owner_token=$3 AND state='processing' AND lease_until>now() RETURNING id`,
        [workspaceId, preparationId, owner, JSON.stringify(frozenInput), JSON.stringify(manifest)],
      );
      if (!updated.rowCount)
        throw new AssetError(
          'preparation_lease_lost',
          'Input preparation ownership changed. Resume the original request.',
        );
      return { id: preparationId, input: frozenInput, manifest, jobId: null };
    } catch (error) {
      const failed = await this.pool.query(
        `UPDATE mr_input_preparations SET state='failed',failure_code='input_preparation_failed',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND owner_token=$3 AND state='processing' RETURNING id`,
        [workspaceId, preparationId, owner],
      );
      if (failed.rowCount)
        await this.pool.query(
          `UPDATE mr_owned_assets SET state='failed',failure_code='input_preparation_failed',updated_at=now() WHERE workspace_id=$1 AND preparation_id=$2 AND state IN ('processing','ready')`,
          [workspaceId, preparationId],
        );
      if (
        error instanceof AssetError &&
        ['invalid_reference_type', 'asset_not_ready', 'asset_not_found', 'invalid_asset'].includes(
          error.code,
        )
      )
        throw error;
      throw new AssetError(
        'input_preparation_failed',
        'Input preparation failed. No generation was admitted.',
        422,
      );
    }
  }
  private async refreshLease(workspaceId: string, preparationId: string, owner: string) {
    const result = await this.pool.query(
      `UPDATE mr_input_preparations SET lease_until=now()+interval '120 seconds',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND owner_token=$3 AND state='processing' AND lease_until>now() RETURNING id`,
      [workspaceId, preparationId, owner],
    );
    if (!result.rowCount)
      throw new AssetError('preparation_lease_lost', 'Input preparation ownership changed.');
  }
  /** Invoke inside the SAME transaction that inserts the job/reservation, after authority/quote revalidation. */
  async finalizeInTransaction(
    client: PoolClient,
    workspaceId: string,
    preparationId: string,
    jobId: string,
    requestHash: string,
  ): Promise<void> {
    const row = (
      await client.query<PreparationRow>(
        'SELECT * FROM mr_input_preparations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
        [workspaceId, preparationId],
      )
    ).rows[0];
    if (!row || row.request_hash !== requestHash || !['ready', 'admitted'].includes(row.state))
      throw new AssetError(
        'preparation_not_ready',
        'The prepared request is not ready for admission.',
      );
    if (row.state === 'admitted') {
      if (row.job_id !== jobId)
        throw new AssetError(
          'preparation_already_admitted',
          'This input preparation already belongs to a generation.',
        );
      return;
    }
    const job = (
      await client.query(
        'SELECT id FROM mr_jobs WHERE workspace_id=$1 AND id=$2 AND request_hash=$3',
        [workspaceId, jobId, requestHash],
      )
    ).rows[0];
    if (!job) throw new AssetError('job_not_found', 'Generation not found.', 404);
    // Consistent key order prevents overlapping multi-asset admission/deletion deadlocks.
    for (const key of [...new Set(row.manifest.map((asset) => asset.assetKey))].sort()) {
      const owned = (
        await client.query<AssetRow>(
          'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2 FOR UPDATE',
          [workspaceId, key],
        )
      ).rows[0];
      requireUsable(owned);
      const manifest = row.manifest.filter((asset) => asset.assetKey === key);
      if (
        manifest.some(
          (asset) =>
            asset.sha256 !== owned.sha256 || asset.byteLength !== Number(owned.byte_length),
        )
      )
        throw new AssetError('asset_changed', 'Prepared input facts changed before admission.');
      await client.query(
        'INSERT INTO mr_asset_pins(asset_key,workspace_id,job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [key, workspaceId, jobId],
      );
    }
    await client.query(
      `UPDATE mr_input_preparations SET state='admitted',job_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, preparationId, jobId],
    );
  }
  /** Reuse accepts identity + slot, never a caller-provided output storage key or URL. */
  async reuse(
    workspaceId: string,
    sourceJobId: string,
    outputIndex: number,
    idempotencyKey: string,
  ): Promise<OwnedAssetView> {
    if (
      !Number.isInteger(outputIndex) ||
      outputIndex < 0 ||
      outputIndex > 63 ||
      !idempotencyKey ||
      idempotencyKey.length > 200
    )
      throw new AssetError(
        'invalid_reuse',
        'Provide a valid output slot and idempotency key.',
        400,
      );
    const source = (
      await this.pool.query<{
        outputs: {
          outputIndex?: number;
          storageKey?: string;
          mediaType: string;
          sha256?: string;
          byteLength?: number;
        }[];
        status: string;
        delivery_status: string;
        output_evidence: unknown;
      }>(
        'SELECT outputs,status,delivery_status,output_evidence FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
        [workspaceId, sourceJobId],
      )
    ).rows[0];
    const evidence = projectOutputEvidence(source?.output_evidence);
    const position = source?.outputs.findIndex(
      (output, index) => originalOutputSlot(output, index, evidence) === outputIndex,
    );
    const output = position !== undefined ? source?.outputs[position] : undefined;
    const unusable = evidence.some(
      (item) =>
        item.outputIndex === position &&
        (item.inspection.decode.status === 'failed' ||
          item.inspection.conformance.status === 'nonconformant'),
    );
    if (
      source?.status !== 'succeeded' ||
      !['available', 'partial'].includes(source.delivery_status) ||
      !output?.storageKey ||
      unusable
    )
      notFound();
    const key = createInputKey(workspaceId, output.mediaType);
    await this.pool.query(
      `INSERT INTO mr_owned_assets(asset_key,workspace_id,state,source_job_id,source_output_index,reuse_idempotency_key)
       VALUES($1,$2,'processing',$3,$4,$5) ON CONFLICT(workspace_id,reuse_idempotency_key) DO NOTHING`,
      [key, workspaceId, sourceJobId, outputIndex, idempotencyKey],
    );
    const row = (
      await this.pool.query<AssetRow>(
        'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND reuse_idempotency_key=$2',
        [workspaceId, idempotencyKey],
      )
    ).rows[0]!;
    if (row.source_job_id !== sourceJobId || row.source_output_index !== outputIndex)
      throw new AssetError(
        'idempotency_conflict',
        'This idempotency key belongs to a different reuse request.',
      );
    if (row.state === 'ready') {
      requireUsable(row);
      return view(row);
    }
    if (row.state !== 'processing')
      throw new AssetError('asset_not_ready', 'The reused asset is no longer available.');
    const writeOwner = await this.claimWrite(workspaceId, row.asset_key);
    try {
      const existing = await this.storage.readInputIfExists(workspaceId, row.asset_key);
      const original =
        existing ?? (await this.storage.readOwnedOutput(sourceJobId, output.storageKey));
      if (
        original.mediaType !== output.mediaType ||
        (output.sha256 !== undefined && original.sha256 !== output.sha256) ||
        (output.byteLength !== undefined && original.size !== output.byteLength)
      )
        throw new AssetError(
          'invalid_output',
          'The retained output does not match its recorded type.',
          422,
        );
      const frozen = await this.storage.writeInput(
        workspaceId,
        row.asset_key,
        original.bytes,
        original.mediaType,
      );
      await this.pool.query(
        `UPDATE mr_owned_assets SET state='ready',media_type=$3,byte_length=$4,sha256=$5,expires_at=$6,updated_at=now()
       WHERE workspace_id=$1 AND asset_key=$2 AND state='processing' AND delete_requested_at IS NULL
       AND write_owner_token=$7 AND write_lease_until>now()`,
        [
          workspaceId,
          row.asset_key,
          frozen.mediaType,
          frozen.size,
          frozen.sha256,
          this.expiry(),
          writeOwner,
        ],
      );
      return this.get(workspaceId, row.asset_key);
    } finally {
      await this.releaseWrite(workspaceId, row.asset_key, writeOwner);
    }
  }
  /** Tombstone immediately for new reads/admission; accepted job pins retain bytes. */
  async delete(
    workspaceId: string,
    assetKey: string,
  ): Promise<{ state: 'deleted'; inUse: boolean }> {
    return this.transaction(async (client) => {
      const row = (
        await client.query<AssetRow>(
          'SELECT * FROM mr_owned_assets WHERE workspace_id=$1 AND asset_key=$2 FOR UPDATE',
          [workspaceId, assetKey],
        )
      ).rows[0];
      if (!row) notFound();
      await client.query(
        `UPDATE mr_owned_assets SET state='deleted',delete_requested_at=COALESCE(delete_requested_at,now()),updated_at=now() WHERE workspace_id=$1 AND asset_key=$2`,
        [workspaceId, assetKey],
      );
      const pins = await client.query(
        'SELECT 1 FROM mr_asset_pins WHERE workspace_id=$1 AND asset_key=$2 LIMIT 1',
        [workspaceId, assetKey],
      );
      return { state: 'deleted', inUse: Boolean(pins.rowCount) };
    });
  }
  /** Only call when worker/delivery no longer needs inputs; never release on cancellation request or unknown acceptance. */
  async releaseJobPins(client: PoolClient, workspaceId: string, jobId: string): Promise<void> {
    await client.query(
      `DELETE FROM mr_asset_pins p USING mr_jobs j
      WHERE p.workspace_id=$1 AND p.job_id=$2 AND j.id=p.job_id AND j.workspace_id=p.workspace_id
      AND j.status IN ('succeeded','failed','cancelled')`,
      [workspaceId, jobId],
    );
  }
  /** Bounded sweeper; deletes no accounting, preparation, lineage, or idempotency records. */
  async cleanup(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500)
      throw new Error('Invalid cleanup limit.');
    // Ready objects no longer need staging. Wait until all issued upload capabilities expire.
    const stages = (
      await this.pool.query<AssetRow>(
        `SELECT * FROM mr_owned_assets WHERE state='ready' AND upload_key IS NOT NULL
       AND staging_purged_at IS NULL AND upload_expires_at<=now() ORDER BY created_at,asset_key LIMIT $1`,
        [limit],
      )
    ).rows;
    for (const stage of stages) {
      try {
        await this.storage.removeUpload(stage.workspace_id, stage.upload_key!);
        await this.pool.query(
          'UPDATE mr_owned_assets SET staging_purged_at=now() WHERE asset_key=$1',
          [stage.asset_key],
        );
      } catch {
        /* Retry after a storage outage. */
      }
    }
    const candidates = (
      await this.pool.query<AssetRow>(
        `SELECT a.* FROM mr_owned_assets a WHERE purged_at IS NULL AND
       (state IN ('deleted','failed','expired') OR expires_at<=now())
       AND (upload_key IS NULL OR upload_expires_at<=now())
       AND (write_lease_until IS NULL OR write_lease_until<=now())
       AND NOT EXISTS(SELECT 1 FROM mr_asset_pins p WHERE p.asset_key=a.asset_key)
       ORDER BY a.created_at,a.asset_key LIMIT $1`,
        [limit],
      )
    ).rows;
    let count = 0;
    for (const candidate of candidates) {
      // Mark under lock before I/O so admission cannot pin between eligibility and deletion.
      const tombstoned = await this.transaction(async (client) => {
        const row = (
          await client.query<AssetRow>(
            'SELECT * FROM mr_owned_assets WHERE asset_key=$1 FOR UPDATE',
            [candidate.asset_key],
          )
        ).rows[0];
        if (!row || row.purged_at) return null;
        const writer = await client.query(
          'SELECT 1 FROM mr_owned_assets WHERE asset_key=$1 AND write_lease_until>now()',
          [candidate.asset_key],
        );
        if (writer.rowCount) return null;
        const pin = await client.query('SELECT 1 FROM mr_asset_pins WHERE asset_key=$1 LIMIT 1', [
          row.asset_key,
        ]);
        if (pin.rowCount) return null;
        if (
          !['deleted', 'failed', 'expired'].includes(row.state) &&
          (!row.expires_at || row.expires_at.getTime() > Date.now())
        )
          return null;
        await client.query(
          `UPDATE mr_owned_assets SET state=CASE WHEN state='deleted' THEN state ELSE 'expired' END,updated_at=now() WHERE asset_key=$1`,
          [row.asset_key],
        );
        return { revision: row.content_revision };
      });
      if (!tombstoned) continue;
      try {
        if (candidate.multipart_session && candidate.state !== 'ready')
          await this.storage.abortMultipart(candidate.workspace_id, candidate.multipart_session);
        await this.storage.removeUpload(candidate.workspace_id, candidate.asset_key);
        if (candidate.upload_key)
          await this.storage.removeUpload(candidate.workspace_id, candidate.upload_key);
        const purged = await this.pool.query(
          `UPDATE mr_owned_assets SET purged_at=now(),updated_at=now() WHERE asset_key=$1 AND content_revision=$2
           AND state IN ('deleted','failed','expired') AND (write_lease_until IS NULL OR write_lease_until<=now())`,
          [candidate.asset_key, tombstoned.revision],
        );
        if (purged.rowCount) count++;
      } catch {
        /* Leave tombstone for a later bounded retry; no content/error URL in logs. */
      }
    }
    return count;
  }
}
