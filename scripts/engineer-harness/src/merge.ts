import type { GitHubClient } from './github-client.js';
import type { PullRequestSnapshot } from './types.js';

/**
 * How the harness lands a pull request it has judged `ready-merge`: exclusively through GitHub's
 * merge queue on `main`.
 *
 * - Stacked PRs (`baseRefName !== "main"`) are refused with `refused-base` (exit 0 + notice) and
 *   no GitHub API calls. Once the parent merges and the PR is retargeted to `main`, a subsequent
 *   harness run lands it.
 * - When `main` has a merge queue enabled, `enqueuePullRequest` is called via `queueClient`
 *   (`ENGINEER_HARNESS_QUEUE_TOKEN`) with `expectedHeadOid = snapshot.headSha` so concurrent head
 *   updates fail safely. Built-in `GITHUB_TOKEN` cannot enqueue or start `merge_group` runs.
 * - When `main` has no merge queue enabled, landing fails closed with `MERGE_QUEUE_REQUIRED` and
 *   never falls back to a direct squash merge.
 */
export const MERGE_BASE_BRANCH = 'main';

export const stackedBaseNotice = (baseRefName: string): string =>
  `The base branch is ${baseRefName}, not ${MERGE_BASE_BRANCH}: the engineer harness merges or enqueues only pull ` +
  `requests whose base is ${MERGE_BASE_BRANCH}. Merge waits until this pull request is retargeted to ` +
  `${MERGE_BASE_BRANCH} (normally when its parent merges).`;

export type LandResult =
  | { kind: 'refused-base'; baseRefName: string; notice: string }
  | { kind: 'enqueued'; position: number }
  | { kind: 'already-queued' };

export type LandingClient = Pick<GitHubClient, 'getMergeQueueState'>;

export type QueueClient = Pick<GitHubClient, 'enqueuePullRequest'>;

export const QUEUE_TOKEN_MISSING =
  'The base branch requires a merge queue, but ENGINEER_HARNESS_QUEUE_TOKEN is not set. GitHub refuses an enqueue by ' +
  "the workflow's GITHUB_TOKEN, and its merge_group run would not start. Add the repository secret " +
  'ENGINEER_HARNESS_QUEUE_TOKEN (a fine-grained personal access token for this repository with contents ' +
  'and pull-requests write).';

export const MERGE_QUEUE_REQUIRED =
  `The base branch ${MERGE_BASE_BRANCH} has no merge queue, and the engineer harness does not merge directly: ` +
  'only the merge queue tests the combined merge_group tree on check.yml before fast-forwarding main. ' +
  `Nothing was merged. Turn "Require merge queue" on for ${MERGE_BASE_BRANCH}, or merge this pull request by hand ` +
  'after verifying every required current-head check.';

export type LandingSnapshot = Pick<PullRequestSnapshot, 'number' | 'headSha' | 'baseRefName'>;

export const landPullRequest = async (
  client: LandingClient,
  snapshot: LandingSnapshot,
  queueClient: QueueClient | null,
): Promise<LandResult> => {
  if (snapshot.baseRefName !== MERGE_BASE_BRANCH) {
    return {
      kind: 'refused-base',
      baseRefName: snapshot.baseRefName,
      notice: stackedBaseNotice(snapshot.baseRefName),
    };
  }

  const queue = await client.getMergeQueueState(snapshot.number, snapshot.baseRefName);

  if (!queue.enabled) {
    throw new Error(MERGE_QUEUE_REQUIRED);
  }
  if (queue.isInMergeQueue) {
    return { kind: 'already-queued' };
  }
  if (queueClient === null) {
    throw new Error(QUEUE_TOKEN_MISSING);
  }
  const entry = await queueClient.enqueuePullRequest(queue.pullRequestId, snapshot.headSha);
  return { kind: 'enqueued', position: entry.position };
};
