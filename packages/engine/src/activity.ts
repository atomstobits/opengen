import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface ActivityFilters {
  modelId?: string;
  providerId?: string;
  deploymentId?: string;
  endpointRegion?: string;
  operation?: string;
  keyId?: string;
  status?: string;
  project?: string;
  since?: string;
  until?: string;
  limit?: number;
  cursor?: string;
}
export interface ActivityItem {
  id: string;
  modelId: string;
  operation: string;
  providerId: string | null;
  endpointRegion: string | null;
  routeId: string;
  deploymentId: string;
  status: string;
  deliveryStatus: string;
  createdAt: string;
  updatedAt: string;
  reservedMicros: number;
  ledgerReservedMicros: number | null;
  settledMicros: number | null;
  heldMicros: number | null;
  accountingState: 'reconciled' | 'unknown' | 'mismatch';
  attribution: {
    kind: string;
    keyId: string | null;
    membershipId: string | null;
    grantId: string | null;
  } | null;
  project: string | null;
}
const statuses = new Set([
  'queued',
  'submitting',
  'running',
  'submission-unknown',
  'succeeded',
  'failed',
  'cancelled',
]);
const filterNames = [
  'modelId',
  'providerId',
  'deploymentId',
  'endpointRegion',
  'operation',
  'keyId',
  'status',
  'project',
  'since',
  'until',
  'limit',
  'cursor',
] as const;
const invalid = (message: string) =>
  Object.assign(new Error(message), {
    code: 'invalid_activity_query',
    statusCode: 400,
  });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function timestamp(value: unknown): string {
  if (typeof value !== 'string') throw invalid('Use an ISO timestamp with a timezone.');
  const parts =
    /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?(?:Z|([+-])(\d\d):(\d\d))$/.exec(
      value,
    );
  if (!parts || !Number.isFinite(Date.parse(value)))
    throw invalid('Use an ISO timestamp with a timezone.');
  const [, year, month, day, hour, minute, second, fraction, , offsetHour, offsetMinute] = parts;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    Number(year) < 1 ||
    Number(month) < 1 ||
    Number(month) > 12 ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour ?? 0) > 23 ||
    Number(offsetMinute ?? 0) > 59
  )
    throw invalid('Use a valid calendar timestamp.');
  // Date normalizes the timezone, but its millisecond precision must not erase query microseconds.
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, `.${(fraction ?? '').padEnd(6, '0')}Z`);
}
/** Shared by adapters: unknown filters cannot silently broaden a private query. */
export function parseActivityFilters(input: unknown): ActivityFilters {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw invalid('Expected query filters.');
  const raw = input as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !filterNames.includes(key as (typeof filterNames)[number])))
    throw invalid('Unknown activity filter.');
  const result: Record<string, unknown> = {};
  for (const name of filterNames) {
    const value = raw[name];
    if (value === undefined) continue;
    if (name === 'limit') {
      if (
        !['number', 'string'].includes(typeof value) ||
        !/^\d+$/.test(String(value)) ||
        Number(value) < 1 ||
        Number(value) > 100
      )
        throw invalid('Page size must be 1–100.');
      result[name] = Number(value);
    } else if (name === 'since' || name === 'until') result[name] = timestamp(value);
    else {
      if (
        typeof value !== 'string' ||
        !value.length ||
        value.length > (name === 'cursor' ? 2048 : 200) ||
        /[\u0000-\u001f]/.test(value)
      )
        throw invalid(`Invalid ${name} filter.`);
      result[name] = value;
    }
  }
  if (result.status && !statuses.has(result.status as string))
    throw invalid('Unknown generation status.');
  if (result.since && result.until && String(result.since) >= String(result.until))
    throw invalid('since must precede until; until is exclusive.');
  return result as ActivityFilters;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function binding(workspaceId: string, filters: ActivityFilters) {
  return digest([
    workspaceId,
    ...filterNames
      .filter((n) => n !== 'limit' && n !== 'cursor')
      .map((name) => [name, filters[name] ?? null]),
  ]);
}
function decodeCursor(value: string, expected: string): { at: string; id: string } {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    // Preserve PostgreSQL's microseconds: Date would drop precision and skip equal-time rows.
    if (
      cursor.v !== 1 ||
      cursor.scope !== expected ||
      typeof cursor.at !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at) ||
      !Number.isFinite(Date.parse(cursor.at)) ||
      !uuid.test(cursor.id)
    )
      throw new Error();
    return cursor;
  } catch {
    throw invalid('Cursor does not belong to this workspace and filter selection.');
  }
}

