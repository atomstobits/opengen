import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateMultipartUploadCommand } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';
import Stripe from 'stripe';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  bootstrap,
  bootstrapCli,
  bucketPolicy,
  configuration,
  reconcileBucketPolicy,
} from '../infra/gcp-bootstrap.mjs';
import { qualifyStorage } from '../infra/qualify-storage.mjs';
import {
  disposeTermsReceipt,
  runDisposeTermsReceiptCli,
} from '../scripts/dispose-terms-receipt.mjs';
import { executeStaffRefundCommand, runStaffRefundCli } from '../scripts/staff-refund.mjs';
import {
  executeAgedCostReliefCommand,
  runAgedCostReliefCli,
} from '../scripts/aged-cost-relief.mjs';
import { verifyReducedRuntimeRole } from '../scripts/qualify-core-postgres.mjs';
import {
  exampleManifest,
  inspectManifest,
  sourceContext,
} from '../scripts/core-activation-preflight.mjs';
import {
  AssetStore,
  createEngine,
  creditWorkspaceInTransaction,
  PaymentStore,
} from '@media-router/engine';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import { staffRefundHash } from '../packages/engine/src/staff-refunds.js';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import { isolatedEngineDatabase, workUntilJob } from './helpers/isolated-engine.js';
import { privateStorageFixture } from './helpers/private-storage.js';

const deployScript = fileURLToPath(new URL('../infra/deploy-gcp.sh', import.meta.url));
const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;

const tempDirs: string[] = [];
function makeTempDir(prefix = 'opengen-infra-launch-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('1. GCP deploy allowlists & public launch env templates', () => {
  let fakeGcloudDir: string;
  beforeAll(() => {
    fakeGcloudDir = mkdtempSync(join(tmpdir(), 'opengen-deploy-gcloud-'));
    writeFileSync(
      join(fakeGcloudDir, 'gcloud'),
      '#!/bin/sh\necho "Forbidden cloud call" >&2\nexit 99\n',
      { mode: 0o755 },
    );
  });
  afterAll(() => {
    rmSync(fakeGcloudDir, { recursive: true, force: true });
  });

  function runPlan(overrides: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = {
      PATH: `${fakeGcloudDir}:${dirname(process.execPath)}:/usr/bin:/bin`,
      OPENGEN_PROJECT_ID: 'fixture-project',
      OPENGEN_REGION: 'us-central1',
      OPENGEN_PUBLIC_URL: 'https://opengen.example',
      OPENGEN_API_IMAGE: `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'a'.repeat(64)}`,
      OPENGEN_API_RUNTIME_SA: 'opengen-api@fixture-project.iam.gserviceaccount.com',
      OPENGEN_WORKER_RUNTIME_SA: 'opengen-worker@fixture-project.iam.gserviceaccount.com',
      OPENGEN_CLOUDSQL_CONNECTION: 'fixture-project:us-central1:fixture-db',
      OPENGEN_DATABASE_SECRET: 'database-url',
      OPENGEN_API_TOKEN_SECRET: 'installation-token',
      OPENGEN_SECRET_VERSION: '3',
      OPENGEN_EXECUTION_SCOPE: 'unrestricted',
      MR_INPUT_RETENTION_MS: '604800000',
      OPENGEN_PROVIDER_SECRET_BINDINGS: 'FAL_KEY=fal-key:2,MR_VAULT_KEY=vault-master:3',
      OPENGEN_API_SECRET_BINDINGS:
        'STRIPE_SECRET_KEY=stripe-sec:1,STRIPE_WEBHOOK_SECRET=stripe-wh:1,OPENGEN_BILLING_PUBLISHABLE_KEY=stripe-pk:1,OPENGEN_BILLING_PORTAL_CONFIGURATION=stripe-portal:1,OPENGEN_BILLING_MANUAL=billing-manual:1,OPENGEN_BILLING_CHECKOUT=billing-checkout:1,OPENGEN_BILLING_RECHARGE=billing-recharge:1,OPENGEN_LEGAL_PUBLICATION_JSON=legal-pub:1',
      ...overrides,
    };
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete env[k];
    }
    return spawnSync('/bin/bash', [deployScript, '--plan'], { env, encoding: 'utf8' });
  }

  it(
    'allows public self-serve Stripe, billing & legal publication bindings on API while rejecting all of them on worker',
    { timeout: 120_000 },
    () => {
      const ok = runPlan();
      expect(ok.status).toBe(0);
      const lines = ok.stdout.split('\n');
      const api = lines.find((line) => line.startsWith('gcloud run deploy opengen-api'))!;
      const worker = lines.find((line) =>
        line.startsWith('gcloud run worker-pools deploy opengen-worker'),
      )!;

      for (const binding of [
        'OPENGEN_BILLING_PUBLISHABLE_KEY=stripe-pk:1',
        'OPENGEN_BILLING_PORTAL_CONFIGURATION=stripe-portal:1',
        'OPENGEN_BILLING_RECHARGE=billing-recharge:1',
        'OPENGEN_LEGAL_PUBLICATION_JSON=legal-pub:1',
      ]) {
        expect(api).toContain(binding);
        expect(worker).not.toContain(binding);
      }
      expect(worker).not.toMatch(/STRIPE_|OPENGEN_BILLING_|OPENGEN_LEGAL_/);

      for (const forbiddenOnWorker of [
        'OPENGEN_BILLING_PUBLISHABLE_KEY',
        'OPENGEN_BILLING_PORTAL_CONFIGURATION',
        'OPENGEN_BILLING_RECHARGE',
        'OPENGEN_LEGAL_PUBLICATION_JSON',
        'STRIPE_SECRET_KEY',
        'OPENGEN_BILLING_MANUAL',
      ]) {
        const rejected = runPlan({
          OPENGEN_API_SECRET_BINDINGS: '',
          OPENGEN_PROVIDER_SECRET_BINDINGS: `${forbiddenOnWorker}=leaked-ref:1`,
        });
        expect(rejected.status).toBe(2);
        expect(rejected.stdout).not.toContain('gcloud');
      }
    },
  );

  it('includes public self-serve launch placeholders across .env.example, infra/opengen.env.example and docs/payments.env.example', () => {
    const dotEnv = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    const infraEnv = readFileSync(join(repoRoot, 'infra/opengen.env.example'), 'utf8');
    const paymentsEnv = readFileSync(join(repoRoot, 'docs/payments.env.example'), 'utf8');

    for (const key of [
      'OPENGEN_BILLING_MANUAL',
      'OPENGEN_BILLING_CHECKOUT',
      'OPENGEN_BILLING_RECHARGE',
      'OPENGEN_BILLING_PUBLISHABLE_KEY',
      'OPENGEN_BILLING_PORTAL_CONFIGURATION',
      'MR_INPUT_RETENTION_MS=604800000',
    ]) {
      expect(dotEnv).toContain(key);
      expect(infraEnv).toContain(key);
    }
    expect(dotEnv).toContain('OPENGEN_EXECUTION_SCOPE=unrestricted');
    expect(dotEnv).toContain('OPENGEN_HERO_VIDEO_URL');
    for (const key of [
      'OPENGEN_BILLING_MANUAL',
      'OPENGEN_BILLING_CHECKOUT',
      'OPENGEN_BILLING_RECHARGE',
      'OPENGEN_BILLING_PUBLISHABLE_KEY',
      'OPENGEN_BILLING_PORTAL_CONFIGURATION',
    ]) {
      expect(paymentsEnv).toContain(key);
    }
  });
});

