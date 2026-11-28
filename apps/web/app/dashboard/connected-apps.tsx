'use client';
import { useEffect, useRef, useState } from 'react';
import { ApiResponseError, readApiJson } from './api-response';
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
        const next = await readApiJson<Grant[]>(
          response,
          'Connected apps could not be loaded. Try refreshing.',
          {
            signal: controller.signal,
            onError: ({ status, code }) => {
              if (status === 409 && code === 'browser_authority_changed')
                notifyBrowserSessionChanged();
            },
          },
        );
        if (!controller.signal.aborted) {
          setGrants(next);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(
            cause instanceof ApiResponseError
              ? cause.message
              : 'Connected apps could not be loaded. Try refreshing.',
          );
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
      await readApiJson<unknown>(
        response,
        'Authorization could not be revoked. Please try again.',
        {
          signal: controller.signal,
          onError: ({ status, code }) => {
            if (active.current && status === 409 && code === 'browser_authority_changed')
              notifyBrowserSessionChanged();
          },
        },
      );
      if (!active.current) return;
      setNotice('App authorization revoked. Connect again from the app if you need access later.');
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(
          cause instanceof ApiResponseError
            ? cause.message
            : 'Authorization could not be revoked. Please try again.',
        );
    } finally {
      mutation.current = null;
      if (active.current) setBusy('');
    }
  }
  return (
    <section className="workspace-settings" aria-label="Connected apps">
      <div className="settings-section-heading apps-section-header">
        <div>
          <h2>Your connected apps.</h2>
          <p>
            Review the apps authorized for this workspace. Revoking an app stops its access and
            refresh tokens; it does not cancel accepted generations. API keys are managed
            separately.
          </p>
        </div>
        <div className="apps-header-actions">
          <a href="/agents" className="button button-outline button-sm">
            Connect an agent ↗
          </a>
          <button
            className="button button-outline button-sm"
            disabled={loading || Boolean(busy)}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Refresh apps
          </button>
        </div>
      </div>
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
      {loading && (
        <p className="detail-note" role="status">
          Loading app authorizations…
        </p>
      )}
      {grants.length > 0 && (
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
      )}
      {!loading && !grants.length && (
        <div className="workspace-empty">
          <h3>No connected apps yet.</h3>
          <p>Start with your agent’s setup guide to authorize Claude Code, Codex, or Cursor.</p>
          <a href="/agents" className="text-link">
            Open agent setup guide ↗
          </a>
        </div>
      )}
    </section>
  );
}
