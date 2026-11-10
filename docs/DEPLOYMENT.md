# OpenGen deployment

The public frontend belongs on Vercel, the API and continuous worker on Google Cloud, and authoritative DNS stays on Cloudflare. The canonical public origin is `https://opengen.dev`.

## Plan the installation

Use the [hosted deployment plan](DEPLOYMENT-PLAN-2026-11-04.md) to review an operator-owned footprint. Keep concrete project and identity bindings in ignored local configuration. Vercel needs Node.js 22, `apps/web` as the frontend root and installation from the root lockfile. The reusable settings payload is in `deploy/cloud/vercel-project-settings.json`.

For a custom domain, verify the targets assigned by your Vercel project before editing DNS. Preserve unrelated records, nameservers and mail configuration. Verify canonical HTTPS, public crawlable metadata and private previews after the change.

## Production topology

1. **Vercel:** server-rendered/SSG home, company and series pages, static assets, and a thin backend-for-frontend. Public catalog and SEO metadata must render without provider credentials.
2. **Cloud Run API:** a private IAM-authenticated HTTP service. Suggested initial sizing is 1 vCPU, 512 MiB, 0 minimum instances and a 2-instance maximum, subject to workload/cost review.
3. **Cloud Run worker pool:** one continuous worker instance initially. A worker pool matches the existing poll loop and does not require an HTTP listener. Continuous capacity incurs cost even with no generation jobs.
4. **Cloud SQL PostgreSQL:** database and reservations/jobs/ledger, in the selected backend region. Select tier, storage, backups, recovery and retention only after a concrete monthly budget is approved. Do not enable public authorized networks merely to make development connectivity convenient.
5. **Secret Manager:** database URL, installation token during bootstrap, provider/vault/storage credentials, and optional API-only session, IdP and Stripe settings. Use pinned secret versions and distinct API/worker runtime identities with access only to their required individual secrets. Do not commit credential JSON, access tokens, database URLs or rendered environment files.

Provider endpoint regions remain separate from the OpenGen backend region and from inference/residency guarantees. Set `METRICS_ORIGIN_REGION` to the actual worker region so measured latency is attributable.

## Vercel to private Google Cloud

Use Vercel OIDC and Google Workload Identity Federation; avoid downloaded service-account JSON keys. Restrict federation to the intended Vercel team, project and production environment, and grant its calling identity only `roles/run.invoker` on the intended API service. The API runtime identity needs separate database and per-secret permissions, not Owner/Editor.

