import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { buildApp, type EngineLike } from '../apps/server/src/app';
import type { Job } from '@media-router/contracts';

const id = '0171cd13-c992-4ac0-87d2-4f59092bca9d';
const objectId = '0171cd13-c992-4ac0-87d2-4f59092bca9e';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
const headers = { authorization: 'Bearer owner', 'idempotency-key': 'stable-breadth-fixture' };
function fixture(video = false) {
  const bytes = video ? mp4 : png;
  const mediaType = video ? 'video/mp4' : 'image/png';
  const job: Job = {
    id,
    workspaceId: 'owner',
    status: 'succeeded',
    deliveryStatus: 'available',
    input: {
      modelId: video ? 'bytedance/seedance-2.5' : 'bytedance/seedream-5.0-pro',
      operation: video ? 'text-to-video' : 'text-to-image',
      input: { prompt: 'Synthetic fixture.', duration: 5 },
    },
    routeId: 'fixture/image',
    deploymentId: 'fixture/region',
    upstreamId: null,
    outputs: [
      {
        url: 'https://owned.example.invalid/fixture?cap=synthetic',
        mediaType,
        fidelity: 'unverified',
        storageKey: `outputs/${id}/${objectId}.${video ? 'mp4' : 'png'}`,
      },
    ],
    error: null,
    createdAt: '2026-11-04T00:00:00.000Z',
    updatedAt: '2026-11-04T00:00:00.000Z',
    reservedMicros: 2,
    settledMicros: 2,
    attemptCount: 1,
  };
  const send = vi.fn(
    async (command: { constructor: { name: string }; input: { Range?: string } }) => {
      if (command.constructor.name === 'HeadObjectCommand')
        return { ContentLength: bytes.length, ContentType: mediaType, ETag: 'fixture-etag' };
      const match = command.input.Range?.match(/^bytes=(\d+)-(\d+)$/);
      const selected = match ? bytes.subarray(Number(match[1]), Number(match[2]) + 1) : bytes;
      return {
        Body: Readable.from([selected]),
        ContentLength: selected.length,
        ...(match ? { ContentRange: `bytes ${match[1]}-${match[2]}/${bytes.length}` } : {}),
      };
    },
  );
  // Match the integrated customer projection: no storageKey in submit/getJob.
  const projected = {
    ...job,
    outputs: job.outputs.map(({ storageKey: _key, ...output }) => output),
  };
  const submit = vi.fn(async () => projected);
  const getJob = vi.fn(async (workspaceId: string) => (workspaceId === 'owner' ? projected : null));
  const ownedOutputAccess = {
    getOwnedOutputJob: vi.fn(async (workspaceId: string, jobId: string) =>
      workspaceId === 'owner' && jobId === id ? job : null,
    ),
  };
  const engine = {
    accounts: {
      authenticate: async (token: string) => ({
        workspaceId: token === 'foreign' ? 'foreign' : 'owner',
        scopes:
          token === 'generate-only'
            ? ['generate']
            : token === 'read-only'
              ? ['read']
              : ['read', 'generate'],
        keyId: token,
      }),
    } as EngineLike['accounts'],
    storage: { bucket: 'private-fixture', client: { send } } as unknown as EngineLike['storage'],
    getExecutableRouteIds: () => [],
    submit,
    getJob,
    listJobs: async () => [],
    cancel: async () => job,
    getBalance: async () => ({}),
    routeMetrics: async () => [],
    ownedOutputAccess,
  } as EngineLike & { ownedOutputAccess?: typeof ownedOutputAccess };
  return { engine, job, send, submit, getJob, ownedOutputAccess };
}
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function appFor(engine: EngineLike) {
  const app = await buildApp({ engine });
  apps.push(app);
  return app;
}

