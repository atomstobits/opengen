# Hosted deployment planning

Choose a project, backend region and resource budget for your installation. Use [the deployment guide](DEPLOYMENT.md) for the public configuration contract and [the operations guide](OPERATIONS.md) for self-hosting, recovery and upgrades.

## Review the footprint

- Place the private Cloud Run API, continuous worker pool, PostgreSQL, private object storage and image registry in the reviewed backend region. Record that region separately from provider processing and data residency.
- Budget for continuous worker capacity, database compute/storage/backups, storage operations and egress, API requests, logs, build, registry and Secret Manager. Test database concurrency before relying on a small shared tier. [Cloud Run pricing](https://cloud.google.com/run/pricing) · [Cloud SQL pricing](https://cloud.google.com/sql/pricing) · [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- Use a dedicated API identity, worker identity, private storage identity and frontend invocation identity. The frontend can invoke only the intended private API through an exact production WIF subject. The API and worker receive only their required individually pinned secret references. Browser/OIDC and payment secrets belong to the API.
- Require Cloud SQL connector authentication and encrypted transport. Preserve deletion protection, verified backups and a point-in-time recovery window. Configure private bucket access and canonical-origin CORS. Use application-managed input cleanup to preserve accepted-job pins. Review output retention separately.

## Prepare an operator-owned deployment

Put concrete account bindings and receipts in ignored local configuration. Use the [example environment](../infra/opengen.env.example) to find the supported variable names. The bootstrap and WIF helpers print offline review plans by default.

```sh
node infra/gcp-bootstrap.mjs \
  --project "$OPENGEN_PROJECT_ID" --region "$OPENGEN_REGION" \
  --bucket "$OPENGEN_BUCKET" --public-origin "$OPENGEN_PUBLIC_URL"
```

Review the exact resource plan before using `--apply --receipt /absolute/private/bootstrap.json`. It checks the existing project and billing state, named resources, Cloud SQL transport and runtime IAM. A rerun validates existing resources and preserves credentials. Existing bucket policy drift requires operator review. The helper applies input-pin-safe lifecycle and canonical-origin CORS only to a newly created bucket. [Hosted storage activation](CORE-HOSTED-ACTIVATION.md)

Create and review the intended human OAuth client in the identity provider, register the exact callback URL and store the client secret on the API only. Verify the frontend team, project, issuer and production claims before preparing federation.

```sh
node infra/vercel-wif.mjs \
  --project "$OPENGEN_PROJECT_ID" --project-number "$OPENGEN_PROJECT_NUMBER" \
  --region "$OPENGEN_REGION" --bucket "$OPENGEN_BUCKET" \
  --public-origin "$OPENGEN_PUBLIC_URL" \
  --team-slug "$VERCEL_TEAM_SLUG" --team-id "$VERCEL_TEAM_ID" \
  --project-name "$VERCEL_PROJECT_NAME" --vercel-project-id "$VERCEL_PROJECT_ID" \
  --issuer-mode team
```

The WIF helper rejects wildcard, preview and development trust. Its apply mode verifies the intended caller, private API invocation and current provider trust before creating bindings. Set its returned transport identifiers server-side in Vercel. The helpers leave project creation, billing, frontend configuration, human OAuth registration and deployment with the operator. [Vercel OIDC](https://vercel.com/docs/oidc/reference) · [Cloud Run authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)

Build the reviewed `server` target from the exact source commit and use the immutable registry digest. Run `infra/deploy-gcp.sh --plan` to inspect the service and worker bindings. After the application initializes, qualify and reduce the database role using the [runtime permissions guide](RUNTIME-PERMISSIONS.md).

## Qualify before opening admission

Verify anonymous API denial, private authenticated health, the exact migration journal, private storage and signed upload/read expiry, Vercel federation, OAuth consent and independently authorized client journeys. Use owned synthetic bytes for storage tests and keep detailed receipts private. The raw transport probe uses existing pinned storage references and does no generation:

```sh
node --import tsx infra/qualify-storage.mjs \
  --bootstrap-receipt /absolute/private/bootstrap.json \
  --output /absolute/private/storage-qualification.json
```

Review [the staged activation checks](CORE-ACTIVATION-PREFLIGHT.md) for fencing old writers, backup/restore and storage behavior. Preserve accepted or uncertain provider attempts and their settlement records through cutover. Reopen generation only after the reviewed checks pass. Customer payments and live provider admission require their own authorization and qualification.
