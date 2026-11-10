# Release-candidate verification

This file preserves dated verification cohorts. Later evidence supersedes older provisioning/client blockers; none of the earlier counts proves the current C0 core. See [current status](STATUS.md), [execution tracker](CORE-EXECUTION-TRACKER.md) and [hosted activation gates](CORE-HOSTED-ACTIVATION.md) for the 21-migration candidate. Core qualification is being recorded against one exact final commit; fixture, native CI, earlier deployed image and actual-client evidence remain distinct.

Evidence updated **2026-11-04**; earlier cohorts are retained below. Local checks use **Node.js 22.23.2 arm64 on macOS**. The integrated source includes canonical generation, customer onboarding and payments. These results are local/fixture evidence, not a public release, live provider test, real identity-provider sign-in or payment charge.

## Agent onboarding verification — 2026-11-04

Isolated from integrated `e530da5`, branch `codex/agent-onboarding-20261104`, Node 22.23.2 arm64. The stable serial suite passed **335 tests, 80 conditional skips across 55 files** in the expanded frozen-source cohort; shared-budget/legacy guards subsequently passed 19 focused checks and the isolated snapshot observer passed all 3 with unchanged time limits. The initial run started during parallel edits and stalled; it was stopped, then the frozen-source full run passed without changing timeouts or excluding files. Targeted packaging/installer suites also passed. PGlite passed **102 tests, seven native-only skips across 17 files**. Native PostgreSQL races remain an exact-commit CI gate.

TypeScript, catalog validation (27 models/19 deployments/67 routes), generated onboarding check, formatting, release hygiene, full Git history/proposed-tree Gitleaks and the **87-route production build** passed. Ten new desktop/phone Chrome browser cases passed with synthetic backend responses and visually reviewed screenshots. These overlap other cohorts; do not add them to the standard-suite count. Actual Codex 0.155.1 read-scope DCR login against the earlier public service stopped at HTTP 404 registration; no grant or media call occurred. See the [qualification ledger](AGENT-QUALIFICATION-2026-11-04.md).

All four CI jobs on historical commit `0cb4460` passed, including native PostgreSQL, browser/build, history/source secret scans, containers and isolated C2PA fixtures. The real hosted API/worker, private storage, least-privilege database role and production-only Vercel transport are deployed and verified. Actual client OAuth and media acceptance remained pending in this cohort. Package, source and transport fixtures are not deployed client success. No paid provider call has run in this onboarding workstream.

## Earlier integrated checks

| Check                           | Observed result                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole-project TypeScript        | Passed after source integration.                                                                                                                                                                  |
| Next production build           | Passed; 82 pages.                                                                                                                                                                                 |
| Standard unit/API/adapter run   | 271 passed, 78 conditional skips; 349 tests across 46 files, including standalone packaging, Retry-After and deployment-plan fixtures.                                                            |
| Complete PGlite SQL runner      | 98 passed, seven native-PostgreSQL-only race tests skipped; 105 tests across 16 files.                                                                                                            |
| Desktop/phone browser coverage  | 58 distinct passing scenarios: 46 main desktop/mixed cases and 12 phone onboarding cases. Evidence includes corrected targeted follow-ups, not a claim that the first combined run was all green. |
| Gitleaks                        | Full history and proposed source passed; 410 source files. The compiled CLI's seven files also pass.                                                                                              |
| Local packaging/release hygiene | Passed; clean archive install, TypeScript, 27 focused checks and 82-page build pass. Standalone CLI bytes match the original qualified build. Final tagged archive remains a separate gate.       |

Counts belong to their individual commands/cohorts. SQL and targeted browser checks overlap other runs and must not be summed into a new distinct-test total. A conditional skip is not passing evidence. The release owner must bind these results to the exact reviewed commit before publication.

