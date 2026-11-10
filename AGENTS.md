# OpenGen

Read docs/PLAN.md and docs/STATUS.md before making changes. This is independent original code; do not copy treg code, branding or catalog content. Reference its product patterns and independently source provider facts.

- Exact variant identity and regional deployment IDs are fixed execution choices. Never merge derivatives by name or infer model availability from a provider's global region list.
- Owner-confirmed identity (2026-11-03): fal's H3 Max and MiniMax H3 Max are one `minimax/h3-max` variant. Preserve provider labels/route IDs; `fal/h3-max` is a legacy alias. This does not establish equivalence for Turbo or other derivatives.
- Endpoint location, inference scope and residency are distinct and may be unknown.
- Public catalog metadata must include sources and distinguish documented from live-verified support. Unknown prices and metrics are null, never zero/free/100%.
- Submit once, persist IDs, resume. Unknown upstream acceptance cannot trigger a blind paid retry. Cancellation does not establish refundability.
- REST, MCP, CLI and web share application rules. Keep adapters explicit; avoid generic expression engines and unrestricted URL proxies.
- Preserve money and tenant isolation transactionally. No keys, private prompts or assets in public telemetry.
- Owner decision (2026-11-04): all user generations are private to the owning workspace and its authorized identities/scopes. No public generation gallery, share/publish operation, private-content SEO or visibility toggle in v1. Customer outputs must use owned private media capabilities; raw provider output URLs are internal recovery data. See docs/CORE-DELIVERY-PLAN.md for the remaining admission/delivery/browser-isolation work.
- Owner decision (2026-11-04): SDK distribution, new SDKs/language bindings and framework adapters are deferred. Prioritize clear human/agent HTTP/MCP docs, effective schemas and executable raw-HTTP examples. Maintain existing internal clients as needed; the separately assigned CLI/skill/plugin onboarding work continues.
- Keep docs/STATUS.md honest. Planned and fixture-backed functionality must not be advertised as live-verified.
- UI keeps the restrained retro brand details, readable sans-serif body and original components. Use the shared semantic color tokens; the current palette and owner feedback are recorded in docs/design/DECISIONS.md.
- Run typecheck, catalog check, tests and web build for affected contracts. Paid provider calls require an explicit bounded budget.

## User-authorized PR merge policy (2026-11-04)

The user explicitly authorized merging all OpenGen PRs once every current-head CI check is green. Do not ask again. Respect repository protections and dependency order; refresh/reconcile the target branch, mark drafts ready when appropriate, and use the expected head SHA so concurrent merge attempts fail safely. PR2 has merged into codex/unified-inputs; PR3 follows that current base, then parent PR1 receives refreshed current-head CI before merging. A source PR merge does not authorize changing repository visibility, publishing packages/tags/releases, hosted activation, new paid admission, cloud/client changes or claiming missing live evidence complete.
