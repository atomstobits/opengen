import { expect, it, vi } from 'vitest';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import type { Job } from '@media-router/contracts';

const jobId = '0171cd13-c992-4ac0-87d2-4f59092bca9d';
const owned = {
  url: 'https://private-storage.example/fixture.png?capability=synthetic',
  storageKey: `outputs/${jobId}/fixture.png`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  mediaType: 'image/png',
  fidelity: 'unverified' as const,
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
      input: { prompt: 'A synthetic fixture.', resolution: '1K' },
    },
    routeId: 'fixture/image',
    deploymentId: 'fixture/region',
    upstreamId: null,
    outputs: [{ ...owned }],
    error: null,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    reservedMicros: 20,
    settledMicros: 20,
    attemptCount: 1,
    ...overrides,
  };
}
function videoFixture(overrides: Partial<Job> = {}) {
  return fixture({
    input: {
      modelId: 'minimax/h3-max',
      operation: 'text-to-video',
      input: { prompt: 'A synthetic fixture.', resolution: '480p', duration: 6 },
    },
    outputs: [{ ...owned, mediaType: 'video/mp4' }],
    ...overrides,
  });
}
async function setup(job: Job) {
  const submit = vi.fn(async () => job);
  const getJob = vi.fn(async (workspaceId: string) =>
    workspaceId === job.workspaceId ? job : null,
  );
  const engine: EngineLike = {
    accounts: {
      authenticate: async (token: string) =>
        token === 'generate-only'
          ? { workspaceId: 'fixture', scopes: ['generate'], keyId: 'fixture' }
          : token === 'reader' || token === 'foreign'
            ? {
                workspaceId: token === 'reader' ? 'fixture' : 'other',
                scopes: ['read'],
                keyId: token,
              }
            : null,
    } as EngineLike['accounts'],
    getExecutableRouteIds: () => [],
    submit,
    getJob,
    listJobs: async () => [],
    cancel: async () => job,
    getBalance: async () => ({}),
    routeMetrics: async () => [],
  };
  return { app: await buildApp({ engine }), submit, getJob };
}
const imageRequest = {
  method: 'POST' as const,
  url: '/v1/images/generations',
  headers: { authorization: 'Bearer generate-only', 'idempotency-key': 'stable-fixture' },
  payload: {
    model: 'bytedance/seedream-5.0-pro',
    prompt: 'A synthetic fixture.',
    size: '1024x1024',
  },
};

it('lets a generate-only key receive its owned image response without a post-admission read failure', async () => {
  // The customer projection may omit its internal storage key.
  const { storageKey: _key, ...projectedOutput } = owned;
  const { app, submit, getJob } = await setup(fixture({ outputs: [projectedOutput] }));
  try {
    const response = await app.inject(imageRequest);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data).toEqual([{ url: owned.url }]);
    expect(submit).toHaveBeenCalledOnce();
    expect(getJob).not.toHaveBeenCalled();
    const read = await app.inject({
      url: `/v1/generations/${jobId}`,
      headers: { authorization: 'Bearer generate-only' },
    });
    expect(read.statusCode).toBe(403);
  } finally {
    await app.close();
  }
});

