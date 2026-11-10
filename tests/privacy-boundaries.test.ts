import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import type { Job } from '@media-router/contracts';

const jobId = '0171cd13-c992-4ac0-87d2-4f59092bca9d';
const capability = 'https://owned.example.invalid/private.png?cap=synthetic';
const privateError = 'SYNTHETIC_PRIVATE https://provider.example.invalid/media?secret=fixture';
const job: Job = {
  id: jobId,
  workspaceId: 'owner',
  status: 'succeeded',
  deliveryStatus: 'available',
  input: {
    modelId: 'bytedance/seedream-5.0-pro',
    operation: 'text-to-image',
    input: { prompt: 'Synthetic private fixture.', resolution: '1K' },
  },
  routeId: 'fixture/route',
  deploymentId: 'fixture/deployment',
  upstreamId: null,
  outputs: [{ url: capability, mediaType: 'image/png', fidelity: 'unverified' }],
  error: null,
  createdAt: '2026-11-04T00:00:00.000Z',
  updatedAt: '2026-11-04T00:00:00.000Z',
  reservedMicros: 20,
  settledMicros: 20,
  attemptCount: 1,
};
function engineFixture() {
  const authenticate = vi.fn(async (_token: string) => ({
    workspaceId: 'owner',
    scopes: ['generate', 'read'],
    keyId: 'fixture-key',
  }));
  const engine: EngineLike = {
    accounts: { authenticate } as unknown as EngineLike['accounts'],
    getExecutableRouteIds: () => [],
    submit: vi.fn(async () => job),
    getJob: vi.fn(async () => job),
    listJobs: async () => [job],
    cancel: vi.fn(async () => job),
    getBalance: vi.fn(async () => ({ availableMicros: 20 })),
    routeMetrics: async () => [],
  };
  return { engine, authenticate };
}
const imageRequest = {
  method: 'POST' as const,
  url: '/v1/images/generations',
  headers: { authorization: 'Bearer fixture', 'idempotency-key': 'private-wait' },
  payload: {
    model: 'bytedance/seedream-5.0-pro',
    prompt: 'Synthetic private fixture.',
    size: '1024x1024',
  },
};
const rpc = (name: string, args: object = {}) => ({
  method: 'POST' as const,
  url: '/mcp',
  headers: {
    authorization: 'Bearer fixture',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26',
  },
  payload: {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  },
});

