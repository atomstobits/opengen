# Governance settings components

`apps/web/app/governance/key-editor.tsx` and `policy-editor.tsx` are isolated client components for the existing private workspace settings screen. They reuse its semantic tokens, controls and typography. They are not mounted in the shared shell in this feature commit. The integration owner controls that mount, HTTP/MCP operation registration, web relay paths and schema rollout.

The components accept authenticated context, current workspace-owned records and typed mutation callbacks. They do not fetch, write storage, submit a generation or infer authority from a key label. The server must authenticate each callback request and revalidate administration authority transactionally; disabled controls are only a UI affordance.

## Mounting and data mapping

Mount `KeyGovernanceEditor` for a selected API key, with `workspaceId`, a stable authenticated `identityId`, and current permission scopes. Use a session/member/grant identity discriminator, never a display name. The wrapper remounts private state when workspace, identity, key, revocation or permission context changes. The parent must remove all private settings immediately on logout or when that context is no longer known, and must discard stale read responses from the previous context.

The key list DTO from `AccountGovernanceStore.listKeys` maps to `GovernanceKey` as follows:

```ts
const apiKey = {
  id: row.id,
  name: row.name,
  secretVersion: row.secretVersion,
  monthlyCapMicros: row.monthlyCapMicros,
  revokedAt: row.revokedAt,
  coverage: {
    since: row.coverageStartedAt,
    legacyUsageUnknown: row.legacyCoverage === 'since_cutover',
  },
  month: {
    utcMonth: row.admissionMonth.slice(0, 7),
    settledMicros: row.grossDebitMicros,
    heldMicros: row.heldMicros,
  },
};
```

Do not turn missing/unattributed coverage into zero use. If no authoritative current-month attribution projection is available, pass `month: null`. `coverage: null` explicitly represents an unestablished cutover. Keep integer micro-USD in callbacks; dollar formatting is confined to the form.

For `PolicyGovernanceEditor`, pass the domain policy record directly (`id`, `name`, `policy`, `maxCostMicros`, integer `revision`, nullable `archivedAt`), and the exact-model/provider catalog choices. Existing unavailable IDs remain visible in the form and are not silently deleted. Model editing copies all existing routing fields; it never clears regional/deployment/processing/fidelity/fallback restrictions. Empty selected lists represent denial, including a per-model provider exception with no providers.

The key editor is read only without `keys:write`. The policy editor is read only without both `keys:write` and `policies:write`, and always read only when archived. Per-generation policy limits and managed monthly key limits have separate labels.

## Callback/API seams

The HTTP paths below describe the feature handler module; the integrator must register/allow them before mounting:

| Callback                                                | Handler request                                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Load key projection                                     | `GET /v1/governance/keys`                                                                          |
| `updateKey(workspaceId,id,changes)`                     | `PATCH /v1/keys/:id` with `{name,monthlyCapMicros}`                                                |
| `rotateKey(workspaceId,id,expectedSecretVersion)`       | `POST /v1/keys/:id/rotate` with `{expectedSecretVersion}`; returns `{id,token,secretVersion}` once |
| `updatePolicy(workspaceId,id,expectedRevision,changes)` | `PATCH /v1/policies/:id` with `{expectedRevision,name,policy,maxCostMicros}`                       |
| `archivePolicy(workspaceId,id,expectedRevision)`        | `POST /v1/policies/:id/archive` with `{expectedRevision}`                                          |

`workspaceId` is a local callback binding check. The HTTP server derives the workspace from authentication, never from a body-supplied workspace or actor. Recheck the active browser workspace before sending a callback, and preserve same-origin/CSRF handling in the existing transport. Read the current session before retrying a failed write. Policy updates/archives use the expected revision and cannot overwrite a concurrent admin's edit silently. Reload the policy record after a confirmed change, so the next action uses the new revision.

Rotation passes the current secret version and makes no automatic retry. A lost/rejected response locks its button until key metadata is refreshed; a page reload also remounts the component. A deliberate replacement rotation uses the newly fetched version. A successful rotation displays the token only in local component memory until dismissed, unmounted or superseded by a newer rotation. No token is placed in a URL, storage, telemetry or the key list. A metadata refresh to the same successful secret version retains its one-time display; a later version clears it. Do not cache/log the response or automatically initiate another rotation.

The UI explains that rotating revokes sourced sessions/apps while stable key identity, cap counters and accepted generations remain. The backend must perform secret replacement and sourced-grant revocation atomically. Merely hiding the previous secret does not implement this contract.

## Manual testing plan

After the integrator mounts and registers the handlers, use only disposable fixture keys and accounts:

1. Open the selected workspace on desktop and phone. Rename a key; save empty, zero and six-decimal monthly caps. Confirm invalid/unsafe amounts do not reach HTTP. Verify server-reported gross debit and held exposure retain their distinct labels, cutover disclosure and BYOK exclusion.
2. Rotate once. Confirm the old credential/session and source-key OAuth refresh fail; the stable key ID and cap totals remain. Copy then dismiss the one-time token; reload and confirm it is not returned. Simulate losing the response and confirm there is no automatic retry and stale-version rotation is rejected.
3. Switch workspace or sign out while each request is delayed. Confirm no old record, form value, notice or secret appears in the new context. Repeat with revoked permissions and a revoked key. The parent must discard the old-context HTTP response as well.
4. Edit exact-model restrictions, author-only and a model provider exception. Check the saved request retains existing endpoint/deployment/processing/fidelity/fallback restrictions. Confirm an empty exception blocks that model and a reseller cannot bypass author-only. Add duplicate exceptions and verify local validation.
5. Rename/update the same profile from two admin sessions. Confirm the stale revision is rejected. Archive a profile and verify existing keys keep the archived policy; accepted jobs retain frozen snapshots. Verify read-only sessions cannot call mutations even with an edited browser request.
6. Check keyboard focus, labels, fieldset disabling, wrapped long IDs and narrow-screen buttons. Announced success/error text must not include raw provider diagnostics or tokens.

Focused unit coverage in `tests/governance-ui.test.ts` checks exact money parsing, zero-versus-absent limits, safe names, preservation of every routing constraint, explicit denial and duplicate exceptions. Shared shell browser/build qualification remains an integration check.
