import { expect, it } from 'vitest';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery';
import type { Principal } from '@media-router/engine';
const actor: Principal = {
  workspaceId: 'owner',
  scopes: ['read', 'generate'],
  keyId: 'key-a',
  keyKind: 'api',
};
it('namespaces private browser recovery by identity, workspace and effective authority', () => {
  const scope = sessionRecoveryScope(actor);
  expect(scope).toMatch(/^[a-f0-9]{64}$/);
  expect(scope).not.toContain('owner');
  expect(sessionRecoveryScope({ ...actor, scopes: ['generate', 'read'] })).toBe(scope);
  for (const change of [
    { workspaceId: 'other' },
    { keyId: 'key-b' },
    { scopes: ['read'] },
    { membershipId: 'other-member' },
    { maxCostMicros: 1 },
    { identity: { issuer: 'https://issuer.invalid', subject: 'other' } },
  ])
    expect(sessionRecoveryScope({ ...actor, ...change } as Principal)).not.toBe(scope);
});