// Requires the additive C5 schema. Legacy rows retain NULL attribution and empty metadata.
// Direct columns let Activity indexes serve exact private filters without loading whole job JSON.
const actor = 'j.attribution';
const metadata = 'j.metadata';
function predicate(workspaceId: string, filters: ActivityFilters) {
  const values: unknown[] = [workspaceId];
  const clauses = ['j.workspace_id=$1'];
  const expressions: Record<string, string> = {
    modelId: "j.input->>'modelId'",
    providerId: "j.deployment_snapshot->>'providerId'",
    deploymentId: "j.deployment_snapshot->>'id'",
    endpointRegion: "j.deployment_snapshot->>'endpointRegion'",
    operation: "j.input->>'operation'",
    keyId: `${actor}->>'keyId'`,
    status: 'j.status',
    project: `${metadata}->>'project'`,
  };
  for (const [name, expression] of Object.entries(expressions)) {
    const value = filters[name as keyof ActivityFilters];
    if (value !== undefined) {
      values.push(value);
      clauses.push(`${expression}=$${values.length}`);
    }
  }
  for (const [name, operator] of [
    ['since', '>='],
    ['until', '<'],
  ] as const) {
    if (filters[name]) {
      values.push(filters[name]);
      clauses.push(`j.created_at${operator}$${values.length}::timestamptz`);
    }
  }
  return { values, clauses };
}
const accountingJoin = `LEFT JOIN LATERAL (
  SELECT count(*) FILTER (WHERE kind='reserve') AS reserve_count,
    count(*) FILTER (WHERE kind='settle') AS settle_count,
    count(*) FILTER (WHERE kind='release') AS release_count,
    count(*) FILTER (WHERE (kind='reserve' AND (reserved_delta_micros<>amount_micros OR available_delta_micros<>-amount_micros))
      OR (kind='settle' AND (reserved_delta_micros<>-amount_micros OR available_delta_micros<>0))
      OR (kind='release' AND (reserved_delta_micros<>-amount_micros OR available_delta_micros<>amount_micros))
      OR kind NOT IN ('reserve','settle','release') OR amount_micros<0) AS invalid_delta_count,
    coalesce(sum(amount_micros) FILTER (WHERE kind='reserve'),0) AS reserved,
    coalesce(sum(amount_micros) FILTER (WHERE kind='settle'),0) AS settled,
    coalesce(sum(amount_micros) FILTER (WHERE kind='release'),0) AS released,
    coalesce(sum(reserved_delta_micros),0) AS held
  FROM mr_ledger l WHERE l.workspace_id=j.workspace_id AND l.job_id=j.id
) a ON true`;
const accountingState = `CASE WHEN a.reserve_count=0 THEN 'unknown'
  WHEN a.reserve_count<>1 OR a.settle_count>1 OR a.invalid_delta_count>0 OR a.reserved<>j.reserved_micros OR a.held<0
    OR (a.settle_count=0 AND (j.settled_micros IS NOT NULL OR a.release_count<>0 OR a.held<>a.reserved))
    OR (a.settle_count=1 AND (j.settled_micros IS DISTINCT FROM a.settled OR a.held<>0
      OR a.release_count<>1 OR a.reserved<>a.settled+a.released))
  THEN 'mismatch' ELSE 'reconciled' END`;
