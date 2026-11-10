# Scoped price evidence review

`packages/catalog/src/maintenance/price-qualification.ts` is a pure maintenance helper. It does not quote requests, evaluate expressions, change catalog rates, enable routes, verify provider access or alter accepted job snapshots. Existing explicit provider formulas remain the pricing authority. Integration of the provider-validation branch precedes any proposed formula extension.

`qualifyPriceEvidence(evidence, target)` checks the completeness and exact scope of a review proposal. A complete result still has `manualApprovalRequired: true` and `actualChargeKnown: false`. It does not verify that a document is genuine or that referenced code/tests were reviewed and passed; reviewers must confirm the dated document bytes and SHA256, exact implementation, test evidence and approval separately. Synthetic fixtures are not source evidence or provider qualification.

Each proposal names one provider, endpoint ID, canonical model, deployment, operation, endpoint region and inference scope. Unknown location/scope is explicitly `null`; matching a null never establishes residency or another regional offering. No alias merging, regional cross-product or unit conversion occurs. This helper does not establish an immutable model weight identity.

Public list, operator contract and private BYOK tariffs have separate scope kinds and tariff bases. Contract/account scopes use a non-secret opaque `scopeRef`; never place a credential or customer identity there. A private rate cannot qualify a public target or another account. `publicPriceEvidence` returns nothing for private scopes and drops internal formula-review references from public-list projections. Public projection still requires approval of the source URL and its public applicability.

A proposal must preserve clean HTTPS source metadata, a real calendar date, content SHA256, explicit USD rate, billing unit, rounding rule and named qualified implementation with review/test references. Missing values stay unknown. Component tariffs do not qualify a complete request formula by themselves. Unknown formula, historical estimate and billing-unit header evidence remain ineligible; none is an invoice or a known actual charge.

`comparePriceEvidence` compares only complete evidence for the same exact identity/account scope, unit, rounding and implementation. A rate change can be reviewed directly; a scope/unit/rounding/formula change requires its own scoped review. There is no arithmetic or runtime promotion in the returned result.

The synthetic fixture `tests/fixtures/catalog-maintenance/prices-scoped.json` includes its synthetic source strings and matching SHA256 values. It exercises public/private scope isolation, unknowns, malformed evidence, incompatible comparisons and approval requirements without a key, private API or paid inference call. No supplied fixture value is an actual provider tariff.
