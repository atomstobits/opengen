# Authentication and workspace access

OpenGen supports workspace API keys, HttpOnly browser sessions, its own MCP OAuth authorization server and optional external identity-provider integration. The repository does not provision an identity provider. Real browser sign-in and hosted-client validation remain deployment release checks.

## API keys and browser sessions

`MR_API_TOKEN` is the privileged installation bootstrap token. Keep it in the operator's secret manager; do not share it as a customer credential or inject it into anonymous website proxy calls. Workspace API keys are generated once by `POST /v1/keys`, stored as hashes and revoked through `DELETE /v1/keys/{id}`. Use distinct scoped keys for each agent/application. Scopes include `read`, `generate`, `keys:write`, `policies:write`, `connections:write` and `webhooks:write`; the server is authoritative about supported scopes.

The browser exchanges a workspace key at `POST /v1/session` for an opaque HttpOnly session. Sessions use Secure cookies on HTTPS installations and expire after twelve hours. Revoking a key invalidates its dependent sessions. `DELETE /v1/session` signs out. The website does not persist the API key in local/session storage. Mutating browser requests must match the configured `OPENGEN_PUBLIC_URL` origin, so set that public origin to the actual website URL, including the local port during development.

Saved policies can restrict providers/deployments, endpoint/processing regions, fidelity, fallback and per-request cost. Requests may narrow these rules; a restricted key cannot create an unrestricted child key. Workspace provider connections are separate from OpenGen keys: they are encrypted with `MR_VAULT_KEY` and bound to one regional deployment. Set `billing: "byok"` explicitly to use an owned provider connection. Managed calls use operator-funded credentials exclusively; BYOK calls must never fall back to operator credentials.

## Optional browser OpenID Connect

Configure these server-only values:

```dotenv
OPENGEN_PUBLIC_URL=https://your-opengen.example
OIDC_ISSUER=https://your-identity-provider.example
OIDC_CLIENT_ID=
OIDC_CLIENT_SECRET=
MR_SESSION_SECRET=
```

Create a client with your chosen identity provider and register the exact redirect URL `https://your-opengen.example/auth/callback`. Supply a cryptographically random `MR_SESSION_SECRET` of at least 32 characters through secure configuration. The identity provider handles authentication and its own multi-factor/account policy. OpenGen's `/auth/login` uses discovery and authorization-code exchange with PKCE, state, nonce and ID-token validation through `openid-client`. The frontend `/auth/login` and `/auth/callback` handlers proxy to the configured gateway.

`GET /auth/login` first presents the shared server-rendered Terms/Privacy notice. A bounded same-origin POST Continue with a signed expiring intent starts the existing OIDC PKCE/state/nonce flow. The current policy is draft/inactive, so sign-in does not accept it or create a Terms receipt. For a separately adopted effective policy, only a successfully verified human flow records an immutable minimal identity/policy receipt before browser session issuance; this does not authorize scopes, funding or a DPA. Direct, MCP and local CLI entries use the same notice and bind/recheck the pending consent request. See [IDENTITY-TERMS.md](IDENTITY-TERMS.md) for the exact boundary and evidence.

The verified issuer/subject identity maps to a private zero-credit workspace. Browser sign-in does not mint managed credit. A verified user can create an unfunded team workspace. Administrators can invite identities that have already signed in to this installation; the recipient explicitly accepts, then selects the workspace in the browser. Admin/member roles clamp access on each request, and removal invalidates membership-backed keys/sessions. Invitation email delivery is not provided. Fixed-workspace API keys cannot switch a browser session into another workspace.

Normal browser sign-in lands on `/app#start`. A valid pending MCP consent request takes precedence and returns to its consent screen. Arbitrary return URLs are not accepted. The authenticated application has Start (`/app#start`), Activity (`/app#activity`) and Team (`/app#team`) views, with separate API-key and connected-app destinations. Existing `/dashboard` hashes remain compatible. `/start` remains the public sign-in/onboarding entry.

Browser login requires a running account backend with PostgreSQL (`DATABASE_URL`) as well as the OIDC configuration above. A catalog-only preview with `database: false` and `oidcEnabled: false` cannot sign in real accounts. Its login-unavailable message is intentional. Protocol tests and screenshots with synthetic sessions do not establish a configured hosted identity provider.

