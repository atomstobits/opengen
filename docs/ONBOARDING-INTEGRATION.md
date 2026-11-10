# Customer onboarding integration

Integrated source candidate, **2026-11-03**, originating from the separate `codex/customer-onboarding` delivery. The shared CLI, navigation, discovery and billing hooks are now wired. This is fixture-backed implementation, not a deployed service or certification of any third-party client/version. See [VERIFICATION.md](VERIFICATION.md) for current integrated results.

## Delivered surfaces

- `apps/web/app/start/{page,welcome}.tsx` and `onboarding/{journey.tsx,onboarding.module.css}` provide account entry and first-use paths. `/api/session` controls sign-in availability; no Google/GitHub/email method is advertised without configured identity. First sign-in reuses issuer/subject identity and creates zero credit. Browser creation remains prominent alongside Agent / CLI / API.
- `gateway-access.tsx` shares sign-in/session UI, explicit collapsed self-hosted workspace-key access, retry and sign-out across consumers. The normal account flow requests no operator/provider credential. Browser sessions remain HttpOnly.
- `dashboard/{workspace,settings,team}.tsx` and `connected-apps.tsx` provide workspace/invitation, API-key and app-grant management. Keys default to expiring read/generate authority intersected with current permissions, appear once and can be revoked. Key issuance stays bound to the authenticated workspace. Independent app grants survive browser sign-out until revoked; revocation does not cancel accepted generations.
- `/app` adds a logged-in Start/Activity/Team navigation shell around those existing components. Start reuses the agent/CLI/browser onboarding, Activity reuses generation details and the ledger, and Team reuses workspace and membership management. API-key and connected-app screens have their own navigation entries. The Team view omits the legacy embedded key/settings section; `/dashboard#settings` retains it. One session/data owner and explicit workspace checks prevent stale private records from carrying across sign-out or workspace changes.
- `agents/{page.tsx,[client]/page.tsx,clients.ts,setup.module.css}` provide a server-rendered directory and eleven client/CLI pages. Instructions explain workspace/cost authority, recovery and dated support evidence. Unknown clients return 404; no actual client/version is certified by configuration fixtures.
- `apps/cli/src/{bindings,bindings-command}.ts` provide secret-free preview, fingerprint-bound apply, explicit replacement, unrelated-setting preservation, atomic private writes, locks and unsafe-file refusal. Cursor/Claude Code entries use independent native OAuth. No CLI token is copied into native client configuration and no global destination is chosen implicitly. See [LOCAL-AGENTS.md](LOCAL-AGENTS.md).

## Shared integration now in place

1. CLI `runCommand` dispatches `bind` to `runBindingCommand`; help exposes preview/apply/status alongside browser login/status/logout. The standalone source entry remains available.
2. Shared navigation and AI-readable discovery link `/start`, `/agents` and client setup pages. Agent pages are included in sitemap/discovery; `/start` remains noindex. The approved partially covered comparison-video hero and browser-creation path are preserved.
3. Dashboard/key/connected-app screens reuse existing account, session, membership and grant services. Canonical job details use `selected.input.input.prompt`. Generation inputs share the same schema and authorization as the other interfaces.
4. `/billing` and the dashboard destination now use the integrated optional payment module. Payment authority, credit and billing holds belong to the shared server/ledger, not onboarding UI. See [PAYMENTS-INTEGRATION.md](PAYMENTS-INTEGRATION.md).
5. Explicit-port localhost callbacks documented by Claude Code/Cursor are accepted only when registered exactly. S256, resource, full URI binding and the literal callback used by OpenGen's own CLI are preserved. See [AUTH.md](AUTH.md#native-client-callback-policy).
6. `cli:build` and `cli:package` produce a standalone Node executable and locally installable private tarball with SHA-256/build manifests and complete notices. The bundle calls the same CLI dispatcher, including binding, with no server/provider dependencies. Eleven packaging tests cover detached execution, offline installation, reproducible bytes and the closed import graph. See [CLI-PACKAGING.md](CLI-PACKAGING.md); no npm publication or global client change is implied.

## Verification and remaining evidence

Current integration checks use **Node.js 22.23.2 arm64**. Whole-tree TypeScript is green; the earlier isolated-branch canonical migration errors have been resolved. Focused binding/login tests use temporary files and synthetic callbacks rather than the developer's global client configuration. Browser checks use synthetic responses/accounts and cover availability/retry, first/returning users, workspace switching, one-time/expiring keys, grants, consent and stale-session recovery on desktop and phone. Current counts and exact evidence boundaries are maintained in [VERIFICATION.md](VERIFICATION.md).

No real signup, hosted identity-provider flow, actual agent authorization, provider call, charge or global client configuration mutation follows from those tests. The integrated candidate remains private and undeployed. Every actual client/version/date row remains unverified in [AGENT-SUPPORT.md](AGENT-SUPPORT.md).

Claude CIMD metadata is unsupported; its instructions select automatic dynamic registration. No local stdio bridge, globally published npm installer, marketplace plugin or pi extension is implied. Local binding means an explicitly reviewed client configuration pointing to hosted MCP, followed by the client's independent authorization. Public `opengen.dev` examples describe endpoint formats; self-hosted users supply their configured origin.

The [parallel delivery plan](PARALLEL-DELIVERY.md) remains the workstream contract. Treg's public setup patterns informed this original implementation; no source/assets were copied. The existing approved design decisions were followed where reference sites could not be inspected.

For the later account-page request, the user selected treg's `/app#start` as a reference. In-app and user-approved Chrome inspection could list the target tab, but page content and screenshot requests timed out; a live visual audit of treg's logged-in screens was not completed. The delivered account views are original adaptations of OpenGen's existing components and selected palette, with synthetic-session desktop/phone evidence.
