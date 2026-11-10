# Read-only catalog drift review

C10 adds local evidence import and review reports. It does not edit the catalog, enable an adapter, change accepted job snapshots, grant account access or establish live provider support. The supplied upstream artifacts are **synthetic fixtures**, including every rate, bound, region and retirement date. They assert no provider fact.

Run from the repository root with Node 22 and this checkout's installed dependencies:

```sh
node --import tsx scripts/catalog-drift.ts \
  tests/fixtures/catalog-maintenance/baseline.json \
  tests/fixtures/catalog-maintenance/candidate.json
```

The command writes JSON to stdout. Exit `0` means no observed change, `2` means review required and `1` means invalid/unreadable evidence or usage. Redirect stdout to a local review file if desired. There is no fetch, apply, accept, catalog-write or route-enablement option. Identical manifests return `0`; a source hash/date change is itself reviewable even when extracted facts stay equal.

## Evidence format

The version-1 JSON manifest contains `evidenceKind` (`synthetic` or `documented`), `scope` and `entries`. See [the baseline fixture](../../tests/fixtures/catalog-maintenance/baseline.json) for a complete example.

- `scope` lists each exact `providerId`, `endpointId`, canonical `modelId` and `deploymentId`. Baseline and candidate must declare the same scope and evidence kind; synthetic evidence cannot be promoted by changing its label. Empty, wildcard, duplicate or over-limit scopes fail. Entries may be absent to report newly observed or missing endpoints, but cannot appear outside the scope. Extending the review scope requires a separate explicit scope decision and matching manifests.
- Each entry has the same four-part `identity`; a `source` with credential-free HTTPS `url`, calendar `checkedAt` date, local relative `path` and lowercase SHA-256 of the **exact raw artifact bytes**; and `inputSchemaPointer`, a local JSON pointer into that JSON artifact, or `null` when unknown.
- `facts` contains manually extracted `capabilities`, `retirement`, `region` and `tariff`. Required unknowns use `null`. These facts are assertions for human review, not independently verified source extraction. The report retains the complete manifest byte hash and a canonical facts hash in addition to source hash/date/URL, binding those assertions to the review.
- `retirement` has nullable `deprecated`, `retirementAt` (ISO calendar date) and `replacementEndpointId`. Missing endpoint evidence means only missing observation. A replacement ID is a disclosure; it never establishes equivalent weights/variant identity or reroutes execution.
- `region` keeps nullable `endpointRegion`, `inferenceScope` and `residency` separate. No provider-global region list is expanded into model routes.
- A nullable `tariff` has `currency`, decimal-text `rate`, `unit`, `rounding`, `formulaStatus`, `accountScope` and `accountRef`. `formulaStatus` may be `unknown`, `unqualified`, `qualified` or null; a label in a drift manifest grants no pricing qualification. Public list pricing requires a null account reference; operator-contract/private-BYOK pricing requires an opaque reference and private handling. Do not put customer names, key IDs, credentials or account payloads in these files.

Artifacts are at most 256 KiB each, with at most 32 explicit endpoint observations, 8 MiB total artifact bytes and a 128 KiB manifest. JSON has depth, node and string limits. Files must be regular local files within the evidence directory after symlink resolution. Absolute paths and escaping paths fail; sources are never fetched. Source URLs permit only one public `endpoint_id` query argument, whose value must match the explicit endpoint identity. Credentials, signed media URLs and provider-account exports do not belong in a source-safe manifest. Larger upstream documents need a bounded separately reviewed facts artifact with honest provenance; do not silently truncate them and call the result the raw upstream document.

For OpenAPI, select the complete relevant schema subtree, including the local reference closure (for example `/components/schemas`), or a separately reviewed normalized schema artifact. The importer does not dereference `$ref`, execute JSON Schema or follow remote links. Changes to omitted or unresolved facts are not semantically detected; any changed raw source hash still appears for review. Schema array ordering is preserved conservatively.

## Report and review

Reports include before/after source evidence and facts hashes for every scoped identity, changed JSON-pointer paths, and added/removed/changed presence flags. Explicit null and a missing field remain distinguishable. Categories cover fields/schema, defaults, numeric/string/item bounds, deprecation, capabilities, endpoint/processing/residency facts, tariff, unit, rounding and account scope. A newly added object can appear as one subtree change; inspect its contents.

Treat every delta as a proposal. The reviewer confirms the primary source and scope, identifies conflicting evidence, and reviews any intended canonical schema, adapter and exact-request quote change. Preserve `fal/h3-max` as the existing alias of `minimax/h3-max`, keep H3 Max Turbo separate, and preserve explicit Official author metadata. A stable endpoint ID does not prove immutable weights. Never derive regional availability, account entitlement or a live verification claim from discovery metadata.

Integrate the existing provider-validation pricing work first. Subsequent arithmetic changes need a narrow endpoint/configuration implementation, source-backed unit/rounding rules and meaningful canonical/adapter/quote tests. This tooling supplies no general formula interpreter and changes no rates. [Price-evidence review fixtures](PRICE-EVIDENCE-REVIEW.md) separately check proposal completeness and prevent public/operator/private scope mixing; neither module is imported by the runtime catalog entry point.

Review and record a focused commit before changing accepted catalog data. Previously accepted jobs retain their frozen route/tariff/input snapshots. Shared catalog/pricing files remain assigned by the integration owner; onboarding owns per-model agent recipes. No schema migration or runtime registry hook is required for C10.

## Primary-source checks

Checked 2026-11-04 using public documentation only. fal documents its historical estimate method as based on past call pricing, and its unit-price method as expected units multiplied by the pricing service's rate; account-specific discounts may apply. This supports keeping historical estimates and private account prices apart from public list tariffs. No authenticated estimate request was made. [fal estimate documentation](https://fal.ai/docs/platform-apis/v1/models/pricing/estimate).

fal documents `X-Fal-Billable-Units` as charged units and points to separate pricing for mapping those units to cost. The header alone does not establish the final USD charge or an invoice. [fal platform headers](https://fal.ai/docs/documentation/model-apis/common-parameters). Public documentation establishes these interface facts; it does not qualify an exact OpenGen request, region, account or supplier price.
