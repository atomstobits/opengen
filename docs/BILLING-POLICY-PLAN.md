# OpenGen billing policy and delegated recharge plan

Prepared **2026-11-04** for shared integration review against read-only source baseline `1ce8dd6`, with ongoing integration changes. This document changes no application code, Git state, deployed configuration or payment state.

## 1. Confirmed user direction and proposed design

The user chose **verified provider cost**, with a proposed initial **5% fee when smart routing is used**. Do not substitute a quote for verified cost. The user also asked to follow treg's delegated payment-policy model and requested a detailed plan routed to an appropriate implementation session.

The scope below separates confirmed commercial direction from proposed implementation defaults. The main owner should resolve the few product choices in section 11 before enabling real charges, while independent implementation and fixture work can proceed.

- Preserve prepaid USD workspace credit, the existing integer ledger, stable generation idempotency, exactly-once credit/settlement, original-job recovery and explicit managed/BYOK ownership.
- Implement a versioned smart-routing fee and display provider cost, fee and total separately. A verified USD1.00 provider cost at5% has USD0.05 fee and USD1.05 total.
- Support explicitly delegated agent billing-policy management through a narrow capability. Do not grant general workspace administration just to manage recharge settings.
- Add optional automatic recharge under a stored payment mandate and workspace policy. Initial activation is opt-in; routine authorized execution does not require a new human click for every recharge.
- Keep all generations, receipts, funding history and payment configuration private to authorized identities. Keep Stripe/provider keys server-side. No raw card data enters OpenGen.
- SDK distribution/new SDKs/framework adapters remain deferred. Publish useful HTTP/MCP schemas, task guides and raw-request examples instead.
- Keep the independent OpenGen Apache-2.0 publication boundary: application-side billing/auth code and safe self-host setup are public-source deliverables; actual keys, customer data and sensitive operational settings are private. Do not copy treg code or its extra license restrictions.

## 2. Existing implementation to reuse

OpenGen already has one-time Stripe Checkout, local orders before external requests, immutable Stripe retry identity, raw-byte signature verification, delayed success/failure, exact once-only workspace credit, billing holds, fixed customer/installation request quotas, cooldown, private billing UI and a Vercel-to-GCP webhook relay. Generation admission already reserves money and managed key-month exposure, then settles/releases under database locks.

Current code gaps relevant to this task:

- `apps/server/src/payments.ts` explicitly rejects bearer/OAuth payment authority and accepts read-scoped customer browser members. It has no separate funding-history/billing-admin capability.
- `packages/contracts/src/index.ts` has no `billing:read` or `billing:manage` scopes.
- Generation settlement currently receives provider cost as customer charge; there is no explicit smart-routing fee snapshot or line item.
- No automatic recharge, stored workspace Stripe Customer/payment-method setup, Customer Portal, explicit invoice creation or paginated payment-document history.
- Current payment validation requires the original face-value USD subtotal/total. Promotions/tax changes cannot be enabled as a simple Checkout flag without changing the validated entitlement contract.

The ledger and PaymentStore should be extended, not replaced with a second billing platform or a general pricing-expression engine.

## 3. B0 — Contract and ownership checkpoint

Assign a billing owner and one core integration reviewer before editing shared files. Freeze additive types/examples for:

1. Routing service classification and immutable fee policy/version.
2. Estimated versus verified provider cost, nominal fee, collected fee, customer total, waived fee and operator overrun.
3. Billing read/manage capabilities, delegated limits and authoritative actor audit.
4. Workspace Stripe customer/payment-method reference, mandate, recharge policy/version and durable recharge attempt.
5. Payment history/status/error responses and the distinction between read-only operations and operations that can lead to charging a card.

The main integration owner allocates contiguous forward migrations after inspecting the current candidate. Do not assume the next migration number; earlier work already uses013 and multiple core migrations. Do not edit old SQL or independently overwrite the loader, KeyScope enum, engine admission/settlement, OAuth projection or shared registries.

