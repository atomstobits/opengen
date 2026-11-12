/** Local source composition qualification for hosted legal publication.
 * Identity, assent, processor and money fixtures are synthetic; zero external network requests. */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildEsbuild } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type Stripe from 'stripe';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as oidc from 'openid-client';
import {
  createEngine,
  type AccountStore,
  type CheckoutSession,
  type McpOAuthStore,
  type Principal,
} from '@media-router/engine';
import {
  dataProcessingPolicy,
  legalPolicies,
  legalPolicyMarkdown,
  privacyPolicy,
  refundsPolicy,
  subprocessorsPolicy,
  termsPolicy,
} from '@media-router/contracts/legal-policies';
import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  HOSTED_LEGAL_POLICY_SLUGS,
  LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  buildHostedLegalPublicationRecord,
  publishedLegalPolicyMarkdown,
  serializeHostedLegalPublication,
  validateHostedLegalPublication,
} from '@media-router/contracts/hosted-legal-publication';
import { buildApp } from '../apps/server/src/app.js';
import {
  hostedBillingManual,
  readBillingManualConfiguration,
} from '../apps/server/src/billing-manual.js';
import {
  createBillingFixtureRuntime,
  type BillingFixtureRuntimeOptions,
} from '../apps/server/src/billing-runtime.js';
import {
  MAX_HOSTED_LEGAL_PUBLICATION_BYTES,
  createHostedHumanTermsPolicyReader,
  readHostedLegalPublicationConfiguration,
} from '../apps/server/src/hosted-legal.js';
import { createStripeClient } from '../apps/server/src/payments.js';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery.js';
import {
  HUMAN_TERMS_NOTICE_VERSION,
  currentHumanTermsPolicy,
  type HumanTermsPolicy,
} from '../apps/server/src/terms-login.js';
import { registerBillingProcessorEnvironmentInTransaction } from '../packages/engine/src/billing-customer.js';
import type { PaymentTransport } from '../packages/engine/src/payments.js';
import { TermsReceiptStore } from '../packages/engine/src/terms-receipts.js';
import {
  legalPageMetadata,
  legalSurfacePresentationFromPublication,
  readWebLegalPublication,
} from '../apps/web/app/legal/publication';
import { GET as getTermsMd } from '../apps/web/app/terms.md/route';
import { GET as getRefundsMd } from '../apps/web/app/refunds.md/route';
import { GET as getPrivacyMd } from '../apps/web/app/privacy.md/route';
import { GET as getDataProcessingMd } from '../apps/web/app/data-processing.md/route';
import { GET as getSubprocessorsMd } from '../apps/web/app/subprocessors.md/route';
import { GET as getLegalPublicationJson } from '../apps/web/app/legal-publication.json/route';
import { isolatedEngineDatabase } from './helpers/isolated-engine.js';

// Match existing web UI tests: Next preserves JSX in apps/web/tsconfig.json, so compile
// the TSX surface components with the automatic React JSX runtime for SSR assertions.
const temporaryUiDir = mkdtempSync(join(process.cwd(), 'node_modules/.hosted-legal-ui-'));
const uiBundleEntry = join(temporaryUiDir, 'legal-ui.cjs');
await buildEsbuild({
  stdin: {
    contents: [
      `export { LegalPresentationProvider } from './apps/web/app/legal/presentation';`,
      `export { LegalReviewPage } from './apps/web/app/legal/review-page';`,
      `export { Footer } from './apps/web/app/ui';`,
      `export { BillingPage } from './apps/web/app/billing/billing';`,
      `export { GatewayAccess } from './apps/web/app/gateway-access';`,
      `export { McpConsent } from './apps/web/app/oauth/consent/consent';`,
      `export { default as DocsPage } from './apps/web/app/docs/page';`,
      `export { generateMetadata as generateTermsMetadata } from './apps/web/app/terms/page';`,
      `export { generateMetadata as generateRefundsMetadata } from './apps/web/app/refunds/page';`,
      `export { generateMetadata as generatePrivacyMetadata } from './apps/web/app/privacy/page';`,
      `export { generateMetadata as generateDpaMetadata } from './apps/web/app/data-processing/page';`,
      `export { generateMetadata as generateSubprocessorsMetadata } from './apps/web/app/subprocessors/page';`,
    ].join(' '),
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: uiBundleEntry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next/navigation'],
  loader: { '.css': 'empty' },
});
const {
  LegalPresentationProvider,
  LegalReviewPage,
  Footer,
  BillingPage,
  GatewayAccess,
  McpConsent,
  DocsPage,
  generateTermsMetadata,
  generateRefundsMetadata,
  generatePrivacyMetadata,
  generateDpaMetadata,
  generateSubprocessorsMetadata,
} = createRequire(import.meta.url)(uiBundleEntry) as {
  LegalPresentationProvider: typeof import('../apps/web/app/legal/presentation').LegalPresentationProvider;
  LegalReviewPage: typeof import('../apps/web/app/legal/review-page').LegalReviewPage;
  Footer: typeof import('../apps/web/app/ui').Footer;
  BillingPage: typeof import('../apps/web/app/billing/billing').BillingPage;
  GatewayAccess: typeof import('../apps/web/app/gateway-access').GatewayAccess;
  McpConsent: typeof import('../apps/web/app/oauth/consent/consent').McpConsent;
  DocsPage: typeof import('../apps/web/app/docs/page').default;
  generateTermsMetadata: typeof import('../apps/web/app/terms/page').generateMetadata;
  generateRefundsMetadata: typeof import('../apps/web/app/refunds/page').generateMetadata;
  generatePrivacyMetadata: typeof import('../apps/web/app/privacy/page').generateMetadata;
  generateDpaMetadata: typeof import('../apps/web/app/data-processing/page').generateMetadata;
  generateSubprocessorsMetadata: typeof import('../apps/web/app/subprocessors/page').generateMetadata;
};
afterAll(() => {
  rmSync(temporaryUiDir, { recursive: true, force: true });
});

const provider = vi.hoisted(() => ({
  claims: {
    iss: 'https://identity.fixture.invalid',
    sub: 'verified-composition-human',
    email: 'human@example.invalid',
  } as Record<string, unknown> | undefined,
}));

vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(async () => ({})),
    buildAuthorizationUrl: vi.fn((_config, params: Record<string, string>) => {
      const url = new URL('https://identity.fixture.invalid/authorize');
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      return url;
    }),
    authorizationCodeGrant: vi.fn(async () => ({
      claims: () => provider.claims,
    })),
  };
});

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const canonicalOrigin = 'https://opengen.dev';
const pendingConsentId = `og_req_${'c'.repeat(43)}`;
const apps: FastifyInstance[] = [];
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'opengen-legal-comp-')));
  tempDirs.push(dir);
  return dir;
}

function validPublication(
  overrides: Partial<{
    publishedAt: string;
    effectiveAt: string;
    approvalReference: string;
    operatingRecordReference: string;
  }> = {},
) {
  return buildHostedLegalPublicationRecord({
    publishedAt: overrides.publishedAt ?? '2026-11-10T12:00:00.000Z',
    effectiveAt: overrides.effectiveAt ?? '2026-11-10T12:00:00.000Z',
    approvalReference: overrides.approvalReference ?? 'owner-legal-approval-fixture-v1',
    operatingRecordReference:
      overrides.operatingRecordReference ?? 'terms-receipt-operating-record-fixture-v1',
  });
}

const cookieParts = (headers: Record<string, unknown>): string[] => {
  const raw = headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((item) => String(item).split(';')[0]!);
};

function cookieJar(...groups: string[][]) {
  const jar = new Map<string, string>();
  for (const item of groups.flat()) {
    if (!item) continue;
    jar.set(item.slice(0, item.indexOf('=')), item);
  }
  return [...jar.values()].join('; ');
}