it.each(['immediate', 'poll'] as const)(
  'rejects revoked authority before delivering an %s image response',
  async (phase) => {
    const { engine, authenticate } = engineFixture();
    let revoked = false;
    authenticate.mockImplementation(async () =>
      revoked ? null! : { workspaceId: 'owner', scopes: ['generate'], keyId: 'fixture-key' },
    );
    engine.submit = vi.fn(async () => {
      revoked = true;
      return phase === 'immediate' ? job : { ...job, status: 'running', outputs: [] };
    });
    const app = await buildApp({ engine });
    try {
      const response = await app.inject(imageRequest);
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(capability);
      expect(response.body).not.toContain(jobId);
      expect(engine.submit).toHaveBeenCalledOnce();
      expect(engine.getJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  },
);

it('reauthorizes after polling before returning an owned image capability', async () => {
  const { engine, authenticate } = engineFixture();
  engine.submit = vi.fn(async () => ({ ...job, status: 'running', outputs: [] }));
  engine.getJob = vi.fn(async () => {
    authenticate.mockResolvedValue(null!);
    return job;
  });
  const app = await buildApp({ engine });
  try {
    const response = await app.inject(imageRequest);
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(capability);
    expect(engine.submit).toHaveBeenCalledOnce();
    expect(engine.getJob).toHaveBeenCalledExactlyOnceWith('owner', jobId);
  } finally {
    await app.close();
  }
});

it('rejects a workspace change during image admission without issuing its output', async () => {
  const { engine, authenticate } = engineFixture();
  engine.submit = vi.fn(async () => {
    authenticate.mockResolvedValue({
      workspaceId: 'foreign',
      scopes: ['generate'],
      keyId: 'fixture-key',
    });
    return job;
  });
  const app = await buildApp({ engine });
  try {
    const response = await app.inject(imageRequest);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(capability);
    expect(engine.submit).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

it.each([
  ['base64', 'success'],
  ['base64', 'failure'],
  ['video-range', 'success'],
  ['video-range', 'failure'],
] as const)(
  'withholds private %s replies when authority is revoked during storage %s',
  async (format, outcome) => {
    const { engine, authenticate } = engineFixture();
    const video = format === 'video-range';
    const bytes = video
      ? Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(20)])
      : Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const mediaType = video ? 'video/mp4' : 'image/png';
    const output = {
      ...job.outputs[0]!,
      storageKey: `outputs/${jobId}/0171cd13-c992-4ac0-87d2-4f59092bca9e.${video ? 'mp4' : 'png'}`,
      mediaType,
    };
    const current: Job = {
      ...job,
      outputs: [output],
      ...(video
        ? {
            input: {
              modelId: 'bytedance/seedance-2.5',
              operation: 'text-to-video',
              input: { prompt: 'Synthetic private video.', duration: 5 },
            },
          }
        : {}),
    };
    engine.submit = vi.fn(async () => current);
    engine.getJob = vi.fn(async () => current);
    engine.ownedOutputAccess = {
      getOwnedOutputJob: vi.fn(async () => current),
    } as unknown as EngineLike['ownedOutputAccess'];
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'HeadObjectCommand')
        return { ContentLength: bytes.length, ContentType: mediaType };
      authenticate.mockResolvedValue(null!);
      if (outcome === 'failure') throw new Error(privateError);
      return {
        Body: Readable.from([video ? bytes.subarray(0, 4) : bytes]),
        ContentLength: video ? 4 : bytes.length,
        ...(video ? { ContentRange: `bytes 0-3/${bytes.length}` } : {}),
      };
    });
    // The storage adapter is synthetic; the actual compatibility byte reader runs.
    engine.storage = { bucket: 'synthetic', client: { send } } as unknown as EngineLike['storage'];
    const app = await buildApp({ engine });
    try {
      const response = await app.inject(
        video
          ? {
              url: `/v1/videos/${jobId}/content`,
              headers: { authorization: 'Bearer fixture', range: 'bytes=0-3' },
            }
          : {
              ...imageRequest,
              payload: { ...imageRequest.payload, response_format: 'b64_json' },
            },
      );
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain('b64_json');
      expect(response.body).not.toContain(capability);
      expect(response.body).not.toContain(jobId);
      expect(response.body).not.toContain('reserved_micros');
      expect(response.headers['content-type']).toContain('application/json');
      expect(send).toHaveBeenCalledTimes(video ? 2 : 1);
    } finally {
      await app.close();
    }
  },
);

it('marks direct MCP private tool responses no-store despite socket hijacking', async () => {
  const { engine } = engineFixture();
  const app = await buildApp({ engine });
  try {
    const response = await app.inject(rpc('job_get', { id: jobId }));
    expect(response.statusCode).toBe(200);
    expect(response.json().result.structuredContent.id).toBe(jobId);
    expect(response.headers['cache-control']).toContain('no-store');
  } finally {
    await app.close();
  }
});

it.each(['job_get', 'job_cancel', 'balance', 'quote'])(
  'does not expose internal errors through direct MCP %s',
  async (name) => {
    const { engine } = engineFixture();
    const fail = vi.fn(async () => {
      throw new Error(privateError);
    });
    engine.getJob = fail;
    engine.cancel = fail;
    engine.getBalance = fail;
    engine.routeMetrics = fail;
    const app = await buildApp({ engine });
    try {
      const response = await app.inject(
        rpc(
          name,
          name === 'balance'
            ? {}
            : name === 'quote'
              ? { input: { ...job.input, routing: { preference: 'speed' } } }
              : { id: jobId },
        ),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json().result.isError).toBe(true);
      expect(fail).toHaveBeenCalledOnce();
      expect(response.body).not.toContain('SYNTHETIC_PRIVATE');
      expect(response.body).not.toContain('provider.example.invalid');
      expect(response.body).not.toContain('secret=fixture');
    } finally {
      await app.close();
    }
  },
);

it('preserves useful MCP scope errors through canonical HTTP authorization', async () => {
  const { engine, authenticate } = engineFixture();
  authenticate.mockResolvedValue({
    workspaceId: 'owner',
    scopes: ['read'],
    keyId: 'fixture-key',
  });
  const app = await buildApp({ engine });
  try {
    const response = await app.inject(rpc('job_cancel', { id: jobId }));
    expect(response.json().result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'insufficient_scope' } },
    });
    expect(engine.cancel).not.toHaveBeenCalled();
    expect(response.body).not.toContain(capability);
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
  }
});