describe('2. Pin-safe GCS bucket policy reconciliation & current-core storage qualifier', () => {
  const baseOptions = {
    project: 'fixture-project',
    region: 'us-central1',
    bucket: 'fixture-opengen-private-assets',
    publicOrigin: 'https://opengen.example',
  };
  const cfg = configuration(baseOptions);

  function legacyBucketFixture() {
    let currentBucket: Record<string, unknown> = {
      name: cfg.bucket,
      metageneration: '1',
      location: 'US-CENTRAL1',
      storageClass: 'STANDARD',
      iamConfiguration: {
        uniformBucketLevelAccess: { enabled: true },
        publicAccessPrevention: 'enforced',
      },
      cors: [
        {
          origin: [cfg.publicOrigin],
          method: ['GET', 'PUT'],
          responseHeader: ['Content-Type'],
          maxAgeSeconds: 3600,
        },
      ],
      lifecycle: {
        rule: [
          { action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['inputs/'] } },
          { action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['outputs/'] } },
        ],
      },
    };
    const patches: unknown[] = [];
    const driver = {
      async command(args: string[]) {
        if (args.slice(0, 3).join(' ') === 'storage buckets describe') {
          return structuredClone(currentBucket);
        }
        if (args.slice(0, 2).join(' ') === 'projects describe') {
          return { projectId: cfg.project, lifecycleState: 'ACTIVE' };
        }
        if (args.slice(0, 3).join(' ') === 'billing projects describe') {
          return { billingEnabled: true };
        }
        if (args.slice(0, 2).join(' ') === 'projects get-iam-policy') {
          return { bindings: [] };
        }
        if (args.slice(0, 3).join(' ') === 'iam service-accounts describe') {
          return { email: args[3] };
        }
        if (args.slice(0, 3).join(' ') === 'artifacts repositories describe') {
          return {
            name: `projects/${cfg.project}/locations/${cfg.region}/repositories/${cfg.repository}`,
            format: 'DOCKER',
          };
        }
        throw new Error(`Unexpected command: ${args.join(' ')}`);
      },
      async rest(method: string, url: string, body: Record<string, unknown>) {
        const expectedMeta = String(currentBucket.metageneration ?? '');
        if (
          method === 'PATCH' &&
          url ===
            `https://storage.googleapis.com/storage/v1/b/${cfg.bucket}?ifMetagenerationMatch=${encodeURIComponent(expectedMeta)}`
        ) {
          patches.push({ url, body: structuredClone(body) });
          currentBucket = {
            ...currentBucket,
            ...structuredClone(body),
            metageneration: String(Number(expectedMeta) + 1),
          };
          return currentBucket;
        }
        throw new Error(`Unexpected REST call: ${method} ${url}`);
      },
      async secretAccess() {
        return '';
      },
      async sleep() {},
    };
    return { driver, patches, getBucket: () => currentBucket };
  }

  it('keeps ordinary bootstrap failing on legacy bucket drift while --reconcile-bucket-policy supports dry-run and --apply', async () => {
    const offlinePlan = await bootstrapCli([
      '--project',
      baseOptions.project,
      '--bucket',
      baseOptions.bucket,
      '--public-origin',
      baseOptions.publicOrigin,
      '--reconcile-bucket-policy',
    ]);
    expect(offlinePlan).toMatchObject({
      mode: 'dry-run',
      operation: 'reconcile-bucket-policy',
      mutated: false,
      desiredPolicy: bucketPolicy(cfg),
    });

    const f = legacyBucketFixture();
    await expect(
      bootstrap(
        {
          ...baseOptions,
          apply: true,
          receipt: '/private/tmp/nonexistent-bootstrap.json',
          saveReceipt: async () => {},
        },
        f.driver,
      ),
    ).rejects.toThrow('bucket exact CORS/lifecycle');
    expect(f.patches).toHaveLength(0);

    const dryRun = await reconcileBucketPolicy(baseOptions, f.driver);
    expect(dryRun).toMatchObject({
      mode: 'dry-run',
      changed: true,
      corsChanged: true,
      lifecycleChanged: true,
      removesLegacyInputsAgeRule: true,
      mutated: false,
    });
    expect(f.patches).toHaveLength(0);

    const savedReceipts: unknown[] = [];
    const applied = await reconcileBucketPolicy(
      {
        ...baseOptions,
        apply: true,
        saveReceipt: async (r: unknown) => savedReceipts.push(r),
      },
      f.driver,
    );
    expect(applied).toMatchObject({
      mode: 'applied',
      changed: true,
      removesLegacyInputsAgeRule: true,
      mutated: true,
      desiredPolicy: bucketPolicy(cfg),
    });
    expect(f.patches).toHaveLength(1);
    expect(savedReceipts).toHaveLength(1);
    expect(
      (f.getBucket().lifecycle as { rule: { condition: { matchesPrefix: string[] } }[] }).rule,
    ).toEqual([{ action: { type: 'Delete' }, condition: { age: 7, matchesPrefix: ['outputs/'] } }]);

    const second = await reconcileBucketPolicy({ ...baseOptions, apply: true }, f.driver);
    expect(second).toMatchObject({ mode: 'applied', changed: false, mutated: false });
    expect(f.patches).toHaveLength(1);

    const missingMeta = legacyBucketFixture();
    delete missingMeta.getBucket().metageneration;
    await expect(
      reconcileBucketPolicy({ ...baseOptions, apply: true }, missingMeta.driver),
    ).rejects.toThrow('bucket metageneration precondition');
  });

  it('refuses unrecognized custom lifecycle rules during bucket reconciliation', async () => {
    const f = legacyBucketFixture();
    f.getBucket().lifecycle = {
      rule: [{ action: { type: 'Delete' }, condition: { age: 30, matchesPrefix: ['archives/'] } }],
    };
    await expect(reconcileBucketPolicy({ ...baseOptions, apply: true }, f.driver)).rejects.toThrow(
      'unrecognized bucket lifecycle rule',
    );
    expect(f.patches).toHaveLength(0);
  });

  it('sets CacheControl: private, no-store on CreateMultipartUploadCommand while keeping prepareUpload client headers unchanged', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'GOOG1EFIXTUREACCESS');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'fixtureSecretValue1234567890');
    const sentCommands: unknown[] = [];
    const storage = new AssetStore('fixture-bucket', {
      region: 'auto',
      endpoint: 'https://storage.googleapis.com',
    });
    try {
      const prepared = await storage.prepareUpload('ws-test', 'image/png', 128);
      expect(prepared.headers).toEqual({
        'Content-Type': 'image/png',
        'x-goog-if-generation-match': '0',
      });
      vi.spyOn(storage.client, 'send').mockImplementation((async (cmd: unknown) => {
        sentCommands.push(cmd);
        return { UploadId: 'mp_upload_123' };
      }) as never);
      await storage.initiateMultipart('ws-test', 'image/png', 6 * 1024 * 1024);
      expect(sentCommands).toHaveLength(1);
      expect(sentCommands[0]).toBeInstanceOf(CreateMultipartUploadCommand);
      expect((sentCommands[0] as CreateMultipartUploadCommand).input).toMatchObject({
        Bucket: 'fixture-bucket',
        ContentType: 'image/png',
        CacheControl: 'private, no-store',
      });
    } finally {
      storage.client.destroy();
      vi.unstubAllEnvs();
    }
  });

  it('qualifies conditional PUT, 412/409 replay rejection, GCS XML private/max-age=0 browser PUT vs multipart private/no-store cache, and CORS preflight', async () => {
    const runQualificationScenario = async (options: {
      endpoint: string;
      browserPutCacheControl: string;
      multipartCacheControl: string;
      preflightAllowHeaders?: string;
      preflightExposeHeaders?: string;
      partExposeHeaders?: string;
      failResumeMultipart?: boolean;
      onState?: (state: { abortedUploadIds: string[]; remainingMultiparts: number }) => void;
    }) => {
      const dir = makeTempDir();
      const receiptPath = join(dir, 'bootstrap.json');
      const outputPath = join(dir, 'storage-evidence.json');
      writeFileSync(
        receiptPath,
        JSON.stringify({
          schemaVersion: 1,
          project: 'fixture-project',
          region: 'us-central1',
          bucket: 'fixture-bucket',
          secrets: {
            'opengen-storage-access': { version: '1' },
            'opengen-storage-secret': { version: '1' },
            'opengen-storage-bucket': { version: '1' },
            'opengen-storage-endpoint': { version: '1' },
            'opengen-storage-region': { version: '1' },
          },
        }),
        { mode: 0o600 },
      );

      const secretMap: Record<string, string> = {
        'opengen-storage-access': 'GOOG1EFIXTUREACCESS',
        'opengen-storage-secret': 'fixtureSecretValue1234567890',
        'opengen-storage-bucket': 'fixture-bucket',
        'opengen-storage-endpoint': options.endpoint,
        'opengen-storage-region': 'auto',
      };
      const driver = {
        async secretAccess(_project: string, name: string) {
          return secretMap[name]!;
        },
      };

      const objects = new Map<string, { bytes: Buffer; mediaType: string; cacheControl: string }>();
      const multiparts = new Map<
        string,
        {
          key: string;
          mediaType: string;
          size: number;
          parts: Map<number, { bytes: Buffer; etag: string }>;
        }
      >();

      const abortedUploadIds: string[] = [];
      const mockStore = {
        async prepareUpload(workspace: string, mediaType: string, _size: number) {
          const key = `inputs/${workspace}/${randomUUID()}.png`;
          return {
            key,
            uploadUrl: `${options.endpoint}/fixture-bucket/${key}?X-Amz-Signature=signed-put`,
            headers: {
              'Content-Type': mediaType,
              ...(options.endpoint === 'https://storage.googleapis.com'
                ? { 'x-goog-if-generation-match': '0' }
                : { 'If-None-Match': '*' }),
            },
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          };
        },
        async writeInput(_workspace: string, key: string, bytes: Uint8Array, mediaType: string) {
          const buf = Buffer.from(bytes);
          const sha256 = createHash('sha256').update(buf).digest('hex');
          const existing = objects.get(key);
          if (existing) {
            const existingSha = createHash('sha256').update(existing.bytes).digest('hex');
            if (existingSha !== sha256) {
              throw Object.assign(new Error('Immutable input already contains different bytes.'), {
                statusCode: 409,
              });
            }
            return {
              bytes: existing.bytes,
              storageKey: key,
              mediaType,
              size: existing.bytes.length,
              sha256,
            };
          }
          objects.set(key, { bytes: buf, mediaType, cacheControl: 'private, no-store' });
          return { bytes: buf, storageKey: key, mediaType, size: buf.length, sha256 };
        },
        async completeUpload(_workspace: string, key: string) {
          if (!objects.has(key)) throw new Error('Missing object.');
          return this.sign(key, 'image/png', 900);
        },
        async sign(key: string, mediaType: string, expiresIn = 900) {
          const token = expiresIn === 1 ? 'expiring-token' : 'valid-token';
          return {
            storageKey: key,
            mediaType,
            fidelity: 'unverified',
            url: `${options.endpoint}/fixture-bucket/${key}?sig=${token}&response-cache-control=private%2C%20no-store`,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          };
        },
        async initiateMultipart(workspace: string, mediaType: string, size: number) {
          const key = `inputs/${workspace}/mp-${randomUUID()}.png`;
          const uploadId = `mp_${randomUUID()}`;
          multiparts.set(uploadId, { key, mediaType, size, parts: new Map() });
          return { key, uploadId, mediaType, size, partSize: 5 * 1024 * 1024, partCount: 1 };
        },
        async signUploadPart(
          _workspace: string,
          session: { key: string; uploadId: string; size: number },
          partNumber: number,
        ) {
          return {
            partNumber,
            size: session.size,
            uploadUrl: `${options.endpoint}/fixture-bucket/${session.key}?uploadId=${session.uploadId}&partNumber=${partNumber}`,
            headers: {},
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          };
        },
        async resumeMultipart(_workspace: string, session: { uploadId: string }) {
          if (options.failResumeMultipart) throw new Error('Simulated resume failure');
          const mp = multiparts.get(session.uploadId);
          if (!mp) throw new Error('Unknown multipart session');
          return [...mp.parts.entries()].map(([partNumber, p]) => ({
            partNumber,
            etag: p.etag,
            size: p.bytes.length,
          }));
        },
        async completeMultipart(
          _workspace: string,
          session: { key: string; uploadId: string; mediaType: string },
          parts: { partNumber: number; etag: string }[],
        ) {
          const mp = multiparts.get(session.uploadId);
          if (!mp || parts.length !== 1) throw new Error('Invalid multipart completion');
          const part = mp.parts.get(1)!;
          if (part.etag !== parts[0]!.etag) throw new Error('ETag mismatch');
          objects.set(session.key, {
            bytes: part.bytes,
            mediaType: session.mediaType,
            cacheControl: options.multipartCacheControl,
          });
          multiparts.delete(session.uploadId);
          return {
            bytes: part.bytes,
            storageKey: session.key,
            mediaType: session.mediaType,
            size: part.bytes.length,
            sha256: createHash('sha256').update(part.bytes).digest('hex'),
          };
        },
        async abortMultipart(_workspace: string, session: { uploadId: string }) {
          abortedUploadIds.push(session.uploadId);
          multiparts.delete(session.uploadId);
        },
        async readInputIfExists(_workspace: string, key: string) {
          const existing = objects.get(key);
          if (!existing) return null;
          return {
            bytes: existing.bytes,
            storageKey: key,
            mediaType: existing.mediaType,
            size: existing.bytes.length,
            sha256: createHash('sha256').update(existing.bytes).digest('hex'),
          };
        },
        async removeUpload(_workspace: string, key: string) {
          objects.delete(key);
        },
      };

      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const key = url.pathname.replace(/^\/fixture-bucket\//, '');
        const method = init?.method ?? 'GET';

        if (method === 'OPTIONS') {
          const reqHeaders = new Headers(init?.headers);
          const origin = reqHeaders.get('origin') ?? '';
          return new Response(null, {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': origin,
              'Access-Control-Allow-Methods': 'GET, HEAD, PUT',
              'Access-Control-Allow-Headers':
                options.preflightAllowHeaders ??
                'Content-Type, If-None-Match, x-goog-if-generation-match',
              'Access-Control-Expose-Headers':
                options.preflightExposeHeaders ?? 'Content-Type, ETag',
            },
          });
        }

        if (method === 'PUT' && url.searchParams.has('uploadId')) {
          const reqHeaders = new Headers(init?.headers);
          const origin = reqHeaders.get('origin');
          const uploadId = url.searchParams.get('uploadId')!;
          const partNumber = Number(url.searchParams.get('partNumber'));
          const body = Buffer.from(init?.body as Uint8Array);
          const etag = `"${createHash('md5').update(body).digest('hex')}"`;
          multiparts.get(uploadId)!.parts.set(partNumber, { bytes: body, etag });
          return new Response(null, {
            status: 200,
            headers: {
              ETag: etag,
              ...(origin
                ? {
                    'Access-Control-Allow-Origin': origin,
                    'Access-Control-Expose-Headers':
                      options.partExposeHeaders ?? 'Content-Type, ETag',
                  }
                : {}),
            },
          });
        }

        if (method === 'PUT') {
          const headers = new Headers(init?.headers);
          const hasPrecondition =
            headers.get('x-goog-if-generation-match') === '0' ||
            headers.get('if-none-match') === '*';
          if (!hasPrecondition) {
            return new Response('Missing precondition', { status: 400 });
          }
          if (objects.has(key)) {
            return new Response('Precondition Failed', { status: 412 });
          }
          objects.set(key, {
            bytes: Buffer.from(init?.body as Uint8Array),
            mediaType: headers.get('content-type') ?? 'application/octet-stream',
            cacheControl: options.browserPutCacheControl,
          });
          return new Response(null, { status: 200, headers: { ETag: '"gen-1"' } });
        }

        if (url.searchParams.get('sig') === 'valid-token') {
          const stored = objects.get(key);
          if (!stored) return new Response('Not found', { status: 404 });
          return new Response(stored.bytes, {
            status: 200,
            headers: {
              'Content-Type': stored.mediaType,
              'Cache-Control': stored.cacheControl,
            },
          });
        }

        return new Response('Forbidden', { status: 403 });
      });

      try {
        const evidence = await qualifyStorage({
          bootstrapReceipt: receiptPath,
          output: outputPath,
          publicOrigin: 'https://opengen.dev',
          driver,
          store: mockStore,
          fetchImpl: fetchMock,
          expiryWaitMs: 0,
        });
        return { evidence, objects, multiparts };
      } finally {
        options.onState?.({ abortedUploadIds, remainingMultiparts: multiparts.size });
      }
    };

    // 1. S3 mock returning exact private, no-store on both browser PUT and multipart passes
    const s3Result = await runQualificationScenario({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      browserPutCacheControl: 'private, no-store',
      multipartCacheControl: 'private, no-store',
    });
    expect(s3Result.evidence).toMatchObject({
      schemaVersion: 2,
      corsOriginChecked: 'https://opengen.dev',
      actualClientQualification: false,
      steps: {
        prepare: true,
        conditionalCreateHeaders: true,
        corsPreflight: true,
        signedUpload: true,
        conflictingReplayRejected: true,
        complete: true,
        signedRetrieval: true,
        privateNoStoreCache: true,
        unsignedDenied: true,
        expiredUrlDenied: true,
        refreshedRetrieval: true,
        multipartComplete: true,
        multipartAbort: true,
        cleanedUp: true,
      },
    });
    expect(s3Result.objects.size).toBe(0);
    expect(s3Result.multiparts.size).toBe(0);

    // 2. Real GCS XML behavior: browser prepareUpload PUT returns private, max-age=0 while multipart returns private, no-store -> passes!
    const gcsResult = await runQualificationScenario({
      endpoint: 'https://storage.googleapis.com',
      browserPutCacheControl: 'private, max-age=0',
      multipartCacheControl: 'private, no-store',
    });
    expect(gcsResult.evidence.steps.privateNoStoreCache).toBe(true);
    expect(gcsResult.evidence.steps.multipartComplete).toBe(true);

    // 3. Multipart missing private, no-store fails closed even on GCS XML!
    await expect(
      runQualificationScenario({
        endpoint: 'https://storage.googleapis.com',
        browserPutCacheControl: 'private, max-age=0',
        multipartCacheControl: 'private, max-age=0',
      }),
    ).rejects.toThrow('multipart-complete');

    // 4. Non-GCS endpoint returning private, max-age=0 on prepareUpload fails closed!
    await expect(
      runQualificationScenario({
        endpoint: 'https://s3.us-east-1.amazonaws.com',
        browserPutCacheControl: 'private, max-age=0',
        multipartCacheControl: 'private, no-store',
      }),
    ).rejects.toThrow('private-cache-control');

    // 5. Preflight exposing conditional header only in Access-Control-Expose-Headers (not Allow-Headers) fails closed!
    await expect(
      runQualificationScenario({
        endpoint: 'https://storage.googleapis.com',
        browserPutCacheControl: 'private, max-age=0',
        multipartCacheControl: 'private, no-store',
        preflightAllowHeaders: 'Content-Type',
        preflightExposeHeaders: 'Content-Type, ETag, x-goog-if-generation-match',
      }),
    ).rejects.toThrow('cors-preflight');

    // 6. Multipart upload response missing ETag in Access-Control-Expose-Headers fails closed!
    await expect(
      runQualificationScenario({
        endpoint: 'https://storage.googleapis.com',
        browserPutCacheControl: 'private, max-age=0',
        multipartCacheControl: 'private, no-store',
        partExposeHeaders: 'Content-Type',
      }),
    ).rejects.toThrow('multipart-complete');

    // 7. Mid-flight multipart failure aborts initiated mpSession in finally!
    let finalState: { abortedUploadIds: string[]; remainingMultiparts: number } | undefined;
    await expect(
      runQualificationScenario({
        endpoint: 'https://storage.googleapis.com',
        browserPutCacheControl: 'private, max-age=0',
        multipartCacheControl: 'private, no-store',
        failResumeMultipart: true,
        onState: (state) => {
          finalState = state;
        },
      }),
    ).rejects.toThrow('multipart-complete');
    expect(finalState?.abortedUploadIds).toHaveLength(1);
    expect(finalState?.remainingMultiparts).toBe(0);
  });
});

