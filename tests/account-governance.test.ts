import { describe, expect, it } from 'vitest';
import { keyScopes } from '@media-router/contracts';
import { AccountGovernanceStore } from '../packages/engine/src/account-governance.js';
import { governanceFixture } from './governance-fixture.js';

describe.skipIf(!process.env.TEST_DATABASE_URL)('private account governance adapter', () => {
  it('uses current admin authority; keeps caps and stable identity through rotation; never lists secrets', async () => {
    const f = await governanceFixture();
    const store = new AccountGovernanceStore(f.pool);
    try {
      const adminKey = await f.accounts.createKey(f.workspaceId, {
        name: 'Admin',
        scopes: [...keyScopes],
      });
      const admin = (await f.accounts.authenticate(adminKey.token))!;
      await store.updateKey(admin, f.key.id, { name: 'Production', monthlyCapMicros: 100 });
      const before = (await store.listKeys(admin)).find((k) => k.id === f.key.id)!;
      expect(before).toMatchObject({
        name: 'Production',
        monthlyCapMicros: 100,
        secretVersion: 1,
        grossDebitMicros: 0,
        heldMicros: 0,
        legacyCoverage: 'since_cutover',
      });
      const rotated = await store.rotateKey(admin, f.key.id, 1);
      expect(rotated.id).toBe(f.key.id);
      expect(rotated.secretVersion).toBe(2);
      expect(await f.accounts.authenticate(f.key.token)).toBeNull();
      expect(await f.accounts.authenticate(rotated.token)).toMatchObject({
        keyId: f.key.id,
        monthlyCapMicros: 100,
        keySecretVersion: 2,
      });
      const keys = await store.listKeys(admin);
      expect(JSON.stringify(keys)).not.toMatch(/token|hash/);
      expect(keys.find((k) => k.id === f.key.id)).toMatchObject({
        secretVersion: 2,
        monthlyCapMicros: 100,
        name: 'Production',
      });
      await expect(store.rotateKey(admin, f.key.id, 1)).rejects.toMatchObject({
        code: 'key_rotation_conflict',
      });
      await store.updateKey(admin, adminKey.id, { monthlyCapMicros: 0 });
      // The earlier unrestricted principal is stale: cap cannot be bypassed by
      // administering keys after an administrator restricts that credential.
      await expect(
        store.updateKey(admin, adminKey.id, { monthlyCapMicros: null }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
      await expect(
        store.createKey(admin, { name: 'Bypass', scopes: ['read', 'generate'] }),
      ).rejects.toMatchObject({ code: 'policy_denied' });
    } finally {
      await f.close();
    }
  });
});