Legacy jobs retain a zero/legacy fee policy. Existing API keys/grants do not silently receive billing privileges. Existing payment orders retain their exact Stripe request definition, idempotency key and safe recovery deadline.

## 4. B1 — Verified cost and 5% smart-routing fee

### Fee eligibility and evidence

- Define smart routing as the selected OpenGen provider/deployment selection/fallback service for an exact model. Merely choosing a model name does not mean the caller pinned a provider.
- Classify the service at quote/admission from the actual routing request and effective workspace policy. Explicit provider/deployment pinning without smart routing has no smart-routing fee. Contradictory pin/fallback selections must be resolved explicitly, not exploited to evade or introduce a fee.
- Disclose the selected service and fee before billable submission; preserve it on idempotent replay. No retrospective fee on already accepted jobs, no fee on polling/redelivery/retrieval, and no fee change caused by an operator configuration update after admission.
- Verified cost means a reviewed supported basis: provider-reported billed currency/amount, complete actual usage multiplied by the correct qualified account tariff, or audited operator reconciliation evidence. Label the basis; an estimate, historical average or incomplete public price is not verified actual cost.
- Unknown cost remains pending with held exposure and a visible review state. Add a review deadline/queue and customer guidance. Never automatically treat an old timeout as proof of non-acceptance or refundability. An explicit operator decision may absorb unresolved liability and release customer exposure, but must record that decision rather than fabricate a zero upstream bill.

### Money behavior

- Use integer basis points (`500` for5%) and exact overflow-checked integer arithmetic. Proposed rounding: upward to one microUSD, identically at quote/reservation/settlement, clearly documented. Zero verified cost gives zero fee.
- Quote and reserve the **gross customer estimate**, including routing fee. Apply request/key/workspace budgets to that gross amount. Keep provider cost and fee separate from the available/reserved balance accounting.
- On verified settlement, compute the nominal fee once from the frozen policy. Preserve the accepted customer ceiling. If verified cost plus nominal fee exceeds it, use an explicit operator-overrun/fee-waiver rule, with the actual upstream cost still visible; never silently overcharge or relabel the charge as a full5% if part was waived.
- Commit customer debit, fee line items, key-month exposure, release and settlement event in one replay-safe transaction. A duplicate webhook/poll/operator result cannot collect the fee twice.
- Record provider and fee amounts per job with attempt evidence. Existing safe fallback normally follows unbilled rejection; any future multiple-billed-attempt pricing needs explicit whole-job policy. Do not compound a fee once per attempt and again on the job.
- For managed calls, debit base plus fee from OpenGen credit. For BYOK, the provider bills the customer directly: any OpenGen smart-routing fee would be a **fee-only** OpenGen debit, not a second debit of provider cost. Keep BYOK smart-fee execution gated until cost verification/collection and the chosen policy are qualified; direct BYOK preserves the existing zero managed debit.

**Acceptance:** quote/reserve/settle parity; 5% examples; tiny/zero values and overflow boundaries; fee policy updates; direct versus smart paths; fallback/replay/recovery; provider-cost unknown; actual overrun; delayed settlement across months; legacy jobs; managed/BYOK separation; no financial mutation on read/quote.

## 5. B2 — Billing capabilities and agent delegation

Proposed permissions:

- Existing ordinary generation/read credentials may read the limited balance needed to spend.
- `billing:read`: private funding history, payment documents and billing configuration allowed by the workspace.
- `billing:manage`: explicitly delegated policy changes, including enable/disable and threshold/amount/monthly recharge cap/frequency, within its owner-set limits.
- Initial payment mandate/card setup and enlargement of the delegation ceiling use the workspace owner/admin's authorized setup flow. This is a proposed guardrail; it is narrower than giving an agent unrestricted admin membership as treg permits.

Owners/admins explicitly delegate billing capability. Do not add it to every default key or OAuth scope merely by extending a global enum. A generation agent cannot grant itself billing access or mint a more powerful child key. Carry stable key/member/grant/client identity through every billing mutation and revalidate current authority/workspace/limits at the transaction boundary.

