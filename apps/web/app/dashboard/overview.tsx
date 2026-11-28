'use client';

import { catalog } from '@media-router/catalog';
import type { ActivityItem } from './activity-view';
import { moneyMicros } from './activity-view';
import { CopyButton, Icon } from '../ui';
import styles from './console.module.css';

export interface LedgerPreviewEntry {
  id: string;
  job_id?: string;
  kind: string;
  amount_micros: string;
  created_at: string;
}

interface WorkspaceOverviewProps {
  availableMicros: number | null;
  hasReadPermission: boolean;
  canManageKeys: boolean;
  recentActivity: ActivityItem[];
  recentLedger: LedgerPreviewEntry[];
  loading: boolean;
  onInspectJob: (jobId: string) => void;
}

function statusClass(status: string): string {
  if (status === 'succeeded') return `${styles.statusPill} ${styles.statusSucceeded}`;
  if (status === 'failed' || status === 'cancelled' || status === 'submission-unknown')
    return `${styles.statusPill} ${styles.statusFailed}`;
  return `${styles.statusPill} ${styles.statusPending}`;
}

function shortDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatAmount(value: string, showPlus = false): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return value;
  const sign = num < 0 ? '-' : showPlus && num > 0 ? '+' : '';
  return `${sign}$${(Math.abs(num) / 1_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

export function WorkspaceOverview({
  availableMicros,
  hasReadPermission,
  canManageKeys,
  recentActivity,
  recentLedger,
  loading,
  onInspectJob,
}: WorkspaceOverviewProps) {
  const hasCredit = availableMicros !== null && availableMicros > 0;
  const showZeroCreditCallout = hasReadPermission && availableMicros !== null && !hasCredit;
  const hasRuns = recentActivity.length > 0;

  return (
    <div className={styles.overview}>
      {showZeroCreditCallout && (
        <div className={styles.fundingStrip} role="region" aria-label="Workspace credit status">
          <div className={styles.fundingCopy}>
            <strong>Ready to generate? Add prepaid credit to start.</strong>
            <p>
              New workspaces start at $0.00. Quotes are always free; add prepaid credit (from $5)
              for managed runs or connect your own provider key.
            </p>
          </div>
          <a className="button button-dark button-sm" href="/billing">
            <Icon name="plus" size={14} /> Add credit
          </a>
        </div>
      )}

      <div className={styles.workbench}>
        <div className={styles.primaryCol}>
          {hasRuns ? (
            <>
              <section className={styles.panel} aria-label="Recent generations">
                <div className={styles.panelHeader}>
                  <h2>Recent generations</h2>
                  <a className={styles.panelAction} href="/app#activity">
                    View all <Icon name="arrow" size={13} />
                  </a>
                </div>
                <ul className={styles.activityList}>
                  {recentActivity.slice(0, 5).map((item) => (
                    <li className={styles.activityRow} key={item.id}>
                      <div className={styles.activityMain}>
                        <div className={styles.activityTitleRow}>
                          <strong>{item.modelId}</strong>
                          <span className={styles.opTag}>{item.operation}</span>
                        </div>
                        <span className={styles.activityMeta}>
                          {item.providerId ?? 'Provider'} · {item.endpointRegion ?? 'undisclosed'} ·{' '}
                          {shortDate(item.createdAt)}
                        </span>
                      </div>
                      <div className={styles.activityCost}>
                        <span className={statusClass(item.status)}>
                          {item.status.replaceAll('-', ' ')}
                        </span>
                        <span
                          className={
                            item.settledMicros !== null ? styles.costSettled : styles.costPending
                          }
                        >
                          {item.settledMicros !== null
                            ? moneyMicros(item.settledMicros)
                            : `${moneyMicros(item.reservedMicros)} held`}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={styles.inspectBtn}
                        onClick={() => onInspectJob(item.id)}
                      >
                        Inspect
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <nav className={styles.quickBar} aria-label="Quick launch">
                <a href="/playground">
                  <span>
                    <Icon name="spark" size={15} /> Playground
                  </span>
                  <Icon name="arrow" size={14} />
                </a>
                <a href="/agents">
                  <span>
                    <Icon name="link" size={15} /> Connect agent
                  </span>
                  <Icon name="arrow" size={14} />
                </a>
                <a href="/docs/api">
                  <span>
                    <Icon name="code" size={15} /> API &amp; CLI docs
                  </span>
                  <Icon name="arrow" size={14} />
                </a>
              </nav>
            </>
          ) : (
            <section className={styles.panel} aria-label="Start generating">
              <div className={styles.panelHeader}>
                <h2>Start generating</h2>
                <a className={styles.panelAction} href="/models">
                  Browse {catalog.models.length} models <Icon name="arrow" size={13} />
                </a>
              </div>
              <p className={styles.panelIntro}>
                Choose how you want to run your first image or video generation. Every path shares
                this workspace&rsquo;s balance, routing policies, and private history.
              </p>
              <div className={styles.launchList}>
                <div className={`${styles.launchRow} ${styles.launchPlayground}`}>
                  <span className={styles.launchIcon} aria-hidden="true">
                    <Icon name="spark" size={17} />
                  </span>
                  <div className={styles.launchBody}>
                    <h3>Playground (Browser)</h3>
                    <p>
                      Pick a model, compare exact regional quotes, and generate directly in your
                      browser.
                    </p>
                  </div>
                  <div className={styles.launchActions}>
                    <a className="button button-dark button-sm" href="/playground">
                      Open Playground <Icon name="arrow" size={14} />
                    </a>
                  </div>
                </div>

                <div className={`${styles.launchRow} ${styles.launchAgent}`}>
                  <span className={styles.launchIcon} aria-hidden="true">
                    <Icon name="link" size={17} />
                  </span>
                  <div className={styles.launchBody}>
                    <h3>Connect an AI agent (MCP)</h3>
                    <p>
                      Authorize Claude Code, Codex, Cursor, or OpenCode via OAuth without sharing
                      raw keys.
                    </p>
                  </div>
                  <div className={styles.launchActions}>
                    <a className="button button-outline button-sm" href="/agents">
                      Agent setup <Icon name="arrow" size={14} />
                    </a>
                  </div>
                </div>

                <div className={`${styles.launchRow} ${styles.launchApi}`}>
                  <span className={styles.launchIcon} aria-hidden="true">
                    <Icon name="code" size={17} />
                  </span>
                  <div className={styles.launchBody}>
                    <h3>HTTP API &amp; CLI</h3>
                    <p>
                      Issue a scoped workspace key for <code>/v1/generations</code> or log in with
                      the portable CLI.
                    </p>
                  </div>
                  <div className={styles.launchActions}>
                    {canManageKeys && (
                      <a className="button button-outline button-sm" href="/app#keys">
                        Create API key
                      </a>
                    )}
                    <a className={styles.panelAction} href="/docs/api">
                      API docs <Icon name="external" size={12} />
                    </a>
                  </div>
                </div>
              </div>
              <div className={styles.cliStrip}>
                <div className={styles.cliCommand}>
                  <span className={styles.cliPrompt} aria-hidden="true">
                    $
                  </span>
                  <code>npx @opengen-dev/cli login</code>
                </div>
                <CopyButton text="npx @opengen-dev/cli login" label="Copy CLI login command" />
              </div>
            </section>
          )}
        </div>

        <div className={styles.sideCol}>
          <section className={styles.panel} aria-label="Workspace controls">
            <div className={styles.panelHeader}>
              <h2>Workspace controls</h2>
            </div>
            <ul className={styles.shortcutList}>
              <li>
                <a className={styles.shortcutLink} href="/app#keys">
                  <span className={styles.shortcutLead}>
                    <span className={styles.shortcutIcon} aria-hidden="true">
                      <Icon name="key" size={16} />
                    </span>
                    <span className={styles.shortcutText}>
                      <strong>API keys &amp; spend caps</strong>
                      <span>Scoped tokens, expiry &amp; routing rules</span>
                    </span>
                  </span>
                  <span className={styles.shortcutChevron} aria-hidden="true">
                    <Icon name="chevron" size={15} />
                  </span>
                </a>
              </li>
              <li>
                <a className={styles.shortcutLink} href="/app#apps">
                  <span className={styles.shortcutLead}>
                    <span className={styles.shortcutIcon} aria-hidden="true">
                      <Icon name="link" size={16} />
                    </span>
                    <span className={styles.shortcutText}>
                      <strong>Connected apps</strong>
                      <span>Review or revoke MCP / OAuth agents</span>
                    </span>
                  </span>
                  <span className={styles.shortcutChevron} aria-hidden="true">
                    <Icon name="chevron" size={15} />
                  </span>
                </a>
              </li>
              <li>
                <a className={styles.shortcutLink} href="/billing">
                  <span className={styles.shortcutLead}>
                    <span className={styles.shortcutIcon} aria-hidden="true">
                      <Icon name="wallet" size={16} />
                    </span>
                    <span className={styles.shortcutText}>
                      <strong>Credit &amp; billing</strong>
                      <span>Prepaid balance, top-ups &amp; auto-recharge</span>
                    </span>
                  </span>
                  <span className={styles.shortcutChevron} aria-hidden="true">
                    <Icon name="chevron" size={15} />
                  </span>
                </a>
              </li>
              <li>
                <a className={styles.shortcutLink} href="/app#team">
                  <span className={styles.shortcutLead}>
                    <span className={styles.shortcutIcon} aria-hidden="true">
                      <Icon name="users" size={16} />
                    </span>
                    <span className={styles.shortcutText}>
                      <strong>Team &amp; workspaces</strong>
                      <span>Switch spaces, invites, webhooks &amp; alerts</span>
                    </span>
                  </span>
                  <span className={styles.shortcutChevron} aria-hidden="true">
                    <Icon name="chevron" size={15} />
                  </span>
                </a>
              </li>
            </ul>
          </section>

          {hasReadPermission && (
            <section className={styles.panel} aria-label="Recent ledger">
              <div className={styles.panelHeader}>
                <h2>Recent ledger</h2>
                <a className={styles.panelAction} href="/app#ledger">
                  Full ledger <Icon name="arrow" size={13} />
                </a>
              </div>
              {recentLedger.length > 0 ? (
                <ul className={styles.ledgerList}>
                  {recentLedger.slice(0, 5).map((entry) => (
                    <li className={styles.ledgerRow} key={entry.id}>
                      <div className={styles.ledgerKind}>
                        <strong>{entry.kind}</strong>
                        <small>{shortDate(entry.created_at)}</small>
                      </div>
                      <span
                        className={
                          entry.kind === 'credit' ||
                          entry.kind === 'opening' ||
                          entry.kind === 'release' ||
                          entry.kind === 'refund'
                            ? `${styles.ledgerAmount} ${styles.ledgerAmountCredit}`
                            : styles.ledgerAmount
                        }
                      >
                        {formatAmount(
                          entry.amount_micros,
                          entry.kind === 'credit' ||
                            entry.kind === 'opening' ||
                            entry.kind === 'release' ||
                            entry.kind === 'refund',
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.emptyWell}>
                  {loading
                    ? 'Loading ledger…'
                    : 'Prepaid credits, holds, and settled charges will appear here.'}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
