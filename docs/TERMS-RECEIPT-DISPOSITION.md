# Exact Terms receipt disposition

Candidate operator procedure, 9 November 2026. This is a narrow owner-maintenance procedure for one reviewed, eligible `mr_terms_receipts` record. It adds no application endpoint, runtime helper, migration, automatic expiry, bypass flag or policy activation. The current Terms remain draft/inactive; draft-only sign-in records no assent receipt. A local synthetic test is not evidence that a hosted receipt has been disposed of or a real request resolved.

## Review before execution

Use the existing private [privacy-request process](PRIVACY-OPERATIONS.md), including requests from people who cannot sign in. Determine the actual identity/authority and applicable request scope through proportionate verification; an email match, guessed subject, workspace role or API grant alone does not authorize this action. Do not require a person to open an account merely to raise a rights request.

The responsible privacy/legal reviewer must decide and record whether this particular record remains necessary for its actual account/agreement, security, dispute or legal-record purpose, whether an applicable preservation/hold prevents disposition, and whether a valid rights request or the operator's adopted retention criteria makes it eligible now. Do not invent a fixed period, automatic eligibility rule, blanket legal exemption or new retention promise. A table's technical immutability does not itself establish a legal reason to retain a record forever. Unresolved eligibility or conflicting preservation duties stop the action and receive the existing escalation/review process.

Prepare a protected case/disposition record outside Git, public issues, CI artifacts and general application logs. Keep only what that case requires:

- Opaque case reference, request/decision dates, responsible reviewer and maintenance operator, and the actual eligibility reason, approved scope and preservation/hold check.
- The exact issuer, subject, policy version, policy digest and **full-precision stored `accepted_at`** of the one approved receipt, held in the restricted execution input/reference. Avoid copying the raw tuple into multiple tickets, command arguments, shell history or ordinary logs. Apply the case's own approved minimization/retention criteria to that working material.
- Approval for the exact database/schema, maintenance role and procedure/source version; expected affected count **one**; and the neighboring records that must remain unchanged, referenced without unnecessary disclosure.
- The active-database action, any necessary handling of protected backups/restores, expected completion evidence and the requester response. Document what remains and why. Active-row removal is not proof of erasure from logs, backup copies, an identity provider or other independent systems.

The approval is specific to the stored receipt and its timestamp. A later qualified sign-in can create a new receipt after disposition. The old approval must not erase that new record. Disposition does not close an account, revoke a session/grant, accept a policy, erase media or alter jobs, membership, money or invoice history.

## Maintenance boundary

Use an already authorized database-owner maintenance connection, separate from ordinary application/customer access. PostgreSQL table ownership or equivalent privileged maintenance authority is what permits the scoped trigger change; this procedure grants no role or additional privilege. Verify the deployed application role is not a superuser, table owner, or a member able to assume the owner role and cannot alter this trigger. A synthetic restricted-role test does not establish the actual hosted grants. If the application has owner-equivalent access, separate that authority before calling this maintenance boundary qualified.

Identify the exact schema and current migration029 table/trigger definitions. Both named immutability triggers must exist in their reviewed, normally enabled state (`tgenabled='O'`), and the maintenance session must use `session_replication_role=origin`. Unexpected trigger definitions/state, inheritance/schema changes or target mismatch require review; do not normalize them silently.

