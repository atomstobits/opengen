import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine, AssetStore } from '@media-router/engine';

const id = '4aa4fabc-f0b0-42cc-ab01-c739300f2517';
const input = {
  modelId: 'fixture/image',
  operation: 'text-to-image' as const,
  input: { prompt: 'Private fixture.' },
};
const engines: ReturnType<typeof createEngine>[] = [];
function engine(storage?: AssetStore) {
  vi.spyOn(AssetStore, 'fromEnv').mockReturnValue(undefined);
  const value = createEngine({
    databaseUrl: 'postgresql://fixture@127.0.0.1:1/unused',
    adapters: [],
    storage,
  });
  engines.push(value);
  return value;
}
function row(outputs: unknown[]) {
  return {
    id,
    workspace_id: 'owner',
    input,
    route_snapshot: { id: 'exact-route' },
    deployment_snapshot: { id: 'exact-region' },
    status: 'succeeded',
    upstream_id: 'original-task',
    outputs,
    error: null,
    delivery_status: 'available',
    delivery_errors: [],
    reserved_micros: '100',
    settled_micros: '70',
    attempt_count: 1,
    created_at: new Date(),
    updated_at: new Date(),
  };
}
afterEach(async () => {
  await Promise.all(engines.splice(0).map((value) => value.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('private generation admission and customer projection', () => {
  it('treats a blank documented retention setting as unset without disabling private storage', () => {
    vi.stubEnv('MR_INPUT_RETENTION_MS', '');
    const value = engine({ sign: vi.fn() } as unknown as AssetStore);
    expect(value.ownedAssets).toBeDefined();
  });
  it('rejects new admission before reservation or provider work when output storage is absent', async () => {
    const value = engine();
    const query = vi
      .spyOn(value.pool, 'query')
      .mockResolvedValue({ rows: [], rowCount: 0 } as never);
    const connect = vi.spyOn(value.pool, 'connect');
    await expect(
      value.submit({ workspaceId: 'owner', idempotencyKey: 'stable', input }),
    ).rejects.toMatchObject({ code: 'storage_not_configured', statusCode: 503 });
    expect(query).toHaveBeenCalledTimes(1); // Only lookup of an already accepted idempotency key.
    expect(connect).not.toHaveBeenCalled();
  });

  it('keeps an accepted replay readable with storage removed but withholds provider output', async () => {
    const value = engine();
    vi.spyOn(value.pool, 'query').mockResolvedValue({
      rows: [
        row([
          {
            url: 'https://provider.invalid/private-token',
            mediaType: 'image/png',
            fidelity: 'unverified',
          },
        ]),
      ],
    } as never);
    const result = await value.getJob('owner', id);
    expect(result).toMatchObject({
      id,
      status: 'succeeded',
      settledMicros: 70,
      deliveryStatus: 'failed',
      outputs: [],
    });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('signs only current-job owned output and omits internal keys and stale URLs', async () => {
    const sign = vi.fn().mockResolvedValue({
      url: 'https://owned.invalid/fresh-capability',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const value = engine({ sign } as unknown as AssetStore);
    vi.spyOn(value.pool, 'query').mockResolvedValue({
      rows: [
        row([
          {
            storageKey: `outputs/${id}/00000000-0000-4000-8000-000000000003.png`,
            url: 'https://provider.invalid/stale',
            mediaType: 'image/png',
            fidelity: 'unverified',
          },
          {
            storageKey:
              'outputs/00000000-0000-4000-8000-000000000004/00000000-0000-4000-8000-000000000003.png',
            url: 'https://provider.invalid/foreign',
            mediaType: 'image/png',
            fidelity: 'unverified',
          },
          { url: 'https://provider.invalid/raw', mediaType: 'image/png', fidelity: 'unverified' },
        ]),
      ],
    } as never);
    const result = await value.getJob('owner', id);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(result?.outputs).toEqual([
      {
        outputIndex: 0,
        url: 'https://owned.invalid/fresh-capability',
        expiresAt: '2099-01-01T00:00:00.000Z',
        mediaType: 'image/png',
        fidelity: 'unverified',
      },
    ]);
    expect(result?.deliveryStatus).toBe('partial');
    expect(JSON.stringify(result)).not.toContain('storageKey');
    expect(JSON.stringify(result)).not.toContain('provider.invalid');
  });

  it('withholds old signed URLs when capability refresh fails, including history', async () => {
    const value = engine({
      sign: vi.fn().mockRejectedValue(new Error('private storage outage')),
    } as unknown as AssetStore);
    vi.spyOn(value.pool, 'query').mockResolvedValue({
      rows: [
        row([
          {
            storageKey: `outputs/${id}/00000000-0000-4000-8000-000000000003.png`,
            url: 'https://owned.invalid/expired',
            mediaType: 'image/png',
            fidelity: 'unverified',
          },
        ]),
      ],
    } as never);
    const [result] = await value.listJobs('owner');
    expect(result).toMatchObject({ outputs: [], deliveryStatus: 'failed', settledMicros: 70 });
    expect(JSON.stringify(result)).not.toContain('expired');
  });
});
