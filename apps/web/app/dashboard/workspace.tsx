'use client';

import { GovernanceSettings } from '../governance/settings';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import type { Job } from '@media-router/contracts';
import { GatewayAccess, type BrowserSession } from '../gateway-access';
import { FirstSteps } from '../onboarding/journey';
import { WorkspaceSettings } from './settings';
import { PrivateActivity } from './activity';
import { readApiJson } from './api-response';
import { hasWorkspaceAuthority, privateWorkspaceHeaders, type ActivityItem } from './activity-view';
import { WorkspaceOperations } from './operations';
import { ConnectedApps } from './connected-apps';
import { WorkspaceOverview } from './overview';
import onboarding from '../onboarding/onboarding.module.css';
import { WorkspaceAdministration } from './team';
import { CopyButton, Footer, Icon, SiteHeader } from '../ui';

const money = (value: number | string) =>
  `$${(Number(value) / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
const date = (value: string) => new Date(value).toLocaleString();
type Balance = { availableMicros: number; reservedMicros: number };
type Entry = {
  id: string;
  job_id?: string;
  kind: string;
  amount_micros: string;
  created_at: string;
};
type WorkspaceView = 'start' | 'generations' | 'ledger' | 'team' | 'settings' | 'keys' | 'apps';
const legacyViews = ['generations', 'ledger', 'keys', 'apps', 'settings'] as const;
const workspaceNavigation: {
  label: string;
  links: {
    label: string;
    path: string;
    icon: ComponentProps<typeof Icon>['name'];
    views: WorkspaceView[];
  }[];
}[] = [
  {
    label: 'Overview',
    links: [
      { label: 'Start', path: '/app#start', icon: 'grid', views: ['start'] },
      {
        label: 'Activity',
        path: '/app#activity',
        icon: 'activity',
        views: ['generations', 'ledger'],
      },
      { label: 'Team', path: '/app#team', icon: 'users', views: ['team', 'settings'] },
    ],
  },
  {
    label: 'Access & billing',
    links: [
      { label: 'API keys', path: '/app#keys', icon: 'key', views: ['keys'] },
      { label: 'Connected apps', path: '/app#apps', icon: 'link', views: ['apps'] },
      { label: 'Credit & billing', path: '/billing', icon: 'wallet', views: [] },
    ],
  },
];
const appTitles: Record<WorkspaceView, string> = {
  start: 'Overview',
  generations: 'Activity',
  ledger: 'Activity',
  team: 'Team & workspaces',
  settings: 'Team & workspaces',
  keys: 'API keys',
  apps: 'Connected apps',
};

function workspaceDescriptor(workspaceId?: string) {
  if (!workspaceId)
    return { label: 'Workspace', badge: 'O', kind: 'default' as const, shortId: '' };
  if (workspaceId.startsWith('user-')) {
    const shortId =
      workspaceId.length > 18
        ? `${workspaceId.slice(0, 10)}…${workspaceId.slice(-4)}`
        : workspaceId;
    return { label: 'Personal workspace', badge: 'P', kind: 'personal' as const, shortId };
  }
  if (workspaceId.startsWith('team-')) {
    const shortId =
      workspaceId.length > 18
        ? `${workspaceId.slice(0, 10)}…${workspaceId.slice(-4)}`
        : workspaceId;
    return { label: 'Team workspace', badge: 'T', kind: 'team' as const, shortId };
  }
  const shortId =
    workspaceId.length > 20 ? `${workspaceId.slice(0, 12)}…${workspaceId.slice(-4)}` : workspaceId;
  return {
    label: workspaceId,
    badge: workspaceId.slice(0, 1).toUpperCase() || 'W',
    kind: 'default' as const,
    shortId,
  };
}

export function Dashboard({ appMode = false }: { appMode?: boolean } = {}) {
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [recentActivity, setRecentActivity] = useState<ActivityItem[]>([]);
  const [hasMoreActivity, setHasMoreActivity] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingInspectId = useRef<string | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [ledger, setLedger] = useState<Entry[]>([]);
  const [tab, setTab] = useState<WorkspaceView>(appMode ? 'start' : 'generations');
  const [hashReady, setHashReady] = useState(false);
  const [selected, setSelected] = useState<{ authority: string; job: Job } | null>(null);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const workspaceId = session?.workspaceId;
  const hasGenerations = recentActivity.length > 0;
  const authority = authenticated
    ? (session?.recoveryScope ??
      JSON.stringify([workspaceId, session?.membershipId, session?.scopes]))
    : '';
  const privateIdentity = {
    recoveryScope: session?.recoveryScope ?? null,
    workspaceId: authenticated ? (workspaceId ?? null) : null,
    membershipId: session?.membershipId ?? null,
    permissions: session?.scopes ?? [],
  };
  const readView = tab === 'start' || tab === 'generations' || tab === 'ledger';
  const hasReadPermission = Boolean(session?.scopes?.includes('read'));
  const canLoadData =
    authenticated &&
    Boolean(workspaceId) &&
    hasReadPermission &&
    hasWorkspaceAuthority(privateIdentity) &&
    (!appMode || (hashReady && readView));
  const currentData = canLoadData && loadedWorkspaceId === authority;
  const currentBalance = currentData ? balance : null;
  const currentLedger = currentData ? ledger : [];
  const currentRecent = currentData ? recentActivity : [];
  const selectedJob =
    currentData && tab === 'generations' && selected && selected.authority === authority
      ? selected.job
      : null;
  useEffect(() => {
    const update = () => {
      const value = window.location.hash.slice(1);
      if (legacyViews.includes(value as (typeof legacyViews)[number]))
        setTab(value as WorkspaceView);
      else if (appMode && value === 'activity') setTab('generations');
      else if (appMode && (value === 'start' || value === 'team')) setTab(value);
      else if (appMode) setTab('start');
      setHashReady(true);
    };
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [appMode]);
  useEffect(() => {
    if (tab === 'generations' && pendingInspectId.current) {
      const nextId = pendingInspectId.current;
      pendingInspectId.current = null;
      setSelected(null);
      setSelectedId(nextId);
      return;
    }
    pendingInspectId.current = null;
    setSelected(null);
    setSelectedId(null);
  }, [authenticated, authority, tab, hasReadPermission]);
  useEffect(() => {
    setError('');
    setLoadedWorkspaceId(null);
    if (!canLoadData || !workspaceId) {
      setRecentActivity([]);
      setHasMoreActivity(false);
      setBalance(null);
      setLedger([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    async function load<T>(path: string): Promise<T> {
      const response = await fetch(path, {
        signal: controller.signal,
        cache: 'no-store',
        headers: privateWorkspaceHeaders(privateIdentity),
      });
      return readApiJson<T>(response, 'Workspace could not be loaded.', {
        signal: controller.signal,
      });
    }
    Promise.all([
      load<{ items: ActivityItem[]; nextCursor?: string | null }>('/api/activity?limit=5'),
      load<Balance>('/api/balance'),
      load<Entry[]>('/api/ledger'),
    ])
      .then(([nextJobs, nextBalance, nextLedger]) => {
        if (controller.signal.aborted) return;
        setRecentActivity(Array.isArray(nextJobs.items) ? nextJobs.items : []);
        setHasMoreActivity(Boolean(nextJobs.nextCursor));
        setBalance(nextBalance);
        setLedger(Array.isArray(nextLedger) ? nextLedger : []);
        setLoadedWorkspaceId(authority);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Workspace could not be loaded.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [canLoadData, workspaceId, authority, refresh]);
  useEffect(() => {
    if (!selectedId || !canLoadData || !workspaceId) return;
    const controller = new AbortController();
    setSelected(null);
    fetch(`/api/generations/${encodeURIComponent(selectedId)}`, {
      headers: privateWorkspaceHeaders(privateIdentity),
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((response) =>
        readApiJson<Job>(response, 'Generation could not be loaded.', {
          signal: controller.signal,
        }),
      )
      .then((job) => {
        if (!controller.signal.aborted) setSelected({ authority, job });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : 'Generation could not be loaded.');
      });
    return () => controller.abort();
  }, [selectedId, canLoadData, workspaceId, authority]);

  const wsInfo = workspaceDescriptor(workspaceId);
  const isZeroCredit = currentBalance !== null && currentBalance.availableMicros <= 0;

  const inspectFromOverview = (jobId: string) => {
    pendingInspectId.current = jobId;
    setTab('generations');
    if (appMode) window.location.hash = 'activity';
  };

  const summary = (
    <div className="workspace-stats">
      <div>
        <span>Available credit</span>
        <strong>{currentBalance ? money(currentBalance.availableMicros) : '—'}</strong>
        {appMode && (
          <a className="workspace-stat-link" href="/billing">
            {isZeroCredit ? '+ Add credit →' : 'Manage billing →'}
          </a>
        )}
      </div>
      <div>
        <span>Reserved for jobs</span>
        <strong>{currentBalance ? money(currentBalance.reservedMicros) : '—'}</strong>
        {appMode && (
          <small className="workspace-stat-note">
            {(currentBalance?.reservedMicros ?? 0) > 0
              ? 'Active hold on pending jobs'
              : 'No active holds'}
          </small>
        )}
      </div>
      <div>
        <span>Recent generations</span>
        {appMode ? (
          <>
            <strong>
              {currentData ? `${currentRecent.length}${hasMoreActivity ? '+' : ''}` : '—'}
            </strong>
            {tab === 'start' ? (
              <a className="workspace-stat-link" href="/app#activity">
                View activity →
              </a>
            ) : (
              <small className="workspace-stat-note">Private to this workspace</small>
            )}
          </>
        ) : (
          <strong>
            <a href="/app#activity">View history</a>
          </strong>
        )}
      </div>
    </div>
  );
  const activityPermission = (
    <p className="detail-note">
      Your workspace permissions do not include activity access. Ask a workspace administrator for
      read permission.
    </p>
  );
  return (
    <>
      <SiteHeader active="dashboard" />
      <main
        className={`workspace-page page-width ${onboarding.workspace}${appMode ? ' account-page' : ''}`}
      >
        <div className={appMode && authenticated ? 'account-layout' : undefined}>
          {appMode && authenticated && (
            <aside className="account-sidebar">
              <div className="account-context">
                <span
                  className={`account-context-mark account-context-mark-${wsInfo.kind}`}
                  aria-hidden="true"
                >
                  {wsInfo.badge}
                </span>
                <div className="account-context-meta">
                  <div className="account-context-title">
                    <strong>{wsInfo.label}</strong>
                    {session?.role && (
                      <span className="account-role-tag">{session.role.toUpperCase()}</span>
                    )}
                  </div>
                  {workspaceId && (
                    <div className="account-context-id-row">
                      {wsInfo.shortId !== wsInfo.label && (
                        <code title={workspaceId}>{wsInfo.shortId}</code>
                      )}
                      <CopyButton text={workspaceId} label="Copy ID" />
                    </div>
                  )}
                </div>
              </div>
              <nav className="account-nav-groups" aria-label="Account navigation">
                {workspaceNavigation.map((group) => (
                  <div className="account-nav-group" key={group.label}>
                    <span>{group.label}</span>
                    {group.links.map((link) => (
                      <a
                        key={link.path}
                        href={link.path}
                        aria-current={link.views.includes(tab) ? 'page' : undefined}
                      >
                        <Icon name={link.icon} size={16} />
                        {link.label}
                      </a>
                    ))}
                  </div>
                ))}
              </nav>
              <div className="account-sidebar-footer">
                <a href="/playground">
                  <Icon name="spark" size={14} /> Playground
                </a>
                <a href="/models">
                  <Icon name="globe" size={14} /> Models
                </a>
                <a href="/docs/api">
                  <Icon name="code" size={14} /> API docs
                </a>
              </div>
            </aside>
          )}
          <div className={appMode ? 'account-content' : undefined}>
            <header className={appMode ? 'account-view-header' : 'workspace-heading'}>
              <div>
                <span className="eyebrow">
                  {appMode ? 'WORKSPACE / ' + appTitles[tab].toUpperCase() : 'YOUR WORKSPACE'}
                </span>
                <h1>{appMode ? appTitles[tab] : 'From idea to output.'}</h1>
                <p>
                  {appMode && tab === 'start'
                    ? 'Balance, recent generations, and quick access across browser, agents, and API.'
                    : appMode && (tab === 'team' || tab === 'settings')
                      ? 'Switch workspaces, invite teammates, and configure webhooks or alerts.'
                      : appMode && tab === 'keys'
                        ? 'Create scoped API keys, set monthly spend caps, and pin routing rules.'
                        : appMode && tab === 'apps'
                          ? 'Review or revoke OAuth and MCP agents authorized for this workspace.'
                          : 'Your private generation history, active holds, and itemized usage ledger.'}
                </p>
              </div>
              <div className="account-header-actions">
                {appMode && tab === 'keys' ? (
                  <>
                    <a className="button button-outline button-sm" href="/docs/api">
                      API docs
                    </a>
                    <a className="button button-dark button-sm" href="/agents">
                      Agent &amp; CLI setup <Icon name="arrow" size={15} />
                    </a>
                  </>
                ) : appMode && tab === 'apps' ? (
                  <a className="button button-dark button-sm" href="/agents">
                    Connect an agent <Icon name="arrow" size={15} />
                  </a>
                ) : (
                  <>
                    {appMode && (
                      <a className="button button-outline button-sm" href="/billing">
                        <Icon name="plus" size={14} /> Add credit
                      </a>
                    )}
                    <a className="button button-dark button-sm" href="/playground">
                      Create in Playground <Icon name="arrow" size={15} />
                    </a>
                  </>
                )}
              </div>
            </header>
            <GatewayAccess onChange={setAuthenticated} onSession={setSession} />
            {authenticated && canLoadData && error && (
              <p className="error-notice" role="alert">
                {error}
              </p>
            )}
            {authenticated &&
              (appMode && tab === 'start' ? (
                <>
                  {summary}
                  {!hasReadPermission && activityPermission}
                  <WorkspaceOverview
                    availableMicros={currentBalance ? currentBalance.availableMicros : null}
                    hasReadPermission={hasReadPermission}
                    canManageKeys={Boolean(session?.scopes?.includes('keys:write'))}
                    recentActivity={currentRecent}
                    recentLedger={currentLedger}
                    loading={loading}
                    onInspectJob={inspectFromOverview}
                  />
                </>
              ) : appMode && (tab === 'team' || tab === 'settings') ? (
                <>
                  <WorkspaceAdministration
                    includeSettings={false}
                    expectedAuthority={privateIdentity}
                  />
                  <WorkspaceOperations {...privateIdentity} />
                </>
              ) : (
                <>
                  {!appMode && !hasGenerations && (
                    <FirstSteps
                      workspaceId={workspaceId}
                      hasGenerations={currentData && hasGenerations}
                      hasCredit={(currentBalance?.availableMicros ?? 0) > 0}
                    />
                  )}
                  {!appMode && (
                    <nav className={onboarding.nav} aria-label="Workspace tools">
                      <a href="/agents">Agent setup ↗</a>
                      <a href="/billing">Credit & billing ↗</a>
                    </nav>
                  )}
                  {(!appMode || readView) && summary}
                  {(!appMode || readView) && (
                    <div className={`workspace-controls ${onboarding.toolbar}`}>
                      <div className="content-tabs" role="tablist" aria-label="Workspace view">
                        {(appMode ? (['generations', 'ledger'] as const) : legacyViews).map(
                          (value) => (
                            <button
                              key={value}
                              role="tab"
                              aria-selected={tab === value}
                              className={tab === value ? 'active' : ''}
                              onClick={() => {
                                setTab(value);
                                if (appMode)
                                  window.location.hash =
                                    value === 'generations' ? 'activity' : value;
                              }}
                            >
                              {value === 'generations'
                                ? 'Generations'
                                : value === 'ledger'
                                  ? 'Usage ledger'
                                  : value === 'keys'
                                    ? 'API keys'
                                    : value === 'apps'
                                      ? 'Connected apps'
                                      : 'Settings'}
                            </button>
                          ),
                        )}
                      </div>
                      <button
                        className="button button-outline button-sm"
                        onClick={() => setRefresh((value) => value + 1)}
                        disabled={loading || (appMode && !hasReadPermission)}
                      >
                        {loading ? 'Refreshing…' : 'Refresh'}
                      </button>
                    </div>
                  )}
                  {appMode && readView && !hasReadPermission ? (
                    activityPermission
                  ) : tab === 'keys' ? (
                    session?.scopes?.includes('keys:write') ? (
                      <>
                        <WorkspaceSettings
                          key={authority}
                          workspaceId={session.workspaceId}
                          recoveryScope={session.recoveryScope}
                          permissions={session.scopes}
                          keysOnly
                          embedded={appMode}
                        />
                        <GovernanceSettings
                          workspaceId={authenticated ? (session.workspaceId ?? null) : null}
                          recoveryScope={authenticated ? (session.recoveryScope ?? null) : null}
                          permissions={session.scopes ?? []}
                        />
                      </>
                    ) : (
                      <p className="detail-note">
                        Your workspace administrator manages API keys. You can connect an agent with
                        your own account from the agent setup guide.
                      </p>
                    )
                  ) : tab === 'apps' ? (
                    <ConnectedApps {...privateIdentity} />
                  ) : tab === 'settings' ? (
                    <WorkspaceAdministration expectedAuthority={privateIdentity} />
                  ) : tab === 'generations' ? (
                    <PrivateActivity
                      key={`${authority}:${refresh}`}
                      {...privateIdentity}
                      onSelectJob={setSelectedId}
                      embedded={appMode}
                    />
                  ) : (
                    <div className="workspace-table-wrap">
                      <table className="workspace-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Entry</th>
                            <th>Amount</th>
                            <th>Generation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentLedger.map((entry) => (
                            <tr key={entry.id}>
                              <td>{date(entry.created_at)}</td>
                              <td>{entry.kind}</td>
                              <td>{money(entry.amount_micros)}</td>
                              <td>
                                <code>{entry.job_id ?? 'Workspace'}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!currentLedger.length && !loading && (
                        <div className="workspace-empty">
                          <h2>A clear record of your usage.</h2>
                          <p>Reservations, settlements and released funds appear here.</p>
                        </div>
                      )}
                    </div>
                  )}
                  {(!appMode || readView) && (
                    <p className="detail-note">
                      Showing up to 100 recent records. A reservation is a temporary hold; pending
                      settlement is not a confirmed refund. Refresh to check ongoing work.
                    </p>
                  )}
                </>
              ))}
            {selectedJob && (
              <section className="workspace-job-detail" aria-labelledby="job-detail-title">
                <div className={`workspace-controls ${onboarding.toolbar}`}>
                  <h2 id="job-detail-title">Generation details</h2>
                  <button
                    className="button button-outline button-sm"
                    onClick={() => setSelected(null)}
                  >
                    Close details
                  </button>
                </div>
                <dl>
                  <div>
                    <dt>Job</dt>
                    <dd>
                      <code>{selectedJob.id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Route</dt>
                    <dd>
                      <code>{selectedJob.routeId}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedJob.status}</dd>
                  </div>
                  <div>
                    <dt>Output delivery</dt>
                    <dd>{selectedJob.deliveryStatus ?? 'Unverified'}</dd>
                  </div>
                  <div>
                    <dt>Prompt</dt>
                    <dd>{selectedJob.input.input.prompt}</dd>
                  </div>
                </dl>
                {selectedJob.error && <p className="error-notice">{selectedJob.error}</p>}
                {(selectedJob.deliveryStatus === 'failed' ||
                  selectedJob.deliveryStatus === 'partial') && (
                  <p className="error-notice">
                    The provider’s generation finished, but{' '}
                    {selectedJob.deliveryStatus === 'partial'
                      ? 'some outputs could not be delivered'
                      : 'output delivery failed'}
                    . Keep this job ID for recovery. A new generation can charge again.
                  </p>
                )}
                <div className="workspace-outputs">
                  {selectedJob.outputs.map((output) => (
                    <div key={output.url}>
                      {output.mediaType.startsWith('image/') ? (
                        <img src={output.url} alt="Generated output" />
                      ) : (
                        <video src={output.url} controls />
                      )}
                      <a className="text-link" href={output.url} target="_blank" rel="noreferrer">
                        Open output <Icon name="external" size={13} />
                      </a>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
