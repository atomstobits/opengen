'use client';

import { useEffect, useState } from 'react';
import {
  activityQuery,
  moneyMicros,
  privateWorkspaceHeaders,
  hasWorkspaceAuthority,
  type ActivityFilters,
  type PrivateWorkspaceAuthority,
} from './activity-view';
import styles from './operations.module.css';

interface Cohort {
  modelId: string;
  operation: string;
  routeId: string;
  deploymentId: string;
  providerId: string | null;
  endpointRegion: string | null;
  configuration: Record<string, unknown>;
  configurationFingerprint: string;
  sampleCount: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  unresolved: number;
  delivered: number;
  unverifiedDelivery: number;
  providerOutcomeLatency: { sampleCount: number; p50Ms: number | null; p95Ms: number | null };
}
interface Analytics {
  since: string;
  until: string;
  sampleCount: number;
  settledMicros: number | null;
  heldMicros: number | null;
  unknownAccountingCount: number;
  truncated: boolean;
  cohorts: Cohort[];
  byKey: KeyUsage[];
  byTag: TagUsage[];
  attributionTruncated: boolean;
  tagsTruncated: boolean;
}
interface UsageAmounts {
  sampleCount: number;
  settledMicros: number | null;
  heldMicros: number | null;
  unknownAccountingCount: number;
}
interface KeyUsage extends UsageAmounts {
  keyId: string | null;
}
interface TagUsage extends UsageAmounts {
  name: string;
  value: string;
}
function latency(value: number | null) {
  return value === null
    ? 'Unknown'
    : `${(value / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })}s`;
}
export function activityConfigurationLabel(value: Record<string, unknown>): string {
  const fields = [
    'resolution',
    'duration',
    'aspectRatio',
    'width',
    'height',
    'count',
    'quality',
    'audio',
    'billing',
    'outputFormat',
    'size',
    'codec',
  ];
  return (
    fields
      .filter((field) => ['string', 'boolean', 'number'].includes(typeof value[field]))
      .map((field) => `${field}: ${String(value[field])}`)
      .join(' · ') || 'Configuration not recorded'
  );
}
/** Private values stay plain text. No directory lookup or inferred key/member identity. */
export function PrivateAttributionTables({
  byKey,
  byTag,
  attributionTruncated,
  tagsTruncated,
}: Pick<Analytics, 'byKey' | 'byTag' | 'attributionTruncated' | 'tagsTruncated'>) {
  return (
    <section className={styles.section} aria-label="Private key and tag usage">
      <div>
        <h3>Usage by key</h3>
        <p className="detail-note">
          Stable key IDs preserve the recorded attribution. Legacy generations without a key remain
          unknown.
        </p>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>
            Private usage and ledger amounts by stable API key ID
          </caption>
          <thead>
            <tr>
              <th>Key ID</th>
              <th>Generations</th>
              <th>Settled</th>
              <th>Reconciled holds</th>
              <th>Accounting needs review</th>
            </tr>
          </thead>
          <tbody>
            {byKey.map((row) => (
              <tr key={row.keyId === null ? 'legacy' : `key:${row.keyId}`}>
                <td>{row.keyId === null ? 'Unknown (legacy)' : <code>{row.keyId}</code>}</td>
                <UsageCells row={row} />
              </tr>
            ))}
          </tbody>
        </table>
        {!byKey.length && (
          <p className={styles.empty}>No key-attributed observations in this window.</p>
        )}
      </div>
      {attributionTruncated && (
        <p className="detail-note">
          Showing the 100 largest key groups. Narrow the filters to inspect the remaining keys.
        </p>
      )}
      <div>
        <h3>Usage by private tag</h3>
        <p className="detail-note">
          Tags belong to this workspace. A generation may have several tags, so tag rows are not
          additive.
        </p>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>
            Private usage and ledger amounts by exact tag name and value
          </caption>
          <thead>
            <tr>
              <th>Tag</th>
              <th>Value</th>
              <th>Generations</th>
              <th>Settled</th>
              <th>Reconciled holds</th>
              <th>Accounting needs review</th>
            </tr>
          </thead>
          <tbody>
            {byTag.map((row) => (
              <tr key={JSON.stringify([row.name, row.value])}>
                <td>
                  <code>{row.name}</code>
                </td>
                <td>{row.value}</td>
                <UsageCells row={row} />
              </tr>
            ))}
          </tbody>
        </table>
        {!byTag.length && <p className={styles.empty}>No tagged observations in this window.</p>}
      </div>
      {tagsTruncated && (
        <p className="detail-note">
          Showing the 100 largest tag groups. Narrow the filters to inspect the remaining tags.
        </p>
      )}
    </section>
  );
}
function UsageCells({ row }: { row: UsageAmounts }) {
  return (
    <>
      <td>{row.sampleCount}</td>
      <td>{moneyMicros(row.settledMicros)}</td>
      <td>{moneyMicros(row.heldMicros)}</td>
      <td>{row.unknownAccountingCount}</td>
    </>
  );
}
/** A separate private aggregate projection; history pagination never changes the sample window. */
export function ActivityAnalytics(props: { filters: ActivityFilters } & PrivateWorkspaceAuthority) {
  if (!hasWorkspaceAuthority(props))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading a private usage report.
      </p>
    );
  return (
    <AnalyticsRecords key={JSON.stringify([props.workspaceId, props.recoveryScope])} {...props} />
  );
}
function AnalyticsRecords({
  filters,
  workspaceId,
  recoveryScope,
}: { filters: ActivityFilters } & PrivateWorkspaceAuthority) {
  const [report, setReport] = useState<Analytics | null>(null);
  const [error, setError] = useState('');
  const query = new URLSearchParams(activityQuery(filters));
  query.delete('limit');
  const serialized = query.toString();
  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    setError('');
    fetch(`/api/activity/analytics?${serialized}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: privateWorkspaceHeaders({ workspaceId, recoveryScope }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            typeof body.error === 'string'
              ? body.error
              : (body.error?.message ?? 'Usage report could not be loaded.'),
          );
        if (!controller.signal.aborted) setReport(body.data ?? body);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Usage report could not be loaded.');
      });
    return () => controller.abort();
  }, [serialized, workspaceId, recoveryScope]);
  return (
    <section className={styles.section} aria-label="Private usage report">
      <div className={styles.heading}>
        <div>
          <h3>Usage by exact configuration</h3>
          <p>
            Uses the applied filters and a window of up to 31 days. Without dates, this report
            covers the last 7 days.
          </p>
        </div>
      </div>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {!report && !error && <p role="status">Loading private usage report…</p>}
      {report && (
        <>
          <p className="detail-note">
            {new Date(report.since).toISOString()} — {new Date(report.until).toISOString()}{' '}
            (exclusive). {report.sampleCount} generation{report.sampleCount === 1 ? '' : 's'}.
          </p>
          <div className={styles.stats}>
            <div>
              <span>Ledger-settled spend</span>
              <strong>{moneyMicros(report.settledMicros)}</strong>
            </div>
            <div>
              <span>Reconciled holds</span>
              <strong>{moneyMicros(report.heldMicros)}</strong>
            </div>
            <div>
              <span>Accounting needs review</span>
              <strong>{report.unknownAccountingCount}</strong>
              <small>Unknown or mismatched records excluded from reconciled holds</small>
            </div>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>
                Private outcomes and recorded provider-outcome latency by exact configuration
              </caption>
              <thead>
                <tr>
                  <th>Exact configuration</th>
                  <th>Generation outcomes</th>
                  <th>Output delivery</th>
                  <th>Admission → provider outcome</th>
                </tr>
              </thead>
              <tbody>
                {report.cohorts.map((cohort, index) => (
                  <tr key={`${cohort.routeId}:${cohort.configurationFingerprint}:${index}`}>
                    <td>
                      <strong>{cohort.modelId}</strong>
                      <code>{cohort.routeId}</code>
                      <small>
                        {cohort.deploymentId} · {cohort.endpointRegion ?? 'Unknown endpoint region'}
                      </small>
                      <small>
                        {cohort.operation} · {activityConfigurationLabel(cohort.configuration)}
                      </small>
                    </td>
                    <td>
                      {cohort.sampleCount} samples
                      <small>
                        {cohort.succeeded} succeeded · {cohort.failed} failed
                      </small>
                      <small>
                        {cohort.cancelled} cancelled · {cohort.unresolved} unresolved
                      </small>
                    </td>
                    <td>
                      {cohort.delivered} available
                      <small>{cohort.unverifiedDelivery} unknown or unverified</small>
                      <small>Generation success is separate from output availability.</small>
                    </td>
                    <td>
                      P50 {latency(cohort.providerOutcomeLatency.p50Ms)}
                      <small>P95 {latency(cohort.providerOutcomeLatency.p95Ms)}</small>
                      <small>{cohort.providerOutcomeLatency.sampleCount} recorded samples</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!report.cohorts.length && (
              <p className={styles.empty}>
                No observations in this window. Latency and rates are unknown.
              </p>
            )}
          </div>
          {report.truncated && (
            <p className="detail-note">
              Showing the 100 largest configuration cohorts. Narrow the filters to inspect the
              remaining cohorts.
            </p>
          )}
          <PrivateAttributionTables
            byKey={report.byKey ?? []}
            byTag={report.byTag ?? []}
            attributionTruncated={report.attributionTruncated}
            tagsTruncated={report.tagsTruncated}
          />
          <p className="detail-note">
            Admission-to-outcome timing includes waiting before the provider result. Separate queue,
            execution, delivery and time-to-usable-asset measurements remain unknown until phase
            evidence is recorded.
          </p>
        </>
      )}
    </section>
  );
}
