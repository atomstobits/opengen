import { createHash } from 'node:crypto';
import { MERGE_BASE_BRANCH, stackedBaseNotice } from './merge.js';
import type {
  ApprovalSummary,
  BlockingReview,
  CiSummary,
  CodexSummary,
  HarnessConfig,
  HarnessEvaluation,
  HarnessState,
  IssueComment,
  PullRequestReview,
  PullRequestSnapshot,
  QueueHold,
  QueueRejection,
  ReadyCheckPlan,
  ReviewSummary,
} from './types.js';

export const ENGINEER_HARNESS_READY_CHECK = 'engineer-harness/ready';

export const ENGINEER_HARNESS_PR_LABELS = [
  'agent:needs-local-claude',
  'agent:awaiting-codex',
  'agent:ready-human',
  'agent:ready-merge',
  'agent:halted',
] as const;

export const ENGINEER_HARNESS_ISSUE_LABELS = ['agent:ready-for-local-claude'] as const;

export const ENGINEER_HARNESS_LABELS = [
  ...ENGINEER_HARNESS_PR_LABELS,
  ...ENGINEER_HARNESS_ISSUE_LABELS,
] as const;

/**
 * Required CI check runs emitted by `.github/workflows/check.yml` (`Checks`), matching the
 * required status checks enforced on `main`.
 */
export const REQUIRED_CI_CHECKS = [
  'Isolated C2PA integration / provenance',
  'verify',
  'secrets',
  'containers',
] as const;

const COLLABORATOR_ASSOCIATIONS: ReadonlyArray<string> = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const COLLABORATOR_WRITE_PERMISSIONS: ReadonlyArray<string> = ['admin', 'write'];

export const createInitialHarnessState = (): HarnessState => ({
  version: 1,
  roundsUsed: 0,
  lastTaskSignature: null,
  lastTaskHeadSha: null,
  lastTaskItems: null,
  halted: false,
  haltReason: null,
});

const hashSignature = (parts: string[]): string =>
  createHash('sha256').update(parts.join('|')).digest('hex');

const stripLeadingHtmlComments = (body: string): string =>
  body.replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, '');

const summarizeBody = (body: string): string => {
  const firstMeaningfulLine = stripLeadingHtmlComments(body)
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (firstMeaningfulLine === undefined) {
    return 'No summary provided.';
  }

  return firstMeaningfulLine.length > 120
    ? `${firstMeaningfulLine.slice(0, 117)}...`
    : firstMeaningfulLine;
};

const getPrioritySeverity = (body: string): 'P0' | 'P1' | 'P2' | 'P3' | null => {
  const priorities: ReadonlyArray<'P0' | 'P1' | 'P2' | 'P3'> = ['P0', 'P1', 'P2', 'P3'];
  const priorityMatches = [...body.matchAll(/(?:^|[\s\[])(P[0-3])(?:[\]\s.,:;!?]|$)/g)];
  return (
    priorities.find((priority) => priorityMatches.some((match) => match[1] === priority)) ?? null
  );
};

export const isConfiguredActorLogin = (
  candidateLogin: string | null,
  configuredActor: string,
): boolean => candidateLogin === configuredActor;

const isAtOrAfter = (candidateTimestamp: string, lowerBoundTimestamp: string): boolean => {
  const candidateTime = Date.parse(candidateTimestamp);
  const lowerBoundTime = Date.parse(lowerBoundTimestamp);

  if (Number.isNaN(candidateTime) || Number.isNaN(lowerBoundTime)) {
    return false;
  }

  return candidateTime >= lowerBoundTime;
};

const isCodexIssueReviewCommentBody = (body: string): boolean =>
  stripLeadingHtmlComments(body).toLowerCase().startsWith('codex review:');

