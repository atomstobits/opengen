import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  AccountGovernanceStore,
  KeyBudgetStore,
  createEngine,
  keyScopes,
} from '@media-router/engine';
import { isolatedEngineDatabase } from './helpers/isolated-engine';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Synthetic identities only. This exercises an already-authenticated request
 * whose key authority changes before the team mutation's final transaction. */
describe.skipIf(!databaseUrl)(
  'team mutations revalidate capped or invalidated source authority',
  () => {
    for (const change of ['cap', 'rotation', 'revocation'] as const) {
      it(`denies a stale unrestricted API actor after ${change} before inviting an administrator`, async () => {
        const isolated = await isolatedEngineDatabase(databaseUrl!, 'team_authority');
        const engine = isolated.bind(
          createEngine({
            databaseUrl: isolated.databaseUrl,
            poolSize: 1,
            providerEnv: {},
            vaultKey: '0'.repeat(64),
          }),
        );
        try {
          await engine.initialize();
          const workspaceId = `authority-${randomUUID()}`;
          await engine.ensureWorkspace(workspaceId);
          const key = await engine.accounts.createKey(workspaceId, {
            name: 'Synthetic team administrator',
            scopes: [...keyScopes],
          });
          const actor = (await engine.accounts.authenticate(key.token))!;
          expect(actor.monthlyCapMicros).toBeUndefined();
          const target = await engine.accounts.identity(
            'https://identity.fixture.invalid',
            `synthetic-target-${randomUUID()}`,
          );
          const governance = new AccountGovernanceStore(engine.pool);
          const admin = { workspaceId, bootstrap: true as const, scopes: ['keys:write' as const] };
          if (change === 'cap') {
            await governance.updateKey(admin, key.id, { monthlyCapMicros: 0 });
            expect(await engine.accounts.authenticate(key.token)).toMatchObject({
              monthlyCapMicros: 0,
            });
          } else if (change === 'rotation') {
            await governance.rotateKey(admin, key.id, 1);
            expect(await engine.accounts.authenticate(key.token)).toBeNull();
          } else {
            await governance.revokeKey(admin, key.id);
            expect(await engine.accounts.authenticate(key.token)).toBeNull();
          }
          await expect(
            engine.accounts.inviteMember(actor, { ...target.identity!, role: 'admin' }),
          ).rejects.toMatchObject({ code: 'policy_denied', statusCode: 403 });
          expect(
            (
              await engine.pool.query(
                'SELECT count(*) FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3',
                [workspaceId, target.identity!.issuer, target.identity!.subject],
              )
            ).rows[0].count,
          ).toBe('0');
        } finally {
          await engine.close();
          await isolated.close();
        }
      });
    }
  },
);

describe.skipIf(!databaseUrl || process.env.TEST_NATIVE_POSTGRES !== '1')(
  'native PostgreSQL team authority race',
  () => {
    it('rechecks a concurrently lowered cap after an observed workspace lock wait', async () => {
      const isolated = await isolatedEngineDatabase(databaseUrl!, 'team_authority_race');
      const engine = isolated.bind(
        createEngine({
          databaseUrl: isolated.databaseUrl,
          poolSize: 3,
          providerEnv: {},
          vaultKey: '0'.repeat(64),
        }),
      );
      let lowering: PoolClient | undefined;
      let pending: Promise<unknown> | undefined;
      let checked: Promise<unknown> | undefined;
      try {
        await engine.initialize();
        const workspaceId = `authority-${randomUUID()}`;
        await engine.ensureWorkspace(workspaceId);
        const key = await engine.accounts.createKey(workspaceId, {
          name: 'Synthetic waiting administrator',
          scopes: [...keyScopes],
        });
        const actor = (await engine.accounts.authenticate(key.token))!;
        expect(actor.monthlyCapMicros).toBeUndefined();
        const target = await engine.accounts.identity(
          'https://identity.fixture.invalid',
          `synthetic-waiting-target-${randomUUID()}`,
        );
        lowering = await engine.pool.connect();
        const blockerPid = (await lowering.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await lowering.query('BEGIN');
        await new KeyBudgetStore().setCapInTransaction(lowering, workspaceId, key.id, 0);

        pending = engine.accounts.inviteMember(actor, { ...target.identity!, role: 'admin' });
        // Observe the rejection immediately; cleanup also consumes it if an
        // earlier assertion fails before the cap transaction is committed.
        checked = expect(pending).rejects.toMatchObject({ code: 'policy_denied', statusCode: 403 });
        void checked.catch(() => {});
        let observedWait = false;
        const deadline = Date.now() + 5_000;
        while (!observedWait && Date.now() < deadline) {
          observedWait = (
            await engine.pool.query(
              'SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))) AS waiting',
              [blockerPid],
            )
          ).rows[0].waiting;
        }
        // Native server lock evidence is required. Elapsed time never proves
        // that the invitation reached the workspace serialization boundary.
        expect(observedWait).toBe(true);
        await lowering.query('COMMIT');
        await checked;
        expect(
          (
            await engine.pool.query('SELECT monthly_cap_micros FROM mr_api_keys WHERE id=$1', [
              key.id,
            ])
          ).rows[0].monthly_cap_micros,
        ).toBe('0');
        expect(
          (
            await engine.pool.query(
              'SELECT count(*) FROM mr_memberships WHERE workspace_id=$1 AND issuer=$2 AND subject=$3',
              [workspaceId, target.identity!.issuer, target.identity!.subject],
            )
          ).rows[0].count,
        ).toBe('0');
      } finally {
        if (lowering) {
          await lowering.query('ROLLBACK');
          lowering.release();
        }
        await Promise.allSettled([pending, checked]);
        await engine.close();
        await isolated.close();
      }
    });
  },
);
