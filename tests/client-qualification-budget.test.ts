import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, lstat, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { quote } from '@media-router/catalog';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import type { Job } from '@media-router/contracts';
import {
  hashInput,
  liabilityMicros,
  executeSmoke,
  SmokeApi,
  type SmokeEntry,
} from '../scripts/live-smoke';
import {
  runClientQualification,
  runProviderQualification,
  reconcileProviderQualification,
  providerQualificationScope,
  type ProviderQualificationOptions,
  reconcileClientQualification,
  qualificationRoute,
  type ClientQualificationOptions,
} from '../scripts/client-qualification-budget';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const historical = (routeId: string, actualCostMicros: number | null, reserveMicros: number) => {
  const input = {
    modelId: 'alibaba/wan-3.0',
    operation: 'text-to-video' as const,
    routeId,
    input: { prompt: 'Synthetic fixture.', resolution: '480p', duration: 2 },
  };
  const entry = {
    routeId,
    input,
    inputHash: hashInput(input),
    idempotencyKey: randomUUID(),
    estimateMicros: reserveMicros / 2,
    reserveMicros,
    actualCostMicros,
    phase: 'accepted' as const,
    jobId: randomUUID(),
    jobStatus: 'succeeded' as const,
    deliveryStatus: 'available' as const,
    outputHashes: ['a'.repeat(64)],
    sources: [],
    createdAt: '2026-11-03T00:00:00Z',
  };
  return {
    ...entry,
    ...(actualCostMicros === null
      ? {
          billingHoldAcknowledgement: {
            kind: 'retain-full-reservation',
            jobId: entry.jobId,
            inputHash: entry.inputHash,
            reserveMicros,
            outputHashes: entry.outputHashes,
            acknowledgedAt: '2026-11-03T00:00:00Z',
          },
        }
      : {}),
  };
};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qualification-fixture-')));
  roots.push(root);
  const receiptPath = join(root, 'shared.json');
  const journal = {
    version: 1 as const,
    server: 'http://127.0.0.1:4510',
    workspaceId: 'original-workspace',
    budgetMicros: 50_000_000,
    entries: [
      historical('prior-image', 45_000, 90_000),
      historical(qualificationRoute, 100_000, 200_000),
      historical('prior-fal', null, 250_000),
      historical('prior-minimax', null, 200_000),
      historical('prior-xai', 40_000, 80_000),
    ],
  };
  await writeFile(receiptPath, JSON.stringify(journal), { mode: 0o600 });
  const input = parseGenerationRequest({
    modelId: 'alibaba/wan-3.0',
    routeId: qualificationRoute,
    operation: 'image-to-video',
    billing: 'managed',
    maxCostMicros: 100_000,
    routing: { fallback: false },
    input: {
      prompt: 'Synthetic fixture.',
      firstFrame: { assetKey: 'inputs/new-workspace/fixture.png' },
      duration: 2,
      resolution: '480p',
      aspectRatio: 'source',
      count: 1,
    },
  });
  const options: ClientQualificationOptions = {
    receiptPath,
    expectedReceiptSha256: sha(await readFile(receiptPath)),
    authority: { server: journal.server, workspaceId: journal.workspaceId },
    case: 'hosted-assistant',
    client: { name: 'TEST FIXTURE ONLY', version: 'fixture-1', date: '2026-11-04' },
    gateway: 'https://gateway.example',
    workspaceId: 'new-workspace',
    input,
    quote: quote(input, { executableRouteIds: [qualificationRoute] }),
    approved: true,
    observeHistorical: async (entry, gateway, workspaceId) => ({
      gateway,
      evidence: { kind: 'original-native-gateway' as const },
      job: {
        id: entry.jobId!,
        workspaceId,
        routeId: entry.routeId,
        input: entry.input,
        status: entry.jobStatus!,
        deliveryStatus: entry.deliveryStatus,
        outputs: entry.outputHashes!.map((sha256) => ({
          url: 'https://private.example/not-recorded',
          mediaType: 'video/mp4',
          sha256,
        })),
      },
    }),
  };
  const job = (input = options.input): Job => ({
    id: randomUUID(),
    workspaceId: 'new-workspace',
    input,
    routeId: qualificationRoute,
    deploymentId: 'alibaba-model-studio-ap-southeast-1',
    status: 'queued',
    upstreamId: null,
    outputs: [],
    error: null,
    createdAt: '2026-11-04T00:00:00Z',
    updatedAt: '2026-11-04T00:00:00Z',
    reservedMicros: 100_000,
    settledMicros: null,
    attemptCount: 0,
  });
  return {
    root,
    journal,
    options,
    job,
    read: async () => JSON.parse(await readFile(receiptPath, 'utf8')),
    digest: async () => sha(await readFile(receiptPath)),
  };
}

