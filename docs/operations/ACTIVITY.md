# Private Activity query contract

This module is an integration candidate, not a hosted-service qualification. All routes require the selected workspace's `read` scope before queries execute. It never exposes a public generation feed. The standalone server adapter is `apps/server/src/activity.ts`; registration, operation discovery, OpenAPI/MCP and browser relay wiring belong to integration. C5's additive `attribution` and `metadata` columns and C7 indexes must land first.

`GET /v1/activity` returns `{items,nextCursor}` with compact rows and accepts only `modelId`, `providerId`, `deploymentId`, `endpointRegion`, `operation`, `keyId`, `status`, `project`, `since`, `until`, `limit` and `cursor`. Identity comes from the trusted Principal. Every predicate is exact and parameterized. A model ID or regional deployment is never inferred or merged. Default limit is 50, maximum 100. `since` is inclusive and `until` exclusive; both require ISO timestamps with a timezone. Unknown filters are rejected.

The descending `(created_at,id)` cursor preserves database microseconds, binds workspace and normalized filter values, and is traversal state rather than a credential. A different workspace/filter selection rejects it. Page size may change. Concurrent newer insertions do not enter subsequent older pages; refresh starts a new traversal. Deletions can shorten pages. It is not a snapshot of mutable job statuses.

Rows omit full input, prompts, outputs, signed URLs, provider receipts and credential connection details. Fetch a selected job through the existing authorized detail endpoint to obtain private output capabilities. List queries never use a storage signer. Legacy actor snapshots remain `null`; the UI labels them unknown. Key/project filters operate on trusted persisted C5 snapshots, never caller-supplied actor labels.

`reservedMicros` is the accepted job's reservation snapshot. `ledgerReservedMicros` and `settledMicros` come from ledger entries. Missing settlement is null, including a legacy job snapshot that claims settlement without a ledger row. A real zero-amount BYOK settlement is zero. `heldMicros` is the ledger reserved-delta sum only when the reservation/settlement snapshot reconciles. `accountingState` is `reconciled`, `unknown` (no reservation ledger) or `mismatch`. Unknown/mismatched held amounts remain null and are counted separately. A successful generation, delivery and settlement are independent outcomes. Cancellation does not imply refund.

`GET /v1/activity/analytics` accepts the same exact filters except pagination. The default window is the preceding seven days; the maximum is 31 days. SQL aggregates the selected private window; responses cap configuration cohorts at 100 and expose `truncated`. Whole-window sample/money totals include every selected job even when cohorts are truncated. Reports include ledger-confirmed settled totals, known holds and unknown-accounting counts. Configuration cohorts preserve exact model/operation/route/deployment/provider/region and a fingerprint of all non-content canonical parameters and media role/count/timing shapes. The compact display includes reported resolution/duration/dimensions/count/quality/audio/billing settings. Prompts, system instructions, asset URLs and element identifiers are excluded from the fingerprint; stochastic seeds remain part of exact parameters. Bounded private `byKey` and `byTag` breakdowns return source key IDs (unknown for legacy) and workspace tag name/value pairs, with their own truncation flags. Tag groups overlap, so their totals are not additive across tags. Public metrics remain separate and omit identity/tags/content.

Existing `completed_at-created_at` is labeled **provider outcome latency**, with count and p50/p95. It is not evidence of usable output delivery. Queue, execution, delivery and end-to-end timings stay null pending C6's observed timing contract. No progress percentages or success percentages are synthesized.

Example (use a private scoped key supplied by your normal secret mechanism):

```sh
curl --fail-with-body --get "$OPENGEN_URL/v1/activity" \
  -H "Authorization: Bearer $OPENGEN_TOKEN" \
  --data-urlencode 'modelId=minimax/h3-max' \
  --data-urlencode 'limit=25' \
  --data-urlencode 'since=2026-11-01T00:00:00Z'
```

Manual testing plan: sign in with two authorized members and two workspaces; paginate jobs sharing a timestamp, insert a newer job, switch workspace/filter, and verify prior cursors fail and private rows clear immediately. Inspect list traffic for absence of prompts/output URLs. Check pending, late-settled, zero-BYOK and legacy missing-ledger jobs against ledger records. Verify read-denied identities cannot query. Run targeted PGlite and native PostgreSQL tests, then inspect the combined candidate's query plans and browser relay scope rules before enabling the UI.
