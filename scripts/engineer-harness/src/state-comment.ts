import type { HarnessEvaluation, HarnessState } from './types.js';

export const ENGINEER_HARNESS_STATE_START = '<!-- engineer-harness-state:start -->';
export const ENGINEER_HARNESS_STATE_END = '<!-- engineer-harness-state:end -->';

/**
 * Only state comments written by the workflow's built-in GitHub Actions identity may carry trusted
 * harness state (`roundsUsed`, `halted`, `queueHold`). Public repository commenters cannot spoof
 * or reset state by embedding state markers in an ordinary comment.
 */
export const TRUSTED_STATE_COMMENT_AUTHORS = ['github-actions[bot]', 'github-actions'] as const;

export const isTrustedHarnessStateAuthor = (authorLogin: string | null): boolean =>
  authorLogin !== null &&
  TRUSTED_STATE_COMMENT_AUTHORS.some((trustedLogin) => trustedLogin === authorLogin);

const getStatusDescription = (evaluation: HarnessEvaluation): string => {
  switch (evaluation.status) {
    case 'needs-local-claude':
      return 'Unresolved review comments, blocking Codex findings, failed CI, or a merge-queue rejection require a local Claude repair round.';
    case 'awaiting-codex':
      return 'The harness is waiting for Codex review and/or CI to finish on the current head SHA.';
    case 'ready-human':
      return 'Automation is satisfied, but the effective merge policy still needs a human collaborator approval on the current head SHA.';
    case 'ready-merge':
      return 'All automated and policy gates are satisfied. The pull request is ready to merge.';
    case 'halted':
      return (
        evaluation.state.haltReason ??
        'The local Claude repair loop halted and needs a human to intervene.'
      );
    /* c8 ignore next 3 */
    default:
      return assertNever(evaluation.status);
  }
};

const getRepairPromptSection = (evaluation: HarnessEvaluation): string => {
  if (evaluation.localClaudeRepairPrompt === null) {
    return '';
  }

  return [
    '### Local Claude Repair Prompt',
    'Copy this prompt into local Claude Code from the repository root:',
    '',
    '```md',
    evaluation.localClaudeRepairPrompt,
    '```',
  ].join('\n');
};

const getBlockingSection = (evaluation: HarnessEvaluation): string => {
  const lines: string[] = [];

  if (evaluation.reviews.unresolvedThreads.length > 0) {
    lines.push('### Unresolved Review Threads');
    for (const thread of evaluation.reviews.unresolvedThreads) {
      lines.push(`- ${thread.id}: ${thread.url}`);
    }
    lines.push('');
  }

  if (evaluation.codex.topLevelFindings.length > 0) {
    lines.push('### Top-Level Codex Findings');
    for (const finding of evaluation.codex.topLevelFindings) {
      lines.push(`- ${finding.id} (${finding.severity}): ${finding.url}`);
    }
    lines.push('');
  }

  if (
    evaluation.ci.failingChecks.length > 0 ||
    evaluation.ci.pendingChecks.length > 0 ||
    evaluation.ci.missingChecks.length > 0
  ) {
    lines.push('### CI Summary');

    if (evaluation.ci.failingChecks.length > 0) {
      lines.push(`- Failing: ${evaluation.ci.failingChecks.join(', ')}`);
    }

    if (evaluation.ci.pendingChecks.length > 0) {
      lines.push(`- Pending: ${evaluation.ci.pendingChecks.join(', ')}`);
    }

    if (evaluation.ci.missingChecks.length > 0) {
      lines.push(`- Missing: ${evaluation.ci.missingChecks.join(', ')}`);
    }

    lines.push('');
  }

  const queueRejection = evaluation.ci.queueRejection;
  if (queueRejection !== null) {
    lines.push('### Merge Queue Rejection');
    lines.push(
      `- The merge queue removed this head for failed checks at ${queueRejection.removedAt}. The harness will not queue it again.`,
    );
    lines.push(`- Queue run: ${queueRejection.runUrl ?? 'not found'}`);
    lines.push(
      `- Failed jobs: ${queueRejection.failedJobs.length > 0 ? queueRejection.failedJobs.join(', ') : 'not listed'}`,
    );
    lines.push(
      '- Cleared by a new commit, or (for a flake) by a maintainer comment `/harness-requeue <head sha>`.',
    );
    lines.push('');
  }

  return lines.join('\n');
};

