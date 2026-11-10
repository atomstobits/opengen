'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CopyButton } from '../ui';
import {
  moneyMicros,
  privateWorkspaceHeaders,
  hasWorkspaceAuthority,
  type PrivateWorkspaceAuthority,
} from './activity-view';
import styles from './operations.module.css';

const eventTypes = [
  'generation.completed',
  'billing.settled',
  'alert.triggered',
  'alert.resolved',
] as const;
type EventType = (typeof eventTypes)[number];
type Subscription = {
  id: string;
  name: string;
  url: string;
  event_types: EventType[];
  enabled: boolean;
  created_at: string;
};
type Delivery = {
  id: string;
  event_id: string;
  subscription_id: string;
  status: string;
  attempt_count: number;
  last_status_code: number | null;
  last_error_code: string | null;
  updated_at: string;
  type: EventType;
};
type AlertSettings = {
  enabled: boolean;
  low_balance_micros: number | string | null;
  spending_limit_micros: number | string | null;
  key_expiry_hours: number | null;
  webhook_failures: boolean;
};
type Alert = {
  alert_key: string;
  active: boolean;
  data: Record<string, unknown>;
  updated_at: string;
};
type Notification = {
  id: string;
  type: 'alert.triggered' | 'alert.resolved';
  createdAt: string;
  readAt: string | null;
  data: Record<string, unknown>;
};
type Preferences = {
  inApp: boolean;
  eventTypes: ('alert.triggered' | 'alert.resolved')[];
  email: boolean;
  emailRecipient?: string | null;
  recipientVerified?: boolean;
  emailAvailable: boolean;
};
interface OperationsProps {
  workspaceId: string | null;
  membershipId?: string | null;
  recoveryScope?: string | null;
  permissions: readonly string[];
}

