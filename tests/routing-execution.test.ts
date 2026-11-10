import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine';
import {
  privateStorageFixture,
  privateOutputFixture,
  privateReadyInputFixture,
  privateInputBytesFixture,
} from './helpers/private-storage';
import type { downloadInput } from '../packages/engine/src/input-download';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import {
  createEngine,
  type AssetStore,
  SubmissionRejected,
  type ProviderAdapter,
} from '@media-router/engine';
import type { GenerateInput } from '@media-router/contracts';
const databaseUrl = process.env.TEST_DATABASE_URL;
const singapore = 'alibaba/ap-southeast-1/wan-3.0';
const frankfurt = 'alibaba/eu-central-1/wan-3.0';
const input: GenerateInput = {
  modelId: 'alibaba/wan-3.0',
  operation: 'text-to-video',
  routing: { endpointRegions: ['ap-southeast-1', 'eu-central-1'], fallback: true },
  input: {
    prompt: 'Synthetic routing execution regression.',
    resolution: '720p',
    duration: 2,
  },
};
describe.skipIf(!databaseUrl)('routing execution invariants', () => {
  async function fixture(
    adapter: Pick<ProviderAdapter, 'submit' | 'poll'>,
    operation: (engine: ReturnType<typeof createEngine>, workspaceId: string) => Promise<void>,
    storage?: AssetStore,
    inputDownloader?: typeof downloadInput,
  ) {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'routing_execution');
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: storage ?? privateStorageFixture(),
        inputDownloader:
          inputDownloader ??
          (async () => {
            throw new Error('Unexpected fixture input download; real network is forbidden.');
          }),
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (route) => [singapore, frankfurt].includes(route.id),
            ...adapter,
          },
        ],
        pollIntervalMs: 0,
      }),
    );
    const workspaceId = `routing-${randomUUID()}`;
    try {
      await engine.initialize();
      await engine.ensureWorkspace(workspaceId, 2000000);
      await operation(engine, workspaceId);
    } finally {
      // Isolated fixture teardown must not manufacture cancellation, capacity
      // release or settlement evidence for uncertain provider work.
      await engine.close();
      await isolated.close();
    }
  }
  const prioritize = async (engine: ReturnType<typeof createEngine>, id: string) => {
    await engine.pool.query("UPDATE mr_jobs SET created_at=now()-interval '1 day' WHERE id=$1", [
      id,
    ]);
  };
  it('falls back only after explicit rejection and keeps each provider attempt in its metrics', async () => {
    const submitted: {
      jobId: string;
      routeId: string;
    }[] = [];
    await fixture(
      {
        submit: async (context) => {
          submitted.push({ jobId: context.jobId, routeId: context.route.id });
          if (context.route.id === frankfurt)
            throw new SubmissionRejected('Synthetic explicit rejection.');
          return { upstreamId: 'synthetic-accepted-task' };
        },
        poll: async () => ({ status: 'succeeded', billedCostMicros: 150000 }),
      },
      async (engine, workspaceId) => {
        const queued = await engine.submit({ workspaceId, idempotencyKey: 'safe-fallback', input });
        expect(queued.reservedMicros).toBe(200000);
        await prioritize(engine, queued.id);
        await engine.workOnce();
        expect(await engine.getJob(workspaceId, queued.id)).toMatchObject({
          status: 'queued',
          attemptCount: 1,
          routeId: singapore,
        });
        await engine.workOnce();
        await engine.workOnce();
        expect(await engine.getJob(workspaceId, queued.id)).toMatchObject({
          status: 'succeeded',
          attemptCount: 2,
          settledMicros: 150000,
        });
        expect(
          submitted.filter((value) => value.jobId === queued.id).map((value) => value.routeId),
        ).toEqual([frankfurt, singapore]);
        await engine.pool.query(
          "UPDATE mr_jobs SET created_at=now()-interval '20 seconds',completed_at=now()-interval '1 second' WHERE id=$1",
          [queued.id],
        );
        await engine.pool.query(
          "UPDATE mr_attempts SET started_at=now()-interval '4 seconds',completed_at=now()-interval '1 second' WHERE job_id=$1 AND number=2",
          [queued.id],
        );
        const metrics = await engine.routeMetrics(input);
        expect(metrics.find((value) => value.routeId === frankfurt)).toMatchObject({
          sampleCount: 1,
          failed: 1,
          unclassifiedFailures: 1,
          technicalSuccessRate: null,
          jobSampleCount: 0,
        });
        expect(metrics.find((value) => value.routeId === singapore)).toMatchObject({
          sampleCount: 1,
          succeeded: 1,
          p50CompletionMs: 3000,
          jobSampleCount: 1,
          // This fixture reports upstream success without output delivery.
          endToEndSampleCount: 0,
          deliveryAvailableJobCount: 0,
          deliveryFailedJobCount: 1,
          deliveryUnresolvedJobCount: 0,
          p50EndToEndMs: null,
          p95EndToEndMs: null,
        });
        expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
      },
    );
  });
  it('does not fall back from ambiguous provider acceptance', async () => {
    const submitted: string[] = [];
    await fixture(
      {
        submit: async (context) => {
          submitted.push(context.jobId);
          throw new Error('Synthetic disconnect after write.');
        },
        poll: async () => {
          throw new Error('No accepted task ID exists.');
        },
      },
      async (engine, workspaceId) => {
        const queued = await engine.submit({ workspaceId, idempotencyKey: 'uncertain', input });
        await prioritize(engine, queued.id);
        await engine.workOnce();
        await engine.workOnce();
        expect(await engine.getJob(workspaceId, queued.id)).toMatchObject({
          status: 'submission-unknown',
          attemptCount: 1,
          routeId: frankfurt,
          settledMicros: null,
        });
        expect(submitted.filter((id) => id === queued.id)).toHaveLength(1);
        expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(200000);
      },
    );
  });
  it('replays an accepted job after its input upload is removed', async () => {
    const storage = privateStorageFixture();
    await fixture(
      {
        submit: async () => {
          throw new Error('No provider call expected.');
        },
        poll: async () => {
          throw new Error('No provider call expected.');
        },
      },
      async (engine, workspaceId) => {
        const ready = await privateReadyInputFixture(engine, workspaceId);
        const prepare = vi.spyOn(engine.ownedAssets!, 'prepare');
        const request = {
          ...input,
          operation: 'image-to-video' as const,
          routeId: singapore,
          routing: undefined,
          input: { ...input.input, firstFrame: { assetKey: ready.assetKey } },
        };
        const accepted = await engine.submit({
          workspaceId,
          idempotencyKey: 'replay-upload',
          input: request,
        });
        expect(prepare).toHaveBeenCalledOnce();
        await storage.removeUpload(workspaceId, ready.uploadKey);
        expect(await engine.ownedAssets!.delete(workspaceId, ready.assetKey)).toMatchObject({
          state: 'deleted',
          inUse: true,
        });
        // Original staging is gone, while accepted-job pins retain the frozen bytes.
        expect(await storage.readInput(workspaceId, ready.assetKey)).toMatchObject({
          sha256: ready.sha256,
        });
        const read = vi.spyOn(storage, 'readInput');
        expect(
          (await engine.submit({ workspaceId, idempotencyKey: 'replay-upload', input: request }))
            .id,
        ).toBe(accepted.id);
        expect(prepare).toHaveBeenCalledOnce();
        expect(read).not.toHaveBeenCalled();
        await expect(
          engine.submit({
            workspaceId,
            idempotencyKey: 'replay-upload',
            input: { ...request, input: { ...request.input, prompt: 'Changed' } },
          }),
        ).rejects.toMatchObject({ code: 'idempotency_conflict' });
        expect(prepare).toHaveBeenCalledOnce();
      },
      storage,
    );
  });
  it('can poll an accepted job after its input upload is removed', async () => {
    const storage = privateStorageFixture();
    const submit = vi.fn(async () => ({ upstreamId: 'accepted-before-removal' }));
    const poll = vi.fn(async () => ({ status: 'succeeded' as const, billedCostMicros: 150000 }));
    await fixture(
      { submit, poll },
      async (engine, workspaceId) => {
        const ready = await privateReadyInputFixture(engine, workspaceId);
        const job = await engine.submit({
          workspaceId,
          idempotencyKey: 'poll-removed-upload',
          input: {
            ...input,
            operation: 'image-to-video',
            routeId: singapore,
            routing: undefined,
            input: { ...input.input, firstFrame: { assetKey: ready.assetKey } },
          },
        });
        await prioritize(engine, job.id);
        await engine.workOnce();
        expect((await engine.getJob(workspaceId, job.id))?.status).toBe('running');
        expect(await engine.ownedAssets!.delete(workspaceId, ready.assetKey)).toMatchObject({
          state: 'deleted',
          inUse: true,
        });
        // Simulate storage loss after provider acceptance, independently of safe API tombstoning.
        await storage.removeUpload(workspaceId, ready.uploadKey);
        await storage.removeUpload(workspaceId, ready.assetKey);
        const read = vi.spyOn(storage, 'readInput');
        const resolve = vi.spyOn(engine, 'resolveInput');
        await engine.workOnce();
        expect(await engine.getJob(workspaceId, job.id)).toMatchObject({
          status: 'succeeded',
          settledMicros: 150000,
        });
        expect(submit).toHaveBeenCalledOnce();
        expect(poll).toHaveBeenCalledOnce();
        expect(read).not.toHaveBeenCalled();
        expect(resolve).not.toHaveBeenCalled();
      },
      storage,
    );
  });
  it('preserves mixed owned/external frame roles and signs only at dispatch', async () => {
    const storage = privateStorageFixture();
    const source = 'https://example.com/external-last.png';
    const download = vi.fn(async (url: string) => {
      expect(url).toBe(source);
      return privateInputBytesFixture();
    });
    const submit = vi
      .fn<ProviderAdapter['submit']>()
      .mockResolvedValue({ upstreamId: 'frame-task' });
    await fixture(
      { submit, poll: async () => ({ status: 'running' }) },
      async (engine, workspaceId) => {
        const ready = await privateReadyInputFixture(engine, workspaceId);
        const sign = vi.spyOn(storage, 'sign');
        const request: GenerateInput = {
          ...input,
          operation: 'image-to-video',
          routeId: singapore,
          routing: undefined,
          input: {
            ...input.input,
            firstFrame: { assetKey: ready.assetKey },
            lastFrame: { url: source },
          },
        };
        const accepted = await engine.submit({
          workspaceId,
          idempotencyKey: 'named-mixed-frames',
          input: request,
        });
        expect(download).toHaveBeenCalledOnce();
        expect(sign).not.toHaveBeenCalled();
        const importedKey = accepted.input.input.lastFrame?.assetKey;
        expect(importedKey).toMatch(new RegExp(`^inputs/${workspaceId}/`));
        expect(importedKey).not.toBe(ready.assetKey);
        expect(accepted.input.input).toMatchObject({
          firstFrame: { assetKey: ready.assetKey },
          lastFrame: { assetKey: importedKey },
          aspectRatio: 'source',
        });
        const preparation = (
          await engine.pool.query(
            'SELECT manifest FROM mr_input_preparations WHERE workspace_id=$1 AND job_id=$2',
            [workspaceId, accepted.id],
          )
        ).rows[0];
        expect(
          preparation.manifest.map(
            ({ path, type, assetKey }: { path: string; type: string; assetKey: string }) => ({
              path,
              type,
              assetKey,
            }),
          ),
        ).toEqual([
          { path: 'firstFrame', type: 'image', assetKey: ready.assetKey },
          { path: 'lastFrame', type: 'image', assetKey: importedKey },
        ]);
        await prioritize(engine, accepted.id);
        await engine.workOnce();
        expect(submit).toHaveBeenCalledOnce();
        expect(sign).toHaveBeenCalledTimes(2);
        // Independent asset lookups/signatures may resolve in either order;
        // named frame placement is asserted on the submitted request below.
        expect(sign.mock.calls.map((call) => call[0]).sort()).toEqual(
          [ready.assetKey, importedKey].sort(),
        );
        expect(submit.mock.calls[0]![0].input.input).toMatchObject({
          firstFrame: { url: `https://private-storage.example/${ready.assetKey}?fixture=owned` },
          lastFrame: { url: `https://private-storage.example/${importedKey}?fixture=owned` },
        });
        expect(
          (
            await engine.submit({
              workspaceId,
              idempotencyKey: 'named-mixed-frames',
              input: request,
            })
          ).id,
        ).toBe(accepted.id);
        expect(download).toHaveBeenCalledOnce();
        expect(sign).toHaveBeenCalledTimes(2);
        await expect(
          engine.submit({
            workspaceId,
            idempotencyKey: 'named-mixed-frames',
            input: {
              ...request,
              input: {
                ...request.input,
                firstFrame: request.input.lastFrame,
                lastFrame: request.input.firstFrame,
              },
            },
          }),
        ).rejects.toMatchObject({ code: 'idempotency_conflict' });
        expect(download).toHaveBeenCalledOnce();
      },
      storage,
      download,
    );
  });
  it('rejects an owned asset in the wrong role before reservation or provider submission', async () => {
    const storage = privateStorageFixture();
    const submit = vi.fn<ProviderAdapter['submit']>();
    await fixture(
      { submit, poll: async () => ({ status: 'running' }) },
      async (engine, workspaceId) => {
        const ready = await privateReadyInputFixture(engine, workspaceId, 'video/mp4');
        const sign = vi.spyOn(storage, 'sign');
        await expect(
          engine.submit({
            workspaceId,
            idempotencyKey: 'wrong-first-frame-type',
            input: {
              ...input,
              operation: 'image-to-video',
              routeId: singapore,
              routing: undefined,
              input: { ...input.input, firstFrame: { assetKey: ready.assetKey } },
            },
          }),
        ).rejects.toMatchObject({ code: 'invalid_reference_type' });
        expect(submit).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
        expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
        expect(await engine.listJobs(workspaceId)).toEqual([]);
        expect(
          (
            await engine.pool.query(
              "SELECT count(*) FROM mr_ledger WHERE workspace_id=$1 AND kind='reserve'",
              [workspaceId],
            )
          ).rows[0].count,
        ).toBe('0');
      },
      storage,
    );
  });
  it('pins an Omni continuation to its owned completed interaction', async () => {
    await fixture(
      {
        submit: async () => {
          throw new Error('No provider call expected.');
        },
        poll: async () => {
          throw new Error('No provider call expected.');
        },
      },
      async (engine, workspaceId) => {
        const route = catalog.routes.find(
          (route) => route.modelId === 'google/gemini-omni-1.1-flash' && route.adapter === 'google',
        )!;
        const deployment = catalog.deployments.find((value) => value.id === route.deploymentId)!;
        const parent = randomUUID();
        const previous: GenerateInput = {
          ...input,
          modelId: route.modelId,
          routing: undefined,
          input: {
            ...input.input,
            duration: 5,
          },
        };
        await engine.pool.query(
          `INSERT INTO mr_jobs(id,workspace_id,idempotency_key,request_hash,input,route_snapshot,deployment_snapshot,status,upstream_id,reserved_micros,settled_micros,completed_at)
        VALUES($1,$2,$3,$3,$4,$5,$6,'succeeded','synthetic-interaction-id',0,0,now())`,
          [
            parent,
            workspaceId,
            `fixture-${parent}`,
            JSON.stringify(previous),
            JSON.stringify(route),
            JSON.stringify(deployment),
          ],
        );
        const next = { ...previous, operation: 'video-edit' as const, previousJobId: parent };
        expect((await engine.resolveInput(workspaceId, next)).routeId).toBe(route.id);
        await expect(engine.resolveInput('another-workspace', next)).rejects.toMatchObject({
          code: 'invalid_continuation',
        });
        await expect(
          engine.resolveInput(workspaceId, { ...next, routeId: 'another-deployment' }),
        ).rejects.toMatchObject({ code: 'continuation_route_mismatch' });
      },
    );
  });
  it('keeps job status and late billing available when an output URL cannot be refreshed', async () => {
    const storage = privateStorageFixture();
    const submit = vi.fn(async () => ({ upstreamId: 'synthetic-provider-id' }));
    const poll = vi.fn(async () => {
      throw new Error('No polling expected after fixture completion.');
    });
    try {
      await fixture(
        { submit, poll },
        async (engine, workspaceId) => {
          const accepted = await engine.submit({
            workspaceId,
            idempotencyKey: 'storage-outage',
            input: { ...input, routeId: singapore, routing: undefined },
          });
          await engine.workOnce();
          const output = await privateOutputFixture(storage, accepted.id);
          await engine.applyProviderResult(workspaceId, accepted.id, {
            status: 'succeeded',
            outputs: [output],
            billedCostMicros: null,
          });
          const available = await workUntilJob(
            engine,
            workspaceId,
            accepted.id,
            (job) => job.status === 'succeeded' && job.deliveryStatus === 'available',
          );
          expect(available.outputs).toHaveLength(1);
          expect(available.settledMicros).toBeNull();
          expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(200000);
          vi.spyOn(storage, 'sign').mockRejectedValue(
            new Error('Synthetic storage signing outage.'),
          );
          const unavailable = await engine.getJob(workspaceId, accepted.id);
          expect(unavailable).toMatchObject({
            status: 'succeeded',
            upstreamId: null,
            outputs: [],
            deliveryStatus: 'failed',
            deliveryErrors: [{ index: 0, code: 'url_refresh_failed' }],
          });
          expect(JSON.stringify(unavailable)).not.toContain(available.outputs[0]!.url);
          expect(
            (
              await engine.pool.query(
                'SELECT upstream_id FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
                [workspaceId, accepted.id],
              )
            ).rows[0].upstream_id,
          ).toBe('synthetic-provider-id');
          expect(
            (
              await engine.applyProviderResult(workspaceId, accepted.id, {
                status: 'succeeded',
                billedCostMicros: 150000,
              })
            ).settledMicros,
          ).toBe(150000);
          expect((await engine.getBalance(workspaceId)).reservedMicros).toBe(0);
          expect(
            (await engine.ledger(workspaceId)).filter((row) => row.kind === 'settle'),
          ).toHaveLength(1);
          expect(submit).toHaveBeenCalledOnce();
          expect(poll).not.toHaveBeenCalled();
        },
        storage,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});
