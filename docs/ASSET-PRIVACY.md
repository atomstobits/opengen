# Private asset and supplier privacy contract

This document describes the C2/C4 asset candidate and its integration requirements. It is source/fixture evidence, not a hosted retention promise, supplier agreement or live private-CDN qualification. User prompts, inputs, outputs, receipts, tags and lineage remain private to the owning workspace and its authorized identities/scopes. There is no public generation gallery, publishing operation or visibility toggle.

## Gateway lifecycle and retention

Owned file state is explicit: `prepared`, `uploading`, `processing`, `ready`, `failed`, `expired` or `deleted`. Creating an upload or completing transport is not sufficient for generation admission. Only an authorized `ready` object with validated bytes/type/size and its immutable hash can dispatch. Upload acceptance does not establish that a model supports the media type, role, count or duration.

An external reference must be imported once under the workspace/idempotency preparation identity, outside reservation locks. The accepted request freezes bytes/hash and the semantic role/order of every input. Replaying the same request uses the same preparation; a changed request conflicts. Failed preparation causes no provider submit or paid reservation. After preparation, admission must revalidate authority, current quote/cap and workspace policy before reserving once.

Pin accepted uses transactionally with job admission. An in-use asset cannot be physically removed while an accepted job still requires it. Deletion must either return an explicit in-use state or tombstone access and defer byte cleanup until pins release; the chosen API response must say which occurred. An output reused as an input receives a separately authorized owned input identity and private parent lineage. Do not copy an output key or expiring URL into `assetKey`, and do not remove another admitted use when deleting a parent. Reuse performs no paid generation.

Expiry/deletion removes content access, not the minimal financial, attempt, idempotency or delivery reconciliation record. Replaying a deleted or expired job returns its original job and availability state; it never starts another paid render. Content cleanup must not rewrite ledger settlement or erase an unresolved acceptance/cost hold. Retained hashes and lineage are private metadata and need their own retention/access review.

| Resource                            | Required operational handling                                                                                                                | Hosted duration                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Unfinished single/multipart uploads | Expire unused upload capabilities; abort abandoned multipart state and remove orphan objects after a grace period.                           | Not finalized or deployed by this feature. |
| Failed/temporary imports            | Reconcile partial object writes; clean unused bytes only after preparation/lease checks.                                                     | Not finalized or deployed by this feature. |
| Ready inputs and reused inputs      | Respect accepted-job pins and independently owned reuse before cleanup.                                                                      | Not finalized or deployed by this feature. |
| Owned outputs                       | Serve only authorized short-lived read capabilities; report expired/deleted honestly.                                                        | Not finalized or deployed by this feature. |
| Private recovery receipts           | Retain within their qualified upstream recovery window; remove sensitive descriptors after terminal reconciliation under an operator policy. | Not finalized or deployed by this feature. |
| Ledger/idempotency/attempt receipts | Retain the minimal record needed for replay-safe accounting and unknown-acceptance recovery.                                                 | Not finalized or deployed by this feature. |
| Application/transport logs          | Exclude prompts, media, capability URLs, credentials and raw provider bodies; review identifier retention separately.                        | Not finalized or deployed by this feature. |

The deployment owner must set and verify private bucket policy, lifecycle rules, backups, encryption, multipart cleanup and actual durations before publishing a hosted promise. A bucket lifecycle rule must not delete pinned work behind the application. Configure cleanup through reviewed deployment/application configuration; this feature does not create cloud resources or delete production data. Private API/app responses require `Cache-Control: no-store`; signed object URLs remain bounded bearer capabilities. Public catalog/company/model metadata and public metrics must not contain private job/actor/tag identifiers or media links.

## Separate supplier facts

`packages/engine/src/supplier-privacy.ts` supplies an internal pure evaluator, `supplierPrivacyIssues(requirements, disclosure, scope)`. Integrate it before reservation/submit, using reviewed server-owned facts scoped to the exact supplier deployment and, where applicable, connection. Clients must not supply their own disclosure or capability evidence. Missing evidence and a different account/deployment cannot satisfy an explicitly requested guarantee. Evidence status remains `documented` or `live-verified`; fixtures do not upgrade it.

The evaluator keeps the following independent:

- API endpoint location, inference scope and all disclosed processing locations.
- Supplier storage locations.
- Payload/request history and deployment logging.
- A comprehensive maximum data-retention commitment.
- An explicit zero-data-retention commitment.