export const formatHarnessStateComment = (
  state: HarnessState,
  evaluation: HarnessEvaluation,
): string => {
  const sections = [
    ENGINEER_HARNESS_STATE_START,
    JSON.stringify(state),
    ENGINEER_HARNESS_STATE_END,
    '## Engineer Harness',
    '',
    `- Status: \`${evaluation.status}\``,
    `- Merge policy: \`${evaluation.approvals.required ? 'human-approval-required' : 'auto-merge'}\``,
    `- Codex actor: \`${evaluation.codex.actor ?? 'unset'}\``,
    `- Local Claude repair rounds used: ${state.roundsUsed}`,
    `- Human approval on current head: ${evaluation.approvals.hasValidHumanApproval ? 'yes' : 'no'}`,
    '',
    getStatusDescription(evaluation),
    '',
    getBlockingSection(evaluation).trim(),
    getRepairPromptSection(evaluation),
  ]
    .filter((section) => section.length > 0)
    .join('\n');

  return `${sections}\n`;
};

export const parseHarnessStateComment = (body: string): HarnessState | null => {
  const startIndex = body.indexOf(ENGINEER_HARNESS_STATE_START);
  const endIndex = body.indexOf(ENGINEER_HARNESS_STATE_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const jsonPayload = body.slice(startIndex + ENGINEER_HARNESS_STATE_START.length, endIndex).trim();

  if (jsonPayload.length === 0) {
    return null;
  }

  let parsedValue: unknown;

  try {
    parsedValue = JSON.parse(jsonPayload);
  } catch {
    return null;
  }

  if (!isHarnessState(parsedValue)) {
    return null;
  }

  return parsedValue;
};

export const isHarnessStateComment = (body: string): boolean =>
  body.includes(ENGINEER_HARNESS_STATE_START) && body.includes(ENGINEER_HARNESS_STATE_END);

const isHarnessState = (value: unknown): value is HarnessState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const lastTaskItems = Reflect.get(value, 'lastTaskItems');
  const hasValidLastTaskItems =
    lastTaskItems === undefined ||
    lastTaskItems === null ||
    (Array.isArray(lastTaskItems) && lastTaskItems.every((item) => typeof item === 'string'));

  const queueHold: unknown = Reflect.get(value, 'queueHold');
  const hasValidQueueHold =
    queueHold === undefined ||
    queueHold === null ||
    (typeof queueHold === 'object' &&
      typeof Reflect.get(queueHold, 'key') === 'string' &&
      (typeof Reflect.get(queueHold, 'headSha') === 'string' ||
        Reflect.get(queueHold, 'headSha') === null));

  return (
    hasValidQueueHold &&
    Reflect.get(value, 'version') === 1 &&
    typeof Reflect.get(value, 'roundsUsed') === 'number' &&
    (typeof Reflect.get(value, 'lastTaskSignature') === 'string' ||
      Reflect.get(value, 'lastTaskSignature') === null) &&
    (typeof Reflect.get(value, 'lastTaskHeadSha') === 'string' ||
      Reflect.get(value, 'lastTaskHeadSha') === null) &&
    hasValidLastTaskItems &&
    typeof Reflect.get(value, 'halted') === 'boolean' &&
    (typeof Reflect.get(value, 'haltReason') === 'string' ||
      Reflect.get(value, 'haltReason') === null)
  );
};

/* c8 ignore next 3 */
const assertNever = (value: never): never => {
  throw new Error(`Unhandled harness status: ${String(value)}`);
};
