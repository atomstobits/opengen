import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { C2paVerification, GenerateInput, Job, OutputAsset } from '@media-router/contracts';
import { projectCustomerJob } from '../packages/engine/src/delivery-projection.js';

const jobId = randomUUID();
const key = `outputs/${jobId}/${randomUUID()}.png`;
const sourceUrl = 'https://provider.example/private?provider_token=synthetic';
const signedUrl = 'https://private-storage.example/capability?signature=synthetic';
const expiresAt = '2099-01-01T00:00:00.000Z';
const source: OutputAsset = {
  storageKey: key,
  url: sourceUrl,
  mediaType: 'image/png',
  fidelity: 'unverified',
};
function fixture(overrides: Partial<Job> = {}): Job {
  return {
    id: jobId,
    workspaceId: 'fixture',
    status: 'succeeded',
    deliveryStatus: 'available',
    input: {
      modelId: 'bytedance/seedream-5.0-pro',
      operation: 'text-to-image',
      input: { prompt: 'Synthetic fixture.', count: 1 },
    },
    routeId: 'fixture/route',
    deploymentId: 'fixture/deployment',
    upstreamId: 'private-upstream-task-id',
    outputs: [{ ...source }],
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    reservedMicros: 17,
    settledMicros: 17,
    attemptCount: 1,
    ...overrides,
  };
}
function signer() {
  return {
    sign: vi.fn(async (storageKey: string, mediaType: string) => ({
      storageKey,
      url: signedUrl,
      mediaType,
      fidelity: 'unverified' as const,
      expiresAt,
    })),
  };
}