The frontend implements optional keyless transport using `@vercel/oidc` and the Google STS/IAM Credentials APIs, following the [Vercel federation guide](https://vercel.com/docs/oidc/gcp). The GCP transport token belongs in `X-Serverless-Authorization: Bearer <short-lived-GCP-ID-token>`, preserving the caller's `Authorization` for application authentication as described by [Cloud Run](https://cloud.google.com/run/docs/authenticating/service-to-service). The proxy never injects an operator token. Protocol fixtures pass. Verify Workload Identity Federation, its IAM grants and a live private Cloud Run call on the target deployment.

Set these **server-only Vercel** variables after reviewing the deployment:

| Variable                         | Value                                                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_ROUTER_API_URL`           | Canonical HTTPS Cloud Run service origin ending in `.run.app`; no path/query, custom domain or traffic-tag assumption. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Resource path `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL_ID/providers/PROVIDER_ID`.          |
| `GCP_SERVICE_ACCOUNT_EMAIL`      | Dedicated Vercel calling identity `NAME@PROJECT_ID.iam.gserviceaccount.com`.                                           |

The SDK requests a short-lived Vercel token with custom audience `https://iam.googleapis.com/` plus that provider resource path. [STS exchanges](https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token) it using the provider's `//iam.googleapis.com/` full resource name. [IAM Credentials](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken) then generates an ID token whose audience is the canonical Cloud Run origin. The service ID token is cached in server memory for at most five minutes, refreshed before expiry, and never returned to callers. Incomplete configuration, token exchange failures or an unsupported backend origin fail closed.

Restrict the WIF principal/attribute condition to the intended Vercel team, project and environment. Grant that restricted principal [`roles/iam.workloadIdentityUser`](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines) on the dedicated calling service account, and grant the service account `roles/run.invoker` only on the intended Cloud Run API. Enable STS/IAM Credentials and service invocation as reviewed prerequisites; the proxy creates no identities, grants or billing resources. Local/Compose deployments leave both GCP identity variables blank and use their configured internal API origin.

The public frontend now exposes registered `/v1/*` paths, Streamable HTTP `/mcp`, `/openapi.json`, `/skill.md` and OAuth protected-resource metadata paths. When no backend URL is configured, public catalog GETs and the static agent skill remain available from shared source metadata. Quotes, metrics, private operations, MCP, OpenAPI and OAuth metadata require the backend; unavailable transport returns 503, with no made-up execution or observation results. The proxy forwards only registered paths/methods and retains caller/session and MCP protocol headers.

### Stripe delivery to the private API

Keep Cloud Run IAM-private. For hosted OpenGen, register Stripe's snapshot-event
destination as `https://opengen.dev/webhooks/stripe`. The dedicated Vercel Node
POST route forwards only to the configured API's exact `/webhooks/stripe` path,
using the same OIDC → STS → IAM Credentials transport above. No unauthenticated
Cloud Run invoker grant or Stripe secret on Vercel is required.

The relay forwards the original ArrayBuffer bytes and Stripe-Signature with
Content-Type. It never JSON-parses, text-decodes or re-encodes the payload, and
strips caller Authorization, cookies, Origin, workspace, idempotency and caller
service-identity headers. It adds only the trusted short-lived
X-Serverless-Authorization token. Backend signature verification remains the
sole payment authority, with Stripe keys and all processing in GCP.

Only fixed POST is registered; this is not an MCP operation or an arbitrary
forwarding target. Signature headers are limited to 4,096 characters, bodies to
1,000,000 bytes, redirects are not followed, and responses are no-store. Missing
federation/identity or unreachable backend fails with 503. Configure and verify
WIF first, then prove exact-byte signed delivery in the dedicated Stripe sandbox
before enabling top-ups. Existing fixtures mock federation and backend calls. Verify the actual relay, IAM grant and Stripe delivery in the target sandbox.

For a self-hosted API that is already publicly reachable, Stripe may post directly
to that API's TLS `/webhooks/stripe`; local/Compose tests can use direct API ingress.
Do not route signed bodies through a generic JSON/text proxy.

`OPENGEN_PUBLIC_URL=https://opengen.dev` is public site-origin configuration (`MEDIA_ROUTER_PUBLIC_URL` is a legacy alias). `MEDIA_ROUTER_API_URL` is server-only. Neither provider keys nor installation tokens should use a `NEXT_PUBLIC_` prefix or be included in public JavaScript, prerendered HTML, API responses, logs or build artifacts.

Optional hosted legal publication uses at most one validated manifest setting (`OPENGEN_LEGAL_PUBLICATION_FILE` or `OPENGEN_LEGAL_PUBLICATION_JSON`), restricted to the canonical `https://opengen.dev` origin and rejected in billing sandbox mode or via bare boolean flags; leave both unset on local and self-hosted deployments to keep legal pages and `/auth/login` in Draft (`noindex`, no Terms receipt written).

Private asset storage currently uses the S3-compatible API. It requires a private bucket and restricted runtime credentials; GCS interoperability HMAC, R2 or another compatible store can supply that interface. This code does not provision a bucket or establish native GCS service-account signing. Do not put storage HMAC/provider keys on Vercel. Configure lifecycle retention/CORS and verify the API/worker's upload/archive/read permissions separately.

## Runtime readiness and secrets

Workspace-scoped hashed keys, HttpOnly sessions, optional OIDC/OAuth, memberships and encrypted provider connections are implemented. A production identity issuer, vault key, database, storage and authorization settings still require deployment-specific verification. Keep the backend private until that boundary is reviewed. Do not publish a public managed-generation service by sharing the operator installation token.

The current quote/execution eligibility check inspects provider-key configuration in the API process, while the worker performs provider calls. Until configuration/vault metadata is separated from secret access, both processes require the corresponding provider secret references. Both may also need `MR_VAULT_KEY` and the private S3/AWS storage references for encrypted connections, uploads and archived outputs. This is an explicit temporary constraint; it is not permission to expose those secrets on Vercel.

Use separate `OPENGEN_API_RUNTIME_SA` and `OPENGEN_WORKER_RUNTIME_SA` service-account emails. Grant database/Cloud SQL and individual shared provider/vault/storage secret access to both as required. Grant access to each installation-token, browser-session, OIDC and Stripe Secret Manager secret only to the API identity; deployment references pin the chosen versions. Do not grant the worker project-wide Secret Manager access: excluding a binding from its container does not revoke IAM permission to read that secret. Keep deployer and Vercel calling identities separate from both runtime identities.

Use keyless CI/deployer authentication and short-lived federated credentials. Keep `.vercel/` account links and `infra/.local/` deployment bindings outside Git. Commit the public template, not real values. Provider test fixtures must remain synthetic and redacted.

## Reviewed deployment commands

`infra/deploy-gcp.sh` prints a plan by default and only accepts secret references, never secret values. It requires Node.js for URL validation, a canonical HTTPS `OPENGEN_PUBLIC_URL` without a trailing slash/path/query, and distinct API/worker service-account emails. The same public origin is explicitly supplied to both processes so their OAuth issuer and browser origin cannot fall back to localhost. Copy `infra/opengen.env.example` into ignored local configuration, fill public identifiers and exact image digests, export the configuration into the shell environment, then run:

```sh
bash infra/deploy-gcp.sh --plan
```

`OPENGEN_PROVIDER_SECRET_BINDINGS` supplies pinned `ENV_NAME=secret-name:numeric-version` references shared by API and worker. `OPENGEN_API_SECRET_BINDINGS` supplies only API session/IdP/payment references: `MR_SESSION_SECRET`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URI`, `OIDC_API_AUDIENCE`, `OIDC_ALLOWED_SCOPES`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and the scoped `OPENGEN_BILLING_*` controls in the payment template. Billing flags, owner/environment identifiers, approved terms and the optional dedicated operator bearer can all use pinned API-only configuration references; their values are not rendered into deployment commands. Public IdP identifiers may be stored as referenced configuration alongside its client secret. The database reference is shared; `MR_API_TOKEN` is separately bound only to the API. API-only names or secret names reused in shared bindings, duplicate environment names, inline values and unpinned versions are rejected. `STRIPE_LIVEMODE` is an API-only nonsecret boolean with an explicit `false` sandbox default; Stripe credentials alone cannot activate legacy startup. The complete reviewed sandbox or manual binding and signed webhook configuration are required before top-ups are available. See [manual binding and remaining acceptance gates](billing/runtime-integration-026.md).

`OPENGEN_PROVIDER_EXECUTION_ENABLED` is a separate nonsecret true/false control shared by API and worker; its unset default is true for normal operation. Set it to false for payment-only qualification. Both official entrypoints also fence the reserved sandbox database namespace, so a worker cannot dispatch stored BYOK jobs from it. Stripe keys and billing authority are still API-only. A provider pause retains existing queued/accepted work and money state rather than fabricating cancellation or refunds.

`OPENGEN_EXECUTION_SCOPE` is an operator-owned request limit shared by API and worker. Direct self-hosted startup and Compose default to `unrestricted`; the GCP planner requires an explicit choice of `unrestricted` or `qualification-sg-v1`. The qualification profile permits only its fixed Singapore Wan/Qwen request shapes. It does not establish live provider verification, authorize a paid call or activate a public launch. A configured shared provider key must not expand that profile.

Scoped image-to-video additionally requires `OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256`, the reviewed owned first-frame content digest, on both processes. Leave this variable unset to keep those scoped requests nonexecutable. Empty or malformed values, or a pin with the unrestricted profile, fail configuration before database initialization. Do not put the pin in customer requests, frontend configuration, public readiness output or secret aliases. The Compose bare-key entry preserves an absent value rather than sending an empty string; provide the reviewed value in the Compose environment only when using the qualification profile. [Compose environment semantics](https://docs.docker.com/reference/compose-file/services/#environment)

Before changing profiles, inventory and resolve older queued work under the existing cutover procedure. Preserve accepted/unknown provider tasks, original inputs/credentials and holds. Matching API/worker scope and pin assertions are checked by the offline activation preflight; actual runtime parity and the authorized queue transition remain separate gates.

Applying requires an explicit resource/cost decision and `OPENGEN_BILLABLE_RUNTIME_APPROVED=yes`. The script does not create Cloud SQL, enable APIs, grant IAM, configure federation, upload secrets or attach billing. These are reviewable prerequisites, not hidden side effects. Verify the resulting bindings and readiness on the target installation.

Before applying: enable required GCP APIs; create restricted runtime/deployer identities; configure federation; create the approved database and backups; upload secrets securely; build and scan the backend image; and verify public catalog/SEO behavior with no credentials.

## References

- [Vercel monorepos](https://vercel.com/docs/monorepos)
- [Vercel Google Cloud OIDC federation](https://vercel.com/docs/oidc/gcp)
- [Google STS token exchange](https://cloud.google.com/iam/docs/reference/sts/rest/v1/TopLevel/token)
- [IAM Credentials ID tokens](https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken)
- [Workload identity for deployment pipelines](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Cloud Run service authentication](https://cloud.google.com/run/docs/authenticating/service-to-service)
- [Cloud Run worker pools](https://cloud.google.com/run/docs/deploy-worker-pools)
- [Cloud Run secrets](https://cloud.google.com/run/docs/configuring/services/secrets)