function safeMoney(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
}
function item(row: Record<string, any>): ActivityItem {
  const attribution = row.attribution;
  return {
    id: row.id,
    modelId: row.model_id,
    operation: row.operation,
    providerId: row.provider_id ?? null,
    endpointRegion: row.endpoint_region ?? null,
    routeId: row.route_id,
    deploymentId: row.deployment_id,
    status: row.status,
    deliveryStatus: row.delivery_status ?? 'unverified',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    reservedMicros: Number(row.reserved_micros),
    ledgerReservedMicros: Number(row.reserve_count) ? safeMoney(row.ledger_reserved) : null,
    settledMicros: Number(row.settle_count) ? safeMoney(row.ledger_settled) : null,
    heldMicros: row.accounting_state === 'reconciled' ? safeMoney(row.ledger_held) : null,
    accountingState: row.accounting_state,
    attribution:
      attribution && typeof attribution.kind === 'string'
        ? {
            kind: attribution.kind,
            keyId: attribution.keyId ?? null,
            membershipId: attribution.membershipId ?? null,
            grantId: attribution.grantId ?? null,
          }
        : null,
    project: row.project ?? null,
  };
}

/** Caller MUST first authorize read scope for workspaceId. No asset signer or provider is used. */
export class ActivityStore {
  constructor(readonly pool: Pool) {}
  async list(
    workspaceId: string,
    input: ActivityFilters = {},
  ): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    const filters = parseActivityFilters(input),
      limit = filters.limit ?? 50;
    const scope = binding(workspaceId, filters);
    const { values, clauses } = predicate(workspaceId, filters);
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor, scope);
      values.push(cursor.at, cursor.id);
      clauses.push(
        `(j.created_at,j.id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    const { rows } = await this.pool.query(
      `WITH page AS (
      SELECT j.id,j.workspace_id,j.input->>'modelId' AS model_id,j.input->>'operation' AS operation,
        j.deployment_snapshot->>'providerId' AS provider_id,j.deployment_snapshot->>'endpointRegion' AS endpoint_region,
        j.route_snapshot->>'id' AS route_id,j.deployment_snapshot->>'id' AS deployment_id,
        j.status,j.delivery_status AS delivery_status,j.created_at,j.updated_at,
        j.reserved_micros,j.settled_micros,${actor} AS attribution,${metadata}->>'project' AS project,
        to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
      FROM mr_jobs j WHERE ${clauses.join(' AND ')} ORDER BY j.created_at DESC,j.id DESC LIMIT $${values.length}
    ) SELECT j.*,a.reserve_count,a.settle_count,a.reserved AS ledger_reserved,
      a.settled AS ledger_settled,a.held AS ledger_held,${accountingState} AS accounting_state
      FROM page j ${accountingJoin} ORDER BY j.created_at DESC,j.id DESC`,
      values,
    );
    const page = rows.slice(0, limit),
      last = page.at(-1);
    return {
      items: page.map(item),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ v: 1, scope, at: last.cursor_at, id: last.id })).toString(
              'base64url',
            )
          : null,
    };
  }

  /** Bounded private report: max 31 days, max 100 exact configuration cohorts; no identity/content projection. */
  async analytics(workspaceId: string, input: ActivityFilters = {}) {
    const filters = parseActivityFilters(input);
    if (filters.cursor || filters.limit)
      throw invalid('Analytics uses a date window, not pagination.');
    const until = filters.until ?? new Date().toISOString();
    const since = filters.since ?? new Date(Date.parse(until) - 7 * 86_400_000).toISOString();
    if (Date.parse(until) - Date.parse(since) > 31 * 86_400_000 || since >= until)
      throw invalid('Analytics window must be positive and at most 31 days.');
    const { values, clauses } = predicate(workspaceId, { ...filters, since, until });
    const { rows } = await this.pool.query(
      `WITH selected AS (
      SELECT j.id,j.workspace_id,j.status,j.delivery_status AS delivery_status,
        j.created_at,j.completed_at,j.reserved_micros,j.settled_micros,
        j.attribution->>'keyId' AS key_id,j.metadata->'tags' AS tags,
        j.input->>'modelId' AS model_id,j.input->>'operation' AS operation,
        j.route_snapshot->>'id' AS route_id,j.deployment_snapshot->>'id' AS deployment_id,
        j.deployment_snapshot->>'providerId' AS provider_id,j.deployment_snapshot->>'endpointRegion' AS endpoint_region,
        md5(jsonb_build_object(
          'parameters',(j.input->'input') - ARRAY['prompt','negativePrompt','systemPrompt','firstFrame','lastFrame','sourceVideo','mask','references','targetAudio','keyframes','shots','elements','draftJobId'],
          'media',jsonb_build_object('firstFrame',j.input->'input' ? 'firstFrame','lastFrame',j.input->'input' ? 'lastFrame',
            'sourceVideo',j.input->'input' ? 'sourceVideo','mask',j.input->'input' ? 'mask','targetAudio',j.input->'input' ? 'targetAudio',
            'referenceTypes',(SELECT jsonb_agg(ref->>'type' ORDER BY ord) FROM jsonb_array_elements(coalesce(j.input->'input'->'references','[]')) WITH ORDINALITY AS refs(ref,ord)),
            'keyframeTimes',(SELECT jsonb_agg(frame->'at' ORDER BY ord) FROM jsonb_array_elements(coalesce(j.input->'input'->'keyframes','[]')) WITH ORDINALITY AS frames(frame,ord)),
            'shotDurations',(SELECT jsonb_agg(shot->'duration' ORDER BY ord) FROM jsonb_array_elements(coalesce(j.input->'input'->'shots','[]')) WITH ORDINALITY AS shots(shot,ord)),
            'elementShapes',(SELECT jsonb_agg(jsonb_build_object('images',jsonb_array_length(coalesce(elem->'images','[]')),'video',elem ? 'video','voice',elem ? 'voice') ORDER BY ord) FROM jsonb_array_elements(coalesce(j.input->'input'->'elements','[]')) WITH ORDINALITY AS elements(elem,ord)))
          )::text) AS configuration_fingerprint,
        jsonb_strip_nulls(jsonb_build_object('resolution',j.input->'input'->'resolution',
          'duration',j.input->'input'->'duration','aspectRatio',j.input->'input'->'aspectRatio',
          'width',j.input->'input'->'width','height',j.input->'input'->'height',
          'count',j.input->'input'->'count','quality',j.input->'input'->'quality',
          'size',j.input->'input'->'size','outputFormat',j.input->'input'->'outputFormat',
          'outputCompression',j.input->'input'->'outputCompression','background',j.input->'input'->'background',
          'codec',j.input->'input'->'codec','bitrateMode',j.input->'input'->'bitrateMode',
          'layers',j.input->'input'->'layers','strength',j.input->'input'->'strength',
          'audio',j.input->'input'->'audio','billing',j.input->'billing')) AS configuration
      FROM mr_jobs j WHERE ${clauses.join(' AND ')}
    ), accounted AS (
      SELECT j.*,a.settled,a.held,${accountingState} AS accounting_state FROM selected j ${accountingJoin}
    ), totals AS (
      SELECT count(*) AS samples,coalesce(sum(settled),0) AS settled,coalesce(sum(held) FILTER (WHERE accounting_state='reconciled'),0) AS held,
        count(*) FILTER (WHERE accounting_state<>'reconciled') AS unknown_accounting FROM accounted
    ), key_totals AS (
      SELECT key_id,count(*) AS samples,coalesce(sum(settled),0) AS settled,
        coalesce(sum(held) FILTER (WHERE accounting_state='reconciled'),0) AS held,
        count(*) FILTER (WHERE accounting_state<>'reconciled') AS unknown_accounting
      FROM accounted GROUP BY key_id ORDER BY count(*) DESC,key_id NULLS LAST LIMIT 101
    ), tag_totals AS (
      SELECT tag.key AS name,tag.value,count(*) AS samples,coalesce(sum(settled),0) AS settled,
        coalesce(sum(held) FILTER (WHERE accounting_state='reconciled'),0) AS held,
        count(*) FILTER (WHERE accounting_state<>'reconciled') AS unknown_accounting
      FROM accounted CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(tags)='object' THEN tags ELSE '{}' END) tag
      GROUP BY tag.key,tag.value ORDER BY count(*) DESC,tag.key,tag.value LIMIT 101
    ), cohorts AS (
      SELECT model_id,operation,route_id,deployment_id,provider_id,endpoint_region,configuration,configuration_fingerprint,count(*) AS samples,
        count(*) FILTER (WHERE status='succeeded') AS succeeded,count(*) FILTER (WHERE status='failed') AS failed,
        count(*) FILTER (WHERE status='cancelled') AS cancelled,
        count(*) FILTER (WHERE status NOT IN ('succeeded','failed','cancelled')) AS unresolved,
        count(*) FILTER (WHERE delivery_status='available') AS delivered,
        count(*) FILTER (WHERE delivery_status IS NULL OR delivery_status='unverified') AS unverified_delivery,
        count(*) FILTER (WHERE completed_at>=created_at) AS latency_samples,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-created_at)*1000)
          FILTER (WHERE completed_at>=created_at) AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM completed_at-created_at)*1000)
          FILTER (WHERE completed_at>=created_at) AS p95
      FROM accounted GROUP BY model_id,operation,route_id,deployment_id,provider_id,endpoint_region,configuration,configuration_fingerprint
      ORDER BY count(*) DESC,model_id,operation,route_id,deployment_id,configuration::text,configuration_fingerprint LIMIT 101
    ) SELECT row_to_json(totals) AS totals,(SELECT coalesce(jsonb_agg(cohorts),'[]') FROM cohorts) AS cohorts,
      (SELECT coalesce(jsonb_agg(key_totals),'[]') FROM key_totals) AS by_key,
      (SELECT coalesce(jsonb_agg(tag_totals),'[]') FROM tag_totals) AS by_tag FROM totals`,
      values,
    );
    const row = rows[0];
    return {
      since,
      until,
      sampleCount: Number(row.totals.samples),
      settledMicros: safeMoney(row.totals.settled),
      heldMicros: safeMoney(row.totals.held),
      unknownAccountingCount: Number(row.totals.unknown_accounting),
      truncated: row.cohorts.length > 100,
      attributionTruncated: row.by_key.length > 100,
      tagsTruncated: row.by_tag.length > 100,
      byKey: row.by_key.slice(0, 100).map((c: Record<string, any>) => ({
        keyId: c.key_id,
        sampleCount: Number(c.samples),
        settledMicros: safeMoney(c.settled),
        heldMicros: safeMoney(c.held),
        unknownAccountingCount: Number(c.unknown_accounting),
      })),
      byTag: row.by_tag.slice(0, 100).map((c: Record<string, any>) => ({
        name: c.name,
        value: c.value,
        sampleCount: Number(c.samples),
        settledMicros: safeMoney(c.settled),
        heldMicros: safeMoney(c.held),
        unknownAccountingCount: Number(c.unknown_accounting),
      })),
      cohorts: row.cohorts.slice(0, 100).map((c: Record<string, any>) => ({
        modelId: c.model_id,
        operation: c.operation,
        routeId: c.route_id,
        deploymentId: c.deployment_id,
        providerId: c.provider_id,
        endpointRegion: c.endpoint_region,
        configuration: c.configuration,
        configurationFingerprint: c.configuration_fingerprint,
        sampleCount: Number(c.samples),
        succeeded: Number(c.succeeded),
        failed: Number(c.failed),
        cancelled: Number(c.cancelled),
        unresolved: Number(c.unresolved),
        delivered: Number(c.delivered),
        unverifiedDelivery: Number(c.unverified_delivery),
        providerOutcomeLatency: {
          sampleCount: Number(c.latency_samples),
          p50Ms: c.p50 === null ? null : Number(c.p50),
          p95Ms: c.p95 === null ? null : Number(c.p95),
        },
        queueLatency: null,
        executionLatency: null,
        deliveryLatency: null,
        endToEndLatency: null,
      })),
    };
  }
}
