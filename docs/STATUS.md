# Implementation status

Core integration snapshot from **2026-11-04** with Playground, billing and legal-surface source updates through **2026-11-10** (`0.1.0` source release). Source publication is not a claim that the current core is deployed to managed production or that unverified provider routes are live-tested. Exact-candidate CI and clean-archive qualification govern source acceptance. See [execution ownership](CORE-EXECUTION-TRACKER.md), [core delivery plan](CORE-DELIVERY-PLAN.md) and [release gates](RELEASE.md).

All user generations, prompts, inputs, outputs, receipts, tags and comparisons remain private to their workspace and authorized identities/scopes. There is no generation gallery, share/publish operation, visibility toggle or private-content SEO. Public catalog/company/model SEO remains. SDK distribution, new SDKs/language bindings and framework adapters are deferred; raw HTTP/MCP documentation and executable examples are the adoption deliverable. Existing internal clients receive necessary compatibility maintenance.

## Human identity Terms source follow-up — 2026-11-09

The source candidate adds the common `/auth/login` Terms/Privacy notice and bounded same-origin Continue, preserves OIDC PKCE/state/nonce and transaction-bound MCP return, and appends migration029 for minimal immutable per-identity policy receipts. The approved legal bodies remain one shared typed source. The current policy remains draft/inactive: normal sign-in accepts no draft and writes no Terms receipt. Active-policy behavior is exercised only with synthetic fixtures; publication/effective-date activation, actual customer assent and hosted identity/client qualification remain separate gates. See [the implementation boundary](IDENTITY-TERMS.md).

The follow-up hosted legal publication wiring (`@media-router/contracts/hosted-legal-publication`, `scripts/prepare-hosted-legal-candidate.ts` and API-only `OPENGEN_LEGAL_PUBLICATION_JSON` / `OPENGEN_LEGAL_PUBLICATION_FILE`) binds one validated immutable publication snapshot across the public web routes, `/legal-publication.json`, `/auth/login`, verified OIDC `mr_terms_receipts` recording and live manual funding admission on `https://opengen.dev`. Unconfigured and self-hosted deployments leave both variables unset and retain the non-binding draft presentation; pre-`effectiveAt` configuration renders scheduled notices without accepting Terms or opening live funding. Source wiring does not perform hosted `T0` publication, receipt-disposition ownership separation or live Stripe activation.

## Hosted external signup and manual prepaid enrollment — 2026-11-11

In scoped manual billing mode (`activation === 'manual'`), workspace administrators signed in through browser OIDC with an active human Terms receipt (`mr_terms_receipts`) can self-serve establish manual prepaid funding ownership (`POST /v1/billing/owner` and `/billing` enrollment card) for newly created personal (`user-*`) and team (`team-*`) workspaces. Self-serve enrollment writes an audited `mr_billing_owners` record pinned to fixed non-recurring rails (`allowsEnabled: false`), enforces `OPENGEN_BILLING_CHECKOUT=paused`, rejects API keys, MCP OAuth grants, non-admin members and active-owner overwrites, and keeps `fixture` and `sandbox` modes default-closed. Saved-card setup, automatic recharge and customer portal remain disabled on manual billing runtimes, and unconfigured or comparison-only provider routes remain truthfully disclosed rather than advertised as live-verified. Keyless hosted legal publication startup also omits unscoped `PaymentStore` construction when Stripe credentials are absent.

## Aged unresolved cost relief source

The core candidate adds an internal, default-closed staff operation for the Credit Policy section 8 funded remedy. One independently approved full-reservation advance preserves the original provider uncertainty, accepted recovery and key-budget hold. Reliable late settlement records the original gross charge and recovers only the unused advance from that job's release. Immutable funding provenance retains paid/noncash character and original payment dates. Migration 031 follows payments' reserved 030, with native concurrency, late-cost, immutable-receipt and upgrade/restore qualification. Publication, staff composition and actual financial admission remain separate. See [the operator procedure](billing/aged-cost-relief.md).

## Current source candidate

