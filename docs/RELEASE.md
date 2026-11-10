# OpenGen release acceptance

Owner decisions **2026-11-04**: all user generations are private to authorized workspace identities; public sharing/gallery/visibility controls are outside v1. SDK distribution, new SDKs and framework adapters are deferred and are not release gates. Human/agent HTTP/MCP documentation and canonical executable examples are the adoption deliverable. See the detailed [core delivery and parallel work plan](CORE-DELIVERY-PLAN.md).

The later public OpenAI plugin application has its own [readiness track](OPENAI-PLUGIN-READINESS.md). Open-source release readiness does not establish directory eligibility or approval, and this checklist does not submit or publish a plugin.

A source package being publishable is different from completing the agreed product. The [plan](PLAN.md) remains the delivery contract. This checklist does not redefine unavailable provider integrations or planned v1 features as complete. Keep [STATUS.md](STATUS.md), the README and release notes truthful. The canonical registry, onboarding/account/key/grant UI, source CLI binding and optional Checkout/hold/cap/raw-relay modules are integrated in the candidate. The unchecked gates below concern final release evidence, not a claim that those source features are still unimplemented. See [VERIFICATION.md](VERIFICATION.md) and [PARALLEL-DELIVERY.md](PARALLEL-DELIVERY.md).

## Reproducible local checks

```sh
npm ci
npm run format:check
npm run typecheck
npm run catalog:check
npm test
npm run test:sql
npm run build
npm run release:check
npm run scan:secrets
```

`release:check` verifies release documents, package versions/licenses, forbidden release paths and high-confidence credential patterns. It is not a full secret scanner or a production-readiness assessment. `scan:secrets` requires Gitleaks and scans both complete Git history and a snapshot of the proposed source tree, including non-ignored untracked files. It redacts findings. Ignored `.env`, `.next`, account bindings and local artifacts must never enter the source release.

`release:check` also works after extracting a source archive without `.git`. In that case its hygiene check walks the source files directly, skips installed dependencies, build caches and test reports, and rejects symbolic links instead of following them. Private `.env` and credential files in the source tree still fail the check; only public example templates are allowed. Run it before generating private local configuration. This archive check does **not** inspect Git history. Run `scan:secrets` in the original repository before exporting the archive. When `.git` exists, a Git enumeration failure is an error, never a reason to fall back to an archive pass.

Git source selection rejects tracked local account bindings, private evidence, backup/database files and generated bundles even if `.gitignore` would normally exclude them. Secret-scan staging also rejects file and parent symlinks before copying any linked bytes. Ignore rules alone do not protect a force-added file.

Use the official [Gitleaks 8.30.1 release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), verify its platform archive against the published checksum, and put the executable on PATH or set `GITLEAKS_BINARY` privately. CI installs that pinned version with a checksum check. The sole exact-value scanner allowlist is a public environment-variable identifier from a regional test fixture, not a credential or a file/path exclusion.

## Source and license gates

- [ ] Exact archive contains the original implemented signup/authentication, workspace/key/MCP OAuth, billing integration and frontend source, plus the self-hostable core and safe configuration examples; no blanket auth/payment/security-source exclusion. See [publication boundary](OPEN-SOURCE-BOUNDARY.md).
- [ ] Documented self-hosted paths work with normal operator-owned dependencies/configuration and no mandatory unpublished OpenGen application module; usable public defaults and operational setup/upgrade/backup/restore/rotation guidance ship.
- [ ] Actual credentials, customer/private-generation data and sensitive deployment policy/settings remain excluded. Payment source inclusion is verified independently of optional sandbox/live activation; no new private-policy framework or license restriction is introduced.
- [ ] All source changes reviewed and committed; no local secrets, account bindings, evidence or build caches tracked.
- [ ] Full Git history and proposed tree pass Gitleaks with findings reviewed without exposing values.
- [ ] All package manifests agree on version and Apache-2.0 project license; third-party obligations in [DEPENDENCIES.md](DEPENDENCIES.md) reviewed.
- [ ] Public catalog facts have dated primary evidence; unknown regions, prices and performance stay unknown.
- [ ] No treg implementation/assets/catalog copied. Original OpenGen branding and media rights are recorded.
- [ ] Clean-checkout `npm ci`, build, catalog, type, API and SQL checks pass.
- [ ] Native PostgreSQL concurrency CI passes; PGlite is supplementary evidence.
- [ ] Desktop/phone browser checks and anonymous-generation rejection pass.
- [ ] Container build/start and disposable database dump/restore pass in CI or a Docker-capable host.
- [ ] Installation, upgrade, backup, restore and secret rotation procedures verified for the advertised deployment.
- [ ] GitHub repository ownership/name, security reporting and branch/release settings are confirmed; CI results link to the exact release commit.

