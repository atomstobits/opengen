# Changelog

## 0.1.1 — 2026-11-11

- **Saved-card automatic recharge & Customer Portal**: Opt-in saved-card setup, off-session automatic USD recharge within workspace ceilings, 3DS/SCA browser authentication recovery, Stripe Customer Portal management, and `POST /v1/operator/billing/work` scheduling behind explicit `OPENGEN_BILLING_RECHARGE=open` configuration.
- **Durable Resend notification email relay**: Standalone idempotent HTTPS operational alert email relay (`npm run email:relay`) backed by PostgreSQL delivery leases (`mr_email_relay_deliveries` storing SHA-256 digests only) and Resend `Idempotency-Key` forwarding.
- **Portable `@opengen/cli` publication**: Updated the closed zero-dependency Node 22.12+ CLI package template to `@opengen/cli` (`bin: opengen`) for public npm installation alongside checksum-verified offline release bundles.

## 0.1.0 — 2026-11-10

Initial independent OpenGen source release: source-linked image/video catalog, explicit company and model-series pages, separate regional providers, quotes, REST/MCP/CLI interfaces, workspace-private media delivery/recovery and a durable PostgreSQL job/attempt/ledger core. See [current status](docs/STATUS.md) for the implemented scope and [release gates](docs/RELEASE.md) for live-provider and managed-deployment boundaries.

Published as an Apache-2.0 source release only; workspace npm packages remain unpublished (`private: true`) and SDK distribution is deferred. Provider fixtures are not live-generation evidence, and source publication does not establish managed-generation or live-payment activation.
