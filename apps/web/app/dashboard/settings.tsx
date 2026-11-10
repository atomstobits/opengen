'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { catalog } from '@media-router/catalog';
import { keyScopes as permissionScopes, type RoutingPolicy } from '@media-router/contracts';
import { CopyButton } from '../ui';
import { notifyBrowserSessionChanged } from '../gateway-access';
import {
  hasWorkspaceAuthority,
  privateWorkspaceHeaders,
  type PrivateWorkspaceAuthority,
} from './activity-view';

type SavedPolicy = {
  id: string;
  name: string;
  policy: RoutingPolicy;
  max_cost_micros: string | null;
};
type ApiKey = {
  id: string;
  name: string;
  scopes: string[];
  policy_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};
type Connection = { deployment_id: string; created_at: string };
const scopes = permissionScopes;
async function requestForAuthority<T>(
  authority: PrivateWorkspaceAuthority,
  path: string,
  method = 'GET',
  input?: unknown,
  signal?: AbortSignal,
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
  signal?.throwIfAborted();
  if (!response.ok) {
    if (response.status === 409 && body.error?.code === 'browser_authority_changed')
      notifyBrowserSessionChanged();
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : (body.error?.message ?? 'The gateway could not complete this request.'),
    );
  }
  return body.data ?? body;
}

