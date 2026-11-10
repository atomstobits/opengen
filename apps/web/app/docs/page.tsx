import { operationTargets, type OperationId } from '@media-router/contracts';
import { Footer, SiteHeader } from '../ui';
import { readWebLegalSurfacePresentation } from '../legal/publication';
import { CodeSample } from './code-sample';
import styles from './page.module.css';
import { JsonLd, canonicalUrl, pageMetadata } from '../seo';

export const metadata = pageMetadata({
  title: 'OpenGen API, MCP & self-hosting documentation',
  description:
    'Set up OpenGen, inspect model and regional route evidence, quote requests, connect agents and resume durable image or video generation jobs.',
  path: '/docs',
});

const sections = [
  ['start', 'Quickstart'],
  ['http-examples', 'Quote, submit and status'],
  ['api-reference', 'API reference'],
  ['catalog', 'The catalog'],
  ['regions', 'Regional providers'],
  ['generate', 'Quote and generate'],
  ['agents', 'Connect an agent'],
  ['workspace', 'Your workspace'],
  ['comparisons', 'Private comparisons'],
  ['compatibility', 'Compatibility'],
  ['events', 'Webhooks & alerts'],
  ['evidence', 'Evidence & metrics'],
  ['self-host', 'Self-host'],
  ['roadmap', 'Build status'],
] as const;

const apiOperations = [
  ['catalog.search', 'Discover exact model routes', '#catalog'],
  ['models.schema', 'Inspect model inputs and limits', '#start'],
  ['quotes.single', 'Get an estimate', '#http-examples'],
  ['assets.prepare', 'Prepare a private media upload', '/guides/image-to-video'],
  ['assets.complete', 'Complete the upload', '/guides/image-to-video'],
  ['media.generate', 'Submit an approved request', '#http-examples'],
  ['jobs.status', 'Wait for compact status', '#http-examples'],
  ['jobs.get', 'Read the job and refresh output links', '#http-examples'],
  ['jobs.lookup', 'Recover a lost submit response', '#http-examples'],
  ['balance.get', 'Inspect workspace credit', '#workspace'],
  ['doctor.get', 'Confirm paying workspace and access', '#start'],
  ['images.edit', 'Use owned image references', '#compatibility'],
  ['videos.content', 'Retrieve owned video bytes', '#compatibility'],
] as const satisfies readonly (readonly [OperationId, string, string])[];

