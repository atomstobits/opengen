# Self-hosting and operations

OpenGen's catalog can run without credentials. Generation requires PostgreSQL, gateway authorization and a supported provider connection. The current implementation status and authorization boundaries are in [STATUS.md](STATUS.md). Hosted OpenGen on Vercel/GCP is configured separately in [DEPLOYMENT.md](DEPLOYMENT.md).

For policy adoption, supplier arrangements and support/privacy/incident procedures, use [Legal Launch](LEGAL-LAUNCH.md), [Provider Privacy Review](PROVIDER-PRIVACY-REVIEW.md) and [Privacy Operations](PRIVACY-OPERATIONS.md). Those procedures require actual operator and agreement records; documentation alone is not a completed customer request or hosted activation.

## Local containers

Prerequisites: Node.js 22.12+, Docker Engine or Docker Desktop, and Docker Compose v2. Use a clean checkout with the committed lockfile.

```sh
npm ci
npm run setup:local
docker compose --env-file .env -f deploy/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose.yaml up --build --detach --wait
node scripts/wait-http.mjs http://127.0.0.1:4310/health http://127.0.0.1:4320
node scripts/container-smoke.mjs
```

`setup:local` creates `.env` with random local database/gateway/vault/session secrets, permissions `0600`, zero opening credit and no provider credentials. It refuses to overwrite an existing file and never prints values. Edit that file privately. Compose exposes web, API and PostgreSQL only on loopback; do not replace those bindings with public interfaces without an authenticated TLS ingress design.

The API and worker share one server image, run as a non-root user and coordinate through PostgreSQL. The web uses a separate image and receives no gateway/database/provider secret. Compose passes an explicit provider-variable list to API/worker rather than loading all of `.env` into every service. The worker does not receive the installation token, browser session secret or OIDC client secret. The shared vault key decrypts provider connections and must be backed up privately with the database. Losing or changing it without re-encrypting existing rows makes those connections unreadable. The API temporarily needs provider configuration for executable-route eligibility; see DEPLOYMENT.md.

The database volume is persistent. `docker compose ... down` preserves it. **`down --volumes` deletes local data** and is appropriate only for a disposable installation. Do not run `docker compose config` without `--quiet` in shared logs because the rendered configuration can contain secrets.

## Browser sign-in and private assets

For normal browser sign-in, configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, the correct public origin and a stable private `MR_SESSION_SECRET` on the API. Register the exact callback URL documented by the authentication implementation. Use HTTPS in a hosted deployment. Do not pass OIDC secrets to Vercel public environment variables.

`MR_VAULT_KEY` is a 32-byte hex key for encrypted provider connections in PostgreSQL. Treat a database backup plus this key as access to those connections. Keep it in a separate secret manager and include it in the protected recovery plan; database backups without it cannot recover encrypted connections. Changing it is a vault migration, not a normal environment edit.

Private uploads/outputs use the configured S3-compatible bucket, endpoint and region. API/worker may receive narrowly scoped cloud storage credentials; the web may not. Disable public bucket listing/access and use bounded signed URLs. Configure CORS only for the actual frontend origin if direct browser upload is enabled. Apply lifecycle/retention and back up retained objects alongside the database. S3 and OIDC are external setup requirements; the base local Compose stack does not create those services.

## Provider setup and spending

Set only the credentials for the exact provider deployment you control. For Alibaba, endpoint region, workspace and credential must agree; optional additional regional credentials use the explicitly named variables in `deploy/compose.yaml`. Provider credentials never belong in the browser.

The initial balance is an operator grant in integer micro-USD, applied once when a workspace is created. It is not a payment topup. Review each route's current capability, price and evidence before supplying credit. Changing the opening balance after workspace creation does not mint more credit. No automated health or release check should trigger a paid generation. A live smoke requires an explicit total budget and a specific route/input.

A successful HTTP submission is not a completed job. Save the idempotency key and returned job ID, poll that same job, and inspect its attempt, output and settlement. A submission of unknown acceptance remains reserved for reconciliation; do not blindly recreate it or manually delete money records. Cancellation after provider submission does not establish a refund.

## Logs, health and recovery

`GET /health` reports HTTP process health and whether a database-backed engine is configured; it is not a provider availability/SLA check. Inspect API and worker service state separately. The worker must be running for queued jobs and polling to advance. Container restarts resume persisted provider IDs instead of submitting again.

