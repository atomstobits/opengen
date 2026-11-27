# Changelog

## 0.1.2 — 2026-11-27

- **Onboarding overhaul & CLI defaults (`@opengen-dev/cli` `0.1.2`)**: Defaulted the portable CLI gateway origin to `https://opengen.dev` with standardized `OPENGEN_API_URL` and `OPENGEN_API_KEY` environment variables (retaining `MEDIA_ROUTER_URL` / `MEDIA_ROUTER_TOKEN` aliases), aligned bundled CLI error serialization with `OPENGEN_API_URL` / `https://opengen.dev`, and refreshed the packaged CLI README and onboarding skill bundle.
- **Auth, Playground, Billing & Pricing**: Added validated `?returnTo=` preservation across `/auth/login` → `/auth/callback`, optional GitHub OAuth and PostgreSQL-backed Email OTP (`036.sql`), HMAC-signed proxy client-IP proof for rate-limited auth/trial routes, interactive `/docs/api` OpenAPI explorer, public `/pricing` overview, Playground starter prompts and raw-HTTP JS/Python tabs, single-step solo workspace funding checkout, and optional starter trial credit.
- **Dated live MCP client evidence**: Recorded dated `2026-11-27` live read-only OAuth MCP verification for `codex-cli 0.155.1` (`catalog_search`, `catalog_get`, `balance`) and live DCR + PKCE consent redirect verification for `Claude Code 2.1.301` on `/agents`.

## 0.1.1 — 2026-11-11

- **Saved-card automatic recharge & Customer Portal**: Opt-in saved-card setup, off-session automatic USD recharge within workspace ceilings, 3DS/SCA browser authentication recovery, Stripe Customer Portal management, and `POST /v1/operator/billing/work` scheduling behind explicit `OPENGEN_BILLING_RECHARGE=open` configuration.
- **Durable Resend notification email relay**: Standalone idempotent HTTPS operational alert email relay (`npm run email:relay`) backed by PostgreSQL delivery leases (`mr_email_relay_deliveries` storing SHA-256 digests only) and Resend `Idempotency-Key` forwarding.
- **Portable `@opengen-dev/cli` publication**: Updated the closed zero-dependency Node 22.12+ CLI package template to `@opengen-dev/cli` (`bin: opengen`) for public npm installation alongside checksum-verified offline release bundles.

## 0.1.0 — 2026-11-10

Initial independent OpenGen source release: source-linked image/video catalog, explicit company and model-series pages, separate regional providers, quotes, REST/MCP/CLI interfaces, workspace-private media delivery/recovery and a durable PostgreSQL job/attempt/ledger core. See [current status](docs/STATUS.md) for the implemented scope and [release gates](docs/RELEASE.md) for live-provider and managed-deployment boundaries.

Published as an Apache-2.0 source release only; workspace npm packages remain unpublished (`private: true`) and SDK distribution is deferred. Provider fixtures are not live-generation evidence, and source publication does not establish managed-generation or live-payment activation.