function attributes(tag: string) {
  return Object.fromEntries(
    [...tag.matchAll(/([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [
      match[1]!,
      (match[2] ?? match[3] ?? '')
        .replaceAll('&amp;', '&')
        .replaceAll('&quot;', '"')
        .replaceAll('&#39;', "'"),
    ]),
  );
}

function parseContinueForm(html: string) {
  const formTag = html.match(/<form\b[^>]*>/i)?.[0];
  expect(formTag).toBeDefined();
  const params = new URLSearchParams();
  for (const match of html.matchAll(/<(?:input|button)\b[^>]*>/gi)) {
    const field = attributes(match[0]);
    if (field.name) params.append(field.name, field.value ?? '');
  }
  return params;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  provider.claims = {
    iss: 'https://identity.fixture.invalid',
    sub: 'verified-composition-human',
    email: 'human@example.invalid',
  };
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('hosted legal publication validator & deterministic digests', () => {
  it('produces exact approved publication Markdown bytes and SHA-256 digests for all five policies', () => {
    const expectedDigests = {
      terms: {
        version: 'hosted-terms-v4-2026-11-09',
        sha256: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
        bytes: 35917,
      },
      refunds: {
        version: 'hosted-refunds-v4-2026-11-09',
        sha256: 'b7e2907ac08297cf326cf50317d2a0a63df8aaf11f4e4f5ee742e7734b7e7748',
        bytes: 14940,
      },
      privacy: {
        version: 'hosted-privacy-v4-2026-11-09',
        sha256: '2183378dbcfc69bf00302f4a46e2d8e5ca1089a501b749459dadaf8eefd5f39a',
        bytes: 27638,
      },
      'data-processing': {
        version: 'business-dpa-template-v2-2026-11-09',
        sha256: '09c5f1505017f685af4bdbfb9b45116115507e2d637092dc1a016319ee722cbb',
        bytes: 27954,
      },
      subprocessors: {
        version: 'business-subprocessors-template-v2-2026-11-09',
        sha256: 'b45965332df72ecdbba6e688af101ce3a26712a79869791cc0770a9816bf382c',
        bytes: 8552,
      },
    } as const;

    const record = validPublication();
    expect(record.canonicalOrigin).toBe(LEGAL_PUBLICATION_CANONICAL_ORIGIN);
    expect(record.policies.map((item) => item.slug)).toEqual([...HOSTED_LEGAL_POLICY_SLUGS]);

    for (const slug of HOSTED_LEGAL_POLICY_SLUGS) {
      const markdown = publishedLegalPolicyMarkdown(slug);
      expect(sha256(markdown), slug).toBe(expectedDigests[slug].sha256);
      expect(Buffer.byteLength(markdown, 'utf8'), slug).toBe(expectedDigests[slug].bytes);

      const entry = record.policies.find((item) => item.slug === slug)!;
      expect(entry.version).toBe(expectedDigests[slug].version);
      expect(entry.publicationMarkdownSha256).toBe(expectedDigests[slug].sha256);
      expect(entry.publicationMarkdownBytes).toBe(expectedDigests[slug].bytes);

      if (slug === 'data-processing' || slug === 'subprocessors') {
        expect(entry.mode).toBe('available-template-not-executed');
        expect(entry.executionStatus).toBe('not-executed');
        expect(entry.effectiveAt).toBeNull();
        expect(markdown).toContain('Availability: template only — not executed by publication.');
      } else {
        expect(entry.effectiveAt).toBe('2026-11-10T12:00:00.000Z');
        expect(entry.executionStatus).toBe('not-applicable');
      }
    }
  });

  it('fails closed on wrong origins, bare flags, tampered hashes, bad timestamps and template execution claims', () => {
    const base = JSON.parse(serializeHostedLegalPublication(validPublication()));

    for (const badInput of [null, undefined, true, 'active', 1, []]) {
      expect(() => validateHostedLegalPublication(badInput)).toThrow();
    }

    for (const wrongOrigin of [
      'http://localhost:4320',
      'https://example.com',
      'https://www.opengen.dev',
      'http://opengen.dev',
      'https://opengen.dev/',
    ]) {
      expect(() => validateHostedLegalPublication(base, { expectedOrigin: wrongOrigin })).toThrow();
      expect(() =>
        validateHostedLegalPublication({ ...base, canonicalOrigin: wrongOrigin }),
      ).toThrow();
    }

    // Partial or reordered policy sets
    expect(() =>
      validateHostedLegalPublication({ ...base, policies: base.policies.slice(0, 4) }),
    ).toThrow();
    expect(() =>
      validateHostedLegalPublication({
        ...base,
        policies: [base.policies[1], base.policies[0], ...base.policies.slice(2)],
      }),
    ).toThrow();

    // Tampered digests and byte counts
    for (const field of [
      'sourceMarkdownSha256',
      'approvedBodyMarkdownSha256',
      'semanticCanonicalSha256',
      'publicationMarkdownSha256',
    ] as const) {
      const copy = structuredClone(base);
      copy.policies[0][field] = 'f'.repeat(64);
      expect(() => validateHostedLegalPublication(copy)).toThrow();
    }
    {
      const copy = structuredClone(base);
      copy.policies[0].publicationMarkdownBytes += 1;
      expect(() => validateHostedLegalPublication(copy)).toThrow();
    }

    // Invalid UTC timestamps and effectiveAt < publishedAt
    for (const badTimestamp of [
      '2026-11-10',
      '2026-11-10T12:00:00+00:00',
      '2026-02-31T12:00:00.000Z',
      '2026-11-10T12:00:00.123456Z',
    ]) {
      expect(() =>
        validateHostedLegalPublication({ ...base, publishedAt: badTimestamp }),
      ).toThrow();
      const copy = structuredClone(base);
      copy.policies[0].effectiveAt = badTimestamp;
      copy.policies[1].effectiveAt = badTimestamp;
      copy.policies[2].effectiveAt = badTimestamp;
      expect(() => validateHostedLegalPublication(copy)).toThrow();
    }
    {
      const copy = structuredClone(base);
      copy.publishedAt = '2026-11-10T12:00:01.000Z';
      expect(() => validateHostedLegalPublication(copy)).toThrow(/precede publishedAt/);
    }
    {
      const copy = structuredClone(base);
      copy.policies[1].effectiveAt = '2026-11-10T13:00:00.000Z';
      expect(() => validateHostedLegalPublication(copy)).toThrow(/coordinated effectiveAt/);
    }

    // Attempting to execute DPA or subprocessors by publication
    for (const templateIndex of [3, 4]) {
      const withEffective = structuredClone(base);
      withEffective.policies[templateIndex].effectiveAt = '2026-11-10T12:00:00.000Z';
      expect(() => validateHostedLegalPublication(withEffective)).toThrow();

      const withExecutedStatus = structuredClone(base);
      withExecutedStatus.policies[templateIndex].executionStatus = 'executed';
      expect(() => validateHostedLegalPublication(withExecutedStatus)).toThrow();

      const withAdoptedMode = structuredClone(base);
      withAdoptedMode.policies[templateIndex].mode = 'contract-adopted';
      expect(() => validateHostedLegalPublication(withAdoptedMode)).toThrow();
    }
  });
});

describe('server trusted configuration reader & startup guards', () => {
  it('defaults to undefined and frozen Draft when absent, and rejects bare switches, symlinks, conflicts and bad origins', () => {
    expect(readHostedLegalPublicationConfiguration({})).toBeUndefined();
    const defaultReader = createHostedHumanTermsPolicyReader(undefined);
    expect(defaultReader).toBe(currentHumanTermsPolicy);
    expect(defaultReader()).toEqual({
      version: 'hosted-terms-v4-draft-2026-11-09',
      digest: '17e9c824b1338651ae9e8570f7b6ec265b0b0d3a805d90b049aa584c70987ad5',
      status: 'draft',
      effectiveAt: null,
    });

    const pub = validPublication();
    const rawJson = serializeHostedLegalPublication(pub);

    expect(
      readHostedLegalPublicationConfiguration({
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_JSON: rawJson,
      }),
    ).toEqual(pub);

    const dir = makeTempDir();
    const filePath = join(dir, 'legal-publication.json');
    writeFileSync(filePath, rawJson);
    expect(
      readHostedLegalPublicationConfiguration({
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_FILE: filePath,
      }),
    ).toEqual(pub);

    // Symlink file and symlink parent directory must fail closed
    const symlinkFile = join(dir, 'linked.json');
    symlinkSync(filePath, symlinkFile);
    expect(() =>
      readHostedLegalPublicationConfiguration({
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_FILE: symlinkFile,
      }),
    ).toThrow();

    const realSubdir = join(dir, 'real-sub');
    mkdirSync(realSubdir);
    writeFileSync(join(realSubdir, 'pub.json'), rawJson);
    const linkedSubdir = join(dir, 'linked-sub');
    symlinkSync(realSubdir, linkedSubdir);
    expect(() =>
      readHostedLegalPublicationConfiguration({
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_FILE: join(linkedSubdir, 'pub.json'),
      }),
    ).toThrow();

    // Mutual exclusion, bare flags, relative paths, sandbox conflict, wrong origins, oversized JSON
    for (const badEnv of [
      { OPENGEN_LEGAL_ACTIVE: 'true' },
      { OPENGEN_TERMS_ACTIVE: '1' },
      { OPENGEN_TERMS_STATUS: 'active' },
      { OPENGEN_HUMAN_TERMS_ACTIVE: 'true' },
      { OPENGEN_PUBLIC_URL: canonicalOrigin, OPENGEN_LEGAL_PUBLICATION_JSON: '   ' },
      { OPENGEN_PUBLIC_URL: canonicalOrigin, OPENGEN_LEGAL_PUBLICATION_FILE: 'relative/pub.json' },
      {
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_FILE: filePath,
        OPENGEN_LEGAL_PUBLICATION_JSON: rawJson,
      },
      {
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_BILLING_SANDBOX: 'true',
        OPENGEN_LEGAL_PUBLICATION_JSON: rawJson,
      },
      {
        OPENGEN_PUBLIC_URL: 'http://localhost:4320',
        OPENGEN_LEGAL_PUBLICATION_JSON: rawJson,
      },
      {
        OPENGEN_PUBLIC_URL: 'https://opengen.dev/subpath',
        OPENGEN_LEGAL_PUBLICATION_JSON: rawJson,
      },
      {
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OPENGEN_LEGAL_PUBLICATION_JSON: 'x'.repeat(MAX_HOSTED_LEGAL_PUBLICATION_BYTES + 1),
      },
    ]) {
      expect(() => readHostedLegalPublicationConfiguration(badEnv)).toThrow();
    }
  });

  it('rejects invalid publication configuration in index.ts before any database or network connection', () => {
    const entry = new URL('../apps/server/src/index.ts', import.meta.url).href;
    const root = fileURLToPath(new URL('../', import.meta.url));
    const script = `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const require = createRequire(import.meta.url);
      const refuseNetwork = () => { throw new Error('UNEXPECTED_STARTUP_NETWORK'); };
      globalThis.fetch = refuseNetwork;
      require('node:net').Socket.prototype.connect = refuseNetwork;
      for (const module of ['node:http', 'node:https']) {
        require(module).request = refuseNetwork;
        require(module).get = refuseNetwork;
      }
      syncBuiltinESMExports();
      await import(${JSON.stringify(entry)});
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: '/usr/bin:/bin',
          NODE_ENV: 'production',
          OPENGEN_PUBLIC_URL: 'http://localhost:4320',
          DATABASE_URL: 'postgresql://fixture@127.0.0.1:1/opengen_fixture',
          OPENGEN_LEGAL_PUBLICATION_JSON: serializeHostedLegalPublication(validPublication()),
        },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).not.toBe(0);
    const output = child.stdout + child.stderr;
    expect(output).toContain('canonical https://opengen.dev');
    expect(output).not.toMatch(/UNEXPECTED_STARTUP_NETWORK|ECONNREFUSED|ETIMEDOUT/);
  }, 45_000);

  it('throws immediately at buildApp startup if auth and manual billing readers disagree or sandbox/unscoped payments are mixed', async () => {
    const readerA = createHostedHumanTermsPolicyReader(validPublication());
    const readerB = createHostedHumanTermsPolicyReader(validPublication());
    const dummyRuntime = {
      activation: 'manual',
      processorEnvironment: { id: 'env-1', accountId: 'acct_fixture', livemode: true },
      terms: { version: 'v1', text: 'text' },
    } as unknown as BillingFixtureRuntimeOptions;

    await expect(
      buildApp({
        publicUrl: canonicalOrigin,
        humanTermsPolicy: readerA,
        billingRuntime: { ...dummyRuntime, humanTermsPolicy: readerB },
      }),
    ).rejects.toThrow('Auth and manual billing must share the exact human Terms policy reader.');

    await expect(
      buildApp({
        publicUrl: canonicalOrigin,
        humanTermsPolicy: readerA,
        billingRuntime: { ...dummyRuntime, humanTermsPolicy: undefined },
      }),
    ).rejects.toThrow('Auth and manual billing must share the exact human Terms policy reader.');

    await expect(
      buildApp({
        publicUrl: canonicalOrigin,
        humanTermsPolicy: readerA,
        billingRuntime: {
          ...dummyRuntime,
          activation: 'sandbox',
          processorEnvironment: { id: 'sbx-1', accountId: 'acct_fixture', livemode: false },
        },
      }),
    ).rejects.toThrow('Sandbox billing activation cannot bind a hosted human Terms policy reader.');

    await expect(
      buildApp({
        publicUrl: canonicalOrigin,
        humanTermsPolicy: readerA,
        paymentConfig: { livemode: true },
      }),
    ).rejects.toThrow('scoped manual billing rather than unscoped payments');
  });
});

describe('ordinary buildApp human login & T0 effectiveAt boundary', () => {
  async function authApp(humanTermsPolicy?: () => HumanTermsPolicy) {
    const receipts: Array<{
      issuer: string;
      subject: string;
      policyVersion: string;
      policyDigest: string;
    }> = [];
    const principal: Principal = {
      workspaceId: 'ws-composition-fixture',
      scopes: ['read', 'generate'],
      keyKind: 'browser',
      identity: {
        issuer: 'https://identity.fixture.invalid',
        subject: 'verified-composition-human',
      },
    };
    vi.spyOn(TermsReceiptStore.prototype, 'recordVerifiedAcceptance').mockImplementation(
      async (input) => {
        receipts.push(input);
        return {
          ...input,
          noticeVersion: HUMAN_TERMS_NOTICE_VERSION,
          action: 'continue',
          method: 'oidc-verified',
          acceptedAt: new Date(),
        };
      },
    );
    const pending = new Set([pendingConsentId]);
    const mcp = {
      issuer: canonicalOrigin,
      pendingAuthorization: vi.fn(async (id: string) =>
        pending.has(id) ? { requestId: id } : null,
      ),
      rateLimit: vi.fn(async () => {}),
      refresh: vi.fn(async () => ({ token_type: 'Bearer', access_token: 'fixture' })),
    } as unknown as McpOAuthStore;

    const app = await buildApp({
      publicUrl: canonicalOrigin,
      ...(humanTermsPolicy ? { humanTermsPolicy } : {}),
      engine: {
        getExecutableRouteIds: () => [],
        submit: async () => ({}),
        getJob: async () => null,
        listJobs: async () => [],
        cancel: async () => null,
        getBalance: async () => ({ availableMicros: 0, reservedMicros: 0 }),
        routeMetrics: async () => [],
        accounts: {
          identity: vi.fn(async () => principal),
          createSession: vi.fn(async () => 'c'.repeat(64)),
          pool: {} as never,
        } as unknown as AccountStore,
        mcpOAuth: mcp,
      },
      env: {
        NODE_ENV: 'test',
        OPENGEN_PUBLIC_URL: canonicalOrigin,
        OIDC_ISSUER: 'https://identity.fixture.invalid',
        OIDC_CLIENT_ID: 'client-fixture',
        OIDC_CLIENT_SECRET: 'synthetic-server-secret',
        MR_SESSION_SECRET: 's'.repeat(32),
      },
    });
    apps.push(app);
    return { app, receipts, pending };
  }

  it('keeps default buildApp on frozen Draft and writes no receipt on verified Continue', async () => {
    const { app, receipts } = await authApp();
    const start = await app.inject({ url: '/auth/login' });
    expect(start.statusCode).toBe(200);
    expect(start.body).toContain('hosted-terms-v4-draft-2026-11-09');
    expect(start.body).toContain(
      '17e9c824b1338651ae9e8570f7b6ec265b0b0d3a805d90b049aa584c70987ad5',
    );
    expect(start.body).toContain('Continuing signs you in. It does not accept these drafts.');

    const fields = parseContinueForm(start.body);
    const startCookies = cookieParts(start.headers);
    const continued = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: canonicalOrigin,
        cookie: cookieJar(startCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: fields.toString(),
    });
    expect(continued.statusCode).toBe(200);

    const cb = await app.inject({
      url: '/auth/callback?code=fixture',
      headers: { cookie: cookieJar(startCookies, cookieParts(continued.headers)) },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('https://opengen.dev/app#start');
    expect(receipts).toEqual([]);
  });

  it('enforces the T0 boundary: returns Draft before T0, rejects pre-T0 intents submitted after T0, and records exact published digest at/after T0 while preserving MCP consent', async () => {
    const t0Iso = '2026-11-10T18:00:00.000Z';
    const t0Ms = Date.parse(t0Iso);
    let currentClock = t0Ms - 30_000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentClock);

    const pub = validPublication({
      publishedAt: '2026-11-10T17:00:00.000Z',
      effectiveAt: t0Iso,
    });
    const sharedReader = createHostedHumanTermsPolicyReader(pub);
    const { app, receipts } = await authApp(sharedReader);

    // 1. Before T0: reader returns Draft; full sign-in succeeds without writing a receipt
    expect(sharedReader()).toMatchObject({
      version: 'hosted-terms-v4-draft-2026-11-09',
      status: 'draft',
      effectiveAt: null,
    });
    const preStart = await app.inject({ url: '/auth/login' });
    expect(preStart.statusCode).toBe(200);
    expect(preStart.body).toContain('hosted-terms-v4-draft-2026-11-09');
    const preContinued = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: canonicalOrigin,
        cookie: cookieJar(cookieParts(preStart.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: parseContinueForm(preStart.body).toString(),
    });
    expect(preContinued.statusCode).toBe(200);
    const preCallback = await app.inject({
      url: '/auth/callback?code=fixture',
      headers: {
        cookie: cookieJar(cookieParts(preStart.headers), cookieParts(preContinued.headers)),
      },
    });
    expect(preCallback.statusCode).toBe(302);
    expect(receipts).toEqual([]);

    // 2. Start one intent and one OIDC transaction just BEFORE T0, then cross T0
    const crossingNotice = await app.inject({
      url: '/auth/login',
      headers: { cookie: `og_mcp_consent=${pendingConsentId}` },
    });
    const crossingNoticeCookies = [
      `og_mcp_consent=${pendingConsentId}`,
      ...cookieParts(crossingNotice.headers),
    ];
    const crossingFields = parseContinueForm(crossingNotice.body);

    const crossingTxNotice = await app.inject({ url: '/auth/login' });
    const crossingTxContinued = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: canonicalOrigin,
        cookie: cookieJar(cookieParts(crossingTxNotice.headers)),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: parseContinueForm(crossingTxNotice.body).toString(),
    });
    expect(crossingTxContinued.statusCode).toBe(200);

    // Advance clock to exact T0
    currentClock = t0Ms;
    expect(sharedReader()).toEqual({
      version: 'hosted-terms-v4-2026-11-09',
      digest: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
      status: 'active',
      effectiveAt: t0Iso,
    });

    // Submitting pre-T0 Continue form after T0 must fail closed (401 login_intent_invalid)
    const stalePost = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: canonicalOrigin,
        cookie: cookieJar(crossingNoticeCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: crossingFields.toString(),
    });
    expect(stalePost.statusCode).toBe(401);
    expect(stalePost.json().error.code).toBe('login_intent_invalid');

    // Completing pre-T0 OIDC callback after T0 must ALSO fail closed without recording a receipt
    const staleCallback = await app.inject({
      url: '/auth/callback?code=fixture',
      headers: {
        cookie: cookieJar(
          cookieParts(crossingTxNotice.headers),
          cookieParts(crossingTxContinued.headers),
        ),
      },
    });
    expect(staleCallback.statusCode).toBe(401);
    expect(staleCallback.json().error.code).toBe('login_intent_invalid');
    expect(receipts).toEqual([]);

    // 3. Fresh login at/after T0 with pending MCP consent: verifies Origin, PKCE/state/nonce, records exact receipt, redirects to /oauth/consent
    const activeStart = await app.inject({
      url: '/auth/login',
      headers: { cookie: `og_mcp_consent=${pendingConsentId}` },
    });
    expect(activeStart.statusCode).toBe(200);
    expect(activeStart.body).toContain('hosted-terms-v4-2026-11-09');
    expect(activeStart.body).toContain(
      '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
    );
    expect(activeStart.body).toContain(`Effective: ${t0Iso}`);
    expect(activeStart.body).toContain('By continuing, you agree to the');

    const activeStartCookies = [
      `og_mcp_consent=${pendingConsentId}`,
      ...cookieParts(activeStart.headers),
    ];
    const activeFields = parseContinueForm(activeStart.body);

    // Wrong Origin still fails 403
    const badOrigin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: 'https://attacker.fixture.invalid',
        cookie: cookieJar(activeStartCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: activeFields.toString(),
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(receipts).toEqual([]);

    const activeContinued = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: {
        origin: canonicalOrigin,
        cookie: cookieJar(activeStartCookies),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: activeFields.toString(),
    });
    expect(activeContinued.statusCode).toBe(200);

    const activeCallback = await app.inject({
      url: '/auth/callback?code=fixture',
      headers: {
        cookie: cookieJar(activeStartCookies, cookieParts(activeContinued.headers)),
      },
    });
    expect(activeCallback.statusCode).toBe(302);
    expect(activeCallback.headers.location).toBe(
      `https://opengen.dev/oauth/consent?request=${encodeURIComponent(pendingConsentId)}`,
    );
    expect(receipts).toEqual([
      {
        issuer: 'https://identity.fixture.invalid',
        subject: 'verified-composition-human',
        policyVersion: 'hosted-terms-v4-2026-11-09',
        policyDigest: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
      },
    ]);
  });
});

describe('web legal routes, /legal-publication.json, HTML rendering & UI surface labels', () => {
  const mdRoutes = {
    terms: getTermsMd,
    refunds: getRefundsMd,
    privacy: getPrivacyMd,
    'data-processing': getDataProcessingMd,
    subprocessors: getSubprocessorsMd,
  } as const;

  const metadataGenerators = {
    terms: generateTermsMetadata,
    refunds: generateRefundsMetadata,
    privacy: generatePrivacyMetadata,
    'data-processing': generateDpaMetadata,
    subprocessors: generateSubprocessorsMetadata,
  } as const;

  const policiesBySlug = {
    terms: termsPolicy,
    refunds: refundsPolicy,
    privacy: privacyPolicy,
    'data-processing': dataProcessingPolicy,
    subprocessors: subprocessorsPolicy,
  } as const;

  it('preserves 100% default Draft web routes, 404 manifest and Draft UI labels when unconfigured', async () => {
    vi.stubEnv('OPENGEN_PUBLIC_URL', canonicalOrigin);
    expect(readWebLegalPublication()).toBeNull();

    const manifestRes = getLegalPublicationJson();
    expect(manifestRes.status).toBe(404);
    expect(manifestRes.headers.get('cache-control')).toBe('no-store');
    expect(manifestRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await manifestRes.json()).toEqual({
      error: {
        code: 'legal_publication_not_configured',
        message: 'No hosted legal publication manifest is configured for this installation.',
      },
    });

    for (const policy of legalPolicies) {
      const res = mdRoutes[policy.slug]();
      expect(res.status).toBe(200);
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(await res.text()).toBe(legalPolicyMarkdown(policy));

      const meta = metadataGenerators[policy.slug]();
      expect(String(meta.title)).toContain('review draft');
      expect(meta.robots).toMatchObject({ index: false });

      const html = renderToStaticMarkup(createElement(LegalReviewPage, { policy }));
      expect(html).toContain('LEGAL / REVIEW DRAFT');
      expect(html).toContain('Not effective');
      expect(html).toContain('Terms draft');
    }

    expect(renderToStaticMarkup(createElement(Footer))).toContain('Terms draft');
    expect(renderToStaticMarkup(createElement(BillingPage))).toContain('Terms draft');
    expect(renderToStaticMarkup(createElement(GatewayAccess, { onChange: () => {} }))).toContain(
      'Terms draft',
    );
    expect(
      renderToStaticMarkup(
        createElement(McpConsent, { requestId: pendingConsentId, initialNeedsLogin: true }),
      ),
    ).toContain('Not yet effective.');
    expect(renderToStaticMarkup(createElement(DocsPage))).toContain('Legal review drafts:');
  });

  it('renders staged pre-effective metadata and UI copy before T0 without claiming adoption', async () => {
    const pub = validPublication({
      publishedAt: '2026-11-10T10:00:00.000Z',
      effectiveAt: '2099-01-01T00:00:00.000Z',
    });
    vi.stubEnv('OPENGEN_PUBLIC_URL', canonicalOrigin);
    vi.stubEnv('OPENGEN_LEGAL_PUBLICATION_JSON', serializeHostedLegalPublication(pub));

    const manifestRes = getLegalPublicationJson();
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');

    const termsMdRes = getTermsMd();
    expect(termsMdRes.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(sha256(await termsMdRes.text())).toBe(
      '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
    );

    expect(legalPageMetadata('terms').robots).toMatchObject({ index: false });

    const stagedTermsHtml = renderToStaticMarkup(
      createElement(LegalReviewPage, { policy: termsPolicy }),
    );
    expect(stagedTermsHtml).toContain('LEGAL / SCHEDULED PUBLICATION');
    expect(stagedTermsHtml).toContain(
      'Scheduled effective time: 2099-01-01T00:00:00.000Z (not yet effective)',
    );
    expect(stagedTermsHtml).toContain('Terms (scheduled)');

    const stagedPresentation = legalSurfacePresentationFromPublication(
      pub,
      Date.parse('2026-11-10T12:00:00.000Z'),
    );
    expect(stagedPresentation.mode).toBe('staged');
    const stagedBillingHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: stagedPresentation,
        children: createElement(BillingPage),
      }),
    );
    expect(stagedBillingHtml).toContain(
      'Scheduled effective 2099-01-01T00:00:00.000Z — not yet effective.',
    );
    expect(stagedBillingHtml).not.toContain('Terms draft');
  });

  it('serves exact published Markdown digests, matching HTML/JSON metadata, adopted UI labels and non-executed templates at/after T0', async () => {
    const pub = validPublication({
      publishedAt: '2026-11-10T12:00:00.000Z',
      effectiveAt: '2026-11-10T12:00:00.000Z',
    });
    vi.stubEnv('OPENGEN_PUBLIC_URL', canonicalOrigin);
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('OPENGEN_NOINDEX', 'false');
    vi.stubEnv('OPENGEN_LEGAL_PUBLICATION_JSON', serializeHostedLegalPublication(pub));

    const manifestRes = getLegalPublicationJson();
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(manifestRes.headers.get('cache-control')).toBe('no-store');
    expect(manifestRes.headers.get('x-robots-tag')).toBeNull();
    const manifestJson = await manifestRes.json();
    expect(manifestJson).toEqual(pub);

    const serverPolicySnapshot = createHostedHumanTermsPolicyReader(pub, () =>
      Date.parse('2026-11-10T12:00:00.000Z'),
    )();
    expect(serverPolicySnapshot).toEqual({
      version: 'hosted-terms-v4-2026-11-09',
      digest: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
      status: 'active',
      effectiveAt: '2026-11-10T12:00:00.000Z',
    });

    for (const slug of HOSTED_LEGAL_POLICY_SLUGS) {
      const mdRes = mdRoutes[slug]();
      expect(mdRes.status).toBe(200);
      expect(mdRes.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
      expect(mdRes.headers.get('cache-control')).toBe('no-store');
      expect(mdRes.headers.get('x-robots-tag')).toBeNull();

      const mdText = await mdRes.text();
      const manifestEntry = manifestJson.policies.find(
        (item: { slug: string }) => item.slug === slug,
      );
      expect(sha256(mdText), slug).toBe(manifestEntry.publicationMarkdownSha256);
      expect(Buffer.byteLength(mdText, 'utf8'), slug).toBe(manifestEntry.publicationMarkdownBytes);
      expect(sha256(mdText), slug).toBe(
        APPROVED_HOSTED_LEGAL_POLICIES[slug].publicationMarkdownSha256,
      );

      if (slug === 'terms') {
        expect(sha256(mdText)).toBe(serverPolicySnapshot.digest);
      }

      const meta = metadataGenerators[slug]();
      expect(String(meta.title)).not.toContain('draft');
      expect(meta.robots).toMatchObject({ index: true });

      const html = renderToStaticMarkup(
        createElement(LegalReviewPage, {
          policy: policiesBySlug[slug],
          publication: pub,
          now: Date.parse('2026-11-10T12:05:00.000Z'),
        }),
      );
      expect(html).not.toContain('LEGAL / REVIEW DRAFT');
      expect(html).not.toContain('Terms draft');
      expect(html).toContain(manifestEntry.version);
      expect(html).toContain(manifestEntry.publicationMarkdownSha256);
      expect(html).toContain('Published: 2026-11-10T12:00:00.000Z');

      if (slug === 'data-processing' || slug === 'subprocessors') {
        expect(html).toContain('LEGAL / BUSINESS TEMPLATE');
        expect(html).toContain('Template only — not executed by publication.');
        expect(html).toContain('does not complete a customer record, supplier appointment, DPA');
        expect(html).not.toContain('Effective: 2026-11-10');
      } else {
        expect(html).toContain('Effective: 2026-11-10T12:00:00.000Z');
      }
    }

    const publishedPresentation = legalSurfacePresentationFromPublication(
      pub,
      Date.parse('2026-11-10T12:05:00.000Z'),
    );
    expect(publishedPresentation.mode).toBe('published');

    const footerHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: publishedPresentation,
        children: createElement(Footer),
      }),
    );
    expect(footerHtml).toContain('Terms of Service');
    expect(footerHtml).toContain('Refund Policy');
    expect(footerHtml).toContain('Privacy Notice');
    expect(footerHtml).not.toContain('draft');

    const billingHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: publishedPresentation,
        children: createElement(BillingPage),
      }),
    );
    expect(billingHtml).toContain('Terms of Service');
    expect(billingHtml).not.toContain('Not yet effective');
    expect(billingHtml).not.toContain('draft');

    const gatewayHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: publishedPresentation,
        children: createElement(GatewayAccess, { onChange: () => {} }),
      }),
    );
    expect(gatewayHtml).toContain('Terms of Service');
    expect(gatewayHtml).not.toContain('not yet effective');

    const consentHtml = renderToStaticMarkup(
      createElement(LegalPresentationProvider, {
        presentation: publishedPresentation,
        children: createElement(McpConsent, {
          requestId: pendingConsentId,
          initialNeedsLogin: true,
        }),
      }),
    );
    expect(consentHtml).toContain('Terms of Service');
    expect(consentHtml).not.toContain('Not yet effective');

    const docsHtml = renderToStaticMarkup(createElement(DocsPage));
    expect(docsHtml).toContain('Hosted legal policies:');
    expect(docsHtml).toContain('available templates only — not executed by publication');
    expect(docsHtml).not.toContain('Legal review drafts:');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  'end-to-end PostgreSQL composition: buildApp + hostedBillingManual + OIDC receipt + live manual funding',
  () => {
    const rails = {
      allowsEnabled: false,
      maxThresholdMicros: 10_000_000,
      maxAmountCents: 2500,
      maxMonthlyCapCents: 10000,
      maxAttemptsPerMonth: 4,
      minCooldownSeconds: 86400,
      maxFailureLimit: 3,
    };

    it('wires one shared hosted reader across auth and hostedBillingManual, gates live funding on the exact 9a1916bf... receipt, and preserves existing order recovery', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'hosted_legal_e2e');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          publicUrl: canonicalOrigin,
          poolSize: 1,
          providerEnv: { NODE_ENV: 'test' },
          adapters: [],
          providerExecutionEnabled: false,
        }),
      );
      try {
        await engine.initialize();
        const subject = `human-owner-${randomUUID()}`;
        const issuer = 'https://identity.fixture.invalid';
        provider.claims = { iss: issuer, sub: subject, email: 'owner@example.invalid' };

        // Provision owner membership & live billing owner record
        const initialPrincipal = await engine.accounts.identity(issuer, subject);
        const workspaceId = initialPrincipal.workspaceId;
        const environment = {
          id: `live-legal-${randomUUID()}`,
          accountId: 'acct_localfixture',
          livemode: true,
        };
        await registerBillingProcessorEnvironmentInTransaction(engine.pool, environment);
        const approvalReference = 'reviewed-live-manual-owner-approval';
        await engine.pool.query(
          `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
           processor_environment_id,livemode,rails,consent_reference,approval_reference)
           SELECT workspace_id,id,extract(epoch FROM accepted_at)::text,1,$3,true,$4,
             'synthetic-owner-consent',$5 FROM mr_memberships
           WHERE workspace_id=$1 AND id=$2`,
          [
            workspaceId,
            initialPrincipal.membershipId,
            environment.id,
            JSON.stringify(rails),
            approvalReference,
          ],
        );

        // Mock Stripe SDK client for hostedBillingManual (no real network)
        const stripe = createStripeClient('local-fixture-noncredential');
        vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
          id: environment.accountId,
          charges_enabled: true,
        } as Stripe.Response<Stripe.Account>);
        const checkoutCreate = vi
          .spyOn(stripe.checkout.sessions, 'create')
          .mockImplementation((async (params: Stripe.Checkout.SessionCreateParams) => {
            const id = `cs_live_${String(params.client_reference_id).replaceAll('-', '')}`;
            return {
              id,
              mode: 'payment',
              currency: 'usd',
              amount_subtotal: 2500,
              amount_total: 2500,
              payment_status: 'unpaid',
              status: 'open',
              client_reference_id: String(params.client_reference_id),
              payment_intent: null,
              livemode: true,
              url: 'https://checkout.stripe.com/c/pay/local_live_fixture',
            } as unknown as Stripe.Response<Stripe.Checkout.Session>;
          }) as never);

        const manualConfig = readBillingManualConfiguration({
          NODE_ENV: 'production',
          OPENGEN_BILLING_MANUAL: 'true',
          STRIPE_LIVEMODE: 'true',
          STRIPE_SECRET_KEY: ['rk', 'live', 'syntheticfixture'].join('_'),
          STRIPE_WEBHOOK_SECRET: ['whsec', 'syntheticfixture'].join('_'),
          OPENGEN_PUBLIC_URL: canonicalOrigin,
          DATABASE_URL: 'postgresql://localhost/opengen_live_fixture',
          OPENGEN_BILLING_MANUAL_WORKSPACE: workspaceId,
          OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: environment.id,
          OPENGEN_BILLING_PROCESSOR_ACCOUNT: environment.accountId,
          OPENGEN_BILLING_APPROVAL_REFERENCE: approvalReference,
          OPENGEN_BILLING_TERMS_VERSION: 'manual-payment-terms-v1',
          OPENGEN_BILLING_TERMS_TEXT: 'Synthetic separate manual payment terms.',
          OPENGEN_BILLING_CHECKOUT: 'open',
        })!;

        const t0Iso = '2026-11-10T15:00:00.000Z';
        const t0Ms = Date.parse(t0Iso);
        let currentClock = t0Ms - 60_000;
        vi.spyOn(Date, 'now').mockImplementation(() => currentClock);

        const publication = readHostedLegalPublicationConfiguration({
          OPENGEN_PUBLIC_URL: canonicalOrigin,
          OPENGEN_LEGAL_PUBLICATION_JSON: serializeHostedLegalPublication(
            validPublication({
              publishedAt: '2026-11-10T14:00:00.000Z',
              effectiveAt: t0Iso,
            }),
          ),
        })!;
        const humanTermsPolicy = createHostedHumanTermsPolicyReader(publication);
        const billingRuntime = await hostedBillingManual(engine.pool, manualConfig, stripe, {
          humanTermsPolicy,
        });
        expect(billingRuntime.humanTermsPolicy).toBe(humanTermsPolicy);

        const app = await buildApp({
          engine,
          billingRuntime,
          humanTermsPolicy,
          publicUrl: canonicalOrigin,
          env: {
            NODE_ENV: 'test',
            OPENGEN_PUBLIC_URL: canonicalOrigin,
            OIDC_ISSUER: issuer,
            OIDC_CLIENT_ID: 'client-fixture',
            OIDC_CLIENT_SECRET: 'synthetic-server-secret',
            MR_SESSION_SECRET: 's'.repeat(32),
          },
        });
        apps.push(app);

        const completeBrowserSignIn = async () => {
          const start = await app.inject({ url: '/auth/login' });
          expect(start.statusCode).toBe(200);
          const startCookies = cookieParts(start.headers);
          const continued = await app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: {
              origin: canonicalOrigin,
              cookie: cookieJar(startCookies),
              'content-type': 'application/x-www-form-urlencoded',
            },
            payload: parseContinueForm(start.body).toString(),
          });
          expect(continued.statusCode).toBe(200);
          const cb = await app.inject({
            url: '/auth/callback?code=fixture',
            headers: { cookie: cookieJar(startCookies, cookieParts(continued.headers)) },
          });
          expect(cb.statusCode).toBe(302);
          const sessionCookie = cookieParts(cb.headers).find((c) => c.startsWith('og_session='))!;
          const rawToken = sessionCookie.slice('og_session='.length);
          const sessionPrincipal = (await engine.accounts.session(rawToken))!;
          return {
            cookie: sessionCookie,
            headers: {
              cookie: sessionCookie,
              'x-opengen-workspace': workspaceId,
              'x-opengen-recovery-scope': sessionRecoveryScope(sessionPrincipal),
            },
          };
        };

        // Phase 1: Before T0 — sign-in works without writing a receipt; live manual funding is closed (terms-inactive)
        const preSession = await completeBrowserSignIn();
        expect(
          (await engine.pool.query('SELECT count(*)::int AS n FROM mr_terms_receipts')).rows[0].n,
        ).toBe(0);

        const preSummary = await app.inject({ url: '/v1/billing', headers: preSession.headers });
        expect(preSummary.statusCode).toBe(200);
        expect(preSummary.json().newFunding).toEqual({
          allowed: false,
          reason: 'terms-inactive',
        });

        const preOrder = await app.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...preSession.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'pre-t0-denied',
          },
          payload: { amountCents: 2500 },
        });
        expect(preOrder.statusCode).toBe(403);
        expect(preOrder.json().error.code).toBe('current_human_terms_inactive');

        // Phase 2: Cross T0 without re-signing in — active Terms now require exact receipt (terms-required)
        currentClock = t0Ms + 1_000;

        // Seed foreign identity & old draft version receipts to prove neither unlocks funding
        const receiptStore = new TermsReceiptStore(engine.pool);
        await receiptStore.recordVerifiedAcceptance({
          issuer,
          subject: `${subject}-other`,
          policyVersion: 'hosted-terms-v4-2026-11-09',
          policyDigest: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
        });
        await receiptStore.recordVerifiedAcceptance({
          issuer,
          subject,
          policyVersion: 'hosted-terms-v4-draft-2026-11-09',
          policyDigest: '17e9c824b1338651ae9e8570f7b6ec265b0b0d3a805d90b049aa584c70987ad5',
        });

        const postNoReceiptSummary = await app.inject({
          url: '/v1/billing',
          headers: preSession.headers,
        });
        expect(postNoReceiptSummary.json().newFunding).toEqual({
          allowed: false,
          reason: 'terms-required',
        });

        const missingReceiptOrder = await app.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...preSession.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'post-t0-missing-receipt',
          },
          payload: { amountCents: 2500 },
        });
        expect(missingReceiptOrder.statusCode).toBe(403);
        expect(missingReceiptOrder.json().error.code).toBe('current_human_terms_required');
        expect(
          (await engine.pool.query('SELECT count(*)::int AS n FROM mr_payment_orders')).rows[0].n,
        ).toBe(0);
        expect(checkoutCreate).not.toHaveBeenCalled();

        // Phase 3: Complete verified Continue + OIDC callback after T0 — writes exact 9a1916bf... receipt & admits live funding!
        const activeSession = await completeBrowserSignIn();
        const savedReceipt = await engine.pool.query(
          `SELECT policy_version, policy_digest, notice_version, action, method
           FROM mr_terms_receipts WHERE issuer=$1 AND subject=$2 AND policy_version=$3`,
          [issuer, subject, 'hosted-terms-v4-2026-11-09'],
        );
        expect(savedReceipt.rows).toEqual([
          {
            policy_version: 'hosted-terms-v4-2026-11-09',
            policy_digest: '9a1916bf8f6fbdb4764dd809621df053ef4f9686435de76d5e3f8c0b7380e998',
            notice_version: 'human-terms-continue-v1',
            action: 'continue',
            method: 'oidc-verified',
          },
        ]);

        const admittedSummary = await app.inject({
          url: '/v1/billing',
          headers: activeSession.headers,
        });
        expect(admittedSummary.json().newFunding).toEqual({ allowed: true });

        const createdOrder = await app.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...activeSession.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'admitted-live-order-1',
          },
          payload: { amountCents: 2500 },
        });
        expect(createdOrder.statusCode, createdOrder.body).toBe(201);
        const orderId = createdOrder.json().id as string;

        const startedCheckout = await app.inject({
          method: 'POST',
          url: `/v1/billing/orders/${orderId}/checkout`,
          headers: {
            ...activeSession.headers,
            origin: canonicalOrigin,
          },
          payload: {},
        });
        expect(startedCheckout.statusCode, startedCheckout.body).toBe(200);
        expect(startedCheckout.json().status).toBe('checkout_open');
        expect(checkoutCreate).toHaveBeenCalledOnce();

        // Phase 4: Recovery preservation — even if a restart returns to unconfigured Draft, reading/replaying the existing order still works while new orders stay closed
        const fallbackRuntime = createBillingFixtureRuntime(engine.pool, {
          ...(billingRuntime as BillingFixtureRuntimeOptions),
          humanTermsPolicy: currentHumanTermsPolicy,
          manualTransport: {
            processorEnvironment: environment,
            assertProcessorEnvironment() {},
            createSession: vi.fn() as PaymentTransport['createSession'],
            retrieveSession: vi.fn(async (sessionId: string): Promise<CheckoutSession> => ({
              id: sessionId,
              mode: 'payment',
              currency: 'usd',
              amount_subtotal: 2500,
              amount_total: 2500,
              payment_status: 'unpaid',
              status: 'open',
              client_reference_id: orderId,
              payment_intent: null,
              livemode: true,
              url: 'https://checkout.stripe.com/c/pay/local_live_fixture',
            })),
          },
        });
        const recoveryApp = await buildApp({
          engine,
          billingRuntime: {
            ...(billingRuntime as BillingFixtureRuntimeOptions),
            humanTermsPolicy: currentHumanTermsPolicy,
            manualTransport: fallbackRuntime.payments.checkoutTransport as PaymentTransport & {
              processorEnvironment: typeof environment;
              assertProcessorEnvironment(): void;
            },
          },
          humanTermsPolicy: currentHumanTermsPolicy,
          publicUrl: canonicalOrigin,
          env: {
            NODE_ENV: 'test',
            OPENGEN_PUBLIC_URL: canonicalOrigin,
            MR_SESSION_SECRET: 's'.repeat(32),
          },
        });
        apps.push(recoveryApp);

        // Existing order read and same-key replay succeed (newFunding: false)
        const existingOrderRead = await recoveryApp.inject({
          url: `/v1/billing/orders/${orderId}`,
          headers: activeSession.headers,
        });
        expect(existingOrderRead.statusCode).toBe(200);
        expect(existingOrderRead.json().id).toBe(orderId);

        const sameKeyReplay = await recoveryApp.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...activeSession.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'admitted-live-order-1',
          },
          payload: { amountCents: 2500 },
        });
        expect(sameKeyReplay.statusCode).toBe(201);
        expect(sameKeyReplay.json().id).toBe(orderId);

        // Brand-new order under Draft is closed (terms-inactive)
        const newOrderBlocked = await recoveryApp.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...activeSession.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'fresh-order-after-withdrawal',
          },
          payload: { amountCents: 2500 },
        });
        expect(newOrderBlocked.statusCode).toBe(403);
        expect(newOrderBlocked.json().error.code).toBe('current_human_terms_inactive');
      } finally {
        await engine.close();
        await isolated.close();
      }
    });

    it('lets a brand-new external OIDC user self-serve enable manual prepaid billing on personal and team workspaces while failing closed across every non-admin, non-browser, paused, or unaccepted path', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'hosted_self_serve_e2e');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          publicUrl: canonicalOrigin,
          poolSize: 1,
          providerEnv: { NODE_ENV: 'test' },
          adapters: [],
          providerExecutionEnabled: false,
        }),
      );
      try {
        await engine.initialize();
        const issuer = 'https://identity.fixture.invalid';
        const operatorPrincipal = await engine.accounts.identity(
          issuer,
          'preseeded-operator-owner',
        );
        const environment = {
          id: `live-selfserve-${randomUUID()}`,
          accountId: 'acct_selfservefixture',
          livemode: true,
        };
        await registerBillingProcessorEnvironmentInTransaction(engine.pool, environment);
        const approvalReference = 'reviewed-live-manual-owner-approval';
        await engine.pool.query(
          `INSERT INTO mr_billing_owners(workspace_id,membership_id,membership_epoch,authority_version,
           processor_environment_id,livemode,rails,consent_reference,approval_reference)
           SELECT workspace_id,id,extract(epoch FROM accepted_at)::text,1,$3,true,$4,
             'synthetic-owner-consent',$5 FROM mr_memberships
           WHERE workspace_id=$1 AND id=$2`,
          [
            operatorPrincipal.workspaceId,
            operatorPrincipal.membershipId,
            environment.id,
            JSON.stringify({
              allowsEnabled: false,
              maxThresholdMicros: 5_000_000,
              maxAmountCents: 100_000,
              maxMonthlyCapCents: 100_000,
              maxAttemptsPerMonth: 4,
              minCooldownSeconds: 86_400,
              maxFailureLimit: 3,
            }),
            approvalReference,
          ],
        );

        const stripe = createStripeClient('local-fixture-noncredential');
        vi.spyOn(stripe.accounts, 'retrieve').mockResolvedValue({
          id: environment.accountId,
          charges_enabled: true,
        } as Stripe.Response<Stripe.Account>);
        const checkoutCreate = vi
          .spyOn(stripe.checkout.sessions, 'create')
          .mockImplementation((async (params: Stripe.Checkout.SessionCreateParams) => ({
            id: `cs_live_${String(params.client_reference_id).replaceAll('-', '')}`,
            mode: 'payment',
            currency: 'usd',
            amount_subtotal: Number(params.line_items?.[0]?.price_data?.unit_amount ?? 2500),
            amount_total: Number(params.line_items?.[0]?.price_data?.unit_amount ?? 2500),
            payment_status: 'unpaid',
            status: 'open',
            client_reference_id: String(params.client_reference_id),
            payment_intent: null,
            livemode: true,
            url: 'https://checkout.stripe.com/c/pay/external_user_live_fixture',
          })) as never);

        const t0Iso = '2026-11-10T15:00:00.000Z';
        const t0Ms = Date.parse(t0Iso);
        let currentClock = t0Ms - 60_000;
        vi.spyOn(Date, 'now').mockImplementation(() => currentClock);

        const publication = readHostedLegalPublicationConfiguration({
          OPENGEN_PUBLIC_URL: canonicalOrigin,
          OPENGEN_LEGAL_PUBLICATION_JSON: serializeHostedLegalPublication(
            validPublication({
              publishedAt: '2026-11-10T14:00:00.000Z',
              effectiveAt: t0Iso,
            }),
          ),
        })!;
        const humanTermsPolicy = createHostedHumanTermsPolicyReader(publication);

        // Regression guard: keyless hosted legal publication starts cleanly without unscoped PaymentStore
        const keylessApp = await buildApp({
          engine,
          humanTermsPolicy,
          publicUrl: canonicalOrigin,
          env: {
            NODE_ENV: 'test',
            OPENGEN_PUBLIC_URL: canonicalOrigin,
            MR_SESSION_SECRET: 's'.repeat(32),
          },
        });
        apps.push(keylessApp);
        expect((await keylessApp.inject({ url: '/health' })).statusCode).toBe(200);

        const makeManualApp = async (checkoutMode: 'open' | 'paused' = 'open') => {
          const manualConfig = readBillingManualConfiguration({
            NODE_ENV: 'production',
            OPENGEN_BILLING_MANUAL: 'true',
            STRIPE_LIVEMODE: 'true',
            STRIPE_SECRET_KEY: ['rk', 'live', 'syntheticfixture'].join('_'),
            STRIPE_WEBHOOK_SECRET: ['whsec', 'syntheticfixture'].join('_'),
            OPENGEN_PUBLIC_URL: canonicalOrigin,
            DATABASE_URL: 'postgresql://localhost/opengen_live_fixture',
            OPENGEN_BILLING_MANUAL_WORKSPACE: operatorPrincipal.workspaceId,
            OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: environment.id,
            OPENGEN_BILLING_PROCESSOR_ACCOUNT: environment.accountId,
            OPENGEN_BILLING_APPROVAL_REFERENCE: approvalReference,
            OPENGEN_BILLING_TERMS_VERSION: 'hosted-manual-prepaid-v1-2026-11-11',
            OPENGEN_BILLING_TERMS_TEXT: 'Prepaid non-recurring Stripe Checkout credit summary.',
            OPENGEN_BILLING_CHECKOUT: checkoutMode,
          })!;
          const runtime = await hostedBillingManual(engine.pool, manualConfig, stripe, {
            humanTermsPolicy,
          });
          const instance = await buildApp({
            engine,
            billingRuntime: runtime,
            humanTermsPolicy,
            publicUrl: canonicalOrigin,
            env: {
              NODE_ENV: 'test',
              OPENGEN_PUBLIC_URL: canonicalOrigin,
              OIDC_ISSUER: issuer,
              OIDC_CLIENT_ID: 'client-fixture',
              OIDC_CLIENT_SECRET: 'synthetic-server-secret',
              MR_SESSION_SECRET: 's'.repeat(32),
            },
          });
          apps.push(instance);
          return instance;
        };

        const app = await makeManualApp('open');
        const pausedApp = await makeManualApp('paused');

        const signInAs = async (sub: string, email: string) => {
          provider.claims = { iss: issuer, sub, email };
          const start = await app.inject({ url: '/auth/login' });
          const startCookies = cookieParts(start.headers);
          const continued = await app.inject({
            method: 'POST',
            url: '/auth/login',
            headers: {
              origin: canonicalOrigin,
              cookie: cookieJar(startCookies),
              'content-type': 'application/x-www-form-urlencoded',
            },
            payload: parseContinueForm(start.body).toString(),
          });
          const cb = await app.inject({
            url: '/auth/callback?code=fixture',
            headers: { cookie: cookieJar(startCookies, cookieParts(continued.headers)) },
          });
          expect(cb.statusCode).toBe(302);
          const sessionCookie = cookieParts(cb.headers).find((c) => c.startsWith('og_session='))!;
          const rawToken = sessionCookie.slice('og_session='.length);
          const sessionPrincipal = (await engine.accounts.session(rawToken))!;
          return {
            cookie: sessionCookie,
            principal: sessionPrincipal,
            headers: {
              cookie: sessionCookie,
              'x-opengen-workspace': sessionPrincipal.workspaceId,
              'x-opengen-recovery-scope': sessionRecoveryScope(sessionPrincipal),
            },
          };
        };

        // 1. External user signs up BEFORE T0 -> workspace created automatically, zero mr_billing_owners row, ownerEnrollment reports terms-inactive
        const preT0External = await signInAs('external-gmail-user-1', 'newuser@gmail.com');
        expect(preT0External.principal.workspaceId).toMatch(/^user-/);
        const preAccess = await app.inject({
          url: '/v1/billing/access',
          headers: preT0External.headers,
        });
        expect(preAccess.statusCode).toBe(200);
        expect(preAccess.json()).toEqual({
          workspaceId: preT0External.principal.workspaceId,
          recoveryScope: preT0External.headers['x-opengen-recovery-scope'],
          capabilities: { read: false, manage: false, setup: false },
          ownerEnrollment: {
            eligible: false,
            expectedAuthorityVersion: 0,
            terms: {
              version: 'hosted-manual-prepaid-v1-2026-11-11',
              text: 'Prepaid non-recurring Stripe Checkout credit summary.',
            },
            reason: 'terms-inactive',
          },
        });

        // 2. Cross T0 without re-signing in -> ownerEnrollment reports terms-required, POST /v1/billing/owner fails closed (403)
        currentClock = t0Ms + 5_000;
        const missingReceiptAccess = await app.inject({
          url: '/v1/billing/access',
          headers: preT0External.headers,
        });
        expect(missingReceiptAccess.json().ownerEnrollment).toMatchObject({
          eligible: false,
          reason: 'terms-required',
        });
        const missingReceiptEnroll = await app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...preT0External.headers, origin: canonicalOrigin },
          payload: {
            expectedAuthorityVersion: 0,
            termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
            acceptedTerms: true,
          },
        });
        expect(missingReceiptEnroll.statusCode).toBe(403);
        expect(missingReceiptEnroll.json().error.code).toBe('current_human_terms_required');

        // 3. Re-sign in after T0 -> OIDC-verified receipt recorded; ownerEnrollment becomes eligible!
        const externalAdmin = await signInAs('external-gmail-user-1', 'newuser@gmail.com');
        const eligibleAccess = await app.inject({
          url: '/v1/billing/access',
          headers: externalAdmin.headers,
        });
        expect(eligibleAccess.json().ownerEnrollment).toEqual({
          eligible: true,
          expectedAuthorityVersion: 0,
          terms: {
            version: 'hosted-manual-prepaid-v1-2026-11-11',
            text: 'Prepaid non-recurring Stripe Checkout credit summary.',
          },
        });

        // Paused runtime reports checkout-paused and rejects POST /v1/billing/owner with 503
        const pausedAccess = await pausedApp.inject({
          url: '/v1/billing/access',
          headers: externalAdmin.headers,
        });
        expect(pausedAccess.json().ownerEnrollment).toMatchObject({
          eligible: false,
          reason: 'checkout-paused',
        });
        const pausedEnroll = await pausedApp.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...externalAdmin.headers, origin: canonicalOrigin },
          payload: {
            expectedAuthorityVersion: 0,
            termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
            acceptedTerms: true,
          },
        });
        expect(pausedEnroll.statusCode).toBe(503);
        expect(pausedEnroll.json().error.code).toBe('checkout_paused');

        // Rejects API key bearer, wrong Origin, stale recoveryScope, and wrong termsVersion
        const apiKeyRes = await app.inject({
          method: 'POST',
          url: '/v1/keys',
          headers: { ...externalAdmin.headers, origin: canonicalOrigin },
          payload: { name: 'cli-agent', scopes: ['read', 'generate'] },
        });
        expect(apiKeyRes.statusCode, apiKeyRes.body).toBe(201);
        const apiKeyToken = apiKeyRes.json().token as string;
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/billing/owner',
              headers: {
                authorization: `Bearer ${apiKeyToken}`,
                origin: canonicalOrigin,
              },
              payload: {
                expectedAuthorityVersion: 0,
                termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
                acceptedTerms: true,
              },
            })
          ).statusCode,
        ).toBe(401);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/billing/owner',
              headers: { ...externalAdmin.headers, origin: 'https://evil.example' },
              payload: {
                expectedAuthorityVersion: 0,
                termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
                acceptedTerms: true,
              },
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/billing/owner',
              headers: {
                ...externalAdmin.headers,
                'x-opengen-recovery-scope': 'stale-recovery-scope',
                origin: canonicalOrigin,
              },
              payload: {
                expectedAuthorityVersion: 0,
                termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
                acceptedTerms: true,
              },
            })
          ).statusCode,
        ).toBe(409);
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/billing/owner',
              headers: { ...externalAdmin.headers, origin: canonicalOrigin },
              payload: {
                expectedAuthorityVersion: 0,
                termsVersion: 'outdated-terms-v0',
                acceptedTerms: true,
              },
            })
          ).statusCode,
        ).toBe(409);

        // 4. Approve self-serve manual prepaid billing on personal workspace -> writes mr_billing_owners (allowsEnabled: false) + audit row + unlocks live Stripe Checkout!
        const enrolled = await app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...externalAdmin.headers, origin: canonicalOrigin },
          payload: {
            expectedAuthorityVersion: 0,
            termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
            acceptedTerms: true,
          },
        });
        expect(enrolled.statusCode, enrolled.body).toBe(200);
        expect(enrolled.json()).toEqual({
          workspaceId: externalAdmin.principal.workspaceId,
          authorityVersion: 1,
        });

        const ownerRow = (
          await engine.pool.query(
            'SELECT livemode, processor_environment_id, rails, approval_reference FROM mr_billing_owners WHERE workspace_id=$1',
            [externalAdmin.principal.workspaceId],
          )
        ).rows[0];
        expect(ownerRow).toMatchObject({
          livemode: true,
          processor_environment_id: environment.id,
          rails: { allowsEnabled: false, maxAmountCents: 100_000, maxMonthlyCapCents: 100_000 },
        });
        expect(ownerRow.approval_reference).toContain('self-serve-manual-v1:');

        const afterAccess = await app.inject({
          url: '/v1/billing/access',
          headers: externalAdmin.headers,
        });
        expect(afterAccess.json()).toEqual({
          workspaceId: externalAdmin.principal.workspaceId,
          recoveryScope: externalAdmin.headers['x-opengen-recovery-scope'],
          capabilities: { read: true, manage: true, setup: true },
        });

        const personalOrder = await app.inject({
          method: 'POST',
          url: '/v1/billing/orders',
          headers: {
            ...externalAdmin.headers,
            origin: canonicalOrigin,
            'idempotency-key': 'external-personal-topup-1',
          },
          payload: { amountCents: 1000 },
        });
        expect(personalOrder.statusCode, personalOrder.body).toBe(201);
        const personalCheckout = await app.inject({
          method: 'POST',
          url: `/v1/billing/orders/${personalOrder.json().id}/checkout`,
          headers: { ...externalAdmin.headers, origin: canonicalOrigin },
          payload: {},
        });
        expect(personalCheckout.statusCode, personalCheckout.body).toBe(200);
        expect(personalCheckout.json().status).toBe('checkout_open');
        expect(checkoutCreate).toHaveBeenCalledOnce();

        // 5. Team workspace: non-admin member gets admin-required; second admin sees owner-already-active after first admin enrolls!
        const createdTeam = await engine.accounts.createTeam(
          externalAdmin.principal,
          'External Studio Team',
        );
        const teamId = createdTeam.id;
        expect(teamId).toMatch(/^team-/);

        const teammate = await signInAs('external-teammate-2', 'member@gmail.com');
        const secondAdmin = await signInAs('external-co-admin-3', 'coadmin@gmail.com');
        await engine.pool.query(
          "INSERT INTO mr_memberships(id,workspace_id,issuer,subject,role,accepted_at) VALUES($1,$2,$3,'external-teammate-2','member',now()),($4,$2,$3,'external-co-admin-3','admin',now())",
          [randomUUID(), teamId, issuer, randomUUID()],
        );

        const switchToTeam = async (userHeaders: Record<string, string>) => {
          const switched = await app.inject({
            method: 'POST',
            url: '/v1/session/workspace',
            headers: { ...userHeaders, origin: canonicalOrigin },
            payload: { workspaceId: teamId },
          });
          expect(switched.statusCode, switched.body).toBe(200);
          const body = switched.json() as { workspaceId: string; recoveryScope: string };
          return {
            cookie: userHeaders.cookie!,
            headers: {
              cookie: userHeaders.cookie!,
              'x-opengen-workspace': body.workspaceId,
              'x-opengen-recovery-scope': body.recoveryScope,
            },
          };
        };

        const teamMemberSession = await switchToTeam(teammate.headers);
        const memberAccess = await app.inject({
          url: '/v1/billing/access',
          headers: teamMemberSession.headers,
        });
        expect(memberAccess.json().ownerEnrollment).toMatchObject({
          eligible: false,
          reason: 'admin-required',
        });
        expect(
          (
            await app.inject({
              method: 'POST',
              url: '/v1/billing/owner',
              headers: { ...teamMemberSession.headers, origin: canonicalOrigin },
              payload: {
                expectedAuthorityVersion: 0,
                termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
                acceptedTerms: true,
              },
            })
          ).statusCode,
        ).toBe(403);

        const teamAdmin1 = await switchToTeam(externalAdmin.headers);
        const teamEnrolled = await app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...teamAdmin1.headers, origin: canonicalOrigin },
          payload: {
            expectedAuthorityVersion: 0,
            termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
            acceptedTerms: true,
          },
        });
        expect(teamEnrolled.statusCode, teamEnrolled.body).toBe(200);

        const teamAdmin2 = await switchToTeam(secondAdmin.headers);
        const secondAdminAccess = await app.inject({
          url: '/v1/billing/access',
          headers: teamAdmin2.headers,
        });
        expect(secondAdminAccess.json().ownerEnrollment).toMatchObject({
          eligible: false,
          expectedAuthorityVersion: 1,
          reason: 'owner-already-active',
        });
        const hijackAttempt = await app.inject({
          method: 'POST',
          url: '/v1/billing/owner',
          headers: { ...teamAdmin2.headers, origin: canonicalOrigin },
          payload: {
            expectedAuthorityVersion: 1,
            termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
            acceptedTerms: true,
          },
        });
        expect(hijackAttempt.statusCode).toBe(409);
        expect(hijackAttempt.json().error.code).toBe('billing_owner_already_active');

        // 6. Auto-recharge activation: existing manual owner upgrades while preserving approval_reference, new user enrolls with allowsEnabled: true, and operator /v1/operator/billing/work ticks cleanly!
        const operatorBearer = 'synthetic-live-recharge-operator-bearer-token-2026';
        const rechargeConfig = readBillingManualConfiguration({
          NODE_ENV: 'production',
          OPENGEN_BILLING_MANUAL: 'true',
          OPENGEN_BILLING_SANDBOX: 'false',
          STRIPE_LIVEMODE: 'true',
          DATABASE_URL: 'postgresql://localhost/opengen_live_fixture',
          OPENGEN_PUBLIC_URL: canonicalOrigin,
          OPENGEN_BILLING_MANUAL_WORKSPACE: operatorPrincipal.workspaceId,
          OPENGEN_BILLING_CHECKOUT: 'open',
          OPENGEN_BILLING_RECHARGE: 'open',
          OPENGEN_BILLING_PUBLISHABLE_KEY: 'pk_live_syntheticAutoRechargeKey123',
          OPENGEN_BILLING_PORTAL_CONFIGURATION: 'bpc_syntheticPortalConfig123',
          OPENGEN_BILLING_OPERATOR_BEARER: operatorBearer,
          OPENGEN_BILLING_PROCESSOR_ENVIRONMENT: environment.id,
          OPENGEN_BILLING_PROCESSOR_ACCOUNT: environment.accountId,
          OPENGEN_BILLING_APPROVAL_REFERENCE: approvalReference,
          OPENGEN_BILLING_TERMS_VERSION: 'hosted-manual-prepaid-v1-2026-11-11',
          OPENGEN_BILLING_TERMS_TEXT: 'Prepaid non-recurring Stripe Checkout credit summary.',
          STRIPE_SECRET_KEY: ['rk', 'live', 'syntheticfixture'].join('_'),
          STRIPE_WEBHOOK_SECRET: ['whsec', 'syntheticfixture'].join('_'),
        })!;
        const rechargeRuntime = await hostedBillingManual(engine.pool, rechargeConfig, stripe, {
          humanTermsPolicy,
        });
        const rechargeApp = await buildApp({
          publicUrl: canonicalOrigin,
          engine,
          humanTermsPolicy,
          billingRuntime: rechargeRuntime,
          env: {
            NODE_ENV: 'test',
            OPENGEN_PUBLIC_URL: canonicalOrigin,
            OIDC_ISSUER: issuer,
            OIDC_CLIENT_ID: 'client-fixture',
            OIDC_CLIENT_SECRET: 'synthetic-server-secret',
            MR_SESSION_SECRET: 's'.repeat(32),
          },
        });
        try {
          const teamOwnerBefore = (
            await engine.pool.query(
              'SELECT approval_reference FROM mr_billing_owners WHERE workspace_id=$1',
              [teamId],
            )
          ).rows[0];
          const upgradeAccess = await rechargeApp.inject({
            url: '/v1/billing/access',
            headers: teamAdmin1.headers,
          });
          expect(upgradeAccess.statusCode).toBe(200);
          expect(upgradeAccess.json()).toMatchObject({
            workspaceId: teamId,
            capabilities: { read: true, manage: true, setup: true },
            ownerEnrollment: {
              eligible: true,
              expectedAuthorityVersion: 1,
              allowsAutoRecharge: true,
              upgradeToRecharge: true,
            },
          });

          const upgraded = await rechargeApp.inject({
            method: 'POST',
            url: '/v1/billing/owner',
            headers: { ...teamAdmin1.headers, origin: canonicalOrigin },
            payload: {
              expectedAuthorityVersion: 1,
              termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
              acceptedTerms: true,
            },
          });
          expect(upgraded.statusCode, upgraded.body).toBe(200);
          expect(upgraded.json()).toEqual({
            workspaceId: teamId,
            authorityVersion: 2,
          });
          const upgradedRow = (
            await engine.pool.query(
              'SELECT rails, approval_reference FROM mr_billing_owners WHERE workspace_id=$1',
              [teamId],
            )
          ).rows[0];
          expect(upgradedRow.rails.allowsEnabled).toBe(true);
          expect(upgradedRow.approval_reference).toBe(teamOwnerBefore.approval_reference);

          const postUpgradeAccess = await rechargeApp.inject({
            url: '/v1/billing/access',
            headers: teamAdmin1.headers,
          });
          expect(postUpgradeAccess.json().ownerEnrollment).toBeUndefined();

          const policyView = await rechargeApp.inject({
            url: '/v1/billing/policy',
            headers: teamAdmin1.headers,
          });
          expect(policyView.statusCode, policyView.body).toBe(200);
          expect(policyView.json()).toMatchObject({
            setupAvailable: true,
            automaticRechargeAvailable: true,
            portalAvailable: true,
            recoveryAvailable: true,
            ownerAuthorityVersion: 2,
          });

          // New external user enrolls directly with allowsEnabled: true
          const freshUser = await signInAs('external-recharge-user-4', 'fresh@gmail.com');
          const freshEnrolled = await rechargeApp.inject({
            method: 'POST',
            url: '/v1/billing/owner',
            headers: { ...freshUser.headers, origin: canonicalOrigin },
            payload: {
              expectedAuthorityVersion: 0,
              termsVersion: 'hosted-manual-prepaid-v1-2026-11-11',
              acceptedTerms: true,
            },
          });
          expect(freshEnrolled.statusCode, freshEnrolled.body).toBe(200);
          const freshRow = (
            await engine.pool.query('SELECT rails FROM mr_billing_owners WHERE workspace_id=$1', [
              freshUser.principal.workspaceId,
            ])
          ).rows[0];
          expect(freshRow.rails.allowsEnabled).toBe(true);

          // Operator billing work endpoint requires operator bearer
          expect(
            (await rechargeApp.inject({ method: 'POST', url: '/v1/operator/billing/work' }))
              .statusCode,
          ).toBe(403);
          const tick = await rechargeApp.inject({
            method: 'POST',
            url: '/v1/operator/billing/work',
            headers: { authorization: `Bearer ${operatorBearer}` },
            payload: {},
          });
          expect(tick.statusCode, tick.body).toBe(200);
          expect(tick.json()).toEqual({ ok: true });
        } finally {
          await rechargeApp.close();
        }
      } finally {
        await engine.close();
        await isolated.close();
      }
    });
  },
);