it.each([
  ['empty successful image', { outputs: [] }, 409, 'failed'],
  ['wrong output media', { outputs: [{ ...owned, mediaType: 'video/mp4' }] }, 409, 'failed'],
  ['failed archive', { outputs: [], deliveryStatus: 'failed' }, 409, 'failed'],
  ['partial archive', { deliveryStatus: 'partial' }, 202, 'partial'],
  ['unverified provider URL', { deliveryStatus: 'unverified' }, 409, 'unverified'],
  ['legacy provider URL', { deliveryStatus: undefined }, 409, 'unverified'],
  [
    'expired capability',
    { outputs: [{ ...owned, expiresAt: '2000-01-01T00:00:00.000Z' }] },
    409,
    'expired',
  ],
  ['invalid expiry', { outputs: [{ ...owned, expiresAt: 'unknown' }] }, 409, 'failed'],
  [
    'another job output',
    { outputs: [{ ...owned, storageKey: 'outputs/foreign/fixture.png' }] },
    409,
    'failed',
  ],
  ['inline data', { outputs: [{ ...owned, url: 'data:image/png;base64,private' }] }, 409, 'failed'],
  [
    'unsafe URL',
    { outputs: [{ ...owned, url: 'http://provider.example/private' }] },
    409,
    'failed',
  ],
  ['pending delivery', { deliveryStatus: 'pending' }, 202, 'pending'],
  ['explicit expiry', { outputs: [], deliveryStatus: 'expired' }, 409, 'expired'],
] as const)(
  'never returns successful empty image data for %s',
  async (_label, overrides, httpCode, status) => {
    const { app, submit, getJob } = await setup(fixture(overrides as Partial<Job>));
    try {
      const response = await app.inject(imageRequest);
      expect(response.statusCode).toBe(httpCode);
      expect(response.headers.location).toBe(`/v1/generations/${jobId}`);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).not.toHaveProperty('data');
      expect(response.json().opengen).toMatchObject({
        job_id: jobId,
        status: 'succeeded',
        delivery_status: status,
        reserved_micros: 20,
        settled_micros: 20,
      });
      expect(response.body).not.toContain(owned.url);
      expect(response.body).not.toContain('storageKey');
      expect(submit).toHaveBeenCalledOnce();
      expect(getJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it.each(['failed', 'cancelled', 'submission-unknown'] as const)(
  'keeps %s distinct and suppresses private provider errors',
  async (status) => {
    const { app } = await setup(
      fixture({ status, error: 'provider secret: https://upstream.example/private-token' }),
    );
    try {
      const response = await app.inject(imageRequest);
      expect(response.statusCode).toBe(status === 'submission-unknown' ? 202 : 422);
      expect(response.json().opengen.status).toBe(status);
      expect(response.body).not.toContain('private-token');
      expect(response.body).not.toContain('provider secret');
      if (status === 'submission-unknown') {
        expect(response.json().opengen).toMatchObject({
          requires_reconciliation: true,
          recovery: 'operator',
        });
      }
    } finally {
      await app.close();
    }
  },
);

it.each([
  ['available', [{ ...owned, mediaType: 'video/mp4' }], 'completed', 303],
  ['available', [], 'failed', 409],
  ['pending', [], 'in_progress', 409],
  ['partial', [{ ...owned, mediaType: 'video/mp4' }], 'in_progress', 409],
  ['failed', [], 'failed', 409],
  ['expired', [], 'failed', 409],
  ['unverified', [{ ...owned, url: 'https://provider.example/private' }], 'failed', 409],
  [undefined, [{ ...owned, url: 'https://provider.example/private' }], 'failed', 409],
] as const)(
  'video completion and content agree for delivery %s',
  async (deliveryStatus, outputs, expectedStatus, contentCode) => {
    const { app, submit } = await setup(
      videoFixture({ deliveryStatus, outputs: [...outputs] } as Partial<Job>),
    );
    try {
      const read = await app.inject({
        url: `/v1/videos/${jobId}`,
        headers: { authorization: 'Bearer reader' },
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.json()).toMatchObject({
        status: expectedStatus,
        opengen: { status: 'succeeded', job_id: jobId },
      });
      expect(read.body).not.toContain('https://provider.example/private');
      const content = await app.inject({
        url: `/v1/videos/${jobId}/content`,
        headers: { authorization: 'Bearer reader' },
      });
      expect(content.statusCode).toBe(contentCode);
      expect(content.headers['cache-control']).toBe('no-store');
      expect(content.headers.location).toBe(
        contentCode === 303 ? owned.url : `/v1/generations/${jobId}`,
      );
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('never redirects an expired video capability or a raw provider URL without archival', async () => {
  const { app } = await setup(
    videoFixture({ outputs: [{ ...owned, expiresAt: '2000-01-01T00:00:00Z' }] }),
  );
  try {
    const read = await app.inject({
      url: `/v1/videos/${jobId}`,
      headers: { authorization: 'Bearer reader' },
    });
    expect(read.json()).toMatchObject({
      status: 'failed',
      opengen: { delivery_status: 'expired' },
    });
    const content = await app.inject({
      url: `/v1/videos/${jobId}/content`,
      headers: { authorization: 'Bearer reader' },
    });
    expect(content.statusCode).toBe(409);
    expect(content.headers.location).not.toBe(owned.url);
  } finally {
    await app.close();
  }
});

it('requires read authority and owning workspace for both video reads and content', async () => {
  const { app, getJob } = await setup(videoFixture());
  try {
    for (const path of [`/v1/videos/${jobId}`, `/v1/videos/${jobId}/content`]) {
      for (const [token, status] of [
        ['unknown', 401],
        ['generate-only', 403],
        ['foreign', 404],
      ] as const) {
        const response = await app.inject({
          url: path,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(status);
        expect(response.body).not.toContain(owned.url);
      }
    }
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(getJob).toHaveBeenCalledWith('other', jobId);
  } finally {
    await app.close();
  }
});

it('returns stable accepted video identity while delivery is pending', async () => {
  const { app, submit } = await setup(
    videoFixture({ outputs: [], deliveryStatus: 'pending' } as Partial<Job>),
  );
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/videos',
      headers: imageRequest.headers,
      payload: {
        model: 'minimax/h3-max',
        prompt: 'A synthetic fixture.',
        seconds: '6',
        size: '854x480',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.headers.location).toBe(`/v1/videos/${jobId}`);
    expect(response.json()).toMatchObject({
      id: jobId,
      status: 'in_progress',
      opengen: { delivery_status: 'pending', recovery: 'same_job' },
    });
    expect(submit).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
