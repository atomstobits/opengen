'use client';

import { notifyBrowserSessionChanged } from '../gateway-access';
import { useEffect, useRef, useState } from 'react';
import { WorkspaceSettings } from './settings';
import { CopyButton } from '../ui';
import {
  hasWorkspaceAuthority,
  privateWorkspaceHeaders,
  type PrivateWorkspaceAuthority,
} from './activity-view';

type Session = {
  authenticated?: boolean;
  recoveryScope?: string;
  workspaceId: string;
  scopes: string[];
  identity?: { issuer: string; subject: string };
  canSwitchWorkspace?: boolean;
  role?: 'admin' | 'member';
};
type Workspace = { id: string; name: string; role?: string; accepted_at?: string | null };
type Member = {
  id: string;
  issuer: string;
  subject: string;
  role: 'admin' | 'member';
  accepted_at: string | null;
  removed_at: string | null;
};
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
        : (body.error?.message ?? 'Workspace settings could not be loaded.'),
    );
  }
  return body.data ?? body;
}

interface AdministrationProps {
  includeSettings?: boolean;
  expectedAuthority?: PrivateWorkspaceAuthority;
}
export function WorkspaceAdministration(props: AdministrationProps = {}) {
  if (props.expectedAuthority && !hasWorkspaceAuthority(props.expectedAuthority))
    return (
      <p className="detail-note" role="status">
        Verify workspace access before loading team settings.
      </p>
    );
  return (
    <Administration
      key={JSON.stringify([
        props.expectedAuthority?.workspaceId,
        props.expectedAuthority?.recoveryScope,
      ])}
      {...props}
    />
  );
}
function Administration({ includeSettings = true, expectedAuthority }: AdministrationProps) {
  const active = useRef(true);
  const mutation = useRef<AbortController | null>(null);
  const verifiedAuthority = useRef<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      mutation.current?.abort();
    };
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [subject, setSubject] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSession(null);
    setWorkspaces([]);
    setMembers([]);
    fetch('/api/session', {
      cache: 'no-store',
      signal: controller.signal,
      ...(expectedAuthority ? { headers: privateWorkspaceHeaders(expectedAuthority) } : {}),
    })
      .then(async (response) => {
        const body = await response.json();
        const current = (body.data ?? body) as Session;
        if (controller.signal.aborted || !active.current) return;
        if (
          !response.ok ||
          current.authenticated !== true ||
          !hasWorkspaceAuthority(current) ||
          !Array.isArray(current.scopes)
        ) {
          notifyBrowserSessionChanged();
          throw new Error('Verify the current workspace before managing team settings.');
        }
        if (
          expectedAuthority &&
          (current.workspaceId !== expectedAuthority.workspaceId ||
            current.recoveryScope !== expectedAuthority.recoveryScope)
        ) {
          notifyBrowserSessionChanged();
          throw new Error('Your workspace authority changed. Refresh team settings.');
        }
        const authorityKey = JSON.stringify([
          current.workspaceId,
          current.recoveryScope,
          [...current.scopes].sort(),
        ]);
        if (verifiedAuthority.current !== authorityKey) {
          mutation.current?.abort();
          setName('');
          setSubject('');
          setRole('member');
          setNotice('');
          setError('');
          verifiedAuthority.current = authorityKey;
        }
        setSession(current);
        setSelected(current.workspaceId);
        setIssuer(current.identity?.issuer ?? '');
        if (current.canSwitchWorkspace) {
          const list = await requestForAuthority<Workspace[]>(
            current,
            '/api/workspaces',
            'GET',
            undefined,
            controller.signal,
          );
          if (!controller.signal.aborted) setWorkspaces(list);
        } else setWorkspaces([{ id: current.workspaceId, name: current.workspaceId }]);
        if (current.scopes.includes('members:write')) {
          const list = await requestForAuthority<Member[]>(
            current,
            '/api/members',
            'GET',
            undefined,
            controller.signal,
          );
          if (!controller.signal.aborted) setMembers(list);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && active.current)
          setError(cause instanceof Error ? cause.message : 'Settings unavailable.');
      });
    return () => controller.abort();
  }, [refresh, expectedAuthority?.workspaceId, expectedAuthority?.recoveryScope]);
  async function request<T>(path: string, method = 'GET', input?: unknown): Promise<T> {
    if (!active.current || !session || !hasWorkspaceAuthority(session))
      throw new Error('Verify the current workspace before changing settings.');
    const signal = mutation.current?.signal;
    const value = await requestForAuthority<T>(session, path, method, input, signal);
    signal?.throwIfAborted();
    if (!active.current) throw new DOMException('Workspace authority changed.', 'AbortError');
    return value;
  }
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
  if (!session)
    return (
      <p className={error ? 'error-notice' : 'detail-note'} role="status">
        {error || 'Loading workspace settings…'}
      </p>
    );
  const administration = session.scopes?.some((scope) =>
    ['keys:write', 'policies:write', 'connections:write'].includes(scope),
  );
  const canManageMembers = session.scopes?.includes('members:write');
  return (
    <>
      <section className="workspace-settings workspace-team-settings">
        <div className="settings-section-heading">
          <h2>Workspaces</h2>
          <p>Choose where to work or create a separate space for a project or team.</p>
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
        {session.canSwitchWorkspace ? (
          <>
            <div className="workspace-choice-grid">
              <form
                className="settings-form workspace-choice"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(async () => {
                    await request('/api/session/workspace', 'POST', { workspaceId: selected });
                    notifyBrowserSessionChanged();
                    window.location.reload();
                  });
                }}
              >
                <h3>Switch workspace</h3>
                <label>
                  Selected workspace
                  <select value={selected} onChange={(event) => setSelected(event.target.value)}>
                    {workspaces
                      .filter((workspace) => workspace.accepted_at)
                      .map((workspace) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.name} · {workspace.role}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="button button-outline"
                  disabled={busy || selected === session.workspaceId}
                >
                  Switch workspace
                </button>
              </form>
              {canManageMembers && (
                <form
                  className="settings-form workspace-choice"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void act(async () => {
                      const workspace = await request<Workspace>('/api/teams', 'POST', { name });
                      await request('/api/session/workspace', 'POST', {
                        workspaceId: workspace.id,
                      });
                      notifyBrowserSessionChanged();
                      window.location.reload();
                    });
                  }}
                >
                  <h3>Create a workspace</h3>
                  <label>
                    New workspace name
                    <input
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      maxLength={80}
                      placeholder="Studio project"
                      required
                    />
                  </label>
                  <p className="detail-note">
                    New workspaces start with no managed credit or provider connections.
                  </p>
                  <button className="button button-outline" disabled={busy || !name.trim()}>
                    Create workspace
                  </button>
                </form>
              )}
            </div>
            {workspaces
              .filter((workspace) => workspace.accepted_at === null)
              .map((workspace) => (
                <article className="recovery-notice" key={workspace.id}>
                  <strong>Invitation to {workspace.name}</strong>
                  <p>{workspace.role} access</p>
                  <button
                    className="button button-outline button-sm"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await request(
                          `/api/workspaces/${encodeURIComponent(workspace.id)}/accept-invite`,
                          'POST',
                          {},
                        );
                        setNotice('Invitation accepted. Select the workspace above to continue.');
                      })
                    }
                  >
                    Accept invitation
                  </button>
                </article>
              ))}
          </>
        ) : (
          <p className="detail-note">
            This gateway key is fixed to <strong>{session.workspaceId}</strong>. Sign in with OpenID
            Connect to select your personal and team workspaces.
          </p>
        )}
        {session.identity && (
          <div className="new-key-notice">
            <strong>Your verified sign-in identity</strong>
            <p>Share this identity with a workspace administrator when requesting an invitation.</p>
            <div className="command-box">
              <code>{JSON.stringify(session.identity)}</code>
              <CopyButton text={JSON.stringify(session.identity)} label="Copy identity" />
            </div>
          </div>
        )}
        {canManageMembers && (
          <>
            <form
              className="settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(async () => {
                  await request('/api/members', 'POST', { issuer, subject, role });
                  setSubject('');
                  setNotice(
                    'Invitation created. Your teammate can accept it from their workspace settings.',
                  );
                });
              }}
            >
              <h3>Invite a teammate</h3>
              <p className="detail-note">
                Ask them to sign in once and share their verified identity above. Email addresses
                alone do not establish account ownership.
              </p>
              <label>
                Identity issuer
                <input
                  type="url"
                  required
                  value={issuer}
                  onChange={(event) => setIssuer(event.target.value)}
                  placeholder="https://your-identity-provider.example"
                />
              </label>
              <label>
                Identity subject
                <input
                  required
                  maxLength={512}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="Their verified subject identifier"
                />
              </label>
              <label>
                Workspace role
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as 'admin' | 'member')}
                >
                  <option value="member">Member · create and view generations</option>
                  <option value="admin">Administrator · manage workspace access</option>
                </select>
              </label>
              <button className="button button-dark" disabled={busy || !subject.trim() || !issuer}>
                Invite teammate
              </button>
            </form>
            <div className="settings-records">
              {members
                .filter((member) => !member.removed_at)
                .map((member) => (
                  <article key={member.id}>
                    <div>
                      <strong>{member.subject}</strong>
                      <p>{member.issuer}</p>
                      <small>{member.accepted_at ? member.role : 'Invitation pending'}</small>
                    </div>
                    <div>
                      <select
                        aria-label={`Role for ${member.subject}`}
                        value={member.role}
                        disabled={busy}
                        onChange={(event) => {
                          const next = event.target.value;
                          void act(async () => {
                            await request(
                              `/api/members/${encodeURIComponent(member.id)}`,
                              'PATCH',
                              { role: next },
                            );
                          });
                        }}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Administrator</option>
                      </select>
                      <button
                        className="button button-outline button-sm"
                        disabled={busy}
                        onClick={() =>
                          act(async () => {
                            await request(
                              `/api/members/${encodeURIComponent(member.id)}`,
                              'DELETE',
                            );
                            setNotice(
                              'Membership removed. Its browser sessions and issued keys lose access.',
                            );
                          })
                        }
                      >
                        Remove access
                      </button>
                    </div>
                  </article>
                ))}
            </div>
          </>
        )}
      </section>
      {includeSettings &&
        (administration ? (
          <WorkspaceSettings
            key={session.workspaceId}
            permissions={session.scopes}
            workspaceId={session.workspaceId}
            recoveryScope={session.recoveryScope}
          />
        ) : (
          <p className="detail-note">
            Your workspace administrator manages keys, routing profiles and provider connections.
          </p>
        ))}
    </>
  );
}