describe('one shared USD50 authority for a fixed two-client qualification', () => {
  it('fsyncs legacy-visible hold and submitting intent under the original lock before one native callback', async () => {
    const f = await fixture();
    let calls = 0;
    const result = await runClientQualification(f.options, async (admission) => {
      calls++;
      expect((await lstat(f.options.receiptPath + '.lock')).mode & 0o777).toBe(0o600);
      const current = await f.read();
      expect(current.server).toBe(f.journal.server);
      expect(current.workspaceId).toBe(f.journal.workspaceId);
      expect(current.budgetMicros).toBe(50_000_000);
      expect(current.entries).toHaveLength(6);
      expect(liabilityMicros(current)).toBe(835_000);
      expect(current.entries[5]).toMatchObject({
        phase: 'submitting',
        reserveMicros: 200_000,
        actualCostMicros: null,
        idempotencyKey: admission.idempotencyKey,
        clientQualification: { gateway: 'https://gateway.example', workspaceId: 'new-workspace' },
      });
      expect(hashInput(admission.input)).toBe(current.entries[5].inputHash);
      return f.job(admission.input);
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      phase: 'accepted',
      accountedMicros: 835_000,
      paidResubmissionAllowed: false,
    });
    expect((await lstat(f.options.receiptPath)).mode & 0o777).toBe(0o600);
    const stored = await f.read();
    for (let index = 0; index < 5; index++) {
      delete stored.entries[index].checkedAt;
      delete stored.entries[index].historicalObservation;
      expect(stored.entries[index]).toEqual(f.journal.entries[index]);
    }
    await expect(lstat(f.options.receiptPath + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains unknown admission and its whole hold without a second submit or paid replacement', async () => {
    const f = await fixture();
    let calls = 0;
    const result = await runClientQualification(f.options, async () => {
      calls++;
      throw new Error('Lost response');
    });
    expect(result.phase).toBe('admission-unknown');
    expect((await f.read()).entries[5]).toMatchObject({
      phase: 'admission-unknown',
      actualCostMicros: null,
      reserveMicros: 200_000,
    });
    await expect(
      runClientQualification(
        { ...f.options, expectedReceiptSha256: await f.digest() },
        async () => {
          calls++;
          return f.job();
        },
      ),
    ).rejects.toThrow('already contains');
    await expect(
      runClientQualification(
        { ...f.options, case: 'local-coding-agent', expectedReceiptSha256: await f.digest() },
        async () => {
          calls++;
          return f.job();
        },
      ),
    ).rejects.toThrow('read-only reconciliation');
    expect(calls).toBe(1);
  });
  it('allows the second named case only after read-only reconciliation, preserving exact route restriction elsewhere', async () => {
    const f = await fixture();
    const first = f.job();
    await runClientQualification(f.options, async () => first);
    await reconcileClientQualification(
      { ...f.options, expectedReceiptSha256: await f.digest() },
      async () => ({
        job: {
          ...first,
          status: 'succeeded',
          deliveryStatus: 'available',
          outputs: [
            {
              url: 'https://private.example/never-persist-url',
              mediaType: 'video/mp4',
              sha256: 'b'.repeat(64),
            },
          ],
        },
        gateway: f.options.gateway,
        settlement: {
          kind: 'settle' as const,
          jobId: first.id,
          workspaceId: f.options.workspaceId,
          source: 'ledger.details.upstreamCostMicros' as const,
          upstreamCostMicros: 100_000,
        },
      }),
    );
    const result = await runClientQualification(
      { ...f.options, case: 'local-coding-agent', expectedReceiptSha256: await f.digest() },
      async ({ input }) => f.job(input),
    );
    expect(result.accountedMicros).toBe(935_000);
    const journal = await f.read();
    expect(
      journal.entries.filter((entry: { routeId: string }) => entry.routeId === qualificationRoute),
    ).toHaveLength(3);
    expect(JSON.stringify(journal)).not.toContain('never-persist-url');
    await expect(
      runClientQualification({ ...f.options, expectedReceiptSha256: await f.digest() }, async () =>
        f.job(),
      ),
    ).rejects.toThrow('already contains');
  });
  it('records an upstream reservation overrun and blocks the second client without discarding the charge', async () => {
    const f = await fixture();
    const first = f.job();
    await runClientQualification(f.options, async () => first);
    const reconciled = await reconcileClientQualification(
      { ...f.options, expectedReceiptSha256: await f.digest() },
      async () => ({
        gateway: f.options.gateway,
        job: { ...first, status: 'succeeded' },
        settlement: {
          kind: 'settle',
          jobId: first.id,
          workspaceId: f.options.workspaceId,
          source: 'ledger.details.upstreamCostMicros',
          upstreamCostMicros: 300_000,
        },
      }),
    );
    expect(reconciled).toMatchObject({
      accountedMicros: 935_000,
      overBudget: false,
      reservationExceeded: true,
    });
    const before = await readFile(f.options.receiptPath);
    let calls = 0;
    await expect(
      runClientQualification(
        { ...f.options, case: 'local-coding-agent', expectedReceiptSha256: await f.digest() },
        async () => {
          calls++;
          return f.job();
        },
      ),
    ).rejects.toThrow('exceeded its reviewed reservation');
    expect(calls).toBe(0);
    expect(await readFile(f.options.receiptPath)).toEqual(before);
    expect((await f.read()).entries[5].actualCostMicros).toBe(300_000);
  });
  it('treats changed outer fallback or continuation as unknown acceptance and never replaces it', async () => {
    for (const change of [{ routing: { fallback: true } }, { previousJobId: randomUUID() }]) {
      const f = await fixture();
      let calls = 0;
      const result = await runClientQualification(f.options, async ({ input }) => {
        calls++;
        return f.job({ ...input, ...change });
      });
      expect(result.phase).toBe('admission-unknown');
      expect(calls).toBe(1);
      expect(liabilityMicros(await f.read())).toBe(835_000);
    }
  });
  it('requires original owned-job evidence and refuses wrong-job or customer-debit settlement fields', async () => {
    const wrong = await fixture();
    await expect(
      runClientQualification(
        {
          ...wrong.options,
          observeHistorical: async (entry, gateway, workspaceId) => ({
            gateway,
            evidence: { kind: 'original-native-gateway' as const },
            job: {
              id: randomUUID(),
              workspaceId,
              routeId: entry.routeId,
              input: entry.input,
              status: 'succeeded',
              deliveryStatus: 'available',
              outputs: [],
            },
          }),
        },
        async () => wrong.job(),
      ),
    ).rejects.toThrow('original gateway');
    expect((await wrong.read()).entries).toHaveLength(5);
    const f = await fixture();
    const job = f.job();
    await runClientQualification(f.options, async () => job);
    for (const source of [
      {
        kind: 'settle',
        jobId: randomUUID(),
        workspaceId: f.options.workspaceId,
        source: 'ledger.details.upstreamCostMicros',
        upstreamCostMicros: 0,
      },
      {
        kind: 'settle',
        jobId: job.id,
        workspaceId: f.options.workspaceId,
        source: 'customer.settledMicros',
        upstreamCostMicros: 0,
      },
    ])
      await expect(
        reconcileClientQualification(
          { ...f.options, expectedReceiptSha256: await f.digest() },
          async () => ({ gateway: f.options.gateway, job, settlement: source as never }),
        ),
      ).rejects.toThrow('linked upstream-cost');
    expect(liabilityMicros(await f.read())).toBe(835_000);
  });
  it('excludes concurrent writers, stale review, origin rebinding and missing approval without submitting', async () => {
    const f = await fixture();
    let calls = 0;
    const submit = async () => {
      calls++;
      return f.job();
    };
    await writeFile(f.options.receiptPath + '.lock', '', { mode: 0o600 });
    await expect(runClientQualification(f.options, submit)).rejects.toThrow('locked');
    await rm(f.options.receiptPath + '.lock');
    await expect(
      runClientQualification({ ...f.options, expectedReceiptSha256: '0'.repeat(64) }, submit),
    ).rejects.toThrow('changed since review');
    await expect(
      runClientQualification(
        { ...f.options, authority: { ...f.options.authority, server: f.options.gateway } },
        submit,
      ),
    ).rejects.toThrow('authority');
    await expect(
      runClientQualification({ ...f.options, approved: false as never }, submit),
    ).rejects.toThrow('approval');
    expect(calls).toBe(0);
    expect((await f.read()).entries).toHaveLength(5);
  });
  it('fails closed on invalid historical retention or changed generation/payer/region/asset configuration', async () => {
    const f = await fixture();
    const originalEvidence = await readFile(f.options.receiptPath);
    let calls = 0;
    const submit = async () => {
      calls++;
      return f.job();
    };
    await expect(
      runClientQualification(
        {
          ...f.options,
          observeHistorical: async (entry, gateway, workspaceId) => ({
            gateway,
            evidence: { kind: 'original-native-gateway' as const },
            job: {
              id: entry.jobId!,
              workspaceId,
              routeId: entry.routeId,
              input: entry.input,
              status: 'succeeded',
              deliveryStatus: 'failed',
              outputs: [],
            },
          }),
        },
        submit,
      ),
    ).rejects.toThrow('Historical unresolved');
    expect(await readFile(f.options.receiptPath)).toEqual(originalEvidence);
    for (const input of [
      { ...f.options.input, billing: 'byok' as const },
      { ...f.options.input, routeId: 'alibaba/eu-central-1/wan-3.0' },
      { ...f.options.input, input: { ...f.options.input.input, duration: 3 } },
      {
        ...f.options.input,
        input: {
          ...f.options.input.input,
          firstFrame: { url: 'https://external.example/image.png' },
        },
      },
    ])
      await expect(
        runClientQualification(
          { ...f.options, input, expectedReceiptSha256: await f.digest() },
          submit,
        ),
      ).rejects.toThrow('reviewed two-second');
    expect(calls).toBe(0);
  });
  it('explicitly rejects foreign-origin entries in the legacy runner without relying on a missing-job response', async () => {
    const f = await fixture();
    const journal = await f.read();
    for (const entry of journal.entries)
      if (entry.actualCostMicros === null) entry.actualCostMicros = entry.reserveMicros;
    await writeFile(f.options.receiptPath, JSON.stringify(journal), { mode: 0o600 });
    await runClientQualification(
      { ...f.options, expectedReceiptSha256: await f.digest() },
      async ({ input }) => f.job(input),
    );
    for (const settled of [false, true]) {
      const current = await f.read();
      if (settled) {
        current.entries[5].actualCostMicros = 100_000;
        current.entries[5].jobStatus = 'succeeded';
      }
      await writeFile(f.options.receiptPath, JSON.stringify(current), { mode: 0o600 });
      const before = await readFile(f.options.receiptPath);
      const requests: { method: string; path: string }[] = [];
      const legacy = new SmokeApi(f.journal.server, 'fixture-only', async (url, init) => {
        requests.push({ method: init?.method ?? 'GET', path: new URL(String(url)).pathname });
        // Every fake endpoint responds successfully. Rejection must happen explicitly
        // before a job lookup, quote, ledger read or generation admission.
        return Response.json({
          authenticated: true,
          workspaceId: f.journal.workspaceId,
          scopes: ['read', 'generate'],
        });
      });
      for (const resume of [false, true])
        await expect(
          executeSmoke(legacy, {
            receiptPath: f.options.receiptPath,
            budgetMicros: 50_000_000,
            routeId: 'some-other-route',
            acceptEstimateRisk: true,
            resume,
          }),
        ).rejects.toThrow('Foreign or malformed entry observer authority');
      expect(requests).toEqual([]);
      expect(await readFile(f.options.receiptPath)).toEqual(before);
      expect(liabilityMicros(await f.read())).toBe(settled ? 735_000 : 835_000);
    }
  });
  it('rejects settlement for every nonterminal native state and retains unknown billing plus its entire hold', async () => {
    const f = await fixture();
    const accepted = f.job();
    await runClientQualification(f.options, async () => accepted);
    const before = await readFile(f.options.receiptPath);
    for (const status of ['queued', 'submitting', 'running', 'submission-unknown'] as const)
      await expect(
        reconcileClientQualification(
          { ...f.options, expectedReceiptSha256: await f.digest() },
          async () => ({
            gateway: f.options.gateway,
            job: { ...accepted, status },
            settlement: {
              kind: 'settle',
              jobId: accepted.id,
              workspaceId: f.options.workspaceId,
              source: 'ledger.details.upstreamCostMicros',
              upstreamCostMicros: 0,
            },
          }),
        ),
      ).rejects.toThrow('terminal native job');
    expect(await readFile(f.options.receiptPath)).toEqual(before);
    expect((await f.read()).entries[5]).toMatchObject({
      actualCostMicros: null,
      reserveMicros: 200_000,
    });
    expect(liabilityMicros(await f.read())).toBe(835_000);
  });
  it('accepts linked upstream settlement only for terminal native states and rejects later nonterminal regression', async () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      const f = await fixture();
      const accepted = f.job();
      await runClientQualification(f.options, async () => accepted);
      await reconcileClientQualification(
        { ...f.options, expectedReceiptSha256: await f.digest() },
        async () => ({
          gateway: f.options.gateway,
          job: { ...accepted, status },
          settlement: {
            kind: 'settle',
            jobId: accepted.id,
            workspaceId: f.options.workspaceId,
            source: 'ledger.details.upstreamCostMicros',
            upstreamCostMicros: 100_000,
          },
        }),
      );
      const before = await readFile(f.options.receiptPath);
      expect(liabilityMicros(await f.read())).toBe(735_000);
      await expect(
        reconcileClientQualification(
          { ...f.options, expectedReceiptSha256: await f.digest() },
          async () => ({
            gateway: f.options.gateway,
            job: { ...accepted, status: 'running' },
            settlement: null,
          }),
        ),
      ).rejects.toThrow('terminal native job');
      expect(await readFile(f.options.receiptPath)).toEqual(before);
    }
  });
  it('never refunds an unknown cost on failure, prevents a reconciled cost reset and rejects linked journal paths', async () => {
    const f = await fixture();
    const accepted = f.job();
    await runClientQualification(f.options, async () => accepted);
    await reconcileClientQualification(
      { ...f.options, expectedReceiptSha256: await f.digest() },
      async () => ({
        job: { ...accepted, status: 'failed', deliveryStatus: 'failed' },
        gateway: f.options.gateway,
        settlement: null,
      }),
    );
    expect(liabilityMicros(await f.read())).toBe(835_000);
    await reconcileClientQualification(
      { ...f.options, expectedReceiptSha256: await f.digest() },
      async () => ({
        gateway: f.options.gateway,
        job: { ...accepted, status: 'failed' },
        settlement: {
          kind: 'settle',
          jobId: accepted.id,
          workspaceId: f.options.workspaceId,
          source: 'ledger.details.upstreamCostMicros',
          upstreamCostMicros: 100_000,
        },
      }),
    );
    await expect(
      reconcileClientQualification(
        { ...f.options, expectedReceiptSha256: await f.digest() },
        async () => ({
          gateway: f.options.gateway,
          job: { ...accepted, status: 'failed' },
          settlement: {
            kind: 'settle',
            jobId: accepted.id,
            workspaceId: f.options.workspaceId,
            source: 'ledger.details.upstreamCostMicros',
            upstreamCostMicros: 0,
          },
        }),
      ),
    ).rejects.toThrow('reconciled charge');
    const linked = join(f.root, 'linked.json');
    await symlink(f.options.receiptPath, linked);
    await expect(
      runClientQualification(
        { ...f.options, receiptPath: linked, expectedReceiptSha256: await f.digest() },
        async () => f.job(),
      ),
    ).rejects.toThrow('symlinks');
  });
});

