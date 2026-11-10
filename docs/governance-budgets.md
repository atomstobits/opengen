# Managed monthly key limits

`KeyBudgetStore` is a transaction-client domain service. Apply the unnumbered
`schema-proposals/governance-caps.sql` through the integration-owned migration.
No old migration changes. These methods alone do not enable admission enforcement.

At final admission, lock the workspace, revalidate current key/member/grant and
narrow policy after preparation, quote every eligible fallback, insert the job,
then reserve the key exposure alongside workspace reserve and ledger in one
transaction. Pass only a trusted stable **API source key**. Browser/member grants
without a source key continue to follow workspace/grant policy; ephemeral browser
keys are not monthly budget subjects. `reserveInTransaction` records every managed
source-key reservation, including when its cap is unset. A cap added later therefore
includes already tracked exposure. OAuth access/refresh and secret rotation keep
this same source key ID.

A monthly limit measures gross managed customer debit plus unresolved held
exposure, in integer micro-USD. The month is UTC wall-clock time after acquiring
the workspace lock, not request start, provider completion, or a local timezone.
Settlement/release uses the original reservation bucket even in a later month.
Retrying reservation/settlement does not add exposure twice. Customer debit cannot
exceed the existing job reserve; provider overrun belongs to the operator and is
separate. Unknown acceptance or cost stays held until the existing accounting
engine has evidence to settle. A confirmed never-submitted rejection may settle
zero, while a timeout may not. Ordinary credits, top-ups and refunds never restore
monthly quota. BYOK external bills are not capped by the gateway ledger.

The migration records an explicit `cap_coverage_started_at`. Pre-cutover
unattributed jobs have no reconstructed key exposure: absence is unknown history,
not proof of zero. Key settings and exports must show that date. A first partial
month is tracked **since that date**, not a complete historical monthly statement.
Never backfill to the current admin/key. Accepted legacy jobs can finish without
creating a new cap reservation. New managed work with a known source key must
never silently skip reservation because the subject is absent or archived.

`setCapInTransaction` is an internal accounting write, not an authorization API.
Its adapter must call `requireGovernanceAdmin(client, actor)` in the same transaction
before writing. Lowering below existing exposure is allowed; existing accepted
work completes and new admissions fail until exposure fits. Cap updates use the
same workspace-first lock as admission. Do not call a pool method from inside
these methods; pool-size-one is supported. Never call providers while locks are held.

Run local isolated SQL fixtures with:

```sh
node scripts/test-governance-sql.mjs tests/key-budgets.test.ts
```

Native PostgreSQL concurrency cases require `TEST_DATABASE_URL` for a disposable
DB and `TEST_NATIVE_POSTGRES=1`; PGlite is explicitly not race qualification.
The integration owner runs combined reserve/ledger, upgrade, restart and native
race proofs after wiring. No provider call or payment is needed for these checks.