describe('3. Container server ffmpeg stage & isolated worker media decode', () => {
  it('installs ffmpeg in the Dockerfile server stage while running as non-root USER node', () => {
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    const serverStage = dockerfile.split('FROM source AS server')[1]!;
    expect(serverStage).toContain(
      'RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*',
    );
    expect(serverStage).toContain('USER node');
    expect(serverStage.indexOf('apt-get install')).toBeLessThan(serverStage.indexOf('USER node'));
  });

  it('wires scrubbed ffprobe/ffmpeg inspection when verified on disk and keeps absent/unisolated c2patool unknown', async () => {
    process.env.OPENGEN_WORKER_NO_AUTOSTART = '1';
    const workerModule = await import('../apps/server/src/worker.js');
    const dir = makeTempDir();
    const fakeProbe = join(dir, 'ffprobe');
    const fakeFfmpeg = join(dir, 'ffmpeg');
    const envLeakMarker = 'DO_NOT_LEAK_SECRET_TO_FFPROBE';

    writeFileSync(
      fakeProbe,
      `#!/bin/sh
if [ -n "$AWS_SECRET_ACCESS_KEY" ] || [ -n "$STRIPE_SECRET_KEY" ]; then
  echo "leaked env" >&2
  exit 9
fi
printf '%s' '{"streams":[{"codec_type":"video","codec_name":"png","width":1,"height":1}]}'
`,
      { mode: 0o755 },
    );
    writeFileSync(
      fakeFfmpeg,
      `#!/bin/sh
if [ -n "$AWS_SECRET_ACCESS_KEY" ] || [ -n "$STRIPE_SECRET_KEY" ]; then
  echo "leaked env" >&2
  exit 9
fi
printf 'frame=1\nprogress=end\n'
`,
      { mode: 0o755 },
    );

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const prevAws = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = envLeakMarker;
    try {
      const delivery = await workerModule.resolveWorkerDeliveryOptions({
        OPENGEN_FFPROBE_PATH: fakeProbe,
        OPENGEN_FFMPEG_PATH: fakeFfmpeg,
        OPENGEN_FFPROBE_NETWORK_ISOLATED: 'true',
        C2PA_TOOL_PATH: fakeProbe,
        C2PA_TOOL_NETWORK_ISOLATED: 'false',
      });
      expect(delivery.inspect).toBeTypeOf('function');
      expect(delivery.provenance).toEqual({ toolPath: '', networkIsolated: false });

      const inspected = await delivery.inspect!(png, 'image/png', {
        workspaceId: 'ws',
        jobId: randomUUID(),
        attempt: 1,
        routeId: 'r',
        deploymentId: 'd',
        upstreamId: 'u',
      });
      expect(inspected.metadata).toEqual({ status: 'available' });
      expect(inspected.decode).toEqual({ status: 'passed', coverage: 'full' });
      expect(inspected.measured).toMatchObject({ width: 1, height: 1, frameCount: 1 });

      // Unset OPENGEN_FFPROBE_NETWORK_ISOLATED fails closed (networkIsolated: false)
      const unsetIsolation = await workerModule.resolveWorkerDeliveryOptions({
        OPENGEN_FFPROBE_PATH: fakeProbe,
        OPENGEN_FFMPEG_PATH: fakeFfmpeg,
      });
      expect(unsetIsolation.inspect).toBeTypeOf('function');
      const blockedInspection = await unsetIsolation.inspect!(png, 'image/png', {
        workspaceId: 'ws',
        jobId: randomUUID(),
        attempt: 1,
        routeId: 'r',
        deploymentId: 'd',
        upstreamId: 'u',
      });
      expect(blockedInspection.metadata).toMatchObject({
        status: 'unavailable',
        reason: 'network_isolation_required',
      });

      const unconfigured = await workerModule.resolveWorkerDeliveryOptions({
        OPENGEN_FFPROBE_PATH: 'disabled',
      });
      expect(unconfigured.inspect).toBeUndefined();
      expect(unconfigured.provenance).toEqual({ toolPath: '', networkIsolated: false });

      const writableProbe = join(dir, 'writable-ffprobe');
      writeFileSync(writableProbe, '#!/bin/sh\nexit 0\n', { mode: 0o777 });
      chmodSync(writableProbe, 0o777);
      await expect(
        workerModule.resolveWorkerDeliveryOptions({ OPENGEN_FFPROBE_PATH: writableProbe }),
      ).rejects.toThrow('non-world-writable');
    } finally {
      if (prevAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = prevAws;
    }
  });
});

describe('4. Preflight 032 support, reduced runtime role check & private-file CLI guards', () => {
  it('validates 33 migrations in core-activation-preflight.mjs', async () => {
    const actual = await sourceContext();
    expect(actual.migrations).toHaveLength(33);
    expect(actual.migrations.at(-1)?.name).toBe('033.sql');
    const cleanSource = { ...actual, dirty: false };
    const result = inspectManifest(exampleManifest(cleanSource), cleanSource);
    expect(result.result).toBe('preflight-passed');
    expect(result.migrationsToApply).toContain('032.sql');
    expect(result.migrationsToApply).toContain('033.sql');
    expect(result.hostedReadiness).toBe('not-established');
  });

  it('enforces 031 sequence usage and 029 trigger privilege denial in verifyReducedRuntimeRole', async () => {
    const executedSql: string[] = [];
    const mockClient = {
      async query(sql: string) {
        executedSql.push(sql);
        if (sql.includes('SELECT current_user AS name')) {
          const roleMatch = executedSql
            .find((s) => s.startsWith('SET LOCAL ROLE '))!
            .replace(/^SET LOCAL ROLE "/, '')
            .replaceAll('"', '');
          return {
            rows: [
              {
                name: roleMatch,
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
              },
            ],
          };
        }
        if (sql.includes('has_sequence_privilege')) {
          return { rows: [{ can_use: true }] };
        }
        if (sql.includes('INSERT INTO "public".mr_ledger')) {
          return { rows: [{ posting_order: 1 }] };
        }
        if (sql.includes('DISABLE TRIGGER')) {
          throw Object.assign(new Error('must be owner of table mr_terms_receipts'), {
            code: '42501',
          });
        }
        if (sql.includes('DELETE FROM "public".mr_terms_receipts')) {
          throw Object.assign(new Error('terms_receipt_immutable'), { code: '55000' });
        }
        return { rows: [], rowCount: 0 };
      },
      release: vi.fn(),
    };
    const mockDb = {
      async query(sql: string) {
        executedSql.push(sql);
        if (sql.includes('can_create_role')) {
          return { rows: [{ rolsuper: false, can_create_role: true }] };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return mockClient;
      },
    };

    await verifyReducedRuntimeRole(mockDb, {
      workspaceId: 'qualification-owner',
      schema: 'public',
    });
    expect(
      executedSql.some((s) =>
        /^GRANT "opengen_runtime_qual_[a-f0-9]+" TO CURRENT_USER WITH SET TRUE$/.test(s),
      ),
    ).toBe(true);
    expect(executedSql.some((s) => s.includes('mr_ledger_posting_order_seq'))).toBe(true);
    expect(
      executedSql.some((s) =>
        s.includes(
          'ALTER TABLE "public".mr_terms_receipts DISABLE TRIGGER mr_terms_receipts_no_update_delete',
        ),
      ),
    ).toBe(true);
    expect(executedSql.at(-1)).toMatch(/^DROP ROLE "opengen_runtime_qual_/);
  });

  it('rejects CLI argv PII/secrets, open file permissions, symlinks and missing --confirm across all 3 operator CLIs', async () => {
    const dir = makeTempDir();
    const openFile = join(dir, 'open-0644.json');
    writeFileSync(openFile, JSON.stringify({ caseReference: 'case-1' }), { mode: 0o644 });
    chmodSync(openFile, 0o644);

    const privateFile = join(dir, 'private-0600.json');
    writeFileSync(
      privateFile,
      JSON.stringify({
        actorId: 'staff-op-1',
        policyVersion: 'hosted-terms-2026-11-16',
        workspaceId: 'ws-1',
        jobId: randomUUID(),
        allocation: [{ ledgerId: randomUUID(), amountMicros: 100 }],
        reference: 'ref-1',
        note: 'note',
        evidenceUrl: 'https://ops.example/case/1',
        snapshotHash: 'a'.repeat(64),
        approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-1' },
      }),
      { mode: 0o600 },
    );
    const linkFile = join(dir, 'symlink.json');
    symlinkSync(privateFile, linkFile);

    await expect(
      runDisposeTermsReceiptCli(['--input', privateFile, '--subject', 'person-pii']),
    ).rejects.toMatchObject({ code: 'invalid_cli_arguments' });
    await expect(runDisposeTermsReceiptCli(['--input', openFile])).rejects.toMatchObject({
      code: 'input_file_permissions_too_open',
    });
    await expect(runDisposeTermsReceiptCli(['--input', linkFile])).rejects.toMatchObject({
      code: 'input_file_not_regular',
    });

    await expect(
      runStaffRefundCli(['--action', 'prepare', '--input', privateFile]),
    ).rejects.toMatchObject({ code: 'human_confirmation_flag_required' });
    await expect(
      runStaffRefundCli(['--action', 'rehearse', '--input', openFile]),
    ).rejects.toMatchObject({ code: 'input_file_permissions_too_open' });
    await expect(
      executeStaffRefundCommand({
        action: 'prepare',
        confirm: true,
        packet: {
          actorId: 'same-person',
          activation: 'sandbox',
          processorEnvironment: { id: 'env_1', accountId: 'acct_test123', livemode: false },
          approval: { reviewerId: 'same-person', approvalReference: 'self-approved' },
        },
        databaseUrl: 'postgresql://127.0.0.1:5432/unused',
      }),
    ).rejects.toMatchObject({ code: 'independent_reviewer_must_differ_from_actor' });

    await expect(
      runAgedCostReliefCli(['--action', 'grant', '--input', privateFile]),
    ).rejects.toMatchObject({ code: 'human_confirmation_flag_required' });
    await expect(
      runAgedCostReliefCli(['--action', 'review', '--confirm', '--input', privateFile]),
    ).rejects.toMatchObject({ code: 'read_only_action_rejects_confirm' });
    await expect(
      runAgedCostReliefCli(['--action', 'review', '--input', openFile]),
    ).rejects.toMatchObject({ code: 'input_file_permissions_too_open' });
  });

  it('executes exact SQL sequence and rollback guarantees in dispose-terms-receipt.mjs', async () => {
    const target = {
      issuer: 'https://idp.fixture.invalid',
      subject: 'synthetic-subject-1',
      policyVersion: 'hosted-terms-2026-11-16',
      policyDigest: 'a'.repeat(64),
      acceptedAtExact: '2026-11-16 01:02:03.456789+00',
    };
    const peer = {
      ...target,
      subject: 'retained-peer-2',
    };
    const dir = makeTempDir();
    const packetPath = join(dir, 'dispose.json');
    writeFileSync(
      packetPath,
      JSON.stringify({
        caseReference: 'PRIV-2026-0001',
        reviewer: 'privacy-reviewer-1',
        operator: 'db-owner-op-2',
        reason: 'Verified privacy disposition case.',
        holdCleared: true,
        schema: 'public',
        target,
        retainedPeers: [peer],
      }),
      { mode: 0o600 },
    );

    let triggerDisabled = false;
    let deleted = false;
    const sqlLog: string[] = [];
    const mockClient = {
      async query(sql: string, params?: unknown[]) {
        sqlLog.push(sql);
        if (sql === 'SHOW session_replication_role') {
          return { rows: [{ session_replication_role: 'origin' }] };
        }
        if (sql.includes('FROM pg_catalog.pg_trigger')) {
          return {
            rows: [
              { tgname: 'mr_terms_receipts_no_truncate', tgenabled: 'O' },
              {
                tgname: 'mr_terms_receipts_no_update_delete',
                tgenabled: triggerDisabled ? 'D' : 'O',
              },
            ],
          };
        }
        if (sql.includes('DISABLE TRIGGER mr_terms_receipts_no_update_delete')) {
          triggerDisabled = true;
          return { rowCount: 0, rows: [] };
        }
        if (sql.includes('ENABLE TRIGGER mr_terms_receipts_no_update_delete')) {
          triggerDisabled = false;
          return { rowCount: 0, rows: [] };
        }
        if (sql.startsWith('SELECT issuer, subject') && params?.[1] === target.subject) {
          return { rowCount: deleted ? 0 : 1, rows: deleted ? [] : [target] };
        }
        if (sql.startsWith('SELECT issuer, subject') && params?.[1] === peer.subject) {
          return { rowCount: 1, rows: [peer] };
        }
        if (sql.startsWith('DELETE FROM "public".mr_terms_receipts')) {
          deleted = true;
          return { rowCount: 1, rows: [target] };
        }
        if (sql === 'ROLLBACK') {
          triggerDisabled = false;
          deleted = false;
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: vi.fn(),
    };
    const mockPool = {
      async connect() {
        return mockClient;
      },
      async query(sql: string) {
        if (sql.includes('FROM pg_catalog.pg_trigger')) {
          return {
            rows: [
              { tgname: 'mr_terms_receipts_no_truncate', tgenabled: 'O' },
              { tgname: 'mr_terms_receipts_no_update_delete', tgenabled: 'O' },
            ],
          };
        }
        return { rowCount: deleted ? 0 : 1, rows: [] };
      },
    } as unknown as Pool;

    const dryRes = await runDisposeTermsReceiptCli(['--input', packetPath], { pool: mockPool });
    expect(dryRes).toMatchObject({
      mode: 'dry-run',
      outcome: 'dry-run-verified',
      matchedCount: 1,
      affectedCount: 0,
      triggersEnabled: true,
    });
    expect(deleted).toBe(false);
    expect(sqlLog.some((s) => s.includes('DISABLE TRIGGER'))).toBe(false);

    sqlLog.length = 0;
    await expect(
      disposeTermsReceipt({
        inputPath: packetPath,
        execute: true,
        pool: mockPool,
        afterDelete: async () => {
          throw Object.assign(new Error('Division by zero'), { code: '22012' });
        },
      }),
    ).rejects.toMatchObject({ code: 'database_operation_failed:22012' });
    expect(deleted).toBe(false);
    expect(triggerDisabled).toBe(false);

    sqlLog.length = 0;
    const outPath = join(dir, 'receipt.json');
    const execRes = await runDisposeTermsReceiptCli(
      ['--input', packetPath, '--execute', '--output', outPath],
      { pool: mockPool },
    );
    expect(execRes).toMatchObject({
      mode: 'execute',
      outcome: 'committed',
      caseReference: 'PRIV-2026-0001',
      affectedCount: 1,
      triggersEnabled: true,
    });
    expect(sqlLog[0]).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(sqlLog).toContain("SET LOCAL lock_timeout='2s'");
    expect(sqlLog).toContain("SET LOCAL statement_timeout='5s'");
    expect(sqlLog).toContain("SET LOCAL idle_in_transaction_session_timeout='5s'");
    expect(sqlLog).toContain('LOCK TABLE "public".mr_terms_receipts IN ACCESS EXCLUSIVE MODE');
    expect(JSON.stringify(execRes)).not.toContain(target.subject);
  });

  it(
    'executes dispose-terms-receipt, staff-refund and aged-cost-relief CLIs end-to-end against in-memory PGlite 001..032',
    { timeout: 120_000 },
    async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const db = new PGlite();
      try {
        for (let i = 1; i <= 32; i++) {
          const name = `${String(i).padStart(3, '0')}.sql`;
          const sql = readFileSync(join(repoRoot, 'packages/engine/migrations', name), 'utf8');
          await db.exec(sql);
        }
        let mutex = Promise.resolve();
        const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
          const next = mutex.then(fn, fn);
          mutex = next.then(
            () => undefined,
            () => undefined,
          );
          return next;
        };
        const query = async (text: string, values?: unknown[]) => {
          const res = await db.query(text, values as unknown[]);
          return { rows: res.rows, rowCount: res.rows.length || res.affectedRows || 0 };
        };
        const serializedQuery = (text: string, values?: unknown[]) =>
          serialize(() => query(text, values));
        const pglitePool = {
          query: serializedQuery,
          async connect() {
            return {
              query: serializedQuery,
              release() {},
            } as unknown as PoolClient;
          },
          end: async () => {},
        } as unknown as Pool;

        const dir = makeTempDir();
        const writePacket = (name: string, payload: unknown) => {
          const p = join(dir, name);
          writeFileSync(p, JSON.stringify(payload), { mode: 0o600 });
          return p;
        };

        const termsStore = new TermsReceiptStore(pglitePool);
        await termsStore.recordVerifiedAcceptance({
          issuer: 'https://idp.fixture.invalid/inproc',
          subject: 'target-user',
          policyVersion: 'hosted-terms-2026-11-16',
          policyDigest: 'd'.repeat(64),
        });
        await termsStore.recordVerifiedAcceptance({
          issuer: 'https://idp.fixture.invalid/inproc',
          subject: 'peer-user',
          policyVersion: 'hosted-terms-2026-11-16',
          policyDigest: 'd'.repeat(64),
        });
        const cols =
          'issuer, subject, policy_version AS "policyVersion", policy_digest AS "policyDigest", accepted_at::text AS "acceptedAtExact"';
        const targetTuple = (
          await pglitePool.query(
            `SELECT ${cols} FROM public.mr_terms_receipts WHERE subject = 'target-user'`,
          )
        ).rows[0]!;
        const peerTuple = (
          await pglitePool.query(
            `SELECT ${cols} FROM public.mr_terms_receipts WHERE subject = 'peer-user'`,
          )
        ).rows[0]!;

        const dispPath = writePacket('disp-pglite.json', {
          caseReference: 'PRIV-INPROC-1',
          reviewer: 'legal-rev-1',
          operator: 'dba-op-2',
          reason: 'Verified privacy erasure.',
          holdCleared: true,
          schema: 'public',
          target: targetTuple,
          retainedPeers: [peerTuple],
        });
        expect(
          await runDisposeTermsReceiptCli(['--input', dispPath], { pool: pglitePool }),
        ).toMatchObject({
          mode: 'dry-run',
          matchedCount: 1,
          affectedCount: 0,
        });
        expect(
          await runDisposeTermsReceiptCli(['--input', dispPath, '--execute'], { pool: pglitePool }),
        ).toMatchObject({
          mode: 'execute',
          outcome: 'committed',
          affectedCount: 1,
          triggersEnabled: true,
        });

        const workspaceId = 'ws-inproc-refund';
        await pglitePool.query(
          'INSERT INTO mr_workspaces(id, available_micros, reserved_micros) VALUES ($1, 0, 0)',
          [workspaceId],
        );
        const procEnv = {
          id: 'env_inproc_sandbox',
          accountId: 'acct_inproc12345',
          livemode: false,
        };
        await registerBillingProcessorEnvironmentInTransaction(pglitePool, procEnv);
        const paymentStore = new PaymentStore(pglitePool, {
          livemode: false,
          processorEnvironment: procEnv,
          creditInTransaction: creditWorkspaceInTransaction,
        });
        const order = await paymentStore.createOrder(workspaceId, 500, randomUUID());
        const totalCents =
          (order as unknown as { totalChargeCents?: number }).totalChargeCents ?? order.amountCents;
        const csId = `cs_test_${order.id.replaceAll('-', '')}`;
        const piId = `pi_inproc_${order.id.replaceAll('-', '')}`;
        const paidSession = {
          id: csId,
          mode: 'payment' as const,
          currency: 'usd',
          amount_subtotal: totalCents,
          amount_total: totalCents,
          payment_status: 'paid',
          status: 'complete',
          client_reference_id: order.id,
          payment_intent: piId,
          livemode: false,
          url: null,
        };
        let sessionPaid = false;
        const transport = {
          processorEnvironment: procEnv,
          assertProcessorEnvironment() {},
          createSession: async () => ({
            ...paidSession,
            payment_status: 'unpaid',
            status: 'open',
            payment_intent: null,
            url: 'https://checkout.stripe.com/c/pay/inproc',
          }),
          retrieveSession: async () =>
            sessionPaid
              ? paidSession
              : {
                  ...paidSession,
                  payment_status: 'unpaid',
                  status: 'open',
                  payment_intent: null,
                  url: 'https://checkout.stripe.com/c/pay/inproc',
                },
        };
        await paymentStore.checkout(workspaceId, order.id, transport);
        sessionPaid = true;
        await paymentStore.reconcile(
          {
            id: `evt_inproc_paid_${randomUUID().replaceAll('-', '')}`,
            type: 'checkout.session.completed',
            livemode: false,
            processorEnvironment: procEnv,
            data: { object: paidSession },
          },
          transport,
        );

        const rehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('sr-rehearse.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              workspaceId,
            }),
          ],
          { pool: pglitePool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        expect(rehearsed.snapshot.availableMicros).toBe(5_000_000);

        const worksheet = {
          snapshot: rehearsed.snapshot,
          externalReturns: [],
          allocationReference: 'alloc-inproc-1',
          originalPayerReference: 'payer-inproc-1',
          note: 'Voluntary unused credit principal return.',
          allocation: [
            {
              fundingReference: `stripe-topup:${order.id}`,
              disposition: 'eligible-paid' as const,
              amountMicros: 5_000_000,
            },
          ],
        };
        const worksheetHash = staffRefundHash(worksheet);

        const prepared = (await runStaffRefundCli(
          [
            '--action',
            'prepare',
            '--confirm',
            '--input',
            writePacket('sr-prepare.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-inproc-1' },
              prepare: {
                workspaceId,
                orderId: order.id,
                reference: 'case-inproc-1',
                origin: 'new',
                eligibleMicros: 5_000_000,
                worksheet,
                worksheetHash,
              },
            }),
          ],
          { pool: pglitePool },
        )) as { case: { id: string; state: string; cashCents: number } };
        expect(prepared.case.cashCents).toBe(500);

        const dispatchRehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('sr-rehearse-dispatch.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              workspaceId,
            }),
          ],
          { pool: pglitePool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        const dispatchWorksheet = {
          ...worksheet,
          snapshot: dispatchRehearsed.snapshot,
        };
        const dispatchWorksheetHash = staffRefundHash(dispatchWorksheet);

        const dispatched = (await runStaffRefundCli(
          [
            '--action',
            'dispatch',
            '--confirm',
            '--input',
            writePacket('sr-dispatch.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-inproc-2' },
              caseId: prepared.case.id,
              dispatch: {
                reference: 'disp-inproc-1',
                note: 'Claim refund instruction.',
                evidenceReference: 'ticket-inproc-1',
                worksheet: dispatchWorksheet,
                worksheetHash: dispatchWorksheetHash,
              },
            }),
          ],
          { pool: pglitePool },
        )) as { case: { dispatchClaimed: boolean } };
        expect(dispatched.case.dispatchClaimed).toBe(true);

        const signingKey = 'fixture-refund-signing-' + 'm'.repeat(16);
        const refundId = 're_inproc_001';
        const rawBody = JSON.stringify({
          id: 'evt_inproc_refund_1',
          object: 'event',
          api_version: '2026-03-25.dahlia',
          created: Math.floor(Date.now() / 1000),
          type: 'refund.updated',
          livemode: false,
          data: {
            object: {
              id: refundId,
              object: 'refund',
              amount: 500,
              currency: 'usd',
              payment_intent: piId,
              charge: 'ch_inproc_001',
              status: 'succeeded',
            },
          },
        });
        const sig = Stripe.webhooks.generateTestHeaderString({
          payload: rawBody,
          secret: signingKey,
        });

        const observed = (await runStaffRefundCli(
          [
            '--action',
            'observe',
            '--confirm',
            '--input',
            writePacket('sr-observe.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-inproc-3' },
              caseId: prepared.case.id,
              workspaceId,
              orderId: order.id,
              refundId,
              delivery: {
                rawBodyBase64: Buffer.from(rawBody, 'utf8').toString('base64'),
                signature: sig,
              },
              observation: {
                reference: 'obs-inproc-1',
                note: 'Observed refund webhook.',
                evidenceReference: 'evt_inproc_refund_1',
              },
            }),
          ],
          { pool: pglitePool, env: { STRIPE_WEBHOOK_SECRET: signingKey } },
        )) as { case: { state: string } };
        expect(observed.case.state).toBe('succeeded');

        const applyRehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('sr-rehearse-apply.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              workspaceId,
            }),
          ],
          { pool: pglitePool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        const applyWorksheet = {
          ...worksheet,
          snapshot: applyRehearsed.snapshot,
        };
        const applyWorksheetHash = staffRefundHash(applyWorksheet);

        const applied = (await runStaffRefundCli(
          [
            '--action',
            'apply',
            '--confirm',
            '--input',
            writePacket('sr-apply.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment: procEnv,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-inproc-4' },
              caseId: prepared.case.id,
              reconcile: {
                action: 'apply-success',
                reference: 'apply-inproc-1',
                note: 'Debit refunded principal.',
                evidenceReference: 'evt_inproc_refund_1',
                worksheet: applyWorksheet,
                worksheetHash: applyWorksheetHash,
              },
            }),
          ],
          { pool: pglitePool },
        )) as { case: { financialState: string } };
        expect(applied.case.financialState).toBe('debited');

        const reliefWs = 'ws-inproc-relief';
        const openingId = randomUUID();
        const jobId = randomUUID();
        await pglitePool.query(
          'INSERT INTO mr_workspaces(id, available_micros, reserved_micros) VALUES ($1, 900, 100)',
          [reliefWs],
        );
        await pglitePool.query(
          "INSERT INTO mr_ledger(id, workspace_id, kind, amount_micros, available_delta_micros, reserved_delta_micros) VALUES ($1, $2, 'opening', 1000, 1000, 0)",
          [openingId, reliefWs],
        );
        await pglitePool.query(
          `INSERT INTO mr_jobs(id, workspace_id, idempotency_key, request_hash, input, route_snapshot, deployment_snapshot, status, upstream_id, reserved_micros, attempt_count)
           VALUES ($1, $2, 'idem-relief', $3, '{"modelId":"alibaba/wan-3.0","operation":"text-to-video","billing":"managed","input":{"prompt":"p"}}'::jsonb, '{"id":"alibaba/ap-southeast-1/wan-3.0"}'::jsonb, '{"id":"alibaba/ap-southeast-1"}'::jsonb, 'running', 'up-1', 100, 1)`,
          [jobId, reliefWs, 'e'.repeat(64)],
        );
        await pglitePool.query(
          `INSERT INTO mr_attempts(id, job_id, number, route_id, deployment_id, state, started_at)
           VALUES ($1, $2, 1, 'alibaba/ap-southeast-1/wan-3.0', 'alibaba/ap-southeast-1', 'running', clock_timestamp() - interval '25 hours')`,
          [randomUUID(), jobId],
        );
        await pglitePool.query(
          "INSERT INTO mr_ledger(id, workspace_id, job_id, kind, amount_micros, available_delta_micros, reserved_delta_micros) VALUES ($1, $2, $3, 'reserve', 100, -100, 100)",
          [randomUUID(), reliefWs, jobId],
        );

        const reliefReview = (await runAgedCostReliefCli(
          [
            '--action',
            'review',
            '--input',
            writePacket('ar-review.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              workspaceId: reliefWs,
              jobId,
              allocation: [{ ledgerId: openingId, amountMicros: 100 }],
            }),
          ],
          { pool: pglitePool },
        )) as { snapshotHash: string; amountMicros: number };
        expect(reliefReview.amountMicros).toBe(100);

        const reliefGrant = (await runAgedCostReliefCli(
          [
            '--action',
            'grant',
            '--confirm',
            '--input',
            writePacket('ar-grant.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-relief-inproc' },
              workspaceId: reliefWs,
              jobId,
              allocation: [{ ledgerId: openingId, amountMicros: 100 }],
              reference: 'relief-inproc-1',
              note: 'Advance aged unresolved reservation.',
              evidenceUrl: 'https://ops.example/relief/inproc-1',
              snapshotHash: reliefReview.snapshotHash,
            }),
          ],
          { pool: pglitePool },
        )) as { receipt: { amountMicros: number } };
        expect(reliefGrant.receipt.amountMicros).toBe(100);

        const reliefReceipt = (await runAgedCostReliefCli(
          [
            '--action',
            'getReceipt',
            '--input',
            writePacket('ar-get.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              workspaceId: reliefWs,
              jobId,
            }),
          ],
          { pool: pglitePool },
        )) as { grant: { jobId: string }; settlement: unknown };
        expect(reliefReceipt.grant.jobId).toBe(jobId);
        expect(reliefReceipt.settlement).toBeNull();
      } finally {
        await db.close();
      }
    },
  );
});