Expose allowlisted native HTTP/MCP operations for policy get/update and recharge status, with accurate scopes, billable-effect descriptions and idempotency. Do not expose an unrestricted card-charge tool. A policy update that enables charging is described as having financial effects; GET balance/status/schema/quote remain side-effect free. Keep any separately reviewed public plugin profile independent.

Keep browser Origin/CSRF protections for cookie requests and proper scoped bearer authorization for agents. Browser-only authentication is no longer the universal rule for policy management. Preserve authenticated workspace selection and reject cross-workspace changes.

Audit actor, before/after policy version, relevant limits and consent reference without tokens or raw provider/payment payloads. Revoking an agent stops future edits. Existing workspace recharge executes under the current owner-approved mandate/policy; policy disable/mandate revocation prevents new attempts, while already accepted payments still reconcile.

**Acceptance:** ordinary agent denied; delegated agent allowed within bounds; ceiling escalation denied; user/key/grant removal and scope reduction races; OAuth refresh/rotation retain identity; workspace mismatch; browser CSRF; concurrent stale-policy updates (optimistic version check); accurate MCP metadata; no privilege leakage from default scope lists.

## 6. B3 — Stripe Customer, setup, portal and documents

- Persist one correctly owned Stripe Customer per workspace and environment with replay-safe creation/recovery. Never bind an arbitrary customer/session merely from request metadata.
- Add Stripe-hosted payment-method setup/off-session capability through reviewed SetupIntent/Checkout flows. Store opaque Stripe references only. Record actual setup completion and the human-approved mandate/policy terms; an agent-supplied `consent:true` alone does not manufacture a new payment mandate.
- Add admin/delegated-authority-gated Customer Portal links and explicit invoice creation for manual top-ups as selected. Persist invoice/payment references and safe document links, plus paginated/filterable history. Keep receipts, invoices and wallet entries distinct.
- Preserve current fixed USD credit entitlement and dynamic payment methods. Do not enable discounts, currency conversion, automatic tax or bonus credit incidentally. Customer billing identity/document support is not a claim of tax compliance; merchant/tax configuration remains an explicit operating decision.
- Pin environment/customer/order/payment identity and API version consistently. Existing uncertain orders keep their original request shape and safe retry window; a deployment cannot silently add new parameters to an old idempotent request.

**Acceptance:** wrong workspace/customer/environment denied; repeated customer/setup initiation; setup timeout/abandon/late webhook; card replacement; existing uncertain order compatibility; invoice versus receipt links; funding-history permissions; no redirect-driven credit; no raw card/secret data in source/UI/logs.

## 7. B4 — Durable automatic recharge

Default disabled until an authorized policy and valid mandate/payment-method setup exist. Policy contains threshold, recharge amount, maximum automatic card reloads per month, per-attempt/frequency limits, cooldown, failure threshold and version. Existing manual amount constraints remain enforced unless explicitly revised. These are **card-funding limits**, separate from generation key spending caps; top-ups never reset generation spend.

Use a bounded worker/event-driven check after committed balance changes or periodic policy evaluation. Do not copy treg's balance-read trigger into our read-only API/MCP surface: reading balance or requesting a quote must not itself dispatch a card charge.

For each recharge:

1. Lock/revalidate current policy, mandate, available balance, risk hold and automatic monthly exposure. Count succeeded and pending/uncertain automatic charges against the funding limit. Admit at most one relevant in-flight recharge per workspace.
2. Persist a stable attempt ID, amount, policy snapshot, external idempotency identity and pending exposure **before** Stripe I/O. Commit before the external call; no database connection/row lock remains held over network work.
3. Use the saved method under that authorization. Preserve the original external request/object after timeout or unknown acceptance; never rotate identities to guess an outcome or add another charge. Reconcile past Stripe idempotency windows using authoritative object evidence/operator handling.
4. Credit exactly once after authoritative paid confirmation through the existing shared transactional primitive. Prefer the existing verified webhook fulfillment path initially; any direct-response fulfillment requires identical validation and dedupe, not a second money path. Invoices alone must not also credit the same payment.
5. Handle insufficient funds, authentication-required, method removal, declined payment, delayed success, lost response, duplicate/out-of-order webhooks and policy disable races explicitly. Stop new automatic attempts after configured failure limits or unresolved external payment. Provide an authenticated hosted recovery action where needed, not an uncontrolled retry loop.