describe('compatibility image breadth HTTP conformance', () => {
  it('fails closed with the existing charged job when private read access is not wired', async () => {
    const { engine, submit, send } = fixture();
    delete engine.ownedOutputAccess;
    const app = await appFor(engine);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers,
      payload: {
        model: 'bytedance/seedream-5.0-pro',
        prompt: 'Fixture.',
        response_format: 'b64_json',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().opengen.job_id).toBe(id);
    expect(response.json().opengen.settled_micros).toBe(2);
    expect(submit).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
  it('returns bounded base64 from owned storage with generate-only scope', async () => {
    const { engine, submit, send } = fixture();
    const app = await appFor(engine);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/generations',
      headers: { ...headers, authorization: 'Bearer generate-only' },
      payload: {
        model: 'bytedance/seedream-5.0-pro',
        prompt: 'Synthetic fixture.',
        response_format: 'b64_json',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ b64_json: png.toString('base64') }]);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(submit).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(response.body).not.toContain('storageKey');
    expect(response.body).not.toContain('owned.example');
  });
  it('converts ordered JSON edit references without injecting a square geometry', async () => {
    const { engine, submit } = fixture();
    const app = await appFor(engine);
    const image = [{ assetKey: 'inputs/owner/first.png' }, { assetKey: 'inputs/owner/second.png' }];
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers,
      payload: { model: 'bytedance/seedream-5.0-pro', prompt: 'Synthetic edit.', image },
    });
    expect(response.statusCode).toBe(200);
    const request = submit.mock.calls[0]![0].input;
    expect(request.operation).toBe('image-edit');
    expect(request.input.references).toEqual(image.map((asset) => ({ type: 'image', asset })));
    expect(request.input.aspectRatio).toBeUndefined();
  });
  it('converts selected multipart owned references in order', async () => {
    const { engine, submit } = fixture();
    const app = await appFor(engine);
    const boundary = 'opengen-fixture-boundary';
    const parts = [
      ['model', 'bytedance/seedream-5.0-pro'],
      ['prompt', 'Synthetic edit.'],
      ['image[]', '{"assetKey":"inputs/owner/first.png"}'],
      ['image[]', '{"assetKey":"inputs/owner/second.png"}'],
    ];
    const payload =
      parts
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join('') + `--${boundary}--\r\n`;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/images/edits',
      headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(submit.mock.calls[0]![0].input.input.references).toHaveLength(2);
  });
  it('rejects unsupported conversion and scope before admission', async () => {
    const { engine, submit } = fixture();
    const app = await appFor(engine);
    for (const payload of [
      {
        model: 'bytedance/seedream-5.0-pro',
        prompt: 'Fixture.',
        image: { assetKey: 'inputs/owner/a.png' },
        mask: { assetKey: 'inputs/owner/mask.png' },
      },
      {
        model: 'bytedance/seedream-5.0-pro',
        prompt: 'Fixture.',
        image: { url: 'https://external.invalid/a.png' },
      },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/v1/images/edits', headers, payload }))
          .statusCode,
      ).toBe(400);
    }
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/images/edits',
          headers: { ...headers, authorization: 'Bearer read-only' },
          payload: {
            model: 'bytedance/seedream-5.0-pro',
            prompt: 'Fixture.',
            image: { assetKey: 'inputs/owner/a.png' },
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('owned video Range HTTP conformance', () => {
  it('returns the complete representation when If-Range does not match', async () => {
    const { engine } = fixture(true);
    const app = await appFor(engine);
    const response = await app.inject({
      url: `/v1/videos/${id}/content`,
      headers: { ...headers, range: 'bytes=4-7', 'if-range': '"old-object"' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(mp4);
    expect(response.headers['content-range']).toBeUndefined();
  });
  it('returns HTTP206 and exact bytes for an authorized single Range', async () => {
    const { engine, send } = fixture(true);
    const app = await appFor(engine);
    const response = await app.inject({
      url: `/v1/videos/${id}/content`,
      headers: { ...headers, range: 'bytes=4-7' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.rawPayload).toEqual(mp4.subarray(4, 8));
    expect(response.headers['content-range']).toBe(`bytes 4-7/${mp4.length}`);
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(send.mock.calls[1]![0].input).not.toHaveProperty('Authorization');
  });
  it('returns HTTP416 with total size and no GET for unsatisfiable/multi-range', async () => {
    const { engine, send } = fixture(true);
    const app = await appFor(engine);
    for (const range of ['bytes=1000-', 'bytes=0-1,4-5']) {
      const response = await app.inject({
        url: `/v1/videos/${id}/content`,
        headers: { ...headers, range },
      });
      expect(response.statusCode).toBe(416);
      expect(response.headers['content-range']).toBe(`bytes */${mp4.length}`);
    }
    expect(
      send.mock.calls.every(([command]) => command.constructor.name === 'HeadObjectCommand'),
    ).toBe(true);
  });
  it('returns a qualified capability redirect without Range, preserving MCP content behavior', async () => {
    const { engine, send, job } = fixture(true);
    const app = await appFor(engine);
    const response = await app.inject({ url: `/v1/videos/${id}/content`, headers });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(job.outputs[0]!.url);
    expect(send).not.toHaveBeenCalled();
  });
  it('denies foreign workspace and generate-only reads before storage access', async () => {
    const { engine, send } = fixture(true);
    const app = await appFor(engine);
    for (const [token, status] of [
      ['foreign', 404],
      ['generate-only', 403],
    ] as const) {
      const response = await app.inject({
        url: `/v1/videos/${id}/content`,
        headers: { authorization: `Bearer ${token}`, range: 'bytes=0-3' },
      });
      expect(response.statusCode).toBe(status);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
