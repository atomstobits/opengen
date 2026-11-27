import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '@media-router/catalog';
import { resolveRouteUpstreamModelId, type GenerateInput } from '@media-router/contracts';
import {
  AccountGovernanceStore,
  AGED_COST_RELIEF_MIN_AGE_MINUTES,
  AgedCostReliefStore,
  createBflAdapter,
  createEngine,
  createFalAdapter,
  createQwenImageAdapter,
  creditWorkspaceInTransaction,
  isOpaqueBillingRoute,
  keyScopes,
  observedFalBillingEventCostMicros,
  observedQwenImageCostMicros,
  opaquePublishedTariffChargeMicros,
  opaquePublishedTariffQuote,
} from '@media-router/engine';
import {
  connectionEnvironment,
  snapshotCredentialEnvironment,
} from '../packages/engine/src/attempt-credentials.js';
import { createFeePolicy } from '../packages/engine/src/billing-fees.js';
import { buildApp } from '../apps/server/src/app.js';
import { agedCostReliefFixture } from './aged-cost-relief-fixture.js';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine.js';
import { privateInputBytesFixture, privateStorageFixture } from './helpers/private-storage.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe('fal billing-events settlement (unit & adapter fixtures)', () => {
  it('parses exact integer nano-USD events, sums multiple matching events, rounds up, and fails closed', () => {
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: 25_000_000 }],
          has_more: false,
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBe(25_000);

    // Sub-micro nano-USD rounds up once at aggregate
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [
            { request_id: 'req-1', cost_estimate_nano_usd: 400 },
            { request_id: 'req-1', cost_estimate_nano_usd: '601' },
            { request_id: 'other-req', cost_estimate_nano_usd: 999_999_999 },
          ],
          has_more: false,
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBe(2);

    // Explicit zero cost is preserved
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-zero', cost_estimate_nano_usd: 0 }],
          has_more: false,
          next_cursor: null,
        },
        'req-zero',
      ),
    ).toBe(0);

    // Fail-closed cases (missing has_more, paginated, non-null next_cursor, missing match, negative, non-integer)
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: 10_000 }],
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: 10_000 }],
          has_more: false,
          next_cursor: 'cursor-page-2',
        },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        { billing_events: [], has_more: false, next_cursor: null },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: 10_000 }],
          has_more: true,
          next_cursor: 'cursor-page-2',
        },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'other', cost_estimate_nano_usd: 10_000 }],
          has_more: false,
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: -1 }],
          has_more: false,
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBeNull();
    expect(
      observedFalBillingEventCostMicros(
        {
          billing_events: [{ request_id: 'req-1', cost_estimate_nano_usd: 12.5 }],
          has_more: false,
          next_cursor: null,
        },
        'req-1',
      ),
    ).toBeNull();
  });

  it('queries /v1/models/billing-events only when FAL_BILLING_KEY is set and schedules deferred retries until indexed', async () => {
    const route = catalog.routes.find(
      (value) =>
        value.adapter === 'fal' &&
        resolveRouteUpstreamModelId(value, 'text-to-video') === 'minimax/h3-max/text-to-video',
    )!;
    const deployment = catalog.deployments.find((value) => value.id === route.deploymentId)!;
    const context = {
      jobId: '6bb043ce-0878-4a94-93e6-4e27a3e55d39',
      workspaceId: 'owner',
      attempt: 1,
      route,
      deployment,
      input: {
        modelId: route.modelId,
        operation: 'text-to-video' as const,
        input: { prompt: 'A calm pond.', duration: 5, resolution: '768p', aspectRatio: '16:9' },
      },
      upstreamId: 'fal-req-42',
    };

    // 1. Without FAL_BILLING_KEY: no billing API request, no retryAfterMs
    const callsNoKey: string[] = [];
    const noKeyAdapter = createFalAdapter({
      env: { FAL_KEY: 'inference-key' },
      fetch: async (url) => {
        callsNoKey.push(String(url));
        if (String(url).endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
      },
    });
    const noKeyRes = await noKeyAdapter.poll(context);
    expect(noKeyRes).toMatchObject({ status: 'succeeded', billedCostMicros: null });
    expect(noKeyRes.retryAfterMs).toBeUndefined();
    expect(callsNoKey.some((u) => u.includes('billing-events'))).toBe(false);

    // 2. With FAL_BILLING_KEY: empty list schedules retryAfterMs, then indexed event settles exact nano-USD
    let indexed = false;
    const authHeaders = new Map<string, string | null>();
    const capture = vi.fn().mockResolvedValue([]);
    const billingAdapter = createFalAdapter({
      env: { FAL_KEY: 'inference-key', FAL_BILLING_KEY: 'billing-readonly-key' },
      captureOutputs: capture,
      fetch: async (url, init) => {
        const u = String(url);
        authHeaders.set(u, new Headers(init?.headers).get('Authorization'));
        if (u.includes('billing-events')) {
          return Response.json({
            billing_events: indexed
              ? [{ request_id: 'fal-req-42', cost_estimate_nano_usd: 87_500_000 }]
              : [],
            has_more: false,
            next_cursor: null,
          });
        }
        if (u.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
      },
    });

    const first = await billingAdapter.poll(context);
    expect(first).toMatchObject({
      status: 'succeeded',
      billedCostMicros: null,
      retryAfterMs: 30_000,
    });
    expect(
      authHeaders.get('https://api.fal.ai/v1/models/billing-events?request_id=fal-req-42&limit=50'),
    ).toBe('Key billing-readonly-key');

    indexed = true;
    const second = await billingAdapter.poll(context);
    expect(second).toMatchObject({ status: 'succeeded', billedCostMicros: 87_500 });
    expect(second.retryAfterMs).toBeUndefined();

    // 3. Failed fal job with FAL_BILLING_KEY settles $0 when confirmed by billing-events
    const failedAdapter = createFalAdapter({
      env: { FAL_KEY: 'inference-key', FAL_BILLING_KEY: 'billing-readonly-key' },
      fetch: async (url) => {
        const u = String(url);
        if (u.includes('billing-events')) {
          return Response.json({
            billing_events: [{ request_id: 'fal-req-42', cost_estimate_nano_usd: 0 }],
            has_more: false,
            next_cursor: null,
          });
        }
        return Response.json({ status: 'COMPLETED', error: 'Upstream failure' });
      },
    });
    const failedRes = await failedAdapter.poll(context);
    expect(failedRes).toMatchObject({ status: 'failed', billedCostMicros: 0 });
    expect(failedRes.retryAfterMs).toBeUndefined();
  });

  it('preserves FAL_BILLING_KEY in managed frozen credentials, excludes it from BYOK, and anchors billing-events queries to attemptStartedAt', async () => {
    const falDeployment = catalog.deployments.find((d) => d.id === 'fal-undisclosed')!;
    const falRoute = catalog.routes.find(
      (r) =>
        r.adapter === 'fal' &&
        resolveRouteUpstreamModelId(r, 'text-to-video') === 'minimax/h3-max-turbo/text-to-video',
    )!;

    expect(
      snapshotCredentialEnvironment(falDeployment, {
        FAL_KEY: 'fixture-managed',
        FAL_BILLING_KEY: 'fixture-billing',
        OPENAI_API_KEY: 'fixture-other',
      }),
    ).toEqual({
      FAL_KEY: 'fixture-managed',
      FAL_BILLING_KEY: 'fixture-billing',
    });
    expect(connectionEnvironment(falDeployment, { apiKey: 'fixture-byok' })).toEqual({
      FAL_KEY: 'fixture-byok',
    });

    const seenUrls: string[] = [];
    const adapter = createFalAdapter({
      env: { FAL_KEY: 'inference-key', FAL_BILLING_KEY: 'billing-readonly-key' },
      fetch: async (url) => {
        const u = String(url);
        seenUrls.push(u);
        if (u.includes('billing-events')) {
          return Response.json({
            billing_events: [{ request_id: 'fal-aged-1', cost_estimate_nano_usd: 91_000_000 }],
            has_more: false,
            next_cursor: null,
          });
        }
        if (u.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
      },
    });
    expect(adapter.supportsDeferredBillingPoll?.(falRoute, falDeployment)).toBe(true);
    expect(
      createFalAdapter({ env: { FAL_KEY: 'inference-key' } }).supportsDeferredBillingPoll?.(
        falRoute,
        falDeployment,
      ),
    ).toBe(false);

    // 5 days old (> 24h fal default window): anchored start/end span ~5 days
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString();
    await adapter.poll({
      jobId: 'job-aged-5d',
      upstreamId: 'fal-aged-1',
      attemptStartedAt: fiveDaysAgo,
      route: falRoute,
      deployment: falDeployment,
      input: {
        modelId: falRoute.modelId,
        routeId: falRoute.id,
        operation: 'text-to-video',
        input: { prompt: 'Test.', resolution: '480p', duration: 5, aspectRatio: '16:9' },
      },
    });
    const fiveDayUrl = new URL(seenUrls.find((u) => u.includes('billing-events'))!);
    expect(fiveDayUrl.searchParams.get('request_id')).toBe('fal-aged-1');
    const start5d = Date.parse(fiveDayUrl.searchParams.get('start')!);
    const end5d = Date.parse(fiveDayUrl.searchParams.get('end')!);
    expect(start5d).toBe(Date.parse(fiveDaysAgo) - 5 * 60_000);
    expect(end5d - start5d).toBeGreaterThan(4 * 24 * 60 * 60_000);
    expect(end5d - start5d).toBeLessThanOrEqual(30 * 24 * 60 * 60_000);

    // 45 days old: window capped at 30 days (within fal's 90-day documented limit)
    seenUrls.length = 0;
    const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
    await adapter.poll({
      jobId: 'job-aged-45d',
      upstreamId: 'fal-aged-1',
      attemptStartedAt: fortyFiveDaysAgo,
      route: falRoute,
      deployment: falDeployment,
      input: {
        modelId: falRoute.modelId,
        routeId: falRoute.id,
        operation: 'text-to-video',
        input: { prompt: 'Test.', resolution: '480p', duration: 5, aspectRatio: '16:9' },
      },
    });
    const cappedUrl = new URL(seenUrls.find((u) => u.includes('billing-events'))!);
    const start45d = Date.parse(cappedUrl.searchParams.get('start')!);
    const end45d = Date.parse(cappedUrl.searchParams.get('end')!);
    expect(start45d).toBe(Date.parse(fortyFiveDaysAgo) - 5 * 60_000);
    expect(end45d - start45d).toBe(30 * 24 * 60 * 60_000);
  });

  it('rate-limits GET /v1/operator/reconciliations/pending after 60 requests per minute', async () => {
    const app = await buildApp({
      workspaceId: 'operator-ws',
      apiToken: 'operator-bootstrap-token',
      engine: {
        accounts: {} as never,
        getExecutableRouteIds: () => [],
        routeMetrics: async () => [],
        submit: async () => {
          throw new Error('unused');
        },
        getJob: async () => null,
        listJobs: async () => [],
        cancel: async () => {
          throw new Error('unused');
        },
        getBalance: async () => ({ availableMicros: 0, reservedMicros: 0, currency: 'USD' }),
        pendingReconciliations: async () => [],
      },
    });
    try {
      // Unauthenticated requests must be rejected without consuming the operator quota
      for (let i = 0; i < 10; i++) {
        const denied = await app.inject({
          url: '/v1/operator/reconciliations/pending',
        });
        expect(denied.statusCode).toBe(401);
      }
      for (let i = 0; i < 60; i++) {
        const res = await app.inject({
          url: '/v1/operator/reconciliations/pending',
          headers: { authorization: 'Bearer operator-bootstrap-token' },
        });
        expect(res.statusCode).toBe(200);
      }
      const limited = await app.inject({
        url: '/v1/operator/reconciliations/pending',
        headers: { authorization: 'Bearer operator-bootstrap-token' },
      });
      expect(limited.statusCode).toBe(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

describe('Alibaba Qwen Image usage settlement (unit & adapter fixtures)', () => {
  it('auto-settles qualified regional text-to-image requests and fails closed on edits/thinking/oversized/missing usage', async () => {
    const qwenRoute = catalog.routes.find(
      (r) =>
        r.modelId === 'alibaba/qwen-image-3.0-pro' &&
        r.deploymentId === 'alibaba-model-studio-ap-southeast-1',
    )!;
    const qwenDeployment = catalog.deployments.find((d) => d.id === qwenRoute.deploymentId)!;
    const baseCtx = {
      jobId: 'qwen-job-1',
      route: qwenRoute,
      deployment: qwenDeployment,
      input: {
        modelId: qwenRoute.modelId,
        routeId: qwenRoute.id,
        operation: 'text-to-image' as const,
        input: { prompt: 'A glass teapot.', resolution: '2K', count: 1 },
      },
      upstreamId: 'qwen-task-1',
    };

    const adapter = createQwenImageAdapter({
      env: {
        ALIBABA_AP_SOUTHEAST_1_API_KEY: 'fixture',
        ALIBABA_AP_SOUTHEAST_1_ENDPOINT: 'https://workspace.example.invalid/api/v1',
      },
      fetch: async () =>
        Response.json({
          output: {
            task_status: 'SUCCEEDED',
            choices: [{ message: { content: [{ image: 'https://media.example.com/qwen.png' }] } }],
          },
          usage: { image_count: 1, width: 2048, height: 1152 },
        }),
    });

    const settled = await adapter.poll(baseCtx);
    expect(settled).toMatchObject({
      status: 'succeeded',
      billedCostMicros: 75_000,
    });

    // Also accepts output_image_count / output_width / output_height field names
    expect(
      observedQwenImageCostMicros(baseCtx, {
        usage: { output_image_count: 1, output_width: 2048, output_height: 2048 },
      }),
    ).toBe(75_000);

    // 1K Singapore rate is 40_000; fails closed if provider returns 2K pixels for 1K request
    const ctx1k = {
      ...baseCtx,
      input: { ...baseCtx.input, input: { ...baseCtx.input.input, resolution: '1K' } },
    };
    expect(
      observedQwenImageCostMicros(ctx1k, { usage: { image_count: 1, width: 1024, height: 1024 } }),
    ).toBe(40_000);
    expect(
      observedQwenImageCostMicros(ctx1k, { usage: { image_count: 1, width: 2048, height: 2048 } }),
    ).toBeNull();

    // Non-Singapore regional rate (us-east-1 2K = 68_761)
    const usRoute = catalog.routes.find(
      (r) =>
        r.modelId === 'alibaba/qwen-image-3.0-pro' &&
        r.deploymentId === 'alibaba-model-studio-us-east-1',
    )!;
    expect(
      observedQwenImageCostMicros(
        { ...baseCtx, route: usRoute },
        { usage: { image_count: 1, width: 2048, height: 1152 } },
      ),
    ).toBe(68_761);

    // Fail-closed: image-edit, thinking, custom size, count != 1, missing usage, empty rates
    expect(
      observedQwenImageCostMicros(
        { ...baseCtx, input: { ...baseCtx.input, operation: 'image-edit' } },
        { usage: { image_count: 1, width: 2048, height: 1152 } },
      ),
    ).toBeNull();
    expect(
      observedQwenImageCostMicros(
        {
          ...baseCtx,
          input: { ...baseCtx.input, input: { ...baseCtx.input.input, thinking: true } },
        },
        { usage: { image_count: 1, width: 2048, height: 1152 } },
      ),
    ).toBeNull();
    expect(
      observedQwenImageCostMicros(
        {
          ...baseCtx,
          input: {
            ...baseCtx.input,
            input: { ...baseCtx.input.input, size: { width: 1024, height: 1024 } },
          },
        },
        { usage: { image_count: 1, width: 1024, height: 1024 } },
      ),
    ).toBeNull();
    expect(
      observedQwenImageCostMicros(baseCtx, {
        usage: { image_count: 2, width: 1024, height: 1024 },
      }),
    ).toBeNull();
    expect(observedQwenImageCostMicros(baseCtx, {})).toBeNull();
    expect(
      observedQwenImageCostMicros(
        { ...baseCtx, route: { ...qwenRoute, rates: [] } },
        { usage: { image_count: 1, width: 2048, height: 1152 } },
      ),
    ).toBeNull();
  });
});

describe('opaque-provider verified-delivery published tariff (unit)', () => {
  it('prices qualified opaque routes (Runway, Replicate, MiniMax video, BFL image, fal) and fails closed on non-opaque, token, BYOK or extra-input routes', () => {
    const runwayKling = catalog.routes.find((r) => r.id === 'runway-undisclosed/kling-kling-4.0')!;
    const replicateSeedance = catalog.routes.find((r) => r.adapter === 'replicate')!;
    const minimaxVideo = catalog.routes.find(
      (r) => r.id === 'minimax-undisclosed/minimax-h3-lite',
    )!;
    const minimaxImage = catalog.routes.find((r) => r.upstreamModelId === 'MiniMax-H3-Image')!;
    const bflImage = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-image')!;
    const bflKlein = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-klein')!;
    const bflVideo = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-video')!;
    const falTurbo = catalog.routes.find(
      (r) =>
        r.adapter === 'fal' &&
        resolveRouteUpstreamModelId(r, 'text-to-video') === 'minimax/h3-max-turbo/text-to-video',
    )!;
    const alibabaWan = catalog.routes.find((r) => r.id === 'alibaba/ap-southeast-1/wan-3.0')!;

    expect(isOpaqueBillingRoute(runwayKling)).toBe(true);
    expect(isOpaqueBillingRoute(replicateSeedance)).toBe(true);
    expect(isOpaqueBillingRoute(minimaxVideo)).toBe(true);
    expect(isOpaqueBillingRoute(minimaxImage)).toBe(false);
    expect(isOpaqueBillingRoute(bflImage)).toBe(true);
    expect(isOpaqueBillingRoute(bflKlein)).toBe(true);
    expect(isOpaqueBillingRoute(bflVideo)).toBe(false);
    expect(isOpaqueBillingRoute({ adapter: 'bfl', upstreamModelId: 'flux-4-unknown' })).toBe(false);
    expect(isOpaqueBillingRoute(falTurbo)).toBe(true);
    expect(isOpaqueBillingRoute(alibabaWan)).toBe(false);

    // BFL FLUX 3 Image & Klein text-to-image published tariffs
    expect(
      opaquePublishedTariffQuote(bflImage, {
        modelId: bflImage.modelId,
        routeId: bflImage.id,
        operation: 'text-to-image',
        input: { prompt: 'Studio ceramic cup.', resolution: '768sq' },
      }),
    ).toEqual({
      routeId: 'bfl-undisclosed/bfl-flux-3-image',
      operation: 'text-to-image',
      resolution: '768sq',
      unit: 'image',
      unitRateMicros: 41_000,
      quantity: 1,
      amountMicros: 41_000,
    });
    expect(
      opaquePublishedTariffChargeMicros(bflImage, {
        modelId: bflImage.modelId,
        routeId: bflImage.id,
        operation: 'text-to-image',
        input: { prompt: 'Studio ceramic cup.', resolution: '4K' },
      }),
    ).toBe(607_000);
    expect(
      opaquePublishedTariffChargeMicros(bflKlein, {
        modelId: bflKlein.modelId,
        routeId: bflKlein.id,
        operation: 'text-to-image',
        input: { prompt: 'Minimal line art.', resolution: '768sq' },
      }),
    ).toBe(8_000);
    // BFL fail-closed cases: flux-3-video (exact cost on poll), image-edit, custom size, grounding
    expect(
      opaquePublishedTariffChargeMicros(bflVideo, {
        modelId: bflVideo.modelId,
        routeId: bflVideo.id,
        operation: 'text-to-video',
        input: { prompt: 'Waves.', resolution: '720p', duration: 5 },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(bflImage, {
        modelId: bflImage.modelId,
        routeId: bflImage.id,
        operation: 'image-edit',
        input: {
          prompt: 'Recolor.',
          resolution: '768sq',
          references: [{ type: 'image', asset: { url: 'https://media.example.com/a.png' } }],
        },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(bflImage, {
        modelId: bflImage.modelId,
        routeId: bflImage.id,
        operation: 'text-to-image',
        input: { prompt: 'Custom size.', size: { width: 1024, height: 1024 } },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(bflImage, {
        modelId: bflImage.modelId,
        routeId: bflImage.id,
        operation: 'text-to-image',
        input: { prompt: 'Grounded.', resolution: '1K', grounding: true },
      }),
    ).toBeNull();

    // Runway Kling 4.0: 3s @ 720p = 3 * 157_000 = 471_000 micro-USD
    expect(
      opaquePublishedTariffChargeMicros(runwayKling, {
        modelId: runwayKling.modelId,
        routeId: runwayKling.id,
        operation: 'text-to-video',
        input: { prompt: 'Boat on lake.', resolution: '720p', duration: 3, aspectRatio: '16:9' },
      }),
    ).toBe(471_000);

    // MiniMax H3 Lite: 4s @ 480p = 4 * 25_000 = 100_000 micro-USD
    expect(
      opaquePublishedTariffChargeMicros(minimaxVideo, {
        modelId: minimaxVideo.modelId,
        routeId: minimaxVideo.id,
        operation: 'text-to-video',
        input: { prompt: 'Sunrise.', resolution: '480p', duration: 4, aspectRatio: '16:9' },
      }),
    ).toBe(100_000);

    // fal output-priced route: 5s @ 480p = 125_000 micro-USD
    expect(
      opaquePublishedTariffChargeMicros(falTurbo, {
        modelId: falTurbo.modelId,
        routeId: falTurbo.id,
        operation: 'text-to-video',
        input: { prompt: 'Ocean.', resolution: '480p', duration: 5, aspectRatio: '16:9' },
      }),
    ).toBe(125_000);

    // Replicate route without published rates fails closed, while a priced Replicate route settles at tariff
    expect(
      opaquePublishedTariffChargeMicros(replicateSeedance, {
        modelId: replicateSeedance.modelId,
        routeId: replicateSeedance.id,
        operation: 'text-to-video',
        input: { prompt: 'Test.', resolution: '720p', duration: 4 },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(
        {
          ...replicateSeedance,
          rates: [
            {
              operation: 'text-to-video',
              resolution: '720p',
              unit: 'output-second',
              usdMicros: 120_000,
            },
          ],
        },
        {
          modelId: replicateSeedance.modelId,
          routeId: replicateSeedance.id,
          operation: 'text-to-video',
          input: { prompt: 'Test.', resolution: '720p', duration: 4 },
        },
      ),
    ).toBe(480_000);

    // Fail-closed exclusions: non-opaque provider, BYOK, references, auto duration, promptExpansion
    expect(
      opaquePublishedTariffChargeMicros(alibabaWan, {
        modelId: alibabaWan.modelId,
        routeId: alibabaWan.id,
        operation: 'text-to-video',
        input: { prompt: 'Test.', resolution: '480p', duration: 2 },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(runwayKling, {
        modelId: runwayKling.modelId,
        routeId: runwayKling.id,
        operation: 'text-to-video',
        billing: 'byok',
        input: { prompt: 'Test.', resolution: '720p', duration: 3 },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(runwayKling, {
        modelId: runwayKling.modelId,
        routeId: runwayKling.id,
        operation: 'text-to-video',
        input: {
          prompt: 'Test.',
          resolution: '720p',
          duration: 3,
          references: [{ type: 'image', asset: { url: 'https://media.example.com/a.png' } }],
        },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(falTurbo, {
        modelId: falTurbo.modelId,
        routeId: falTurbo.id,
        operation: 'text-to-video',
        input: { prompt: 'Test.', resolution: '480p', duration: 5, promptExpansion: true },
      }),
    ).toBeNull();
    expect(
      opaquePublishedTariffChargeMicros(
        { ...runwayKling, rates: [] },
        {
          modelId: runwayKling.modelId,
          routeId: runwayKling.id,
          operation: 'text-to-video',
          input: { prompt: 'Test.', resolution: '720p', duration: 3 },
        },
      ),
    ).toBeNull();
  });
});

describe.skipIf(!databaseUrl)('reconciliation pipeline, resolve action, and 1-hour SLA', () => {
  it('resolves an expired submission-unknown job with a recorded upstream_id and lists it in pending holds', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'resolve_expired');
    const route = catalog.routes.find((r) => r.id === 'alibaba/ap-southeast-1/wan-3.0')!;
    const input: GenerateInput = {
      modelId: route.modelId,
      routeId: route.id,
      operation: 'text-to-video',
      input: { resolution: '720p', duration: 2, prompt: 'Synthetic expired-task fixture.' },
    };
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (candidate) => candidate.id === route.id,
            submit: async () => ({ upstreamId: 'expired-upstream-id' }),
            poll: async () => ({
              status: 'unknown',
              error: 'Provider task expired; billing requires reconciliation.',
            }),
          },
        ],
      }),
    );
    const app = await buildApp({
      engine,
      workspaceId: 'operator-ws',
      apiToken: 'operator-bootstrap-token',
    });
    try {
      await engine.initialize();
      const ws = `customer-${randomUUID()}`;
      await engine.ensureWorkspace('operator-ws');
      await engine.ensureWorkspace(ws, 1_000_000);
      const nonOpKey = await engine.accounts.createKey(ws, {
        name: 'Workspace admin',
        scopes: [...keyScopes],
      });

      const submitted = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'expired-job-1',
        input,
      });
      await workUntilJob(engine, ws, submitted.id, (j) => j.status === 'submission-unknown');
      const inspected = await engine.inspectJob(ws, submitted.id);
      expect(inspected).toMatchObject({
        status: 'submission-unknown',
        upstreamId: 'expired-upstream-id',
        settledMicros: null,
      });

      // Pending queue denies non-operator, lists the stuck hold for operator
      expect(
        (
          await app.inject({
            url: '/v1/operator/reconciliations/pending',
            headers: { authorization: `Bearer ${nonOpKey.token}` },
          })
        ).statusCode,
      ).toBe(403);
      const pendingRes = await app.inject({
        url: `/v1/operator/reconciliations/pending?workspaceId=${encodeURIComponent(ws)}`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
      });
      expect(pendingRes.statusCode).toBe(200);
      expect(pendingRes.json().data).toEqual([
        expect.objectContaining({
          id: submitted.id,
          workspaceId: ws,
          status: 'submission-unknown',
          upstreamId: 'expired-upstream-id',
          reservedMicros: submitted.reservedMicros,
        }),
      ]);

      // Reject fails because upstream_id is set; settle fails because non-terminal
      const rejectRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${submitted.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: {
          action: 'reject',
          reference: 'ref-reject',
          note: 'Attempted reject with existing upstream ID.',
          evidenceUrl: 'https://provider.example/evidence',
        },
      });
      expect(rejectRes.statusCode).toBe(409);

      const settleRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${submitted.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: {
          action: 'settle',
          reference: 'ref-settle',
          note: 'Attempted settle on non-terminal expired job.',
          evidenceUrl: 'https://provider.example/evidence',
          billedCostMicros: 50_000,
        },
      });
      expect(settleRes.statusCode).toBe(400);

      // Resolve terminates and settles atomically
      const resolvePayload = {
        action: 'resolve',
        terminalStatus: 'failed',
        reference: 'ref-resolve-expired-1',
        note: 'Confirmed expired task in provider billing ledger with $0.05 charge.',
        evidenceUrl: 'https://provider.example/billing/expired-upstream-id',
        billedCostMicros: 50_000,
        costBasis: 'operator-audited',
      };
      const resolvedRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${submitted.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: resolvePayload,
      });
      expect(resolvedRes.statusCode, resolvedRes.body).toBe(200);
      expect(resolvedRes.json()).toMatchObject({
        id: submitted.id,
        status: 'failed',
        settledMicros: 50_000,
      });

      // Dispatch slot released, wallet refunded unused hold, removed from pending queue
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 950_000,
        reservedMicros: 0,
        currency: 'USD',
      });
      expect(
        (
          await engine.pool.query('SELECT state FROM mr_dispatch_slots WHERE job_id=$1', [
            submitted.id,
          ])
        ).rows,
      ).toEqual([{ state: 'released' }]);
      expect(await engine.pendingReconciliations({ workspaceId: ws })).toEqual([]);

      // Exact replay is idempotent; second distinct resolve is blocked
      const replayRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${submitted.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: resolvePayload,
      });
      expect(replayRes.statusCode).toBe(200);

      const secondRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${submitted.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: { ...resolvePayload, reference: 'ref-resolve-expired-2' },
      });
      expect(secondRes.statusCode).toBe(409);
    } finally {
      await app.close();
      await engine.close();
      await isolated.close();
    }
  });

  it('resolves a fee-bearing submission-unknown job without upstream_id using operator-audited costBasis', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'resolve_fee_no_upstream');
    const policy = createFeePolicy({
      id: 'fixture-resolve-fee',
      version: 1,
      activation: 'fixture',
      basisPoints: 500,
      eligibleOutcomes: ['succeeded'],
      overrunAllocation: 'provider-first',
    });
    const route = catalog.routes.find((r) => r.id === 'alibaba/ap-southeast-1/wan-3.0')!;
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        fixtureBillingPolicy: policy,
        adapters: [
          {
            id: 'alibaba',
            isConfigured: (candidate) => candidate.id === route.id,
            submit: async () => {
              throw new Error('Lost HTTP response after paid submit.');
            },
            poll: async () => {
              throw new Error('Should not poll without upstream_id.');
            },
          },
        ],
      }),
    );
    try {
      await engine.initialize();
      const ws = `fee-ws-${randomUUID()}`;
      await engine.ensureWorkspace(ws, 1_000_000);
      const job = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fee-unknown-1',
        input: {
          modelId: route.modelId,
          operation: 'text-to-video',
          routing: { fallback: false },
          feeAcceptance: { policyId: policy.id, policyVersion: policy.version },
          input: { resolution: '720p', duration: 2, prompt: 'Synthetic fee-bearing timeout.' },
        },
      });
      await workUntilJob(engine, ws, job.id, (j) => j.status === 'submission-unknown');
      expect((await engine.inspectJob(ws, job.id))?.upstreamId).toBeNull();

      // Without costBasis: rejected with fee_evidence_required and rolled back
      await expect(
        engine.reconcile(ws, job.id, {
          action: 'resolve',
          terminalStatus: 'failed',
          reference: 'missing-basis',
          note: 'Operator checked upstream invoice without audited basis.',
          evidenceUrl: 'https://provider.example/invoice/1',
          billedCostMicros: 50_000,
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: 'fee_evidence_required' });
      expect(await engine.reconciliations(ws, job.id)).toEqual([]);

      // With costBasis: 'operator-audited' + operator authority: settles cleanly
      const resolved = await engine.reconcile(
        ws,
        job.id,
        {
          action: 'resolve',
          terminalStatus: 'cancelled',
          reference: 'audited-no-upstream',
          note: 'Operator audited provider invoice confirming cancelled task billed $0.05.',
          evidenceUrl: 'https://provider.example/invoice/1',
          billedCostMicros: 50_000,
          costBasis: 'operator-audited',
        },
        { operatorId: 'installation-operator' },
      );
      expect(resolved).toMatchObject({ status: 'cancelled', settledMicros: 50_000 });
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 950_000,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await engine.close();
      await isolated.close();
    }
  });

  it('settles a managed fal job automatically via deferred billing_poll_pending once billing-events indexes', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'fal_deferred_billing');
    const route = catalog.routes.find(
      (r) =>
        r.adapter === 'fal' &&
        resolveRouteUpstreamModelId(r, 'text-to-video') === 'minimax/h3-max-turbo/text-to-video',
    )!;
    let billingIndexed = false;
    const fal = createFalAdapter({
      env: { FAL_KEY: 'fixture-key', FAL_BILLING_KEY: 'fixture-billing-key' },
      fetch: async (url, init) => {
        const u = String(url);
        if (init?.method === 'POST') return Response.json({ request_id: 'fal-deferred-1' });
        if (u.includes('billing-events')) {
          return Response.json({
            billing_events: billingIndexed
              ? [{ request_id: 'fal-deferred-1', cost_estimate_nano_usd: 87_500_000 }]
              : [],
            has_more: false,
            next_cursor: null,
          });
        }
        if (u.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
      },
    });
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        adapters: [fal],
      }),
    );
    try {
      await engine.initialize();
      const ws = `fal-ws-${randomUUID()}`;
      await engine.ensureWorkspace(ws, 1_000_000);
      const job = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fal-deferred-job',
        input: {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'text-to-video',
          input: {
            prompt: 'Ocean waves at dawn.',
            resolution: '480p',
            duration: 5,
            aspectRatio: '16:9',
          },
        },
      });
      await workUntilJob(engine, ws, job.id, (j) => j.status === 'succeeded');
      const afterComplete = (
        await engine.pool.query(
          'SELECT settled_micros,billing_poll_pending FROM mr_jobs WHERE id=$1',
          [job.id],
        )
      ).rows[0];
      expect(afterComplete).toEqual({ settled_micros: null, billing_poll_pending: true });

      // Simulate billing-events indexing and make next_poll_at due immediately
      billingIndexed = true;
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [job.id],
      );
      await workUntilJob(engine, ws, job.id, (j) => j.settledMicros !== null);
      expect(await engine.getJob(ws, job.id)).toMatchObject({
        status: 'succeeded',
        settledMicros: 87_500,
      });
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 912_500,
        reservedMicros: 0,
        currency: 'USD',
      });
    } finally {
      await engine.close();
      await isolated.close();
    }
  });

  it('enforces the 1-hour aged-cost-relief floor in both store and SQL migration 034 and supports custom minAgeMinutes >= 60', async () => {
    const f = await agedCostReliefFixture();
    try {
      expect(AGED_COST_RELIEF_MIN_AGE_MINUTES).toBe(60);
      expect(
        () =>
          new AgedCostReliefStore(f.engine.pool, {
            ...f.storeOptions,
            minAgeMinutes: 59,
          }),
      ).toThrow();

      // 57 minutes (< 1 hour) rejected by store AND by migration 034 SQL CHECK & trigger (SQLSTATE 23514)
      const job = await f.admit({ hours: 0.95 });
      await expect(f.store.review(f.target(job), f.context)).rejects.toThrow();

      await f.engine.pool.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-interval '65 minutes' WHERE job_id=$1",
        [job.id],
      );
      const customStore = new AgedCostReliefStore(f.engine.pool, {
        ...f.storeOptions,
        minAgeMinutes: 120,
      });
      await expect(customStore.review(f.target(job), f.context)).rejects.toThrow();

      const { input, reviewed } = await f.packet(job);

      // Direct SQL enforcement check bypassing the store at 57 minutes (< 1 hour)
      await f.engine.pool.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-interval '57 minutes' WHERE job_id=$1",
        [job.id],
      );
      const subHourLiability = (
        await f.engine.pool.query<{ started_at: Date }>(
          'SELECT min(started_at) AS started_at FROM mr_attempts WHERE job_id=$1',
          [job.id],
        )
      ).rows[0]!.started_at;
      const creditLedgerId = randomUUID();
      const client = await f.engine.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO mr_ledger(id,workspace_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference)
           VALUES($1,$2,'credit',$3,$3,0,$4)`,
          [creditLedgerId, job.workspaceId, job.reservedMicros, `aged-cost-relief:${job.id}`],
        );
        // 1) CHECK constraint mr_aged_cost_reliefs_min_age_check rejects created_at < liability_since + 1h
        await client.query('SAVEPOINT sp_check');
        await expect(
          client.query(
            `INSERT INTO mr_aged_cost_reliefs(
               job_id,workspace_id,reference,request_hash,policy_version,snapshot_hash,snapshot,
               allocation,amount_micros,credit_ledger_id,approval_reference,approval_hash,actor,
               note,evidence_url,liability_since
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,$12,$13,$14,$15)`,
            [
              job.id,
              job.workspaceId,
              'sql-subhour-1',
              '0'.repeat(64),
              reviewed.policyVersion,
              input.snapshotHash,
              JSON.stringify(reviewed.snapshot),
              JSON.stringify(reviewed.allocation),
              job.reservedMicros,
              creditLedgerId,
              'sql-approval',
              JSON.stringify({ id: 'staff-1', kind: 'installation-operator' }),
              input.note,
              input.evidenceUrl,
              subHourLiability,
            ],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT sp_check');

        // 2) Admission guard trigger rejects clock_timestamp() < first_liability + 1h even with future created_at
        await client.query('SAVEPOINT sp_trigger');
        await expect(
          client.query(
            `INSERT INTO mr_aged_cost_reliefs(
               job_id,workspace_id,reference,request_hash,policy_version,snapshot_hash,snapshot,
               allocation,amount_micros,credit_ledger_id,approval_reference,approval_hash,actor,
               note,evidence_url,liability_since,created_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$4,$12,$13,$14,$15,$16)`,
            [
              job.id,
              job.workspaceId,
              'sql-subhour-2',
              '0'.repeat(64),
              reviewed.policyVersion,
              input.snapshotHash,
              JSON.stringify(reviewed.snapshot),
              JSON.stringify(reviewed.allocation),
              job.reservedMicros,
              creditLedgerId,
              'sql-approval',
              JSON.stringify({ id: 'staff-1', kind: 'installation-operator' }),
              input.note,
              input.evidenceUrl,
              subHourLiability,
              new Date(subHourLiability.getTime() + 2 * 60 * 60_000),
            ],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT sp_trigger');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Restore to 65 minutes (>= 1 hour) and grant cleanly as positive control
      await f.engine.pool.query(
        "UPDATE mr_attempts SET started_at=clock_timestamp()-interval '65 minutes' WHERE job_id=$1",
        [job.id],
      );
      const granted = await f.store.grant((await f.packet(job)).input, f.context);
      expect(granted.amountMicros).toBe(job.reservedMicros);
    } finally {
      await f.close();
    }
  });

  it('settles opaque Runway customer wallet on verified delivery while keeping upstream_cost_micros null until record-supplier-cost', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'opaque_runway_settlement');
    const runwayRoute = catalog.routes.find((r) => r.id === 'runway-undisclosed/kling-kling-4.0')!;
    let failDownload = false;
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        delivery: {
          maxAttempts: 1,
          download: async () => {
            if (failDownload) throw new Error('Simulated upstream media outage.');
            return privateInputBytesFixture('video/mp4').bytes;
          },
        },
        adapters: [
          {
            id: 'runway',
            isConfigured: (candidate) => candidate.id === runwayRoute.id,
            submit: async ({ jobId }) => ({ upstreamId: `runway-task-${jobId}` }),
            poll: async () => ({
              status: 'succeeded',
              billedCostMicros: null,
              outputs: [
                {
                  url: 'https://cdn.example.com/kling.mp4',
                  mediaType: 'video/mp4',
                  fidelity: 'unverified',
                },
              ],
            }),
          },
        ],
      }),
    );
    const app = await buildApp({
      engine,
      workspaceId: 'operator-ws',
      apiToken: 'operator-bootstrap-token',
    });
    try {
      await engine.initialize();
      const ws = `runway-ws-${randomUUID()}`;
      await engine.ensureWorkspace('operator-ws');
      await engine.ensureWorkspace(ws, 1_000_000);

      // 1. Verified delivery settles customer immediately at 471_000 while upstream_cost_micros stays null
      const deliveredJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'runway-delivered-1',
        input: {
          modelId: runwayRoute.modelId,
          routeId: runwayRoute.id,
          operation: 'text-to-video',
          input: {
            prompt: 'A sailboat on calm water.',
            resolution: '720p',
            duration: 3,
            aspectRatio: '16:9',
          },
        },
      });
      await workUntilJob(
        engine,
        ws,
        deliveredJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, deliveredJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: 471_000,
      });
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 529_000,
        reservedMicros: 0,
        currency: 'USD',
      });
      const dbRow = (
        await engine.pool.query(
          'SELECT settled_micros::text,upstream_cost_micros::text FROM mr_jobs WHERE id=$1',
          [deliveredJob.id],
        )
      ).rows[0];
      expect(dbRow).toEqual({ settled_micros: '471000', upstream_cost_micros: null });

      const settleLedger = (await engine.ledger(ws)).find(
        (entry) => entry.kind === 'settle' && entry.job_id === deliveredJob.id,
      );
      expect(settleLedger?.details).toMatchObject({
        upstreamCostMicros: null,
        settlementBasis: 'verified-delivery-published-tariff',
        supplierReconciliationPending: true,
      });

      // Does not appear in customer-hold queue; DOES appear in supplier-cost queue
      expect(
        await engine.pendingReconciliations({ workspaceId: ws, kind: 'customer-hold' }),
      ).toEqual([]);
      const supplierQueueRes = await app.inject({
        url: `/v1/operator/reconciliations/pending?workspaceId=${encodeURIComponent(ws)}&kind=supplier-cost`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
      });
      expect(supplierQueueRes.statusCode).toBe(200);
      expect(supplierQueueRes.json().data).toEqual([
        expect.objectContaining({
          id: deliveredJob.id,
          pendingKind: 'supplier-cost',
          settledMicros: 471_000,
        }),
      ]);

      // Operator records actual Runway supplier invoice cost (39 promo credits @ $0.008 = $0.312)
      const supplierPayload = {
        action: 'record-supplier-cost',
        reference: 'runway-invoice-2026-11-19',
        note: 'Runway invoice reconciled 39 credits from $8 promo pack ($0.312 USD).',
        evidenceUrl: 'https://dev.runwayml.com/billing/usage/runway-task',
        billedCostMicros: 312_000,
      };
      const recordRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${deliveredJob.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: supplierPayload,
      });
      expect(recordRes.statusCode, recordRes.body).toBe(200);
      expect(
        (
          await engine.pool.query(
            'SELECT settled_micros::text,upstream_cost_micros::text FROM mr_jobs WHERE id=$1',
            [deliveredJob.id],
          )
        ).rows[0],
      ).toEqual({ settled_micros: '471000', upstream_cost_micros: '312000' });
      // Customer balance is completely untouched by supplier-invoice reconciliation
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 529_000,
        reservedMicros: 0,
        currency: 'USD',
      });
      expect(
        await engine.pendingReconciliations({ workspaceId: ws, kind: 'supplier-cost' }),
      ).toEqual([]);

      // Exact replay is idempotent; second distinct record-supplier-cost returns 409
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${ws}/generations/${deliveredJob.id}/reconcile`,
            headers: { authorization: 'Bearer operator-bootstrap-token' },
            payload: supplierPayload,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${ws}/generations/${deliveredJob.id}/reconcile`,
            headers: { authorization: 'Bearer operator-bootstrap-token' },
            payload: { ...supplierPayload, reference: 'runway-invoice-duplicate' },
          })
        ).statusCode,
      ).toBe(409);

      // 2. Undelivered opaque job (delivery failure) MUST NOT auto-settle customer wallet
      failDownload = true;
      const undeliveredJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'runway-undelivered-2',
        input: {
          modelId: runwayRoute.modelId,
          routeId: runwayRoute.id,
          operation: 'text-to-video',
          input: {
            prompt: 'A mountain pass.',
            resolution: '720p',
            duration: 3,
            aspectRatio: '16:9',
          },
        },
      });
      await workUntilJob(
        engine,
        ws,
        undeliveredJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'failed',
      );
      expect(await engine.getJob(ws, undeliveredJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'failed',
        settledMicros: null,
      });
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 58_000,
        reservedMicros: 471_000,
        currency: 'USD',
      });
      // record-supplier-cost refuses unsettled jobs
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/workspaces/${ws}/generations/${undeliveredJob.id}/reconcile`,
            headers: { authorization: 'Bearer operator-bootstrap-token' },
            payload: { ...supplierPayload, reference: 'ref-unsettled-reject' },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
      await engine.close();
      await isolated.close();
    }
  });

  it('preserves frozen FAL_BILLING_KEY, anchors >24h billing-events queries, and keeps exact-billing intent across captured-output crash recovery on default adapters', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'fal_frozen_recovery');
    const route = catalog.routes.find(
      (r) =>
        r.adapter === 'fal' &&
        resolveRouteUpstreamModelId(r, 'text-to-video') === 'minimax/h3-max-turbo/text-to-video',
    )!;
    let submitSeq = 0;
    let expireQueueResults = false;
    const queueReadsAfterExpiry: string[] = [];
    const billingUrls: string[] = [];
    const billingAuths: Array<string | null> = [];
    const indexedCosts = new Map<string, number>();

    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        vaultKey: '0'.repeat(64),
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        providerEnv: {
          FAL_KEY: 'fixture-fal-key',
          FAL_BILLING_KEY: 'fixture-billing-key',
        },
        delivery: {
          maxAttempts: 1,
          download: async () => privateInputBytesFixture('video/mp4').bytes,
        },
        providerFetch: async (url, init) => {
          const u = String(url);
          if (init?.method === 'POST') {
            submitSeq += 1;
            return Response.json({ request_id: `fal-default-${submitSeq}` });
          }
          if (u.includes('billing-events')) {
            billingUrls.push(u);
            billingAuths.push(new Headers(init?.headers).get('Authorization'));
            const reqId = new URL(u).searchParams.get('request_id') ?? '';
            const nano = indexedCosts.get(reqId);
            return Response.json({
              billing_events:
                nano === undefined ? [] : [{ request_id: reqId, cost_estimate_nano_usd: nano }],
              has_more: false,
              next_cursor: null,
            });
          }
          if (expireQueueResults) {
            queueReadsAfterExpiry.push(u);
            return new Response('Result expired under X-Fal-Store-IO: 0', { status: 404 });
          }
          if (u.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
          return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
        },
      }),
    );
    try {
      await engine.initialize();
      const ws = `fal-default-ws-${randomUUID()}`;
      await engine.ensureWorkspace(ws, 1_000_000);

      // 1. Default (non-injected) adapter freezes FAL_BILLING_KEY and anchors >24h attempt start time
      const job1 = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fal-aged-1',
        input: {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'text-to-video',
          input: {
            prompt: 'Coastal lighthouse.',
            resolution: '480p',
            duration: 5,
            aspectRatio: '16:9',
          },
        },
      });
      await workUntilJob(engine, ws, job1.id, (j) => j.status === 'running');
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60_000);
      await engine.pool.query('UPDATE mr_attempts SET started_at=$2 WHERE job_id=$1', [
        job1.id,
        threeDaysAgo,
      ]);
      indexedCosts.set('fal-default-1', 87_500_000);
      await workUntilJob(
        engine,
        ws,
        job1.id,
        (j) => j.status === 'succeeded' && j.settledMicros !== null,
      );
      expect(await engine.getJob(ws, job1.id)).toMatchObject({
        status: 'succeeded',
        settledMicros: 87_500,
      });
      expect(billingAuths[0]).toBe('Key fixture-billing-key');
      const query1 = new URL(billingUrls[0]!);
      expect(query1.searchParams.get('request_id')).toBe('fal-default-1');
      expect(Date.parse(query1.searchParams.get('start')!)).toBe(
        threeDaysAgo.getTime() - 5 * 60_000,
      );
      expect(query1.searchParams.get('end')).toBeTruthy();

      // 2. Crash after captured output before applyProviderResult must NOT fall back to published tariff
      const job2 = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fal-crash-2',
        input: {
          modelId: route.modelId,
          routeId: route.id,
          operation: 'text-to-video',
          input: {
            prompt: 'Fog over pine forest.',
            resolution: '480p',
            duration: 5,
            aspectRatio: '16:9',
          },
        },
      });
      await workUntilJob(engine, ws, job2.id, (j) => j.status === 'running');
      // Next poll captures outputs into mr_output_receipts, then crashes before applyProviderResult commits.
      const applySpy = vi
        .spyOn(engine, 'applyProviderResult')
        .mockRejectedValueOnce(new Error('Simulated worker crash after captureOutputs.'));
      await engine.workOnce();
      applySpy.mockRestore();

      // Job is still 'running' while a durable mr_output_receipts row exists
      expect((await engine.getJob(ws, job2.id))?.status).toBe('running');
      expect(
        (
          await engine.pool.query(
            'SELECT count(*)::int AS n FROM mr_output_receipts WHERE job_id=$1',
            [job2.id],
          )
        ).rows[0].n,
      ).toBe(1);

      // Recovery (reconcileCapturedCompletion + recoverDeliveryOnce) makes output available
      // while keeping billing_poll_pending=true and settled_micros=null (never list-tariff 125_000!)
      await workUntilJob(
        engine,
        ws,
        job2.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      const afterRecovery = (
        await engine.pool.query(
          'SELECT settled_micros,upstream_cost_micros,billing_poll_pending FROM mr_jobs WHERE id=$1',
          [job2.id],
        )
      ).rows[0];
      expect(afterRecovery).toEqual({
        settled_micros: null,
        upstream_cost_micros: null,
        billing_poll_pending: true,
      });

      // Simulate X-Fal-Store-IO: 0 queue result expiry (404 on /status and queue result):
      // terminal billing_poll_pending follow-up MUST use pollBilling() and settle exact nano-USD without re-reading output!
      expireQueueResults = true;
      indexedCosts.set('fal-default-2', 82_000_000);
      await engine.pool.query(
        "UPDATE mr_jobs SET next_poll_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [job2.id],
      );
      await workUntilJob(engine, ws, job2.id, (j) => j.settledMicros !== null);
      expect(queueReadsAfterExpiry).toEqual([]);
      expect(
        (
          await engine.pool.query(
            'SELECT settled_micros::text,upstream_cost_micros::text,billing_poll_pending FROM mr_jobs WHERE id=$1',
            [job2.id],
          )
        ).rows[0],
      ).toEqual({
        settled_micros: '82000',
        upstream_cost_micros: '82000',
        billing_poll_pending: false,
      });
    } finally {
      await engine.close();
      await isolated.close();
    }
  });

  it('settles BFL image routes via published tariff on verified delivery while keeping BFL video exact-cost-only', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'bfl_opaque_image');
    const bflImage = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-image')!;
    const bflKlein = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-klein')!;
    const bflVideo = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-video')!;
    let seq = 0;
    const taskMeta = new Map<string, { kind: 'image' | 'video'; cost?: number }>();
    const bfl = createBflAdapter({
      env: { BFL_API_KEY: 'fixture-bfl-key' },
      fetch: async (url, init) => {
        const u = String(url);
        if (init?.method === 'POST') {
          seq += 1;
          const id = `bfl-task-${seq}`;
          const isVideo = u.endsWith('/flux-3-video');
          taskMeta.set(id, {
            kind: isVideo ? 'video' : 'image',
            ...(isVideo && seq === 3 ? { cost: 40 } : {}),
          });
          return Response.json({ id, polling_url: `https://api.bfl.ai/v1/get_result?id=${id}` });
        }
        const id = new URL(u).searchParams.get('id') ?? '';
        const meta = taskMeta.get(id)!;
        if (meta.kind === 'video') {
          return Response.json({
            status: 'Ready',
            ...(meta.cost !== undefined ? { cost: meta.cost } : {}),
            result: { sample: `https://cdn.example.com/${id}.mp4` },
          });
        }
        // Live BFL image polls omit `cost`
        return Response.json({
          status: 'Ready',
          result: { sample: `https://cdn.example.com/${id}.png` },
        });
      },
    });
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        delivery: {
          maxAttempts: 1,
          download: async (source) =>
            privateInputBytesFixture(source.mediaType === 'video/mp4' ? 'video/mp4' : 'image/png')
              .bytes,
        },
        adapters: [bfl],
      }),
    );
    const app = await buildApp({
      engine,
      workspaceId: 'operator-ws',
      apiToken: 'operator-bootstrap-token',
    });
    try {
      await engine.initialize();
      const ws = `bfl-ws-${randomUUID()}`;
      await engine.ensureWorkspace('operator-ws');
      await engine.ensureWorkspace(ws, 2_000_000);

      // 1. BFL FLUX 3 Image (768sq) settles immediately at 41_000 with upstream_cost_micros = null
      const imageJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'bfl-img-1',
        input: {
          modelId: bflImage.modelId,
          routeId: bflImage.id,
          operation: 'text-to-image',
          input: { prompt: 'Glass sphere.', resolution: '768sq' },
        },
      });
      await workUntilJob(
        engine,
        ws,
        imageJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, imageJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: 41_000,
      });
      expect(
        (
          await engine.pool.query(
            'SELECT settled_micros::text,upstream_cost_micros::text FROM mr_jobs WHERE id=$1',
            [imageJob.id],
          )
        ).rows[0],
      ).toEqual({ settled_micros: '41000', upstream_cost_micros: null });

      // 2. BFL FLUX 3 Klein (768sq) settles immediately at 8_000 with upstream_cost_micros = null
      const kleinJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'bfl-klein-1',
        input: {
          modelId: bflKlein.modelId,
          routeId: bflKlein.id,
          operation: 'text-to-image',
          input: { prompt: 'Paper crane.', resolution: '768sq' },
        },
      });
      await workUntilJob(
        engine,
        ws,
        kleinJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, kleinJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: 8_000,
      });
      expect(
        (await engine.pendingReconciliations({ workspaceId: ws, kind: 'supplier-cost' })).map(
          (item) => item.id,
        ),
      ).toEqual([imageJob.id, kleinJob.id]);

      // Operator records BFL supplier invoice cost for imageJob without changing customer balance
      const recordRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${imageJob.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: {
          action: 'record-supplier-cost',
          reference: 'bfl-invoice-1',
          note: 'Confirmed 4.1 BFL credits billed for FLUX 3 Image 768sq.',
          evidenceUrl: 'https://api.bfl.ai/billing/usage/bfl-task-1',
          billedCostMicros: 41_000,
        },
      });
      expect(recordRes.statusCode, recordRes.body).toBe(200);
      expect(
        (
          await engine.pool.query(
            'SELECT settled_micros::text,upstream_cost_micros::text FROM mr_jobs WHERE id=$1',
            [imageJob.id],
          )
        ).rows[0],
      ).toEqual({ settled_micros: '41000', upstream_cost_micros: '41000' });

      // 3. BFL FLUX 3 Video with get_result.cost = 40 settles exact 400_000
      const videoExact = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'bfl-vid-exact',
        input: {
          modelId: bflVideo.modelId,
          routeId: bflVideo.id,
          operation: 'text-to-video',
          input: { prompt: 'Ocean tide.', resolution: '720p', duration: 5 },
        },
      });
      await workUntilJob(
        engine,
        ws,
        videoExact.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(
        (
          await engine.pool.query(
            'SELECT settled_micros::text,upstream_cost_micros::text FROM mr_jobs WHERE id=$1',
            [videoExact.id],
          )
        ).rows[0],
      ).toEqual({ settled_micros: '400000', upstream_cost_micros: '400000' });

      // 4. BFL FLUX 3 Video omitting cost MUST NOT fall back to published tariff
      const videoMissingCost = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'bfl-vid-nocost',
        input: {
          modelId: bflVideo.modelId,
          routeId: bflVideo.id,
          operation: 'text-to-video',
          input: { prompt: 'Mountain fog.', resolution: '720p', duration: 5 },
        },
      });
      await workUntilJob(
        engine,
        ws,
        videoMissingCost.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, videoMissingCost.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: null,
      });
      expect(
        (await engine.pendingReconciliations({ workspaceId: ws, kind: 'customer-hold' })).map(
          (item) => item.id,
        ),
      ).toEqual([videoMissingCost.id]);
    } finally {
      await app.close();
      await engine.close();
      await isolated.close();
    }
  });

  it('settles fee-bearing opaque verified-delivery jobs at the published tariff with costStatus published-tariff and enforces migration 035 SQL guards', async () => {
    const isolated = await isolatedEngineDatabase(databaseUrl!, 'fee_opaque_tariff');
    const policy = createFeePolicy({
      id: 'fixture-opaque-smart-5pct',
      version: 1,
      activation: 'fixture',
      basisPoints: 500,
      eligibleOutcomes: ['succeeded'],
      overrunAllocation: 'provider-first',
    });
    const feeAcceptance = { policyId: policy.id, policyVersion: policy.version };
    const bflImage = catalog.routes.find((r) => r.id === 'bfl-undisclosed/bfl-flux-3-image')!;
    const runwayKling = catalog.routes.find((r) => r.id === 'runway-undisclosed/kling-kling-4.0')!;
    const falTurbo = catalog.routes.find(
      (r) =>
        r.adapter === 'fal' &&
        resolveRouteUpstreamModelId(r, 'text-to-video') === 'minimax/h3-max-turbo/text-to-video',
    )!;
    let failDownload = false;
    let bflSeq = 0;
    const bfl = createBflAdapter({
      env: { BFL_API_KEY: 'fixture-bfl-key' },
      fetch: async (url, init) => {
        if (init?.method === 'POST') {
          bflSeq += 1;
          const id = `bfl-fee-${bflSeq}`;
          return Response.json({ id, polling_url: `https://api.bfl.ai/v1/get_result?id=${id}` });
        }
        const id = new URL(String(url)).searchParams.get('id') ?? '';
        return Response.json({
          status: 'Ready',
          result: { sample: `https://cdn.example.com/${id}.png` },
        });
      },
    });
    const falWithBillingKey = createFalAdapter({
      env: { FAL_KEY: 'fixture-fal-key', FAL_BILLING_KEY: 'fixture-billing-key' },
      fetch: async (url, init) => {
        const u = String(url);
        if (init?.method === 'POST') return Response.json({ request_id: 'fal-fee-1' });
        if (u.includes('billing-events'))
          return Response.json({ billing_events: [], has_more: false, next_cursor: null });
        if (u.endsWith('/status')) return Response.json({ status: 'COMPLETED' });
        return Response.json({ video: { url: 'https://v3b.fal.media/files/b/fixture/out.mp4' } });
      },
    });
    const engine = isolated.bind(
      createEngine({
        databaseUrl: isolated.databaseUrl,
        storage: privateStorageFixture(),
        pollIntervalMs: 0,
        fixtureBillingPolicy: policy,
        delivery: {
          maxAttempts: 1,
          download: async (source) => {
            if (failDownload) throw new Error('Simulated media outage.');
            return privateInputBytesFixture(
              source.mediaType === 'video/mp4' ? 'video/mp4' : 'image/png',
            ).bytes;
          },
        },
        adapters: [
          bfl,
          falWithBillingKey,
          {
            id: 'runway',
            isConfigured: (candidate) => candidate.id === runwayKling.id,
            submit: async ({ jobId }) => ({ upstreamId: `runway-fee-${jobId}` }),
            poll: async () => ({
              status: 'succeeded',
              billedCostMicros: null,
              outputs: [
                {
                  url: 'https://cdn.example.com/runway-fee.mp4',
                  mediaType: 'video/mp4',
                  fidelity: 'unverified',
                },
              ],
            }),
          },
        ],
      }),
    );
    const app = await buildApp({
      engine,
      workspaceId: 'operator-ws',
      apiToken: 'operator-bootstrap-token',
    });
    try {
      await engine.initialize();
      const ws = `fee-opaque-ws-${randomUUID()}`;
      await engine.ensureWorkspace('operator-ws');
      await engine.ensureWorkspace(ws, 2_000_000);
      const key = await new AccountGovernanceStore(engine.pool).createKey(
        { workspaceId: ws, bootstrap: true, scopes: ['read', 'generate', 'keys:write'] },
        { name: 'Fee opaque key', scopes: ['read', 'generate'], monthlyCapMicros: 1_500_000 },
      );

      // 1. Smart 5% fee on BFL FLUX 3 Image (768sq): 41_000 tariff + 2_050 fee = 43_050
      const smartRes = await app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: {
          authorization: `Bearer ${key.token}`,
          'idempotency-key': 'fee-bfl-1',
        },
        payload: {
          modelId: bflImage.modelId,
          operation: 'text-to-image',
          routing: { fallback: false },
          feeAcceptance,
          input: { prompt: 'Warm lantern.', resolution: '768sq' },
        },
      });
      expect(smartRes.statusCode, smartRes.body).toBe(202);
      const smartJob = smartRes.json();
      expect(smartJob.reservedMicros).toBe(43_050);

      await workUntilJob(
        engine,
        ws,
        smartJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      const smartSettled = await engine.getJob(ws, smartJob.id);
      const expectedSmartBilling = {
        ...feeAcceptance,
        service: 'smart',
        basisPoints: 500,
        costStatus: 'published-tariff',
        providerCostMicros: 41_000,
        customerProviderDebitMicros: 41_000,
        nominalFeeMicros: 2_050,
        collectedFeeMicros: 2_050,
        waivedFeeMicros: 0,
        operatorOverrunMicros: 0,
        customerTotalMicros: 43_050,
      };
      expect(smartSettled).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: 43_050,
        billing: expectedSmartBilling,
      });

      const smartDb = (
        await engine.pool.query(
          'SELECT settled_micros::text,upstream_cost_micros::text,fee_cost_evidence FROM mr_jobs WHERE id=$1',
          [smartJob.id],
        )
      ).rows[0];
      expect(smartDb.settled_micros).toBe('43050');
      expect(smartDb.upstream_cost_micros).toBeNull();
      expect(smartDb.fee_cost_evidence).toMatchObject({
        workspaceId: ws,
        jobId: smartJob.id,
        routeId: bflImage.id,
        evidence: {
          basis: 'verified-delivery-published-tariff',
          deliveryVerified: true,
          currency: 'USD',
          tariffRouteId: bflImage.id,
          operation: 'text-to-image',
          resolution: '768sq',
          unit: 'image',
          unitRateMicros: 41_000,
          quantity: 1,
          amountMicros: 41_000,
        },
      });

      // Private credential identity and upstream reference must never leak to customer job or ledger
      const smartLedger = (await engine.ledger(ws)).filter((entry) => entry.job_id === smartJob.id);
      expect(JSON.stringify(smartSettled)).not.toContain(
        smartDb.fee_cost_evidence.evidence.upstreamReference,
      );
      expect(JSON.stringify(smartLedger)).not.toContain(
        smartDb.fee_cost_evidence.credentialIdentity,
      );
      expect(smartLedger.find((entry) => entry.kind === 'settle')?.details).toMatchObject({
        upstreamCostMicros: null,
        settlementBasis: 'verified-delivery-published-tariff',
        supplierReconciliationPending: true,
        billingFee: expectedSmartBilling,
      });
      expect(
        (
          await engine.pool.query(
            'SELECT gross_debit_micros::text,held_micros::text FROM mr_key_months WHERE key_id=$1',
            [key.id],
          )
        ).rows,
      ).toEqual([{ gross_debit_micros: '43050', held_micros: '0' }]);

      // Appears in supplier-cost queue (not customer-hold); record-supplier-cost leaves customer untouched
      expect(
        await engine.pendingReconciliations({ workspaceId: ws, kind: 'customer-hold' }),
      ).toEqual([]);
      expect(
        (await engine.pendingReconciliations({ workspaceId: ws, kind: 'supplier-cost' })).map(
          (item) => item.id,
        ),
      ).toEqual([smartJob.id]);
      const recordRes = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${smartJob.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: {
          action: 'record-supplier-cost',
          reference: 'bfl-fee-supplier-1',
          note: 'Supplier invoice settled at discounted $0.035 USD.',
          evidenceUrl: 'https://api.bfl.ai/billing/invoice/1',
          billedCostMicros: 35_000,
        },
      });
      expect(recordRes.statusCode, recordRes.body).toBe(200);
      expect(
        (
          await engine.pool.query(
            "SELECT settled_micros::text,upstream_cost_micros::text,fee_settlement->>'costStatus' AS cost_status FROM mr_jobs WHERE id=$1",
            [smartJob.id],
          )
        ).rows[0],
      ).toEqual({
        settled_micros: '43050',
        upstream_cost_micros: '35000',
        cost_status: 'published-tariff',
      });
      expect(await engine.getBalance(ws)).toEqual({
        availableMicros: 2_000_000 - 43_050,
        reservedMicros: 0,
        currency: 'USD',
      });

      // Direct SQL migration 035 CHECK constraints reject missing evidence or invalid costStatus
      const client = await engine.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp_evidence');
        await expect(
          client.query('UPDATE mr_jobs SET fee_cost_evidence=NULL WHERE id=$1', [smartJob.id]),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT sp_evidence');

        await client.query('SAVEPOINT sp_status');
        await expect(
          client.query(
            `UPDATE mr_jobs SET fee_settlement=jsonb_set(fee_settlement,'{costStatus}','"estimate"') WHERE id=$1`,
            [smartJob.id],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query('ROLLBACK TO SAVEPOINT sp_status');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // 2. Direct 0% fee pinned Runway job settles at 471_000 with costStatus published-tariff
      const directJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fee-runway-1',
        input: {
          modelId: runwayKling.modelId,
          routeId: runwayKling.id,
          operation: 'text-to-video',
          routing: { fallback: false },
          feeAcceptance,
          input: { prompt: 'Boat.', resolution: '720p', duration: 3, aspectRatio: '16:9' },
        },
      });
      await workUntilJob(
        engine,
        ws,
        directJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, directJob.id)).toMatchObject({
        status: 'succeeded',
        settledMicros: 471_000,
        billing: {
          ...feeAcceptance,
          service: 'direct',
          basisPoints: 0,
          costStatus: 'published-tariff',
          providerCostMicros: 471_000,
          nominalFeeMicros: 0,
          collectedFeeMicros: 0,
          customerTotalMicros: 471_000,
        },
      });

      // 3. Undelivered fee-bearing opaque job stays held until audited operator settlement
      failDownload = true;
      const failedDeliveryJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fee-fail-1',
        input: {
          modelId: runwayKling.modelId,
          routeId: runwayKling.id,
          operation: 'text-to-video',
          routing: { fallback: false },
          feeAcceptance,
          input: { prompt: 'Storm.', resolution: '720p', duration: 3, aspectRatio: '16:9' },
        },
      });
      await workUntilJob(
        engine,
        ws,
        failedDeliveryJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'failed',
      );
      expect(await engine.getJob(ws, failedDeliveryJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'failed',
        settledMicros: null,
        billing: { ...feeAcceptance, costStatus: 'pending' },
      });
      const auditedSettle = await app.inject({
        method: 'POST',
        url: `/v1/workspaces/${ws}/generations/${failedDeliveryJob.id}/reconcile`,
        headers: { authorization: 'Bearer operator-bootstrap-token' },
        payload: {
          action: 'settle',
          reference: 'runway-audited-1',
          note: 'Confirmed 39 Runway promo credits ($0.312 USD) after failed media fetch.',
          evidenceUrl: 'https://dev.runwayml.com/billing/usage/1',
          costBasis: 'operator-audited',
          billedCostMicros: 312_000,
        },
      });
      expect(auditedSettle.statusCode, auditedSettle.body).toBe(200);
      expect(auditedSettle.json()).toMatchObject({
        settledMicros: 312_000,
        billing: { costStatus: 'verified', providerCostMicros: 312_000 },
      });

      // 4. Fee-bearing fal job WITH FAL_BILLING_KEY enabled must NOT prematurely fall back to published tariff
      failDownload = false;
      const falJob = await engine.submit({
        workspaceId: ws,
        idempotencyKey: 'fee-fal-1',
        input: {
          modelId: falTurbo.modelId,
          routeId: falTurbo.id,
          operation: 'text-to-video',
          routing: { fallback: false },
          feeAcceptance,
          input: { prompt: 'Tide.', resolution: '480p', duration: 5, aspectRatio: '16:9' },
        },
      });
      await workUntilJob(
        engine,
        ws,
        falJob.id,
        (j) => j.status === 'succeeded' && j.deliveryStatus === 'available',
      );
      expect(await engine.getJob(ws, falJob.id)).toMatchObject({
        status: 'succeeded',
        deliveryStatus: 'available',
        settledMicros: null,
        billing: { ...feeAcceptance, costStatus: 'pending' },
      });
      expect(
        (
          await engine.pool.query('SELECT billing_poll_pending FROM mr_jobs WHERE id=$1', [
            falJob.id,
          ])
        ).rows[0],
      ).toEqual({ billing_poll_pending: true });
    } finally {
      await app.close();
      await engine.close();
      await isolated.close();
    }
  });
});