describe('strict customer delivery projection', () => {
  it('checks workspace authorization before minting any output capability', async () => {
    const storage = signer();
    for (const workspaceId of ['', 'foreign']) {
      await expect(projectCustomerJob(workspaceId, fixture(), storage)).rejects.toMatchObject({
        statusCode: 404,
        code: 'not_found',
        message: 'Job not found.',
      });
    }
    expect(storage.sign).not.toHaveBeenCalled();
  });

  it('issues fresh owned capabilities and removes unknown private fields at every projected boundary', async () => {
    const evidence = {
      status: 'valid',
      checkedAt: '2026-11-04T00:00:00.000Z',
      sha256: 'a'.repeat(64),
      tool: 'c2patool',
      validationCodes: ['claimSignature.validated'],
      signer: 'Synthetic signer',
      receipt: { secret: 'c2pa-secret' },
    } as C2paVerification;
    const input = {
      modelId: 'bytedance/seedream-5.0-pro',
      operation: 'image-edit',
      providerConnectionId: 'input-secret',
      input: {
        prompt: 'Synthetic fixture.',
        size: { width: 1024, height: 1024, credential: 'size-secret' },
        firstFrame: { assetKey: 'inputs/fixture/input.png', credential: 'asset-secret' },
        references: [
          {
            type: 'image',
            asset: {
              url: 'https://customer.example/reference.png',
              credential: 'reference-secret',
            },
            receipt: 'reference-row-secret',
          },
        ],
        keyframes: [
          {
            at: 'start',
            image: { assetKey: 'inputs/fixture/input.png', secret: 'keyframe-asset-secret' },
            secret: 'keyframe-secret',
          },
        ],
        shots: [{ prompt: 'A shot.', duration: 3, private: 'shot-secret' }],
        elements: [
          {
            id: 'element',
            description: 'A prop.',
            images: [{ assetKey: 'inputs/fixture/input.png', secret: 'element-asset-secret' }],
            voice: { url: 'https://customer.example/voice.wav', secret: 'voice-secret' },
            secret: 'element-secret',
          },
        ],
        privateReceipt: 'args-secret',
      },
      routing: { providerIds: ['fixture'], credential: 'policy-secret' },
    } as GenerateInput;
    const job = {
      ...fixture({
        input,
        outputs: [
          {
            ...source,
            sha256: 'a'.repeat(64),
            byteLength: 50,
            c2pa: evidence,
            receipt: 'output-secret',
          } as OutputAsset,
        ],
      }),
      providerConnectionId: 'connection-secret',
      receipts: [{ source_url: sourceUrl }],
    };
    const storage = signer();
    const projected = await projectCustomerJob('fixture', job, storage);
    expect(storage.sign).toHaveBeenCalledExactlyOnceWith(key, 'image/png');
    expect(projected.outputs).toEqual([
      {
        outputIndex: 0,
        url: signedUrl,
        expiresAt,
        mediaType: 'image/png',
        fidelity: 'unverified',
        sha256: 'a'.repeat(64),
        byteLength: 50,
        c2pa: {
          status: 'valid',
          checkedAt: '2026-11-04T00:00:00.000Z',
          sha256: 'a'.repeat(64),
          tool: 'c2patool',
          validationCodes: ['claimSignature.validated'],
          signer: 'Synthetic signer',
        },
      },
    ]);
    expect(projected).toMatchObject({
      status: 'succeeded',
      deliveryStatus: 'available',
      upstreamId: null,
      reservedMicros: 17,
      settledMicros: 17,
      routeId: job.routeId,
      deploymentId: job.deploymentId,
    });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain(sourceUrl);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('private-upstream-task-id');
    expect(projected.input.input.references?.[0]?.asset).toEqual({
      url: 'https://customer.example/reference.png',
    });
    expect(job.outputs[0]!.storageKey).toBe(key);
  });

  it.each([
    'outputs/foreign/123.png',
    `outputs/${randomUUID()}/${randomUUID()}.png`,
    `outputs/${jobId}/not-a-uuid.png`,
    `outputs/${jobId}/${randomUUID()}.jpg`,
    `outputs/${jobId}/${randomUUID()}.png?secret=1`,
    `outputs/${jobId}/../${randomUUID()}.png`,
    `inputs/${jobId}/${randomUUID()}.png`,
    undefined,
  ])(
    'rejects non-owned, malformed or media-mismatched key %s without signing',
    async (storageKey) => {
      const storage = signer();
      const projected = await projectCustomerJob(
        'fixture',
        fixture({ outputs: [{ ...source, storageKey }] }),
        storage,
      );
      expect(projected.deliveryStatus).toBe('failed');
      expect(projected.outputs).toEqual([]);
      expect(storage.sign).not.toHaveBeenCalled();
      expect(JSON.stringify(projected)).not.toContain(sourceUrl);
    },
  );

  it('returns no provider or stale signed output if storage is absent', async () => {
    const projected = await projectCustomerJob('fixture', fixture());
    expect(projected).toMatchObject({
      status: 'succeeded',
      deliveryStatus: 'failed',
      outputs: [],
      reservedMicros: 17,
      settledMicros: 17,
    });
    expect(JSON.stringify(projected)).not.toContain(sourceUrl);
  });

  it('drops a failed signature instead of falling back to either old output URL', async () => {
    const storage = {
      sign: vi.fn(async () => {
        throw new Error(`credentials failed for ${sourceUrl}`);
      }),
    };
    const projected = await projectCustomerJob('fixture', fixture(), storage);
    expect(projected).toMatchObject({
      status: 'succeeded',
      deliveryStatus: 'failed',
      outputs: [],
      deliveryErrors: [{ index: 0, code: 'url_refresh_failed' }],
    });
    expect(JSON.stringify(projected)).not.toContain('provider_token');
    expect(JSON.stringify(projected)).not.toContain('credentials');
  });

  it.each([
    { url: 'http://storage.example/output', expiresAt },
    { url: 'data:image/png;base64,synthetic', expiresAt },
    { url: 'https://user:password@storage.example/output', expiresAt },
    { url: signedUrl, expiresAt: '2000-01-01T00:00:00.000Z' },
    { url: signedUrl, expiresAt: 'invalid' },
    { url: signedUrl, expiresAt: undefined },
  ])('does not expose malformed or expired newly signed capabilities %#', async (capability) => {
    const storage = { sign: vi.fn(async () => ({ ...source, ...capability })) };
    const projected = await projectCustomerJob('fixture', fixture(), storage);
    expect(projected.deliveryStatus).toBe('failed');
    expect(projected.outputs).toEqual([]);
  });

  it('retains one successful capability when another slot fails and keeps the bill intact', async () => {
    const second = { ...source, storageKey: `outputs/${jobId}/${randomUUID()}.png` };
    const storage = signer();
    storage.sign.mockRejectedValueOnce(new Error('private storage outage'));
    const projected = await projectCustomerJob(
      'fixture',
      fixture({ outputs: [source, second], input: { ...fixture().input, input: { count: 2 } } }),
      storage,
    );
    expect(projected).toMatchObject({
      status: 'succeeded',
      deliveryStatus: 'partial',
      reservedMicros: 17,
      settledMicros: 17,
    });
    expect(projected.outputs).toHaveLength(1);
    expect(projected.outputs[0]?.outputIndex).toBe(1);
    expect(projected.deliveryErrors).toEqual([{ index: 0, code: 'url_refresh_failed' }]);
  });

  it('does not upgrade a partial delivery merely because every retained slot can be signed', async () => {
    const projected = await projectCustomerJob(
      'fixture',
      fixture({
        deliveryStatus: 'partial',
        deliveryErrors: [{ index: 1, code: `unsafe ${sourceUrl}` }],
      }),
      signer(),
    );
    expect(projected.deliveryStatus).toBe('partial');
    expect(projected.outputs).toHaveLength(1);
    expect(projected.deliveryErrors).toEqual([{ index: 1, code: 'output_delivery_failed' }]);
    expect(JSON.stringify(projected)).not.toContain(sourceUrl);
  });

  it('does not count duplicate retained keys as separately delivered outputs', async () => {
    const storage = signer();
    const projected = await projectCustomerJob(
      'fixture',
      fixture({ outputs: [source, source] }),
      storage,
    );
    expect(storage.sign).toHaveBeenCalledTimes(1);
    expect(projected.deliveryStatus).toBe('partial');
    expect(projected.outputs).toHaveLength(1);
  });

  it.each(['queued', 'submitting', 'running', 'submission-unknown'] as const)(
    'keeps %s generation outcome independent from missing output delivery',
    async (status) => {
      const projected = await projectCustomerJob(
        'fixture',
        fixture({ status, outputs: [], error: null }),
        signer(),
      );
      expect(projected).toMatchObject({
        status,
        outputs: [],
        deliveryStatus: 'pending',
        reservedMicros: 17,
        settledMicros: 17,
      });
      expect(JSON.stringify(projected)).not.toContain(sourceUrl);
    },
  );

  it('preserves captured durable delivery work while no slot is retained yet', async () => {
    const projected = await projectCustomerJob(
      'fixture',
      fixture({ outputs: [], deliveryStatus: 'pending' } as Partial<Job>),
      signer(),
    );
    expect(projected).toMatchObject({
      status: 'succeeded',
      deliveryStatus: 'pending',
      outputs: [],
    });
  });

  it.each(['failed', 'cancelled'] as const)(
    'does not imply pending recovery for a terminal %s generation',
    async (status) => {
      const projected = await projectCustomerJob(
        'fixture',
        fixture({ status, outputs: [], error: sourceUrl }),
        signer(),
      );
      expect(projected).toMatchObject({
        status,
        deliveryStatus: 'failed',
        outputs: [],
        error: 'Generation did not complete.',
      });
    },
  );

  it('keeps explicit terminal source expiry honest', async () => {
    const projected = await projectCustomerJob(
      'fixture',
      fixture({ outputs: [], deliveryStatus: 'expired' } as Partial<Job>),
      signer(),
    );
    expect(projected.deliveryStatus).toBe('expired');
  });
});

