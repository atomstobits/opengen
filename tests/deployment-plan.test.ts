import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../infra/deploy-gcp.sh', import.meta.url));
const billingConfigurationNames = [
  'OPENGEN_BILLING_MANUAL',
  'OPENGEN_BILLING_CHECKOUT',
  'OPENGEN_BILLING_PROCESSOR_ENVIRONMENT',
  'OPENGEN_BILLING_PROCESSOR_ACCOUNT',
  'OPENGEN_BILLING_MANUAL_WORKSPACE',
  'OPENGEN_BILLING_APPROVAL_REFERENCE',
  'OPENGEN_BILLING_TERMS_VERSION',
  'OPENGEN_BILLING_TERMS_TEXT',
  'OPENGEN_BILLING_OPERATOR_BEARER',
  'OPENGEN_BILLING_SANDBOX',
  'OPENGEN_BILLING_SANDBOX_WORKSPACE',
] as const;
let toolsPath: string;
beforeAll(() => {
  toolsPath = mkdtempSync(join(tmpdir(), 'opengen-deployment-plan-'));
  // Even an accidental gcloud invocation during these dry-run tests cannot reach GCP.
  writeFileSync(
    join(toolsPath, 'gcloud'),
    '#!/bin/sh\necho "Forbidden cloud invocation in plan test" >&2\nexit 99\n',
    { mode: 0o755 },
  );
});
afterAll(() => rmSync(toolsPath, { recursive: true, force: true }));

function plan(overrides: NodeJS.ProcessEnv = {}, explicit = true) {
  const env: NodeJS.ProcessEnv = {
    PATH: `${toolsPath}:${dirname(process.execPath)}:/usr/bin:/bin`,
    OPENGEN_PROJECT_ID: 'fixture-project',
    OPENGEN_REGION: 'us-central1',
    OPENGEN_PUBLIC_URL: 'https://opengen.example',
    OPENGEN_API_IMAGE: `us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:${'a'.repeat(64)}`,
    OPENGEN_API_RUNTIME_SA: 'opengen-api@fixture-project.iam.gserviceaccount.com',
    OPENGEN_WORKER_RUNTIME_SA: 'opengen-worker@fixture-project.iam.gserviceaccount.com',
    OPENGEN_CLOUDSQL_CONNECTION: 'fixture-project:us-central1:fixture-db',
    OPENGEN_DATABASE_SECRET: 'database-url',
    OPENGEN_API_TOKEN_SECRET: 'installation-token',
    OPENGEN_SECRET_VERSION: '7',
    OPENGEN_EXECUTION_SCOPE: 'unrestricted',
    OPENGEN_PROVIDER_SECRET_BINDINGS:
      'FAL_KEY=fal-key:2,MR_VAULT_KEY=vault-master:3,AWS_ACCESS_KEY_ID=storage-access:4,AWS_SECRET_ACCESS_KEY=storage-secret:4',
    OPENGEN_API_SECRET_BINDINGS:
      'MR_SESSION_SECRET=session-only:7,OIDC_ISSUER=idp-issuer:2,OIDC_CLIENT_ID=idp-client-id:3,OIDC_CLIENT_SECRET=idp-secret:9,STRIPE_SECRET_KEY=stripe-only:4,STRIPE_WEBHOOK_SECRET=stripe-webhook-only:4',
    ...overrides,
  };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  return spawnSync('/bin/bash', [script, ...(explicit ? ['--plan'] : [])], {
    env,
    encoding: 'utf8',
  });
}

