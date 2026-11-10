# Routing governance domain and integration contract

This source module adds fixture-tested routing profile operations and policy composition. It is not a claim of deployed API/UI availability or provider qualification. The integration owner registers routes and wires authoritative reservation checks.

`GovernedRoutingPolicy` extends the existing regional controls with:

- `modelIds`: allowed exact model IDs. Omitted means unrestricted; an empty list permits no model. Aliases, similarly named derivatives and global provider region lists cannot establish exact model permission.
- `modelProviderExceptions`: a bounded list of `{modelId, providerIds}` entries. An entry replaces only the global provider allowlist for that exact model. It cannot broaden deployment, endpoint/processing-region, native-fidelity, author-only or fallback restrictions. Empty provider lists deny all routes for that model.
- `authorOnly`: allow serving companies explicitly recorded in the exact model's `authorProviderIds`. This field defaults to unrestricted when absent. An empty/missing author list fails closed. Company names, family membership and a reseller's endpoint label never establish authorship.

`processingScopes` is an independent allowlist of `regional`, `mainland-china`, `international`, `global` or `undisclosed` deployment scopes. It is intersected on every fallback separately from known processing-region locations and never inferred from an endpoint. An empty scope list denies all routes.

All fields are broker routing controls outside canonical model `input`. Saved policies and snapshots remain private to a workspace. Validation bounds lists and exceptions to 128 entries, rejects unknown controls and checks exact catalog model/provider/deployment IDs. Unknown processing locations cannot satisfy a processing-region restriction.

`intersectRoutingPolicies(current, snapshot)` preserves the intersection of regional, model and per-model provider authority. A removed or widened current exception cannot widen a grant's older snapshot. `constrainRoutingPolicy(enforced, requested)` rejects explicit request expansion and inherits omitted restrictions. Disjoint constraints produce empty deny-all lists, never unrestricted defaults. These helpers do not alter caller objects.

`constrainGovernedInput(catalog, policy, input)` converts author/model/exception controls into ordinary quote filters for the selected exact model. Processing scopes also materialize into a deployment allowlist intersection so quote selection can choose an eligible route, rather than merely rejecting a forbidden selection later. Use the narrowed extended policy at final reservation, materialize it again, and validate the selected route plus every fallback with `assertGovernedRoutes`. Do not materialize once before preparation and then trust that old selection. Preserve the extended frozen policy privately for receipts/history; do not re-evaluate accepted jobs against mutable policies during polling or delivery recovery.

`RoutingPolicyStore` implements create, list, rename/update and archive. Mutations acquire the workspace lock before revalidating the administrator with the caller-supplied callback on the same connection. No provider I/O or second pool checkout occurs in the transaction; a pool size of one works. Reads require current `read`, writes current `policies:write` and unrestricted administrator authority. Keys with a per-call ceiling, monthly cap or bound policy cannot administer profiles to expand their own authority. Profile IDs are always scoped to the authenticated workspace.

Updates and archive require `expectedRevision`; stale edits return `policy_conflict` (409). Archive is terminal in this slice and does not clear bound key policy IDs. New admissions through an archived bound policy fail closed. Existing admitted snapshots stay intact. A future restore operation requires an explicit reviewed contract.

The unnumbered schema proposal is `packages/engine/schema-proposals/governance-routing.sql`; the integrator owns migration numbering and the accepted manifest. It adds `archived_at`, `updated_at` and revision 1 for existing profile rows. It does not invent historical actor attribution or modify old migrations.

## Proposed HTTP registration

The integration owner can register the following workspace-scoped operations using existing authentication, CSRF and no-store response rules:

| Operation                       | Scope            | Input                                                                                             |
| ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `GET /v1/policies`              | `read`           | optional `includeArchived`                                                                        |
| `POST /v1/policies`             | `policies:write` | `name`, `policy`, optional `maxCostMicros`                                                        |
| `PATCH /v1/policies/:id`        | `policies:write` | `expectedRevision`, optional `name`, `policy`, `maxCostMicros` (null clears only per-job ceiling) |
| `POST /v1/policies/:id/archive` | `policies:write` | `expectedRevision`                                                                                |

No public sharing, visibility control, SDK, provider-key read or paid inference is introduced. Saved policy maxCostMicros is a per-generation customer ceiling; monthly managed key caps are the separate key-budget domain. Archiving is not cancellation and never releases already accepted generation holds.

## Manual testing plan

1. Create a profile for an exact model with EU endpoint/processing restrictions; rename it and lower its per-call ceiling. A stale revision edit must conflict.
2. Bind an API key, add an exact-model provider exception, and enable author-only. A reseller fallback or a route with unknown/global processing must fail before reserve. Check every fallback, including a similarly named derivative.
3. Start input preparation, then narrow or archive its bound profile. The final reservation must reject or use only the newly narrowed authority. The existing accepted job keeps its frozen route/policy and settlement.
4. Archive the profile. Existing key bindings must remain visible and admission must fail closed; another workspace must neither list nor update it.
5. Revoke/demote the acting administrator while an edit waits for the workspace lock. Revalidation must deny the write. Repeat with a pool size of one.

The module tests include deterministic pure policy cases, PostgreSQL-wire lifecycle/tenant/revocation fixtures and native-PostgreSQL concurrency cases when enabled. PGlite evidence does not establish multi-connection locking behavior; the combined native PostgreSQL qualification belongs to integration.