export default function DocsPage() {
  const legal = readWebLegalSurfacePresentation();
  return (
    <>
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'TechArticle',
          headline: 'OpenGen API, MCP and self-hosting documentation',
          url: canonicalUrl('/docs'),
          description:
            'Setup and operating guide for the OpenGen image and video API catalog and gateway.',
          publisher: { '@id': `${canonicalUrl('/')}#organization` },
          isPartOf: { '@id': `${canonicalUrl('/')}#website` },
        }}
      />
      <SiteHeader />
      <main className="docs-page page-width">
        <span className="eyebrow">API / AGENTS / SELF-HOST</span>
        <h1>Build with OpenGen.</h1>
        <p className="docs-intro">
          Inspect an exact model, get a quote, then create with your workspace. Start here with
          curl, or choose your agent or browser workflow.
        </p>
        <nav className={styles.paths} aria-label="Choose your workflow">
          <a className="button button-dark" href="#http-examples">
            Use the API
          </a>
          <a className="button" href="/agents">
            Connect an agent
          </a>
          <a className="button" href="/playground">
            Create in Playground
          </a>
        </nav>
        <div className="docs-grid">
          <nav className="docs-index" aria-label="Documentation sections">
            <span className="eyebrow">ON THIS PAGE</span>
            {sections.map(([id, text]) => (
              <a key={id} href={`#${id}`}>
                {text}
              </a>
            ))}
          </nav>
          <div className={`docs-body ${styles.body}`}>
            <section id="start">
              <h2>1. Inspect your model.</h2>
              <p>
                Set <code>OPENGEN_API_URL</code> to your gateway’s origin, such as{' '}
                <code>https://opengen.dev</code>. Read its model schema before building a request.
                Discovery and estimates are free of generation charges.
              </p>
              <CodeSample
                title="Inspect model"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/models/schema?modelId=bytedance%2Fseedream-5.0-pro&operation=text-to-image"`}
              />
              <p>
                For private operations, <a href="/start">sign in to your workspace</a> and create a
                scoped OpenGen API key. Store it privately as <code>OPENGEN_TOKEN</code>. Submission
                requires <code>generate</code>, and private job reads require <code>read</code>.
                Provider credentials are configured on the gateway.
              </p>
              <CodeSample
                title="Workspace access"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/doctor" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN"`}
              />
              <p>
                Check the access report’s paying workspace, scopes, balance and billing holds. Use
                that workspace when approving the request’s payer and budget.
              </p>
              <p>
                Continue with the image request below, or follow the{' '}
                <a href="/guides/image-to-video">image-to-video walkthrough</a> for private media
                uploads, agent commands and recovery.
              </p>
            </section>
            <section id="http-examples">
              <h2>2. Quote your request.</h2>
              <p>
                Save this example as <code>request.json</code> in private storage. Adjust it to the
                model schema you inspected. The managed request below sets a one-dollar budget in
                integer micro-USD. Your quote shows route availability, estimates and notices.
              </p>
              <CodeSample
                title="Request JSON"
                code={`{
  "modelId": "bytedance/seedream-5.0-pro",
  "operation": "text-to-image",
  "input": {"prompt": "A paper lighthouse on a plain blue background.", "resolution": "1K"},
  "billing": "managed",
  "maxCostMicros": 1000000
}`}
              />
              <CodeSample
                title="Quote"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/quotes" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \\
  --data-binary @request.json`}
              />
              <div className="docs-callout">
                <p>
                  Confirm the paying workspace in your access report, then review the quote’s
                  estimate, notices, executable status and budget. A quote starts no generation and
                  reserves no funds. Approve the selected request and bounded spend before
                  submitting.
                </p>
              </div>
              <h3>3. Submit the approved request once.</h3>
              <p>
                Save a new <code>OPENGEN_IDEMPOTENCY_KEY</code> with the exact request before this
                paid operation. Keep that key for recovery and persist the returned job{' '}
                <code>id</code> immediately as <code>OPENGEN_JOB_ID</code>.
              </p>
              <CodeSample
                title="Paid submit"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/generations" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN" -H 'Content-Type: application/json' \\
  -H "Idempotency-Key: $OPENGEN_IDEMPOTENCY_KEY" --data-binary @request.json`}
              />
              <h3>4. Read the same job.</h3>
              <CodeSample
                title="Status"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/generations/$OPENGEN_JOB_ID/status" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN"`}
              />
              <p>
                Repeat the status read while work or delivery is pending. Compact status accepts the
                last <code>revision</code> as <code>afterRevision</code> and a bounded{' '}
                <code>waitMs</code> of up to 25000. Read the full job for fresh private output links
                once delivery is <code>available</code> or <code>partial</code>.
              </p>
              <CodeSample
                title="Job and output links"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/generations/$OPENGEN_JOB_ID" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN"`}
              />
              <h3>Recover a lost submit response.</h3>
              <p>
                If submission returns no job ID, retain the original body and key. Look up that
                request using URL encoding. A missing result can still reflect an unresolved
                submission. Continue read-only recovery with the same key and gateway.
              </p>
              <CodeSample
                title="Recover request"
                code={`curl --fail-with-body --get "$OPENGEN_API_URL/v1/generations/lookup" \\
  -H "Authorization: Bearer $OPENGEN_TOKEN" \\
  --data-urlencode "idempotencyKey=$OPENGEN_IDEMPOTENCY_KEY"`}
              />
              <p>
                Preserve the original job across timeouts. Changing the request under its saved key
                causes a conflict. Generation, delivery and settlement have separate states. Keep
                signed media URLs in private storage and refresh them by reading the same retained
                job. Terminal delivery failure or expiry needs operator help.
              </p>
            </section>
            <section id="api-reference">
              <h2>API reference</h2>
              <p>
                <a href="/openapi.json">Open the OpenAPI 3.1 specification</a> for request fields,
                authentication, response schemas and error codes. The{' '}
                <a href="/v1/operations">operation registry</a> lists the same native operations
                available through MCP’s <code>call</code> tool. These paths use your gateway origin.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th scope="col">HTTP endpoint</th>
                    <th scope="col">MCP operation</th>
                    <th scope="col">Workflow</th>
                  </tr>
                </thead>
                <tbody>
                  {apiOperations.map(([id, title, href]) => (
                    <tr key={id}>
                      <td>
                        <code>
                          {operationTargets[id].method}{' '}
                          {operationTargets[id].path.replace(/:([a-zA-Z]+)/g, '{$1}')}
                        </code>
                      </td>
                      <td>
                        <code>{id}</code>
                      </td>
                      <td>
                        <a href={href}>{title}</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Inspect <code>models.schema</code> for the selected model and operation. Its{' '}
                <code>inputSchema</code> describes fields inside <code>input</code>. The request
                envelope also needs <code>modelId</code> and <code>operation</code>. Operator-only
                operations in the full specification require installation privileges.
              </p>
            </section>
            <section id="catalog">
              <h2>The catalog is the contract.</h2>
              <p>
                Discover a model, read its exact variant and inspect the routes before constructing
                a request. A family groups related models; a route identifies the exact model served
                by a specific provider deployment.
              </p>
              <CodeSample
                title="HTTP example"
                code={`GET /v1/models\nPOST /v1/quotes\nPOST /v1/generations\nGET /v1/generations/{id}`}
              />
              <p>
                <strong>H3 Max and MiniMax H3 Max share one variant.</strong> MiniMax and fal appear
                as separate providers for <code>minimax/h3-max</code>. H3 Max Turbo and Pika H3 Flex
                remain distinct. Each provider keeps its own capability limits and regional routes.
              </p>
              <p>
                Each route links to its original documentation and pricing evidence. Open weights
                and commercial usage permissions are separate properties.
              </p>
            </section>
            <section id="regions">
              <h2>A region is a selectable route.</h2>
              <p>
                Each documented model–regional deployment combination appears separately. Alibaba’s
                Wan 3.0 Standard and Prime each have documented offerings in Beijing, Singapore,
                Tokyo, Frankfurt, Virginia and Hong Kong.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>What it tells you</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Endpoint region</td>
                    <td>Where requests enter the provider</td>
                  </tr>
                  <tr>
                    <td>Inference scope</td>
                    <td>Where the provider permits processing</td>
                  </tr>
                  <tr>
                    <td>Processing/storage regions</td>
                    <td>Provider-published locations, or unknown</td>
                  </tr>
                  <tr>
                    <td>Measurement origin</td>
                    <td>Where a performance sample was taken</td>
                  </tr>
                </tbody>
              </table>
              <p>
                <strong>
                  A Frankfurt endpoint with a Global inference scope is not an EU-only commitment.
                </strong>{' '}
                Undisclosed processing locations remain unknown. Regional prices, credentials,
                limits and observations are kept separate.
              </p>
              <p>
                Pin a route ID to stay on one regional deployment. Region restrictions apply to
                every eligible attempt. A provider’s broad regional footprint does not imply that
                every model is offered everywhere.
              </p>
            </section>
            <section id="generate">
              <h2>Quotes and regional routes</h2>
              <p>
                Quotes show a request-specific estimate and whether this installation can execute
                the route. A catalog-only route can have a published price while remaining
                unavailable for generation here.
              </p>
              <CodeSample
                title="HTTP example"
                code={`curl --fail-with-body "$OPENGEN_API_URL/v1/quotes" \\\n  -H 'Content-Type: application/json' \\\n  -d '{\n    "modelId": "alibaba/wan-3.0",\n    "operation": "text-to-video",\n    "input": {\n      "prompt": "A slow tracking shot along a coastal road.",\n      "resolution": "720p",\n      "duration": 5\n    },\n    "maxCostMicros": 2000000\n  }'`}
              />
              <p>
                Use the canonical model ID returned by your catalog; the example must be adjusted if
                the ID differs. Generation is a separate, authenticated request. Send a stable{' '}
                <code>Idempotency-Key</code> with the same input when retrying a submission.
              </p>
              <div className="docs-callout">
                <p>
                  <strong>A timeout is not proof that a paid generation failed.</strong> Save the
                  gateway job ID and poll it. Do not replace an unresolved submission with a new
                  request key. A job can explicitly report <code>submission-unknown</code> while the
                  upstream outcome is unresolved.
                </p>
              </div>
              <p>
                Provider attempts, reserved funds and settlement are separate records. Requesting
                cancellation does not establish that the provider cancelled or refunded the
                generation.
              </p>
              <p>
                Fallback is opt-in and only follows an explicit provider rejection before
                acceptance. It preserves the exact variant and policy restrictions. An uncertain
                acceptance never triggers an automatic replacement. Inspect the quote’s{' '}
                <code>reservationMicros</code>: managed fallback can reserve the largest estimate
                among up to four eligible attempts. Speed and reliability preferences require enough
                matching observations; unmeasured routes are not assigned invented scores.
              </p>
            </section>
            <section id="agents">
              <h2>Give your agent one doorway.</h2>
              <p>
                Choose your client in <a href="/agents">agent setup</a> for sign-in and workspace
                consent. The gateway’s <a href="/llms.txt">llms.txt</a> and{' '}
                <a href="/skill.md">OpenGen skill</a> describe discovery, quotes and job recovery.
              </p>
              <CodeSample
                title="HTTP example"
                code={`# Read-only discovery on the configured installation