New manual/automatic reloads obey billing risk holds. Existing accepted charges may still complete and must reconcile; turning the feature off cannot rewrite external reality or erase ledger history. Alerts go only to authorized verified billing recipients, with no private generation content.

**Acceptance:** two workers at one threshold create one charge; concurrent manual refill; reserve/low-balance events; duplicate trigger; monthly boundary plus unknown attempts; server crash before/after Stripe response; delayed/duplicate paid event; mandate/policy revocation; required authentication; cap reduction; charge failure; no double credit and no additional generation call. Fixture tests first; native PostgreSQL proves cross-connection races.

## 8. B5 — Billing UI, agent docs and reconciliation operations

- Show available/reserved/settled amounts and provider-cost/fee line items. Separate generation spending limits from automatic reload limits.
- Provide private billing history, invoices/portal, recharge setup/status, explicit enabled/disabled/requires-setup/requires-authentication/review states and delegated policy controls. Ordinary members see only permitted wallet information.
- Explain unknown cost and payment outcomes with existing job/order/attempt IDs and safe next actions. Never instruct a new paid submit/charge to recover an unknown existing one.
- Add an operator queue for unmatched/rejected webhooks, uncertain checkout/recharge attempts, unresolved provider costs and refund/dispute holds, with evidence/reference/audited resolution. Reuse existing ledger/outbox/alerts; do not auto-clear risk from a timer.
- Document HTTP/MCP policy-management permission, examples of permitted/forbidden delegated changes, quote service selection, fee calculation and rounding, gross spend, BYOK limitations, available credit versus card charging, receipt versus invoice and authorization revocation behavior.
- Validate examples against actual schemas/handlers without SDK installation. State configuration and live verification boundaries honestly. New billing code belongs in the open-source application; runtime keys and private policies/data do not.

## 9. Parallel implementation and merge order

The main thread should first check active ownership and choose whether to resume the existing payments session or create a dedicated billing workstream. This side conversation creates no sessions and interacts with no sub-agents.

| Package / owner                    | Can start in parallel                                                                                | Waits for                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Billing integration owner / B0** | Inspect current core, allocate migration slots and freeze contracts/policy examples                  | Owns shared merge/rollout sequence; coordinates core integrator and onboarding.                                |
| **Fee/verified-cost worker / B1**  | Pure integer fee logic, quote/receipt fixtures, legacy/overrun cases and supported cost-basis review | B0 eligibility/settlement fields before core admission/ledger wiring.                                          |
| **Billing authority worker / B2**  | Capability/delegation tests, policy validators, safe endpoint/MCP schema proposals                   | B0; shared auth/key/OAuth changes reviewed by core owner.                                                      |
| **Stripe journey worker / B3**     | Injectable customer/setup/portal/invoice transport and synthetic event cases                         | B2 roles, customer ownership and unchanged legacy order contract.                                              |
| **Recharge engine worker / B4**    | Durable state machine, duplicate/crash/cap/month-boundary tests against fake transport               | B0 policy schema, B2 authority, B3 mandate/payment references and approved billing primitive.                  |
| **UI/docs/operations worker / B5** | Typed UI mocks, docs examples, reconciliation views and feature-specific notifications               | B1–B4 stable contracts; shared components/generators reused from existing owners.                              |
| **Independent QA**                 | Targeted money/tenant/privacy/example tests and upgrade fixtures                                     | Recheck actual final committed candidate after integration; preflight snapshots are not release qualification. |