The future OpenAI public-plugin application adds a separate compatibility/review gate. Auth0 is a candidate, not an installed integration. Keep human login and connector authorization distinct, and validate the hosted arrangement against OpenAI's current MCP requirements. Optional Sign in with ChatGPT is a separate, currently limited offering. See [OPENAI-PLUGIN-READINESS.md](OPENAI-PLUGIN-READINESS.md).

## Hosted MCP and browser authorization

Add `https://your-opengen.example/mcp` to a remote MCP client. Protected-resource metadata at `/.well-known/oauth-protected-resource/mcp` discovers OpenGen's authorization server at `/.well-known/oauth-authorization-server`. Public clients can register exact HTTPS callbacks, literal HTTP loopback callbacks or `http://localhost:<port>/<path>` callbacks with an explicit positive port through `/oauth/register`; registration and authorization requests have database-backed rate limits and client limits. Dynamic client metadata URL documents are not supported, and their discovery extension is not advertised.

OpenGen uses authorization code with S256 PKCE. `/oauth/authorize` opens a consent page showing the client name, callback origin, requested `read`/`generate` permissions and paying workspace. Account sign-in uses the optional OpenID Connect configuration above, then returns to the same pending consent request. Account sign-in is offered only after that provider is configured. A self-hosted user can instead connect a workspace API key through the existing browser-session exchange. The installation bootstrap token cannot delegate OAuth access.

Consent never accepts an API bearer token as a substitute for the browser session. It requires the exact public website origin and checks accepted membership in the selected workspace. A fixed workspace-key session can authorize only that key's workspace and permissions. Generation permission authorizes billable requests subject to the workspace balance and existing routing, regional and budget restrictions; sign-in itself creates no credit.

The code is single-use and expires after five minutes. Tokens bind to the canonical `${OPENGEN_PUBLIC_URL}/mcp` resource, client and selected workspace. Access tokens last at most one hour; grants and refresh tokens last at most thirty days. Refresh rotates tokens; reuse of a consumed refresh token revokes the authorization family. Code reuse with the correct PKCE verifier also revokes its authorization. Only hashes of opaque authorization codes, access tokens and refresh tokens are stored in the database. Clients receive no upstream provider credentials or workspace API keys.

Each request and refresh rechecks the authority behind the grant. An account grant follows the accepted workspace membership independently of its short-lived browser sign-in key. Removing and later inviting that identity again does not revive the old grant. A key-backed grant follows the source key's current expiry, revocation, scopes and policy, intersected with the original consent restrictions so it cannot grow more permissive. Administrative scopes are never delegated by this flow.

`POST /oauth/revoke` revokes a client's token family. `GET /v1/oauth/grants` lists visible app authorizations for the current workspace; `DELETE /v1/oauth/grants/{id}` revokes an authorization owned by that browser membership/source key or visible to a workspace key administrator. The protocol's registration, token and revocation endpoints accept public clients without client secrets. Token and revocation requests support standard URL-encoded forms. They do not use browser cookies for authority; consent remains a separate same-origin operation.

### Native-client callback policy

