import type { Principal } from '@media-router/engine';
import { sessionRecoveryScope } from './session-recovery.js';

/** Compatibility export for the Playground hook; C0 owns the identity projection. */
export { sessionRecoveryScope as browserRecoveryScope } from './session-recovery.js';

/** Expected browser authority is a concurrency guard. It never grants workspace access. */
export function assertBrowserRecoveryScope(
  principal: Principal,
  headers: Record<string, string | string[] | undefined>,
): void {
  const workspace = headers['x-opengen-workspace'];
  const scope = headers['x-opengen-recovery-scope'];
  // Existing raw HTTP/MCP callers authenticate normally without browser cache bindings.
  if (workspace === undefined && scope === undefined) return;
  if (
    typeof workspace !== 'string' ||
    typeof scope !== 'string' ||
    workspace !== principal.workspaceId ||
    scope !== sessionRecoveryScope(principal)
  )
    throw Object.assign(
      new Error(
        'Your authorized workspace or identity changed. Review the current request before submitting.',
      ),
      { statusCode: 409, code: 'browser_authority_changed' },
    );
}
