# OpenGen implementation plan

Updated 2026-11-04. This is the delivery contract; a planned feature is not an implemented feature. See [STATUS.md](STATUS.md) for the current slice.

The canonical generation, customer onboarding and payments workstreams are integrated in the source candidate. Their local implementation does not complete the agreed live-provider or release/deployment gates. See [PARALLEL-DELIVERY.md](PARALLEL-DELIVERY.md) and [VERIFICATION.md](VERIFICATION.md).

## Current owner decisions and execution plan

On November 6 the owner made hosted payment acceptance a requirement for the initial release. The first proposed payment scope is scoped manual USD Checkout, verified fulfillment and recovery. The release gate requires a dedicated hosted Stripe sandbox to pass first, followed by approval for the exact production candidate, payment terms and activation. See [the payment rollout review](billing/hosted-payment-rollout.md).

All user generations are private to their owning workspace and authorized identities/scopes. No public generation gallery, sharing/publishing or visibility controls are planned for v1. Public catalog/company/model documentation remains discoverable; private prompts/media/receipts never become SEO content. Retention, private signed delivery and upstream provider disclosures still require explicit behavior.

SDK distribution, new language SDKs and framework adapters are deferred. Existing internal clients may receive required compatibility maintenance. Excellent readable human/agent docs, schemas, raw-HTTP examples and easy API/MCP onboarding replace SDK distribution as the adoption deliverable; the existing CLI/skill/plugin work continues.

The detailed [core delivery and parallel work plan](CORE-DELIVERY-PLAN.md) is authoritative for sequencing, package ownership, dependencies, privacy acceptance and the deferred SDK scope. It assigns one integration owner to shared contracts/migrations and identifies independent work that can start immediately. Earlier competitive-audit SDK recommendations are historical findings, not current release commitments.

## Product and open-source boundary