const isAffirmativeCleanCodexIssueReviewBody = (body: string): boolean =>
  /\b(?:did not|didn't) find any (?:major )?issues\b/i.test(body) ||
  /\bno (?:major )?issues (?:were )?found\b/i.test(body);

export const getCodexReviewRequestedHeadSha = (body: string): string | null => {
  const autoReviewMarkerMatch = body.match(/<!--\s*codex-auto-review:([a-f0-9]{7,40})\s*-->/i);
  if (autoReviewMarkerMatch?.[1] !== undefined) {
    return autoReviewMarkerMatch[1].toLowerCase();
  }

  const explicitHeadMatch = body.match(
    /@codex\s+review[\s\S]*?\bcurrent head\s+([a-f0-9]{7,40})\b/i,
  );
  if (explicitHeadMatch?.[1] !== undefined) {
    return explicitHeadMatch[1].toLowerCase();
  }

  return null;
};

export const hasCodexReviewRequest = (body: string): boolean =>
  getCodexReviewRequestedHeadSha(body) !== null;

const getCodexReviewedCommitSha = (body: string): string | null =>
  body.match(/\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i)?.[1]?.toLowerCase() ?? null;

/**
 * Only repository collaborators (`admin`/`write`) or `github-actions[bot]` may author a head-bound
 * `@codex review` request that binds a clean issue-comment receipt on a public repository.
 */
const mayRequestCodexReview = (comment: IssueComment): boolean => {
  if (comment.authorLogin === 'github-actions[bot]' || comment.authorLogin === 'github-actions') {
    return true;
  }
  if (comment.authorPermission !== undefined) {
    return COLLABORATOR_WRITE_PERMISSIONS.includes(comment.authorPermission);
  }
  if (comment.authorAssociation !== undefined) {
    return COLLABORATOR_ASSOCIATIONS.includes(comment.authorAssociation);
  }
  return true;
};

const hasInProgressCodexReaction = (comment: IssueComment, actor: string): boolean =>
  comment.reactionGroups?.some(
    (group) =>
      group.content === 'EYES' &&
      group.userLogins.some((login) => isConfiguredActorLogin(login, actor)),
  ) ?? false;

const isShaPrefixForHead = (candidateSha: string, headSha: string): boolean => {
  const normalizedCandidateSha = candidateSha.toLowerCase();
  return (
    normalizedCandidateSha.length >= 7 && headSha.toLowerCase().startsWith(normalizedCandidateSha)
  );
};

const getLatestHeadBoundCodexReviewRequestBefore = (
  issueComments: IssueComment[],
  issueReviewComment: IssueComment,
  actor: string,
): { requestedHeadSha: string; createdAt: string } | null => {
  const issueReviewCommentTime = Date.parse(issueReviewComment.createdAt);
  if (Number.isNaN(issueReviewCommentTime)) {
    return null;
  }

  let latestRequest: { requestedHeadSha: string; createdAt: string; time: number } | null = null;

  for (const comment of issueComments) {
    const requestedHeadSha = getCodexReviewRequestedHeadSha(comment.body);
    if (requestedHeadSha === null) {
      continue;
    }

    if (!mayRequestCodexReview(comment)) {
      continue;
    }

    const requestTime = Date.parse(comment.createdAt);
    if (Number.isNaN(requestTime) || requestTime > issueReviewCommentTime) {
      continue;
    }

    if (hasInProgressCodexReaction(comment, actor)) {
      continue;
    }

    if (latestRequest === null || requestTime >= latestRequest.time) {
      latestRequest = {
        requestedHeadSha,
        createdAt: comment.createdAt,
        time: requestTime,
      };
    }
  }

  if (latestRequest === null) {
    return null;
  }

  return {
    requestedHeadSha: latestRequest.requestedHeadSha,
    createdAt: latestRequest.createdAt,
  };
};

const isCodexIssueReviewCommentOnHead = (
  snapshot: PullRequestSnapshot,
  comment: IssueComment,
  actor: string,
): boolean => {
  const reviewedCommitSha = getCodexReviewedCommitSha(comment.body);
  if (reviewedCommitSha !== null && !isShaPrefixForHead(reviewedCommitSha, snapshot.headSha)) {
    return false;
  }

  const latestRequest = getLatestHeadBoundCodexReviewRequestBefore(
    snapshot.issueComments,
    comment,
    actor,
  );
  if (latestRequest === null) {
    return false;
  }

  return (
    isShaPrefixForHead(latestRequest.requestedHeadSha, snapshot.headSha) &&
    isAtOrAfter(latestRequest.createdAt, snapshot.headCommittedAt)
  );
};

/**
 * Explicit maintainer command to retry enqueueing the same head after a merge-queue flake.
 */
export const QUEUE_RETRY_COMMAND = '/harness-requeue';

export const QUEUE_REMOVAL_FAILED_CHECKS = 'failed_checks';

const mayRetryQueue = (comment: IssueComment): boolean =>
  COLLABORATOR_WRITE_PERMISSIONS.includes(comment.authorPermission ?? '') ||
  COLLABORATOR_ASSOCIATIONS.includes(comment.authorAssociation ?? '');

export const hasQueueRetryCommand = (body: string): boolean =>
  getQueueRetryRequestedSha(body) !== null;

const getQueueRetryRequestedSha = (body: string): string | null =>
  body.match(/^[ \t]*\/harness-requeue[ \t]+([a-f0-9]{7,40})[ \t]*$/im)?.[1]?.toLowerCase() ?? null;

const isStrictlyAfter = (
  candidateTimestamp: string | null | undefined,
  lowerBoundTimestamp: string,
): boolean => {
  if (candidateTimestamp === null || candidateTimestamp === undefined) {
    return false;
  }

  return Date.parse(candidateTimestamp) > Date.parse(lowerBoundTimestamp);
};

const getQueueRejection = (
  snapshot: PullRequestSnapshot,
  previousHold: QueueHold | null,
): { rejection: QueueRejection | null; hold: QueueHold | null } => {
  const removal = snapshot.mergeQueueRemoval ?? null;
  if (removal === null || removal.reason !== QUEUE_REMOVAL_FAILED_CHECKS) {
    return { rejection: null, hold: null };
  }

  const key = removal.mergeGroupSha ?? removal.removedAt;
  const hold: QueueHold =
    previousHold !== null && previousHold.key === key
      ? previousHold
      : {
          key,
          headSha: isStrictlyAfter(snapshot.headForcePushedAt, removal.enqueuedAt)
            ? null
            : snapshot.headSha,
        };

  if (hold.headSha !== snapshot.headSha) {
    return { rejection: null, hold };
  }

  const retryRequested = snapshot.issueComments.some((comment) => {
    const requestedSha = getQueueRetryRequestedSha(comment.body);
    return (
      requestedSha !== null &&
      isShaPrefixForHead(requestedSha, snapshot.headSha) &&
      mayRetryQueue(comment) &&
      isAtOrAfter(comment.createdAt, removal.removedAt)
    );
  });
  if (retryRequested) {
    return { rejection: null, hold };
  }

  return {
    rejection: {
      removedAt: removal.removedAt,
      mergeGroupSha: removal.mergeGroupSha,
      runUrl: removal.runUrl,
      failedJobs: removal.failedJobs,
    },
    hold,
  };
};

const describeQueueRejection = (rejection: QueueRejection): string =>
  `queue run ${rejection.runUrl ?? 'not found'}` +
  `, failed jobs: ${rejection.failedJobs.length > 0 ? rejection.failedJobs.join(', ') : 'not listed'}`;

const getCiSummary = (
  snapshot: PullRequestSnapshot,
  queueRejection: QueueRejection | null,
): CiSummary => ({
  ...getCheckSummary(snapshot.ciChecks),
  queueRejection,
});

const getCheckSummary = (
  checks: PullRequestSnapshot['ciChecks'],
): Omit<CiSummary, 'queueRejection'> => {
  const latestChecksByName = new Map<string, PullRequestSnapshot['ciChecks'][number]>();

  for (const check of checks) {
    const existingCheck = latestChecksByName.get(check.name);
    if (existingCheck === undefined) {
      latestChecksByName.set(check.name, check);
      continue;
    }

    const existingTimestamp = existingCheck.completedAt ?? existingCheck.startedAt ?? '';
    const candidateTimestamp = check.completedAt ?? check.startedAt ?? '';

    if (candidateTimestamp >= existingTimestamp) {
      latestChecksByName.set(check.name, check);
    }
  }

  const failingChecks: string[] = [];
  const pendingChecks: string[] = [];
  const missingChecks: string[] = [];

  for (const requiredCheck of REQUIRED_CI_CHECKS) {
    const check = latestChecksByName.get(requiredCheck);
    if (check === undefined) {
      missingChecks.push(requiredCheck);
      continue;
    }

    if (check.status !== 'completed') {
      pendingChecks.push(requiredCheck);
      continue;
    }

    if (check.conclusion !== 'success') {
      failingChecks.push(requiredCheck);
    }
  }

  if (failingChecks.length > 0) {
    return {
      state: 'failing',
      failingChecks,
      pendingChecks,
      missingChecks,
    };
  }

  if (pendingChecks.length > 0 || missingChecks.length > 0) {
    return {
      state: 'pending',
      failingChecks,
      pendingChecks,
      missingChecks,
    };
  }

  return {
    state: 'passed',
    failingChecks,
    pendingChecks,
    missingChecks,
  };
};

/**
 * On an open-source repository, `auto-merge` applies only to same-repository branches authored by
 * collaborators with `admin` or `write` permission. Fork PRs and external contributor PRs always
 * require a human collaborator `APPROVED` review on the exact current `headSha`.
 */
export const isTrustedInternalPullRequest = (snapshot: PullRequestSnapshot): boolean => {
  if (
    snapshot.headRepositoryNameWithOwner === null ||
    snapshot.headRepositoryNameWithOwner !== snapshot.baseRepositoryNameWithOwner
  ) {
    return false;
  }

  if (snapshot.authorPermission !== undefined) {
    return COLLABORATOR_WRITE_PERMISSIONS.includes(snapshot.authorPermission);
  }

  if (snapshot.authorAssociation !== undefined) {
    return COLLABORATOR_ASSOCIATIONS.includes(snapshot.authorAssociation);
  }

  return true;
};

const isCollaboratorApproval = (review: PullRequestReview, headSha: string): boolean => {
  if (review.state !== 'APPROVED') {
    return false;
  }

  if (review.commitOid !== headSha) {
    return false;
  }

  if (review.authorType === 'Bot') {
    return false;
  }

  return COLLABORATOR_ASSOCIATIONS.includes(review.authorAssociation);
};

const getApprovalSummary = (
  snapshot: PullRequestSnapshot,
  requiresHumanApproval: boolean,
): ApprovalSummary => {
  const validApprovers = snapshot.reviews
    .filter((review) => isCollaboratorApproval(review, snapshot.headSha))
    .map((review) => review.authorLogin)
    .filter((login): login is string => login !== null);

  return {
    required: requiresHumanApproval,
    hasValidHumanApproval: validApprovers.length > 0,
    validApprovers,
  };
};

const getCodexSummary = (snapshot: PullRequestSnapshot, actor: string | null): CodexSummary => {
  if (actor === null) {
    return {
      actorConfigured: false,
      actor,
      currentHeadReviewed: false,
      topLevelFindings: [],
    };
  }

  const codexReviewsOnHead = snapshot.reviews.filter(
    (review) =>
      isConfiguredActorLogin(review.authorLogin, actor) && review.commitOid === snapshot.headSha,
  );

  const codexIssueReviewCommentsOnHead = snapshot.issueComments.filter(
    (comment) =>
      isConfiguredActorLogin(comment.authorLogin, actor) &&
      isCodexIssueReviewCommentBody(comment.body) &&
      isCodexIssueReviewCommentOnHead(snapshot, comment, actor),
  );

  const topLevelReviewSignals: Array<{
    id: string;
    url: string;
    body: string;
    createdAt: string;
    severity: 'P0' | 'P1' | 'P2' | 'P3' | null;
    completed: boolean;
  }> = [
    ...codexReviewsOnHead.map((review) => ({
      id: review.id,
      url: review.url,
      body: review.body,
      createdAt: review.submittedAt,
      severity: getPrioritySeverity(review.body),
      completed: true,
    })),
    ...codexIssueReviewCommentsOnHead.map((comment) => {
      const severity = getPrioritySeverity(comment.body);
      return {
        id: `issue-comment-${comment.id}`,
        url: comment.url,
        body: comment.body,
        createdAt: comment.createdAt,
        severity,
        completed: severity !== null || isAffirmativeCleanCodexIssueReviewBody(comment.body),
      };
    }),
  ]
    .filter((signal) => signal.completed)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const latestTopLevelReview = topLevelReviewSignals[0];
  const topLevelFindings: BlockingReview[] = [];
  if (latestTopLevelReview) {
    const severity = latestTopLevelReview.severity;
    if (severity !== null) {
      topLevelFindings.push({
        id: latestTopLevelReview.id,
        url: latestTopLevelReview.url,
        severity,
        excerpt: summarizeBody(latestTopLevelReview.body),
      });
    }
  }

  return {
    actorConfigured: true,
    actor,
    currentHeadReviewed: topLevelReviewSignals.length > 0,
    topLevelFindings,
  };
};

const getReviewSummary = (snapshot: PullRequestSnapshot): ReviewSummary => ({
  unresolvedThreads: snapshot.reviewThreads
    .filter((thread) => !thread.isResolved)
    .map((thread) => {
      const firstComment = thread.comments[0];

      return {
        id: thread.id,
        url: firstComment?.url ?? snapshot.url,
        excerpt:
          firstComment === undefined
            ? 'No review comment details were returned.'
            : summarizeBody(firstComment.body),
      };
    }),
});

const getBlockingItems = (ci: CiSummary, reviews: ReviewSummary, codex: CodexSummary): string[] =>
  [
    ...ci.failingChecks.map((checkName) => `ci:${checkName}`),
    ...(ci.queueRejection === null
      ? []
      : [`merge-queue:${ci.queueRejection.mergeGroupSha ?? ci.queueRejection.removedAt}`]),
    ...reviews.unresolvedThreads.map((thread) => `review-thread:${thread.id}`),
    ...codex.topLevelFindings.map((finding) => `codex-finding:${finding.id}:${finding.severity}`),
  ].sort();

const getBlockingSignature = (blockingItems: string[], headSha: string): string | null => {
  if (blockingItems.length === 0) {
    return null;
  }

  return hashSignature([headSha, ...blockingItems]);
};

const shouldStartRepairRound = (
  blockingItems: string[],
  headSha: string,
  state: HarnessState,
): boolean => {
  if (state.lastTaskSignature === null || state.lastTaskHeadSha !== headSha) {
    return true;
  }

  const previousItems = state.lastTaskItems;
  if (previousItems === undefined || previousItems === null) {
    return false;
  }

  const previousItemSet = new Set(previousItems);
  return blockingItems.some((item) => !previousItemSet.has(item));
};

const getLocalClaudeRepairPrompt = (
  snapshot: PullRequestSnapshot,
  ci: CiSummary,
  reviews: ReviewSummary,
  codex: CodexSummary,
  roundsUsed: number,
  maxRounds: number,
): string => {
  const lines = [
    'Please address the current blocking items on this pull request using local Claude Code.',
    '',
    `PR: ${snapshot.url}`,
    `Head SHA: ${snapshot.headSha}`,
    `Manual repair round: ${roundsUsed}/${maxRounds}`,
    '',
  ];

  if (reviews.unresolvedThreads.length > 0 || codex.topLevelFindings.length > 0) {
    lines.push('Review findings to address:');
    for (const thread of reviews.unresolvedThreads) {
      lines.push(`- Review thread ${thread.id}: ${thread.url}`);
      lines.push(`  Summary: ${thread.excerpt}`);
    }

    for (const finding of codex.topLevelFindings) {
      lines.push(`- Top-level ${finding.severity} finding ${finding.id}: ${finding.url}`);
      lines.push(`  Summary: ${finding.excerpt}`);
    }

    lines.push('');
  }

  if (ci.failingChecks.length > 0) {
    lines.push('Failing CI checks to fix:');
    for (const checkName of ci.failingChecks) {
      lines.push(`- ${checkName}`);
    }
    lines.push('');
  }

  if (ci.queueRejection !== null) {
    lines.push('Merge queue rejection to fix:');
    lines.push(
      `- The merge queue removed this head for failed checks at ${ci.queueRejection.removedAt}; the harness will not queue it again.`,
    );
    lines.push(`- Queue run: ${ci.queueRejection.runUrl ?? 'not found'}`);
    lines.push(
      `- Failed jobs: ${ci.queueRejection.failedJobs.length > 0 ? ci.queueRejection.failedJobs.join(', ') : 'not listed'}`,
    );
    lines.push(
      `- A new commit clears the hold. If the failure was a flake, a maintainer comments \`${QUEUE_RETRY_COMMAND} ${snapshot.headSha}\` to queue this head once more.`,
    );
    lines.push('');
  }

  lines.push('Constraints:');
  lines.push(
    '- Address every unresolved review thread and resolve it after the requested change is made.',
  );
  lines.push('- Fix any Codex findings, failed CI, and directly-required tests or code.');
  lines.push('- Push commits to the existing pull-request branch.');
  lines.push('- Do not introduce unrelated refactors, dependency churn, or opportunistic cleanup.');
  lines.push('- Finish with a concise summary of the changes and validation you ran.');

  return lines.join('\n');
};

const getDesiredLabels = (status: HarnessEvaluation['status']): string[] => {
  switch (status) {
    case 'needs-local-claude':
      return ['agent:needs-local-claude'];
    case 'awaiting-codex':
      return ['agent:awaiting-codex'];
    case 'ready-human':
      return ['agent:ready-human'];
    case 'ready-merge':
      return ['agent:ready-merge'];
    case 'halted':
      return ['agent:halted'];
    /* c8 ignore next 3 */
    default:
      return assertNever(status);
  }
};

const getReadyCheck = (
  status: HarnessEvaluation['status'],
  ci: CiSummary,
  reviews: ReviewSummary,
  codex: CodexSummary,
  approvals: ApprovalSummary,
  state: HarnessState,
  baseRefName: string,
): ReadyCheckPlan => {
  switch (status) {
    case 'ready-merge':
      if (baseRefName !== MERGE_BASE_BRANCH) {
        return {
          name: ENGINEER_HARNESS_READY_CHECK,
          status: 'completed',
          conclusion: 'success',
          title: `Gates satisfied; merge waits until the base is retargeted to ${MERGE_BASE_BRANCH}`,
          summary:
            'CI is green, Codex blocking findings are cleared, and merge policy requirements are satisfied. ' +
            stackedBaseNotice(baseRefName),
        };
      }
      return {
        name: ENGINEER_HARNESS_READY_CHECK,
        status: 'completed',
        conclusion: 'success',
        title: 'Engineer harness is ready',
        summary:
          'CI is green, Codex blocking findings are cleared, and merge policy requirements are satisfied.',
      };
    case 'ready-human':
      return {
        name: ENGINEER_HARNESS_READY_CHECK,
        status: 'completed',
        conclusion: 'action_required',
        title: 'Waiting for human approval',
        summary: `All automated gates are satisfied, but merge policy requires a human collaborator approval on the current head SHA. Valid approvals: ${approvals.validApprovers.join(', ') || 'none'}.`,
      };
    case 'awaiting-codex':
      return {
        name: ENGINEER_HARNESS_READY_CHECK,
        status: 'in_progress',
        conclusion: null,
        title: 'Waiting for Codex review or CI',
        summary: getAwaitingSummary(ci, codex),
      };
    case 'needs-local-claude':
      return {
        name: ENGINEER_HARNESS_READY_CHECK,
        status: 'completed',
        conclusion: 'action_required',
        title: 'Waiting for local Claude fixes',
        summary: getBlockingSummary(ci, reviews, codex),
      };
    case 'halted':
      return {
        name: ENGINEER_HARNESS_READY_CHECK,
        status: 'completed',
        conclusion: 'action_required',
        title: 'Harness halted',
        summary: state.haltReason ?? 'The engineer harness halted and requires human intervention.',
      };
    /* c8 ignore next 3 */
    default:
      return assertNever(status);
  }
};

const getAwaitingSummary = (ci: CiSummary, codex: CodexSummary): string => {
  const waitingReasons: string[] = [];

  if (!codex.actorConfigured) {
    waitingReasons.push('Configure the CODEX_REVIEW_ACTOR repository variable.');
  } else if (!codex.currentHeadReviewed) {
    waitingReasons.push('Codex has not reviewed the current head SHA yet.');
  }

  if (ci.pendingChecks.length > 0) {
    waitingReasons.push(`Pending CI checks: ${ci.pendingChecks.join(', ')}.`);
  }

  if (ci.missingChecks.length > 0) {
    waitingReasons.push(
      `Expected CI checks have not reported yet: ${ci.missingChecks.join(', ')}.`,
    );
  }

  return waitingReasons.join(' ');
};

const getBlockingSummary = (ci: CiSummary, reviews: ReviewSummary, codex: CodexSummary): string => {
  const lines: string[] = [];

  if (reviews.unresolvedThreads.length > 0) {
    lines.push(
      `Unresolved review threads: ${reviews.unresolvedThreads.map((thread) => thread.id).join(', ')}.`,
    );
  }

  if (codex.topLevelFindings.length > 0) {
    lines.push(
      `Top-level Codex findings: ${codex.topLevelFindings.map((finding) => `${finding.id} (${finding.severity})`).join(', ')}.`,
    );
  }

  if (ci.failingChecks.length > 0) {
    lines.push(`Failing CI checks: ${ci.failingChecks.join(', ')}.`);
  }

  if (ci.queueRejection !== null) {
    lines.push(
      `The merge queue rejected this head (${describeQueueRejection(ci.queueRejection)}). ` +
        `It is not queued again until a new commit, or a maintainer's ${QUEUE_RETRY_COMMAND} <head sha> comment.`,
    );
  }

  return lines.join(' ');
};

export const evaluateHarness = (
  snapshot: PullRequestSnapshot,
  previousState: HarnessState,
  config: HarnessConfig,
): HarnessEvaluation => {
  const queue = getQueueRejection(snapshot, previousState.queueHold ?? null);
  const evaluation = evaluateGates(snapshot, previousState, config, queue.rejection);
  const { queueHold: _previousHold, ...state } = evaluation.state;

  return {
    ...evaluation,
    state: queue.hold === null ? state : { ...state, queueHold: queue.hold },
  };
};

const evaluateGates = (
  snapshot: PullRequestSnapshot,
  previousState: HarnessState,
  config: HarnessConfig,
  queueRejection: QueueRejection | null,
): HarnessEvaluation => {
  const ci = getCiSummary(snapshot, queueRejection);
  const reviews = getReviewSummary(snapshot);
  const codex = getCodexSummary(snapshot, config.codexReviewActor);
  const requiresHumanApproval =
    config.mergePolicy === 'human-approval-required' || !isTrustedInternalPullRequest(snapshot);
  const approvals = getApprovalSummary(snapshot, requiresHumanApproval);
  const blockingItems = getBlockingItems(ci, reviews, codex);
  const blockingSignature = getBlockingSignature(blockingItems, snapshot.headSha);

  const hasBlockingItems = blockingSignature !== null;
  const shouldClearHalt =
    previousState.halted && previousState.lastTaskHeadSha !== snapshot.headSha;
  const workingState = shouldClearHalt ? createInitialHarnessState() : previousState;
  const startsRepairRound =
    blockingSignature !== null &&
    shouldStartRepairRound(blockingItems, snapshot.headSha, workingState);

  if (hasBlockingItems && config.maxRounds === 0) {
    const haltedState: HarnessState = {
      ...workingState,
      lastTaskSignature: blockingSignature,
      lastTaskHeadSha: snapshot.headSha,
      lastTaskItems: blockingItems,
      halted: true,
      haltReason:
        'Automatic local Claude repair is disabled because ENGINEER_HARNESS_MAX_ROUNDS is set to 0.',
    };

    return {
      status: 'halted',
      desiredLabels: getDesiredLabels('halted'),
      ci,
      reviews,
      codex,
      approvals,
      blockingSignature,
      startedRepairRound: false,
      localClaudeRepairPrompt: null,
      state: haltedState,
      readyCheck: getReadyCheck(
        'halted',
        ci,
        reviews,
        codex,
        approvals,
        haltedState,
        snapshot.baseRefName,
      ),
    };
  }

  if (
    hasBlockingItems &&
    (workingState.halted || (startsRepairRound && workingState.roundsUsed >= config.maxRounds))
  ) {
    const haltedState: HarnessState = {
      ...workingState,
      lastTaskSignature: blockingSignature,
      lastTaskHeadSha: snapshot.headSha,
      lastTaskItems: blockingItems,
      halted: true,
      haltReason:
        workingState.haltReason ??
        `The engineer harness reached the local Claude repair cap (${config.maxRounds} rounds) for this pull request. A human needs to take over or reset the loop with a new revision.`,
    };

    return {
      status: 'halted',
      desiredLabels: getDesiredLabels('halted'),
      ci,
      reviews,
      codex,
      approvals,
      blockingSignature,
      startedRepairRound: false,
      localClaudeRepairPrompt: null,
      state: haltedState,
      readyCheck: getReadyCheck(
        'halted',
        ci,
        reviews,
        codex,
        approvals,
        haltedState,
        snapshot.baseRefName,
      ),
    };
  }

  if (hasBlockingItems) {
    const nextState: HarnessState = {
      version: 1,
      roundsUsed: startsRepairRound ? workingState.roundsUsed + 1 : workingState.roundsUsed,
      lastTaskSignature: blockingSignature,
      lastTaskHeadSha: snapshot.headSha,
      lastTaskItems: blockingItems,
      halted: false,
      haltReason: null,
    };

    return {
      status: 'needs-local-claude',
      desiredLabels: getDesiredLabels('needs-local-claude'),
      ci,
      reviews,
      codex,
      approvals,
      blockingSignature,
      startedRepairRound: startsRepairRound,
      localClaudeRepairPrompt: getLocalClaudeRepairPrompt(
        snapshot,
        ci,
        reviews,
        codex,
        nextState.roundsUsed,
        config.maxRounds,
      ),
      state: nextState,
      readyCheck: getReadyCheck(
        'needs-local-claude',
        ci,
        reviews,
        codex,
        approvals,
        nextState,
        snapshot.baseRefName,
      ),
    };
  }

  if (!codex.actorConfigured || !codex.currentHeadReviewed || ci.state === 'pending') {
    const nextState: HarnessState = {
      ...workingState,
      lastTaskSignature: null,
      lastTaskHeadSha: snapshot.headSha,
      lastTaskItems: null,
      halted: false,
      haltReason: null,
    };

    return {
      status: 'awaiting-codex',
      desiredLabels: getDesiredLabels('awaiting-codex'),
      ci,
      reviews,
      codex,
      approvals,
      blockingSignature,
      startedRepairRound: false,
      localClaudeRepairPrompt: null,
      state: nextState,
      readyCheck: getReadyCheck(
        'awaiting-codex',
        ci,
        reviews,
        codex,
        approvals,
        nextState,
        snapshot.baseRefName,
      ),
    };
  }

  if (approvals.required && !approvals.hasValidHumanApproval) {
    const nextState: HarnessState = {
      ...workingState,
      lastTaskSignature: null,
      lastTaskHeadSha: snapshot.headSha,
      lastTaskItems: null,
      halted: false,
      haltReason: null,
    };

    return {
      status: 'ready-human',
      desiredLabels: getDesiredLabels('ready-human'),
      ci,
      reviews,
      codex,
      approvals,
      blockingSignature,
      startedRepairRound: false,
      localClaudeRepairPrompt: null,
      state: nextState,
      readyCheck: getReadyCheck(
        'ready-human',
        ci,
        reviews,
        codex,
        approvals,
        nextState,
        snapshot.baseRefName,
      ),
    };
  }

  const readyState: HarnessState = {
    version: 1,
    roundsUsed: 0,
    lastTaskSignature: null,
    lastTaskHeadSha: snapshot.headSha,
    lastTaskItems: null,
    halted: false,
    haltReason: null,
  };

  return {
    status: 'ready-merge',
    desiredLabels: getDesiredLabels('ready-merge'),
    ci,
    reviews,
    codex,
    approvals,
    blockingSignature,
    startedRepairRound: false,
    localClaudeRepairPrompt: null,
    state: readyState,
    readyCheck: getReadyCheck(
      'ready-merge',
      ci,
      reviews,
      codex,
      approvals,
      readyState,
      snapshot.baseRefName,
    ),
  };
};

/* c8 ignore next 3 */
const assertNever = (value: never): never => {
  throw new Error(`Unhandled harness status: ${String(value)}`);
};
