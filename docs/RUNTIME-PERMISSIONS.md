# Runtime database permissions

Use distinct API and worker identities with individually granted Secret Manager references. The PostgreSQL application role needs ownership of its database and tables so startup migrations can run. Application authorization enforces tenant boundaries.

## Complete the bootstrap after migrations

Cloud SQL assigns a new built-in PostgreSQL user the broad `cloudsqlsuperuser` role by default, with database-creation and role-creation privileges. The bootstrap provisions the initial user. Qualify the narrower runtime role after the exact application's migrations pass. [Cloud SQL database roles](https://docs.cloud.google.com/sql/docs/postgres/create-manage-users#replace_database_roles_for_an_existing_user)

First inspect the selected database, current role, schema permissions, table owners and migration checksums. Confirm this is the dedicated application database and preserve the existing credential. Connect as the database administrator and supply the reviewed `app_db` and `runtime_role` as `psql` variables. Rehearse the ownership change in a transaction that rolls back:

```sql
BEGIN;
ALTER DATABASE :"app_db" OWNER TO :"runtime_role";
GRANT USAGE, CREATE ON SCHEMA public TO :"runtime_role";
-- Inspect the database owner and schema CREATE permission here.
ROLLBACK;
```

After reviewing the rehearsal, repeat the two statements in a transaction ending in `COMMIT`. This preserves schema access before removing inherited broad privileges.

Use the Cloud SQL control plane to replace the runtime user's role memberships with an empty list. Set the project, instance and runtime username in the operator shell for the reviewed installation.

```sh
gcloud sql users assign-roles "$OPENGEN_DATABASE_USER" \
  --project "$OPENGEN_PROJECT_ID" \
  --instance "$OPENGEN_SQL_INSTANCE" \
  --type=BUILT_IN \
  --database-roles= \
  --revoke-existing-roles
```

The empty-role replacement preserves the existing password. Keep the database URL and administrator credentials private. [Cloud SQL role assignment](https://docs.cloud.google.com/sdk/gcloud/reference/sql/users/assign-roles)

## Verify the result with a fresh connection

Query metadata using the runtime credential and its private Cloud SQL connector:

```sql
SELECT current_user, rolsuper, rolcreatedb, rolcreaterole,
       rolreplication, rolbypassrls
FROM pg_roles WHERE rolname = current_user;

SELECT datname, pg_get_userbyid(datdba) AS owner
FROM pg_database WHERE datname = current_database();

SELECT nspname, pg_get_userbyid(nspowner) AS owner,
       has_schema_privilege(current_user, nspname, 'CREATE') AS can_create
FROM pg_namespace WHERE nspname = 'public';

SELECT r.rolname, m.admin_option
FROM pg_auth_members m
JOIN pg_roles r ON r.oid = m.roleid
JOIN pg_roles u ON u.oid = m.member
WHERE u.rolname = current_user;
```

Expect the runtime role to own the database and application tables. The `public` schema owner `pg_database_owner` follows the database owner on PostgreSQL 17. Require schema CREATE and confirm that superuser, CREATEDB, CREATEROLE, replication and RLS bypass are all false, with no broad role memberships. Compare every applied migration checksum with the exact release source.

A hosted reduced-role initialization on the earlier 13-migration cohort passed with an empty adapter list and left the migration checksums unchanged. Repeat the database-only check for the exact target image before relying on that role for a new deployment. Keep execution identifiers and credential references in ignored local receipts. [Hosted activation](CORE-HOSTED-ACTIVATION.md)

## Dedicated Terms receipt owner and DDL migrations

After migration `029.sql`, hardened hosted installations transfer ownership of `mr_terms_receipts` to a dedicated `NOLOGIN` owner role with zero permanent members (for example `opengen_terms_receipts_owner`) while leaving the application runtime role with DML-only privileges (`SELECT`, `INSERT`). This prevents the runtime role from executing `ALTER TABLE mr_terms_receipts` to disable `mr_terms_receipts_no_update_delete` or `mr_terms_receipts_no_truncate`.

Because the runtime role does not own `mr_terms_receipts`, **any forward SQL migration containing DDL on `mr_terms_receipts` (such as `036.sql` widening `mr_terms_receipts_method_check`) will fail at runtime startup with PostgreSQL `42501` (`must be owner of table mr_terms_receipts`)**.

- Prefer companion tables owned by the runtime role instead of altering `mr_terms_receipts`.
- When an approved migration must alter `mr_terms_receipts`, apply the `mr_terms_receipts` DDL through a guarded, audited owner-maintenance step before rolling out the new image:
  1. Take a verified database backup and pause workers.
  2. Run the `mr_terms_receipts` DDL under a short-lived least-privilege maintenance session holding only the dedicated `mr_terms_receipts` owner role (never granting that role to the runtime user and never keeping permanent members on the owner role).
  3. Assert inside the same transaction that `mr_terms_receipts` stays owned by the dedicated `NOLOGIN` owner role and both immutability triggers remain enabled (`tgenabled = 'O'`).
  4. Create any non-receipt tables under the runtime role so it owns them natively, and record the exact SHA-256 checksum of the migration file in `mr_migrations`.
  5. Immediately revoke temporary database/schema grants and delete the ephemeral maintenance user before resuming API/worker rollout.
- `tests/terms-receipt-upgrade.test.ts` guards `packages/engine/migrations/` so any new migration altering `mr_terms_receipts` fails CI unless explicitly reviewed and allowlisted.