curl --fail-with-body "$OPENGEN_API_URL/llms.txt"
# MCP uses Streamable HTTP POST at the same origin’s /mcp`}
              />
              <p>
                The shared tool surface follows{' '}
                <strong>catalog_search → catalog_get → quote → call → job_get</strong>. Generation
                uses the same account and execution rules as the REST API. Provider credentials stay
                on the server.
              </p>
              <p>
                On your gateway, <code>GET /v1/operations</code> lists registered operation IDs and{' '}
                <code>GET /openapi.json</code> describes the native API. MCP’s <code>call</code>{' '}
                tool accepts explicit operations such as <code>media.generate</code>,{' '}
                <code>assets.prepare</code>, <code>keys.create</code> and{' '}
                <code>policies.create</code>. It cannot target arbitrary URLs, and every operation
                enforces the same REST scopes and workspace rules.
              </p>
              <p>
                The browser uses a private HttpOnly session. When the installation has OpenID
                Connect configured, sign in through its identity provider. Self-hosted operators can
                also connect with a gateway API key. The browser exchanges that key for a session
                and does not save it in local or session storage. Provider keys are configured
                separately and stay encrypted on the gateway.
              </p>
              <p>
                Remote clients discover the installation’s OAuth metadata. Native authorization
                supports PKCE and registered clients; installations may also configure an external
                issuer. Follow the installation’s published agent setup for sign-in and workspace
                consent. Source support does not establish actual client authorization or a live
                generation result.
              </p>
            </section>
            <section id="workspace">
              <h2>One workspace for people and agents.</h2>
              <p>
                The <a href="/dashboard">workspace</a> shows recent generations, available and
                reserved credit, and usage ledger entries. A generation keeps the exact selected
                model and regional provider route. A pending settlement remains visible instead of
                being presented as a confirmed refund.
              </p>
              <p>
                Create a separate scoped API key for each application or agent. Keys are shown once;
                copy them into your secret manager. Revoking a key also revokes browser sessions
                that depend on it. A saved routing profile can restrict endpoint regions and
                spending for that key; requests cannot expand those restrictions.
              </p>
              <p>
                Provider connections belong to a specific workspace and regional deployment. With
                the vault enabled, the gateway encrypts these credentials at rest and never returns
                the saved secret. “My provider account” billing requires your own connection. Your
                provider bills you directly; unknown-priced requests cannot promise a gateway
                spending ceiling.
              </p>
              <p>
                Private uploads use the installation’s object storage. The browser retains stable
                asset keys with its draft; the gateway validates ownership and refreshes access at
                dispatch. An upload requires authenticated access and configured storage. The
                playground saves drafts and stable submission keys in the current tab so reloading
                does not create a second paid request.
              </p>
              <CodeSample
                title="HTTP example"
                code={`GET /v1/session
GET /v1/generations
GET /v1/balance
GET /v1/ledger
POST /v1/keys
POST /v1/policies
PUT /v1/connections/{deploymentId}
POST /v1/assets
POST /v1/assets/complete`}
              />
            </section>
            <section id="comparisons">
              <h2>Compare two image models privately.</h2>
              <p>
                The <a href="/playground/compare">comparison workspace</a> uses one prompt with two
                distinct exact models and pinned text-to-image routes. Each route needs an
                executable managed quote. Review both requests, their notices and the combined
                spending ceiling before approving the run.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th scope="col">HTTP endpoint</th>
                    <th scope="col">Behavior</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>POST /v1/comparisons/quote</code>
                    </td>
                    <td>
                      Save a private quote from a prompt and exactly two route IDs. Requires read
                      scope. Returns 201.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/comparisons/&#123;id&#125;/approve</code>
                    </td>
                    <td>
                      Approve the saved run with generate scope and an absent request body. Returns
                      202.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /v1/comparisons/&#123;id&#125;</code>
                    </td>
                    <td>
                      Read the same private run, its child jobs and current output links with read
                      scope.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /v1/comparisons</code>
                    </td>
                    <td>List the latest 20 admitted runs for the authorized workspace.</td>
                  </tr>
                </tbody>
              </table>
              <p>
                These comparison routes use HTTP directly. The OpenAPI specification describes their
                payloads. The saved run ID and server-owned child keys make repeated approval
                resolve to the same admitted pair. Persist that ID and recover by reading the same
                run after a timeout. Approval reserves both children together. Each job then tracks
                its own delivery and settlement. Comparison results and prompts belong to the
                authorized workspace.
              </p>
            </section>
            <section id="compatibility">
              <h2>Use the native API for the full contract.</h2>
              <p>
                OpenAI-style endpoints provide a strict subset. Unsupported fields fail instead of
                being silently dropped. They require an OpenGen workspace key and a stable{' '}
                <code>Idempotency-Key</code>, and accept exact OpenGen model IDs.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th>Implemented subset</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <code>POST /v1/images/generations</code>
                    </td>
                    <td>
                      One text-to-image result at a supported 1K/2K/4K tier, delivered by owned URL
                      or base64. Base64 is limited to 8 MiB decoded PNG/JPEG/WebP; a larger result
                      remains the same job and can be retrieved by URL.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/images/edits</code>
                    </td>
                    <td>
                      Ready owned image references in JSON or bounded multipart text fields (256
                      KiB, 24 parts). Upload and complete through native assets first. Model limits
                      may narrow the 1–10 reference envelope; binary parts and masks are
                      unsupported.
                    </td>
                  </tr>
                  <tr>
                    <td>Slow image requests</td>
                    <td>
                      After a bounded wait, HTTP 202 returns the existing job ID and native poll
                      URL. This is an OpenGen extension, not a synchronous image result.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>POST /v1/videos</code>
                    </td>
                    <td>
                      JSON text-to-video with exact supported duration and landscape/portrait size.
                      No multipart first frame or remix.
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <code>GET /v1/videos/&#123;id&#125;/content</code>
                    </td>
                    <td>
                      Without Range, authenticated HTTP 303 to a private owned capability. A single
                      byte Range returns 206 from owned MP4 storage up to 100 MiB; malformed,
                      multiple or unsatisfiable ranges return 416. If-Range mismatch returns the
                      complete 200 response. Binary Range retrieval is HTTP-only.
                    </td>
                  </tr>
                </tbody>
              </table>
              <p>
                This is a selected compatibility subset. Use native jobs to inspect the original
                route, unknown-submission state, output delivery, C2PA evidence and settlement. The
                repository’s compatibility matrix records the exact accepted fields and extensions.
              </p>
            </section>
            <section id="events">
              <h2>Know when media is ready and billing is final.</h2>
              <p>
                Subscribe to signed <code>generation.completed</code> and{' '}
                <code>billing.settled</code> events separately. A transactional outbox retains
                delivery IDs and retries failed deliveries with backoff. Validate the timestamp and
                HMAC against the exact raw body, deduplicate event IDs, and do not assume event
                ordering. The repository’s webhook guide includes the signing format.
              </p>
              <p>
                Workspace alerts cover configured low-balance, spending, key-expiry and webhook
                delivery conditions, including resolution events. Destinations must be public HTTPS;
                provider response bodies, prompts and output URLs are not included in event
                payloads. Webhook signing secrets are returned once and stored encrypted.
              </p>
            </section>
            <section id="evidence">
              <h2>Evidence before a score.</h2>
              <p>
                Catalog status, execution availability and observed health are separate.
                “Documented” means that the provider publishes the offering; it does not mean this
                installation has live-tested it.
              </p>
              <ul>
                <li>
                  Unobserved routes show <strong>unknown</strong>, never an invented speed or
                  success score.
                </li>
                <li>Provider-attempt success and final job success are different metrics.</li>
                <li>
                  Technical failures, policy rejections and unresolved jobs need separate
                  denominators.
                </li>
                <li>
                  Comparable samples use matching model, operation, resolution and duration, with a
                  visible origin and window.
                </li>
                <li>
                  Published prices include a source and check date. Reference inputs and other
                  charges may require a separate quote.
                </li>
              </ul>
              <p>
                Delivered files carry separate content-credential verification when the installation
                has the C2PA verifier configured. Each output distinguishes a valid signature,
                trusted signer, invalid or absent credentials, and unavailable verification, with a
                file hash and check time. A catalog listing never establishes output provenance.
              </p>
            </section>
            <section id="self-host">
              <h2>Your keys. Your infrastructure.</h2>
              <p>
                OpenGen is an independent Apache-2.0 implementation. The gateway, catalog,
                application and deployment instructions belong to the public project; no proprietary
                control plane is required.
              </p>
              <p>
                The first runtime uses PostgreSQL for durable jobs and accounting. Configure
                provider credentials on the server. Alibaba regional credentials must match the
                selected workspace and endpoint. Keep API tokens and provider secrets out of source
                control.
              </p>
              <p>
                Deploy the website behind the same trusted access boundary as your gateway when
                running a private installation. Read the root README and deployment files before
                exposing a service publicly.
              </p>
            </section>
            <section id="roadmap">
              <h2>Build status</h2>
              <p>
                This is a release candidate under validation. The catalog states which routes are
                documented; the quote states what the current installation can execute. Implemented
                protocol support and synthetic fixture tests do not establish live account access,
                measured quality or final billing accuracy.
              </p>
              <table className="docs-table">
                <thead>
                  <tr>
                    <th>Layer</th>
                    <th>Release requirement</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Catalog</td>
                    <td>
                      Complete initial model scope, separate regional deployments, source links and
                      capability contracts
                    </td>
                  </tr>
                  <tr>
                    <td>Execution</td>
                    <td>
                      Durable jobs, idempotency, regional pinning, bounded reservations and explicit
                      unknown submissions
                    </td>
                  </tr>
                  <tr>
                    <td>Agent interfaces</td>
                    <td>
                      Canonical HTTP and MCP over the same application services; CLI onboarding is
                      separately available
                    </td>
                  </tr>
                  <tr>
                    <td>Full v1 additions</td>
                    <td>
                      Output provenance verification, saved routing profiles, compatibility
                      endpoints, batch quotes, signed outbound webhooks, alerts and browser
                      submission recovery
                    </td>
                  </tr>
                  <tr>
                    <td>Later optional modules</td>
                    <td>Opt-in stalled-image acceleration, rebates and referral workflows</td>
                  </tr>
                </tbody>
              </table>
              <p>
                The repository plan records the implementation milestones and acceptance gates.
                Catalog breadth must never be presented as verified execution coverage.
              </p>
              <p>
                {legal.mode === 'published' ? (
                  <>
                    Hosted legal policies: <a href="/terms">Terms of Service</a>,{' '}
                    <a href="/refunds">Prepaid Credit and Refund Policy</a> and{' '}
                    <a href="/privacy">Privacy Notice</a>. Business templates:{' '}
                    <a href="/data-processing">Business Data Processing Addendum</a> and{' '}
                    <a href="/subprocessors">Subprocessor Schedule</a> (available templates only —
                    not executed by publication).
                  </>
                ) : legal.mode === 'staged' ? (
                  <>
                    Hosted legal documents: <a href="/terms">Terms of Service</a>,{' '}
                    <a href="/refunds">Prepaid Credit and Refund Policy</a> and{' '}
                    <a href="/privacy">Privacy Notice</a> (scheduled effective {legal.effectiveAt} —
                    not yet effective), plus available business templates{' '}
                    <a href="/data-processing">Business Data Processing Addendum</a> and{' '}
                    <a href="/subprocessors">Subprocessor Schedule</a> (templates only — not
                    executed by publication).
                  </>
                ) : (
                  <>
                    Legal review drafts: <a href="/terms">Terms of Service</a>,{' '}
                    <a href="/refunds">Prepaid Credit and Refund Policy</a>,{' '}
                    <a href="/privacy">Privacy Notice</a>,{' '}
                    <a href="/data-processing">Business Data Processing Addendum</a> and{' '}
                    <a href="/subprocessors">Subprocessor Schedule</a>. These proposals are not
                    effective or adopted.
                  </>
                )}
              </p>
            </section>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