The November 9 brand source candidate uses the owner's final Opposing cuts
selection: stepped paired corners, a 12 px magenta center with two opposing cuts,
and the original outlined Geist Pixel wordmark. The common header/footer, native
app/favicons, Organization logo and standalone social image use the same approved
artwork. Light/dark SVGs, a forest-tile Stripe icon and transparent horizontal
exports replace the earlier rounded G assets. The existing palette, body fonts
and page layout remain. Source files do not establish website deployment or
Stripe upload. See [the identity decision](design/DECISIONS.md#approved-opposing-cut-identity--2026-11-09).

Hosted payment support is required at initial release. The source integration combines the current Playground and billing runtime, preserves reviewed billing migrations 022–025 and comparison migration 026, and keeps the dedicated sandbox startup path behind explicit configuration. Stripe-signed hosted delivery and production acceptance have separate qualification gates. See [the payment rollout review](billing/hosted-payment-rollout.md) and [runtime integration and manual acceptance](billing/runtime-integration-026.md).

A hosted sandbox attempt on source `292e462` exposed a Checkout UI enum incompatibility. The corrective candidate adds migration 027 and explicit new request versions while fencing historical unbound POSTs and preserving known-session fulfillment. Local regressions do not replace fresh hosted qualification. See [Checkout request compatibility](billing/checkout-request-versions.md).

The staff refund candidate adds forward migration 028 and a separate, default-closed
closed-by-default store. It secures an audited original-payment remainder, claims one
manual external instruction, records verified processor evidence and applies one
exact wallet debit or evidenced restoration with separate rounding expense. Staff
holds preserve existing admission and accepted-job recovery behavior. There is no
normal runtime route, refund issuer, automatic live activation, automatic paid-lot
allocation, expiry scheduler or general unknown-provider-cost waiver. Local fixtures
are not hosted financial admission or policy adoption. See the [staff procedure and
remaining core dependencies](billing/staff-refunds.md).

The existing-refund integration adds a separate, unmounted mode-matched controller and
official-SDK raw-signature producer. It pins one canonical paid order/refund,
offers a read-only rehearsal, prepares only an already-issued return, observes
verified deliveries and requires independent approval for an explicit exact debit.
It cannot dispatch, issue refunds or resolve holds. Forward030 mode-binds the refund
case/financial guard, preserving001–029 and false-mode history, and source accepts
explicit matching manual/live-shaped composition while remaining closed by default.
New live funding additionally matches the verified human with029 and the active
server Terms snapshot; accepted recovery is separate. No protected namespace or
real live account is qualified by local fixtures. See
the [controller boundary](billing/existing-refund-controller.md) and the
[remaining live-source proposal](billing/staff-refund-live-source-plan.md).

The [billing expansion](BILLING-POLICY-PLAN.md) has a separate recovery checkpoint containing the fee, policy, customer setup, recharge, UI and fixture modules. Migration 022 connects fixture-only generation fees. The local integration through 025 adds explicit billing authority, processor ownership, signed reconciliation and a fixture-only application and worker path. Commercial decisions, processor qualification and activation remain gated. See [the 025 integration checkpoint](billing/core-025.md). The recovered branch carries the earlier fixture ledger as historical evidence in [BILLING-QUALIFICATION.md](BILLING-QUALIFICATION.md).

- Public docs provide a four-step HTTP quickstart with separate quote, paid-submit and status copy actions, a shared-route API index, and a crawlable image-to-video guide from the canonical agent walkthrough. OpenAPI includes core operation titles/groups, the implemented multipart image-edit contract and HTTP-only private comparison endpoints. Guide discovery links respect the selected model and documented route capabilities.
- Lists 27 exact variants, 11 companies, 19 deployments and 66 provider routes, with explicit Official attribution and canonical common/model-specific inputs. MiniMax and fal H3 Max share the `minimax/h3-max` variant and `fal/h3-max` remains an alias. Turbo/Flex derivatives and regional deployments remain separate. Unknown prices, measurements and residency remain unknown.
- Requires configured private output storage before new reservation/dispatch. Customer job/native/MCP/compatibility reads expose authorized owned capabilities and bounded evidence, withhold raw provider URLs/storage keys/private credential receipts, and keep generation, delivery and settlement independent. Operator-only inspection retains the original provider task identity.
- Freezes immutable input packages before admission; validates readiness/type/ownership, supports bounded audio/WebM and multipart, pins accepted inputs, and registers private output reuse. Original request/idempotency/actor metadata remains immutable. Legacy current-byte cutover never claims original-at-admission hashes or silently refetches missing external references.
- Persists per-output recovery receipts and inline staging before provider-side archival. Same-job recovery uses original attempts and frozen encrypted credentials, immutable output keys, bounded leases/retries and safe per-file evidence; it neither regenerates nor settles again. Known decoder rejection is unusable delivery; missing tools/measurements are unknown.
- Revalidates key/member/grant authority under the reservation lock after preparation; records private actor/project/tags; atomically reserves workspace and stable-key UTC monthly exposure. Rotation retains key/cap lineage and revokes sourced grants/sessions. Saved exact-model/author/provider/region/scope policies have revisions/archive behavior and fail closed.
- Adds durable workspace/supply capacity, unknown-acceptance occupancy, pre-intent input preparation, local queue-start deadlines, safe errors and nullable progress/timings. Compact status supports bounded fresh-authorized waiting/disconnects. Accepted polling, deadlines, stale intents and private delivery receive bounded maintenance turns ahead of new submits.
- Adds compact private Activity pagination/filters/ledger analytics, customer webhook edits/rotation/history, member notifications and governance screens. Browser recovery binds identity/workspace/effective authority; canonical forms/advanced/JSON preserve exact route/roles/options and reject stale quotes/replies. Optional operational email has verified-recipient/member opt-in and durable relay delivery; absent configuration sends nothing. Actual relay/inbox delivery is not claimed.
- Extends the documented compatibility subset with strict owned image edits/references, bounded base64 and owned video Range/If-Range delivery. Unsupported mappings fail explicitly. Read-only catalog drift and price-evidence tools require review and cannot enable routes or rewrite accepted snapshots.
- Integrates committed onboarding diagnosis/discovery/recovery/feedback and the later source-safe deployment/budget evidence. The shared USD50 journal retains its original authority/holds; foreign observer scope is rejected before HTTP. No new paid admission was performed by core integration.

- The November 6 Playground source candidate exposes published rate evidence and request approval terms, adds phone action navigation and public setup links, and keeps the authorized result available during draft edits. The separate private comparison admits two priced text-to-image jobs atomically through the existing executor. Its quote and original job identities live in forward migration 026, after the immutable billing schema in 022–025. Hosted identity, pricing and delivery require separate qualification.

Forward migrations013 (onboarding feedback) and014–021 (private core) are centrally allocated; old SQL remains unchanged. Source/domain fixtures are not native races, deployed storage, actual clients or live provider qualification.

## Qualification state

The optional `qualification-sg-v1` execution scope adds a shared fixed request boundary for the Singapore Wan Standard/Prime video and Qwen Turbo image qualification cohort. It narrows quote eligibility, new admission, frozen input checks and new dispatch/fallback without removing documented catalog capabilities or changing normal unrestricted self-host defaults. A verified owned fixture fingerprint gates image-to-video; queued scope conflicts require an explicit operator transition and retain original jobs/holds while accepted provider attempts remain recoverable. Configuration and local scope fixtures do not establish live qualification or customer launch approval. See [operator execution scope](EXECUTION-SCOPE.md).

All eight feature packages and the privacy, money, documentation, activation and packaging QA fixes are integrated. Private runtime fixtures exercise original credential ownership, same-job partial/inline recovery, exactly-once money, current key/member authority, cancellation during signing, queue/maintenance fairness and legacy input cutover. The earlier clean checkpoint `d64875a` passed all 1173 native-service tests; CI then found platform and restore-command issues in the separate upgrade harness, which were corrected. Those results are historical evidence, not a pass for a later source tree. Final acceptance requires current-head whole-tree CI, the populated native upgrade/dump/restore harness, production browser/build checks, history/tree scans and installation/build of the exact clean source archive. The PR and release qualification report retain the actual commit and results; partial or synthetic cohorts do not substitute for them.

Both installed x86 and temporary arm64 PostgreSQL binaries failed local shared-memory initialization. PGlite remains explicitly a PostgreSQL-wire fixture check. The private CI PostgreSQL service is the native qualification path; its populated001–012 upgrade/dump/restore harness preserves unknown/accepted jobs, holds, grants/events and checksums. See [verification history](VERIFICATION.md) and the execution tracker for dated evidence boundaries.

## Separately owned deployed evidence

The committed onboarding report at `8dffe71` records an **older** private runtime image from `f9f9784`, 13 migrations, reduced database privileges, private GCS transport and production Vercel WIF metadata access. That image is not the current C0 core. These source-attributed deployment observations do not prove the new migrations/credentials/assets/recovery/capacity/browser paths are hosted.

On 2026-11-06, both Codex and Claude completed hosted generation and private delivery on `alibaba/ap-southeast-1/wan-3.0` with a 480p, two-second image-to-video request. A later bounded hosted pass completed Standard text-to-video and Prime text-to-video/image-to-video at the same resolution and duration. Route badges and quote notices record those scoped configurations. These observations used an earlier deployed API/worker cohort; the current integrated source still needs deployment verification. See [hosted provider evidence](providers/COVERAGE.md#hosted-wan-evidence--november-6-2026) and [earlier local validation](providers/VALIDATION-2026-11-03.md).

Before hosted core activation, reconcile the older seven-day bucket lifecycle with accepted input pins and qualify conditional PUT/If-None-Match, multipart/ETag/CORS, private capability cache/HEAD behavior and retention/soft-delete disclosures. A cloud age rule cannot silently delete pinned accepted inputs. No live bucket policy was changed by core integration.

The dated provider report records seven authenticated read-only surfaces, five upstream successes, four gateway deliveries and manual xAI recovery on a separate source cohort. It does not establish complete exact model/operation/region coverage or current-core gateway delivery. The single coordinator/current journal owns further paid admissions and unknown fal/MiniMax holds; historical remaining-balance numbers are not a new allowance.

Hosted current-core upgrade/restore, identity/client proof, provider coverage and actual xAI/restricted-output delivery, native verifier isolation, final hero/media rights and required initial-release Stripe sandbox/raw-webhook proof remain explicit operational gates independent of source publication. Self-hosted installations may use operator funding without a payment processor, with legal surfaces defaulting to Draft unless a validated hosted publication manifest is configured for `https://opengen.dev`. Workspace npm packages remain private/unpublished (`private: true`); hosted activation and live payment/provider admission retain their separate gates. See [the public application/private runtime boundary](OPEN-SOURCE-BOUNDARY.md).
