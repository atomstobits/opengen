import styles from './onboarding.module.css';

export function FirstSteps({
  workspaceId,
  hasGenerations = false,
  hasCredit = false,
}: {
  workspaceId?: string;
  hasGenerations?: boolean;
  hasCredit?: boolean;
}) {
  return (
    <section className={styles.journey} aria-labelledby="first-steps-title">
      <ol className={styles.steps} aria-label="Getting started">
        <li>1 · Account connected</li>
        <li aria-current="step">2 · Choose your way to create</li>
        <li>3 · Quote, then generate</li>
      </ol>
      <h2 id="first-steps-title">
        {hasGenerations ? 'Your next idea starts here.' : 'Make yourself at home.'}
      </h2>
      <p>
        Your selected workspace holds your creations, credit and access. Agent approvals and API
        keys apply to this workspace.
      </p>
      {workspaceId && (
        <strong className={styles.workspaceId}>Selected workspace: {workspaceId}</strong>
      )}
      <div className={styles.choices}>
        <a className={styles.choice} href="/agents">
          <span>01 / AGENT</span>
          <h3>Connect your agent ↗</h3>
          <p>Choose your app, review permissions and approve the paying workspace.</p>
        </a>
        <a className={styles.choice} href="/agents/cli">
          <span>02 / CLI + API</span>
          <h3>Build your workflow ↗</h3>
          <p>Use browser login for the CLI, or create a scoped key for your application.</p>
        </a>
        <a className={styles.choice} href="/playground">
          <span>03 / BROWSER</span>
          <h3>Create in browser ↗</h3>
          <p>Choose a model, describe your idea and compare a quote before creating.</p>
        </a>
      </div>
      {!hasCredit && (
        <p className={styles.funding}>
          New workspaces start with $0 managed credit. Managed creation needs available credit; a
          quote checks route availability before you submit.{' '}
          <a href="/billing">Credit & billing ↗</a>
        </p>
      )}
      <nav className={styles.nav} aria-label="Workspace setup">
        <a href="/app#team">Workspace & invitations</a>
        <a href="/app#keys">API keys</a>
        <a href="/app#apps">Connected apps</a>
      </nav>
    </section>
  );
}
