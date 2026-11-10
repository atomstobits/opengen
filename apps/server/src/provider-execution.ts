/** Trusted runtime control, shared by API and worker; never generation input. */
export function readProviderExecutionConfiguration(env: NodeJS.ProcessEnv): boolean {
  const enabled = env.OPENGEN_PROVIDER_EXECUTION_ENABLED ?? 'true';
  const sandbox = env.OPENGEN_BILLING_SANDBOX ?? 'false';
  if (!['true', 'false'].includes(enabled) || !['true', 'false'].includes(sandbox))
    throw new Error('Provider execution and sandbox controls must be exactly true or false.');

  let sandboxDatabase = false;
  if (env.DATABASE_URL) {
    try {
      const database = new URL(env.DATABASE_URL);
      const name = decodeURIComponent(database.pathname.slice(1));
      if (
        !['postgres:', 'postgresql:'].includes(database.protocol) ||
        !name ||
        [...database.searchParams.keys()].some((key) =>
          ['database', 'dbname', 'connectionstring'].includes(key.toLowerCase()),
        )
      )
        throw new Error('Invalid database target.');
      sandboxDatabase = name.toLowerCase().startsWith('opengen_billing_sandbox');
    } catch {
      throw new Error('Provider execution requires an explicit, unambiguous database URL.');
    }
  }
  // Workers receive the database but no Stripe credentials or API-only billing
  // configuration. The reserved namespace independently fences the same sandbox
  // even if its worker omitted, or mistakenly enabled, the shared control.
  return enabled === 'true' && sandbox !== 'true' && !sandboxDatabase;
}