Finish review before opening the transaction. Arrange a short maintenance window: an `ACCESS EXCLUSIVE` table lock blocks other reads/writes, including sign-in receipt work, until transaction end. PostgreSQL documents that this lock conflicts with all other table-lock modes, and that `ALTER TABLE` trigger operations require the relevant table privilege. [PostgreSQL17 locking](https://www.postgresql.org/docs/17/explicit-locking.html), [ALTER TABLE](https://www.postgresql.org/docs/17/sql-altertable.html)

Capture the target using a parameterized private read that returns `accepted_at::text`. Preserve its full fractional seconds and timezone offset. The JavaScript `Date` returned by ordinary receipt reads has only millisecond precision and is **not** the compare-and-delete timestamp. Keep issuer/subject strings exact; do not trim, normalize URLs, match email, broaden the version or omit the digest/time predicates.

## One transaction, one target

The qualification test contains a file-local synthetic example. It is not a production export or CLI. The operator's reviewed maintenance client must implement all of the following on **one dedicated connection**:

1. Start `BEGIN ISOLATION LEVEL SERIALIZABLE`. Set transaction-local `lock_timeout='2s'`, `statement_timeout='5s'` and `idle_in_transaction_session_timeout='5s'`, or separately review suitable bounded values for that deployment. Do not wait for human approval while holding the lock. A timeout or serialization failure aborts the action; do not drop the bounds or retry with broader predicates.
2. Lock the fully qualified `mr_terms_receipts` table in `ACCESS EXCLUSIVE` mode. Verify the original trigger states and `session_replication_role=origin` while holding the lock.
3. Disable **only** `mr_terms_receipts_no_update_delete` inside this transaction. Never change `mr_terms_receipts_no_truncate`, use `DISABLE TRIGGER ALL/USER`, change replication role, drop a trigger/constraint or install a persistent bypass.
4. Execute one parameterized DELETE with all five approved target fields and `RETURNING`. The predicate is:

   ```sql
   WHERE issuer=$1
     AND subject=$2
     AND policy_version=$3
     AND policy_digest=$4
     AND accepted_at=$5::timestamptz
   ```

   The maintenance client must require exactly one returned row and verify it matches the approved tuple, including full-precision `accepted_at::text`. Zero rows, an unexpected returned value or any error means **ROLLBACK**, never success or a wider DELETE. No UPDATE, bulk account deletion or TRUNCATE is part of this procedure.

5. Re-enable `mr_terms_receipts_no_update_delete` **before COMMIT**, verify both immutability triggers again have their original enabled state, and verify the selected peer records remain unchanged. Commit only after these checks. The exclusive lock stays held while the trigger is temporarily disabled, preventing another session from using that interval.
6. On any failure, roll back the same transaction and release the connection. Transactional rollback restores both the deleted row and trigger changes. Do not commit a disabled-trigger state as cleanup. Read back trigger state and relevant records through a fresh authorized transaction after completion. [PostgreSQL ROLLBACK](https://www.postgresql.org/docs/17/sql-rollback.html)

The fully qualified table identifier is fixed during review, not taken from a customer request; the five receipt values are bound parameters. Database credentials and receipt fields do not belong in argv or shared transcripts. This procedure does not require a new database function, `SECURITY DEFINER`, application flag or runtime export.

If the connection is lost while COMMIT may have been sent, treat the outcome as unknown until readback establishes the exact target's presence/absence and normal trigger state. Do not infer rollback from a lost client response or issue a new broad deletion. Reconcile the protected case record before any subsequent action. A missing or changed receipt, including a new timestamp for a fresh acceptance, needs a new determination rather than reuse of the old approval.

## Completion and retained copies

Record the opaque case reference, actual operator/reviewer, execution time and source/procedure version, committed/rolled-back/unknown outcome, affected count and restricted verification evidence. Avoid attaching a fresh full-table export or keeping additional raw receipt copies merely to prove deletion. Document any lawfully retained case/recovery record, its purpose, access owner and actual review/rotation criteria; this runbook supplies no numeric period.

Confirm the approved target alone is absent after a successful commit, retained peers are unchanged and the normal guards are enabled. Verify forbidden ordinary UPDATE/DELETE/TRUNCATE on synthetic fixtures, **not by issuing destructive probes against real customer records**. Native qualification uses a restricted synthetic non-owner role to prove it cannot disable the guard even when granted DML privileges. No ordinary runtime role is elevated for a rehearsal.

Backups and restore handling must follow the operator's approved recovery/retention plan. Record a minimal protected disposition reference so a restore does not silently revive a disposed original receipt for normal use. Reconcile the exact original tuple before resuming access; do not delete a later receipt merely because issuer/subject/version match. Do not promise immediate removal from every backup or override necessary preservation controls. Report the completed scope, any retained copies/reasons and the available request/review path through the existing privacy procedure.

## Qualification boundary

`tests/terms-receipt-disposition.test.ts` uses only isolated schemas and synthetic identities. It checks one-target deletion with peers preserved, ordinary mutation refusal before/after, rollback after a real SQL error following DELETE, all five target mismatches and stale approval after a fresh receipt. Native-only role qualification requires an explicitly disposable loopback PostgreSQL cluster and permission to create/remove a uniquely named NOLOGIN fixture role; if absent, that check is skipped and is not native privilege evidence. The fixture restores role/session state and removes its grants/role on completion.

The root-owned harness must record exact-commit native results before this procedure is called qualified. These tests do not run themselves, create a real account, accept active Terms, change actual application grants, dispose of hosted records or authorize policy activation. Actual operator adoption, eligibility decisions, deployed privileges and backup/restore handling remain separate operational gates.

## Local source evidence — 9 November 2026

Node22.23.2arm64 with a disposable loopback PostgreSQL17 cluster: the focused receipt, disposition, populated-upgrade, login and proxy/transport cohort passed **102 tests across six files, with no skips**. This includes all five disposition cases and the restricted-role privilege check. No real receipt or hosted database was used. Exact-head CI and reviewer approval are recorded on the private source PR; local mechanism evidence does not complete the actual operator retention/eligibility record or qualify deployed grants and recovery-copy handling.
