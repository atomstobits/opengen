'use client';
import { useEffect, useRef, useState } from 'react';
import { hasWorkspaceAuthority, privateWorkspaceHeaders } from './activity-view';
import { notifyBrowserSessionChanged } from '../gateway-access';
type Grant = {
  id: string;
  client_name: string;
  scopes: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
interface AppsProps {
  workspaceId?: string | null;
  recoveryScope?: string | null;
  permissions?: readonly string[];
}
export function ConnectedApps(props: AppsProps = {}) {
  const authority = { workspaceId: props.workspaceId ?? null, recoveryScope: props.recoveryScope };
  if (!hasWorkspaceAuthority(authority))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading connected apps.
      </p>
    );
  if (!props.permissions?.includes('read'))
    return <p className="detail-note">Read permission is required to review connected apps.</p>;
  return (
    <AppAuthorizations
      key={JSON.stringify([
        authority.workspaceId,
        authority.recoveryScope,
        [...props.permissions].sort(),
      ])}
      workspaceId={authority.workspaceId}
      recoveryScope={authority.recoveryScope}
    />
  );
}
function AppAuthorizations({
  workspaceId,
  recoveryScope,
}: {
  workspaceId: string;
  recoveryScope: string;
}) {
  const active = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      mutation.current?.abort();
    };
  }, []);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch('/api/oauth/grants', {
      cache: 'no-store',
      signal: controller.signal,
      headers: privateWorkspaceHeaders({ workspaceId, recoveryScope }),
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          if (response.status === 409 && data.error?.code === 'browser_authority_changed')
            notifyBrowserSessionChanged();
          throw new Error('Connected apps could not be loaded. Try refreshing.');
        }
        if (!controller.signal.aborted) {
          setGrants(data.data ?? data);
          setError('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('Connected apps could not be loaded. Try refreshing.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, workspaceId, recoveryScope]);
  async function revoke(id: string) {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(id);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/oauth/grants/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        cache: 'no-store',
        signal: controller.signal,
        headers: privateWorkspaceHeaders({ workspaceId, recoveryScope }),
      });
      controller.signal.throwIfAborted();
      if (!active.current) return;
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        if (response.status === 409 && body.error?.code === 'browser_authority_changed')
          notifyBrowserSessionChanged();
        throw new Error('Authorization could not be revoked. Please try again.');
      }
      setNotice('App authorization revoked. Connect again from the app if you need access later.');
      setRefresh((value) => value + 1);
    } catch {
      if (active.current && !controller.signal.aborted)
        setError('Authorization could not be revoked. Please try again.');
    } finally {
      mutation.current = null;
      if (active.current) setBusy('');
    }
  }
  return (
    <section className="workspace-settings" aria-label="Connected apps">
      <div className="settings-section-heading">
        <h2>Your connected apps.</h2>
        <p>
          Review the apps authorized for this workspace. Revoking an app stops its access and
          refresh tokens; it does not cancel accepted generations. API keys are managed separately.
        </p>
      </div>
      <a href="/agents" className="text-link">
        Connect an agent ↗
      </a>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading app authorizations…</p>}
      <div className="settings-records">
        {grants.map((grant) => (
          <article key={grant.id}>
            <div>
              <strong>{grant.client_name}</strong>
              <p>{grant.scopes.join(' · ')}</p>
              <small>
                {grant.revoked_at
                  ? 'Revoked'
                  : `Expires ${new Date(grant.expires_at).toLocaleString()}`}
              </small>
            </div>
            {!grant.revoked_at && (
              <button
                className="button button-outline button-sm"
                disabled={Boolean(busy)}
                onClick={() => revoke(grant.id)}
                aria-label={`Revoke ${grant.client_name}`}
              >
                {busy === grant.id ? 'Revoking…' : 'Revoke access'}
              </button>
            )}
          </article>
        ))}
      </div>
      {!loading && !grants.length && (
        <p>No connected apps yet. Start with your agent’s setup guide.</p>
      )}
      <button
        className="button button-outline button-sm"
        disabled={loading || Boolean(busy)}
        onClick={() => setRefresh((value) => value + 1)}
      >
        Refresh apps
      </button>
    </section>
  );
}
