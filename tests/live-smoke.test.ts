import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog, GenerationArguments, Job, Quote } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import {
  catalogSmokeCases,
  automaticSmokeResult,
  executeSmoke,
  liabilityMicros,
  parseBudget,
  SmokeApi,
  smokePlan,
  validateServer,
  retainedBillingHold,
  main,
  type SmokeReceipt,
} from '../scripts/live-smoke';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const source = { url: 'https://example.com/pricing', checkedAt: '2026-11-02' };
const catalog: Catalog = {
  providers: [{ id: 'fixture', name: 'Fixture', website: source.url }],
  deployments: [
    {
      id: 'fixture-region',
      providerId: 'fixture',
      name: 'Fixture',
      endpointRegion: 'test',
      scope: 'regional',
      processingRegions: null,
      storageRegions: null,
      endpointTemplate: null,
      credentialEnv: null,
      source,
    },
  ],
  models: [
    {
      id: 'bytedance/seedream-5.0-pro',
      name: 'Fixture image',
      creator: 'Fixture',
      authorProviderIds: [],
      familyId: 'fixture',
      modality: 'image',
      aliases: [],
      openness: 'closed',
      license: 'Synthetic fixture',
      description: 'No live API.',
      source,
    },
  ],
  routes: [1, 2, 3].map((index) => ({
    id: `fixture/route-${index}`,
    modelId: 'bytedance/seedream-5.0-pro',
    deploymentId: 'fixture-region',
    upstreamModelId: 'fixture-model',
    operations: ['text-to-image'],
    resolutions: ['1K'],
    durations: [],
    fidelity: 'unknown',
    adapter: 'byteplus',
    status: 'documented',
    rates:
      index === 3
        ? []
        : [{ resolution: '1K', operation: 'text-to-image', unit: 'image', usdMicros: 45_000 }],
    source,
    pricingSource: source,
  })),
};
async function temporaryReceipt() {
  const directory = await mkdtemp(join(tmpdir(), 'opengen-live-smoke-fixture-'));
  directories.push(directory);
  return join(directory, 'receipt.json');
}
function fixture(
  options: {
    actualCostMicros?: number | null;
    admissionUnknown?: boolean;
    retainAcceptedJob?: boolean;
    scopes?: string[];
    beforeSubmit?: () => Promise<void>;
    catalog?: Catalog;
  } = {},
) {
  const requests: { path: string; method: string; authorization: string | null }[] = [];
  const jobs: Job[] = [];
  let paidPosts = 0;
  const request: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, authorization: new Headers(init?.headers).get('authorization') });
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    if (path === '/v1/catalog') return respond(options.catalog ?? catalog);
    if (path === '/v1/session')
      return respond({
        authenticated: true,
        workspaceId: 'fixture-workspace',
        scopes: options.scopes ?? ['read', 'generate'],
      });
    if (path === '/v1/quotes') {
      const quote: Quote = {
        modelId: body.modelId,
        operation: body.operation,
        estimateOnly: true,
        selectedRouteId: body.routeId,
        candidates: [
          {
            routeId: body.routeId,
            deploymentId: 'fixture-region',
            providerId: 'fixture',
            endpointRegion: 'test',
            scope: 'regional',
            estimatedCostMicros: 45_000,
            currency: 'USD',
            executable: true,
            reason: null,
            source,
            notices: [],
          },
        ],
        notices: [],
      };
      return respond(quote);
    }
    if (path === '/v1/generations' && method === 'POST') {
      // Exercise the canonical REST admission parser instead of echoing invalid envelopes.
      const parsed = parseGenerationRequest(body);
      paidPosts++;
      await options.beforeSubmit?.();
      const job: Job = {
        id: `fixture-job-${paidPosts}`,
        workspaceId: 'fixture-workspace',
        input: parsed,
        routeId: body.routeId,
        deploymentId: 'fixture-region',
        upstreamId: 'fixture-upstream',
        status: 'succeeded',
        error: null,
        outputs: [
          {
            url: 'https://example.com/private-signed-output.png?credential=redacted-fixture',
            mediaType: 'image/png',
            fidelity: 'unverified',
            sha256: 'ab'.repeat(32),
          },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliveryStatus: 'available',
        reservedMicros: 45_000,
        settledMicros: 45_000,
        attemptCount: 1,
      };
      if (options.retainAcceptedJob !== false) jobs.push(job);
      if (options.admissionUnknown)
        throw new Error('Synthetic lost response with sensitive-body-not-to-be-retained');
      return respond(job);
    }
    if (path === '/v1/generations') return respond(jobs);
    if (path.startsWith('/v1/generations/'))
      return respond(jobs.find((job) => job.id === path.split('/').pop()));
    if (path === '/v1/ledger')
      return respond({
        data: jobs.map((job) => ({
          job_id: job.id,
          kind: 'settle',
          details: {
            upstreamCostMicros:
              options.actualCostMicros === undefined ? 45_000 : options.actualCostMicros,
          },
        })),
      });
    throw new Error(`Unexpected synthetic request ${method} ${path}`);
  };
  return {
    api: new SmokeApi('http://127.0.0.1:4310', 'fixture-private-gateway-key', request),
    requests,
    jobs,
    paidPosts: () => paidPosts,
  };
}
const executeOptions = (receiptPath: string) => ({
  receiptPath,
  budgetMicros: 50_000_000,
  routeId: 'fixture/route-1',
  acceptEstimateRisk: true,
});
const acknowledgeOptions = (receiptPath: string, jobId = 'fixture-job-1') => ({
  receiptPath,
  budgetMicros: 50_000_000,
  resume: true,
  acceptEstimateRisk: false,
  retainBillingHoldJobId: jobId,
});
const changedArguments: { name: string; change: Partial<GenerationArguments>; modelId?: string }[] =
  [
    { name: 'resolution', change: { resolution: '2K' } },
    { name: 'count', change: { count: 2 }, modelId: 'xai/grok-imagine-image-2.0' },
    { name: 'output format', change: { outputFormat: 'jpeg' } },
    { name: 'watermark', change: { watermark: false } },
    { name: 'quality', change: { quality: 'medium' }, modelId: 'xai/grok-imagine-image-2.0' },
  ];
