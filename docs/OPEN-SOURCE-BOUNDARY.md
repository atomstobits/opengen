# OpenGen publication boundary

Updated **2026-11-04**. OpenGen is an independent Apache-2.0 project. This document makes the positive publication inventory explicit: application code for authentication and payment integration belongs in the public source alongside the generation gateway. Publishing source, making the repository public, deploying a managed service and enabling real payments remain separate actions with their existing acceptance gates.

## Application source and documentation to publish

| Area                                    | Included in the source release                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account provisioning and authentication | Original implemented signup/account provisioning, browser sessions, identity-provider integration and configuration examples, CLI login, consent, refresh/revocation and authorization checks. Normal external identity-provider requirements are documented.                                                                                |
| Workspaces and credentials              | Workspace/team membership, roles, API-key issuance/rotation/revocation, scoped grants, provider-connection mechanisms and tenant isolation. Credential-handling code is public; actual credentials and customer records are private.                                                                                                         |
| MCP and generation                      | MCP OAuth/PKCE, HTTP/MCP schemas and handlers, canonical inputs, catalog/source metadata, explicit adapters, routing, jobs, private assets, recovery, accounting and operator mechanisms.                                                                                                                                                    |
| Billing integration                     | The implemented prepaid ledger, top-up orders, Checkout, signature-verified webhooks, idempotent credit/settlement and refund/dispute holds. Payment UI and safe configuration examples are included even when real payments are disabled.                                                                                                   |
| Product interfaces                      | Original public catalog/company/model pages, private application/Playground/Activity/Team/settings frontend, CLI, skill/plugin source and useful human/agent HTTP/MCP documentation. SDK distribution remains deferred; existing internal client source may remain in the repository.                                                        |
| Self-hosting and operations             | Safe example environment configuration, containers/local setup, generic deployment/IAM scripts, migrations, storage/retention setup, installation/upgrade, backup/restore, key rotation and troubleshooting procedures. Public origins, protocol metadata and generic architecture are not secrets merely because production also uses them. |
| Verification and obligations            | Synthetic fixtures, relevant tests, CI definitions, dependency/license notices, reviewed source-safe capability/verification reports and exact-source packaging instructions.                                                                                                                                                                |

Release packaging must retain these application modules. Do not exclude authentication, payment, administration or security-mechanism source merely because the corresponding runtime data is sensitive. The public core must be useful with documented normal dependencies and operator-owned configuration; it must not require an unpublished OpenGen application module or OpenGen's production credentials.

This inventory covers the implementation agreed for OpenGen. It does not add a new identity provider, every login method found in another product, automatic top-ups, new SDKs or another billing system. Optional payment activation still needs the existing sandbox/raw-webhook/exactly-once-credit evidence and separate operational authorization. Self-hosting without a payment processor retains the documented operator-funding path.

## Runtime material to keep private

- Real provider keys, OAuth client secrets, signing/private encryption keys, production database connection strings and secret-manager values. Public example templates use placeholders; tests use clearly synthetic credentials.
- Customer identities/account bindings, sessions/tokens, prompts, input/output media, private asset/recovery capabilities, provider receipts and private job/history/label data. All user generations remain private to their authorized workspace. Encryption or hashing does not turn customer records into publication fixtures.
- Database dumps/backups, private live-test artifacts, raw billing/provider receipts and live budget journals. Reviewed source-safe outcomes may be published without private identifiers or content.
- Sensitive deployment-specific settings, access identities, incident/break-glass procedures and any explicitly separated deployment-specific abuse thresholds, lists or scoring data. Publish the generic configuration contract and useful operational procedures using safe examples.

The existing source/history/artifact scans and packaging exclusions apply to force-tracked files too. Keeping a file in `.gitignore` is not publication acceptance. Do not delete actual customer data or rotate live secrets as part of preparing this documentation.

## Deployment-specific abuse policy

OpenGen does not need a new policy-extension framework for this release. Generic security mechanisms, public limits/validation, authorization and money invariants remain in the public implementation. If an operator later separates deployment-specific abuse policy, document that boundary and provide usable, honest public defaults. A private policy module must not become mandatory for self-hosted signup, authorization, generation or accounting, or conceal an override of public tenant/spend controls.

Privacy, retention and publication are separate contracts: a public source repository contains the mechanisms for private generations, not the private generations themselves. Short-lived owned delivery URLs remain bearer capabilities and do not establish provider ZDR or instant revocation.

## Release acceptance

1. Inspect the exact final archive and confirm it contains the implemented account/authentication, workspace/key/MCP OAuth, billing integration and frontend source as well as the self-hostable generation core, licenses and safe configuration examples.
2. Install/configure the extracted source with documented dependencies and synthetic/operator-owned configuration. Verify supported self-hosted account/workspace/API/MCP/generation paths without a mandatory unpublished OpenGen application module. Fixtures do not replace the separately required actual identity/client/provider qualification.
3. Verify payment integration source is present; keep activation disabled until its separate payment gates pass. Source publication does not authorize a real charge or add auto-refill.
4. Check complete Git history, proposed source and archive for secrets, customer/private-generation data and local operational artifacts, retaining the established artifact/symlink protections and third-party obligations.
5. Confirm useful self-host/upgrade/storage/retention/backup/restore/rotation documentation ships. Sensitive values may be omitted; essential setup instructions and generic mechanisms may not be withheld as an undocumented hosted-only dependency.

## Reference findings: treg's boundary

The public treg repository includes [account provisioning](https://github.com/superdesigndev/treg/blob/main/src/treg/application/signup.py), [human authentication](https://github.com/superdesigndev/treg/blob/main/src/treg/routers/auth.py), [MCP OAuth](https://github.com/superdesigndev/treg/blob/main/src/treg/domain/identity/mcp_oauth.py), [billing integration](https://github.com/superdesigndev/treg/blob/main/src/treg/application/billing.py) and its [frontend](https://github.com/superdesigndev/treg/tree/main/frontend). Authentication and payments are not withheld as proprietary hosted-only application modules. Source presence does not independently verify its hosted operation.

Its documentation separately describes private hosted abuse-policy tuning alongside usable public defaults, and private live operational settings: [policy extensions](https://github.com/superdesigndev/treg/blob/main/docs/context/architecture/policy-extensions.md), [deployment](https://github.com/superdesigndev/treg/blob/main/docs/context/ops/deploy.md).

The [treg LICENSE](https://github.com/superdesigndev/treg/blob/main/LICENSE) contains Apache-2.0 text with additional terms restricting third-party hosted/managed/embedded services without written authorization. OpenGen retains its own standard Apache-2.0 license and original implementation; this comparison imports neither treg code nor its additional restriction.