## Product and live-provider gates from the agreed plan

- [ ] Approved responsive video-backed UI implemented and reviewed; production clip/poster has redistribution rights and factual attribution.
- [ ] Every advertised executable route has dated, explicitly budgeted real smoke evidence. Fixtures never count as live verification.
- [ ] Initial provider/model coverage and regional audits complete, with provider-specific capability/price evidence. Canonical schemas/discovery for all 27 variants, named asset roles and rejection of unsupported arguments agree across interfaces on the exact release commit.
- [ ] Scoped authentication/workspaces/keys/grants, secure provider connections, hosted OAuth/consent, local CLI/binding and actual client/version authorization verified for the advertised deployment.
- [ ] Upload/output lifecycle, browser recovery, dashboard/ledger and billing flows completed as specified.
- [ ] Private storage is required before generation admission; customer HTTP/MCP/compatibility/event responses never expose raw provider output URLs. Delivery retry resumes existing work without repeated provider submission or settlement.
- [ ] Inputs/history/reuse/status and browser recovery enforce the owning workspace; no private content/credentials enter public sitemap, metadata, examples, public metrics or unredacted telemetry. Retention/expiry and upstream disclosures are accurate.
- [ ] Human/agent HTTP/MCP examples validate against effective schemas and pass fixture-backed end-to-end walkthroughs without installing a new SDK. SDK distribution is deferred.
- [ ] Saved regional routing policies/fallback constraints and observed metrics verified.
- [ ] C2PA, compatibility endpoints, signed outbound events/alerts and remaining v1 interfaces implemented and validated.
- [ ] Optional payment enablement has dedicated sandbox evidence for Checkout/retry, signed raw-byte webhook delivery, atomic credit, persistent holds/caps and customer recovery; production key/operational decisions are reviewed before live charges. Provider-test authorization does not authorize customer charges.
- [ ] Deployed managed service remains private until its auth, transport identity, database/storage and operations gates pass. Hosted raw Vercel-to-GCP webhook/WIF routing must be verified before payment enablement.

Reviewed provider-validation fixes and source-safe reports are integrated. Their older authenticated access/generation cohort still requires exact-current-candidate and complete coverage qualification. Some charges remain unknown/held, and xAI manual recovery is not a gateway delivery pass. The authorized provider budget is USD 50 **total** across workstreams; use the current shared private admission journal, not a stale document's spending figure. Payment sandbox/live charges require their separate authorization and evidence. Unknown model availability, acceptance and costs must not be replaced with invented release evidence.

## Packaging after the gates pass

Create a clean tagged commit only after acceptance. `npm run release:archive -- /absolute/private/path/opengen-0.1.0.tar.gz` refuses dirty/untracked source and archives the committed tree with a SHA-256 sidecar. It does not create a GitHub release, push a tag or publish npm packages. Scan/extract the archive and run the clean-install checks against that exact archive before publication. Release notes must state supported/executable routes, observed test dates and known limitations without claiming planned features work.

For source-only packaging acceptance, use a clean, reviewed commit and a fresh private temporary directory. Record `git rev-parse HEAD HEAD^{tree}`, the lockfile SHA-256, `node --version`, `npm --version`, `node -p 'process.platform + " " + process.arch'` and the Gitleaks version alongside the results. Run `release:check` and `scan:secrets` in the source repository first. Create two archives at distinct paths with the existing `release:archive` command, verify their SHA-256 sidecars and compare their bytes with `cmp`. This establishes repeatable archive bytes for that exact source and recorded toolchain; mutable container base tags and a Node version range do not establish bit-reproducible container images.

List the archive before extraction: it must contain only the `opengen-0.1.0/` tree, regular source files/directories, licenses/notices and public configuration templates. No `.git`, installed dependencies, private configuration, account bindings, customer media/receipts, database backups or generated distribution artifacts belong in it. Extract into a new directory outside the checkout, run `npm ci` from the lockfile, then `release:check`, type/catalog checks and `vitest run tests/release-packaging.test.ts --maxWorkers=1 --no-file-parallelism`. Run the production build once there if archive/build qualification is still needed. Record passes, failures and skips against the commit/archive hash; these packaging checks supplement the full exact-candidate CI gates above. A working-tree snapshot is preflight evidence and must never be described as a release tag or final candidate.

The root repository is intentionally `private: true` for npm: the open-source release is a source repository/archive, not an accidental monorepo npm publication. Individual SDK publication and new SDK/framework packages are deferred by the owner; do not add them as prerequisites.