const fixtureCatalogFor = (modelId?: string) =>
  modelId
    ? {
        ...catalog,
        models: catalog.models.map((model) => ({ ...model, id: modelId })),
        routes: catalog.routes.map((route) => ({ ...route, modelId })),
      }
    : catalog;

describe('bounded smoke planning', () => {
  it('parses exact micro-USD and refuses a scope-expanding budget or credential-bearing origin', () => {
    expect(parseBudget('50')).toBe(50_000_000);
    expect(parseBudget('0.000001')).toBe(1);
    for (const value of ['50.000001', '0', '-1', '1e1', '0.0000001', 'Infinity'])
      expect(() => parseBudget(value)).toThrow();
    expect(validateServer('http://127.0.0.1:4310')).toBe('http://127.0.0.1:4310');
    for (const value of [
      'http://remote.example',
      'https://user:secret@example.com',
      'https://example.com/?token=private',
    ])
      expect(() => validateServer(value)).toThrow();
  });
  it('keeps unknown prices blocked and planning never reaches generation', async () => {
    expect(
      catalogSmokeCases(catalog).find((entry) => entry.routeId === 'fixture/route-3'),
    ).toMatchObject({
      state: 'blocked',
      estimateMicros: null,
      reason: 'No qualified request price; live submission blocked.',
    });
    const data = fixture();
    const plan = await smokePlan(data.api);
    expect(plan.filter((entry) => entry.state === 'ready')).toHaveLength(2);
    expect(data.paidPosts()).toBe(0);
    const prepared = plan.find((entry) => entry.state === 'ready')!.input!;
    expect(prepared).toMatchObject({
      input: { prompt: expect.any(String), resolution: '1K' },
      routing: { fallback: false },
      billing: 'managed',
    });
    expect(prepared).not.toHaveProperty('prompt');
    expect(prepared).not.toHaveProperty('resolution');
    expect(
      data.requests
        .filter((request) => request.method === 'POST')
        .every((request) => request.path === '/v1/quotes'),
    ).toBe(true);
  });
});