async function requestForWorkspace<T>(
  authority: PrivateWorkspaceAuthority,
  path: string,
  signal: AbortSignal,
  method = 'GET',
  input?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    cache: 'no-store',
    signal,
    headers: {
      ...privateWorkspaceHeaders(authority),
      ...(input === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : (body.error?.message ?? 'The request could not be completed.'),
    );
  return body.data ?? body;
}
function useOperationRequest({ workspaceId, recoveryScope }: PrivateWorkspaceAuthority) {
  return useCallback(
    async <T,>(path: string, signal: AbortSignal, method = 'GET', input?: unknown): Promise<T> =>
      requestForWorkspace<T>({ workspaceId, recoveryScope }, path, signal, method, input),
    [workspaceId, recoveryScope],
  );
}
/** Re-keying also removes one-time secrets before another identity can render. */
export function WorkspaceOperations(props: OperationsProps) {
  if (!props.workspaceId) return null;
  if (!hasWorkspaceAuthority(props))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading private operations.
      </p>
    );
  return (
    <OperationViews
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
function OperationViews(props: OperationsProps) {
  const canManage = props.permissions.includes('webhooks:write');
  const canNotify = props.permissions.includes('read') && Boolean(props.membershipId);
  const [view, setView] = useState<'webhooks' | 'alerts' | 'notifications'>(
    canManage ? 'webhooks' : 'notifications',
  );
  if (!canManage && !canNotify)
    return (
      <p className="detail-note">
        Webhook settings require workspace administration permission. Personal notifications require
        an active workspace membership.
      </p>
    );
  const tabs = [
    ...(canManage ? (['webhooks', 'alerts'] as const) : []),
    ...(canNotify ? (['notifications'] as const) : []),
  ];
  return (
    <section className={styles.section} aria-label="Workspace operations">
      <nav className={styles.tabs} aria-label="Operations sections">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-current={tab === view ? 'page' : undefined}
            onClick={() => setView(tab)}
          >
            {tab === 'webhooks' ? 'Webhooks' : tab === 'alerts' ? 'Alerts' : 'Your notifications'}
          </button>
        ))}
      </nav>
      {view === 'webhooks' && canManage ? (
        <Webhooks authority={props} />
      ) : view === 'alerts' && canManage ? (
        <Alerts authority={props} />
      ) : canNotify ? (
        <Notifications authority={props} />
      ) : null}
    </section>
  );
}
function useActions() {
  const active = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      controller.current?.abort();
    };
  }, []);
  async function act(operation: (signal: AbortSignal) => Promise<string | void>) {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await operation(pending.signal);
      if (active.current) {
        setNotice(next ?? 'Saved.');
        setRefresh((n) => n + 1);
      }
    } catch (cause) {
      if (active.current && !pending.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'The request could not be completed.');
    } finally {
      controller.current = null;
      if (active.current) setBusy(false);
    }
  }
  return { busy, error, notice, refresh, setRefresh, setError, act };
}
function Messages({ error, notice }: { error: string; notice: string }) {
  return (
    <>
      {error && (
        <p className="error-notice" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="recovery-notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
function EventSelector({
  selected,
  setSelected,
  disabled = false,
}: {
  selected: EventType[];
  setSelected: (types: EventType[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className={styles.checks} disabled={disabled}>
      <legend>Subscribed events</legend>
      {eventTypes.map((type) => (
        <label key={type}>
          <input
            type="checkbox"
            checked={selected.includes(type)}
            onChange={(event) =>
              setSelected(
                event.target.checked
                  ? [...selected, type]
                  : selected.filter((value) => value !== type),
              )
            }
          />
          {type}
        </label>
      ))}
    </fieldset>
  );
}
function Webhooks({ authority }: { authority: PrivateWorkspaceAuthority }) {
  const request = useOperationRequest(authority);
  const state = useActions();
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selectedEvents, setSelectedEvents] = useState<EventType[]>([
    'generation.completed',
    'billing.settled',
  ]);
  const [editing, setEditing] = useState<string | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      request<Subscription[]>('/api/webhooks', controller.signal),
      request<Delivery[]>('/api/webhook-deliveries', controller.signal),
    ])
      .then(([nextSubscriptions, nextDeliveries]) => {
        if (!controller.signal.aborted) {
          setSubscriptions(nextSubscriptions);
          setDeliveries(nextDeliveries);
          state.setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          state.setError(cause instanceof Error ? cause.message : 'Webhooks could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [state.refresh, request]);
  function resetForm() {
    setEditing(null);
    setName('');
    setUrl('');
    setSelectedEvents(['generation.completed', 'billing.settled']);
    setCancelPending(false);
  }
  return (
    <>
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">SIGNED EVENTS</span>
          <h2>Connect your workflow.</h2>
          <p>
            Generation completion and billing settlement are separate events. Delivery uses your
            private, signed outbox.
          </p>
        </div>
        <a className="text-link" href="/docs#events">
          Verify signatures ↗
        </a>
      </div>
      <Messages error={state.error} notice={state.notice} />
      {secret && (
        <aside className={styles.secret} aria-label="One-time webhook secret">
          <strong>Save the secret for {secret.name}.</strong>
          <p>This secret is shown once. Store it in your server’s secret manager.</p>
          <div className={styles.secretValue}>
            <code>{secret.value}</code>
            <CopyButton text={secret.value} label="Copy secret" />
          </div>
          <button type="button" className="text-link" onClick={() => setSecret(null)}>
            I’ve saved this secret
          </button>
        </aside>
      )}
      <div className={styles.split}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void state.act(async (signal) => {
              if (editing) {
                await request(`/api/webhooks/${encodeURIComponent(editing)}`, signal, 'PATCH', {
                  name: name.trim(),
                  url,
                  eventTypes: selectedEvents,
                  pending: 'cancel',
                });
                resetForm();
                return 'Endpoint updated. Queued retries were cancelled; new events use the updated settings.';
              }
              const result = await request<Subscription & { secret: string }>(
                '/api/webhooks',
                signal,
                'POST',
                { name: name.trim(), url, eventTypes: selectedEvents },
              );
              if (!signal.aborted) {
                setSecret({ name: result.name, value: result.secret });
                resetForm();
              }
              return 'Webhook created. Save the secret before leaving this view.';
            });
          }}
        >
          <h3>{editing ? 'Edit endpoint' : 'New endpoint'}</h3>
          <label>
            Name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Production workflow"
              disabled={state.busy}
            />
          </label>
          <label>
            Public endpoint URL
            <input
              required
              type="url"
              maxLength={2048}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://your-app.example/events"
              disabled={state.busy}
            />
          </label>
          <EventSelector
            selected={selectedEvents}
            setSelected={setSelectedEvents}
            disabled={state.busy}
          />
          {editing && (
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={cancelPending}
                onChange={(event) => setCancelPending(event.target.checked)}
              />
              Cancel queued events and retries for this endpoint. Updates are blocked while a
              delivery is in progress.
            </label>
          )}
          <div className={styles.actions}>
            <button
              type="submit"
              className="button button-dark button-sm"
              disabled={
                state.busy ||
                Boolean(secret) ||
                !name.trim() ||
                !selectedEvents.length ||
                Boolean(editing && !cancelPending)
              }
            >
              {state.busy ? 'Saving…' : editing ? 'Save endpoint' : 'Create webhook'}
            </button>
            {editing && (
              <button type="button" className="text-link" disabled={state.busy} onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>
          <p className="detail-note">
            Disabling cancels queued deliveries and retries. A request already sent may still
            arrive. Enabling resumes new events and does not replay cancelled events.
          </p>
        </form>
        <div className={styles.records} aria-busy={loading}>
          {loading && <p role="status">Loading endpoints…</p>}
          {subscriptions.map((subscription) => (
            <article key={subscription.id} className={styles.record}>
              <div className={styles.recordHeading}>
                <h3>{subscription.name}</h3>
                <span className={styles.status}>
                  {subscription.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <p className={styles.endpoint}>{subscription.url}</p>
              <small>{subscription.event_types.join(' · ')}</small>
              <div className={styles.actions}>
                <button
                  className="button button-outline button-sm"
                  disabled={state.busy || Boolean(secret)}
                  onClick={() => {
                    setEditing(subscription.id);
                    setName(subscription.name);
                    setUrl(subscription.url);
                    setSelectedEvents(subscription.event_types);
                    setCancelPending(false);
                  }}
                >
                  Edit
                </button>
                <button
                  className="button button-outline button-sm"
                  disabled={state.busy}
                  onClick={() =>
                    void state.act(async (signal) => {
                      await request(
                        `/api/webhooks/${encodeURIComponent(subscription.id)}`,
                        signal,
                        'PATCH',
                        { enabled: !subscription.enabled },
                      );
                      return subscription.enabled
                        ? 'Webhook disabled. Queued retries cancelled; an already-sent request may still arrive.'
                        : 'Webhook enabled for new events.';
                    })
                  }
                >
                  {subscription.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  className="text-link"
                  disabled={state.busy || Boolean(secret)}
                  onClick={() =>
                    void state.act(async (signal) => {
                      const result = await request<{ secret: string }>(
                        `/api/webhooks/${encodeURIComponent(subscription.id)}/rotate-secret`,
                        signal,
                        'POST',
                      );
                      if (!signal.aborted)
                        setSecret({ name: subscription.name, value: result.secret });
                      return 'Secret rotated. Update your receiver immediately; future deliveries use the new secret.';
                    })
                  }
                >
                  Rotate secret
                </button>
              </div>
            </article>
          ))}
          {!loading && !subscriptions.length && (
            <p>No endpoints yet. Add one to receive signed events.</p>
          )}
        </div>
      </div>
      <div className={styles.heading}>
        <div>
          <h3>Delivery history</h3>
          <p>Up to 100 recent deliveries. Retries retain the same event ID.</p>
        </div>
        <button
          className="button button-outline button-sm"
          disabled={loading || state.busy}
          onClick={() => state.setRefresh((n) => n + 1)}
        >
          Refresh history
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Event</th>
              <th>Endpoint</th>
              <th>Delivery</th>
              <th>Attempts / response</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <td>
                  <strong>{delivery.type}</strong>
                  <code>{delivery.event_id}</code>
                  <small>{new Date(delivery.updated_at).toLocaleString()}</small>
                </td>
                <td>
                  {subscriptions.find((item) => item.id === delivery.subscription_id)?.name ??
                    delivery.subscription_id}
                </td>
                <td>
                  {delivery.status}
                  <small>{delivery.last_error_code}</small>
                </td>
                <td>
                  {delivery.attempt_count} attempt{delivery.attempt_count === 1 ? '' : 's'}
                  <small>
                    {delivery.last_status_code === null
                      ? 'No HTTP response recorded'
                      : `HTTP ${delivery.last_status_code}`}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && !deliveries.length && <p className={styles.empty}>No deliveries recorded.</p>}
      </div>
    </>
  );
}
const defaultAlerts: AlertSettings = {
  enabled: false,
  low_balance_micros: null,
  spending_limit_micros: null,
  key_expiry_hours: null,
  webhook_failures: false,
};
function Alerts({ authority }: { authority: PrivateWorkspaceAuthority }) {
  const request = useOperationRequest(authority);
  const state = useActions();
  const [settings, setSettings] = useState<AlertSettings>(defaultAlerts);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      request<AlertSettings>('/api/alerts/settings', controller.signal),
      request<Alert[]>('/api/alerts', controller.signal),
    ])
      .then(([nextSettings, nextAlerts]) => {
        if (!controller.signal.aborted) {
          setSettings(nextSettings);
          setAlerts(nextAlerts);
          state.setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          state.setError(cause instanceof Error ? cause.message : 'Alerts could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [state.refresh, request]);
  return (
    <>
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">WORKSPACE HEALTH</span>
          <h2>Keep the useful signals close.</h2>
          <p>
            Alert conditions resolve when they clear. Personal read state is separate for every
            member.
          </p>
        </div>
      </div>
      <Messages error={state.error} notice={state.notice} />
      <div className={styles.split}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void state.act(async (signal) => {
              await request('/api/alerts/settings', signal, 'PUT', {
                enabled: settings.enabled,
                lowBalanceMicros:
                  settings.low_balance_micros === null ? null : Number(settings.low_balance_micros),
                spendingLimitMicros:
                  settings.spending_limit_micros === null
                    ? null
                    : Number(settings.spending_limit_micros),
                keyExpiryHours: settings.key_expiry_hours,
                webhookFailures: settings.webhook_failures,
              });
              return 'Workspace alert settings saved.';
            });
          }}
        >
          <fieldset disabled={state.busy || loading} className={styles.fieldset}>
            <legend>Alert settings</legend>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(event) =>
                  setSettings((value) => ({ ...value, enabled: event.target.checked }))
                }
              />
              Enable workspace alerts
            </label>
            <MoneyInput
              label="Low balance, USD"
              value={settings.low_balance_micros}
              onChange={(value) =>
                setSettings((current) => ({ ...current, low_balance_micros: value }))
              }
            />
            <MoneyInput
              label="Settled spend in 24 hours, USD"
              value={settings.spending_limit_micros}
              onChange={(value) =>
                setSettings((current) => ({ ...current, spending_limit_micros: value }))
              }
            />
            <label>
              Key expiry warning, hours
              <input
                type="number"
                min={1}
                max={720}
                step={1}
                value={settings.key_expiry_hours ?? ''}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    key_expiry_hours: event.target.value ? Number(event.target.value) : null,
                  }))
                }
                placeholder="Disabled"
              />
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={settings.webhook_failures}
                onChange={(event) =>
                  setSettings((value) => ({ ...value, webhook_failures: event.target.checked }))
                }
              />
              Alert when webhook delivery fails
            </label>
            <button type="submit" className="button button-dark button-sm">
              {state.busy ? 'Saving…' : 'Save alert settings'}
            </button>
          </fieldset>
        </form>
        <div className={styles.records} aria-busy={loading}>
          {loading && <p role="status">Loading alerts…</p>}
          {alerts.map((alert) => (
            <article className={styles.record} key={alert.alert_key}>
              <div className={styles.recordHeading}>
                <h3>{alertTitle(alert.data, alert.alert_key)}</h3>
                <span className={styles.status}>{alert.active ? 'Active' : 'Resolved'}</span>
              </div>
              <AlertEvidence data={alert.data} />
              <small>{new Date(alert.updated_at).toLocaleString()}</small>
            </article>
          ))}
          {!loading && !alerts.length && <p>No alert conditions recorded.</p>}
        </div>
      </div>
    </>
  );
}
function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | string | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min="0"
        max="9007199254"
        step="0.000001"
        value={value === null ? '' : Number(value) / 1_000_000}
        onChange={(event) => {
          const next =
            event.target.value === '' ? null : Math.round(Number(event.target.value) * 1_000_000);
          if (next === null || Number.isSafeInteger(next)) onChange(next);
        }}
        placeholder="Disabled"
      />
    </label>
  );
}
function alertTitle(data: Record<string, unknown>, fallback: string): string {
  return data.kind === 'low_balance'
    ? 'Credit is running low'
    : data.kind === 'spending'
      ? 'Spending threshold reached'
      : data.kind === 'key_expiry'
        ? 'An API key is nearing expiry'
        : data.kind === 'webhook_delivery'
          ? 'Webhook delivery needs attention'
          : fallback === 'balance'
            ? 'Balance alert'
            : 'Workspace alert';
}
/** Only explicitly safe fields are rendered, never an arbitrary event-data dump. */
function AlertEvidence({ data }: { data: Record<string, unknown> }) {
  const rows: ReactNode[] = [];
  for (const [field, label] of [
    ['availableMicros', 'Available'],
    ['spentMicros', 'Settled spend'],
    ['thresholdMicros', 'Threshold'],
  ] as const)
    if (typeof data[field] === 'number' && Number.isSafeInteger(data[field]))
      rows.push(
        <p key={field}>
          {label}: {moneyMicros(data[field] as number)}
        </p>,
      );
  if (data.reason === 'condition_cleared')
    rows.push(<p key="reason">The condition has cleared.</p>);
  if (data.reason === 'alerts_disabled')
    rows.push(<p key="reason">Workspace alerts were disabled.</p>);
  return <>{rows}</>;
}
function Notifications({ authority }: { authority: PrivateWorkspaceAuthority }) {
  const request = useOperationRequest(authority);
  const state = useActions();
  const [items, setItems] = useState<Notification[]>([]);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setItems([]);
    Promise.all([
      request<{ items: Notification[]; nextCursor: string | null }>(
        `/api/notifications?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        controller.signal,
      ),
      request<Preferences>('/api/notifications/preferences', controller.signal),
    ])
      .then(([page, nextPreferences]) => {
        if (!controller.signal.aborted) {
          setItems(page.items);
          setNextCursor(page.nextCursor);
          setPreferences(nextPreferences);
          state.setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          state.setError(
            cause instanceof Error ? cause.message : 'Notifications could not be loaded.',
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [state.refresh, cursor, request]);
  return (
    <>
      <div className={styles.heading}>
        <div>
          <span className="eyebrow">JUST FOR YOU</span>
          <h2>Your workspace notifications.</h2>
          <p>Marking a notification read changes only your read state in this workspace.</p>
        </div>
        <button
          className="button button-outline button-sm"
          disabled={loading || state.busy}
          onClick={() => state.setRefresh((n) => n + 1)}
        >
          Refresh
        </button>
      </div>
      <Messages error={state.error} notice={state.notice} />
      <div className={styles.split}>
        <div className={styles.records} aria-busy={loading}>
          {loading && <p role="status">Loading notifications…</p>}
          {items.map((item) => (
            <article key={item.id} className={styles.record}>
              <div className={styles.recordHeading}>
                <h3>{alertTitle(item.data, String(item.data.alertKey ?? ''))}</h3>
                <span className={styles.status}>
                  {item.readAt ? 'Read' : 'Unread'} ·{' '}
                  {item.type === 'alert.resolved' ? 'Resolved' : 'Triggered'}
                </span>
              </div>
              <AlertEvidence data={item.data} />
              <small>{new Date(item.createdAt).toLocaleString()}</small>
              {!item.readAt && (
                <button
                  className="text-link"
                  disabled={state.busy}
                  onClick={() =>
                    void state.act(async (signal) => {
                      await request(
                        `/api/notifications/${encodeURIComponent(item.id)}/read`,
                        signal,
                        'POST',
                      );
                      return 'Notification marked read for you.';
                    })
                  }
                >
                  Mark read
                </button>
              )}
            </article>
          ))}
          {!loading && !items.length && <p>No notifications in this view.</p>}
          <div className={styles.actions}>
            <button
              className="button button-outline button-sm"
              disabled={loading || !previous.length}
              onClick={() => {
                setCursor(previous.at(-1) ?? null);
                setPrevious((current) => current.slice(0, -1));
              }}
            >
              Newer
            </button>
            <button
              className="button button-outline button-sm"
              disabled={loading || !nextCursor}
              onClick={() => {
                setPrevious((current) => [...current, cursor]);
                setCursor(nextCursor);
              }}
            >
              Older
            </button>
          </div>
        </div>
        {preferences && (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void state.act(async (signal) => {
                await request('/api/notifications/preferences', signal, 'PUT', {
                  inApp: preferences.inApp,
                  eventTypes: preferences.eventTypes,
                  email: preferences.email,
                });
                return 'Your notification preferences saved.';
              });
            }}
          >
            <fieldset className={styles.fieldset} disabled={state.busy}>
              <legend>Your preferences</legend>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={preferences.inApp}
                  onChange={(event) =>
                    setPreferences(
                      (current) => current && { ...current, inApp: event.target.checked },
                    )
                  }
                />
                Show in-app notifications
              </label>
              {(['alert.triggered', 'alert.resolved'] as const).map((type) => (
                <label key={type} className={styles.check}>
                  <input
                    type="checkbox"
                    checked={preferences.eventTypes.includes(type)}
                    onChange={(event) =>
                      setPreferences(
                        (current) =>
                          current && {
                            ...current,
                            eventTypes: event.target.checked
                              ? [...current.eventTypes, type]
                              : current.eventTypes.filter((value) => value !== type),
                          },
                      )
                    }
                  />
                  {type === 'alert.triggered'
                    ? 'New alert conditions'
                    : 'Resolved alert conditions'}
                </label>
              ))}
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={preferences.email}
                  disabled={!preferences.emailAvailable}
                  onChange={(event) =>
                    setPreferences(
                      (current) => current && { ...current, email: event.target.checked },
                    )
                  }
                />
                Email operational alerts
                {preferences.emailRecipient ? ` to ${preferences.emailRecipient}` : ''}
              </label>
              <p className="detail-note">
                {preferences.emailAvailable
                  ? 'Email contains only a short notice and a sign-in link. Queued retries stop when you disable it; an already sent request may still arrive.'
                  : 'Email notifications are not enabled here. A configured relay and your verified sign-in address are required for this membership.'}
              </p>
              <button className="button button-dark button-sm" type="submit">
                {state.busy ? 'Saving…' : 'Save preferences'}
              </button>
            </fieldset>
          </form>
        )}
      </div>
    </>
  );
}