Use redacted application logs and job IDs for investigation. Keep prompts, authorization headers, provider bodies, signed media URLs and raw database dumps private. Database jobs/attempts/ledger records are sensitive even when they contain no provider credential.

If a job remains `submission-unknown`, reconcile upstream acceptance and billing from the provider's console/ID before deciding whether any new call is safe. The public bootstrap does not implement an operator reconciliation UI; do not claim automated resolution or edit ledger entries ad hoc. Escalate with a private, redacted evidence record.

## Backup and restore

Back up PostgreSQL and retained output objects under a coordinated retention policy. Encrypt backups, restrict access, store them outside the source checkout, and test restoration. A database-only backup does not preserve externally expiring provider outputs. Recovery point/time objectives depend on the operator's database and object storage configuration; the repository does not promise them.

For the local Compose database, choose a private destination and restrictive permissions:

```sh
umask 077
docker compose --env-file .env -f deploy/compose.yaml exec -T db pg_dump -U opengen -d opengen --format=custom > /absolute/private/path/opengen.dump
```

Do not put the dump in the repository, an issue attachment or public CI artifact. The following restores to a **new disposable database** so the existing installation is untouched:

```sh
docker compose --env-file .env -f deploy/compose.yaml exec -T db createdb -U opengen opengen_restore_check
docker compose --env-file .env -f deploy/compose.yaml exec -T db pg_restore -U opengen -d opengen_restore_check --no-owner --no-acl --exit-on-error < /absolute/private/path/opengen.dump
docker compose --env-file .env -f deploy/compose.yaml exec -T db psql -U opengen -d opengen_restore_check -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM mr_workspaces;'
```

For an actual recovery, stop admission and the worker, confirm the target is empty and correct, restore database plus objects, check balances/jobs and credentials, then start the API before the worker. Reconcile any upstream work that completed during the outage. Keep the old deployment/data until the restored service has been verified. Never replay unresolved submissions as a recovery strategy.

CI runs `scripts/database-smoke.mjs` against a disposable Compose stack to exercise dump/restore and compare core table counts. That check must pass before claiming container backup/restore verification.

## Upgrades

Pin the Git commit or image digest you deploy. Read the changelog and migration changes. Stop admission and the worker, take and verify a backup, build the reviewed version and start the API. Schema initialization is guarded by a PostgreSQL advisory lock; it is not a substitute for migration review or backup. Check catalog/schema, authorization, existing jobs and balances before resuming the worker. Roll back application code only when its schema compatibility has been confirmed; otherwise restore the reviewed backup to a fresh database.

Rotate provider credentials in the upstream account, then update only the required runtime secret references and restart those consumers. Revoke compromised scoped keys through the key-management API and rotate the emergency installation token through a controlled maintenance window. Prefer a production secret manager and short-lived identity credentials. Never solve an access problem by checking a key file into Git.

## Verification boundary

This runbook and the CI workflow are implementation artifacts. Local Docker/container tests have not been executed on the current development machine because Docker is absent. Native PostgreSQL, container startup and dump/restore gates need recorded CI results. PGlite tests alone do not establish native multi-connection behavior. See [RELEASE.md](RELEASE.md) and [VERIFICATION.md](VERIFICATION.md).

## Evidenced provider reconciliation

The private `/operator` page and `POST /v1/workspaces/{workspaceId}/generations/{id}/reconcile` require the installation operator, including for a different workspace. Workspace administrators and ordinary API keys cannot change financial outcomes through this endpoint. Every action requires a stable reference, verification notes and an HTTPS provider-evidence link. The evidence link is stored privately; the gateway does not fetch it or claim to verify it automatically.

`resume` attaches the observed original task ID to unresolved acceptance and resumes reads without another submission. `reject` releases the hold only when the operator confirms no upstream acceptance and no task ID has been recorded. `settle` records evidenced actual provider cost for a completed, unsettled job; the original reservation caps customer debit, and any provider overrun remains an operator cost. Repeating the same reference/body returns the current job; a changed body under that reference is rejected. Audit insertion and state/ledger changes commit together. An already-settled job cannot be charged again.

`GET /v1/ledger` supports `after` and `limit` (1–1000). `GET /v1/ledger/export?format=csv` exports a page with `X-Next-Cursor` when another page may exist. JSON export is available for agents. Keep exported financial data private.
