/** Expected UI authority is a concurrency fence, never an authentication credential. */
export interface PrivateWorkspaceAuthority {
  workspaceId: string | null;
  recoveryScope?: string | null;
}
export function hasWorkspaceAuthority(
  authority: PrivateWorkspaceAuthority,
): authority is { workspaceId: string; recoveryScope: string } {
  return (
    typeof authority.workspaceId === 'string' &&
    authority.workspaceId.length > 0 &&
    authority.workspaceId.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(authority.workspaceId) &&
    typeof authority.recoveryScope === 'string' &&
    authority.recoveryScope.trim().length > 0 &&
    authority.recoveryScope.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(authority.recoveryScope)
  );
}
export function privateWorkspaceHeaders(
  authority: PrivateWorkspaceAuthority,
): Record<string, string> {
  if (!hasWorkspaceAuthority(authority))
    throw new Error('Verify the current workspace authority before a private request.');
  return {
    'x-opengen-workspace': authority.workspaceId,
    'x-opengen-recovery-scope': authority.recoveryScope,
  };
}

/** Private list-only projection. Details and signed outputs are fetched after an explicit selection. */
export interface ActivityItem {
  id: string;
  modelId: string;
  operation: string;
  providerId: string | null;
  endpointRegion: string | null;
  routeId: string;
  deploymentId: string;
  status: string;
  deliveryStatus?: string | null;
  createdAt: string;
  updatedAt: string;
  reservedMicros: number;
  settledMicros: number | null;
  heldMicros: number | null;
  ledgerReservedMicros: number | null;
  accountingState: 'reconciled' | 'unknown' | 'mismatch';
  attribution: {
    kind: 'api' | 'browser' | 'oauth' | 'bootstrap' | 'unknown';
    keyId: string | null;
    membershipId: string | null;
    grantId: string | null;
  } | null;
  project: string | null;
  progress?: { phase: string; percent: number | null; observedAt: string; source: string } | null;
}
export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}
export const activityFilterFields = [
  ['modelId', 'Exact model ID'],
  ['providerId', 'Provider ID'],
  ['deploymentId', 'Deployment ID'],
  ['endpointRegion', 'Endpoint region'],
  ['operation', 'Operation'],
  ['keyId', 'API key ID'],
  ['status', 'Generation status'],
  ['project', 'Project'],
] as const;
export type ActivityFilters = Partial<
  Record<(typeof activityFilterFields)[number][0] | 'since' | 'until', string>
>;

/** Date inputs represent UTC days: since inclusive, until exclusive on the following day. */
export function activityQuery(filters: ActivityFilters, cursor?: string | null): string {
  const query = new URLSearchParams({ limit: '25' });
  for (const [field] of activityFilterFields) {
    const value = filters[field]?.trim();
    if (value) query.set(field, value);
  }
  if (filters.since) query.set('since', new Date(`${filters.since}T00:00:00.000Z`).toISOString());
  if (filters.until)
    query.set(
      'until',
      new Date(Date.parse(`${filters.until}T00:00:00.000Z`) + 86_400_000).toISOString(),
    );
  if (cursor) query.set('cursor', cursor);
  return query.toString();
}
export function activityIdentity(item: ActivityItem): string {
  if (!item.attribution || item.attribution.kind === 'unknown') return 'Unknown (legacy)';
  const actor = item.attribution.membershipId
    ? `Member ${item.attribution.membershipId}`
    : item.attribution.keyId
      ? `Key ${item.attribution.keyId}`
      : 'Unknown identity';
  return `${item.attribution.kind} · ${actor}`;
}
export function moneyMicros(value: number | null | undefined): string {
  if (value == null || !Number.isSafeInteger(value)) return 'Unknown';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value / 1_000_000);
}

/** Never round an oversized page total into a plausible dollar amount. */
export function sumMicros(values: readonly number[]): number | null {
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  return total > BigInt(Number.MAX_SAFE_INTEGER) || total < BigInt(Number.MIN_SAFE_INTEGER)
    ? null
    : Number(total);
}