describe('review-only GCP deployment plans', () => {
  it('defaults to a plan with the canonical public origin and separate least-privilege identities', () => {
    const result = plan({}, false);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.split('\n');
    const api = lines.find((line) => line.startsWith('gcloud run deploy opengen-api'))!;
    const worker = lines.find((line) =>
      line.startsWith('gcloud run worker-pools deploy opengen-worker'),
    )!;
    expect(api).toContain('--service-account opengen-api@fixture-project.iam.gserviceaccount.com');
    expect(worker).toContain(
      '--service-account opengen-worker@fixture-project.iam.gserviceaccount.com',
    );
    for (const command of [api, worker]) {
      expect(command).toContain('OPENGEN_PUBLIC_URL=https://opengen.example');
      expect(command).toContain('DATABASE_URL=database-url:7');
      expect(command).toContain('MR_DATABASE_POOL_SIZE=4');
      expect(command).toContain('OPENGEN_PROVIDER_EXECUTION_ENABLED=true');
      expect(command).toContain('OPENGEN_EXECUTION_SCOPE=unrestricted');
      expect(command).toContain('--set-cloudsql-instances fixture-project:us-central1:fixture-db');
      expect(command).toContain('FAL_KEY=fal-key:2');
      expect(command).toContain('MR_VAULT_KEY=vault-master:3');
      expect(command).toContain('AWS_SECRET_ACCESS_KEY=storage-secret:4');
      expect(command).toContain(`@sha256:${'a'.repeat(64)}`);
    }
    for (const binding of [
      'MR_API_TOKEN=installation-token:7',
      'MR_SESSION_SECRET=session-only:7',
      'OIDC_CLIENT_SECRET=idp-secret:9',
      'STRIPE_SECRET_KEY=stripe-only:4',
      'STRIPE_WEBHOOK_SECRET=stripe-webhook-only:4',
    ]) {
      expect(api).toContain(binding);
      expect(worker).not.toContain(binding);
    }
    expect(api).toContain('STRIPE_LIVEMODE=false');
    expect(api).toContain('--execution-environment gen2');
    expect(api).toContain('--invoker-iam-check');
    expect(api).toContain('--no-allow-unauthenticated');
    expect(worker).not.toMatch(/MR_API_TOKEN|MR_SESSION_SECRET|OIDC_|STRIPE_/);
    expect(result.stdout).toContain('No cloud mutation performed.');
  });

  it('passes the same nonsecret provider-execution boolean to API and worker', () => {
    for (const value of [undefined, 'true', 'false']) {
      const result = plan({ OPENGEN_PROVIDER_EXECUTION_ENABLED: value });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        const [environment, secrets] = command.split('--set-secrets');
        expect(environment).toContain(`OPENGEN_PROVIDER_EXECUTION_ENABLED=${value ?? 'true'}`);
        expect(secrets).not.toContain('OPENGEN_PROVIDER_EXECUTION_ENABLED');
      }
    }
  });

  it('pins the same explicit scope and optional first-frame digest on API and worker', () => {
    for (const pin of [undefined, 'a'.repeat(64), 'B'.repeat(64)]) {
      const result = plan({
        OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: pin,
      });
      expect(result.status).toBe(0);
      const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        const [environment, secrets] = command.split('--set-secrets');
        expect(environment).toContain('OPENGEN_EXECUTION_SCOPE=qualification-sg-v1');
        if (pin) expect(environment).toContain(`OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256=${pin}`);
        else expect(environment).not.toContain('OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256');
        expect(secrets).not.toMatch(
          /OPENGEN_EXECUTION_SCOPE|OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256/,
        );
      }
    }
  });

  it('rejects omitted or invalid scopes, pins and secret aliases before cloud commands', () => {
    const cases: NodeJS.ProcessEnv[] = [
      ...[undefined, '', 'qualified', 'qualification-sg-v1,HOST=wrong'].map((scope) => ({
        OPENGEN_EXECUTION_SCOPE: scope,
      })),
      ...['', 'not-a-digest', 'a'.repeat(63), 'a'.repeat(65)].map((pin) => ({
        OPENGEN_EXECUTION_SCOPE: 'qualification-sg-v1',
        OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: pin,
      })),
      { OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256: 'a'.repeat(64) },
    ];
    for (const name of ['OPENGEN_EXECUTION_SCOPE', 'OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256']) {
      cases.push({ OPENGEN_PROVIDER_SECRET_BINDINGS: `${name}=scope-control:1` });
      cases.push({ OPENGEN_API_SECRET_BINDINGS: `${name}=scope-control:1` });
    }
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
      expect(result.stderr).not.toContain('HOST=wrong');
    }
  });

  it('rejects invalid provider-execution controls and secret aliases before any cloud command', () => {
    const cases: NodeJS.ProcessEnv[] = [
      '',
      'FALSE',
      'False',
      '0',
      '1',
      'yes',
      ' false',
      'false ',
      'false,HOST=wrong',
      'false\nHOST=wrong',
    ].map((value) => ({ OPENGEN_PROVIDER_EXECUTION_ENABLED: value }));
    for (const name of [
      'OPENGEN_PROVIDER_EXECUTION_ENABLED',
      'OPENGEN_PROVIDER_EXECUTION_UNKNOWN',
    ]) {
      cases.push({ OPENGEN_PROVIDER_SECRET_BINDINGS: `${name}=runtime-control:2` });
      cases.push({ OPENGEN_API_SECRET_BINDINGS: `${name}=runtime-control:2` });
    }
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
      expect(result.stderr).not.toContain('HOST=wrong');
    }
  });

  it('binds scoped billing controls and terms through pinned API-only references without serializing values', () => {
    const bindings = billingConfigurationNames.map(
      (name, index) => `${name}=billing-config-${index}:5`,
    );
    const inlineTerms = 'fixture-only private terms, second clause\nthird clause';
    const result = plan({
      OPENGEN_API_SECRET_BINDINGS: bindings.join(','),
      // The planner must not read/serialize config payloads from its own environment.
      OPENGEN_BILLING_TERMS_TEXT: inlineTerms,
      OPENGEN_BILLING_OPERATOR_BEARER: 'fixture-only-private-operator-value',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
    expect(commands).toHaveLength(2);
    const [api, worker] = commands as [string, string];
    const [apiEnvironment, apiSecrets] = api.split('--set-secrets');
    for (const [index, name] of billingConfigurationNames.entries()) {
      expect(apiSecrets).toContain(bindings[index]);
      expect(apiEnvironment).not.toContain(name);
      expect(worker).not.toContain(name);
      expect(worker).not.toContain(`billing-config-${index}:5`);
    }
    expect(worker).not.toContain('OPENGEN_BILLING_');
    expect(result.stdout).not.toContain(inlineTerms);
    expect(result.stdout).not.toContain('fixture-only private terms');
    expect(result.stdout).not.toContain('fixture-only-private-operator-value');
    expect(result.stdout).toContain('No cloud mutation performed.');
  });

  it('binds hosted legal publication JSON through a pinned API-only reference and rejects worker or bare-flag aliases', () => {
    const inlinePublication = '{"schemaVersion":1,"canonicalOrigin":"https://opengen.dev"}';
    const result = plan({
      OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_LEGAL_PUBLICATION_JSON=legal-publication-config:3',
      OPENGEN_LEGAL_PUBLICATION_JSON: inlinePublication,
      OPENGEN_LEGAL_PUBLICATION_FILE: '/tmp/fixture-legal-publication.json',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
    expect(commands).toHaveLength(2);
    const [api, worker] = commands as [string, string];
    const [apiEnvironment, apiSecrets] = api.split('--set-secrets');
    expect(apiSecrets).toContain('OPENGEN_LEGAL_PUBLICATION_JSON=legal-publication-config:3');
    expect(apiEnvironment).not.toContain('OPENGEN_LEGAL_');
    expect(worker).not.toContain('OPENGEN_LEGAL_');
    expect(worker).not.toContain('legal-publication-config:3');
    expect(result.stdout).not.toContain(inlinePublication);
    expect(result.stdout).not.toContain('/tmp/fixture-legal-publication.json');

    for (const settings of [
      {
        OPENGEN_PROVIDER_SECRET_BINDINGS:
          'OPENGEN_LEGAL_PUBLICATION_JSON=legal-publication-config:3',
      },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_LEGAL_PUBLICATION_FILE=legal-publication-config:3' },
      {
        OPENGEN_PROVIDER_SECRET_BINDINGS:
          'OPENGEN_LEGAL_PUBLICATION_FILE=legal-publication-config:3',
      },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_LEGAL_ACTIVE=legal-publication-config:3' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'OPENGEN_LEGAL_ACTIVE=legal-publication-config:3' },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_LEGAL_PUBLICATION_JSON=vault-master:12' },
      {
        OPENGEN_API_SECRET_BINDINGS:
          'OPENGEN_LEGAL_PUBLICATION_JSON=legal-publication-config:latest',
      },
    ] satisfies NodeJS.ProcessEnv[]) {
      const rejected = plan(settings);
      expect(rejected.status).toBe(2);
      expect(rejected.stdout).not.toContain('gcloud');
      expect(rejected.stderr).not.toContain('Forbidden cloud invocation');
    }
  });

  it('rejects scoped billing worker bindings, shared secret aliases and unreviewed configuration names', () => {
    const cases: NodeJS.ProcessEnv[] = billingConfigurationNames.flatMap((name) => [
      { OPENGEN_PROVIDER_SECRET_BINDINGS: `${name}=billing-config:5` },
      // A different version of the same shared secret still leaks its role boundary.
      { OPENGEN_API_SECRET_BINDINGS: `${name}=vault-master:12` },
      {
        OPENGEN_API_SECRET_BINDINGS: `${name}=billing-config:5`,
        OPENGEN_PROVIDER_SECRET_BINDINGS: 'FAL_KEY=billing-config:8',
      },
    ]);
    cases.push(
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_BILLING_UNREVIEWED=billing-config:5' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'OPENGEN_BILLING_UNREVIEWED=billing-config:5' },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_BILLING_TERMS_TEXT=billing-config:latest' },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_BILLING_MANUAL=billing-config:0' },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_BILLING_TERMS_TEXT=fixture-private-terms, clause' },
      { OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_BILLING_TERMS_TEXT=fixture-private-terms\nclause' },
      {
        OPENGEN_API_SECRET_BINDINGS:
          'OPENGEN_BILLING_CHECKOUT=first:2,OPENGEN_BILLING_CHECKOUT=second:3',
      },
    );
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status, Object.keys(settings).join(',')).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('fixture-private-terms');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
    }
  });

  it('accepts an explicit canonical HTTPS origin with a nondefault port without changing its authority', () => {
    const result = plan({ OPENGEN_PUBLIC_URL: 'https://self-hosted.example:8443' });
    expect(result.status).toBe(0);
    expect(result.stdout.split('OPENGEN_PUBLIC_URL=https://self-hosted.example:8443')).toHaveLength(
      3,
    );
  });

  it('rejects missing or malformed public origins before rendering deployment commands', () => {
    for (const value of [
      undefined,
      'http://opengen.example',
      'https://localhost',
      'https://private.internal',
      'https://user:password@opengen.example',
      'https://opengen.example/',
      'https://opengen.example/path',
      'https://opengen.example?token=private',
      'https://opengen.example#fragment',
      'https://opengen.example,HOST=wrong',
      'https://opengen.example:99999',
    ]) {
      const result = plan({ OPENGEN_PUBLIC_URL: value });
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('user:password');
      expect(result.stderr).not.toContain('token=private');
    }
  });

  it('rejects unpinned or malformed secret references, inline values, duplicates and role leaks', () => {
    const cases: NodeJS.ProcessEnv[] = [
      { OPENGEN_SECRET_VERSION: 'latest' },
      { OPENGEN_DATABASE_SECRET: 'database-url:latest' },
      { OPENGEN_API_TOKEN_SECRET: 'token,OTHER=value' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'FAL_KEY=fal-key:latest' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'FAL_KEY=fal-key:0' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'DATABASE_URL=override:1' },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'FAL_KEY=first:1,FAL_KEY=second:2' },
      { OPENGEN_API_SECRET_BINDINGS: 'STRIPE_SECRET_KEY=inline-private-value-do-not-echo' },
      { OPENGEN_API_SECRET_BINDINGS: 'STRIPE_SECRET_KEY=stripe-key:latest' },
      { OPENGEN_API_SECRET_BINDINGS: 'MR_SESSION_SECRET=first:1,MR_SESSION_SECRET=second:2' },
      { OPENGEN_API_SECRET_BINDINGS: 'FAL_KEY=provider-in-wrong-binding:1' },
      { OPENGEN_API_SECRET_BINDINGS: 'STRIPE_SECRET_KEY=fal-key:3' },
      { OPENGEN_API_TOKEN_SECRET: 'database-url' },
      ...[
        'MR_API_TOKEN',
        'MR_SESSION_SECRET',
        'MR_DATABASE_POOL_SIZE',
        'OIDC_CLIENT_SECRET',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'STRIPE_LIVEMODE',
        'OPENGEN_PUBLIC_URL',
      ].map((name) => ({ OPENGEN_PROVIDER_SECRET_BINDINGS: `${name}=api-only:1` })),
    ];
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status, Object.keys(settings).join(', ')).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('inline-private-value-do-not-echo');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
    }
  });

  it('refuses a shared or non-service runtime identity and preserves immutable-image and mode guards', () => {
    for (const settings of [
      { OPENGEN_WORKER_RUNTIME_SA: 'opengen-api@fixture-project.iam.gserviceaccount.com' },
      { OPENGEN_API_RUNTIME_SA: 'operator@example.com' },
      { OPENGEN_WORKER_RUNTIME_SA: undefined },
      { OPENGEN_API_IMAGE: 'us-central1-docker.pkg.dev/fixture-project/opengen/api:latest' },
      {
        OPENGEN_API_IMAGE:
          'us-central1-docker.pkg.dev/fixture-project/opengen/api@sha256:placeholder',
      },
      { OPENGEN_REGION: 'us-central1,HOST=wrong' },
      { OPENGEN_CLOUDSQL_CONNECTION: 'postgresql://not-an-instance-identifier' },
      { STRIPE_LIVEMODE: 'yes' },
    ]) {
      const result = plan(settings);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
    }
  });

  it('forwards explicit safe input retention identically to both roles and leaves blank defaults unset', () => {
    for (const value of [undefined, '']) {
      const result = plan({ MR_INPUT_RETENTION_MS: value });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('MR_INPUT_RETENTION_MS=');
      expect(result.stdout).not.toContain('OPENGEN_NOTIFICATION_EMAIL_');
    }
    for (const value of ['60000', '604800000']) {
      const result = plan({ MR_INPUT_RETENTION_MS: value });
      expect(result.status).toBe(0);
      const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
      expect(commands).toHaveLength(2);
      for (const command of commands) expect(command).toContain(`MR_INPUT_RETENTION_MS=${value}`);
    }
  });

  it('refuses invalid retention and runtime-control secret aliases before rendering cloud commands', () => {
    const values = [
      '0',
      '59999',
      '60000.5',
      '1e6',
      '060000',
      'NaN',
      'Infinity',
      '-60000',
      '9007199254740992',
      ' 60000',
      '60000,HOST=wrong',
      '60000\nHOST=wrong',
    ];
    const cases: NodeJS.ProcessEnv[] = values.map((value) => ({ MR_INPUT_RETENTION_MS: value }));
    for (const name of [
      'MR_INPUT_RETENTION_MS',
      'OPENGEN_NOTIFICATION_EMAIL_ENDPOINT',
      'OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED',
    ])
      cases.push({ OPENGEN_PROVIDER_SECRET_BINDINGS: `${name}=runtime-config:3` });
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      expect(result.stderr).not.toContain('Forbidden cloud invocation');
    }
  });

  it('configures optional operational email for both server roles with pinned shared auth only', () => {
    const endpoint = 'https://relay.example/v1/notifications';
    const auth = 'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=notification-relay-auth:9';
    const result = plan({
      MR_INPUT_RETENTION_MS: '604800000',
      OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
      OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED: '1',
      OPENGEN_PROVIDER_SECRET_BINDINGS: `FAL_KEY=fal-key:2,MR_VAULT_KEY=vault-master:3,${auth}`,
    });
    expect(result.status).toBe(0);
    const commands = result.stdout.split('\n').filter((line) => line.startsWith('gcloud '));
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain(`OPENGEN_NOTIFICATION_EMAIL_ENDPOINT=${endpoint}`);
      expect(command).toContain('OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED=1');
      expect(command).toContain(auth);
      expect(command.split('--set-secrets')[0]).not.toContain(
        'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN',
      );
    }
    const unauthenticatedRelay = plan({ OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint });
    expect(unauthenticatedRelay.status).toBe(0);
    expect(unauthenticatedRelay.stdout).toContain(
      'OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED=0',
    );
    expect(unauthenticatedRelay.stdout).not.toContain('OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=');
  });

  it('rejects malformed or credential-bearing email configuration without echoing values or contacting cloud', () => {
    const endpoint = 'https://relay.example/v1/notifications';
    const invalidEndpoints = [
      'http://relay.example/send',
      'https://localhost/send',
      'https://private.internal/send',
      'https://127.0.0.1/send',
      'https://[::1]/send',
      'https://relay.example:8443/send',
      'https://user:private-password@relay.example/send',
      'https://relay.example/send?token=private-query',
      'https://relay.example/send#private-fragment',
      'https://relay.example/send,HOST=wrong',
      ' https://relay.example/send',
    ];
    const cases: NodeJS.ProcessEnv[] = invalidEndpoints.map((value) => ({
      OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: value,
    }));
    cases.push(
      { OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED: '1' },
      ...['true', 'false', 'yes', '2', '01'].map((value) => ({
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED: value,
      })),
      {
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN: 'inline-private-email-token-do-not-echo',
      },
      { OPENGEN_PROVIDER_SECRET_BINDINGS: 'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=relay-auth:9' },
      {
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_API_SECRET_BINDINGS: 'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=relay-auth:9',
      },
      {
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_PROVIDER_SECRET_BINDINGS: 'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=relay-auth:latest',
      },
      {
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_PROVIDER_SECRET_BINDINGS:
          'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=inline-private-email-token-do-not-echo',
      },
      {
        OPENGEN_NOTIFICATION_EMAIL_ENDPOINT: endpoint,
        OPENGEN_PROVIDER_SECRET_BINDINGS: 'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN=stripe-only:9',
      },
    );
    for (const settings of cases) {
      const result = plan(settings);
      expect(result.status, Object.keys(settings).join(',')).toBe(2);
      expect(result.stdout).not.toContain('gcloud');
      for (const value of [
        'inline-private-email-token-do-not-echo',
        'private-password',
        'private-query',
        'private-fragment',
        'Forbidden cloud invocation',
      ])
        expect(result.stderr).not.toContain(value);
    }
  });

  it('keeps local runtime configuration private and payment configuration API-only', () => {
    const compose = readFileSync(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
    const shared = compose.split('\nservices:')[0]!;
    const api = compose.split('\n  api:')[1]!.split('\n  worker:')[0]!;
    const worker = compose.split('\n  worker:')[1]!.split('\n  web:')[0]!;
    const web = compose.split('\n  web:')[1]!;
    for (const name of [
      'MR_INPUT_RETENTION_MS',
      'OPENGEN_NOTIFICATION_EMAIL_ENDPOINT',
      'OPENGEN_NOTIFICATION_EMAIL_AUTH_TOKEN',
    ]) {
      expect(shared).toContain(`${name}: \${${name}:-}`);
      expect(web).not.toContain(name);
    }
    expect(shared).toContain(
      'OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED: ${OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED:-0}',
    );
    expect(web).not.toContain('OPENGEN_NOTIFICATION_EMAIL_IDEMPOTENCY_CONFIRMED');
    for (const role of [api, worker]) {
      expect(role).toContain('<<: *provider-env');
      expect(role).toContain('OPENGEN_PUBLIC_URL: ${OPENGEN_PUBLIC_URL:-http://127.0.0.1:4320}');
    }
    expect(web).not.toContain('*provider-env');
    expect(shared).toContain(
      'OPENGEN_PROVIDER_EXECUTION_ENABLED: ${OPENGEN_PROVIDER_EXECUTION_ENABLED-true}',
    );
    expect(shared).toContain('OPENGEN_EXECUTION_SCOPE: ${OPENGEN_EXECUTION_SCOPE-unrestricted}');
    expect(shared).toMatch(/^  OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256:\s*$/m);
    expect(web).not.toContain('OPENGEN_PROVIDER_EXECUTION_ENABLED');
    expect(web).not.toMatch(/OPENGEN_EXECUTION_SCOPE|OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256/);
    const example = readFileSync(new URL('../infra/opengen.env.example', import.meta.url), 'utf8');
    expect(example).toContain('OPENGEN_PROVIDER_EXECUTION_ENABLED=true');
    expect(example).toContain('OPENGEN_EXECUTION_SCOPE=qualification-sg-v1');
    expect(example).toContain('Set false for a dedicated payment sandbox.');
    for (const [name, fallback] of [
      ['STRIPE_SECRET_KEY', ''],
      ['STRIPE_WEBHOOK_SECRET', ''],
      ['STRIPE_LIVEMODE', 'false'],
    ]) {
      expect(api).toContain(`${name}: \${${name}:-${fallback}}`);
      for (const role of [shared, worker, web]) expect(role).not.toContain(name);
    }
    for (const name of billingConfigurationNames) {
      const fallback =
        name === 'OPENGEN_BILLING_MANUAL' || name === 'OPENGEN_BILLING_SANDBOX'
          ? 'false'
          : name === 'OPENGEN_BILLING_CHECKOUT'
            ? 'paused'
            : '';
      expect(api).toContain(`${name}: \${${name}:-${fallback}}`);
      for (const role of [shared, worker, web]) expect(role).not.toContain(name);
    }
  });
});
