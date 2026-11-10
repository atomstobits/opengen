import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PaymentError } from './payments.js';
export interface BillingReviewItem {
  kind: 'stripe-event' | 'manual-payment' | 'automatic-payment' | 'provider-cost' | 'risk-hold';
  id: string;
  workspaceId: string | null;
  reason: string;
  createdAt: string;
  heldMicros?: number;
  amountCents?: number;
}
/** Installation-operator surface. Billing delegates cannot inspect/resolve this
 * queue. It never initiates payment, generation, refunds or estimate settlement. */
export class BillingOperationsStore {
  constructor(private pool: Pool) {}
  private async tx<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async queue(
    authorize: (client: PoolClient) => Promise<void>,
    options: { workspaceId?: string; limit?: number } = {},
  ): Promise<BillingReviewItem[]> {
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new PaymentError('invalid_limit', 'Use a review page size from 1 to 100.');
    return this.tx(async (client) => {
      await authorize(client);
      const reliefSchema = (
        await client.query("SELECT to_regclass('mr_aged_cost_relief_settlements') AS name")
      ).rows[0].name;
      const supplierReview = reliefSchema
        ? `
        UNION ALL SELECT 'provider-cost',g.job_id::text,g.workspace_id,
          'operator-funded-predecessor-cost-unverified',g.liability_since,NULL,NULL
        FROM mr_aged_cost_reliefs g JOIN mr_aged_cost_relief_settlements s USING(job_id)
        WHERE jsonb_array_length(COALESCE(s.receipt->'unverifiedPredecessors','[]'::jsonb))>0
          AND ($1::text IS NULL OR g.workspace_id=$1)`
        : '';
      const rows = (
        await client.query(
          `SELECT * FROM (
        SELECT 'stripe-event'::text AS kind,e.id,NULL::text AS workspace_id,COALESCE(e.reason,e.state) AS reason,e.created_at,NULL::bigint AS held_micros,NULL::integer AS amount_cents
          FROM mr_payment_events e WHERE e.state IN ('pending','rejected') AND $1::text IS NULL
        UNION ALL SELECT 'manual-payment',id::text,workspace_id,status,created_at,NULL,amount_cents FROM mr_payment_orders WHERE status IN ('review','checkout_pending') AND($1::text IS NULL OR workspace_id=$1)
        UNION ALL SELECT 'automatic-payment',id::text,workspace_id,COALESCE(failure_code,status),created_at,NULL,amount_cents FROM mr_billing_recharge_attempts WHERE status IN ('unknown','review','requires_authentication','submitting') AND($1::text IS NULL OR workspace_id=$1)
        UNION ALL SELECT 'provider-cost',id::text,workspace_id,'provider-cost-unverified',created_at,reserved_micros,NULL FROM mr_jobs WHERE settled_micros IS NULL AND status IN ('succeeded','failed','cancelled','submission-unknown') AND($1::text IS NULL OR workspace_id=$1)
        UNION ALL SELECT 'risk-hold',event_id,workspace_id,reason,created_at,NULL,NULL FROM mr_billing_holds WHERE resolved_at IS NULL AND($1::text IS NULL OR workspace_id=$1)
        ${supplierReview}
      ) review ORDER BY created_at,id LIMIT $2`,
          [options.workspaceId ?? null, limit],
        )
      ).rows;
      return rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        workspaceId: row.workspace_id,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
        ...(row.held_micros === null ? {} : { heldMicros: Number(row.held_micros) }),
        ...(row.amount_cents === null ? {} : { amountCents: row.amount_cents }),
      }));
    });
  }
  async resolveHold(
    workspaceId: string,
    eventId: string,
    input: { reference: string; note: string; evidenceUrl: string },
    actor: Record<string, unknown>,
    authorize: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    if (!input.reference || input.reference.length > 200 || !input.note || input.note.length > 2000)
      throw new PaymentError(
        'invalid_resolution',
        'A bounded operator reference and note are required.',
      );
    const evidence = new URL(input.evidenceUrl);
    if (evidence.protocol !== 'https:' || evidence.username || evidence.password)
      throw new PaymentError('invalid_evidence', 'Use an HTTPS evidence reference.');
    await this.tx(async (client) => {
      await client.query('SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
      await authorize(client);
      const hold = (
        await client.query(
          'SELECT * FROM mr_billing_holds WHERE workspace_id=$1 AND event_id=$2 FOR UPDATE',
          [workspaceId, eventId],
        )
      ).rows[0];
      if (!hold) throw new PaymentError('not_found', 'Billing hold not found.', 404);
      const prior = (
        await client.query(
          'SELECT * FROM mr_billing_hold_resolutions WHERE event_id=$1 AND reference=$2',
          [eventId, input.reference],
        )
      ).rows[0];
      if (prior) {
        if (prior.note !== input.note || prior.evidence_url !== input.evidenceUrl)
          throw new PaymentError(
            'resolution_conflict',
            'Hold resolution reference already has different evidence.',
            409,
          );
        return;
      }
      if (hold.resolved_at)
        throw new PaymentError(
          'already_resolved',
          'This hold already has an audited resolution.',
          409,
        );
      await client.query(
        'INSERT INTO mr_billing_hold_resolutions(id,event_id,workspace_id,reference,note,evidence_url,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          randomUUID(),
          eventId,
          workspaceId,
          input.reference,
          input.note,
          input.evidenceUrl,
          JSON.stringify(actor),
        ],
      );
      await client.query(
        'UPDATE mr_billing_holds SET resolved_at=now(),resolution_reference=$3 WHERE workspace_id=$1 AND event_id=$2',
        [workspaceId, eventId, input.reference],
      );
    });
  }
}
