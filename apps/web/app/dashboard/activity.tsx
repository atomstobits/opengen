'use client';

import { useEffect, useState } from 'react';
import {
  activityFilterFields,
  activityIdentity,
  privateWorkspaceHeaders,
  hasWorkspaceAuthority,
  activityQuery,
  moneyMicros,
  sumMicros,
  type ActivityFilters,
  type ActivityItem,
  type ActivityPage,
} from './activity-view';
import styles from './operations.module.css';
import { ActivityAnalytics } from './activity-analytics';

export interface PrivateActivityProps {
  workspaceId: string | null;
  membershipId?: string | null;
  recoveryScope?: string | null;
  permissions: readonly string[];
  onSelectJob?: (id: string) => void;
}
/** The identity boundary remounts before a previous workspace's records can render. */
export function PrivateActivity(props: PrivateActivityProps) {
  if (!props.workspaceId || !props.permissions.includes('read'))
    return (
      <p className="detail-note">Your workspace permissions do not include activity access.</p>
    );
  if (!hasWorkspaceAuthority(props))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading private activity.
      </p>
    );
  return (
    <ActivityRecords
      key={JSON.stringify([
        props.workspaceId,
        props.membershipId,
        props.recoveryScope,
        [...props.permissions].sort(),
      ])}
      {...props}
    />
  );
}
function ActivityRecords({ workspaceId, recoveryScope, onSelectJob }: PrivateActivityProps) {
  const [draft, setDraft] = useState<ActivityFilters>({});
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [showAnalytics, setShowAnalytics] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setPage(null);
    fetch(`/api/activity?${activityQuery(filters, cursor)}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: privateWorkspaceHeaders({ workspaceId, recoveryScope }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Activity could not be loaded. Try refreshing.');
        const body = await response.json();
        if (!controller.signal.aborted) setPage(body.data ?? body);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Activity could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [workspaceId, recoveryScope, filters, cursor, refresh]);
  const items = page?.items ?? [];
  const observed = items.filter((item) => item.settledMicros !== null);
  const held = items.filter((item) => item.heldMicros !== null);
  function apply(next: ActivityFilters) {
    setPage(null);
    setFilters(next);
    setCursor(null);
    setPrevious([]);
  }
  function navigate(next: string | null) {
    setPage(null);
    setCursor(next);
  }
  return (
    <section className={styles.section} aria-label="Private activity">
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">PRIVATE ACTIVITY</span>
          <h2>Every generation. A clear record.</h2>
          <p>
            Filter exact models and regional deployments. Costs come from your workspace ledger.
          </p>
        </div>
        <button
          className="button button-outline button-sm"
          disabled={loading}
          onClick={() => {
            setPage(null);
            setRefresh((n) => n + 1);
          }}
        >
          Refresh
        </button>
      </div>
      <form
        className={styles.filters}
        onSubmit={(event) => {
          event.preventDefault();
          apply({ ...draft });
        }}
      >
        <details>
          <summary>
            Filter activity{Object.values(filters).some(Boolean) ? ' · filters applied' : ''}
          </summary>
          <div className={styles.filterGrid}>
            {activityFilterFields.map(([field, label]) => (
              <label key={field}>
                {label}
                <input
                  maxLength={200}
                  value={draft[field] ?? ''}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [field]: event.target.value }))
                  }
                  placeholder={field === 'keyId' ? 'Stable key ID' : 'Any'}
                />
              </label>
            ))}
            <label>
              From day (UTC)
              <input
                type="date"
                value={draft.since ?? ''}
                max={draft.until}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, since: event.target.value }))
                }
              />
            </label>
            <label>
              Through day (UTC)
              <input
                type="date"
                value={draft.until ?? ''}
                min={draft.since}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, until: event.target.value }))
                }
              />
            </label>
          </div>
          <div className={styles.actions}>
            <button type="submit" className="button button-dark button-sm" disabled={loading}>
              Apply filters
            </button>
            <button
              type="button"
              className="text-link"
              disabled={loading}
              onClick={() => {
                setDraft({});
                apply({});
              }}
            >
              Clear filters
            </button>
          </div>
        </details>
      </form>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      <div className={styles.stats} aria-label="Current page totals">
        <div>
          <span>Generations on this page</span>
          <strong>{page ? items.length : '—'}</strong>
        </div>
        <div>
          <span>Settled on this page</span>
          <strong>
            {page ? moneyMicros(sumMicros(observed.map((item) => item.settledMicros!))) : '—'}
          </strong>
          <small>
            {observed.length} confirmed · {items.length - observed.length} pending or unknown
          </small>
        </div>
        <div>
          <span>Still held on this page</span>
          <strong>
            {page && held.length === items.length
              ? moneyMicros(sumMicros(held.map((item) => item.heldMicros!)))
              : 'Unknown'}
          </strong>
          <small>Temporary holds, separate from settled spend</small>
        </div>
      </div>
      <div className={styles.tableWrap} aria-busy={loading}>
        <table className={styles.table}>
          <caption className={styles.srOnly}>
            Private workspace generation history, newest first
          </caption>
          <thead>
            <tr>
              <th>Model & route</th>
              <th>Generation / delivery</th>
              <th>Reserved / settled / held</th>
              <th>Identity & project</th>
              {onSelectJob && <th>Details</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <ActivityRow key={item.id} item={item} onSelectJob={onSelectJob} />
            ))}
          </tbody>
        </table>
        {loading && (
          <p className={styles.empty} role="status">
            Loading activity…
          </p>
        )}
        {!loading && page && !items.length && (
          <div className={styles.empty}>
            <h3>No generations in this view.</h3>
            <p>Adjust your filters or create something in the playground.</p>
            <a className="text-link" href="/playground">
              Open playground ↗
            </a>
          </div>
        )}
      </div>
      <div className={styles.pagination}>
        <p>
          Newest first · 25 per page. New generations appear when you return to the newest page.
        </p>
        <div className={styles.actions}>
          <button
            className="button button-outline button-sm"
            disabled={loading || !previous.length}
            onClick={() => {
              navigate(previous.at(-1) ?? null);
              setPrevious((value) => value.slice(0, -1));
            }}
          >
            Newer
          </button>
          <button
            className="button button-outline button-sm"
            disabled={loading || !page?.nextCursor}
            onClick={() => {
              setPrevious((value) => [...value, cursor]);
              navigate(page!.nextCursor);
            }}
          >
            Older
          </button>
        </div>
      </div>
      <p className="detail-note">
        Legacy identity and missing delivery evidence remain unknown. A reservation is a temporary
        hold; pending settlement does not confirm a refund. These are private page totals, not an
        all-time report.
      </p>
      <div className={styles.actions}>
        <button
          className="button button-outline button-sm"
          aria-expanded={showAnalytics}
          onClick={() => setShowAnalytics((current) => !current)}
        >
          {showAnalytics ? 'Close usage report' : 'View private usage report'}
        </button>
      </div>
      {showAnalytics && (
        <ActivityAnalytics
          key={JSON.stringify([filters, workspaceId, recoveryScope])}
          filters={filters}
          workspaceId={workspaceId}
          recoveryScope={recoveryScope}
        />
      )}
    </section>
  );
}
function ActivityRow({
  item,
  onSelectJob,
}: {
  item: ActivityItem;
  onSelectJob?: (id: string) => void;
}) {
  return (
    <tr>
      <td>
        <strong>{item.modelId}</strong>
        <small>
          {item.operation} · {new Date(item.createdAt).toLocaleString()}
        </small>
        <code>{item.routeId}</code>
        <small>
          {item.providerId ?? 'Unknown provider'} ·{' '}
          {item.endpointRegion ?? 'Unknown endpoint region'}
        </small>
        <small title={item.deploymentId}>{item.deploymentId}</small>
      </td>
      <td>
        <span className={styles.status}>{item.status.replaceAll('-', ' ')}</span>
        <small>Delivery: {item.deliveryStatus ?? 'Unverified'}</small>
        {item.progress && (
          <small>
            {item.progress.phase}
            {item.progress.percent == null ? '' : ` · ${item.progress.percent}%`} ·{' '}
            {item.progress.source}
          </small>
        )}
      </td>
      <td>
        <span>{moneyMicros(item.reservedMicros)} reserved</span>
        <small>
          {item.settledMicros === null
            ? 'Pending / unknown settlement'
            : `${moneyMicros(item.settledMicros)} settled`}
        </small>
        <small>{moneyMicros(item.heldMicros)} held</small>
        {item.accountingState === 'mismatch' && <small>Ledger reconciliation needed</small>}
      </td>
      <td>
        <span className={styles.identity}>{activityIdentity(item)}</span>
        {item.attribution?.keyId && item.attribution.membershipId && (
          <small>Key {item.attribution.keyId}</small>
        )}
        <small>{item.project ?? 'No project recorded'}</small>
        <code>{item.id}</code>
      </td>
      {onSelectJob && (
        <td>
          <button
            className="text-link"
            aria-label={`View generation ${item.id}`}
            onClick={() => onSelectJob(item.id)}
          >
            View ↗
          </button>
        </td>
      )}
    </tr>
  );
}
