# C7 operations integration handoff

This is a private, fixture-backed package candidate. The integration owner controls all shared exports, engine hooks, schema numbering, server/OpenAPI/MCP registration, browser relay and workspace shell. Do not enable partial frontend routes before their authenticated backend/schema exists.

## Schema and exports

Apply C5's `mr_jobs.attribution jsonb` / `metadata jsonb` migration before Activity. `NULL` legacy attribution remains unknown. The existing `delivery_status` column comes from006. Apply the unnumbered `packages/engine/schema-proposals/activity-indexes.sql` and `operations-notifications.sql` drafts under integration's reserved018; preserve old migrations and contiguous loader numbering. Reconcile index overhead on the combined realistic native PostgreSQL candidate. Export `ActivityStore`, `parseActivityFilters`, and their types from `activity.ts`; export `NotificationStore`, `notificationTypes`, `notificationData`, and types from `notifications.ts` through the engine entry point.

## Server and protocol hooks

At the existing `registerEvents` call in `apps/server/src/app.ts`, after authentication is available:

```ts
await registerActivity(app, {
  activity: new ActivityStore(options.engine.pool),
  authenticate,
});
await registerNotifications(app, {
  notifications: new NotificationStore(options.engine.pool),
  authenticate,
});
```

Keep optional-storage startup behavior: only construct/register configured stores when the engine exists, or return503 from equivalent wrappers. Existing events routes already use `engine.events`. No new worker, queue, provider submission or settlement hook is needed for member notifications: they read existing transactionally enqueued alert-triggered/resolved events, deduplicated by the existing outbox. Notification preferences do not suppress workspace webhook events.

Add stable operation targets and strict schemas with these exact routes. Names below are proposals for the registry owner to reconcile once; all clients must use the accepted names:

| Operation                       | Method/path                         | Scope                    |
| ------------------------------- | ----------------------------------- | ------------------------ |
| `activity.list`                 | GET `/v1/activity`                  | read                     |
| `activity.analytics`            | GET `/v1/activity/analytics`        | read                     |
| `notifications.list`            | GET `/v1/notifications`             | read + active membership |
| `notifications.preferences.get` | GET `/v1/notifications/preferences` | read + active membership |
| `notifications.preferences.put` | PUT `/v1/notifications/preferences` | read + active membership |
| `notifications.read`            | POST `/v1/notifications/:id/read`   | read + active membership |

`parseActivityFilters` is the executable strict parser; it accepts only named exact predicates, timestamp bounds and cursor/limit. Analytics rejects cursor/limit and enforces at most31days. Notification list accepts limit1..100,cursor,unreadOnly=true|false. Preference schema is exported as `notificationPreferencesSchema`; false email is accepted, true rejected because transport is unavailable. Read operation accepts only route UUID plus empty body. The existing `webhooks.update` schema must use exported `webhookEditSchema` plus its route ID instead of the old enabled-only schema, so canonical call/MCP parity does not strip endpoint/event edits. Existing create/rotate/list/delivery/alerts targets remain.

Keep these operations private in OpenAPI/MCP and relay allowlists: no addition to publicOperationIds, no unauthenticated catalog or metrics path. Activity is additive; retain legacy `jobs.list` recovery contract for existing internal clients/live-smoke until explicitly migrated. No SDK distribution work is needed.

## Browser hooks

Import `PrivateActivity` and `WorkspaceOperations` from their standalone dashboard modules. Supply trusted `{workspaceId,membershipId,permissions}` from the selected authenticated session. BrowserSession needs the server-derived membershipId (or equally strong identity epoch); absent member identity gates personal notification controls. Mount only within authorized app views. Each component resets private state and one-time secrets when workspace/member/scopes change and aborts in-flight requests.

Replace Activity's full `load<Job[]>('/api/generations')` with compact Activity. Do not retain it as a hidden background request for detail support. On `onSelectJob(id)`, fetch one authorized job detail and clear it on workspace/member/scope transitions. Start/Team/governance/Playground retain their respective ownership. Localized styles are in `operations.module.css`; shared global CSS is untouched.

Browser relay mappings required: `/api/activity` => `/v1/activity`, `/api/activity/analytics` => `/v1/activity/analytics`; existing webhooks/webhook-deliveries/alerts/settings/alerts paths; and the notification paths above. Canonical registry targets must feed the native allowlist; do not add arbitrary URL forwarding. Match current CSRF/session handling for mutations.

## Qualification and manual testing plan

Run targeted Activity/review, events/notifications and UI fixtures in this clone. Then integration must run combined native-PG tenant/cursor/index/migration/concurrency checks and browser/build checks. In browsers, switch workspace/member and revoke scopes during delayed reads/mutations; private rows, selected details and secrets clear immediately. Verify no prompts/output URLs are transferred in list traffic. Page equal timestamps with new arrivals, filter exact variants/regions, and compare held/settled/unknown totals against the ledger. Create/rotate/edit/disable a synthetic webhook; cancelled queued retries never reroute and an already-started send may still arrive. Mark one alert notification read as two members; read/preferences remain independent. No real mail/provider inference is part of this testing plan.

Native local initdb was attempted in a package-isolated temporary directory and failed due host SHMALL shared-memory exhaustion, including with escalated execution. No global kernel/cluster changes were made. PGlite query-plan/behavior evidence is not a claim of native qualification. Full release, live-provider, hosted identity/client, external delivery/mail and deployment remain separate gates.