One writer integrates `engine/index.ts`, KeyScope/auth projection, numbered migrations/loader, server operation/OpenAPI/MCP/relay registries and the root lockfile. Workers own narrow modules/tests and separate shared-wiring handoffs. Do not destabilize the current candidate by merging incomplete payment behavior merely to increase parallelism.

**Order:** B0 → fee/authority checkpoint → customer/setup and recharge integration → private UI/docs/operations → exact-candidate qualification → separately authorized sandbox/managed activation. Existing non-payment core work continues independently. No new pricing DSL, event platform, SDK or unnecessary marketplace payout system.

## 10. Verification and activation gates

- Native PostgreSQL: admission/fee/cap consistency, authority races, stable retry identities, duplicate paid events, same-workspace concurrent recharge, original UTC buckets and no nested pool deadlocks.
- Migration/rollback: populated old balances/jobs/orders/holds/grants upgrade without new fees or automatic recharge; legacy order requests immutable; restore and code rollback preserve accepted work and financial history.
- Contract/privacy: browser/API/MCP permissions, no automatic scope grants, safe field-level errors/actions, private funding/documents, no secret/card/customer data in public telemetry/examples/artifacts.
- Money: estimate versus verified basis, provider cost/fee/total equality, rounding/overflow, customer ceilings, explicit waivers/overruns, managed versus BYOK, pending/uncertain funding counted, no top-up reset of generation caps.
- Stripe sandbox: current pinned SDK/API and restricted-key permissions, actual hosted setup/Checkout, signed raw-byte Vercel→GCP webhook delivery, delayed outcomes, replay/recovery, failure/authentication and document/portal behavior. Use a dedicated sandbox; never infer this from mocks.
- Live enablement: verified merchant/payment configuration, customer terms/fees/mandate, monitoring and operator refund/dispute policy, private secrets and a reviewed rollout. No real customer charge or new provider-spend allowance is authorized merely by this plan. The existing USD50 provider-test cap is not a Stripe payment budget.

## 11. Product choices to close before real charging

Main should make these explicit without blocking unrelated implementation:

1. Exact smart-routing classification/default for new and legacy clients; no undisclosed fee or retrospective fee.
2. Routing fee for provider-billed failures, cancellation, partial/unrecoverable delivery and multiple billable attempts. Do not invent eligibility from the upstream success flag alone.
3. BYOK smart-routing fee collection and supported cost-verification basis; direct BYOK remains unchanged until chosen.
4. Operator overrun/waived-fee allocation under an accepted customer cap, and a visible deadline/handling policy for unresolved holds.
5. Whether billing agents may change settings up to a human-owned delegation ceiling; the proposed design permits this without broad workspace-admin authority or an arbitrary card-charge API.

Promotional credit lots, coupons/bonuses/referrals, general subscriptions/paid SSO, credit expiry and marketplace payouts remain separate optional business scope. Adding a promotion requires explicit entitlement/ledger semantics, not only `allow_promotion_codes`.

## Public reference evidence

- treg role-based billing API and recharge fields: https://github.com/superdesigndev/treg/blob/main/src/treg/routers/billing.py
- Agent/CLI token versus browser membership resolution: https://github.com/superdesigndev/treg/blob/main/src/treg/domain/identity/access.py
- Owner-created admin agents: https://github.com/superdesigndev/treg/blob/main/src/treg/routers/orgs.py
- Stripe/customer/mandate/recharge/portal/invoice implementation: https://github.com/superdesigndev/treg/blob/main/src/treg/application/billing.py
- Integer ledger, configurable markup, credit blocks and stale-hold behavior: https://github.com/superdesigndev/treg/blob/main/src/treg/domain/money/__init__.py
- Public markup default is0.0, not evidence of the hosted rate: https://github.com/superdesigndev/treg/blob/main/src/treg/config.py

These references establish public code behavior, not hosted production settings or live acceptance. treg's missing-cost reservation settlement is not the selected OpenGen verified-cost policy. Reference product patterns only; no treg implementation was copied.
