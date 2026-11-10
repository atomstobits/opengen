'use client';
import { useCallback, useEffect, useState } from 'react';
import { GatewayAccess } from '../../gateway-access';
import { useLegalPresentation } from '../../legal/presentation';
import { Icon } from '../../ui';
import styles from './consent.module.css';

interface View {
  client: { id: string; name: string; redirectOrigin: string };
  requestedScopes: ('read' | 'generate')[];
  availableScopes: ('read' | 'generate')[];
  workspaces: { id: string; name: string; role: string | null }[];
  resource: string;
}
const permissionCopy = {
  read: {
    title: 'Read workspace activity',
    description: 'View jobs, balance and the model catalog.',
  },
  generate: {
    title: 'Generate images and video',
    description: 'Submit billable generations using this workspace’s credit.',
  },
};

export function McpConsent({
  requestId,
  initialNeedsLogin = false,
}: {
  requestId: string;
  initialNeedsLogin?: boolean;
}) {
  const legal = useLegalPresentation();
  const [view, setView] = useState<View | null>(null),
    [workspace, setWorkspace] = useState('');
  const [selected, setSelected] = useState<('read' | 'generate')[]>([]),
    [confirmed, setConfirmed] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(initialNeedsLogin),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);
  const onSession = useCallback((authenticated: boolean) => {
    if (authenticated) setSessionVersion((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setError('');
    setConfirmed(false);
    if (!/^og_req_[A-Za-z0-9_-]{43}$/.test(requestId)) {
      setError('This authorization link is invalid. Start again from your agent.');
      return;
    }
    fetch(`/api/oauth/consent?request=${encodeURIComponent(requestId)}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (controller.signal.aborted) return;
        if (response.status === 401) {
          setNeedsLogin(true);
          setLoginUrl(typeof data.loginUrl === 'string' ? data.loginUrl : null);
          return;
        }
        if (response.status === 403) setNeedsLogin(true);
        if (!response.ok)
          throw new Error(
            data.error_description ?? data.error?.message ?? 'Authorization could not be loaded.',
          );
        setNeedsLogin(false);
        setView(data);
        setWorkspace(data.workspaces[0]?.id ?? '');
        setSelected(data.availableScopes);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Authorization is unavailable.');
      });
    return () => controller.abort();
  }, [requestId, sessionVersion]);
  async function decide(approve: boolean) {
    if (!view || !workspace || (approve && (!confirmed || !selected.length))) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/oauth/consent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, workspaceId: workspace, scopes: selected, approve }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error_description ?? 'Authorization could not be completed.');
      const target = new URL(result.redirectTo);
      // The server validated the full registered URI; the UI additionally binds the displayed origin.
      if (target.origin !== view.client.redirectOrigin)
        throw new Error('The client redirect changed. Start again from your agent.');
      window.location.assign(target.href);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authorization could not be completed.');
      setBusy(false);
    }
  }
  return (
    <main className={styles.page} aria-labelledby="consent-title">
      <div className={styles.layout}>
        <header className={styles.intro}>
          <a className={styles.brand} href="/">
            OpenGen
          </a>
          <span className={styles.eyebrow}>Workspace authorization</span>
          <h1 id="consent-title">Connect your agent.</h1>
          <p>Choose a workspace, then review what this client can do on your behalf.</p>
          <div className={styles.assurance}>
            <span className={styles.assuranceMark} aria-hidden="true">
              <Icon name="check" size={15} />
            </span>
            <span>
              Your provider credentials stay on OpenGen. You can revoke access in Connected apps.
            </span>
          </div>
        </header>

        <div className={styles.request}>
          {needsLogin && (
            <section className={styles.card} aria-labelledby="sign-in-title">
              <span className={styles.eyebrow}>Account access</span>
              <h2 id="sign-in-title">Sign in to continue</h2>
              <p className="legal-review-links">
                {legal.mode === 'published' ? (
                  <>
                    Review our <a href="/terms">Terms of Service</a> and{' '}
                    <a href="/privacy">Privacy Notice</a>.
                  </>
                ) : legal.mode === 'staged' ? (
                  <>
                    Policies: <a href="/terms">Terms of Service</a> and{' '}
                    <a href="/privacy">Privacy Notice</a>. Scheduled effective {legal.effectiveAt} —
                    not yet effective.
                  </>
                ) : (
                  <>
                    Proposed policies: <a href="/terms">Terms</a> and <a href="/privacy">Privacy</a>
                    . Not yet effective.
                  </>
                )}
              </p>
              {loginUrl ? (
                <a className="button button-dark" href={loginUrl}>
                  Sign in with your account
                </a>
              ) : (
                <p>Connect a scoped workspace key to continue on this installation.</p>
              )}
              <details className={styles.fallback}>
                <summary>Connect a self-hosted workspace key</summary>
                <GatewayAccess
                  onChange={onSession}
                  loginUrl={`/oauth/login?request=${encodeURIComponent(requestId)}`}
                />
              </details>
            </section>
          )}
          {view && (
            <section className={styles.card} aria-label="Agent authorization">
              <div className={styles.client}>
                <span className={styles.clientMark} aria-hidden="true">
                  {view.client.name.trim().slice(0, 1).toUpperCase() || 'A'}
                </span>
                <div>
                  <span className={styles.eyebrow}>Requesting access</span>
                  <h2>{view.client.name}</h2>
                  <p className={styles.origin}>Client origin: {view.client.redirectOrigin}</p>
                </div>
              </div>
              <label className={styles.workspace}>
                <span>Paying workspace</span>
                <select
                  value={workspace}
                  disabled={busy}
                  onChange={(event) => {
                    setWorkspace(event.target.value);
                    setConfirmed(false);
                  }}
                >
                  {view.workspaces.length === 0 && (
                    <option value="">No workspaces available</option>
                  )}
                  {view.workspaces.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} ({item.role ?? 'workspace key'})
                    </option>
                  ))}
                </select>
              </label>
              <fieldset className={styles.permissions} disabled={busy}>
                <legend>Permissions</legend>
                {view.requestedScopes.map((scope) => (
                  <label className={styles.permission} key={scope}>
                    <input
                      type="checkbox"
                      checked={selected.includes(scope)}
                      disabled={!view.availableScopes.includes(scope)}
                      onChange={(event) => {
                        setSelected((values) =>
                          event.target.checked
                            ? [...values, scope]
                            : values.filter((value) => value !== scope),
                        );
                        setConfirmed(false);
                      }}
                    />
                    <span>
                      <strong>{permissionCopy[scope].title}</strong>
                      <small>{permissionCopy[scope].description}</small>
                    </span>
                    {scope === 'generate' && <span className={styles.billable}>Billable</span>}
                  </label>
                ))}
              </fieldset>
              <p className={styles.note}>
                Workspace budgets and regional restrictions still apply.
              </p>
              <label className={styles.confirmation}>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>
                  I trust this client and authorize the selected permissions for this workspace.
                </span>
              </label>
              <div className={styles.actions}>
                <button
                  type="button"
                  className="button button-outline"
                  onClick={() => decide(false)}
                  disabled={busy || !workspace}
                >
                  Deny
                </button>
                <button
                  type="button"
                  className="button button-dark"
                  onClick={() => decide(true)}
                  disabled={busy || !workspace || !confirmed || !selected.length}
                >
                  Authorize client <Icon name="arrow" size={16} />
                </button>
              </div>
            </section>
          )}
          {!view && !needsLogin && !error && (
            <section className={styles.card}>
              <p role="status">Loading authorization…</p>
            </section>
          )}
          {error && (
            <p className="error-notice" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
