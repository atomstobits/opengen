# Scoped actual-client qualification and the shared budget

Reviewed 2026-11-04. This is a preparation proposal and fixture-tested coordinator, not actual-client/provider success. No live receipt was written and no provider or generation request was made during preparation.

## Existing authority

Use the original operator-owned private budget journal and its exclusive lock. Keep both permission-restricted and outside the source checkout. Verify the owning process stopped before removing a stale lock. Preserve the original accounting authority and all unresolved holds.

The historical source-safe provider report records five attempts and retained unknown fal/MiniMax charges. xAI gateway delivery remained failed despite manual output recovery. Reconcile the current journal against its original gateway and workspace before any new authorization.

The existing smoke runner refuses another gateway/workspace, plans only text generation and blocks another test of a previously tested route. Its provider-branch retained-hold acknowledgements preserve unknown charges. None of these global rules is relaxed by this proposal.

## Exact proposed case

Use `alibaba/ap-southeast-1/wan-3.0`, upstream `wan3.0-video`, `image-to-video`, one owned first frame, 480p, two seconds, one output, source aspect ratio, managed payer and no fallback. Singapore lists USD 0.05/output-second, so the request estimate is USD 0.10 and the conservative shared hold is USD 0.20 per client. For two cases, the proposed new hold totals USD 0.40. Reconcile the current authorization independently. The provider can charge differently from the estimate. [Current original Singapore tariff](https://www.alibabacloud.com/help/en/model-studio/wan3-0-video)

The first-frame API supports one image, two-second minimum without video inputs and 480p. Prepare an owned, opaque PNG/JPEG locally: each side 240–8000 pixels, aspect no greater than 8:1, at most 20MB. Native managed uploads must resolve to provider-reachable HTTPS storage URLs; never make the bucket public. Provider task/results last 24 hours, so retain the gateway job/output promptly. The published API recommends polling around 15 seconds. [Current API and limits](https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference)

Only Singapore has the relevant prior account/transport/generation sample. That sample was text-to-video; image-to-video and deployed delivery still need evidence. Other regions' lower tariffs do not establish access. The exact regional key, model and workspace endpoint must match. [Regional isolation](https://www.alibabacloud.com/help/en/model-studio/regions)

## New coordinator invariants

`scripts/client-qualification-budget.ts` exposes no executable entry point or provider transport. `runClientQualification` requires an exact named client/version/date, explicit approval, the current receipt SHA256, original authority identity, target gateway/workspace, exact scoped input and executable quote. A caller supplies a single actual-client/native-submit callback. Fixtures do not establish a real client.

The coordinator acquires the original exclusive lock, requires the existing private version-one receipt, compares its reviewed digest and revalidates historical unknown-charge evidence through a read-only observer against the original gateway or an authenticated copy of its original datastore. It never rebinds top-level authority or reinterprets historical inputs with newer model defaults. Historical unknown charges and their acknowledged full reservations are immutable in this admission coordinator; unavailable/mismatched historical delivery blocks admission.

Only two fixed cases are allowed across the entire journal: `hosted-assistant` and `local-coding-agent`, once each, in scope `opengen-onboarding-two-clients-2026-11-04`. This is a narrow route-repeat exception for the reviewed case; the original runner’s global duplicate-route checks remain unchanged; its additional foreign-origin guard only restricts unsafe cross-deployment recovery.

Each reservation is a normal version-one `SmokeEntry` in the existing `entries` array, with private per-entry client/gateway/workspace provenance. Legacy spend accounting sees the hold. The legacy runner explicitly rejects any client entry belonging to another gateway/workspace before job/ledger refresh or admission, even when its charge is known; it never treats a missing remote job as the guard. The reserved entry and submission intent are atomically written and fsynced before the one callback, while holding the same lock. Exceptions retain `admission-unknown`, the original key/input and the full hold; no callback retry, replacement, cancellation or automatic refund exists.

`reconcileClientQualification` only observes an existing owned native job/key and explicit `settle` ledger evidence from `details.upstreamCostMicros` linked to the same gateway/workspace/job. It matches all canonical outer controls, arguments and payer; only a narrower admitted cost cap is allowed. It stores hashes, never signed output URLs. A linked settlement is accepted only after the matching native job is terminal (`succeeded`, `failed` or `cancelled`). Queued, submitting, running and submission-unknown jobs retain unknown billing and the full hold even if a callback claims a settled ledger cost. A known settled cost cannot be silently reset or regress to a nonterminal job; absent billing stays unknown even after failure. An upstream cost above its reviewed reservation is recorded as the real liability and blocks further admission even when the aggregate remains below the approved total. Aggregate-budget exhaustion is reported separately. The second case waits until the first admission is reconciled; it does not replace a failed first case.

## Remaining prerequisites

1. Review this scoped coordinator and its transport callbacks before live use. Reconcile the sole journal under its lock and retain the unchanged fal/MiniMax holds. Use original owned-job/output evidence for the mandatory read-only historical observer; the earlier local validation services can remain stopped when using the offline snapshot path below.
2. Supply the deployed native gateway, initialized database, private storage, configured OIDC/native OAuth, funded paying workspace and exact Singapore provider connection through the approved secret mechanism. Preparation did not read provider `.env` files or import credentials. Verify provider API and DNS-pinned output transport independently; API proxy success does not prove delivery.
3. Prepare and locally decode the owned first-frame fixture; complete upload ownership and schema checks through each named client's supported journey. Obtain and retain the exact native quote and bounded payer authorization.
4. Use actual hosted and local clients with exact versions/dates. Capture discovery/schema/upload/quote, the one authorized submit, interruption/resume, private retrieval, refresh and revocation. Record unsupported client upload behavior honestly. Do not label source SDK, transport fixtures, browser stubs or CLI packaging as actual-client success.

Fixture tests exercise the legacy runner's explicit fail-closed behavior, shared liability visibility, locking, original-history retention, two-case bounds, unknown acceptance, read-only reconciliation, refusal of cost resets and invalid origin/region/payer/asset changes. They make no provider calls.

## Selected route: baseline versus provider branch

The selected Alibaba adapter implementation is unchanged between the integrated onboarding baseline and provider-validation commit `3c897e0`. Its Singapore route, image-to-video tariff and canonical operation schema are also unchanged; no provider-branch merge or Alibaba cherry-pick is required for this case. Whole-file catalog imports from that older branch would discard newer explicit authorship/Official metadata and must not be used.

For deployment `alibaba-model-studio-ap-southeast-1`, `alibabaCredentials` requires both a key and a provider workspace ID. The preferred regional settings are `ALIBABA_AP_SOUTHEAST_1_API_KEY` and `ALIBABA_AP_SOUTHEAST_1_WORKSPACE_ID`. The existing shared-key fallback is available only with `ALIBABA_REGION=ap-southeast-1`, `DASHSCOPE_API_KEY` and `ALIBABA_WORKSPACE_ID`. These are variable names, not credentials. Both API and worker must receive the exact approved Singapore connection server-side.

The adapter reconstructs the fixed provider origin `https://{workspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1` and submits to `/services/aigc/video-generation/video-synthesis`; polling uses `/tasks/{task_id}`. A successful authenticated model-list check on `dashscope-intl.aliyuncs.com` alone is insufficient to configure this workspace endpoint. The prior native text-video sample exercised the same adapter; the private runtime launcher contains no Alibaba/DashScope endpoint or fetch override. Do not invent a workspace ID or swap regional hosts.

If original read-only evidence needs restoration, first confirm process and socket ownership. Restore only the API, database and storage needed for original-job inspection. Keep workers and generation admission off during that recovery.

## Offline historical observer

`scripts/historical-qualification-evidence.ts` copies the stopped original PGlite database and S3rver object tree into a new ignored, private snapshot. It rejects symlinks and nested copy destinations, records per-file hashes, and verifies the sources and sole budget receipt did not change during copying. It then validates the copied database against that manifest before opening **only the copy**. All copied directories are mode 0700 and files 0600. No environment loader, provider/gateway request, worker or migration runs.

The observer selects exactly the original owned job and its original arguments/status/route. SQL projects output storage keys, types, lengths and hashes without selecting saved output URLs. Only job-owned copied objects can be read; their actual SHA256 must match the stored metadata, journal and immutable copy manifest. Returned evidence is explicitly tagged `original-datastore-snapshot`, with the manifest digest and original authority provenance. That is local datastore evidence; it does not claim HTTP transport or a current deployed service. Historical unknown charges and full holds remain immutable. When later used under the coordinator lock, the observation class and manifest digest are recorded alongside the original entry; the original authority and financial history remain intact.

A read-only preparation on 2026-11-04 verified both original unknown-charge jobs and their two archived objects from a private snapshot. No original service was started, no provider was called, and the live budget receipt remained byte-identical. Prompts, job IDs, storage keys and output URLs were not printed. The private snapshot and metadata summary remain ignored local evidence, outside release artifacts.

PGlite may update its working copy while opening or closing it. Treat each database copy as a disposable observer session; create a fresh validated copy before another session rather than bypassing a changed-copy check. The historical observer can be used under the same budget-coordinator lock without reviving the old API/worker.

## Hosted provider qualification cohort

The same coordinator module also exposes `runProviderQualification` and `reconcileProviderQualification` for three fixed, once-only hosted cases. This source extension prepares controlled admission. It does not record a live qualification result.

| Case                | Exact Singapore model and operation | Request estimate | Shared hold |
| ------------------- | ----------------------------------- | ---------------- | ----------- |
| `wan-standard-text` | Wan 3.0 Standard, text-to-video     | USD 0.100        | USD 0.200   |
| `wan-prime-text`    | Wan 3.0 Prime, text-to-video        | USD 0.136        | USD 0.272   |
| `wan-prime-image`   | Wan 3.0 Prime, image-to-video       | USD 0.136        | USD 0.272   |

Each case uses `https://opengen.dev`, managed billing, its exact `alibaba/ap-southeast-1/` route, 480p, two seconds, one output and no fallback. Text cases require 16:9 and no media inputs. The image case requires source aspect ratio and a workspace-owned first frame. The caller must verify the reviewed owned synthetic image's bytes, dimensions and ready asset state before admission. Additional parameters and different regions, models, payers or configurations are refused.

The caller supplies explicit approval, upstream estimate-risk acknowledgement, current executable quote, exact original journal SHA-256 and authority, and observed API and worker source commits. Source-priced estimates remain independent of provider-side spending enforcement. A `providerQualification` record with scope `opengen-hosted-providers-2026-11-06` stores the fixed case and its hosted observer authority alongside the normal legacy-visible reservation. The original journal, exclusive lock, USD50 ceiling, retained historical holds, financial history and two-client limits remain in force. The historical local text-video case and the hosted text-video case have distinct deployment provenance. This cohort permits only the three named additions.

Before reserving, the coordinator observes original unknown-charge holds through their original authenticated datastore/native observer and each hosted entry through its own recorded gateway/workspace observer. Existing entries are checked on copies and preserved in the journal. Mismatched jobs, output hashes, settlement evidence or observer authority block admission. Every prior hosted case must have a reconciled terminal job, available delivery and matching output hashes. An unresolved admission or cost blocks the next paid case.

The reservation and submission intent are fsynced under the original lock before the one native gateway callback. Exceptions retain the original idempotency key and full hold without repeating submission. Resume uses `reconcileProviderQualification` with only existing-job reads and the matching `ledger.details.upstreamCostMicros` settlement. Unknown costs stay unknown, failures do not imply refunds, and a reported overrun is retained and blocks further admission. Provider entries also participate in the legacy runner's pre-request observer-authority guard. The two actual-client cases cannot be repeated through this cohort.
