# Hosted core activation gate

The deployed onboarding image recorded at `f9f9784` and13 migrations is an older cohort. Passing its private storage/WIF/least-privilege checks does not activate or qualify the new core. The existing onboarding/deployment owner controls cloud changes, identity and actual clients. No cloud mutation is performed by this document or the integration review.

Use the [current-core preflight runbook](CORE-ACTIVATION-PREFLIGHT.md) for the migration014–021 inventory, bounded offline manifest check, ordered owner handoff and rollback boundaries. Its synthetic assertions never establish hosted readiness.

## Pin-safe storage and honest retention

The older bootstrap applied seven-day age deletion to both `inputs/` and `outputs/`. This bypasses SQL accepted-use pins. The current source policy deliberately removes the `inputs/` age rule: application readiness/tombstone/expiry/pin/write-lease state controls input cleanup. Bootstrap validates an existing bucket and fails on drift; it does not silently rewrite that older live policy. Deployment must review/apply the compatible policy before enabling the core.

For a normal seven-day input lifetime, configure `MR_INPUT_RETENTION_MS=604800000` consistently on API and worker. New admissions reject expired/deleted inputs; already accepted pinned jobs can retain access until their real terminal outcome. The idle worker purges eligible unpinned/tombstoned bytes. Missing original legacy references or unknown credential identity remain operator gates, never permission to refetch changed inputs or regenerate. When the setting is unset, ready input objects have no automatic application expiry; do not publish a different hosted promise.

The source bucket policy retains its earlier seven-day `outputs/` age rule pending explicit managed retention review. Signed capabilities now bind private/no-store cache policy and check retained output existence/size/type before customer issuance. Missing/forbidden objects cannot become a successful compatibility response. Soft-delete recoverability is separate from active GET availability or physical erasure. Database/backups, private recovery receipts, provider retention/logs and already issued capabilities have separate lifetimes; no comprehensive ZDR claim follows from these controls.

## Current storage qualification

Qualify the exact combined build against the actual private bucket: create-only PUT with `x-goog-if-generation-match: 0`, conflicting replay, repeated completion, multipart interruption/resume/ETag/abort, conditional freeze into a separate owned key, DNS-safe immutable import, output reuse, deletion during writes, pin retention, HEAD/cache overrides and receipt recovery. The bucket CORS policy allows `Content-Type`, `ETag`, `If-None-Match` and `x-goog-if-generation-match`. Verify the actual browser preflight and conditional writes before activation. [Cloud Storage request preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)

Run populated upgrade and backup/restore under the reduced deployed application role before enabling new writes. Preserve accepted/unknown jobs, price/route/actor snapshots, holds and exactly-once ledger history. Real legacy accounts without a recoverable original credential snapshot cannot be replaced with whichever connection is newest; require original-account evidence or operator reconciliation. Restricted fal ingestion, actual xAI gateway recovery and provider coverage remain with the one authorized provider/client coordinator and current shared USD50 journal.

## Separate external gates

Human sign-in/workspace consent, both actual named clients (including proxy transport), current-core owned media/refresh/revocation, native verifier isolation and final media rights still need their own dated evidence. Optional Stripe enablement requires sandbox/raw-webhook/exactly-once-credit qualification. Optional notification email requires a verified opted-in recipient and configured idempotent relay; source tests send nothing externally. Keep repository/PR/packages private and do not merge, deploy, publish or admit more paid work merely because source fixtures pass.
