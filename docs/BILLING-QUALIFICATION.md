# Billing milestone qualification ledger

2026-11-04. Private source candidate; not live payment approval. This work extends
manual billing under [BILLING-POLICY-PLAN.md](BILLING-POLICY-PLAN.md). All generation,
funding, setup, mandate and document data remain workspace-private. New commercial
fees, owner enrollment, hosted setup, portal, automatic recharge and SCA recovery
are disabled unless their separate explicit source gates/approvals are supplied.

## Source checkpoints

- `1a51c36`: pure immutable fee/evidence/gross-allocation contract;21 unit tests.
- `8fa59e3`: explicit funding owner/envelope, narrow delegated policy and audit.
- `d2cd918`: owned customer/setup/mandate/document/request transport, frozen owner
  approval, method-detach barrier and original-payment SCA projection.
- Subsequent funding/domain/shared integration commits and final exact-head CI are
  recorded below as they complete; an earlier test pass is not a later-head pass.

## Recorded local evidence

Own clone, Node22.23.2, private ephemeral PostgreSQL-wire PGlite and fake transports.
No account/key/config access, real Stripe/provider payment, mandate, deployment,
cloud mutation, package publication or public repository change occurred.

- Pure B1:21 cases; exact integer rounding/overflow, immutable classification,
  eligible outcomes, gross caps, cost evidence, unknown holds and managed/BYOK.
- Serialized B2/B3 checkpoint:38 passed,2 native-only races skipped. Covers
  owner/delegate rails and stale authority, setup/session/environment boundaries,
  owner epoch/version/consent fences, detachment/out-of-order recovery and documents.
- Subsequent cohort:89 passed,5 native-only skipped,1 expected-count assertion
  corrected after webhook GET admission became quota-accounted. No qualification
  pass is claimed for that failing cohort; final rerun required.
- UI+authentication helpers:13 passed; schema-valid fixed requests, workspace/
  recovery identity, exact money, same setup retry key, same PI confirmation,
  memory-only scoped capability and safe errors; no external script was loaded.
- Independent router/raw-webhook fixtures:20 passed using actual Fastify and
  official SDK signatures; browser/session/Origin/recovery and bearer boundaries,
  closed inputs, activation gates, financial metadata and one ingress dispatch.
- Whole-tree TypeScript was green before the latest additive processor-namespace
  follow-up. Final source type/build/catalog/tests/hygiene remain required after
  shared core hooks and new migration assembly.

## Recovery qualification — 2026-11-05

Recovery commit `3875885` restores the interrupted source on merged main
`97af8da`. The fee module matches the recorded checksum. The recharge fixture
now seeds the fake processor registry and its owner binding so it exercises the
late environment-identity checks.

- 68 local billing unit, API, webhook, transport and UI helper tests passed.
- 49 billing database tests passed on an isolated native PostgreSQL 17.11
  instance, including the five concurrent cases. The ephemeral PGlite cohort
  passed 44 with five native cases skipped.
- Git whitespace, source hygiene, and release packaging checks passed.

Shared runtime registration, forward migrations, commercial decisions, final
candidate CI and Stripe sandbox and live gates remain open. The database
qualification used synthetic rows and fake payment transport.

## Manual testing plan for the private PR

1. Install the exact private source commit with its own dependencies and a
   disposable database. Upgrade a populated001–021 snapshot to reviewed022–025;
   preserve old balances, ledgers, unknown jobs/orders, source scopes, grants and
   legacy idempotency request parameters. Dump/restore/restart that candidate.
2. Confirm existing ordinary/API-cookie/bootstrap/external-JWT/legacy OAuth
   credentials gain no billing capability. Exercise explicit owner approval,
   delegated read/manage rails and both policy/envelope CAS versions. Remove,
   rotate, reduce scopes/rails and change membership while mutations wait; reject
   stale authority at the final database lock without expanding child grants.
3. In fixture-enabled configuration, show a gross quote and immutable provider/
   fee snapshot for managed direct/smart requests. Confirm legacy zero, unknown
   cost hold/review, verified settlement, ceiling waivers/operator overrun and
   original key-month exposure. Poll/recover/redeliver without another fee.
4. With mock payment transport, review server terms and initiate human-only setup,
   reload after timeout with the original key, simulate signature-verified setup,
   replacement/detachment and owner-version changes. No redirects create mandates
   or credit. Test customer/environment/amount/method/document boundaries.
5. Enable a fixture recharge policy explicitly inside the approved owner envelope.
   Trigger two workers, manual refill, version/cap reduction, failure/authentication,
   month rollover and crashes before/after the external response. Confirm one
   original attempt, durable pending exposure/cooldown/quota and one ledger credit.
6. Complete only the original paused card PI using the mocked Stripe.js factory.
   Verify human-only authorization, no new PI/method/amount, revocation races,
   duplicate-click suppression, memory-only capability and webhook-only credit.
7. Inspect private billing on desktop and phone for missing capability, absent
   owner approval, requires-setup, enabled/disabled, pending, credited, declined,
   authentication and review/hold states. Switch identity/workspace/scopes and
   discard stale responses. Receipts, invoices and wallet credits remain distinct.
8. Review the installation-only queue. Reconcile original payment identity with
   authoritative evidence; refuse cancellation during a live claim and processing
   PI-as-unpaid. Resolve holds with an immutable reference/note/evidence trail;
   preserve ledger history and accepted jobs. No refund/charge action is implied.
9. Run native PostgreSQL races, full exact-head CI/type/catalog/build/browser,
   source/history secret scans and clean archive install/upgrade/restore. Inspect
   OpenAPI/MCP request examples and financial-effect metadata against actual
   registries; GET/balance/schema/quote do not create funding work.

## Remaining external/product gates

Section11 classification/defaults, outcome fees, BYOK fee-only verification,
fee-waiver/operator liability/review deadline and owner/delegation choices require
explicit human decision before real charging. The5% example is proposed, not an
accepted production price. Actual restricted-key/account/sandbox identity,
Checkout/setup/off-session/SCA/portal/invoice methods, bank outcomes, hosted
CSP/raw-byte WIF relay, alerts to verified opted-in billing recipients and live
merchant/tax/customer terms remain separately authorized verification gates.
The USD50 provider budget is not a Stripe budget. Source merge is not activation.