Build an independent Apache-2.0 image/video API gateway with the catalog → inspect → quote → call experience found in treg. The public repository includes the core server, worker, catalog, routing, accounting, web UI, CLI and MCP. No treg source or proprietary hosted module is required. Its [current license](https://github.com/superdesigndev/treg/blob/main/LICENSE) restricts third-party hosted services built from its code, so we use original implementations and independently sourced provider information.

The positive publication inventory includes OpenGen's original implemented signup/account provisioning, authentication/sessions, workspaces/membership/keys, MCP OAuth, billing integration and complete frontend, alongside the self-hostable core. Ship safe configuration examples and useful installation, deployment, upgrade, storage/retention, backup/restore and rotation documentation. Actual credentials, customer/private-generation data and sensitive deployment-specific settings remain private. No mandatory unpublished application or abuse-policy module may be required for the documented self-hosted core; no new policy framework is requested. Publishing payment integration source is separate from enabling real payments and does not add automatic refills. See [OPEN-SOURCE-BOUNDARY.md](OPEN-SOURCE-BOUNDARY.md) for source/archive acceptance and the corrected treg reference findings. OpenGen's standard Apache-2.0 decision is unchanged; SDK distribution remains deferred.

The product is named **OpenGen**, with canonical public origin `https://opengen.dev`. The frontend is hosted on Vercel, the backend belongs in a separate GCP project, and Cloudflare owns authoritative DNS. Keep secrets outside the open-source repository and frontend builds; see SECURITY.md and docs/DEPLOYMENT.md.

The user selected the dark terminal-inspired direction, then requested a less geeky treatment for designers and producers. Keep restrained retro brand details, approachable sans-serif body text, visual discovery and plain-language creation controls. The latest color request permits replacing every color to create a coherent palette with strong contrast; the candidate follows the preferred forest/magenta direction with coordinated citrus, aqua, apricot and lilac tints, with shared semantic tokens across the site. **Agent / CLI / API onboarding stays front and center in the hero**, presented as a clean, compact setup card. Keep a visible Create in browser / Playground path alongside it. API IDs and detailed code should not overwhelm the creative flow. The web journey is choose a model → describe the result → create; normal web sign-in should not require pasting gateway/provider keys. AlleyBloom's confident hierarchy and outlines remain useful references. The user has approved the cinematic comparison-background hero layout: one pre-edited Hyperframe video, intentionally partially covered by a short headline and compact Agent / CLI / API onboarding card, with a secondary Create in browser path. No visible pause button. Move the creation form and detailed catalog below the hero; retain reduced-motion and poster/loading fallbacks. See docs/design/DECISIONS.md. The approved redesign is implemented in the release candidate; the public production catalog has not yet been updated. Use original components/assets and preserve desktop/phone parity.

SEO/AEO/GEO is a top release priority for every home, company and series page: unique useful copy and metadata, raw crawlable HTML, stable canonical identities, truthful structured data and source evidence, internal discovery links, sitemap/robots, and a public AI-readable index. These are engineering requirements, not ranking guarantees. See docs/SEO.md.

## Required initial models

Video: Seedance 2.5; Seedance 2.0 Standard/Fast/Mini; Kling 4.0; Wan 3.0 Standard/Prime; MiniMax H3 base/Highspeed/Lite/Max, with MiniMax and fal serving the same Max variant; separately identified H3 Max Turbo by fal and H3 Flex by Pika; stable Gemini Omni 1.1 Flash (Omni Flash alias); Grok Imagine Video 1.5/Lite plus the legacy editing/extension model.

Images: GPT Image 2.5 Sunburst/Flare; GPT Image 2 (2.0 alias); Nano Banana 2.1; Grok Imagine Image 2.0; Seedream 5.0 Pro; Qwen Image 2.1 base and verified derivatives/hosted offerings; Qwen Image 3.0 Pro.

Record openness and licenses per exact variant. Open weights do not establish unrestricted commercial rights. Use the confirmed shared `minimax/h3-max` identity for MiniMax H3 Max and fal H3 Max. Preserve provider naming and upstream IDs on their routes. Do not infer equivalence for Max Turbo, H3 Flex or other Pro/Turbo labels.

## Regional providers are first-class

The relationship is company → regional deployment → exact-model route, with model family/revision on the model side. Each documented region gets its own route, price, capability record, verification status and observations. Credentials are private workspace connections to public deployments; they do not create duplicate public companies.

Distinguish API endpoint region, permitted processing scope, disclosed processing locations, storage/residency commitments and measurement origin. Unknown is valid. A Frankfurt endpoint with Global inference does not promise EU-only processing. Resellers may disclose no processing region.

Wan 3.0 Standard and Prime each have documented Beijing, Singapore, Tokyo, Frankfurt, Virginia and Hong Kong offerings: 12 distinct entries. [Standard](https://www.alibabacloud.com/help/en/model-studio/wan3-0-video), [Prime](https://www.alibabacloud.com/help/en/model-studio/wan3-0-video-prime), [regional endpoints](https://www.alibabacloud.com/help/en/model-studio/regions).

Enumerate all documented regions for every supported provider/model; never blindly cross-product all provider regions with all models. Keep comparison-only and unconfigured offerings visible. Exact regional pinning constrains every attempt. Policies define allowed endpoint regions and processing scopes, and request overrides may narrow but never expand workspace permissions. Historical jobs preserve the selected route and price snapshot.

## One application core

Use TypeScript, React/Next, Fastify, PostgreSQL and S3-compatible storage. Interfaces share the same contracts and application services. Provider adapters own request translation, authentication, submission, polling, cancellation and usage extraction. Catalog records own identity, schemas, capabilities, prices, sources and evidence. Do not introduce a general user-programmable proxy or pricing-expression interpreter.

The implemented canonical registry covers all 27 exact model variants with common arguments plus typed model-specific fields in one `input` object. Model/operation schemas and `models.schema` discovery expose qualified roles, counts, limits and defaults across REST, MCP, SDK, CLI and the playground. Named owned/external asset references preserve media roles and order. Unsupported fields or combinations are rejected before reservation/submission; provider adapters must not silently drop requested arguments.

Durable jobs, attempts and money records are persisted before external work. The bootstrap uses PostgreSQL job rows with transactional claims; a queue library is an implementation option once needed, not an additional source of job truth. No Redis or Kubernetes dependency is required to self-host.

## Execution and money contracts

### Billing expansion

The [billing policy plan](BILLING-POLICY-PLAN.md) tracks the next billing milestone: verified provider cost with a proposed 5% smart-routing fee, scoped billing delegation, saved payment setup and opt-in recharge. Reuse the current PaymentStore, ledger, holds and webhooks. Preserve legacy zero-fee jobs and side-effect-free reads. Shared admission, settlement, OAuth scope and migration wiring require integration review. The product decisions in section 11 and Stripe sandbox and live qualification govern activation.

- One caller job may own several separately recorded provider attempts. Stable idempotency keys bind a workspace and request hash; changing the body under the same key is a conflict.
- A submission timeout means unknown acceptance, not confirmed failure. Never blindly submit a second billable job. Reconcile by upstream ID where available; unresolved submissions remain visible and reserved for operator reconciliation.
- Persist upstream IDs, regional deployment and pricing snapshots. Restart during polling must resume the same provider task.
- Cancellation requested, confirmed cancellation and actual refund are distinct. Upstream success and media delivery success are also distinct.
- Use integer micro-USD for ledger entries and precise rate calculations. Distinguish quote, reservation, upstream cost, platform fee, settlement and refund. Atomic workspace reservations prevent concurrent overspend. Duplicate callbacks and settlement attempts cannot double charge.
- BYOK and operator-funded calls have explicit credential and billing ownership. Optional card topups sit on the same public ledger. Self-hosting must work without a payment processor.
- Unknown-priced routes are comparison-only or explicitly BYOK until supported pricing exists. Estimates are not guaranteed ceilings. Any customer cap and operator-overrun policy must be explicit.

Optional customer prepaid credit is implemented through human-initiated Checkout, workspace-owned orders/history and exactly-once ledger credit using the shared transaction helper. Refund/dispute holds block new managed and BYOK spending while accepted jobs remain recoverable and settle. Durable order/outbound-request caps and same-order retry/cooldown rules are enforced. The hosted Stripe webhook uses a dedicated raw-byte Vercel-to-GCP relay; GCP owns signature verification and secrets. These paths remain fixture-backed until separately configured sandbox/deployment checks pass. Self-hosted operator funding remains available without Stripe. See [PAYMENTS.md](PAYMENTS.md).

## Routing and observations

Policies include pinned route, cheapest eligible, fastest supported by evidence and most reliable supported by evidence. Eligibility includes exact variant, operation, all requested parameters, regional restrictions, fidelity, access and budget. Do not silently drop references/audio or substitute variants. Preserve Omni provider interaction/session IDs and pin continuation edits to that deployment.

Publish separate provider-attempt and end-to-end job success. Split policy rejection, invalid input, technical failure, cancellation and unresolved outcomes. Report p50/p95 time to usable asset, queue/first-preview times where observable, sample counts, window, configuration cohort and measurement origin. Do not present zero observations as 100% success. Benchmark, internal and customer traffic remain distinguishable. Public metrics omit prompts, keys and identifying assets.

## Explicit Yir feature additions

1. C2PA validation and per-file verification evidence, including signer/integrity/output checks; absent evidence stays unknown. Request-level fidelity requirements filter routes using stated evidence and limitations.
2. Saved routing profiles attached to workspace/API keys: providers, deployments, processing scopes, fidelity, fallback and spending limits. Per-request overrides only narrow policy.
3. OpenAI Images/Videos compatibility endpoints as thin adapters, with a documented compatibility matrix. SDK/framework adapters are deferred; canonical HTTP/MCP examples and clear compatibility docs are the current adoption deliverable.
4. Batch quotes, 1–20 requests, reusing single-quote pricing.
5. Signed customer outbound webhooks with subscriptions, delivery IDs, retry/backoff, history and generation-completed vs billing-settled events. Upstream callbacks are a separate interface.
6. Alerts for balance, key expiry, spending and failing webhook delivery, including resolution handling.
7. Machine-readable parameter-handling notices in quotes, results and events. No silent downgrade by default.
8. Browser draft/submission recovery with a persistent idempotency key and existing job lookup; reload cannot create a second paid render.
9. Scoped account-management APIs for policies, usage, keys and event settings, sharing dashboard authorization.

Optional later modules: opt-in image stalled-attempt acceleration with explicit possible double billing; rebates/referrals/affiliate settlement; Go SDK; standalone audio/3D generation. Generated audio inside video remains in the initial scope. [Yir routing](https://yir.ai/docs/concepts/routing), [console](https://yir.ai/docs/console), [compatibility](https://yir.ai/docs/integrations/openai-compatibility), [webhooks](https://yir.ai/docs/production/webhooks).

## Interfaces and user journeys

Public: model/family/provider pages, separate regional comparison rows, exact-configuration estimates, provenance links, metric methodology and docs. Authenticated: playground/uploads, job/attempt history, workspace members, API keys, provider connections, budgets, ledger, exports and operator reconciliation.

### Company and series pages

Company pages use canonical creator paths such as `/bytedance` and `/minimax`, with a `/companies` directory. Each company page lists every catalogued series and exact variant belonging to that company. Explicit parent-brand relationships let Alibaba also list its Qwen brand without inferring ownership from serving-provider names.

Every model series has a shareable page such as `/bytedance/seedance-2.5`, `/bytedance/seedance-2.0` or `/minimax/h3`. Versioned series membership is explicit: Seedance 2.5 is separate from 2.0 Standard/Fast/Mini, and GPT Image 2.5 is separate from GPT Image 2. The series owner is distinct from variant authorship and serving provider. MiniMax owns the H3 series page, which lists six canonical variants and their separate regional provider rows. MiniMax and fal serve the shared `minimax/h3-max` variant; the former `fal/h3-max` ID remains an alias.

Company, series and variant links are discoverable from the home catalog. Variant deep links preserve the chosen variant, and a provider's Try action preserves its exact regional route in the playground. Model/variant aliases redirect to a canonical series URL; unknown companies, series or cross-series variant selections do not silently resolve to a different model.

Provider sections compare documented prices with their actual billing units, endpoint regions, inference scope, observed completion latency at P50/P75/P90/P95/P99, and technical success rate with sample evidence. Availability uptime is a different metric and is not inferred from generation success. Unknown data remains unknown. Do not fabricate token prices, audio-off rates or observation values to match a reference layout.

Each exact variant's author has an Official attribution tag. Serving rows receive Official only when their provider is explicitly listed in that model's `authorProviderIds`; author-operated regional offerings are tagged individually. ByteDance/BytePlus and Qwen/Alibaba relationships are registered explicitly, and derivatives follow their own exact author. This denotes authorship/first-party operation, independently of documented/live-verified route status or OpenGen's commercial authorization. Missing author-hosted offerings remain missing.

The website, REST company/series endpoints and MCP discovery share catalog membership selectors. Public pages render model metadata and provider listings on the server, include canonical metadata and return real 404s for unknown entries.

REST, CLI and MCP support discover → inspect → quote → upload → submit → wait/resume → retrieve → inspect route and cost. MCP keeps a small stable tool surface: catalog_search, catalog_get, quote, call, job_get, job_cancel, balance; assets and settings can be added through registered operations. No arbitrary URLs as call targets. Remote OAuth and local browser/token login are part of full v1. Ship llms.txt, skill.md and executable integration examples.

The logged-in application uses `/app#start`, `/app#activity` and `/app#team` for onboarding, generation/cost history and workspace membership. It reuses the existing account services, keeps API-key and connected-app management separate, and preserves legacy `/dashboard` hash entry points. Normal OIDC sign-in lands on Start while valid pending MCP consent retains priority. Public `/start` is the sign-in/onboarding entry. The local catalog-only preview does not imply that real identity or database configuration is present.

Future public OpenAI plugin submission is an explicit planned track. Before selecting the hosted authentication arrangement, validate the current OpenAI requirements and the product's eligibility. Prepare a limited public plugin tool profile and live reviewer evidence; generic MCP support does not establish directory approval. This track is independent of the open-source release. See [OPENAI-PLUGIN-READINESS.md](OPENAI-PLUGIN-READINESS.md).

## Milestones and acceptance

| Milestone | Deliverable                                                                  | Exit evidence                                                                                             |
| --------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1         | Original repository, updated plan, typed catalog, documented regional routes | Catalog integrity and exact regional pricing tests                                                        |
| 2         | Durable image/video execution, attempts and reservations                     | No duplicate paid work after retry/restart; real provider smoke evidence when credentials are supplied    |
| 3         | Multiple exact-model routes, saved policies, regional fallback, metrics      | Constraints enforced on every attempt; unknown performance remains unknown                                |
| 4         | Catalog/comparisons/playground/dashboard and recovery                        | Verified desktop/phone flows using real services                                                          |
| 5         | MCP, CLI, HTTP docs, protocol compatibility, batch quotes                    | Same model/deployment IDs and authorization across interfaces                                             |
| 6         | Fidelity checks, outbound events, alerts, operator money flows               | Replay-safe settlement and delivery; evidence-based output claims                                         |
| 7         | Full initial provider coverage and OSS release                               | Every advertised executable route has a dated smoke test; install, backup, restore and upgrade documented |

After the core contracts stabilize, provider adapters, UI and agent interfaces can progress in parallel. Live paid smoke tests must use an explicit bounded budget; fixture tests never consume provider credits. CI uses PostgreSQL integration tests, catalog checks, API tests, type checking and a web production build. Release review includes tenant isolation, callback signatures, bounded asset fetching, credential redaction and dependency audit.

## Owner refinement — unified input and MCP onboarding (2026-11-03)

The same exact model uses one input across all serving providers. Every generation kind uses one canonical operation schema across models, with discoverable model/route capability differences (including element roles/counts/types), shared pre-charge validation and explicit incompatibility responses. Named assets replace ambiguous positional URL/upload arrays. REST, MCP, SDK, CLI and playground share these contracts and the existing job protocol. See [UNIFIED-GENERATION-API.md](UNIFIED-GENERATION-API.md).

MCP must match treg's documented onboarding pattern: hosted connector plus OAuth consent/paying-workspace selection; local installer, browser login and agent skill; search/inspect/call with canonical schema and limits. The source candidate implements native OAuth/PKCE, consent, CLI login/status/logout, preview/apply local binding, account/key/grant UI and agent guides. Published installation distribution, configured hosted identity and actual client/version interoperability still require evidence; transport fixtures alone do not complete this release gate. See [ONBOARDING-INTEGRATION.md](ONBOARDING-INTEGRATION.md) and [AGENT-SUPPORT.md](AGENT-SUPPORT.md).

Keep the current PostgreSQL execution engine for v1. Temporal is a future orchestration option for multi-stage pipelines, not a prerequisite for consistent provider inputs. The implementation work strengthens contracts and onboarding while retaining the PostgreSQL executor.

Owner refinement: schema composition follows fal's common-arguments plus model-specific-extensions mechanism. Common does not mean universally supported. Preserve one typed input, discoverable effective capabilities and a separate broker control plane. The implemented registry derives from the exhaustive model/provider input audit in [research/canonical-inputs/README.md](research/canonical-inputs/README.md). Future defaults or provider-specific combinations must remain evidence-backed; unknown support must not be promoted into executable capability.

## Refreshed competitive audit — 2026-11-03

The [Yir and treg gap audit](COMPETITIVE-GAP-AUDIT-2026-11-03.md) separates missing/partial product behavior from implemented but unverified deployment and intentional scope choices. Work in this order: integrate and requalify the separate provider-validation branch; fix compatibility delivery semantics; prove hosted/local agent first success; distribute CLI/skill and repair one-URL onboarding; complete immutable reference intake and output checks; expose existing account/event services with key caps, profile lifecycle and usable history. Human/agent HTTP/MCP docs accompany these changes; SDK/framework distribution is deferred by the 2026-11-04 owner decision. Audio/3D expansion, trial credits and broader retry policies remain explicit later decisions. The audit adds a backlog and evidence, not completed implementation or automatic new paid-call authorization.

## fal selections and shared delivery packages — 2026-11-04

The [fal comparison and combined backlog](FAL-GAP-AUDIT-2026-11-04.md) recommends folding durable redelivery, upstream retention/access controls, queue/progress/capacity, usage evidence and private caller/project attribution into the existing Yir work. Complete Playground controls and generated raw-HTTP examples reuse canonical schemas; private output reuse follows while SDK distribution is deferred. A small private budgeted same-input comparison mode is a selected follow-up after reliable delivery, with atomic group admission and stable child jobs, not a new protocol or workflow platform. Per-model agent docs, CLI/skill distribution and backend/identity/client qualification stay with the existing onboarding chat. GPU hosting/training, general DAGs, model realtime, semantic asset search and enterprise hierarchy are deferred. These are researched backlog selections, not completed product changes or additional release gates.
