# C5 integration handoff

This feature branch contains standalone governance domains and a separate shared
wiring commit for review. It is a fixture-verified integration candidate, not a
migration-qualified or deployed service. The integration owner controls the
numbered migration, production activation, registries, relay allowlists, shell
mounting and combined qualification.

## Required rollout and shared seams

Combine the three unnumbered proposals in `packages/engine/schema-proposals/`:
`governance-authority.sql`, `governance-caps.sql`, `governance-routing.sql`.
Slot016 is reserved in the coordination migration ledger; this branch adds no
numbered SQL or migration-loader entry. Apply the schema before activating its
new auth/admission reads. Old migrations and old attribution are unchanged.
Legacy `attribution`/`effective_policy` remain NULL. Cutover timestamps make key
coverage explicit; old unattributed spending is never reconstructed as zero.

The shared wiring commit adds:

- Principal projection of stable key/version, member, grant/client/resource and
  authority expiry. External verified JWTs have an explicit external-authority
  marker and expiry; they cannot be confused with a native grant missing IDs.
  Native access tokens retain their expiry and native grants retain their source.
- HTTP native and compatibility `submit` options pass the server principal. MCP
  `media.generate` injects the same authenticated HTTP handler. Caller actor IDs
  are rejected. Quote policy helpers materialize author/model/provider/scope
  restrictions into ordinary route eligibility filters.
- Final transaction revalidation after input preparation, all fallback checks,
  frozen effective policy/attribution, key and workspace reserve together, and
  exactly-once settlement in the admission month. Direct trusted internal submits
  without a principal remain explicitly unknown; public adapters must always pass
  their authenticated principal. They must never synthesize a principal from JSON.
- Bounded private metadata at the broker envelope, outside `input`; metadata is
  hashed for idempotency and stored separately. It is stripped before preparation,
  worker/provider input and all authority decisions. Replay retains the original
  actor and metadata. Changed metadata conflicts under the same idempotency key.
- Existing key creation/revocation and policy creation use fresh transactional
  governance authority. Source-key OAuth consent revalidates the actor/version
  under its workspace lock, so a pre-rotation request cannot mint a fresh grant.
  Capped credentials cannot administer governance or mint uncapped child keys.

Do not apply this shared commit without reviewing conflicts with newer onboarding,
private delivery, assets, capacity and history hooks. In particular preserve the
integrated customer projection, storage admission guard and durable preparation
identity. Add `clientId: string|null` to the shared attribution contract and carry
it through private history; do not infer it for legacy jobs. No identity metadata
is a provider model argument or public analytics field.

## Governance handlers and settings mount

`apps/server/src/governance.ts` supplies handlers but is deliberately not mounted
in the shared app in this feature branch. After account registration, register it
once using the existing authenticator and these domain objects:

```ts
await registerGovernance(app, {
  authenticate,
  keys: new AccountGovernanceStore(engine.accounts.pool),
  policies: new RoutingPolicyStore(
    engine.accounts.pool,
    engine.catalog,
    revalidateGovernanceAuthority,
  ),
});
```

Existing `POST /v1/keys`, `DELETE /v1/keys/:id` and `POST /v1/policies`
authority changes are in the shared commit. New handlers require these additional
explicit operation/OpenAPI/MCP and browser relay entries:

| Suggested operation | HTTP                          | Body                                                              |
| ------------------- | ----------------------------- | ----------------------------------------------------------------- |
| keys.governance     | GET /v1/governance/keys       | none; keys:write                                                  |
| keys.update         | PATCH /v1/keys/:id            | name?, monthlyCapMicros?: integer or null                         |
| keys.rotate         | POST /v1/keys/:id/rotate      | expectedSecretVersion: positive integer                           |
| policies.update     | PATCH /v1/policies/:id        | expectedRevision, name?, policy?, maxCostMicros?: integer or null |
| policies.archive    | POST /v1/policies/:id/archive | expectedRevision                                                  |

The first three require keys:write; the last two require policies:write and
unrestricted current administration authority. Rotation returns only after commit
and sets no-store. Do not log or persist its response token. Unknown-response retry
with the same expected version is a conflict, not another secret rotation.
`AccountGovernanceStore.listKeys` returns cap/coverage/current month gross debit and
held exposure without hashes or secrets. `RoutingPolicyStore.list` returns the
revision/archived projection; archived bindings fail closed and are never unbound.
Update policy list consumers to use this typed projection and omit archives by
default. Bound archived profiles and accepted frozen jobs keep their identity.

Mount the new narrow key/policy editors as described in `governance-ui.md`, using
authenticated workspace+identity context. The shared shell and relays are not
modified here. Browser checks must exercise the mounted integrated UI, not infer
success from unit tests or an unmounted component.

## Meaningful checks and manual testing plan

The own-clone Node22 install uses local node_modules and a separate npm cache.
`node scripts/test-governance-sql.mjs` boots a disposable PGlite socket, records
checksums for immutable001–012, and applies unnumbered governance proposals to the
fixture only. This does not test production numbered manifest/upgrade behavior.
Targeted tests cover source identities through HTTP/compat/MCP, key rotation and
revocation, external/native authority expiry, private metadata, UTC rollover,
replay, held costs, credits, BYOK exclusion, cap lowering, legacy/tenant coverage,
model/provider exceptions, explicit author IDs, processing scopes and policy
lifecycle. Whole-tree TypeScript and catalog checks also pass on this candidate.
Native races are gated on TEST_NATIVE_POSTGRES=1 and a disposable TEST_DATABASE_URL;
PGlite is not native race proof. Integration owns native admission/cap lowering,
rotation, concurrent policy edits/revocation and populated upgrade/restart/restore.

After schema/registry/mount integration:

1. Use disposable synthetic admin/member/source-key/native OAuth and external JWT
   fixtures. Submit through HTTP, compatibility, browser and MCP. Check stored
   source identities and private tags; confirm tags never reach adapters/public
   DTOs. Remove membership/revoke key/expire token/change policy during preparation
   and confirm admission fails with no job, debit or provider call.
2. Race managed admissions and cap lowering on native PostgreSQL. Check workspace
   ledger equals key gross+held accounting, one reserve/settle per job, stable source
   subject across rotation/refresh, original UTC month on late settlement and no
   quota restored by top-ups/credits. Verify unknown acceptance remains held and
   BYOK external charges carry no false managed-cap claim.
3. Exercise rename/update/archive and stale revisions; exact model exceptions,
   author-only and every endpoint/processing/deployment/fallback constraint. Keys
   bound to archived profiles must fail new admission; accepted snapshots survive.
4. Mount settings on desktop/phone and run the detailed `governance-ui.md` manual
   plan: one-time secret display, lost-response handling, reload, logout/workspace
   change, scope removal, keyboard access and preserved regional restrictions.

No paid generation, provider secret/key file, cloud change, deployment, payment,
shared preview mutation or public publication is part of these checks. Existing
provider receipt/usage and frozen-tariff accounting evidence must stay intact when
merging the provider-validation branch; this feature does not relabel its pricing
or fixture evidence as live provider verification.
