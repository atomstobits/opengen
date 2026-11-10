import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { catalog } from '@media-router/catalog';
import {
  canonicalModelId,
  containsPrivatePaste,
  feedbackInputSchema,
  type FeedbackInput,
} from '@media-router/contracts';

const failure = (code: string, message: string, statusCode = 400) =>
  Object.assign(new Error(message), { code, statusCode });

export class FeedbackStore {
  constructor(private readonly pool: Pool) {}

  async submit(workspaceId: string, raw: FeedbackInput) {
    const input = feedbackInputSchema.parse(raw);
    if (containsPrivatePaste(input.summary))
      throw failure(
        'feedback_private_content',
        'Remove URLs, addresses, credentials, prompts and raw logs before submitting.',
      );
    const modelId = input.modelId ? canonicalModelId(input.modelId) : undefined;
    if (modelId && !catalog.models.some((model) => model.id === modelId))
      throw failure(
        'feedback_model_not_found',
        'Link an existing model ID; describe a requested model in the sanitized summary.',
      );
    const route = input.routeId
      ? catalog.routes.find((route) => route.id === input.routeId)
      : undefined;
    if (input.routeId && (!route || (modelId && route.modelId !== modelId)))
      throw failure('feedback_route_not_found', 'The route must exist and match the linked model.');
    if (input.jobId) {
      // Select reference metadata only. Never load prompts, outputs, attempts or logs.
      const job = (
        await this.pool.query(
          'SELECT route_snapshot FROM mr_jobs WHERE id=$1 AND workspace_id=$2',
          [input.jobId, workspaceId],
        )
      ).rows[0];
      if (!job) throw failure('feedback_job_not_found', 'Owned job not found.', 404);
      if (
        (modelId && job.route_snapshot.modelId !== modelId) ||
        (route && job.route_snapshot.id !== route.id)
      )
        throw failure(
          'feedback_reference_mismatch',
          'The linked model and route must match the owned job.',
        );
    }
    const id = randomUUID();
    // Bound per-workspace storage growth transactionally without touching money.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      const count = Number(
        (
          await client.query(
            "SELECT count(*) AS n FROM mr_feedback WHERE workspace_id=$1 AND created_at > now()-interval '1 day'",
            [workspaceId],
          )
        ).rows[0].n,
      );
      if (count >= 20)
        throw failure(
          'feedback_daily_limit',
          'This workspace has reached the daily report limit.',
          429,
        );
      await client.query(
        'INSERT INTO mr_feedback(id,workspace_id,kind,category,summary,model_id,route_id,job_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          id,
          workspaceId,
          input.kind,
          input.category,
          input.summary,
          modelId ?? null,
          input.routeId ?? null,
          input.jobId ?? null,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { id, status: 'received' as const, visibility: 'workspace-and-operator' as const };
  }

  async get(workspaceId: string, id: string) {
    const row = (
      await this.pool.query(
        'SELECT id,kind,category,summary,model_id AS "modelId",route_id AS "routeId",job_id AS "jobId",created_at AS "createdAt" FROM mr_feedback WHERE id=$1 AND workspace_id=$2',
        [id, workspaceId],
      )
    ).rows[0];
    if (!row) throw failure('feedback_not_found', 'Report not found.', 404);
    return { ...row, status: 'received', visibility: 'workspace-and-operator' };
  }
}
