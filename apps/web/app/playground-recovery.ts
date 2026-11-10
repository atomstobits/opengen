import type { GenerateInput, Operation } from '@media-router/contracts';

type RecoveryKind =
  'draft' | 'submission' | 'job' | 'lineage' | 'last-result' | 'comparison-approval';
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `recoveryScope` is an opaque server-issued identity/effective-permission binding, not a token. */
export type RecoveryContext = {
  workspaceId: string;
  recoveryScope: string;
  scopes: readonly string[];
  modelId: string;
  operation: Operation;
};

type RecoverySession = {
  authenticated: boolean;
  workspaceId?: string;
  recoveryScope?: string;
  scopes?: readonly string[];
};

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Missing identity projection disables persistence; a workspace name alone cannot identify a caller. */
export function recoveryContext(
  session: RecoverySession | null,
  modelId: string,
  operation: Operation,
): RecoveryContext | null {
  if (
    !session?.authenticated ||
    !nonempty(session.workspaceId) ||
    !nonempty(session.recoveryScope) ||
    !Array.isArray(session.scopes) ||
    !session.scopes.every(nonempty) ||
    !nonempty(modelId)
  )
    return null;
  return {
    workspaceId: session.workspaceId,
    recoveryScope: session.recoveryScope,
    scopes: [...new Set(session.scopes)].sort(),
    modelId,
    operation,
  };
}

export function recoveryKey(context: RecoveryContext, kind: RecoveryKind): string {
  const parts = [
    context.workspaceId,
    context.recoveryScope,
    JSON.stringify([...new Set(context.scopes)].sort()),
    context.modelId,
    context.operation,
  ];
  if (!parts.every(nonempty) || !context.scopes.every(nonempty))
    throw new Error('A verified workspace and identity are required for browser recovery.');
  const scope = kind === 'last-result' ? parts.slice(0, 3) : parts;
  return `opengen.playground.v1:${scope.map(encodeURIComponent).join(':')}:${kind}`;
}

/** Validation belongs to the canonical form or receipt reader; unknown envelopes never restore. */
export function readRecovery<T>(
  storage: RecoveryStorage,
  context: RecoveryContext,
  kind: RecoveryKind,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const key = recoveryKey(context, kind);
    const raw = storage.getItem(key);
    if (raw === null) return null;
    try {
      const saved: unknown = JSON.parse(raw);
      if (record(saved) && saved.version === 1 && saved.namespace === key && validate(saved.value))
        return saved.value;
    } catch {
      // Damaged browser state is retired without altering any other namespace.
    }
    // A damaged submission may already have been accepted. Keep it blocked until explicit review.
    if (kind !== 'submission' && kind !== 'comparison-approval') storage.removeItem(key);
  } catch {
    // Browser storage is optional for drafts and may be unavailable in private browsing.
  }
  return null;
}

/** A write must survive a read-back before it can protect a paid submission. */
export function writeRecovery<T>(
  storage: RecoveryStorage,
  context: RecoveryContext,
  kind: RecoveryKind,
  value: T,
): boolean {
  try {
    const key = recoveryKey(context, kind);
    const serialized = JSON.stringify({ version: 1, namespace: key, value });
    storage.setItem(key, serialized);
    return storage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function clearRecovery(
  storage: RecoveryStorage,
  context: RecoveryContext,
  kind: RecoveryKind,
): void {
  try {
    storage.removeItem(recoveryKey(context, kind));
  } catch {
    // No browser-state cleanup failure can authorize another submission.
  }
}

/** Legacy model-only records have no trustworthy owner and must never be migrated into a session. */
export function retireLegacyPlaygroundStorage(
  storage: Pick<Storage, 'length' | 'key' | 'removeItem'>,
): number {
  let removed = 0;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (
        key &&
        ['opengen:draft:', 'media-router:submission:', 'media-router:job:'].some((prefix) =>
          key.startsWith(prefix),
        )
      ) {
        storage.removeItem(key);
        removed++;
      }
    }
  } catch {
    // Access-denied storage is never read to restore content.
  }
  return removed;
}

/** Stable JSON is also the exact request body; unsupported JSON values fail before submission. */
export function requestFingerprint(request: GenerateInput): string {
  const ancestors = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null)
      throw new Error('The request must contain valid JSON values.');
    if (ancestors.has(value)) throw new Error('The request must not contain circular values.');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return value.map(canonical);
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error('The request must contain plain JSON objects.');
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonical(child)]),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return JSON.stringify(canonical(request));
}

export type SubmissionReceipt = {
  key: string;
  fingerprint: string;
  jobId?: string;
  rejected?: true;
  attemptAfter?: string;
};