[Claude Code](https://code.claude.com/docs/en/mcp#use-a-fixed-oauth-callback-port) documents `http://localhost:PORT/callback`; [Cursor](https://cursor.com/docs/mcp#static-redirect-url) documents `http://localhost:8787/callback` alongside its HTTPS web callback. OpenGen accepts those exact registered forms for compatibility. This is protocol-fixture coverage, not a claim that an actual client/version has passed deployed authentication.

[RFC 8252 §8.3](https://datatracker.ietf.org/doc/html/rfc8252#section-8.3) prefers IP literals because localhost resolution and listener binding can be misconfigured. OpenGen's own CLI keeps its literal `127.0.0.1` callback. Allowing exactly localhost trades that literal-address assurance for compatibility with the documented native clients; clients must still bind their listener to the local loopback interface. The gateway does not resolve or fetch callback addresses.

The localhost exception requires an explicit positive port and rejects aliases, subdomains, user information, fragments and OAuth response parameters. S256 PKCE, the canonical resource and complete registered URI binding remain mandatory. OpenGen preserves exact port/path/query matching at authorization and code exchange; it does not implement a variable-port matching exception. [RFC 9700 §2.1](https://datatracker.ietf.org/doc/html/rfc9700#section-2.1) requires exact redirect matching with a native localhost-port exception; per-flow dynamic registration records the actual callback here. No wildcard or client-metadata-document fetching is introduced.

## Local CLI browser sign-in

The CLI's browser-login helper registers a literal `127.0.0.1` callback on a random available port, generates a fresh state and PKCE verifier, and opens the same hosted consent flow. It validates the callback state before exchanging the code. Login, status and logout outputs contain connection metadata rather than tokens. The private token profile defaults to `$XDG_CONFIG_HOME/opengen/auth.json`, or `~/.config/opengen/auth.json` when that variable is unset. On POSIX systems the profile must be a regular private `0600` file; symlink and publicly readable profiles are refused. Keep this directory out of source control and backups intended for sharing.

Refresh uses an exclusive profile lock to avoid parallel reuse of a rotating refresh token. Logout revokes server authorization before deleting the profile; a failed revoke retains it so logout can be retried. If a process is interrupted and leaves an `auth.json.lock` file, verify no OpenGen process is using that profile before removing the stale lock. If a refresh response is lost or a grant expires, sign in again; do not weaken token-reuse checks to recover a session.

## Optional external OAuth resource access

For a remote MCP client using an external authorization server, configure:

```dotenv
OIDC_ISSUER=https://your-identity-provider.example
OIDC_JWKS_URI=https://your-identity-provider.example/.well-known/jwks.json
OIDC_API_AUDIENCE=https://your-opengen.example/mcp
```

These identifiers are public configuration, not client secrets. Their URLs must use HTTPS. This is a separate resource-token integration for deployments that already issue external access tokens; OpenGen's own client onboarding above remains the advertised authorization flow. Register/configure the resource audience with that issuer and arrange for its access tokens to carry `read` and/or `generate` scopes. The gateway verifies issuer, audience, signature, required subject/issue/expiry claims and supported signing algorithms. External resource tokens default to recognized `read`/`generate` scopes. Administrative OAuth scopes require explicit deployment opt-in through `OIDC_ALLOWED_SCOPES` and an issuer grant of the same scope; merely requesting a scope does not grant it. An account-identified token with the deliberately enabled `members:write` grant can create an unfunded team. Fixed workspace keys cannot create or switch workspaces. Ordinary workspace administration uses a browser session or a suitably scoped OpenGen key.

MCP authentication failures advertise protected-resource metadata. Availability of metadata does not establish that a specific client's discovery/registration flow has passed live testing. Validate the exact audience/scope policy with each client and deployment; do not turn off audience or signature checks to make it work. The local protocol tests cover registration, payer-workspace consent, redirect/resource/PKCE binding, hashed tokens, revocation and replay checks; they do not certify a live third-party connector or identity-provider deployment.

## Funding and operator boundaries

Self-hosting does not require a payment processor. An installation operator can create a workspace through `POST /v1/workspaces` and fund an existing workspace through `POST /v1/workspaces/{id}/credits`:

```json
{ "amountMicros": 1000000, "reference": "unique-operator-funding-reference" }
```

Only the installation operator may fund balances. Persist and reuse the same reference for a retry; changing the amount under an existing reference is a conflict and cannot credit twice. This records accounting credit, not a card payment, receipt or upstream charge. Never expose this operator operation to anonymous visitors or browser code. New browser identities have zero credit until explicitly funded, or can configure their own provider account for BYOK.

Before exposing managed generation, verify TLS, proxy forwarding, cookie origin, workspace isolation, key revocation, policy narrowing, external token validation and Vercel-to-GCP identity on the exact deployment. Keep secrets and `MR_VAULT_KEY` outside source and frontend builds; preserve the vault key separately from database backups for restoration and rotation.

## MCP business operations and HTTP transports

The fixed `/v1/operations` allowlist exposes discovery, single/batch quotes, generation, owned jobs, uploads, accounting/export, keys, policies, encrypted connections, team membership, webhooks, alerts and operator reconciliation through MCP `call`. Every call goes through the native HTTP handler, including its workspace scope and installation-operator checks. A registered operator operation does not grant an agent that privilege. Browser cookie creation/workspace switching, OIDC redirects and OAuth metadata remain HTTP-only transport protocols. MCP ledger export explicitly selects JSON; CSV remains an HTTP presentation format. Content retrieval returns a short-lived location rather than following it with a gateway credential.
