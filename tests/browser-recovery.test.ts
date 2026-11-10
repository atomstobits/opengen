import { describe, expect, it } from 'vitest';
import type { Principal } from '@media-router/engine';
import { assertBrowserRecoveryScope } from '../apps/server/src/browser-recovery';
import { sessionRecoveryScope } from '../apps/server/src/session-recovery';

const principal: Principal = {
  workspaceId: 'synthetic-workspace-a',
  keyId: 'synthetic-key-a',
  scopes: ['read', 'generate'],
  keyKind: 'browser',
  membershipId: 'synthetic-member-a',
};
const expectedHeaders = {
  'x-opengen-workspace': principal.workspaceId,
  'x-opengen-recovery-scope': sessionRecoveryScope(principal),
};

describe('expected browser authority guard', () => {
  it('allows existing raw HTTP/MCP callers with no browser binding', () => {
    expect(() => assertBrowserRecoveryScope(principal, {})).not.toThrow();
  });

  it('accepts the exact server-derived workspace, actor and effective authority', () => {
    expect(() => assertBrowserRecoveryScope(principal, expectedHeaders)).not.toThrow();
    expect(() =>
      assertBrowserRecoveryScope({ ...principal, scopes: ['generate', 'read'] }, expectedHeaders),
    ).not.toThrow();
  });

  it('rejects cookie workspace/identity/permission changes before admission', () => {
    for (const changed of [
      { workspaceId: 'synthetic-workspace-b' },
      { keyId: 'synthetic-key-b' },
      { membershipId: 'synthetic-member-b' },
      { identity: { issuer: 'https://identity.example.test', subject: 'another-identity' } },
      { scopes: ['read'] as Principal['scopes'] },
      { policy: { fallback: false } },
      { maxCostMicros: 10 },
    ]) {
      try {
        assertBrowserRecoveryScope({ ...principal, ...changed }, expectedHeaders);
        expect.fail('Changed authority must not reach admission.');
      } catch (cause) {
        expect(cause).toMatchObject({ statusCode: 409, code: 'browser_authority_changed' });
        expect((cause as Error).message).not.toContain('synthetic-key');
      }
    }
  });

  it('rejects partial, duplicated or forged expected bindings', () => {
    for (const headers of [
      { 'x-opengen-workspace': principal.workspaceId },
      { 'x-opengen-recovery-scope': expectedHeaders['x-opengen-recovery-scope'] },
      { ...expectedHeaders, 'x-opengen-workspace': '' },
      { ...expectedHeaders, 'x-opengen-recovery-scope': 'forged-scope' },
      { ...expectedHeaders, 'x-opengen-workspace': [principal.workspaceId, principal.workspaceId] },
      {
        ...expectedHeaders,
        'x-opengen-recovery-scope': [expectedHeaders['x-opengen-recovery-scope']],
      },
    ])
      expect(() => assertBrowserRecoveryScope(principal, headers)).toThrow(
        /workspace or identity changed/,
      );
  });
});
