import { notFound } from 'next/navigation';
import { pageMetadata, siteOrigin } from '../../seo';
import { CopyButton, Footer, SiteHeader } from '../../ui';
import { AGENT_REVIEW_DATE, agentClients, findAgentClient } from '../clients';
import styles from '../setup.module.css';

export function generateStaticParams() {
  return agentClients.map(({ slug }) => ({ client: slug }));
}
export async function generateMetadata({ params }: { params: Promise<{ client: string }> }) {
  const client = findAgentClient((await params).client);
  if (!client) return {};
  return pageMetadata({
    title: `Set up ${client.name} | OpenGen`,
    description: `${client.summary} Documentation-based setup, with explicit OpenGen verification status.`,
    path: `/agents/${client.slug}`,
  });
}

export default async function AgentSetupPage({ params }: { params: Promise<{ client: string }> }) {
  const client = findAgentClient((await params).client);
  if (!client) notFound();
  const origin = siteOrigin();
  const snippet = client.snippet?.(origin);
  const bindingCommand = ['cursor', 'claude-code'].includes(client.slug)
    ? `opengen bind preview --client ${client.slug} --config /absolute/path/to/your-project/${client.slug === 'cursor' ? '.cursor/mcp.json' : '.mcp.json'} --url ${origin}`
    : null;
  return (
    <>
      <SiteHeader />
      <main className={`${styles.page} page-width`}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <a href="/agents">Agent setup</a>
          <span aria-hidden="true">/</span>
          <span>{client.name}</span>
        </nav>
        <header className={styles.detailHero}>
          <span className={styles.monogram} aria-hidden="true">
            {client.monogram}
          </span>
          <span className="eyebrow">{client.kind.toUpperCase()}</span>
          <h1>Create with {client.name}.</h1>
          <p>{client.summary}</p>
          <div className={styles.actions}>
            <a className="button button-dark" href="/start">
              Open your workspace ↗
            </a>
            <a className={styles.textLink} href="/playground">
              Create in browser →
            </a>
          </div>
        </header>
        <div className={styles.detailGrid}>
          <section className={styles.instructions} aria-labelledby="setup-title">
            <span className={styles.kind}>{client.approach}</span>
            <h2 id="setup-title">A few steps to get connected.</h2>
            <ol className={styles.steps}>
              {client.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            {client.slug !== 'pi' && client.slug !== 'cli' && (
              <div className={styles.codeBlock}>
                <span>Endpoint format · use your configured gateway</span>
                <div>
                  <code>{origin}/mcp</code>
                  <CopyButton text={`${origin}/mcp`} label="Copy address" />
                </div>
              </div>
            )}
            {snippet && (
              <div className={styles.codeBlock}>
                <span>{snippet.label}</span>
                <pre>
                  <code>{snippet.code}</code>
                </pre>
                <CopyButton text={snippet.code} label="Copy example" />
              </div>
            )}
            {bindingCommand && (
              <details className={styles.codeBlock}>
                <summary>Preview a project configuration change</summary>
                <p>
                  With the reviewed portable OpenGen CLI installed on Node 22.12 or later, preview
                  the change below. Preview writes nothing. Preserve the printed previewId, then use
                  apply with the same options and --preview-id only after review. No global
                  destination is selected and no token is copied.
                </p>
                <pre>
                  <code>{bindingCommand}</code>
                </pre>
                <CopyButton text={bindingCommand} label="Copy preview command" />
              </details>
            )}
            <p className={styles.source}>
              Instructions based on <a href={client.source.url}>{client.source.label} ↗</a>,
              reviewed {AGENT_REVIEW_DATE}. Client interfaces and permissions can change.
            </p>
            {client.slug !== 'cli' && (
              <p>
                Prefer a shell workflow?{' '}
                <a href="/agents/cli">Use OpenGen’s CLI and browser login →</a>
              </p>
            )}
          </section>
          <aside className={styles.aside} aria-label="Setup evidence and permissions">
            <span className={styles.status}>VERIFICATION PENDING</span>
            <h2>Know what you’re connecting.</h2>
            <p>{client.caution}</p>
            <dl className={styles.evidence}>
              <div>
                <dt>Documentation reviewed</dt>
                <dd>{AGENT_REVIEW_DATE}</dd>
              </div>
              <div>
                <dt>Actual client / version / test date</dt>
                <dd>
                  {client.slug === 'cli'
                    ? 'Source CLI fixtures only. No deployed identity-provider test.'
                    : 'None recorded. Not verified end to end.'}
                </dd>
              </div>
              <div>
                <dt>OpenGen protocol evidence</dt>
                <dd>Local authorization and CLI fixtures, separate from client compatibility.</dd>
              </div>
            </dl>
            <a href="/agents#support-matrix">Compare support evidence →</a>
          </aside>
        </div>
        <section className={styles.consent} aria-labelledby="consent-title">
          <span className="eyebrow">YOU CHOOSE THE WORKSPACE</span>
          <h2 id="consent-title">Connect with a clear view of the cost.</h2>
          <div className={styles.routes}>
            <div>
              <h3>Review consent</h3>
              <p>
                Check the app name, callback destination, permissions and paying workspace. Read
                allows discovery; generate permits billable jobs within your workspace’s rules.
                Denying consent grants no access.
              </p>
            </div>
            <div>
              <h3>Start with discovery</h3>
              <p>
                Ask for catalog search, inspect a model and request a quote. Check availability and
                the spending ceiling before generation. Your new personal workspace starts with zero
                managed credit.
              </p>
            </div>
            <div>
              <h3>Stay in control</h3>
              <p>
                Manage connected apps and revoke their authorizations in your workspace. Keep API
                keys separate for each application. Signing out of the website does not revoke an
                agent’s grant.
              </p>
            </div>
          </div>
        </section>
        <section className={styles.recovery} aria-labelledby="recovery-title">
          <h2 id="recovery-title">If setup stops halfway</h2>
          <details>
            <summary>The browser sign-in is unavailable</summary>
            <p>
              Your deployment must have sign-in configured. Start at{' '}
              <a href="/start">your workspace</a> to check availability. Hosted assistants need a
              publicly reachable HTTPS endpoint; installing code inside their sandbox does not
              create a hosted connector.
            </p>
          </details>
          <details>
            <summary>I denied consent or chose the wrong workspace</summary>
            <p>
              Start connection again and review the paying workspace before approving. A key stays
              in its issued workspace. To change an agent’s workspace, revoke its old authorization
              and sign in again with the intended selection.
            </p>
          </details>
          <details>
            <summary>Local login expired or was interrupted</summary>
            <p>
              Run <code>opengen doctor</code> using the installed CLI. Sign in again when expired or
              revoked. A stale profile lock requires checking that no OpenGen process is active
              before removing it; never bypass token-reuse checks or share the profile.
            </p>
          </details>
          <details>
            <summary>I want to disconnect</summary>
            <p>
              Revoke the connected app in OpenGen’s workspace, then remove its client configuration.
              For OpenGen’s CLI, <code>opengen logout</code> revokes before deleting the private
              profile. If revocation fails, keep the profile and retry.
            </p>
          </details>
        </section>
      </main>
      <Footer />
    </>
  );
}
