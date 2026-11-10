import { randomUUID } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import type { GenerateInput } from '@media-router/contracts';
import { createEngine, type ExecutionScope } from '../packages/engine/src/index.js';
import { inputPreparationHash } from '../packages/engine/src/owned-assets.js';
import { createInputKey } from '../packages/engine/src/input-media.js';
import { buildApp } from '../apps/server/src/app.js';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';
import {
  privateInputBytesFixture,
  privateReadyInputFixture,
  privateStorageFixture,
} from './helpers/private-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const video: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  routeId: 'alibaba/ap-southeast-1/wan-3.0',
  operation: 'text-to-video',
  billing: 'managed',
  routing: { fallback: false },
  input: {
    prompt: 'Synthetic guard fixture.',
    resolution: '480p',
    duration: 2,
    count: 1,
    aspectRatio: '16:9',
  },
};
const image: GenerateInput = {
  modelId: 'qwen/image-2.1-turbo',
  routeId: 'alibaba-model-studio-ap-southeast-1/qwen-image-2.1-turbo',
  operation: 'text-to-image',
  billing: 'managed',
  routing: { fallback: false },
  input: { prompt: 'Synthetic guard fixture.', resolution: '1K', count: 1, aspectRatio: '1:1' },
};
async function fixture() {
  const db = await isolatedEngineDatabase(databaseUrl!, 'qualification_scope');
  const storage = privateStorageFixture();
  const submit = vi.fn(async ({ jobId }: { jobId: string }) => ({
    upstreamId: `synthetic-${jobId}`,
  }));
  const poll = vi.fn(async () => ({ status: 'running' as const }));
  const download = vi.fn(async () => {
    throw new Error('No external input imports permitted.');
  });
  const instances: ReturnType<typeof createEngine>[] = [];
  const open = (executionScope: ExecutionScope) => {
    const engine = db.bind(
      createEngine({
        databaseUrl: db.databaseUrl,
        poolSize: 4,
        pollIntervalMs: 100,
        storage,
        inputDownloader: download,
        vaultKey: '0'.repeat(64),
        providerEnv: {},
        adapterCredentialIdentity: 'qualification-synthetic-v1',
        executionScope,
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (_route, deployment) =>
              deployment.id === 'alibaba-model-studio-ap-southeast-1',
            submit,
            poll,
          },
        ],
      }),
    );
    instances.push(engine);
    return engine;
  };
  const unrestricted = open({ profile: 'unrestricted' });
  try {
    await unrestricted.initialize();
    await unrestricted.ensureWorkspace('qualification_test', 10_000_000);
  } catch (error) {
    await Promise.all(instances.map((engine) => engine.close()));
    await db.close();
    throw error;
  }
  return {
    unrestricted,
    open,
    storage,
    submit,
    poll,
    download,
    workspaceId: 'qualification_test',
    async close() {
      await Promise.all(instances.map((engine) => engine.close()));
      await db.close();
    },
  };
}
async function snapshot(engine: ReturnType<typeof createEngine>, workspaceId: string) {
  return {
    balance: await engine.getBalance(workspaceId),
    ledger: await engine.ledger(workspaceId),
    counts: (
      await engine.pool.query(`SELECT
      (SELECT count(*) FROM mr_jobs) AS jobs,
      (SELECT count(*) FROM mr_attempts) AS attempts,
      (SELECT count(*) FROM mr_input_preparations) AS preparations,
      (SELECT count(*) FROM mr_dispatch_slots) AS slots,
      (SELECT count(*) FROM mr_key_reservations) AS key_reservations`)
    ).rows[0],
  };
}