An EU endpoint does not establish EU processing or storage. History opt-out does not establish absence of deployment logs. A CDN expiry does not establish deletion of prompts, inputs, logs, backups or every supplier copy. Private OpenGen delivery does not establish supplier ZDR. Unknown values remain unknown. Requests for unsupported/unknown guarantees must fail before charge; do not silently downgrade them or present them as best effort. Supplier facts and terms may need account-specific evidence and re-review before enablement.

No complete supplier privacy matrix or hosted ZDR guarantee is established by the current candidate. Exact model/region identity and the existing regional routing policy remain authoritative; this module must not expand available routes or infer region coverage.

## fal controls and restricted delivery gate

The repository's [fal mechanism audit](research/canonical-inputs/fal-reference.md) and [fal gap audit](FAL-GAP-AUDIT-2026-11-04.md) supply the baseline. Official fal documentation was read again on 2026-11-04 without accessing a provider account. fal separates history, CDN media and deployment logs; history opt-out alone does not establish ZDR. [fal retention documentation](https://fal.ai/docs/documentation/model-apis/media-expiration)

`prepareFalPrivacyControls` validates a semantic plan. `falPrivacyHeaders` serializes only the named controls: history opt-out becomes `X-Fal-Store-IO: 0`; lifecycle JSON contains the selected `expiration_duration_seconds` and, for account-private output, `initial_acl` with a `forbid` default and no additional users. Capabilities require reviewed evidence for the exact deployment/connection. Expiry must fall within reviewed bounds and cover the explicit recovery window. Private ACL additionally requires `authenticatedIngestion: 'ready'`; the default remains `unavailable`. Neither the plan nor header serialization establishes ZDR. [fal platform headers](https://fal.ai/docs/documentation/model-apis/common-parameters), [fal file ACLs](https://fal.ai/docs/documentation/model-apis/file-access-controls)

`exchangeFalCdnReadToken` authenticates only at the fixed fal REST token endpoint, requests a short lifetime, bounds response bytes/time and rejects redirects. It validates the returned token and ISO expiry, clamps local use to the requested lifetime, and produces bearer-header options for the existing DNS-pinned `readPublicAsset`. The API key is never returned in download options. Tokens stay in memory for immediate ingestion; do not log, persist or expose them in customer DTOs. The returned local deadline must be checked before use; reacquire an expired capability for the same upstream task/output. Official fal's Python client also parses the token expiry as an ISO datetime. [fal file ACLs](https://fal.ai/docs/documentation/model-apis/file-access-controls), [official fal client](https://raw.githubusercontent.com/fal-ai/fal/main/projects/fal_client/src/fal_client/client.py)

The supported restricted-media host is the exact documented `v3b.fal.media`, limited to canonical `/files/b/<store>/<file>` URLs without queries/fragments. This is intentionally narrower than a general `fal.media` suffix. `vf.fal.media`, bare `fal.media`, `v3.fal.media` upload transport, unknown subdomains and redirects are not qualified restricted read targets. The token response's `base_url` does not change this permission. Broader support needs reviewed evidence and tests. [fal file ACLs](https://fal.ai/docs/documentation/model-apis/file-access-controls), [fal CDN guide](https://fal.ai/docs/documentation/model-apis/fal-cdn)

The existing fal adapter remains unchanged. The integration owner must authorize the persisted job/output and supplier connection, connect token exchange to private delivery receipts/downloads, enforce the local deadline, and prove same-output recovery before enabling restricted output headers. No live restricted-CDN retrieval has run. Never send a fal API key to a media host, derive allowed credential hosts from an untrusted URL, broaden to a wildcard, or forward credentials across redirects. Delivery retries resume the same task/output slot and do not regenerate or settle twice.

## Verification boundary

`tests/supplier-privacy.test.ts` uses synthetic facts and no credentials/network. It covers unknown/reviewed facts, independent location/history/logging/retention controls, full location coverage, account/deployment scope, recovery windows and the restricted-output gate. It proves the policy evaluator and semantic control validation only. Registry/admission hooks, deployed storage retention, private-delivery token integration and live restricted retrieval remain integration/deployment prerequisites. `tests/fal-cdn.test.ts` verifies the fixed token origin, bounded lifetime/response, safe errors, exact media host and absence of the API key in download options, using synthetic HTTP responses only.