The checks cover model-schema discovery and media-role parity, strict common/model-specific arguments, provider mapping, unknown acceptance and idempotency, regional and credential ownership, atomic money and shared credit transactions, account/key/grant boundaries, OAuth/CLI/configuration binding, payment holds/caps/signature fixtures, raw-byte webhook transport, and desktop/phone recovery and onboarding. Unsupported operations and unknown prices remain explicitly unqualified.

## Evidence limits

PGlite runs PostgreSQL SQL through a local WASM/socket process and a constrained connection pool. It does not establish native multi-connection locking. The seven native payment races are enabled with TEST_NATIVE_POSTGRES=1 in PostgreSQL CI; they require exact-commit CI evidence and were not run locally. Fixture requests do not reach model providers or Stripe. Browser responses and accounts are synthetic; no client/version in [AGENT-SUPPORT.md](AGENT-SUPPORT.md) is live-certified.

Historical review commit `aea948a` passed all GitHub CI jobs: native PostgreSQL with the seven local race skips enabled, browser/build, complete-history secret scans, container startup/authentication and database backup/restore. Its source archive SHA-256 is `ee30d89c2f8213179eff2939e7f6bfc273463ea84baeedc070a307b4598a6c8a`; extraction without Git metadata passed source hygiene. Subsequent CLI/workflow changes require their own final-commit checks.

Historical review commit `877fb7d` passed all four CI jobs. This includes real isolated c2patool checks using synthetic fixtures, native database races, source/history scans, container backup/restore, the standalone package, and production browser/build checks.

Its source archive SHA-256 is `91bf690199c80174afeed812026bf6e61abc892ded3a05bdfd285b98437c7016`. A fresh extraction without Git metadata passed `npm ci` (zero reported vulnerabilities), source hygiene, whole TypeScript, 27 focused SDK/discovery/package checks and the 82-page production build. The CLI rebuilt from that clean install is byte-identical to the original qualified local package, SHA-256 `4eec86dce39f961b99c64b3c53a3d879bad0e96c234e497fdfbdc6c304b09b2d` under the recorded local toolchain.

The standalone CLI passed 11 packaging tests and the 44-test CLI/login/binding cohort. Its tarball contains seven reviewed regular files, full licenses and manifests; only Node builtins remain external at runtime. It is locally installable and unpublished. Documentation-only evidence updates do not establish live operation or waive final tagged-archive checks.

This historical cohort did not configure provider credentials or submit paid jobs. Every advertised executable route requires dated live evidence; current admissions use the shared operator journal. Stripe sandbox/restricted-key/webhook flows, actual hosted identity and agent authorization, GCP deployment/WIF and final Hyperframe footage remain unverified. Real-tool CI is not production verifier deployment evidence. No provider or payment network activity is inferred from fixtures.

## Deployment and artifacts

The earlier public `https://opengen.dev` catalog has working Cloudflare/Vercel HTTPS and crawlable canonical pages. The integrated candidate is not deployed. GCP billing remains disabled and the API/worker, database, storage and production identity/secrets are not provisioned. The raw Vercel-to-GCP webhook relay and keyless transport are source/fixture implementations; live federation, IAM-private backend delivery and Stripe signature forwarding still need deployment evidence. See [DEPLOYMENT.md](DEPLOYMENT.md).

Screenshots, traces, private receipts, local configuration and provider evidence remain ignored artifacts. The final release must pass the checks in [RELEASE.md](RELEASE.md) against its exact commit/archive. See [STATUS.md](STATUS.md) for current product scope and [PARALLEL-DELIVERY.md](PARALLEL-DELIVERY.md) for the integrated workstream boundaries.

## Dedicated catalog and playground navigation — 2026-11-03

The UI follow-up separates `/models` discovery from `/playground` creation, removes Companies from primary navigation and preserves creator/series pages and exact regional handoffs. Local TypeScript and the 84-route production build pass. The standard run passes 273 tests with 78 conditional skips; 59 distinct desktop/phone browser scenarios pass across the main run and targeted follow-ups. Two parallel local browser processes initially collided in their shared trace directory; the affected cases passed with separate output folders. No provider generation, payment or deployment was performed for this UI change.

