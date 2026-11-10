/** Operational logs never serialize provider/SQL messages, payloads, URLs or credentials. */
export function operationalError(error: unknown): { code: string; sqlState?: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code))
    return { code: 'database_error', sqlState: code };
  const safeCodes = new Set([
    'storage_not_configured',
    'original_credentials_unavailable',
    'legacy_capacity_unreconciled',
    'dispatch_configuration',
    'dispatch_backpressure',
    'billing_hold',
    'insufficient_balance',
    'policy_denied',
    'key_monthly_cap_exceeded',
    'input_preparation_failed',
    'delivery_attempt_mismatch',
    'result_attempt_mismatch',
    'authentication_not_configured',
    'database_not_configured',
  ]);
  return { code: typeof code === 'string' && safeCodes.has(code) ? code : 'operation_failed' };
}