describe.skipIf(!databaseUrl)(
  '5. End-to-end PostgreSQL/PGlite qualification of maintenance CLIs',
  () => {
    it('runs dispose-terms-receipt.mjs dry-run and execute against real migration 029 triggers', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'cli_terms_disp');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          poolSize: 2,
          providerEnv: {},
          adapters: [],
          providerExecutionEnabled: false,
        }),
      );
      try {
        await engine.initialize();
        const store = new TermsReceiptStore(engine.pool);
        const base = {
          issuer: 'https://identity.fixture.invalid/cli',
          subject: 'eligible-cli-subject',
          policyVersion: 'hosted-terms-2026-11-16',
          policyDigest: 'c'.repeat(64),
        };
        await store.recordVerifiedAcceptance(base);
        await store.recordVerifiedAcceptance({ ...base, subject: 'retained-cli-peer' });

        const cols =
          'issuer, subject, policy_version AS "policyVersion", policy_digest AS "policyDigest", accepted_at::text AS "acceptedAtExact"';
        const target = (
          await engine.pool.query(
            `SELECT ${cols} FROM "${isolated.schema}".mr_terms_receipts WHERE subject = $1`,
            [base.subject],
          )
        ).rows[0]!;
        const peer = (
          await engine.pool.query(
            `SELECT ${cols} FROM "${isolated.schema}".mr_terms_receipts WHERE subject = $1`,
            ['retained-cli-peer'],
          )
        ).rows[0]!;

        const dir = makeTempDir();
        const packetPath = join(dir, 'case.json');
        writeFileSync(
          packetPath,
          JSON.stringify({
            caseReference: 'PRIV-CLI-001',
            reviewer: 'legal-reviewer',
            operator: 'db-owner',
            reason: 'Eligible single-receipt disposition.',
            holdCleared: true,
            schema: isolated.schema,
            target,
            retainedPeers: [peer],
          }),
          { mode: 0o600 },
        );

        const dry = await runDisposeTermsReceiptCli(['--input', packetPath], {
          pool: engine.pool,
        });
        expect(dry).toMatchObject({ mode: 'dry-run', matchedCount: 1, affectedCount: 0 });

        const committed = await runDisposeTermsReceiptCli(['--input', packetPath, '--execute'], {
          pool: engine.pool,
        });
        expect(committed).toMatchObject({
          mode: 'execute',
          outcome: 'committed',
          affectedCount: 1,
        });

        const remaining = await engine.pool.query(
          `SELECT subject FROM "${isolated.schema}".mr_terms_receipts`,
        );
        expect(remaining.rows).toEqual([{ subject: 'retained-cli-peer' }]);
        await expect(
          engine.pool.query(`DELETE FROM "${isolated.schema}".mr_terms_receipts`),
        ).rejects.toMatchObject({ code: '55000' });
      } finally {
        await engine.close();
        await isolated.close();
      }
    });

    it('runs staff-refund.mjs rehearse -> prepare -> dispatch -> observe -> apply end-to-end', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'cli_staff_ref');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          poolSize: 1,
          statusPoolSize: 1,
          storage: privateStorageFixture(),
          vaultKey: 'ab'.repeat(32),
          providerEnv: {},
          adapters: [],
          providerExecutionEnabled: false,
        }),
      );
      try {
        await engine.initialize();
        const workspaceId = `ws-refund-${randomUUID()}`;
        await engine.ensureWorkspace(workspaceId, 0);
        const processorEnvironment = {
          id: `env_cli_${randomUUID().slice(0, 8)}`,
          accountId: 'acct_clifixture123',
          livemode: false,
        };
        await registerBillingProcessorEnvironmentInTransaction(engine.pool, processorEnvironment);
        const payments = new PaymentStore(engine.pool, {
          livemode: false,
          processorEnvironment,
          creditInTransaction: creditWorkspaceInTransaction,
        });
        const order = await payments.createOrder(workspaceId, 500, randomUUID());
        const sessionId = `cs_test_${order.id.replaceAll('-', '')}`;
        const paymentIntentId = `pi_cli_${order.id.replaceAll('-', '')}`;
        const totalCents =
          (order as unknown as { totalChargeCents?: number }).totalChargeCents ?? order.amountCents;
        const paidSession = {
          id: sessionId,
          mode: 'payment' as const,
          currency: 'usd',
          amount_subtotal: totalCents,
          amount_total: totalCents,
          payment_status: 'paid',
          status: 'complete',
          client_reference_id: order.id,
          payment_intent: paymentIntentId,
          livemode: false,
          url: null,
        };
        let isPaid = false;
        const transport = {
          processorEnvironment,
          assertProcessorEnvironment() {},
          createSession: async () => ({
            ...paidSession,
            payment_status: 'unpaid',
            status: 'open',
            payment_intent: null,
            url: 'https://checkout.stripe.com/c/pay/fixture',
          }),
          retrieveSession: async () =>
            isPaid
              ? paidSession
              : {
                  ...paidSession,
                  payment_status: 'unpaid',
                  status: 'open',
                  payment_intent: null,
                  url: 'https://checkout.stripe.com/c/pay/fixture',
                },
        };
        await payments.checkout(workspaceId, order.id, transport);
        isPaid = true;
        await payments.reconcile(
          {
            id: `evt_paid_${randomUUID().replaceAll('-', '')}`,
            type: 'checkout.session.completed',
            livemode: false,
            processorEnvironment,
            data: { object: paidSession },
          },
          transport,
        );

        const dir = makeTempDir();
        const writePacket = (name: string, payload: unknown) => {
          const p = join(dir, name);
          writeFileSync(p, JSON.stringify(payload), { mode: 0o600 });
          return p;
        };

        const rehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('rehearse.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              workspaceId,
            }),
          ],
          { pool: engine.pool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        expect(rehearsed.snapshot.availableMicros).toBe(5_000_000);

        const worksheet = {
          snapshot: rehearsed.snapshot,
          externalReturns: [],
          allocationReference: 'alloc-cli-1',
          originalPayerReference: 'payer-cli-1',
          note: 'Unused paid balance return.',
          allocation: [
            {
              fundingReference: `stripe-topup:${order.id}`,
              disposition: 'eligible-paid' as const,
              amountMicros: 5_000_000,
            },
          ],
        };
        const worksheetHash = staffRefundHash(worksheet);

        const prepared = (await runStaffRefundCli(
          [
            '--action',
            'prepare',
            '--confirm',
            '--input',
            writePacket('prepare.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-prep-1' },
              prepare: {
                workspaceId,
                orderId: order.id,
                reference: 'case-cli-1',
                origin: 'new',
                eligibleMicros: 5_000_000,
                worksheet,
                worksheetHash,
              },
            }),
          ],
          { pool: engine.pool },
        )) as { case: { id: string; state: string; cashCents: number } };
        expect(prepared.case.state).toBe('prepared');
        expect(prepared.case.cashCents).toBe(500);

        const dispatchRehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('rehearse-dispatch.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              workspaceId,
            }),
          ],
          { pool: engine.pool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        const dispatchWorksheet = {
          ...worksheet,
          snapshot: dispatchRehearsed.snapshot,
        };
        const dispatchWorksheetHash = staffRefundHash(dispatchWorksheet);

        const dispatched = (await runStaffRefundCli(
          [
            '--action',
            'dispatch',
            '--confirm',
            '--input',
            writePacket('dispatch.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-disp-1' },
              caseId: prepared.case.id,
              dispatch: {
                reference: 'disp-cli-1',
                note: 'Claim one external refund instruction.',
                evidenceReference: 'ticket-cli-1',
                worksheet: dispatchWorksheet,
                worksheetHash: dispatchWorksheetHash,
              },
            }),
          ],
          { pool: engine.pool },
        )) as { case: { state: string; dispatchClaimed: boolean } };
        expect(dispatched.case.state).toBe('unknown');
        expect(dispatched.case.dispatchClaimed).toBe(true);

        const webhookSecret = 'fixture-refund-signing-' + 'k'.repeat(16);
        const refundId = 're_cli_refund_001';
        const rawPayload = JSON.stringify({
          id: 'evt_refund_cli_001',
          object: 'event',
          api_version: '2026-03-25.dahlia',
          created: Math.floor(Date.now() / 1000),
          type: 'refund.updated',
          livemode: false,
          data: {
            object: {
              id: refundId,
              object: 'refund',
              amount: 500,
              currency: 'usd',
              payment_intent: paymentIntentId,
              charge: 'ch_cli_refund_001',
              status: 'succeeded',
            },
          },
        });
        const signature = Stripe.webhooks.generateTestHeaderString({
          payload: rawPayload,
          secret: webhookSecret,
        });

        const observed = (await runStaffRefundCli(
          [
            '--action',
            'observe',
            '--confirm',
            '--input',
            writePacket('observe.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-obs-1' },
              caseId: prepared.case.id,
              workspaceId,
              orderId: order.id,
              refundId,
              delivery: {
                rawBodyBase64: Buffer.from(rawPayload, 'utf8').toString('base64'),
                signature,
              },
              observation: {
                reference: 'obs-cli-1',
                note: 'Observed signed Stripe refund event.',
                evidenceReference: 'evt_refund_cli_001',
              },
            }),
          ],
          { pool: engine.pool, env: { STRIPE_WEBHOOK_SECRET: webhookSecret } },
        )) as { case: { state: string; refundId: string } };
        expect(observed.case.state).toBe('succeeded');
        expect(observed.case.refundId).toBe(refundId);

        const applyRehearsed = (await runStaffRefundCli(
          [
            '--action',
            'rehearse',
            '--input',
            writePacket('rehearse-apply.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              workspaceId,
            }),
          ],
          { pool: engine.pool },
        )) as {
          snapshot: { availableMicros: number; reservedMicros: number; exposureHash: string };
        };
        const applyWorksheet = {
          ...worksheet,
          snapshot: applyRehearsed.snapshot,
        };
        const applyWorksheetHash = staffRefundHash(applyWorksheet);

        const applied = (await runStaffRefundCli(
          [
            '--action',
            'apply',
            '--confirm',
            '--input',
            writePacket('apply.json', {
              actorId: 'staff-op-1',
              activation: 'sandbox',
              processorEnvironment,
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-apply-1' },
              caseId: prepared.case.id,
              reconcile: {
                action: 'apply-success',
                reference: 'apply-cli-1',
                note: 'Apply wallet debit for completed refund.',
                evidenceReference: 'evt_refund_cli_001',
                worksheet: applyWorksheet,
                worksheetHash: applyWorksheetHash,
              },
            }),
          ],
          { pool: engine.pool },
        )) as { case: { financialState: string } };
        expect(applied.case.financialState).toBe('debited');
        expect((await engine.getBalance(workspaceId)).availableMicros).toBe(0);
      } finally {
        await engine.close();
        await isolated.close();
      }
    });

    it('runs aged-cost-relief.mjs review -> grant -> getReceipt end-to-end', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'cli_aged_rel');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          poolSize: 1,
          statusPoolSize: 1,
          storage: privateStorageFixture(),
          vaultKey: 'cd'.repeat(32),
          providerEnv: {},
          pollIntervalMs: 0,
          adapters: [
            {
              id: 'alibaba',
              isConfigured: (route) => route.id === 'alibaba/ap-southeast-1/wan-3.0',
              submit: async ({ jobId }) => ({ upstreamId: `aged-cli-${jobId}` }),
              poll: async () => ({ status: 'running' }),
            },
          ],
        }),
      );
      try {
        await engine.initialize();
        const workspaceId = `ws-relief-${randomUUID()}`;
        await engine.ensureWorkspace(workspaceId, 1_000_000);
        const opening = (
          await engine.pool.query<{ id: string }>(
            `SELECT id FROM "${isolated.schema}".mr_ledger WHERE workspace_id = $1 AND kind = 'opening'`,
            [workspaceId],
          )
        ).rows[0]!;

        const submitted = await engine.submit({
          workspaceId,
          idempotencyKey: randomUUID(),
          input: {
            modelId: 'alibaba/wan-3.0',
            operation: 'text-to-video',
            billing: 'managed',
            routing: { fallback: false },
            input: { prompt: 'Synthetic aged job.', resolution: '720p', duration: 2 },
          },
        });
        const running = await workUntilJob(
          engine,
          workspaceId,
          submitted.id,
          (j) => j.status === 'running',
        );
        await engine.pool.query(
          `UPDATE "${isolated.schema}".mr_attempts SET started_at = clock_timestamp() - interval '25 hours' WHERE job_id = $1`,
          [running.id],
        );

        const dir = makeTempDir();
        const writePacket = (name: string, payload: unknown) => {
          const p = join(dir, name);
          writeFileSync(p, JSON.stringify(payload), { mode: 0o600 });
          return p;
        };
        const allocation = [{ ledgerId: opening.id, amountMicros: running.reservedMicros }];

        const reviewed = (await runAgedCostReliefCli(
          [
            '--action',
            'review',
            '--input',
            writePacket('review.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              workspaceId,
              jobId: running.id,
              allocation,
            }),
          ],
          { pool: engine.pool },
        )) as { snapshotHash: string; amountMicros: number };
        expect(reviewed.amountMicros).toBe(running.reservedMicros);

        const granted = (await runAgedCostReliefCli(
          [
            '--action',
            'grant',
            '--confirm',
            '--input',
            writePacket('grant.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              approval: { reviewerId: 'staff-rev-2', approvalReference: 'apr-relief-1' },
              workspaceId,
              jobId: running.id,
              allocation,
              reference: 'relief-cli-1',
              note: 'Approved 24h unresolved supplier cost advance.',
              evidenceUrl: 'https://ops.example/relief/1',
              snapshotHash: reviewed.snapshotHash,
            }),
          ],
          { pool: engine.pool },
        )) as { receipt: { jobId: string; amountMicros: number } };
        expect(granted.receipt.jobId).toBe(running.id);
        expect(granted.receipt.amountMicros).toBe(running.reservedMicros);

        const loaded = (await runAgedCostReliefCli(
          [
            '--action',
            'getReceipt',
            '--input',
            writePacket('get-receipt.json', {
              actorId: 'staff-op-1',
              policyVersion: 'hosted-terms-2026-11-16',
              workspaceId,
              jobId: running.id,
            }),
          ],
          { pool: engine.pool },
        )) as { grant: { jobId: string }; settlement: unknown };
        expect(loaded.grant.jobId).toBe(running.id);
        expect(loaded.settlement).toBeNull();
      } finally {
        await engine.close();
        await isolated.close();
      }
    });
  },
);