## Expanded color palette — 2026-11-03

The Pantone-inspired color follow-up preserves the forest foundation and adds category accents, cream count panels and readable regional/source metadata. The 84-route production build, whole TypeScript, formatting and 15 focused catalog/series desktop/phone browser checks pass. Desktop model/catalog/home and phone model screenshots were reviewed; the phone document remains 390px wide at a 390px viewport. The new accent foreground pairs pass the documented contrast calculations, with dark ink on light fills. No API, pricing, availability or verification values were changed.

## Shared MiniMax H3 Max identity — 2026-11-03

Owner-confirmed MiniMax H3 Max / fal H3 Max naming is represented by one `minimax/h3-max` catalog model and generation profile. The current catalog has 27 models, six H3 variants and the same 67 routes. Both provider routes retain their IDs, upstream IDs, prices and sources; providerModelName retains the original human labels. `fal/h3-max` is accepted as an alias across discovery/generation and redirects in model/playground URLs, preserving explicit provider pins. Route validation retains narrower native limits and fal-specific capabilities before reservation. TypeScript, the 84-route build, 282 standard tests, 98 PGlite checks (seven native-only skips) and 15 catalog/series browser scenarios pass; focused CLI/package follow-ups also pass. No live provider calls were made.

## Grouped playground model picker — 2026-11-03

The model picker uses the catalog's 14 explicit series as native option groups, retaining all 27 exact variant IDs once and removing duplicated creator suffixes. The 84-route production build, whole-tree TypeScript and four focused playground/provider-handoff browser scenarios pass. Additional checks at 1440px and 390px confirm group membership, exact variant selection, provider-pin retention while editing, pin reset on model changes and no horizontal overflow. No provider generation ran.

## Playground API and agent instructions — 2026-11-03

The playground has compact API/agent controls above the browser form. Request JSON and agent briefs call the existing form request builder, preserving model, operation, named media, billing, spending limit and regional provider selection. Curl commands read a separate request.json and use private environment-variable placeholders for the workspace key, persisted submission ID and returned job ID; user text never enters shell command source. The MCP address and API endpoints use the server's validated public site origin.

Whole-tree TypeScript, the 84-route production build, formatting, 415-file release hygiene and full-history/proposed-source Gitleaks pass. Seven focused browser scenarios pass across the initial run and targeted follow-up; two new tests initially used exact implicit-label locators and passed after selecting the same controls by role. Checks cover exported-request parity with browser quotes, named first frames, exact provider pins, clipboard contents and desktop/phone input retention. Additional 1440px/390px screenshots and three generated commands per layout were checked using a mock curl, without network generation calls. No provider or payment activity ran.

## Brighter contrast palette — 2026-11-03

The visual follow-up retains the forest canvas and magenta actions, adding brighter citrus summaries, cyan video headers, apricot image headers and supporting lilac. All new light header text, IDs, copy actions, glyphs and selected badges use dark ink. Numeric contrast checks for the new dark-ink/light-fill pairs exceed 8:1; these do not certify unrelated existing states.

The 84-route production build and its TypeScript check pass, as do all 18 catalog/series/playground browser scenarios. Additional screenshots and computed-style checks at 1440px and 390px confirm the cyan/apricot fills, dark nested labels, forest variant buttons and no horizontal page overflow. The saved palette image is a local design artifact. No content, provider metrics, routing, billing or generation behavior changed.

## Coherent warm palette — 2026-11-03

The user rejected the prior multihue palette and authorized a complete color change. The candidate now uses espresso/cocoa surfaces, ivory light panels and one coral action accent. Shared semantic tokens replace hardcoded green/pink fields and category/geography rainbow overrides throughout catalog, playground, accounts, agents, billing and share-image styling. Semantic success/warning/failure colors remain separate from the brand, with state labels retained.

