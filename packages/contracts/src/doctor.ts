/** Configuration diagnosis is read-only and never proves live provider availability or spend consent. */
export interface WorkspaceReadiness {
  balance: { availableMicros: number; reservedMicros: number; currency: 'USD' };
  billingHold: boolean;
  configuredRoutes: { managed: string[]; byok: string[] };
  /** Operator scope only. No fixture fingerprint or private asset identifier is disclosed. */
  executionScope?: {
    profile: 'unrestricted' | 'qualification-sg-v1';
    /** Only conflicts belonging to this authenticated workspace. */
    queuedConflicts: number;
    /** Runtime-wide block, without foreign workspace identifiers or counts. */
    transitionBlocked: boolean;
  };
}
export interface DoctorBlocker {
  code: string;
  message: string;
  nextCommand: string;
}
export interface DoctorReport {
  authenticated: true;
  authorized: boolean;
  account: { issuer: string; subject: string } | null;
  payingWorkspace: { id: string; name: string | null };
  scopes: string[];
  policy: import('./index').RoutingPolicy | null;
  maxCostMicros: number | null;
  balance: WorkspaceReadiness['balance'];
  billingHold: boolean | null;
  executionScope?: WorkspaceReadiness['executionScope'];
  executableRoutes: {
    managed: string[];
    byok: string[];
    evidence: 'configuration-only';
    requestQuoteRequired: true;
  };
  blockers: DoctorBlocker[];
  nextBlocker: DoctorBlocker | null;
  nextCommand: string;
  notices: string[];
}