it('remaps receipt slots after a signing failure without losing failed-slot evidence', async () => {
  const storage = signer();
  storage.sign.mockRejectedValueOnce(new Error('private credential URL'));
  const job = {
    ...fixture({
      outputs: [source, { ...source, storageKey: `outputs/${jobId}/${randomUUID()}.png` }],
    }),
    outputEvidence: [
      {
        index: 0,
        state: 'failed',
        outputIndex: null,
        code: 'output_nonconformant',
        inspection: {
          conformance: {
            status: 'nonconformant',
            notices: [
              {
                code: 'requested_output_mismatch',
                field: 'requiresAudio',
                requested: true,
                delivered: false,
              },
            ],
          },
        },
      },
      { index: 1, state: 'available', outputIndex: 0 },
      { index: 2, state: 'available', outputIndex: 1 },
    ],
  };
  const projected = await projectCustomerJob('fixture', job, storage);
  expect(projected.outputs).toHaveLength(1);
  expect(projected.outputs[0]!.outputIndex).toBe(2);
  expect(projected.deliveryErrors).toEqual([{ index: 1, code: 'url_refresh_failed' }]);
  expect(projected.outputEvidence).toMatchObject([
    {
      index: 0,
      state: 'failed',
      outputIndex: null,
      code: 'output_nonconformant',
      inspection: {
        conformance: {
          status: 'nonconformant',
          notices: [
            {
              code: 'requested_output_mismatch',
              field: 'requiresAudio',
              requested: true,
              delivered: false,
            },
          ],
        },
      },
    },
    { index: 1, state: 'failed', outputIndex: null, code: 'url_refresh_failed' },
    { index: 2, state: 'available', outputIndex: 0 },
  ]);
  expect(JSON.stringify(projected)).not.toContain('credential');
});

