import { createHash } from 'node:crypto';
import type { Principal } from '@media-router/engine';

/** A local persistence namespace, never a credential or authorization capability. */
export function sessionRecoveryScope(principal: Principal): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: principal.workspaceId,
        keyId: principal.keyId ?? null,
        membershipId: principal.membershipId ?? null,
        kind: principal.bootstrap ? 'bootstrap' : (principal.keyKind ?? 'unknown'),
        identity: principal.identity ?? null,
        scopes: [...principal.scopes].sort(),
        policy: principal.policy ?? null,
        maxCostMicros: principal.maxCostMicros ?? null,
      }),
    )
    .digest('hex');
}