async function providerFixture(caseName: ProviderQualificationOptions['case'] = 'wan-prime-text') {
  const f = await fixture();
  const gateway = 'https://opengen.dev';
  const observe = async (
    entry: Readonly<SmokeEntry>,
    origin = gateway,
    workspaceId = f.options.workspaceId,
  ) => ({
    gateway: origin,
    job: {
      ...f.job(entry.input),
      id: entry.jobId!,
      routeId: entry.routeId,
      workspaceId,
      status: 'succeeded' as const,
      deliveryStatus: 'available' as const,
      outputs: [
        {
          url: 'https://private.example/never-persist',
          mediaType: 'video/mp4',
          sha256: 'b'.repeat(64),
        },
      ],
    },
    settlement:
      entry.actualCostMicros === null
        ? null
        : {
            kind: 'settle' as const,
            jobId: entry.jobId!,
            workspaceId,
            source: 'ledger.details.upstreamCostMicros' as const,
            upstreamCostMicros: entry.actualCostMicros,
          },
  });
  for (const clientCase of ['hosted-assistant', 'local-coding-agent'] as const) {
    const options = {
      ...f.options,
      gateway,
      case: clientCase,
      expectedReceiptSha256: await f.digest(),
    };
    await runClientQualification(options, async () => f.job());
    await reconcileClientQualification(
      { ...options, expectedReceiptSha256: await f.digest() },
      async (entry) => observe({ ...entry, actualCostMicros: 100_000 }),
    );
  }
  function optionsFor(
    selected: ProviderQualificationOptions['case'],
  ): ProviderQualificationOptions {
    const image = selected === 'wan-prime-image';
    const standard = selected === 'wan-standard-text';
    const modelId = standard ? 'alibaba/wan-3.0' : 'alibaba/wan-3.0-prime';
    const routeId = standard ? qualificationRoute : 'alibaba/ap-southeast-1/wan-3.0-prime';
    const input = parseGenerationRequest({
      modelId,
      routeId,
      operation: image ? 'image-to-video' : 'text-to-video',
      billing: 'managed',
      maxCostMicros: standard ? 100_000 : 136_000,
      routing: { fallback: false },
      input: {
        prompt: 'Synthetic provider qualification.',
        resolution: '480p',
        duration: 2,
        count: 1,
        aspectRatio: image ? 'source' : '16:9',
        ...(image ? { firstFrame: { assetKey: 'inputs/new-workspace/fixture.png' } } : {}),
      },
    });
    return {
      receiptPath: f.options.receiptPath,
      expectedReceiptSha256: '',
      authority: f.options.authority,
      case: selected,
      gateway,
      workspaceId: f.options.workspaceId,
      apiSource: 'a'.repeat(40),
      workerSource: 'b'.repeat(40),
      input,
      quote: quote(input, { executableRouteIds: [routeId] }),
      approved: true,
      acceptEstimateRisk: true,
      observeHistorical: f.options.observeHistorical,
      observeQualified: observe,
    };
  }
  return {
    ...f,
    provider: optionsFor(caseName),
    optionsFor,
    observe,
    providerJob: (input: ProviderQualificationOptions['input']) => ({
      ...f.job(input),
      routeId: input.routeId!,
    }),
  };
}

