import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenGen, JobWaitTimeoutError, SubmissionUncertainError } from '@media-router/sdk';
import type { Job } from '@media-router/contracts';
import { runCommand, serializeCommandError } from '../apps/cli/src/index';

const baseUrl = 'https://gateway.example';
const job = {
  id: 'b2cb1884-0146-4567-8c0c-895d960a916f',
  status: 'succeeded',
  deliveryStatus: 'failed',
  upstreamId: 'upstream-existing',
  settledMicros: null,
  reservedMicros: 500,
  outputs: [],
} as unknown as Job;

describe('read-only first run and structured recovery', () => {
  it('validates the bare command and environment token with GET instead of declaring a token connected', async () => {
    const seen: string[] = [];
    for (const status of [401, 403, 503]) {
      const result = await runCommand([], {
        env: { MEDIA_ROUTER_URL: baseUrl, MEDIA_ROUTER_TOKEN: 'fixture-private-value' },
        request: async (url, init) => {
          seen.push(`${init?.method} ${new URL(String(url)).pathname}`);
          expect(new Headers(init?.headers).get('Authorization')).toBe(
            'Bearer fixture-private-value',
          );
          return Response.json(
            {
              error: {
                code: status === 403 ? 'insufficient_scope' : 'unauthorized',
                message: 'private response intentionally not relayed',
              },
            },
            { status },
          );
        },
      });
      expect(result).toMatchObject({
        credentialPresent: true,
        authenticated: status === 403,
        authorized: false,
      });
      expect(JSON.stringify(result)).not.toContain('fixture-private-value');
      expect(JSON.stringify(result)).not.toContain('private response');
    }
    expect(seen).toEqual(['GET /v1/doctor', 'GET /v1/doctor', 'GET /v1/doctor']);
  });

  it('does not refresh or rewrite an expired private profile during doctor', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opengen-readonly-status-'));
    const profilePath = join(directory, 'auth.json');
    const original = JSON.stringify({
      version: 1,
      baseUrl,
      issuer: baseUrl,
      resource: `${baseUrl}/mcp`,
      clientId: 'fixture',
      workspaceId: 'studio',
      scope: 'read generate',
      accessToken: `og_mcp_a_${'a'.repeat(43)}`,
      refreshToken: `og_mcp_r_${'r'.repeat(43)}`,
      expiresAt: new Date(0).toISOString(),
    });
    await writeFile(profilePath, original, { mode: 0o600 });
    try {
      const result = await runCommand(['doctor'], {
        env: { MEDIA_ROUTER_URL: baseUrl },
        profilePath,
        request: async (url, init) => {
          expect(init?.method).toBe('GET');
          expect(new URL(String(url)).pathname).toBe('/v1/doctor');
          return Response.json(
            { error: { code: 'unauthorized', message: 'Expired.' } },
            { status: 401 },
          );
        },
      });
      expect(result).toMatchObject({ credentialPresent: true, authenticated: false });
      expect(await readFile(profilePath, 'utf8')).toBe(original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not mistake an ingress 403 for validated authentication', async () => {
    const result = await runCommand(['doctor'], {
      env: { MEDIA_ROUTER_URL: baseUrl, MEDIA_ROUTER_TOKEN: 'fixture-private-value' },
      request: async () => new Response('Forbidden by an upstream proxy.', { status: 403 }),
    });
    expect(result).toMatchObject({
      credentialPresent: true,
      connected: false,
      authenticated: false,
      authorized: false,
      nextBlocker: { code: 'request_failed' },
    });
  });

  it('does not echo accidentally pasted private flags in structured errors', async () => {
    try {
      await runCommand(['status', '--accidental-private-fixture-value'], {});
      throw new Error('Expected invalid arguments.');
    } catch (error) {
      const output = JSON.stringify(serializeCommandError(error));
      expect(output).toContain('private arguments were not printed');
      expect(output).not.toContain('accidental-private-fixture-value');
    }
  });

  it('recovers an unknown submission by GET only and preserves independent delivery and billing states', async () => {
    const seen: string[] = [];
    const client = new OpenGen({
      baseUrl,
      fetch: async (url, init) => {
        seen.push(`${init?.method} ${String(url)}`);
        return Response.json(job);
      },
    });
    const result = await runCommand(['job', 'recover', '--idempotency-key', 'saved key'], {
      client,
      env: { MEDIA_ROUTER_URL: baseUrl },
    });
    expect(result).toMatchObject({
      id: job.id,
      recovery: {
        acceptance: 'accepted',
        delivery: 'failed',
        billing: { state: 'reserved', settledMicros: null },
        resume: {
          args: ['job', 'resume', job.id, '--timeout-ms', '900000'],
          environment: { MEDIA_ROUTER_URL: baseUrl },
        },
      },
    });
    expect(seen).toEqual([`GET ${baseUrl}/v1/generations/lookup?idempotencyKey=saved+key`]);
  });

  it('gives exact safe commands and states for wait timeout, unknown admission and missing lookup', async () => {
    const timedOut = serializeCommandError(new JobWaitTimeoutError(job.id, job), { baseUrl });
    expect(timedOut).toMatchObject({
      error: {
        code: 'wait_timeout',
        jobId: job.id,
        paidResubmissionAllowed: false,
        state: { delivery: 'failed', billing: { state: 'reserved' } },
        resume: { args: ['job', 'resume', job.id, '--timeout-ms', '900000'] },
      },
    });
    const unknown = serializeCommandError(new SubmissionUncertainError('persisted-key'), {
      baseUrl,
    });
    expect(unknown).toMatchObject({
      error: {
        code: 'submission_unknown',
        acceptance: 'unknown',
        paidResubmissionAllowed: false,
        resume: { args: ['job', 'recover', '--idempotency-key', 'persisted-key'] },
      },
    });
    const client = new OpenGen({
      baseUrl,
      fetch: async () =>
        Response.json(
          { error: { code: 'submission_not_found', message: 'Unknown acceptance.' } },
          { status: 404 },
        ),
    });
    try {
      await runCommand(['job', 'recover', '--idempotency-key', 'persisted-key'], { client });
      throw new Error('Expected unknown submission.');
    } catch (error) {
      expect(serializeCommandError(error)).toMatchObject({
        error: {
          code: 'submission_unknown',
          status: 404,
          acceptance: 'unknown',
          paidResubmissionAllowed: false,
        },
      });
    }
  });

  it('keeps job ID and safe resume after Ctrl-C without sending a mutation', async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const client = new OpenGen({
      baseUrl,
      fetch: async (_url, init) => {
        methods.push(init?.method!);
        controller.abort(new Error('interrupt'));
        return Response.json({ ...job, status: 'running' });
      },
    });
    try {
      await runCommand(['job', 'resume', job.id], { client, signal: controller.signal });
      throw new Error('Expected interrupt.');
    } catch (error) {
      expect(serializeCommandError(error)).toMatchObject({
        error: {
          code: 'wait_interrupted',
          jobId: job.id,
          resume: { args: ['job', 'resume', job.id, '--timeout-ms', '900000'] },
        },
      });
    }
    expect(methods).toEqual(['GET']);
  });
});
