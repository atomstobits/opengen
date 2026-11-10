import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AccountStore } from '@media-router/engine';

it('does not exchange a delegated source-key OAuth grant for a broader cookie session', async () => {
  const query = vi.fn();
  const store = new AccountStore({ query } as unknown as Pool);
  await expect(
    store.createSession({
      workspaceId: 'owner',
      keyId: '00000000-0000-4000-8000-000000000001',
      keyKind: 'oauth',
      grantId: '00000000-0000-4000-8000-000000000002',
      scopes: ['read'],
    }),
  ).rejects.toMatchObject({ code: 'policy_denied', statusCode: 403 });
  expect(query).not.toHaveBeenCalled();
});
