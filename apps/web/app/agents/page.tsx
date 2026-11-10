import { pageMetadata } from '../seo';
import { Footer, SiteHeader } from '../ui';
import { AGENT_REVIEW_DATE, agentClients } from './clients';
import styles from './setup.module.css';

export const metadata = pageMetadata({
  title: 'Connect your agent | OpenGen',
  description:
    'Set up OpenGen with hosted assistants, local coding agents, the CLI or API. See dated setup instructions and verification status for each client.',
  path: '/agents',
});

export default function AgentsPage() {
  return (
    <>
      <SiteHeader />
      <main className={`${styles.page} page-width`}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <a href="/">OpenGen</a>
          <span aria-hidden="true">/</span>
          <span>Agent setup</span>
        </nav>
        <header className={styles.hero}>
          <span className="eyebrow">AGENT / CLI / API</span>
          <h1>
            Your tools.
            <br />A new creative outlet.
          </h1>
          <p>
            Find an image or video model, inspect its options and get a quote from the place you
            already work.
          </p>
          <div className={styles.actions}>
            <a className="button button-dark" href="/start">
              Start with your workspace ↗
            </a>
            <a className={styles.textLink} href="/playground">
              Create in browser →
            </a>
          </div>
        </header>
        <section className={styles.routes} aria-label="Choose your connection">
          <div>
            <span className={styles.number}>01</span>
            <h2>Hosted assistant</h2>
            <p>
              Add the gateway’s MCP address in your client. Sign in and choose the workspace that
              pays. There’s no local installer.
            </p>
          </div>
          <div>
            <span className={styles.number}>02</span>
            <h2>Local agent</h2>
            <p>
              Use the client’s MCP OAuth support, or OpenGen’s source CLI with browser login and a
              private local profile.
            </p>
          </div>
          <div>
            <span className={styles.number}>03</span>
            <h2>Your application</h2>
            <p>
              Create a separate expiring API key in your workspace. Keep its read/generate
              permissions limited to the job.
            </p>
          </div>
        </section>
        <section className={styles.notice} aria-labelledby="verification-note">
          <strong id="verification-note">Setup guides, with the evidence attached.</strong>
          <p>
            Reviewed {AGENT_REVIEW_DATE}. OpenGen’s authorization and CLI have local protocol
            fixtures. Third-party client versions have not been verified end to end. Hosted sign-in
            and generation need a configured deployment; a guide is not a claim that the public
            service is ready.
          </p>
          <a href="#support-matrix">See the support matrix ↓</a>
          <p>
            Ready to use a private reference?{' '}
            <a href="/guides/image-to-video">Follow the image-to-video walkthrough →</a>
          </p>
        </section>
        <section aria-labelledby="choose-agent">
          <div className={styles.sectionHeading}>
            <h2 id="choose-agent">Where do you want to create?</h2>
            <span>Choose your setup</span>
          </div>
          <div className={styles.clients}>
            {agentClients.map((client) => (
              <a className={styles.client} href={`/agents/${client.slug}`} key={client.slug}>
                <span className={styles.monogram} aria-hidden="true">
                  {client.monogram}
                </span>
                <div>
                  <span className={styles.kind}>{client.kind}</span>
                  <h3>{client.name}</h3>
                  <p>{client.summary}</p>
                  <span className={styles.clientStatus}>
                    {client.slug === 'cli'
                      ? 'Local protocol fixtures'
                      : 'Client verification pending'}
                  </span>
                </div>
                <span className={styles.arrow} aria-hidden="true">
                  ↗
                </span>
              </a>
            ))}
          </div>
        </section>
        <section
          className={styles.matrixSection}
          id="support-matrix"
          aria-labelledby="matrix-title"
        >
          <h2 id="matrix-title">What has actually been checked?</h2>
          <p>
            Documentation reviewed {AGENT_REVIEW_DATE}. “Protocol fixtures” means synthetic requests
            against local code, without a real client, identity provider or generation charge.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.matrix}>
              <caption>OpenGen client support evidence as of {AGENT_REVIEW_DATE}</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Setup path</th>
                  <th scope="col">Documentation</th>
                  <th scope="col">Tested client / version / date</th>
                </tr>
              </thead>
              <tbody>
                {agentClients.map((client) => (
                  <tr key={client.slug}>
                    <th scope="row">
                      <a href={`/agents/${client.slug}`}>{client.name}</a>
                    </th>
                    <td>{client.approach}</td>
                    <td>
                      <a href={client.source.url}>{client.source.label} ↗</a>
                    </td>
                    <td>
                      {client.slug === 'cli'
                        ? 'Local fixtures only; deployed login unverified'
                        : 'None recorded — unverified'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.finePrint}>
            The OpenGen protocol fixtures cover PKCE/state, workspace consent, permission
            boundaries, token rotation/revocation and private profiles. They do not certify any
            third-party client. pi’s documented core has no native MCP; its CLI path is unverified.
          </p>
        </section>
      </main>
      <Footer />
    </>
  );
}