describe('fixed hosted provider cases in the same mixed-observer journal', () => {
  it('preserves all seven old entries, both holds and exhausted client cases while settling three distinct hosted cases', async () => {
    const f = await providerFixture();
    const original = await f.read();
    for (const caseName of ['wan-prime-text', 'wan-prime-image', 'wan-standard-text'] as const) {
      const options = { ...f.optionsFor(caseName), expectedReceiptSha256: await f.digest() };
      const result = await runProviderQualification(options, async ({ input, idempotencyKey }) => {
        const recorded = await f.read();
        const entry = recorded.entries.at(-1);
        expect(entry.phase).toBe('submitting');
        expect(entry.providerQualification.scope).toBe(providerQualificationScope);
        expect(idempotencyKey).toMatch(/^opengen-provider-[a-f0-9-]{36}$/);
        expect(entry.reserveMicros).toBe(options.input.maxCostMicros! * 2);
        expect(await lstat(options.receiptPath + '.lock')).toBeDefined();
        return f.providerJob(input);
      });
      expect(result.phase).toBe('accepted');
      await reconcileProviderQualification(
        { ...options, expectedReceiptSha256: await f.digest() },
        async (entry) => f.observe({ ...entry, actualCostMicros: entry.estimateMicros }),
      );
    }
    const current = await f.read();
    expect(current.entries.slice(0, 7)).toEqual(original.entries);
    expect(current.server).toBe(original.server);
    expect(current.workspaceId).toBe(original.workspaceId);
    expect(liabilityMicros(current)).toBe(1_207_000);
    expect(JSON.stringify(current)).not.toContain('never-persist');
    await expect(
      runClientQualification({ ...f.options, expectedReceiptSha256: await f.digest() }, async () =>
        f.job(),
      ),
    ).rejects.toThrow('already contains');
  });

  it('keeps a timed-out admission and full hold, refuses repeat and different paid cases, then recovers the same key read-only', async () => {
    const f = await providerFixture();
    const options = { ...f.provider, expectedReceiptSha256: await f.digest() };
    let submits = 0;
    const result = await runProviderQualification(options, async () => {
      submits++;
      throw Error('timeout');
    });
    expect(result.phase).toBe('admission-unknown');
    expect(liabilityMicros(await f.read())).toBe(1_107_000);
    await expect(
      runProviderQualification(
        { ...options, expectedReceiptSha256: await f.digest() },
        async () => {
          submits++;
          return f.providerJob(options.input);
        },
      ),
    ).rejects.toThrow('already has an admission');
    await expect(
      runProviderQualification(
        { ...f.optionsFor('wan-prime-image'), expectedReceiptSha256: await f.digest() },
        async () => {
          submits++;
          return f.providerJob(options.input);
        },
      ),
    ).rejects.toThrow('unresolved');
    const accepted = {
      ...f.providerJob(options.input),
      status: 'succeeded' as const,
      deliveryStatus: 'available' as const,
      outputs: [
        {
          url: 'https://private.example/never-persist',
          mediaType: 'video/mp4',
          sha256: 'b'.repeat(64),
        },
      ],
    };
    await reconcileProviderQualification(
      { ...options, expectedReceiptSha256: await f.digest() },
      async () => ({
        gateway: options.gateway,
        job: accepted,
        settlement: {
          kind: 'settle',
          jobId: accepted.id,
          workspaceId: options.workspaceId,
          source: 'ledger.details.upstreamCostMicros',
          upstreamCostMicros: 136_000,
        },
      }),
    );
    expect(submits).toBe(1);
    expect(liabilityMicros(await f.read())).toBe(971_000);
  });

  it('retains a successful delivered job with unknown cost and blocks another paid case', async () => {
    const f = await providerFixture();
    const options = { ...f.provider, expectedReceiptSha256: await f.digest() };
    await runProviderQualification(options, async ({ input }) => f.providerJob(input));
    await reconcileProviderQualification(
      { ...options, expectedReceiptSha256: await f.digest() },
      f.observe,
    );
    expect((await f.read()).entries.at(-1).deliveryStatus).toBe('available');
    expect((await f.read()).entries.at(-1).actualCostMicros).toBeNull();
    expect(liabilityMicros(await f.read())).toBe(1_107_000);
    await expect(
      runProviderQualification(
        { ...f.optionsFor('wan-prime-image'), expectedReceiptSha256: await f.digest() },
        async () => {
          throw Error('unexpected submit');
        },
      ),
    ).rejects.toThrow('unresolved');
  });

  it('excludes simultaneous provider admissions and rejects stale reviewed bytes', async () => {
    const f = await providerFixture();
    const options = { ...f.provider, expectedReceiptSha256: await f.digest() };
    let release!: () => void;
    let submitted!: () => void;
    const started = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = runProviderQualification(options, async ({ input }) => {
      submitted();
      await waiting;
      return f.providerJob(input);
    });
    await started;
    await expect(
      runProviderQualification(
        {
          ...f.optionsFor('wan-prime-image'),
          expectedReceiptSha256: options.expectedReceiptSha256,
        },
        async () => {
          throw Error('unexpected submit');
        },
      ),
    ).rejects.toThrow('locked');
    release();
    await first;
    await expect(
      runProviderQualification(
        {
          ...f.optionsFor('wan-prime-image'),
          expectedReceiptSha256: options.expectedReceiptSha256,
        },
        async () => {
          throw Error('unexpected submit');
        },
      ),
    ).rejects.toThrow('changed since review');
    expect((await f.read()).entries).toHaveLength(8);
  });

  it('rejects wrong observers, changed historical delivery and malformed origin metadata before a new admission', async () => {
    const f = await providerFixture();
    const before = await readFile(f.options.receiptPath);
    for (const change of ['gateway', 'workspace', 'historical'] as const) {
      const options = {
        ...f.provider,
        expectedReceiptSha256: await f.digest(),
        observeQualified: async (
          entry: Readonly<SmokeEntry>,
          gateway: string,
          workspaceId: string,
        ) =>
          f.observe(
            entry,
            change === 'gateway' ? 'https://foreign.example' : gateway,
            change === 'workspace' ? 'foreign-workspace' : workspaceId,
          ),
        observeHistorical: async (
          entry: Readonly<SmokeEntry>,
          gateway: string,
          workspaceId: string,
        ) => {
          const value = await f.options.observeHistorical(entry, gateway, workspaceId);
          if (change === 'historical') value.job.deliveryStatus = 'failed';
          return value;
        },
      };
      await expect(
        runProviderQualification(options, async () => {
          throw Error('unexpected submit');
        }),
      ).rejects.toThrow();
      expect(await readFile(f.options.receiptPath)).toEqual(before);
    }
    await runProviderQualification(
      { ...f.provider, expectedReceiptSha256: await f.digest() },
      async ({ input }) => f.providerJob(input),
    );
    const data = await f.read();
    const cohort = data.entries.at(-1).providerQualification;
    for (const changed of [
      { ...cohort, gateway: 'https://foreign.example' },
      null,
      { ...cohort, apiSource: 'malformed' },
    ]) {
      data.entries.at(-1).providerQualification = changed;
      await writeFile(f.options.receiptPath, JSON.stringify(data));
      await expect(
        reconcileProviderQualification(
          { ...f.provider, expectedReceiptSha256: await f.digest() },
          async () => {
            throw Error('unexpected read');
          },
        ),
      ).rejects.toThrow('observer authority');
    }
  });

  it('requires exact priced inputs and preserves unknown nonterminal settlement holds and recorded overruns', async () => {
    const f = await providerFixture();
    const options = { ...f.provider, expectedReceiptSha256: await f.digest() };
    for (const input of [
      { ...options.input, routing: { fallback: true } },
      { ...options.input, input: { ...options.input.input, duration: 5 } },
      { ...options.input, billing: 'byok' as const },
      { ...options.input, previousJobId: randomUUID() },
    ])
      await expect(
        runProviderQualification({ ...options, input }, async () => {
          throw Error('unexpected submit');
        }),
      ).rejects.toThrow();
    const accepted = f.providerJob(options.input);
    await runProviderQualification(options, async () => accepted);
    const pending = await readFile(options.receiptPath);
    await expect(
      reconcileProviderQualification(
        { ...options, expectedReceiptSha256: await f.digest() },
        async () => ({
          gateway: options.gateway,
          job: accepted,
          settlement: {
            kind: 'settle',
            jobId: accepted.id,
            workspaceId: options.workspaceId,
            source: 'ledger.details.upstreamCostMicros',
            upstreamCostMicros: 0,
          },
        }),
      ),
    ).rejects.toThrow('terminal');
    expect(await readFile(options.receiptPath)).toEqual(pending);
    await reconcileProviderQualification(
      { ...options, expectedReceiptSha256: await f.digest() },
      async (entry) => f.observe({ ...entry, actualCostMicros: 300_000 }),
    );
    await expect(
      runProviderQualification(
        { ...f.optionsFor('wan-prime-image'), expectedReceiptSha256: await f.digest() },
        async () => {
          throw Error('unexpected submit');
        },
      ),
    ).rejects.toThrow('exceeded its reservation');
    expect((await f.read()).entries.at(-1).actualCostMicros).toBe(300_000);
  });

  it('makes the legacy runner reject provider-origin metadata before any HTTP even without client entries', async () => {
    const f = await providerFixture();
    await runProviderQualification(
      { ...f.provider, expectedReceiptSha256: await f.digest() },
      async ({ input }) => f.providerJob(input),
    );
    const data = await f.read();
    data.entries = data.entries.filter(
      (entry: { clientQualification?: unknown }) => !entry.clientQualification,
    );
    await writeFile(f.options.receiptPath, JSON.stringify(data));
    let requests = 0;
    const api = new SmokeApi(data.server, 'fixture', async () => {
      requests++;
      throw Error('unexpected HTTP');
    });
    await expect(
      executeSmoke(api, {
        receiptPath: f.options.receiptPath,
        budgetMicros: 50_000_000,
        resume: true,
        acceptEstimateRisk: false,
      }),
    ).rejects.toThrow('observer authority');
    expect(requests).toBe(0);
  });
});