it.each([false, true])(
  'keeps a partially delivered output identity when earlier slots recover (persisted slot: %s)',
  async (persistedSlot) => {
    const first = { ...source, storageKey: `outputs/${jobId}/${randomUUID()}.png` };
    const second = { ...source, ...(persistedSlot ? { outputIndex: 1 } : {}) };
    const partial = await projectCustomerJob(
      'fixture',
      {
        ...fixture({ outputs: [second], deliveryStatus: 'partial' }),
        outputEvidence: [
          { index: 0, state: 'pending', outputIndex: null },
          { index: 1, state: 'available', outputIndex: 0 },
        ],
      },
      signer(),
    );
    expect(partial.outputs[0]!.outputIndex).toBe(1);
    expect(partial.outputEvidence).toMatchObject([
      { index: 0, state: 'pending', outputIndex: null },
      { index: 1, state: 'available', outputIndex: 0 },
    ]);
    const complete = await projectCustomerJob(
      'fixture',
      {
        ...fixture({ outputs: [first, second] }),
        outputEvidence: [
          { index: 0, state: 'available', outputIndex: 0 },
          { index: 1, state: 'available', outputIndex: 1 },
        ],
      },
      signer(),
    );
    expect(complete.outputs[1]!.outputIndex).toBe(partial.outputs[0]!.outputIndex);
  },
);

it.each([
  [{ decode: { status: 'failed', coverage: 'none' } }, 'output_decode_failed'],
  [{ conformance: { status: 'nonconformant', notices: [] } }, 'output_nonconformant'],
] as const)(
  'never signs a retained output known unusable in its mapped inspection %#',
  async (inspection, code) => {
    const storage = signer();
    const projected = await projectCustomerJob(
      'fixture',
      {
        ...fixture(),
        outputEvidence: [{ index: 4, state: 'available', outputIndex: 0, inspection }],
      },
      storage,
    );
    expect(storage.sign).not.toHaveBeenCalled();
    expect(projected.outputs).toEqual([]);
    expect(projected.outputEvidence).toMatchObject([
      { index: 4, state: 'failed', outputIndex: null, code },
    ]);
  },
);
