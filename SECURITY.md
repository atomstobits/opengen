# OpenGen security

OpenGen is open-source software under Apache-2.0. The repository and source archives must remain safe to publish without carrying or deleting operational credentials on a release branch.

## Secrets and deployment boundaries

- Keep provider credentials, database connection strings, gateway tokens and OAuth client secrets outside Git and outside frontend builds. `.env*`, `.vercel/`, rendered infrastructure bindings and common key files are ignored. Commit only placeholder templates.
- Vercel serves the public catalog and frontend. Its proxy forwards the caller's OpenGen credential; it must not inject an operator generation token for anonymous visitors.
- GCP runtime secrets belong in Secret Manager. Prefer workload identity and short-lived federated credentials over downloaded service-account JSON. Grant access to specific secrets/services, not project-wide Owner or Editor.
- Public environment variables and metadata are limited to public origins, documented model/provider information and non-sensitive feature configuration. A `NEXT_PUBLIC_` prefix is never appropriate for a private credential.
- Do not log authorization headers, provider response bodies, private prompts, signed asset URLs or secret values. Error responses must be redacted.
- Provider secrets stay inside the configured gateway/worker. Frontend clients receive job IDs, evidence and outputs, not upstream credentials.

## Before publishing or deploying

1. Run a standard secret scanner such as Gitleaks or TruffleHog over tracked files and Git history. Review findings without printing credential values into public logs.
2. Inspect staged files and build artifacts for `.env`, private keys, service-account JSON and provider/operator tokens. Synthetic tests use explicitly fake tokens only.
3. Verify that unauthenticated generation is rejected and that frontend proxies do not supply privileged credentials.
4. Verify workspace isolation, idempotency, spending reservations and unknown-submission behavior. A network timeout must not create a second paid request.
5. Review API ingress, TLS, database access, runtime identities and secret versions for the exact deployment.

The installation token is a privileged operator bootstrap credential, not a shared customer key. Use workspace-scoped keys or revocable browser sessions for users. Provider connections are encrypted with MR_VAULT_KEY; secure that key separately from database backups. Optional OIDC, key policies, asset ownership and all production transport/authorization boundaries require deployment verification. Keep a managed backend private until those gates pass; do not share the installation token as public access.

## Reporting and incident response

Do not post secrets, private customer inputs or exploit details in a public issue. Use the repository's private security advisory/reporting channel when enabled; until then, contact a maintainer privately before sharing sensitive details.

If a credential is committed or exposed, revoke/rotate it first. Removing the current file does not revoke it or erase Git history, forks, build logs or caches. Follow the provider's incident procedures and document the affected scope without reproducing the key.