describe('shared receipt observer authority (synthetic fixtures only)', () => {
  async function reviewedReceipt() {
    const receiptPath = await temporaryReceipt();
    const options = { actualCostMicros: null as number | null };
    const data = fixture(options);
    await executeSmoke(data.api, executeOptions(receiptPath));
    const receipt = await executeSmoke(data.api, acknowledgeOptions(receiptPath));
    return { receiptPath, receipt, data, options };
  }
  it.each(['gateway', 'workspace', 'both'] as const)(
    'rejects a foreign %s before any observer call in every mode, preserving the receipt',
    async (difference) => {
      const { receiptPath, receipt, data } = await reviewedReceipt();
      const foreign = structuredClone(receipt.entries[0]!);
      Object.assign(foreign, {
        clientQualification: {
          gateway: difference === 'workspace' ? receipt.server : 'https://foreign.example',
          workspaceId: difference === 'gateway' ? receipt.workspaceId : 'foreign-workspace',
        },
      });
      receipt.entries.push(foreign);
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const bytes = await readFile(receiptPath);
      const before = data.requests.length;
      for (const mode of [
        { ...executeOptions(receiptPath), routeId: 'fixture/route-2' },
        { receiptPath, budgetMicros: 50_000_000, resume: true, acceptEstimateRisk: false },
        acknowledgeOptions(receiptPath),
      ]) {
        await expect(executeSmoke(data.api, mode)).rejects.toThrow('entry observer authority');
        expect(data.requests.slice(before)).toEqual([]);
        expect(await readFile(receiptPath)).toEqual(bytes);
        await expect(stat(receiptPath + '.lock')).rejects.toMatchObject({ code: 'ENOENT' });
      }
      expect(liabilityMicros(JSON.parse(bytes.toString()))).toBe(180_000);
      expect(data.paidPosts()).toBe(1);
    },
  );
  it.each(['reserved', 'submitting', 'admission-unknown', 'accepted'] as const)(
    'never recovers a foreign %s entry from a colliding native job or ledger',
    async (phase) => {
      const { receiptPath, receipt, data, options } = await reviewedReceipt();
      const foreign = structuredClone(receipt.entries[0]!);
      foreign.phase = phase;
      delete foreign.jobId;
      delete foreign.billingHoldAcknowledgement;
      Object.assign(foreign, {
        clientQualification: { gateway: 'https://foreign.example', workspaceId: 'foreign' },
      });
      // Same canonical input, nonce and route: the old authority could otherwise
      // return a matching native job and a charge that releases the foreign hold.
      options.actualCostMicros = 45_000;
      expect(data.jobs[0]!.input).toEqual(parseGenerationRequest(foreign.input));
      receipt.entries.push(foreign);
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const bytes = await readFile(receiptPath);
      const before = data.requests.length;
      await expect(
        executeSmoke(data.api, {
          receiptPath,
          budgetMicros: 50_000_000,
          resume: true,
          acceptEstimateRisk: false,
        }),
      ).rejects.toThrow('entry observer authority');
      expect(data.requests.slice(before)).toEqual([]);
      expect(await readFile(receiptPath)).toEqual(bytes);
      expect(liabilityMicros(JSON.parse(bytes.toString()))).toBe(180_000);
    },
  );
  it('also rejects foreign entries whose generation and charge are already terminal', async () => {
    const { receiptPath, receipt, data } = await reviewedReceipt();
    const foreign = structuredClone(receipt.entries[0]!);
    foreign.actualCostMicros = 45_000;
    Object.assign(foreign, {
      clientQualification: { gateway: receipt.server, workspaceId: 'another-workspace' },
    });
    receipt.entries.push(foreign);
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const bytes = await readFile(receiptPath);
    const before = data.requests.length;
    await expect(
      executeSmoke(data.api, { ...executeOptions(receiptPath), routeId: 'fixture/route-2' }),
    ).rejects.toThrow('entry observer authority');
    expect(data.requests.slice(before)).toEqual([]);
    expect(await readFile(receiptPath)).toEqual(bytes);
  });
  it.each([
    null,
    false,
    0,
    'unrecognized-origin',
    [],
    {},
    { gateway: 'https://foreign.example' },
    { workspaceId: 'foreign' },
    { gateway: 'https://user:private-token@foreign.example', workspaceId: 'foreign' },
    { gateway: 'http://127.0.0.1:4310', workspaceId: '' },
    { gateway: 'http://127.0.0.1:4310/', workspaceId: 'fixture-workspace' },
  ])(
    'fails closed for malformed origin metadata %j without reading a gateway',
    async (metadata) => {
      const { receiptPath, receipt, data } = await reviewedReceipt();
      Object.assign(receipt.entries[0]!, { clientQualification: metadata });
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const bytes = await readFile(receiptPath);
      const before = data.requests.length;
      await expect(
        executeSmoke(data.api, {
          receiptPath,
          budgetMicros: 50_000_000,
          resume: true,
          acceptEstimateRisk: false,
        }),
      ).rejects.toThrow('Foreign or malformed entry observer authority');
      expect(data.requests.slice(before)).toEqual([]);
      expect(await readFile(receiptPath)).toEqual(bytes);
    },
  );
  it('preserves native authority, holds and acknowledgements when provenance matches', async () => {
    const { receiptPath, receipt, data } = await reviewedReceipt();
    const acknowledgement = structuredClone(receipt.entries[0]!.billingHoldAcknowledgement);
    const metadata = { gateway: receipt.server, workspaceId: receipt.workspaceId };
    Object.assign(receipt.entries[0]!, { clientQualification: metadata });
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    const before = data.requests.length;
    const resumed = await executeSmoke(data.api, {
      receiptPath,
      budgetMicros: 50_000_000,
      resume: true,
      acceptEstimateRisk: false,
    });
    expect(resumed).toMatchObject({
      server: receipt.server,
      workspaceId: receipt.workspaceId,
      budgetMicros: receipt.budgetMicros,
      entries: [{ clientQualification: metadata, billingHoldAcknowledgement: acknowledgement }],
    });
    expect(retainedBillingHold(resumed.entries[0]!)).toBe(true);
    expect(liabilityMicros(resumed)).toBe(90_000);
    expect(data.requests.slice(before).every((request) => request.method === 'GET')).toBe(true);
    expect(data.paidPosts()).toBe(1);
  });
  it('refuses changing the receipt gateway before session or observer reads', async () => {
    const { receiptPath } = await reviewedReceipt();
    let calls = 0;
    const foreignApi = new SmokeApi('https://foreign.example', undefined, async () => {
      calls++;
      throw new Error('No transport should run.');
    });
    const bytes = await readFile(receiptPath);
    await expect(
      executeSmoke(foreignApi, {
        receiptPath,
        budgetMicros: 50_000_000,
        resume: true,
        acceptEstimateRisk: false,
      }),
    ).rejects.toThrow('Receipt identity or budget differs');
    expect(calls).toBe(0);
    expect(await readFile(receiptPath)).toEqual(bytes);
  });
});

