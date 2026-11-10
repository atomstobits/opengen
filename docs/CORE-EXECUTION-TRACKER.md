# Core implementation and release ownership

2026-11-04. Isolated baseline `fa825f054cd795b33316fb9486864539ffd32b5c`. This candidate is private; no public generation gallery or SDK distribution is planned.

The integration owner coordinates shared contracts, engine/auth/registry/ledger/migration wiring, combined qualification and release evidence. Feature owners work in isolated branches with the following responsibilities:

| Package               | Branch suffix               | Responsibility                                                |
| --------------------- | --------------------------- | ------------------------------------------------------------- |
| C1/C3 delivery        | core-delivery-20261104      | provider review, private readiness, durable recovery/evidence |
| C2/C4 assets          | core-assets-20261104        | owned input preparation, readiness, reuse, private lifecycle  |
| C5 governance         | core-governance-20261104    | trusted actor, tags, caps, key rotation, policies             |
| C6 execution          | core-execution-20261104     | safe errors, progress, capacity/deadlines                     |
| C7 operations         | core-operations-20261104    | private history/analytics, webhooks, alerts                   |
| C8 Playground         | core-playground-20261104    | canonical form, scoped recovery and reuse                     |
| C9 compatibility/docs | core-compatibility-20261104 | protocol conformance, raw HTTP/MCP reference                  |
| C10 catalog           | core-catalog-20261104       | reviewed drift and tariff tooling                             |

The onboarding/deployment owner keeps identity/deployment, CLI/skill/plugin, discovery/doctor/recovery/feedback, actual client proof and feedback migration013. Provider evidence stays with the separate provider-validation workstream. C0 does not admit duplicate paid tests, import keys, deploy or publish. The USD50 budget is shared and requires its current journal/coordinator.

Feature owners keep their handoffs with the integration checkpoints and migration ledger. Old migrations are immutable; C0 serializes contiguous new numbers and reviews hook commits separately. Provider changes are reviewed by actual commit diff to preserve newer attribution/Official/catalog/UI changes.

## Evidence

Checkpoint 1 publishes additive private actor/error/progress/status/history/asset types. Nullable legacy history remains unknown. All feature packages are integrated. Final combined tests, native PostgreSQL upgrade/races, browser/build/security/source archive and backup/restore qualification are tied to the exact clean integration head, rather than individual feature snapshots. Fixture checks do not establish hosted identity, real clients, provider delivery, payment enablement or media rights. See STATUS.md and the local integration report for subsequent exact commit evidence and remaining external gates.

Checkpoint 2026-11-04: all eight feature packages, shared capacity/delivery runtime hooks, legacy accepted input cutover and optional explicit-opt-in email are integrated. Onboarding013 remains unchanged; core014–021 are contiguous and registered once. Focused privacy, money, documentation, activation and release QA fixes are integrated. C0 owns exact-head CI/browser/build/native upgrade/restore and clean archive acceptance. Source PR merges are user-authorized when every current-head CI check is green; public publication and hosted/live qualification remain separate.

QA reports are scoped preflights and focused checks. Their earlier synthetic snapshot is not a release candidate. The exact final commit, CI/browser counts, archive digest and extraction/install/build results belong in the integration qualification report and PR; known hosted identity/storage/reduced-role, actual clients/provider delivery, native verifier isolation, optional mail/payment and final media-rights gates are preserved in STATUS.md and CORE-HOSTED-ACTIVATION.md.