describe.skipIf(!databaseUrl)('qualification scope across durable admission and dispatch', () => {
  it('short-circuits bounded UUID-key pages without full inventory or irrelevant manifests', async () => {
    const f = await fixture();
    try {
      const request = image;
      const template = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: request,
      });
      await f.unrestricted.workOnce();
      f.submit.mockClear();
      await f.unrestricted.pool.query(
        `INSERT INTO mr_jobs
        (id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,fallback_routes)
        SELECT ('10000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,workspace_id,'legacy-scope-'||n,request_hash,
          input||'{"metadata":{"project":"private-label"}}'::jsonb,route_snapshot,deployment_snapshot,'queued',0,fallback_routes
        FROM mr_jobs CROSS JOIN generate_series(1,70) n WHERE id=$1`,
        [template.id],
      );
      await f.unrestricted.pool.query(
        `UPDATE mr_jobs SET input=jsonb_set(input,'{input,resolution}','"2K"') WHERE id='10000000-0000-4000-8000-000000000033'`,
      );
      const scoped = f.open({ profile: 'qualification-sg-v1' });
      const inventory = vi
        .spyOn(scoped, 'executionScopeConflicts')
        .mockRejectedValue(new Error('Explicit inventory is not the hot path.'));
      const packages = vi.spyOn(scoped.ownedAssets!, 'admittedInputForJob');
      const query = scoped.pool.query.bind(scoped.pool);
      const transfers: { count: number; input: GenerateInput }[] = [];
      const read = vi.spyOn(scoped.pool, 'query').mockImplementation((async (...args: any[]) => {
        const result = await (query as any)(...args);
        transfers.push(
          ...result.rows.map((row: { input: GenerateInput }) => ({
            count: result.rows.length,
            input: row.input,
          })),
        );
        return result;
      }) as typeof scoped.pool.query);
      expect(await scoped.hasExecutionScopeConflict()).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
      expect(transfers).toHaveLength(64);
      expect(
        transfers.every(
          (row) =>
            row.count === 32 &&
            row.input.input.prompt === undefined &&
            row.input.metadata === undefined,
        ),
      ).toBe(true);
      expect(packages).not.toHaveBeenCalled();
      expect(inventory).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('advances the bounded qualification expiry sweep past conflicting holds while accepted work polls', async () => {
    const f = await fixture();
    try {
      const accepted = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: image,
      });
      await f.unrestricted.workOnce();
      const conflicts = [];
      for (let i = 0; i < 9; i++)
        conflicts.push(
          await f.unrestricted.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: {
              ...image,
              input: { ...image.input, resolution: '2K' },
              queueStartDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
            },
          }),
        );
      await f.unrestricted.pool.query(
        "UPDATE mr_jobs SET queue_start_deadline_at=clock_timestamp()-interval '1 hour' WHERE id=ANY($1::uuid[])",
        [conflicts.map((job) => job.id)],
      );
      await f.unrestricted.pool.query(
        "UPDATE mr_dispatch_slots SET start_deadline_at=clock_timestamp()-interval '1 hour' WHERE job_id=ANY($1::uuid[])",
        [conflicts.map((job) => job.id)],
      );
      const template = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: video,
      });
      // A valid version-5 UUID that sorts after Node's version-4 IDs, with a positive reservation.
      const expiringId = 'ffffffff-ffff-5fff-bfff-ffffffffffff';
      await f.unrestricted.pool.query(
        `INSERT INTO mr_jobs
        (id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,reserved_micros,fallback_routes,queue_start_deadline_at)
        SELECT $2::uuid,workspace_id,$2::text,request_hash,input,route_snapshot,deployment_snapshot,'queued',reserved_micros,fallback_routes,clock_timestamp()-interval '1 second'
        FROM mr_jobs WHERE id=$1`,
        [template.id, expiringId],
      );
      await f.unrestricted.pool.query(
        'UPDATE mr_workspaces SET available_micros=available_micros-100000,reserved_micros=reserved_micros+100000 WHERE id=$1',
        [f.workspaceId],
      );
      await f.unrestricted.pool.query(
        `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros)
        VALUES($1,$2,$3,'reserve',100000,-100000,100000)`,
        [randomUUID(), f.workspaceId, expiringId],
      );
      const scoped = f.open({ profile: 'qualification-sg-v1' });
      const before = await scoped.getBalance(f.workspaceId);
      const originalConflicts = (
        await scoped.pool.query('SELECT * FROM mr_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [
          conflicts.map((job) => job.id),
        ])
      ).rows;
      const inventory = vi
        .spyOn(scoped, 'executionScopeConflicts')
        .mockRejectedValue(new Error('Accepted polling must not load an inventory.'));
      const existence = vi
        .spyOn(scoped, 'hasExecutionScopeConflict')
        .mockRejectedValue(new Error('Accepted polling must precede transition scanning.'));
      for (let turn = 0; turn < 2; turn++) {
        await scoped.pool.query('UPDATE mr_jobs SET next_poll_at=clock_timestamp() WHERE id=$1', [
          accepted.id,
        ]);
        expect(await scoped.workOnce()).toBe(true);
      }
      expect(f.poll).toHaveBeenCalledTimes(2);
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(inventory).not.toHaveBeenCalled();
      expect(existence).not.toHaveBeenCalled();
      expect(
        (await scoped.pool.query('SELECT status FROM mr_jobs WHERE id=$1', [expiringId])).rows[0]
          .status,
      ).toBe('failed');
      expect(await scoped.getBalance(f.workspaceId)).toEqual({
        ...before,
        availableMicros: before.availableMicros + 100_000,
        reservedMicros: before.reservedMicros - 100_000,
      });
      expect(
        (
          await scoped.pool.query('SELECT * FROM mr_jobs WHERE id=ANY($1::uuid[]) ORDER BY id', [
            conflicts.map((job) => job.id),
          ])
        ).rows,
      ).toEqual(originalConflicts);
    } finally {
      await f.close();
    }
  });

  it('retains unrestricted deadline ordering instead of the qualification scheduling cursor', async () => {
    const f = await fixture();
    try {
      const jobs = [];
      for (let i = 0; i < 2; i++)
        jobs.push(
          await f.unrestricted.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: video,
          }),
        );
      jobs.sort((a, b) => a.id.localeCompare(b.id));
      const [later, earlier] = jobs;
      await f.unrestricted.pool.query(
        "UPDATE mr_jobs SET queue_start_deadline_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
        [earlier!.id],
      );
      await f.unrestricted.pool.query(
        "UPDATE mr_jobs SET queue_start_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [later!.id],
      );
      await f.unrestricted.pool.query(
        "UPDATE mr_dispatch_slots SET start_deadline_at=clock_timestamp()-interval '1 hour' WHERE job_id=$1",
        [earlier!.id],
      );
      await f.unrestricted.pool.query(
        "UPDATE mr_dispatch_slots SET start_deadline_at=clock_timestamp()-interval '1 second' WHERE job_id=$1",
        [later!.id],
      );
      await f.unrestricted.workOnce();
      expect((await f.unrestricted.getJob(f.workspaceId, earlier!.id))?.status).toBe('failed');
      expect((await f.unrestricted.getJob(f.workspaceId, later!.id))?.status).toBe('queued');
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('diagnoses a global transition for another workspace without exposing its queue or fixture details', async () => {
    const f = await fixture();
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      const conflict = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: { ...image, input: { ...image.input, resolution: '2K' } },
      });
      const ownWorkspace = 'qualification_other';
      await f.unrestricted.ensureWorkspace(ownWorkspace, 1_000_000);
      const key = await f.unrestricted.accounts.createKey(ownWorkspace, {
        name: 'Synthetic owner diagnosis',
        scopes: ['read', 'generate'],
      });
      const scoped = f.open({ profile: 'qualification-sg-v1', firstFrameSha256: 'a'.repeat(64) });
      app = await buildApp({ engine: scoped });
      const headers = { authorization: `Bearer ${key.token}` };
      const before = await snapshot(scoped, ownWorkspace);
      const diagnosis = await app.inject({ url: '/v1/doctor', headers });
      expect(diagnosis.statusCode).toBe(200);
      expect(diagnosis.json()).toMatchObject({
        payingWorkspace: { id: ownWorkspace },
        executionScope: {
          profile: 'qualification-sg-v1',
          queuedConflicts: 0,
          transitionBlocked: true,
        },
        nextBlocker: { code: 'execution_scope_transition_required' },
      });
      expect(diagnosis.body).not.toContain(conflict.id);
      expect(diagnosis.body).not.toContain(f.workspaceId);
      expect(diagnosis.body).not.toContain('a'.repeat(64));
      expect(Object.keys(diagnosis.json().executionScope).sort()).toEqual([
        'profile',
        'queuedConflicts',
        'transitionBlocked',
      ]);
      const admission = await app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload: video,
      });
      expect(admission.statusCode).toBe(503);
      expect(admission.json().error.code).toBe('execution_scope_transition_required');
      expect(await snapshot(scoped, ownWorkspace)).toEqual(before);
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await app?.close();
      await f.close();
    }
  });

  it('dispatches an already-admitted legacy frozen copy without changing its original input or hash', async () => {
    const f = await fixture();
    try {
      const bytes = privateInputBytesFixture();
      const ready = await privateReadyInputFixture(f.unrestricted, f.workspaceId);
      const template: GenerateInput = {
        ...video,
        operation: 'image-to-video',
        input: { ...video.input, aspectRatio: 'source', firstFrame: { assetKey: ready.assetKey } },
      };
      const admitted = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: template,
      });
      const stagingKey = createInputKey(f.workspaceId, 'image/png');
      await f.storage.writeInput(f.workspaceId, stagingKey, bytes.bytes, 'image/png');
      const original: GenerateInput = {
        ...admitted.input,
        input: { ...admitted.input.input, firstFrame: { assetKey: stagingKey } },
      };
      const originalHash = inputPreparationHash(original);
      await f.unrestricted.pool.query('DELETE FROM mr_asset_pins WHERE job_id=$1', [admitted.id]);
      await f.unrestricted.pool.query('DELETE FROM mr_input_preparations WHERE job_id=$1', [
        admitted.id,
      ]);
      await f.unrestricted.pool.query(
        `UPDATE mr_jobs SET input=$2,request_hash=$3,
        created_at=(SELECT applied_at-interval '1 hour' FROM mr_migrations WHERE name='015.sql') WHERE id=$1`,
        [admitted.id, JSON.stringify(original), originalHash],
      );
      const before = (
        await f.unrestricted.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [admitted.id])
      ).rows[0];
      const beforeAdoption = f.open({
        profile: 'qualification-sg-v1',
        firstFrameSha256: bytes.sha256,
      });
      await expect(
        beforeAdoption.ownedAssets!.preparedInputForJob(f.workspaceId, admitted.id, original, {
          allowLegacyCutover: false,
        }),
      ).rejects.toMatchObject({ code: 'legacy_input_unavailable' });
      await expect(beforeAdoption.workOnce()).rejects.toMatchObject({
        code: 'execution_scope_transition_required',
      });
      expect(
        (
          await beforeAdoption.pool.query(
            'SELECT count(*) AS count FROM mr_input_preparations WHERE job_id=$1',
            [admitted.id],
          )
        ).rows[0].count,
      ).toBe('0');
      expect(
        (await beforeAdoption.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [admitted.id]))
          .rows[0],
      ).toEqual(before);
      expect(f.submit).not.toHaveBeenCalled();
      const copied = await f.unrestricted.ownedAssets!.preparedInputForJob(
        f.workspaceId,
        admitted.id,
        original,
      );
      const frozenKey = copied.input.input.firstFrame!.assetKey!;
      expect(frozenKey).not.toBe(stagingKey);
      expect(
        (await f.unrestricted.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [admitted.id]))
          .rows[0],
      ).toEqual(before);
      await f.storage.removeUpload(f.workspaceId, stagingKey);
      const scoped = f.open({ profile: 'qualification-sg-v1', firstFrameSha256: bytes.sha256 });
      const preparation = vi.spyOn(scoped.ownedAssets!, 'prepare');
      const read = vi.spyOn(f.storage, 'readInput');
      expect(await scoped.hasExecutionScopeConflict()).toBe(false);
      expect(await scoped.executionScopeConflicts()).toEqual([]);
      expect(await scoped.workOnce()).toBe(true);
      expect(f.submit).toHaveBeenCalledTimes(1);
      expect(f.submit.mock.calls[0]![0]).toMatchObject({
        jobId: admitted.id,
        input: { input: { firstFrame: { url: expect.stringContaining(frozenKey) } } },
      });
      expect(
        (
          await scoped.pool.query('SELECT input,request_hash FROM mr_jobs WHERE id=$1', [
            admitted.id,
          ])
        ).rows[0],
      ).toEqual({ input: original, request_hash: originalHash });
      expect(preparation).not.toHaveBeenCalled();
      expect(read.mock.calls.some((call) => call[1] === stagingKey)).toBe(false);
      expect(f.download).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it.each(['deleted', 'expired'] as const)(
    'continues an admitted pinned fixture after it becomes %s for new use',
    async (state) => {
      const f = await fixture();
      try {
        const source = privateInputBytesFixture();
        const scoped = f.open({ profile: 'qualification-sg-v1', firstFrameSha256: source.sha256 });
        const frame = await privateReadyInputFixture(scoped, f.workspaceId);
        const request: GenerateInput = {
          ...video,
          operation: 'image-to-video',
          input: {
            ...video.input,
            aspectRatio: 'source',
            firstFrame: { assetKey: frame.assetKey },
          },
        };
        const admitted = await scoped.submit({
          workspaceId: f.workspaceId,
          idempotencyKey: randomUUID(),
          input: request,
        });
        if (state === 'deleted')
          expect(await scoped.ownedAssets!.delete(f.workspaceId, frame.assetKey)).toMatchObject({
            inUse: true,
          });
        else
          await scoped.pool.query(
            "UPDATE mr_owned_assets SET expires_at=clock_timestamp()-interval '1 second' WHERE asset_key=$1",
            [frame.assetKey],
          );
        expect(await scoped.executableForWorkspace(f.workspaceId, request)).toEqual([]);
        const before = await snapshot(scoped, f.workspaceId);
        await expect(
          scoped.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: request,
          }),
        ).rejects.toMatchObject({ code: 'execution_scope_denied' });
        expect(await snapshot(scoped, f.workspaceId)).toEqual(before);
        expect(await scoped.executionScopeConflicts()).toEqual([]);
        expect(await scoped.workOnce()).toBe(true);
        expect(f.submit).toHaveBeenCalledTimes(1);
        expect((await scoped.getJob(f.workspaceId, admitted.id))?.status).toBe('running');
        expect(f.submit.mock.calls[0]![0]).toMatchObject({ jobId: admitted.id });
        expect(f.download).not.toHaveBeenCalled();
      } finally {
        await f.close();
      }
    },
  );

  it('rejects out-of-scope variants, equal-price sizes, payer and media before imports or reservations', async () => {
    const f = await fixture();
    try {
      const scoped = f.open({ profile: 'qualification-sg-v1' });
      const connections = vi.spyOn(scoped.accounts, 'getConnection');
      const before = await snapshot(scoped, f.workspaceId);
      for (const request of [
        { ...image, input: { ...image.input, resolution: '2K' } },
        {
          ...image,
          modelId: 'alibaba/qwen-image-2.1-pro',
          routeId: 'alibaba-model-studio-ap-southeast-1/alibaba-qwen-image-2.1-pro',
        },
        { ...video, input: { ...video.input, duration: 3 } },
        { ...video, input: { ...video.input, audio: false } },
        { ...video, billing: 'byok' },
        { ...video, routing: { fallback: true } },
        {
          ...video,
          operation: 'image-to-video',
          input: {
            ...video.input,
            aspectRatio: 'source',
            firstFrame: { url: 'https://example.invalid/external.png' },
          },
        },
      ] as GenerateInput[]) {
        await expect(
          scoped.submit({
            workspaceId: f.workspaceId,
            idempotencyKey: randomUUID(),
            input: request,
          }),
        ).rejects.toMatchObject({ code: 'execution_scope_denied' });
      }
      expect(await snapshot(scoped, f.workspaceId)).toEqual(before);
      expect(connections).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('uses verified owned bytes and frozen manifest identity for image qualification, never a URL or declared digest', async () => {
    const f = await fixture();
    try {
      // This tiny local fixture tests identity, not the operator's independent 512px/opacity qualification.
      const source = privateInputBytesFixture();
      const scoped = f.open({ profile: 'qualification-sg-v1', firstFrameSha256: source.sha256 });
      const frame = await privateReadyInputFixture(scoped, f.workspaceId);
      const request: GenerateInput = {
        ...video,
        operation: 'image-to-video',
        input: {
          ...video.input,
          aspectRatio: 'source',
          firstFrame: { assetKey: frame.assetKey },
        },
      };
      const noPin = f.open({ profile: 'qualification-sg-v1' });
      expect(await noPin.executableForWorkspace(f.workspaceId, request)).toEqual([]);
      expect(scoped.getExecutableRouteIds(request)).toEqual([]); // No workspace-owned proof in this synchronous inventory call.
      const resolved = await scoped.resolveInput(f.workspaceId, request);
      const ids = await scoped.executableForWorkspace(f.workspaceId, resolved, request);
      expect(ids).toEqual([video.routeId]);
      expect(
        scoped.quoteGeneration(resolved, { executableRouteIds: ids, scopeInput: request })
          .selectedRouteId,
      ).toBe(video.routeId);
      const before = await snapshot(scoped, f.workspaceId);
      await expect(
        noPin.submit({ workspaceId: f.workspaceId, idempotencyKey: randomUUID(), input: request }),
      ).rejects.toMatchObject({ code: 'execution_scope_denied' });
      expect(await snapshot(scoped, f.workspaceId)).toEqual(before);

      // Simulate object tampering beneath unchanged ready metadata. No real storage or media is used.
      const changed = Buffer.from(source.bytes);
      changed[changed.length - 1] ^= 1;
      await f.storage.client.send(
        new PutObjectCommand({
          Bucket: f.storage.bucket,
          Key: frame.assetKey,
          Body: changed,
          ContentType: 'image/png',
        }),
      );
      expect(await scoped.executableForWorkspace(f.workspaceId, resolved, request)).toEqual([]);
      await expect(
        scoped.submit({ workspaceId: f.workspaceId, idempotencyKey: randomUUID(), input: request }),
      ).rejects.toMatchObject({ code: 'execution_scope_denied' });
      expect(await snapshot(scoped, f.workspaceId)).toEqual(before);
      await f.storage.client.send(
        new PutObjectCommand({
          Bucket: f.storage.bucket,
          Key: frame.assetKey,
          Body: source.bytes,
          ContentType: 'image/png',
        }),
      );
      const admitted = await scoped.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: request,
      });
      expect(admitted.status).toBe('queued');

      await f.storage.client.send(
        new PutObjectCommand({
          Bucket: f.storage.bucket,
          Key: frame.assetKey,
          Body: changed,
          ContentType: 'image/png',
        }),
      );
      await scoped.workOnce();
      expect(f.submit).not.toHaveBeenCalled();
      expect(
        (await scoped.pool.query('SELECT count(*) AS count FROM mr_attempts')).rows[0].count,
      ).toBe('0');
      expect((await scoped.getJob(f.workspaceId, admitted.id))?.input).toEqual(admitted.input);
      expect(f.download).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });

  it('keeps accepted upstream work polling and original replays while blocking a queued profile transition without releasing holds', async () => {
    const f = await fixture();
    try {
      const previous: GenerateInput = { ...image, input: { ...image.input, resolution: '2K' } };
      const key = randomUUID();
      const accepted = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: key,
        input: previous,
      });
      await f.unrestricted.workOnce();
      expect(f.submit).toHaveBeenCalledTimes(1);
      const queuedRequest: GenerateInput = {
        ...video,
        input: { ...video.input, resolution: '720p', duration: 5 },
        queueStartDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const queued = await f.unrestricted.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: randomUUID(),
        input: queuedRequest,
      });
      // Make the pre-existing local deadline due without changing its original request or accepted snapshot.
      await f.unrestricted.pool.query(
        "UPDATE mr_jobs SET queue_start_deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [queued.id],
      );
      const scoped = f.open({ profile: 'qualification-sg-v1' });
      const before = await snapshot(scoped, f.workspaceId);
      const oldRow = (await scoped.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [queued.id]))
        .rows[0];
      const replay = await scoped.submit({
        workspaceId: f.workspaceId,
        idempotencyKey: key,
        input: previous,
      });
      expect(replay.id).toBe(accepted.id);
      await scoped.pool.query('UPDATE mr_jobs SET next_poll_at=clock_timestamp() WHERE id=$1', [
        accepted.id,
      ]);
      await scoped.workOnce();
      expect(f.poll).toHaveBeenCalledTimes(1);
      expect(f.submit).toHaveBeenCalledTimes(1);
      await scoped.pool.query(
        "UPDATE mr_jobs SET next_poll_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [accepted.id],
      );
      await expect(scoped.workOnce()).rejects.toMatchObject({
        code: 'execution_scope_transition_required',
      });
      await expect(
        scoped.submit({ workspaceId: f.workspaceId, idempotencyKey: randomUUID(), input: video }),
      ).rejects.toMatchObject({ code: 'execution_scope_transition_required' });
      expect(
        (await scoped.pool.query('SELECT * FROM mr_jobs WHERE id=$1', [queued.id])).rows[0],
      ).toEqual(oldRow);
      expect(await snapshot(scoped, f.workspaceId)).toEqual(before);
      expect((await scoped.workspaceReadiness(f.workspaceId)).executionScope).toEqual({
        profile: 'qualification-sg-v1',
        queuedConflicts: 1,
        transitionBlocked: true,
      });
      expect(await scoped.executionScopeConflicts()).toEqual([
        {
          jobId: queued.id,
          workspaceId: f.workspaceId,
          routeId: video.routeId,
          operation: video.operation,
        },
      ]);
      expect(f.download).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
