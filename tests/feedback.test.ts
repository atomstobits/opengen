import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { containsPrivatePaste, feedbackInputSchema } from '@media-router/contracts';
import { createEngine, FeedbackStore } from '@media-router/engine';
import { buildApp, type EngineLike } from '../apps/server/src/app';

const reviewed = {
  kind: 'feedback' as const,
  category: 'setup' as const,
  summary: 'The upload instructions could explain completion more clearly.',
  reviewedForPrivacy: true as const,
};

describe('explicit private feedback', () => {
  it('requires review and rejects automatic attachments and common private pastes', () => {
    expect(feedbackInputSchema.safeParse({ ...reviewed, reviewedForPrivacy: false }).success).toBe(
      false,
    );
    expect(feedbackInputSchema.safeParse({ ...reviewed, rawPrompt: 'private' }).success).toBe(
      false,
    );
    for (const value of [
      'Bearer abcdefghijkl',
      `og_sk_${'a'.repeat(64)}`,
      `og_mcp_a_${'a'.repeat(43)}`,
      'https://private.example/output?signature=abc',
      'person@example.com',
      'api_key=private',
      'prompt: private task',
      'data:image/png;base64,abcd',
    ])
      expect(containsPrivatePaste(value)).toBe(true);
    expect(containsPrivatePaste(reviewed.summary)).toBe(false);
  });
  it('requires write scope, enforces CSRF origin and keeps reads in the authenticated workspace', async () => {
    const writes: unknown[] = [];
    const engine = {
      accounts: {
        authenticate: async (token: string) => ({
          workspaceId: 'workspace-a',
          scopes: token === 'writer' ? ['read', 'feedback:write'] : ['read'],
        }),
      },
      feedback: {
        submit: async (...args: unknown[]) => {
          writes.push(args);
          return { id: randomUUID(), status: 'received' };
        },
        get: async (...args: unknown[]) => {
          writes.push(args);
          return { status: 'received' };
        },
      },
      getExecutableRouteIds: () => [],
      routeMetrics: async () => [],
    } as unknown as EngineLike;
    const app = await buildApp({ engine, publicUrl: 'https://gateway.example' });
    try {
      const submit = (token: string, payload: unknown = reviewed, origin?: string) =>
        app.inject({
          method: 'POST',
          url: '/v1/feedback',
          headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) },
          payload,
        });
      expect((await submit('reader')).statusCode).toBe(403);
      expect((await submit('writer', reviewed, 'https://other.example')).statusCode).toBe(403);
      expect((await submit('writer', { ...reviewed, logs: [] })).statusCode).toBe(400);
      expect((await submit('writer')).statusCode).toBe(201);
      expect(writes).toEqual([['workspace-a', reviewed]]);
      const id = randomUUID();
      const response = await app.inject({
        url: `/v1/feedback/${id}`,
        headers: { authorization: 'Bearer reader' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(writes[1]).toEqual(['workspace-a', id]);
    } finally {
      await app.close();
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('private feedback persistence', () => {
  it('persists only reviewed fields, validates owned references and isolates tenants with a daily bound', async () => {
    const engine = createEngine({ databaseUrl: process.env.TEST_DATABASE_URL! });
    await engine.initialize();
    const workspace = `feedback-${randomUUID()}`;
    await engine.ensureWorkspace(workspace, 0);
    const store = new FeedbackStore(engine.pool);
    try {
      const receipt = await store.submit(workspace, reviewed);
      expect(await store.get(workspace, receipt.id)).toMatchObject({
        summary: reviewed.summary,
        visibility: 'workspace-and-operator',
      });
      await expect(store.get('another-workspace', receipt.id)).rejects.toMatchObject({
        code: 'feedback_not_found',
      });
      await expect(
        store.submit(workspace, { ...reviewed, jobId: randomUUID() }),
      ).rejects.toMatchObject({ code: 'feedback_job_not_found' });
      await expect(
        store.submit(workspace, { ...reviewed, modelId: 'unknown/model' }),
      ).rejects.toMatchObject({ code: 'feedback_model_not_found' });
      await expect(
        store.submit(workspace, { ...reviewed, summary: 'Authorization: Bearer private' }),
      ).rejects.toMatchObject({ code: 'feedback_private_content' });
      for (let index = 1; index < 20; index++) await store.submit(workspace, reviewed);
      await expect(store.submit(workspace, reviewed)).rejects.toMatchObject({
        code: 'feedback_daily_limit',
      });
      expect((await engine.getBalance(workspace)).availableMicros).toBe(0);
    } finally {
      await engine.pool.query('DELETE FROM mr_feedback WHERE workspace_id=$1', [workspace]);
      await engine.close();
    }
  });
});