describe('explicit retention of reviewed unsettled billing holds', () => {
  it.each(changedArguments)(
    'blocks acknowledgement when a same-prompt/model/route job changes $name',
    async ({ change, modelId }) => {
      const receiptPath = await temporaryReceipt();
      const data = fixture({ actualCostMicros: null, catalog: fixtureCatalogFor(modelId) });
      await executeSmoke(data.api, executeOptions(receiptPath));
      Object.assign(data.jobs[0]!.input.input, change);
      // These are independently valid model inputs, so failure must be an exact
      // request mismatch rather than relying on malformed upstream data.
      expect(() => parseGenerationRequest(data.jobs[0]!.input)).not.toThrow();
      await expect(executeSmoke(data.api, acknowledgeOptions(receiptPath))).rejects.toThrow(
        'Returned job does not match',
      );
      const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as SmokeReceipt;
      expect(saved.entries[0]!.billingHoldAcknowledgement).toBeUndefined();
      expect(liabilityMicros(saved)).toBe(90_000);
      expect(data.paidPosts()).toBe(1);
    },
  );
  it.each(['billing', 'operation', 'request route'])(
    'blocks acknowledgement after a same-prompt job changes %s',
    async (field) => {
      const receiptPath = await temporaryReceipt();
      const data = fixture({ actualCostMicros: null });
      await executeSmoke(data.api, executeOptions(receiptPath));
      const returned = data.jobs[0]!.input;
      if (field === 'billing') returned.billing = 'byok';
      else if (field === 'request route') returned.routeId = 'fixture/route-2';
      else {
        returned.operation = 'image-edit';
        returned.input.references = [
          { type: 'image', asset: { url: 'https://media.example.com/input.png' } },
        ];
      }
      expect(() => parseGenerationRequest(returned)).not.toThrow();
      await expect(executeSmoke(data.api, acknowledgeOptions(receiptPath))).rejects.toThrow(
        'Returned job does not match',
      );
      expect(data.paidPosts()).toBe(1);
    },
  );
  it('normalizes canonical defaults and permits gateway-narrowed routing policy', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ actualCostMicros: null });
    await executeSmoke(data.api, executeOptions(receiptPath));
    delete data.jobs[0]!.input.input.resolution;
    data.jobs[0]!.input.routing = {
      fallback: false,
      providerIds: ['fixture'],
      endpointRegions: ['test'],
    };
    const receipt = await executeSmoke(data.api, acknowledgeOptions(receiptPath));
    expect(retainedBillingHold(receipt.entries[0]!)).toBe(true);
    expect(data.paidPosts()).toBe(1);
  });
  it('retains the full hold and pending result, then permits only a different route', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ actualCostMicros: null });
    const pending = await executeSmoke(data.api, executeOptions(receiptPath));
    const before = pending.entries[0]!;
    const readsBefore = data.requests.length;
    const acknowledged = await executeSmoke(data.api, acknowledgeOptions(receiptPath));
    expect(acknowledged.entries[0]).toMatchObject({
      actualCostMicros: null,
      reserveMicros: before.reserveMicros,
      inputHash: before.inputHash,
      idempotencyKey: before.idempotencyKey,
      billingHoldAcknowledgement: {
        kind: 'retain-full-reservation',
        jobId: 'fixture-job-1',
        inputHash: before.inputHash,
        reserveMicros: 90_000,
        outputHashes: before.outputHashes,
      },
    });
    expect(retainedBillingHold(acknowledged.entries[0]!)).toBe(true);
    expect(automaticSmokeResult(acknowledged.entries[0]!)).toBe('pending');
    expect(liabilityMicros(acknowledged)).toBe(90_000);
    expect(data.paidPosts()).toBe(1);
    expect(data.requests.slice(readsBefore).some((request) => request.path === '/v1/ledger')).toBe(
      false,
    );
    expect(data.requests.slice(readsBefore).every((request) => request.method === 'GET')).toBe(
      true,
    );
    await expect(executeSmoke(data.api, executeOptions(receiptPath))).rejects.toThrow(
      'already has a test receipt',
    );
    const next = await executeSmoke(data.api, {
      ...executeOptions(receiptPath),
      routeId: 'fixture/route-2',
    });
    expect(data.paidPosts()).toBe(2);
    expect(liabilityMicros(next)).toBe(180_000);
    expect(next.entries.every((entry) => entry.actualCostMicros === null)).toBe(true);
    // Acknowledging one entry is never a blanket waiver of other unknown charges.
    await expect(executeSmoke(data.api, executeOptions(receiptPath))).rejects.toThrow('unsettled');
  });
  it.each([
    ['running', { status: 'running' }],
    ['failed', { status: 'failed' }],
    ['cancelled', { status: 'cancelled' }],
    ['unknown acceptance', { status: 'submission-unknown' }],
    ['failed delivery', { deliveryStatus: 'failed' }],
    ['partial delivery', { deliveryStatus: 'partial' }],
    ['pending delivery', { deliveryStatus: 'pending' }],
    ['missing hash', { outputs: [] }],
  ] as const)('refuses acknowledgement for %s', async (_name, change) => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ actualCostMicros: null });
    await executeSmoke(data.api, executeOptions(receiptPath));
    Object.assign(data.jobs[0]!, change);
    await expect(executeSmoke(data.api, acknowledgeOptions(receiptPath))).rejects.toThrow(
      'requires one accepted, succeeded job',
    );
    expect(data.paidPosts()).toBe(1);
    const saved = JSON.parse(await readFile(receiptPath, 'utf8')) as SmokeReceipt;
    expect(saved.entries[0]!.billingHoldAcknowledgement).toBeUndefined();
    expect(liabilityMicros(saved)).toBe(90_000);
  });
  it('refuses a nonaccepted phase, malformed hash, nonexistent job and known charge', async () => {
    for (const condition of ['phase', 'hash', 'job', 'known'] as const) {
      const receiptPath = await temporaryReceipt();
      const data = fixture({ actualCostMicros: condition === 'known' ? 45_000 : null });
      const receipt = await executeSmoke(data.api, executeOptions(receiptPath));
      if (condition === 'phase') {
        receipt.entries[0]!.phase = 'reserved';
        await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      }
      if (condition === 'hash') data.jobs[0]!.outputs[0]!.sha256 = 'not-a-sha256';
      await expect(
        executeSmoke(
          data.api,
          acknowledgeOptions(receiptPath, condition === 'job' ? 'missing-job' : 'fixture-job-1'),
        ),
      ).rejects.toThrow('requires one accepted, succeeded job');
      expect(data.paidPosts()).toBe(1);
    }
  });
  it.each(['jobId', 'inputHash', 'reserveMicros', 'outputHashes'] as const)(
    'blocks a tampered acknowledgement %s snapshot',
    async (field) => {
      const receiptPath = await temporaryReceipt();
      const data = fixture({ actualCostMicros: null });
      await executeSmoke(data.api, executeOptions(receiptPath));
      const receipt = await executeSmoke(data.api, acknowledgeOptions(receiptPath));
      const acknowledgement = receipt.entries[0]!.billingHoldAcknowledgement!;
      if (field === 'reserveMicros') acknowledgement.reserveMicros--;
      else if (field === 'outputHashes') acknowledgement.outputHashes = ['cd'.repeat(32)];
      else acknowledgement[field] = 'different-snapshot';
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      await expect(
        executeSmoke(data.api, { ...executeOptions(receiptPath), routeId: 'fixture/route-2' }),
      ).rejects.toThrow(field === 'outputHashes' ? 'unsettled' : 'does not match');
      expect(data.paidPosts()).toBe(1);
    },
  );
  it('rechecks delivered state and blocks stale acknowledgement after output changes', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ actualCostMicros: null });
    await executeSmoke(data.api, executeOptions(receiptPath));
    await executeSmoke(data.api, acknowledgeOptions(receiptPath));
    data.jobs[0]!.outputs[0]!.sha256 = 'cd'.repeat(32);
    await expect(
      executeSmoke(data.api, { ...executeOptions(receiptPath), routeId: 'fixture/route-2' }),
    ).rejects.toThrow('unsettled');
    expect(data.paidPosts()).toBe(1);
  });
  it('keeps the held liability inside the unchanged aggregate budget', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ actualCostMicros: null });
    const budgetMicros = 179_999;
    await executeSmoke(data.api, { ...executeOptions(receiptPath), budgetMicros });
    await executeSmoke(data.api, { ...acknowledgeOptions(receiptPath), budgetMicros });
    await expect(
      executeSmoke(data.api, {
        ...executeOptions(receiptPath),
        budgetMicros,
        routeId: 'fixture/route-2',
      }),
    ).rejects.toThrow('Insufficient remaining test budget');
    expect(data.paidPosts()).toBe(1);
  });
  it('uses the same exclusive receipt lock for acknowledgement and subsequent admission', async () => {
    const receiptPath = await temporaryReceipt();
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const data = fixture({
      actualCostMicros: null,
      beforeSubmit: async () => {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as SmokeReceipt;
        if (receipt.entries.length === 2) {
          reached();
          await gate;
        }
      },
    });
    await executeSmoke(data.api, executeOptions(receiptPath));
    await executeSmoke(data.api, acknowledgeOptions(receiptPath));
    const next = executeSmoke(data.api, {
      ...executeOptions(receiptPath),
      routeId: 'fixture/route-2',
    });
    await submitted;
    try {
      await expect(executeSmoke(data.api, acknowledgeOptions(receiptPath))).rejects.toThrow(
        'receipt is locked',
      );
    } finally {
      release();
    }
    const receipt = await next;
    expect(data.paidPosts()).toBe(2);
    expect(liabilityMicros(receipt)).toBe(180_000);
  });
  it.each([
    ['--execute', '--resume'],
    ['--retain-billing-hold', 'job'],
    ['--resume', '--retain-billing-hold', 'job', '--route', 'fixture/route-2'],
    ['--resume', '--retain-billing-hold', 'job', '--accept-estimate-risk'],
    ['--resume', '--retain-billing-hold', 'job', '--wait-ms', '0'],
    ['--resume', '--retain-billing-hold', 'job', '--retain-billing-hold', 'job'],
  ])('rejects conflicting CLI modes %j before making any request', async (...args) => {
    await expect(main(args)).rejects.toThrow();
  });
});
describe('resumable live smoke execution without live calls', () => {
  it.each(changedArguments)(
    'does not recover an unknown admission from a same-prompt/model/route job with different $name',
    async ({ change, modelId }) => {
      const receiptPath = await temporaryReceipt();
      const data = fixture({
        admissionUnknown: true,
        catalog: fixtureCatalogFor(modelId),
      });
      await executeSmoke(data.api, executeOptions(receiptPath));
      Object.assign(data.jobs[0]!.input.input, change);
      expect(() => parseGenerationRequest(data.jobs[0]!.input)).not.toThrow();
      const receipt = await executeSmoke(data.api, {
        ...executeOptions(receiptPath),
        resume: true,
        acceptEstimateRisk: false,
      });
      expect(receipt.entries[0]).toMatchObject({
        phase: 'admission-unknown',
        actualCostMicros: null,
      });
      expect(receipt.entries[0]!.jobId).toBeUndefined();
      expect(liabilityMicros(receipt)).toBe(90_000);
      expect(data.paidPosts()).toBe(1);
    },
  );
  it('submits unique nested prompts that survive canonical admission and receipt roundtrip', async () => {
    const data = fixture();
    const planned = catalogSmokeCases(catalog)[0]!.input!;
    const firstPath = await temporaryReceipt();
    const secondPath = await temporaryReceipt();
    const first = await executeSmoke(data.api, executeOptions(firstPath));
    const second = await executeSmoke(data.api, executeOptions(secondPath));
    const inputs = [first.entries[0]!.input, second.entries[0]!.input];
    for (const [index, input] of inputs.entries()) {
      expect(input).not.toHaveProperty('prompt');
      expect(input.input.prompt).toMatch(/Smoke reference [0-9a-f-]{36}\.$/);
      expect(parseGenerationRequest(input)).toEqual(data.jobs[index]!.input);
    }
    expect(inputs[0]!.input.prompt).not.toBe(planned.input.prompt);
    expect(inputs[0]!.input.prompt).not.toBe(inputs[1]!.input.prompt);
    const saved = JSON.parse(await readFile(firstPath, 'utf8')) as SmokeReceipt;
    expect(saved.entries[0]!.input).toEqual(inputs[0]);
    expect(data.paidPosts()).toBe(2);
  });
  it('durably records the budget hold and submission intent before one POST, then uses actual upstream cost', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({
      actualCostMicros: 55_000,
      beforeSubmit: async () => {
        const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as SmokeReceipt;
        expect(receipt.entries).toHaveLength(1);
        expect(receipt.entries[0]).toMatchObject({
          phase: 'submitting',
          reserveMicros: 90_000,
          actualCostMicros: null,
        });
        expect((await stat(receiptPath)).mode & 0o077).toBe(0);
      },
    });
    const receipt = await executeSmoke(data.api, executeOptions(receiptPath));
    expect(data.paidPosts()).toBe(1);
    expect(liabilityMicros(receipt)).toBe(55_000);
    expect(automaticSmokeResult(receipt.entries[0]!)).toBe('passed');
    expect(automaticSmokeResult({ ...receipt.entries[0]!, outputHashes: [] })).toBe('pending');
    expect(automaticSmokeResult({ ...receipt.entries[0]!, deliveryStatus: 'failed' })).toBe(
      'failed',
    );
    expect(receipt.entries[0]).toMatchObject({
      phase: 'accepted',
      jobStatus: 'succeeded',
      deliveryStatus: 'available',
      actualCostMicros: 55_000,
      upstreamId: 'fixture-upstream',
      outputHashes: ['ab'.repeat(32)],
    });
    const saved = await readFile(receiptPath, 'utf8');
    expect(saved).not.toContain('fixture-private-gateway-key');
    expect(saved).not.toContain('private-signed-output');
    await expect(executeSmoke(data.api, executeOptions(receiptPath))).rejects.toThrow(
      'already has a test receipt',
    );
    expect(data.paidPosts()).toBe(1);
  });
  it('recovers an ambiguous accepted admission using only owned job reads, without another POST', async () => {
    const receiptPath = await temporaryReceipt();
    const data = fixture({ admissionUnknown: true });
    const pending = await executeSmoke(data.api, executeOptions(receiptPath));
    expect(pending.entries[0]).toMatchObject({
      phase: 'admission-unknown',
      actualCostMicros: null,
    });
    expect(liabilityMicros(pending)).toBe(90_000);
    // A different job on this model/route has the unmodified planner prompt. Recovery
    // must select the exact canonical nonce prompt instead of this unrelated job.
    data.jobs.push({
      ...data.jobs[0]!,
      id: 'unrelated-job',
      input: parseGenerationRequest(catalogSmokeCases(catalog)[0]!.input!),
    });
    const resumed = await executeSmoke(data.api, {
      ...executeOptions(receiptPath),
      resume: true,
      acceptEstimateRisk: false,
    });
    expect(resumed.entries[0]).toMatchObject({
      phase: 'accepted',
      actualCostMicros: 45_000,
      jobId: 'fixture-job-1',
    });
    expect(data.paidPosts()).toBe(1);
    expect(await readFile(receiptPath, 'utf8')).not.toContain('sensitive-body');
  });
  it('holds an unresolvable admission and missing actual billing rather than treating local credit as spend', async () => {
    const unknownPath = await temporaryReceipt();
    const unknown = fixture({ admissionUnknown: true, retainAcceptedJob: false });
    await executeSmoke(unknown.api, executeOptions(unknownPath));
    await expect(
      executeSmoke(unknown.api, { ...executeOptions(unknownPath), routeId: 'fixture/route-2' }),
    ).rejects.toThrow('remains unsubmitted, unresolved or unsettled');
    expect(unknown.paidPosts()).toBe(1);
    const pendingPath = await temporaryReceipt();
    const pending = fixture({ actualCostMicros: null });
    const receipt = await executeSmoke(pending.api, executeOptions(pendingPath));
    expect(receipt.entries[0]!.actualCostMicros).toBeNull();
    expect(liabilityMicros(receipt)).toBe(90_000);
    await expect(
      executeSmoke(pending.api, { ...executeOptions(pendingPath), routeId: 'fixture/route-2' }),
    ).rejects.toThrow('unsettled');
    expect(pending.paidPosts()).toBe(1);
  });
  it('refuses another render after actual spend reaches the cap and imports only an empty prior approval', async () => {
    const receiptPath = await temporaryReceipt();
    await writeFile(
      receiptPath,
      JSON.stringify({ authorized_usd: 50, spent_usd: 0, provider_requests: [] }),
      { mode: 0o600 },
    );
    const data = fixture({ actualCostMicros: 50_000_000 });
    await executeSmoke(data.api, executeOptions(receiptPath));
    await expect(
      executeSmoke(data.api, { ...executeOptions(receiptPath), routeId: 'fixture/route-2' }),
    ).rejects.toThrow('Insufficient remaining test budget');
    expect(data.paidPosts()).toBe(1);
    const nonemptyPath = await temporaryReceipt();
    await writeFile(
      nonemptyPath,
      JSON.stringify({ authorized_usd: 50, spent_usd: 1, provider_requests: [{ id: 'earlier' }] }),
      { mode: 0o600 },
    );
    await expect(executeSmoke(data.api, executeOptions(nonemptyPath))).rejects.toThrow(
      'Receipt identity or budget differs',
    );
    expect(data.paidPosts()).toBe(1);
  });
  it('serializes receipt access and checks required scopes before billable admission', async () => {
    const receiptPath = await temporaryReceipt();
    let release!: () => void;
    let reached!: () => void;
    const submitted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const data = fixture({
      beforeSubmit: async () => {
        reached();
        await gate;
      },
    });
    const first = executeSmoke(data.api, executeOptions(receiptPath));
    await submitted;
    await expect(executeSmoke(data.api, executeOptions(receiptPath))).rejects.toThrow(
      'receipt is locked',
    );
    release();
    await first;
    expect(data.paidPosts()).toBe(1);
    const denied = fixture({ scopes: ['generate'] });
    await expect(
      executeSmoke(denied.api, executeOptions(await temporaryReceipt())),
    ).rejects.toThrow('plus generate scope');
    expect(denied.paidPosts()).toBe(0);
  });
});
