# Actionable agent discovery

Reviewed 2026-11-04. Discovery and examples describe the source-backed catalog and canonical schemas. They do not establish live credentials, provider access or a working hosted generation service.

`GET /v1/catalog/search` accepts `q` (optional text), `modality`, `familyId`, `providerId`, `region` (endpoint region), `operation` and `inputRole`. MCP `catalog_search` uses `query` instead of `q` with the same filter names. Registered `catalog.search` uses the HTTP names. SDK `search(query, options, filters)` and CLI flags use the same selector:

```sh
opengen catalog search --modality video --provider alibaba --region eu-central-1 \
  --operation image-to-video --input-role firstFrame
```

Filters combine. Operation and role must belong to the same effective model profile, and provider/endpoint-region constraints must match a route serving that operation. Searching without provider/region constraints retains comparison-only models without a serving route. Text matches registered operations and argument/role names as well as exact IDs, names, creators and aliases. It is deterministic catalog search, not an external semantic search service. Endpoint location does not imply inference location or residency.

Input roles are `firstFrame`, `lastFrame`, `keyframes`, `sourceVideo`, `references.image`, `references.video`, `references.audio`, `references.document`, `mask`, `elements` and `targetAudio`. A role match describes schema support; the exact route and input still need a quote.

Inspect an exact model and operation with `models.schema`:

```json
{
  "operationId": "models.schema",
  "input": { "modelId": "bytedance/seedance-2.5", "operation": "image-to-video" }
}
```

The profile retains common/model-specific arguments, capabilities, effective `inputSchema`, sources and notices. Its `examples` adds:

- `request`: a canonical request derived from schema defaults, required fields and a valid media-role branch. Managed payer selection is explicit.
- `quote`: the registered `quotes.single` operation envelope for that request. Quoting spends no credit.
- `cli`: the quote command after saving the edited request privately as `request.json`.
- `placeholders`: owned asset paths that must be replaced after upload prepare/PUT/complete.
- `notices`: template, route, budget and payer requirements.

All 76 current model-operation templates pass the published argument schema and canonical parser in local tests. Provider-specific limits may narrow them; no template is an authorized submission or a qualified price. Media-dependent prices may remain unknown. There are no fabricated remote media URLs in these templates.

MCP `catalog_get` returns a single schema copy per model profile. Exact-model responses retain profiles under `model.generationProfiles` and include only deployments referenced by that model's routes. Where a public series ID is also an exact model ID, the existing series projection takes precedence: inspect its `models[].generationProfiles`; a duplicate top-level model/schema is omitted. Series and company projections retain each constituent model's own profile. Route inspection includes only that route's operations. Tools advertise read-only versus mutating hints; the generic `call` tool remains conservatively mutating because its allowlist includes paid generation and account changes.

These local REST/MCP/SDK/fallback tests use fixtures. A protocol SDK test client is not a named hosted assistant or a real coding-agent qualification result.