The 84-route build and its TypeScript check pass. All 50 existing desktop/phone browser scenarios pass, including generation drafts, provider handoffs, authentication, keys and synthetic payment flows. Additional screenshots and computed-style checks cover seven pages at both 1440px and 390px, with no horizontal page overflow and consistent dark-on-coral actions and ivory model headers. Contrast checks are recorded in design/PANTONE-SOURCES.md. This styling cohort made no live provider or payment requests; the separately requested provider-validation workstream owns its own dated evidence and the shared USD 50 budget reconciliation.

## Refined forest palette — 2026-11-03

The user clarified that the preferred direction is the forest/magenta/citrus/aqua/apricot/lilac reference, with smaller coherence adjustments. The warm-neutral experiment is superseded. The active palette retains forest and magenta, softens the citrus and aligns the four supporting tints. One magenta selection/action treatment, neutral regional labels and shared dark green text reduce unrelated color combinations while preserving the bright direction.

The final 84-route build and TypeScript check pass. The 18 catalog/series/playground browser scenarios pass; additional computed-style and screenshot checks cover five pages at both 1440px and 390px with no page overflow. Dark ink on all four supporting fills exceeds 7:1. Explicit warm-white labels on magenta exceed 4.5:1 in normal and hover states. The semantic-token cleanup across the wider account/billing surfaces previously passed the full 50-scenario browser cohort. This styling work made no live provider or payment requests.

## Logged-in Start, Activity and Team — 2026-11-03

The new noindex `/app` shell reuses existing sessions, onboarding, generations, ledger and team components. Start, Activity and Team are hash-addressable; keys, connected apps and billing have separate entries. Legacy dashboard hashes remain supported. Team's embedded key-settings area is omitted in the new Team view while the legacy settings page retains it. Workspace/read-scope gates and aborted stale loads prevent another workspace's records or selected prompt from remaining visible. Normal browser OIDC sign-in now lands on `/app#start`; valid pending MCP consent retains precedence.

The final build has 85 routes/pages and passes TypeScript. The browser cohort covers 54 distinct scenarios across the initial run and focused follow-ups. One new test initially retained its guest document during a mocked identity change; reloading after the fixture change corrected it. All four account cases and twelve legacy onboarding cases pass on the final UI. Six authenticated synthetic-account screenshots cover Start, Activity and Team at 1440px and 390px. Five native authorization tests also pass against an ephemeral PGlite PostgreSQL-wire database; the separate focused no-database authorization cohort passed nine tests with its database-dependent cases skipped. These are distinct cohorts, not live hosted-login evidence.

Formatting, 417-file release hygiene and full-history/proposed-source Gitleaks pass. The actual preview remains catalog-only (`database: false`, `oidcEnabled: false`); no real identity provider was configured. Treg reference tab metadata was available, but in-app and user-approved Chrome content/screenshot calls timed out, so no completed live audit or exact visual parity is claimed. No provider or payment calls ran for this change.

## Official model authors and first-party providers — 2026-11-03

Every exact variant has an Official author attribution. The catalog's explicit `authorProviderIds` field marks author-operated serving companies, including ByteDance/BytePlus and Qwen/Alibaba relationships. Provider rows compare this metadata with their deployment's provider ID; there is no name, namespace or series-owner heuristic. MiniMax's shared H3 Max marks MiniMax's row, while fal's Max row remains untagged. Turbo and Flex follow their own exact derivative authors. Every Wan regional row is tagged independently. Kling's reseller-only listing and Qwen's base variant with no serving route retain their author attribution without inventing author-hosted availability. Tags are independent of live-verification status and OpenGen's commercial authorization.

Whole-tree TypeScript, catalog integrity, 58 focused catalog/API/schema tests and the 85-route production build pass. All 18 catalog/series/playground browser scenarios pass, including first-party/reseller and twelve Wan-region badge checks. Additional screenshots at 1440px/390px confirm visible author/provider badges, exclusions, empty-route handling and no page overflow. The local `/v1/models` response publishes the same author metadata. Formatting, 418-file release hygiene and Git-history/proposed-source Gitleaks pass. No paid provider calls ran for this change.
