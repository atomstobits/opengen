# Customer onboarding implementation plan

Owner: `codex/customer-onboarding`; baseline `a0bbd14`; planned 2026-11-03.

## Contract and scope

Reuse AccountStore issuer/subject identities, first-sign-in personal zero-credit workspaces, configured OIDC, HttpOnly sessions, workspace membership checks, scoped hashed API keys and existing hosted MCP consent / CLI browser PKCE helpers. No email-based linking, customer operator/provider secrets, real signups, paid requests, deployment or global agent configuration writes. Preserve the approved comparison-video hero unchanged. All commands run in this worktree.

## Delivery steps

1. Inspect AUTH, TEAMS, release/design docs and existing session/key/workspace interfaces. Research treg's signup and agent setup patterns and AlleyBloom's signup/design through primary references; independently implement original OpenGen UI. Show only configured authentication.
2. Add a friendly `/start` entry with signup/sign-in semantics, a selected-workspace first-use checklist, direct browser creation and Agent / CLI / API paths. Improve the existing reusable gateway access UI; keep existing key-based access under explicit self-hosted advanced access. Add dashboard navigation, empty states, key management access and a reserved billing link/slot.
3. Improve key issuance UI: selected workspace, explicit expiry, read/generate defaults, server-controlled admin scope boundaries, one-time display/dismissal/revocation and no browser credential storage. Preserve workspace switch/membership behavior.
4. Add dedicated agent directory/detail pages with hosted OAuth and local browser-login choices, consent/paying-workspace explanation, revocation and recovery. Publish a dated evidence matrix separating protocol fixtures, documented setup and actual tested clients/versions. Cover ChatGPT, Claude, Claude Code, Cursor, Codex, OpenClaw, Hermes, OpenCode and pi honestly.
5. Add isolated local client-binding modules: explicit preview/apply entry, preserve unrelated JSON settings, avoid overwriting existing OpenGen entries silently, stale-preview protection, private profile reuse and no credentials in config/argv/URLs. Test exclusively in temporary directories. Propose CLI dispatch/native transport hooks in ONBOARDING-INTEGRATION rather than editing shared files.
6. Run focused unit/auth/config tests and narrow TypeScript checks; run desktop/phone browser fixture tests sequentially when available, using macOS escalation rules. Do not run heavy Next/browser/PGlite concurrently. Record baseline canonical-generation errors separately without fixing another owner's files.
7. Review diffs, format owned files, record validation/client/deployment gaps and exact shared wiring, then commit focused changes on this branch. No push/merge/release.

## Ownership/delegation

- Root: session/signup/start and dashboard integration, focused web verification, final handoff.
- Local binding subagent: new `apps/cli/src/bindings.ts`, standalone binding entry module, focused tests and local binding documentation. No CLI index/login or shared transport changes.
- Agent guidance subagent: new agent directory/detail pages, scoped styles/data, dated support matrix and source research. No hero/shared ui edits.

## Review gates

Authorization is enforced by existing backend operations; hidden controls are not security. No API-key default administrative scopes. Account sign-in availability is read from `/api/session`. Keys and OAuth tokens never enter local/session storage. New config writes require explicit application of a concrete preview. No live client success is claimed without version/date evidence. Main chat owns final whole-tree integration/build and release gates.

## Portable CLI packaging follow-up (2026-11-03)

Prepare new build/package scripts and a private opengen-cli template without editing core CLI/SDK/contracts or root dependency locks. Bundle only the closed CLI/SDK/contracts/Zod graph into a Node22 ESM executable, initialize Zod jitless, preserve license/NOTICE evidence, and suppress imported modules' direct-execution guards in a wrapper. Fail closed on graph escapes/external packages. Package exact allowlisted files into deterministic npm-compatible USTAR/gzip with SHA-256 manifests. Verify detached execution, mocked catalog/quote/status, safe binding preview, local temp-prefix offline npm installation, hashes and excluded artifacts. Main integrates exact builder dependency/lock and build/release workflows. No global install, real login, publishing, provider calls or client config mutation.
