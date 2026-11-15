export type MergePolicy = 'human-approval-required' | 'auto-merge';

export type HarnessStatus =
  'needs-local-claude' | 'awaiting-codex' | 'ready-human' | 'ready-merge' | 'halted';

export type CheckConclusion = 'success' | 'action_required' | 'failure';

export interface HarnessConfig {
  mergePolicy: MergePolicy;
  codexReviewActor: string | null;
  maxRounds: number;
  now: string;
  runUrl: string | null;
}

export interface ReviewThreadComment {
  id: string;
  authorLogin: string | null;
  body: string;
  url: string;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

export interface PullRequestReview {
  id: string;
  authorLogin: string | null;
  authorType: string | null;
  authorAssociation: string;
  body: string;
  state: string;
  submittedAt: string;
  url: string;
  commitOid: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  url: string;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
  /** GitHub author association (OWNER, MEMBER, COLLABORATOR, ...). */
  authorAssociation?: string;
  /**
   * Repository permission (`admin`, `write`, `read`, `none`) from REST
   * `collaborators/{login}/permission`, populated for security-relevant comments
   * (`/harness-requeue` and head-bound Codex review requests).
   */
  authorPermission?: string;
  reactionGroups?: IssueCommentReactionGroup[];
}

export interface IssueCommentReactionGroup {
  content: string;
  userLogins: string[];
}

export interface CheckRunStatus {
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PullRequestSnapshot {
  number: number;
  title: string;
  url: string;
  state: string;
  merged: boolean;
  isDraft: boolean;
  headSha: string;
  headCommittedAt: string;
  headRefName: string;
  headRepositoryNameWithOwner: string | null;
  baseRefName: string;
  baseRepositoryNameWithOwner: string;
  /** Pull request author login, populated from GraphQL when available. */
  authorLogin?: string | null;
  /** Pull request author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...). */
  authorAssociation?: string;
  /** Pull request author repository permission (`admin`, `write`, `read`, `none`) for same-repo PRs. */
  authorPermission?: string;
  labels: string[];
  reviewThreads: ReviewThread[];
  reviews: PullRequestReview[];
  issueComments: IssueComment[];
  ciChecks: CheckRunStatus[];
  /** Latest merge-queue removal when no subsequent enqueue has occurred. */
  mergeQueueRemoval?: MergeQueueRemoval | null;
  /** Latest force push of the head branch (`HeadRefForcePushedEvent.createdAt`), or null. */
  headForcePushedAt?: string | null;
}

/**
 * Latest removal from the base branch's merge queue when not re-enqueued since.
 * Run fields are populated for `reason: "failed_checks"`.
 */
export interface MergeQueueRemoval {
  enqueuedAt: string;
  removedAt: string;
  reason: string;
  mergeGroupSha: string | null;
  /** Head SHA on the PR at the time it entered the merge queue, when recoverable from timeline. */
  enqueuedHeadSha?: string | null;
  /** True when a commit or force-push occurred on the PR after the corresponding enqueue event. */
  headAdvancedAfterEnqueue?: boolean;
  runUrl: string | null;
  failedJobs: string[];
}

/** Active merge-queue rejection holding the pull request's current head. */
export interface QueueRejection {
  removedAt: string;
  mergeGroupSha: string | null;
  runUrl: string | null;
  failedJobs: string[];
}

export interface HarnessState {
  version: 1;
  roundsUsed: number;
  lastTaskSignature: string | null;
  lastTaskHeadSha: string | null;
  lastTaskItems?: string[] | null;
  halted: boolean;
  haltReason: string | null;
  queueHold?: QueueHold | null;
  lastEnqueuedHeadSha?: string | null;
}

export interface QueueHold {
  key: string;
  headSha: string | null;
}

export interface BlockingThread {
  id: string;
  url: string;
  excerpt: string;
}

export interface BlockingReview {
  id: string;
  url: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  excerpt: string;
}

export interface ReviewSummary {
  unresolvedThreads: BlockingThread[];
}

export interface CiSummary {
  state: 'passed' | 'pending' | 'failing';
  failingChecks: string[];
  pendingChecks: string[];
  missingChecks: string[];
  queueRejection: QueueRejection | null;
}

export interface CodexSummary {
  actorConfigured: boolean;
  actor: string | null;
  currentHeadReviewed: boolean;
  topLevelFindings: BlockingReview[];
}

export interface ApprovalSummary {
  required: boolean;
  hasValidHumanApproval: boolean;
  validApprovers: string[];
}

export interface ReadyCheckPlan {
  name: string;
  status: 'in_progress' | 'completed';
  conclusion: CheckConclusion | null;
  title: string;
  summary: string;
}

export interface HarnessEvaluation {
  status: HarnessStatus;
  desiredLabels: string[];
  ci: CiSummary;
  reviews: ReviewSummary;
  codex: CodexSummary;
  approvals: ApprovalSummary;
  blockingSignature: string | null;
  startedRepairRound: boolean;
  localClaudeRepairPrompt: string | null;
  state: HarnessState;
  readyCheck: ReadyCheckPlan;
}
