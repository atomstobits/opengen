# Managed generation fee integration through migration 022

Reviewed 2026-11-05 against the recovered billing tree `fb216cc67485cda9f9d7da2faa400b6d8b310121`. Migration 022 adds nullable admission, settlement and private cost evidence to `mr_jobs`. The server and worker entry points have no fee policy configuration. The generation fee fixture requires an injected adapter and a versioned `fixture` policy.

## Quote and admission

A fee-aware request supplies `feeAcceptance` with the disclosed policy ID and version. HTTP and MCP quotes use the engine's fee calculation for that acceptance. Quote candidates carry the provider estimate, nominal fee estimate and customer estimate. The reservation is the largest gross estimate in the selected candidate set. Route selection uses the gross ceiling and admission recomputes the quote with current authority under the workspace lock. Request hashing includes the acceptance and a replay returns the original job and terms.

Omitted acceptance follows the existing quote, routing and settlement behavior. Unpinned BYOK can use an owned connection and an exact route can carry the existing fallback option. Explicit fee acceptance currently supports managed requests only. The fixture classifier treats explicit route or singleton constraints as direct with zero applied basis points. It rejects a pinned request with fallback enabled. The 500 basis point rate, upward rounding and provider-first allocation are fixture choices awaiting the commercial decisions in section 11 of the billing plan.

## Evidence and settlement

The fixture checks provider-reported USD evidence against the locked job, exact attempt, provider, route, deployment, original task and frozen credential identity. Its operator route requires an explicit `operator-audited` basis and records the reconciliation reference in the same transaction. Qualified account tariffs and trustworthy production evidence producers are future integration work. Immediate results with no provable original task retain their hold.

A terminal observation without qualified cost leaves gross wallet and key-month exposure reserved. A recoverable billing poll keeps its original task and lease boundary. Generation status and delivery continue independently. A local cancellation or deadline can release the reservation when the exact dispatch closure, zero attempts and absence of a prior submit intent prove that dispatch never started. A provider rejection preserves the hold on fee jobs pending evidence. Legacy fallback retains its existing behavior.

One transaction records the provider debit, nominal and collected fee, waiver, operator overrun, customer total, release, original key-month settlement and one settlement event. Public customer-facing shapes carry the workspace-private monetary summary. Supplier evidence, task identity and credential identity remain in private storage.

## Verification and next integration boundary

The isolated PostgreSQL 17.11 run passed 85 tests across fee, engine, BYOK ownership, dispatch, routing and schema suites. The fee cases exercise gross quote and reservation parity, gross cap rejection, pending bare cost, payer mismatch, original-task poll settlement, audited reconciliation, ceiling waiver and overrun, replay, queued cancellation and legacy compatibility. TypeScript, catalog validation, generated onboarding and production web build passed.

Migration slots 023–025 remain reserved for authority/policy, customer/mandate and recharge. In the recovery draft, `policy-schema.sql` stores `processor_environment_id` and the policy store joins `mr_billing_processor_environments`. The customer/setup/mandate SQL still keys ownership using `livemode`. The recharge attempt table and legacy manual order table each bind a PaymentIntent independently. Their credit references use `stripe-recharge:<attempt>` and `stripe-topup:<order>`. A shared processor namespace and one cross-path PaymentIntent owner are required before registering those migrations or mounting the funding hooks. Test the same PaymentIntent across manual, recharge and invoice observations and require one owner, one credit and one risk route.

Commercial approval, provider cost qualification, Stripe sandbox and live activation remain separate gates.