interface SettingsProps {
  permissions?: readonly string[];
  workspaceId?: string;
  recoveryScope?: string | null;
  keysOnly?: boolean;
}
export function WorkspaceSettings(props: SettingsProps = {}) {
  const authority = { workspaceId: props.workspaceId ?? null, recoveryScope: props.recoveryScope };
  if (!hasWorkspaceAuthority(authority))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading private settings.
      </p>
    );
  if (
    !props.permissions?.some((scope) =>
      ['keys:write', 'policies:write', 'connections:write'].includes(scope),
    )
  )
    return (
      <p className="detail-note">
        Your workspace administrator manages keys, routing profiles and provider connections.
      </p>
    );
  return (
    <SettingsRecords
      key={JSON.stringify([
        authority.workspaceId,
        authority.recoveryScope,
        [...props.permissions].sort(),
        props.keysOnly,
      ])}
      {...props}
    />
  );
}
function SettingsRecords({
  permissions,
  workspaceId,
  recoveryScope,
  keysOnly = false,
}: SettingsProps) {
  const active = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      mutation.current?.abort();
    };
  }, []);
  const request = useCallback(
    async <T,>(path: string, method = 'GET', input?: unknown, signal?: AbortSignal): Promise<T> => {
      if (!active.current) throw new DOMException('Workspace authority changed.', 'AbortError');
      const pending = signal ?? mutation.current?.signal;
      const value = await requestForAuthority<T>(
        { workspaceId: workspaceId ?? null, recoveryScope },
        path,
        method,
        input,
        pending,
      );
      pending?.throwIfAborted();
      if (!active.current) throw new DOMException('Workspace authority changed.', 'AbortError');
      return value;
    },
    [workspaceId, recoveryScope],
  );
  const views = (
    [
      { id: 'keys', scope: 'keys:write' },
      { id: 'policies', scope: 'policies:write' },
      { id: 'connections', scope: 'connections:write' },
    ] as const
  ).filter(
    (view) =>
      (!keysOnly || view.id === 'keys') && (!permissions || permissions.includes(view.scope)),
  );
  const [view, setView] = useState<'keys' | 'policies' | 'connections'>(views[0]?.id ?? 'keys');
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [policies, setPolicies] = useState<SavedPolicy[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState(
    ['read', 'generate'].filter((scope) => !permissions || permissions.includes(scope)),
  );
  const [keyPolicy, setKeyPolicy] = useState('');
  const [expiryDays, setExpiryDays] = useState('30');
  const [expiresAt, setExpiresAt] = useState('');
  const [createdKeyId, setCreatedKeyId] = useState('');
  const [createdKey, setCreatedKey] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [preference, setPreference] = useState<RoutingPolicy['preference']>('cost');
  const [regions, setRegions] = useState<string[]>([]);
  const [maxCost, setMaxCost] = useState('');
  const [deployment, setDeployment] = useState(
    catalog.deployments.find((item) => item.credentialEnv)?.id ?? '',
  );
  const [apiKey, setApiKey] = useState('');
  const [providerWorkspace, setProviderWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setError('');
    const load =
      view === 'keys'
        ? Promise.all([
            request<ApiKey[]>('/api/keys', 'GET', undefined, controller.signal).then((nextKeys) => {
              if (!cancelled) setKeys(nextKeys);
            }),
            (!permissions || permissions.includes('read')
              ? request<SavedPolicy[]>('/api/policies', 'GET', undefined, controller.signal)
              : Promise.resolve([])
            ).then((nextPolicies) => {
              if (!cancelled) setPolicies(nextPolicies);
            }),
          ])
        : view === 'policies'
          ? request<SavedPolicy[]>('/api/policies', 'GET', undefined, controller.signal).then(
              (next) => {
                if (!cancelled) setPolicies(next);
              },
            )
          : request<Connection[]>('/api/connections', 'GET', undefined, controller.signal).then(
              (next) => {
                if (!cancelled) setConnections(next);
              },
            );
    load.catch((cause) => {
      if (!cancelled)
        setError(cause instanceof Error ? cause.message : 'Settings could not be loaded.');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [view, refresh, request]);
  async function act(operation: () => Promise<void>) {
    if (mutation.current) return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await operation();
      if (!active.current || controller.signal.aborted) return;
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (active.current && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : 'Settings could not be saved.');
    } finally {
      mutation.current = null;
      if (active.current) setBusy(false);
    }
  }
  const selectedDeployment = catalog.deployments.find((item) => item.id === deployment);
  const allowedScopes = scopes.filter((scope) => !permissions || permissions.includes(scope));
  const endpointRegions = [...new Set(catalog.deployments.map((item) => item.endpointRegion))];
  return (
    <section className="workspace-settings">
      <div className="settings-navigation" aria-label="Settings section">
        {views.map(({ id: value }) => (
          <button
            key={value}
            className={view === value ? 'selected' : ''}
            onClick={() => {
              setView(value);
              setError('');
              setNotice('');
              if (value !== view) setCreatedKey('');
            }}
          >
            {value === 'keys'
              ? 'API keys'
              : value === 'policies'
                ? 'Routing profiles'
                : 'Provider connections'}
          </button>
        ))}
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
      {view === 'keys' && (
        <>
          <div className="settings-section-heading">
            <h2>Keys for your applications and agents.</h2>
            <p>
              Create a separate key per workflow. Assign only the permissions and routing profile it
              needs.
            </p>
          </div>
          <p className="detail-note">
            Selected workspace: <strong>{workspaceId ?? 'current authenticated workspace'}</strong>.
            New keys stay bound to this workspace.
          </p>
          {createdKey && (
            <div className="new-key-notice">
              <strong>Your key is shown once.</strong>
              <p>
                Copy it into your application’s secret manager, then dismiss this message. It cannot
                be shown again.
              </p>
              <p>
                Workspace: <strong>{workspaceId ?? 'current authenticated workspace'}</strong>
              </p>
              <div className="command-box">
                <code>{createdKey}</code>
                <CopyButton text={createdKey} label="Copy key" />
              </div>
              <button className="text-link" onClick={() => setCreatedKey('')}>
                I’ve saved this key
              </button>
            </div>
          )}
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const result = await request<ApiKey & { token: string }>('/api/keys', 'POST', {
                  name: keyName.trim(),
                  scopes: keyScopes,
                  ...(keyPolicy ? { policyId: keyPolicy } : {}),
                  expiresAt:
                    expiryDays === 'custom'
                      ? new Date(expiresAt).toISOString()
                      : new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString(),
                });
                setCreatedKey(result.token);
                setCreatedKeyId(result.id);
                setKeyName('');
              });
            }}
          >
            <div className="field-grid">
              <label>
                Key name
                <input
                  required
                  maxLength={80}
                  value={keyName}
                  onChange={(event) => setKeyName(event.target.value)}
                  placeholder="Production agent"
                />
              </label>
              <label>
                Routing profile
                <select value={keyPolicy} onChange={(event) => setKeyPolicy(event.target.value)}>
                  <option value="">Workspace defaults</option>
                  {policies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Key expiry
              <select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days (recommended)</option>
                <option value="90">In 90 days</option>
                <option value="custom">Choose a date and time</option>
              </select>
            </label>
            {expiryDays === 'custom' && (
              <label>
                Expiry date <span className="optional">your local time</span>
                <input
                  required
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => setExpiresAt(event.target.value)}
                />
              </label>
            )}
            <p className="detail-note">
              Read and generate are the usual permissions for normal workflows. Administrative
              permissions let applications change workspace settings; grant them only when needed.
            </p>
            <fieldset>
              <legend>Permissions</legend>
              <div className="settings-checkboxes">
                {allowedScopes.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={keyScopes.includes(scope)}
                      onChange={(event) =>
                        setKeyScopes((current) =>
                          event.target.checked
                            ? [...current, scope]
                            : current.filter((value) => value !== scope),
                        )
                      }
                    />
                    {scope}
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              className="button button-dark"
              type="submit"
              disabled={
                busy ||
                Boolean(createdKey) ||
                !keyName.trim() ||
                !keyScopes.length ||
                (expiryDays === 'custom' && (!expiresAt || Date.parse(expiresAt) <= Date.now()))
              }
            >
              {busy ? 'Creating…' : 'Create API key'}
            </button>
          </form>
          <div className="settings-records">
            {keys.map((key) => (
              <article key={key.id}>
                <div>
                  <strong>{key.name}</strong>
                  <p>{key.scopes.join(' · ')}</p>
                  <small>
                    {key.revoked_at
                      ? 'Revoked'
                      : key.expires_at
                        ? `Expires ${new Date(key.expires_at).toLocaleString()}`
                        : 'No expiry'}
                  </small>
                </div>
                {!key.revoked_at && (
                  <button
                    className="button button-outline button-sm"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request(`/api/keys/${encodeURIComponent(key.id)}`, 'DELETE');
                        if (key.id === createdKeyId) setCreatedKey('');
                        setNotice('Key revoked. Sessions using that key also lose access.');
                      })
                    }
                  >
                    Revoke
                  </button>
                )}
              </article>
            ))}
            {!keys.length && <p className="detail-note">No API keys to display.</p>}
          </div>
        </>
      )}
      {view === 'policies' && (
        <>
          <div className="settings-section-heading">
            <h2>A routing profile for every workflow.</h2>
            <p>
              Restrict endpoint regions and the spending ceiling, then attach the profile to an API
              key. Individual requests can narrow these limits.
            </p>
          </div>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                const limit = maxCost.trim() ? Number(maxCost) : undefined;
                if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0))
                  throw new Error('Enter a positive spending limit.');
                await request('/api/policies', 'POST', {
                  name: policyName,
                  policy: { preference, ...(regions.length ? { endpointRegions: regions } : {}) },
                  ...(limit === undefined ? {} : { maxCostMicros: Math.round(limit * 1_000_000) }),
                });
                setPolicyName('');
                setNotice('Routing profile saved. You can now attach it to a new API key.');
              });
            }}
          >
            <div className="field-grid">
              <label>
                Profile name
                <input
                  required
                  maxLength={80}
                  value={policyName}
                  onChange={(event) => setPolicyName(event.target.value)}
                  placeholder="EU production"
                />
              </label>
              <label>
                Route preference
                <select
                  value={preference}
                  onChange={(event) =>
                    setPreference(event.target.value as RoutingPolicy['preference'])
                  }
                >
                  <option value="cost">Lowest eligible price</option>
                  <option value="speed">Lowest observed latency</option>
                  <option value="reliability">Highest observed reliability</option>
                </select>
              </label>
            </div>
            <label>
              Maximum spend per generation, USD <span className="optional">optional</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={maxCost}
                onChange={(event) => setMaxCost(event.target.value)}
                placeholder="2.00"
              />
            </label>
            <fieldset>
              <legend>
                Allowed endpoint regions <span className="optional">none selected means any</span>
              </legend>
              <div className="settings-checkboxes">
                {endpointRegions.map((region) => (
                  <label key={region}>
                    <input
                      type="checkbox"
                      checked={regions.includes(region)}
                      onChange={(event) =>
                        setRegions((current) =>
                          event.target.checked
                            ? [...current, region]
                            : current.filter((value) => value !== region),
                        )
                      }
                    />
                    {region}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="detail-note">
              An endpoint region does not guarantee inference residency. Preferences based on
              performance require observed samples.
            </p>
            <button
              className="button button-dark"
              type="submit"
              disabled={busy || !policyName.trim()}
            >
              {busy ? 'Saving…' : 'Save routing profile'}
            </button>
          </form>
          <div className="settings-records">
            {policies.map((policy) => (
              <article key={policy.id}>
                <div>
                  <strong>{policy.name}</strong>
                  <p>
                    {policy.policy.endpointRegions?.join(', ') ?? 'Any endpoint region'} ·{' '}
                    {policy.policy.preference ?? 'cost'}
                  </p>
                  <small>
                    {policy.max_cost_micros === null
                      ? 'No profile spending ceiling'
                      : `$${Number(policy.max_cost_micros) / 1_000_000} maximum per generation`}
                  </small>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
      {view === 'connections' && (
        <>
          <div className="settings-section-heading">
            <h2>Your providers. Your regional connections.</h2>
            <p className="detail-note">
              Removing a connection blocks new requests. Accepted generations retain their original
              provider account and can still finish and be billed. Cancel queued jobs first when you
              want to stop them.
            </p>
            <p>
              Credentials are encrypted by your gateway and are never returned by this page. Choose
              each regional deployment separately.
            </p>
          </div>
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void act(async () => {
                await request(`/api/connections/${encodeURIComponent(deployment)}`, 'PUT', {
                  apiKey,
                  ...(providerWorkspace.trim() ? { workspaceId: providerWorkspace.trim() } : {}),
                });
                setApiKey('');
                setProviderWorkspace('');
                setNotice(
                  'Provider connection saved. Quotes will check whether its exact routes are executable.',
                );
              });
            }}
          >
            <label>
              Regional provider deployment
              <select
                value={deployment}
                onChange={(event) => {
                  setDeployment(event.target.value);
                  setApiKey('');
                  setProviderWorkspace('');
                }}
              >
                {catalog.deployments
                  .filter((item) => item.credentialEnv)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.endpointRegion}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Provider API key
              <input
                type="password"
                required
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Stored encrypted on your gateway"
              />
            </label>
            {selectedDeployment?.providerId === 'alibaba' && (
              <label>
                Alibaba regional workspace ID
                <input
                  required
                  value={providerWorkspace}
                  onChange={(event) => setProviderWorkspace(event.target.value)}
                  placeholder="Matching this regional provider key"
                />
              </label>
            )}
            <button className="button button-dark" type="submit" disabled={busy || !apiKey.trim()}>
              {busy ? 'Saving…' : 'Save provider connection'}
            </button>
          </form>
          <div className="settings-records">
            {connections.map((connection) => (
              <article key={connection.deployment_id}>
                <div>
                  <strong>
                    {catalog.deployments.find((item) => item.id === connection.deployment_id)
                      ?.name ?? connection.deployment_id}
                  </strong>
                  <p>{connection.deployment_id}</p>
                  <small>Saved {new Date(connection.created_at).toLocaleString()}</small>
                </div>
                <button
                  className="button button-outline button-sm"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await request(
                        `/api/connections/${encodeURIComponent(connection.deployment_id)}`,
                        'DELETE',
                      );
                      setNotice('Provider connection removed.');
                    })
                  }
                >
                  Remove
                </button>
              </article>
            ))}
            {!connections.length && (
              <p className="detail-note">No workspace provider connections saved.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
