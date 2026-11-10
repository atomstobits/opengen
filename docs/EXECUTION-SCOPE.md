# Operator qualification execution scope

`OPENGEN_EXECUTION_SCOPE=qualification-sg-v1` selects a bounded **qualification** profile. It does not establish provider entitlement, live verification, settled cost, or public customer launch approval. The normal self-hosted default is `unrestricted`; its existing catalog, policy, credential and pricing checks continue to apply. The GCP deployment planner requires an explicit profile and forwards the same profile to API and worker.

The profile permits managed billing, one output and no fallback, on these exact Singapore routes only:

| Models                                     | Operation        | Request shape                                                                                                          |
| ------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `alibaba/wan-3.0`, `alibaba/wan-3.0-prime` | `text-to-video`  | 480p, 2 seconds, explicit 16:9, no input media                                                                         |
| The same two Wan models                    | `image-to-video` | 480p, 2 seconds, source aspect, one already-owned first-frame PNG matching the operator's verified fixture fingerprint |
| `qwen/image-2.1-turbo`                     | `text-to-image`  | 1K, 1:1, no input media, watermark on, prompt extension and thinking off                                               |

The deployment is `alibaba-model-studio-ap-southeast-1`. Wan route IDs are `alibaba/ap-southeast-1/wan-3.0` and `alibaba/ap-southeast-1/wan-3.0-prime`; the image route is `alibaba-model-studio-ap-southeast-1/qwen-image-2.1-turbo`. Base Qwen and Pro variants are distinct and are not included. Turbo 2K remains outside the scope even though its published estimate equals 1K.

Only the listed model arguments are accepted: prompt, resolution, count and aspect ratio; Wan additionally requires duration and permits firstFrame only for image-to-video. Qwen additionally permits watermark, promptExtend and thinking at the fixed values above. Existing Qwen adapter defaults and count=1 may be omitted. Other advanced arguments, media, continuation, fee acceptance, BYOK and enabled fallback are outside this qualification profile. Existing model validation still applies.

## Owned fixture identity

For image-to-video, set `OPENGEN_QUALIFICATION_FIRST_FRAME_SHA256` to the SHA-256 of the independently verified, owned qualification PNG. Missing configuration leaves image-to-video nonexecutable; malformed configuration fails startup before opening a database. A fingerprint is valid only with the qualification profile. It is an operator control, never accepted in generation JSON or secret aliases.

The operator's cohort receipt must establish the proposed opaque 512×512 fixture's actual geometry, rights and immutable byte fingerprint. The engine does not invent dimensions or opacity from the digest and adds no decoder. It verifies authorized ready-asset metadata and current owned bytes against the configured fingerprint, then checks the frozen manifest before reservation and new dispatch. It imports no external reference to satisfy this profile. The fingerprint and private asset keys are not exposed in public catalog, quotes or doctor scope metadata.

API and worker must use the same profile and fingerprint. A zero-provider-I/O runtime fence and the billing-sandbox database fence remain stronger controls. Selecting this profile never opens those controls or enables production payments.

## Quotes, new work and existing work

Single/batch HTTP, MCP, CLI, compatibility and browser generation share the application engine. Out-of-scope quotes retain published estimates and catalog rows, but have no executable selection or reservation. Browser generation already follows that quote result. Configuration readiness still is not live verification.

New admission checks scope before imports and reservation, rechecks the governed request and prepared manifest at the reserve boundary, and revalidates the owned fixture before new provider dispatch. The profile permits no new fallback attempt. Existing accepted or unknown provider attempts continue using their original credentials, identity and snapshots for polling, cancellation, delivery and settlement. An idempotent replay still returns its original accepted job.

Changing scope requires an explicit operator transition. Use the operator-only `engine.executionScopeConflicts()` inventory and inspect existing queued, never-submitted work before switching writers. Admission and new dispatch use an existence check that reads bounded keyset pages and stops at the first conflict; it does not build a full inventory or aggregate all input manifests. Accepted work is handled before that scan. Existing admitted legacy cutovers use their frozen copied references and manifest with the original job's envelope and request hash; this scope never adopts new legacy inputs.

Scoped doctor output separates the runtime's transition-blocked boolean from the owning workspace's conflict count. No other workspace's count, job ID, fingerprint or asset identifier is exposed. If conflicts remain, new admission and dispatch fail closed. Conflicting queued jobs and holds are retained without automatic cancellation or refund; ordinary deadline handling continues for already-in-scope jobs. The qualification-only bounded expiry sweep rotates by job ID so conflicting head rows cannot starve eligible deadlines. This process-local cursor is only selection cadence; scope checks and locked PostgreSQL state remain authoritative. Accepted upstream polling, webhooks, alerts and other worker maintenance continue. Complete or explicitly reconcile conflicting work through the previously approved runtime; do not edit stored requests or infer refunds.

Fence old writers, compare API/worker effective configuration, inventory queued work and record the transition decision before activating the new runtime. The deployment preflight's runtime parity and external queue-transition evidence are prerequisites, not substitutes for actual source/image, resource, provider and money qualification.