type SubmissionJournal = { receipts: SubmissionReceipt[] };
function isSubmissionJournal(value: unknown): value is SubmissionJournal {
  return (
    record(value) &&
    Array.isArray(value.receipts) &&
    value.receipts.every(
      (receipt: unknown) =>
        record(receipt) &&
        nonempty(receipt.key) &&
        receipt.key.length <= 200 &&
        nonempty(receipt.fingerprint) &&
        (receipt.jobId === undefined || nonempty(receipt.jobId)) &&
        (receipt.attemptAfter === undefined || nonempty(receipt.attemptAfter)) &&
        (receipt.rejected === undefined ||
          (receipt.rejected === true && receipt.jobId === undefined)),
    ) &&
    new Set(value.receipts.map((receipt) => receipt.key)).size === value.receipts.length
  );
}

export function findSubmission(
  storage: RecoveryStorage,
  context: RecoveryContext,
  fingerprint: string,
): SubmissionReceipt | undefined {
  return readRecovery(storage, context, 'submission', isSubmissionJournal)
    ?.receipts.slice()
    .reverse()
    .find((receipt) => receipt.fingerprint === fingerprint);
}

export function findSubmissionForJob(
  storage: RecoveryStorage,
  context: RecoveryContext,
  jobId: string,
): SubmissionReceipt | undefined {
  return readRecovery(storage, context, 'submission', isSubmissionJournal)?.receipts.find(
    (receipt) => receipt.jobId === jobId,
  );
}

/** Editing away and back must not discard a key whose upstream acceptance may still be unknown. */
export function prepareSubmission(
  storage: RecoveryStorage,
  context: RecoveryContext,
  request: GenerateInput,
  newKey: () => string = () => crypto.randomUUID(),
  newAttemptAfter?: string,
): SubmissionReceipt {
  if (request.modelId !== context.modelId || request.operation !== context.operation)
    throw new Error('The request does not match the selected model and operation.');
  const fingerprint = requestFingerprint(request);
  let hasSavedSubmission: boolean;
  try {
    hasSavedSubmission = storage.getItem(recoveryKey(context, 'submission')) !== null;
  } catch {
    throw new Error('Browser recovery could not be saved. This request has not been submitted.');
  }
  const saved = readRecovery(storage, context, 'submission', isSubmissionJournal);
  if (hasSavedSubmission && !saved)
    throw new Error(
      'Saved submission recovery is invalid. Review existing workspace jobs before creating a new generation.',
    );
  const journal = saved ?? { receipts: [] };
  const previous = journal.receipts.filter((receipt) => receipt.fingerprint === fingerprint).at(-1);
  if (previous && newAttemptAfter === undefined) {
    if (previous.rejected) {
      delete previous.rejected;
      if (!writeRecovery(storage, context, 'submission', journal))
        throw new Error(
          'Browser recovery could not be saved. This request has not been submitted.',
        );
    }
    return previous;
  }
  if (newAttemptAfter !== undefined && previous?.jobId !== newAttemptAfter)
    throw new Error('Recover the latest submission before preparing a new attempt.');
  const receipt = {
    key: newKey(),
    fingerprint,
    ...(newAttemptAfter ? { attemptAfter: newAttemptAfter } : {}),
  };
  if (!nonempty(receipt.key) || receipt.key.length > 200)
    throw new Error('A stable submission key is required.');
  if (journal.receipts.some((entry) => entry.key === receipt.key))
    throw new Error('A submission key cannot be reused with changed settings.');
  journal.receipts.push(receipt);
  if (!writeRecovery(storage, context, 'submission', journal))
    throw new Error('Browser recovery could not be saved. This request has not been submitted.');
  return receipt;
}

/** Attach only the result of the same immutable submission; late results cannot replace another key. */
export function recordSubmissionJob(
  storage: RecoveryStorage,
  context: RecoveryContext,
  receipt: SubmissionReceipt,
  jobId: string,
): boolean {
  if (!nonempty(jobId)) return false;
  const journal = readRecovery(storage, context, 'submission', isSubmissionJournal);
  const entry = journal?.receipts.find(
    (candidate) => candidate.key === receipt.key && candidate.fingerprint === receipt.fingerprint,
  );
  if (!journal || !entry || (entry.jobId !== undefined && entry.jobId !== jobId)) return false;
  entry.jobId = jobId;
  delete entry.rejected;
  return writeRecovery(storage, context, 'submission', journal);
}

/** A confirmed pre-admission rejection permits a new quote and a retry using the same key. */
export function recordSubmissionRejection(
  storage: RecoveryStorage,
  context: RecoveryContext,
  receipt: SubmissionReceipt,
): boolean {
  const journal = readRecovery(storage, context, 'submission', isSubmissionJournal);
  const entry = journal?.receipts.find(
    (candidate) => candidate.key === receipt.key && candidate.fingerprint === receipt.fingerprint,
  );
  if (!journal || !entry || entry.jobId) return false;
  entry.rejected = true;
  return writeRecovery(storage, context, 'submission', journal);
}
