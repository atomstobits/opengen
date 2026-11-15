import { z } from 'zod';
import {
  createInitialHarnessState,
  ENGINEER_HARNESS_LABELS,
  ENGINEER_HARNESS_PR_LABELS,
  ENGINEER_HARNESS_READY_CHECK,
  hasCodexReviewRequest,
  hasQueueRetryCommand,
} from './controller.js';
import {
  isHarnessStateComment,
  isTrustedHarnessStateAuthor,
  parseHarnessStateComment,
} from './state-comment.js';
import type {
  CheckRunStatus,
  HarnessState,
  IssueComment,
  MergeQueueRemoval,
  PullRequestReview,
  PullRequestSnapshot,
  ReadyCheckPlan,
  ReviewThread,
  ReviewThreadComment,
} from './types.js';

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  apiBaseUrl?: string;
}

export interface HarnessStateComment {
  id: number;
  body: string;
  state: HarnessState;
}

interface LabelDefinition {
  name: (typeof ENGINEER_HARNESS_LABELS)[number];
  color: string;
  description: string;
}

export interface CreateIssueInput {
  title: string;
  body: string;
  labels: string[];
}

export interface CreatedIssue {
  number: number;
  url: string;
}

const nullableActorSchema = z
  .object({
    login: z.string().nullable(),
  })
  .nullable();

const reviewThreadCommentNodeSchema = z.object({
  id: z.string(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  author: nullableActorSchema,
});

const reviewThreadNodeSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: z.object({
    nodes: z.array(reviewThreadCommentNodeSchema),
  }),
});

const reviewNodeSchema = z.object({
  id: z.string(),
  body: z.string(),
  state: z.string(),
  submittedAt: z.string().nullable(),
  url: z.string(),
  authorAssociation: z.string(),
  author: z
    .object({
      login: z.string().nullable(),
      __typename: z.string().nullable(),
    })
    .nullable(),
  commit: z
    .object({
      oid: z.string().nullable(),
    })
    .nullable(),
});

const reactionGroupSchema = z.object({
  content: z.string(),
  users: z.object({
    nodes: z.array(
      z.object({
        login: z.string().nullable(),
      }),
    ),
  }),
});

const issueCommentNodeSchema = z.object({
  databaseId: z.number(),
  body: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: nullableActorSchema,
  authorAssociation: z.string().optional(),
  reactionGroups: z.array(reactionGroupSchema).optional(),
});

const mergeQueueTimelineNodeSchema = z.object({
  __typename: z.string(),
  createdAt: z.string().optional(),
  reason: z.string().nullable().optional(),
  commit: z.object({ oid: z.string() }).nullable().optional(),
  beforeCommit: z.object({ oid: z.string() }).nullable().optional(),
  afterCommit: z.object({ oid: z.string() }).nullable().optional(),
});

const mergeQueueTimelineGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        timelineItems: z.object({
          nodes: z.array(mergeQueueTimelineNodeSchema.nullable()),
        }),
      }),
    }),
  }),
});

const workflowRunsResponseSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number(),
      html_url: z.string(),
    }),
  ),
});

const workflowRunJobsResponseSchema = z.object({
  jobs: z.array(
    z.object({
      name: z.string(),
      conclusion: z.string().nullable(),
    }),
  ),
});

/** The workflow whose `merge_group` run gates a merge-queue entry in OpenGen. */
export const MERGE_QUEUE_CI_WORKFLOW_FILE = 'check.yml';

const FAILED_JOB_CONCLUSIONS: ReadonlyArray<string> = ['failure', 'timed_out', 'startup_failure'];

export type MergeQueueTimelineNode = z.infer<typeof mergeQueueTimelineNodeSchema>;

export type MergeQueueHistoryRemoval = Pick<
  MergeQueueRemoval,
  | 'enqueuedAt'
  | 'removedAt'
  | 'reason'
  | 'mergeGroupSha'
  | 'enqueuedHeadSha'
  | 'headAdvancedAfterEnqueue'
>;

export interface MergeQueueHistory {
  removal: MergeQueueHistoryRemoval | null;
  headForcePushedAt: string | null;
}

export const summarizeMergeQueueTimeline = (
  nodes: ReadonlyArray<MergeQueueTimelineNode | null>,
): MergeQueueHistory => {
  const nonNullNodes = nodes.filter((node): node is MergeQueueTimelineNode => node !== null);
  const hasCommitItems = nonNullNodes.some((node) => node.__typename === 'PullRequestCommit');
  const orderedNodes = hasCommitItems
    ? nonNullNodes
    : nonNullNodes
        .filter(
          (node): node is MergeQueueTimelineNode & { createdAt: string } =>
            node.createdAt !== undefined,
        )
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));

  let currentHeadSha: string | null = null;
  let enqueuedAt: string | null = null;
  let activeEnqueueHeadSha: string | null = null;
  let activeHeadAdvanced = false;
  let removal: MergeQueueHistoryRemoval | null = null;
  let headForcePushedAt: string | null = null;

  for (const node of orderedNodes) {
    if (node.__typename === 'PullRequestCommit') {
      const oid = node.commit?.oid ?? null;
      if (oid !== null) {
        currentHeadSha = oid;
      }
      if (enqueuedAt !== null) {
        activeHeadAdvanced = true;
      }
      if (removal !== null) {
        removal.headAdvancedAfterEnqueue = true;
      }
    } else if (node.__typename === 'HeadRefForcePushedEvent') {
      if (node.createdAt !== undefined) {
        headForcePushedAt = node.createdAt;
      }
      if (
        enqueuedAt !== null &&
        activeEnqueueHeadSha === null &&
        node.beforeCommit?.oid !== undefined
      ) {
        activeEnqueueHeadSha = node.beforeCommit.oid;
      }
      if (
        removal !== null &&
        (removal.enqueuedHeadSha === undefined || removal.enqueuedHeadSha === null) &&
        node.beforeCommit?.oid !== undefined &&
        removal.headAdvancedAfterEnqueue !== true
      ) {
        removal.enqueuedHeadSha = node.beforeCommit.oid;
      }
      if (node.afterCommit?.oid !== undefined) {
        currentHeadSha = node.afterCommit.oid;
      }
      if (enqueuedAt !== null) {
        activeHeadAdvanced = true;
      }
      if (removal !== null) {
        removal.headAdvancedAfterEnqueue = true;
      }
    } else if (node.__typename === 'AddedToMergeQueueEvent' && node.createdAt !== undefined) {
      enqueuedAt = node.createdAt;
      activeEnqueueHeadSha = currentHeadSha;
      activeHeadAdvanced = false;
      removal = null;
    } else if (node.__typename === 'RemovedFromMergeQueueEvent' && node.createdAt !== undefined) {
      removal = {
        enqueuedAt: enqueuedAt ?? node.createdAt,
        removedAt: node.createdAt,
        reason: node.reason ?? '',
        mergeGroupSha: node.beforeCommit?.oid ?? null,
        enqueuedHeadSha: activeEnqueueHeadSha,
        headAdvancedAfterEnqueue: activeHeadAdvanced,
      };
      enqueuedAt = null;
      activeEnqueueHeadSha = null;
      activeHeadAdvanced = false;
    }
  }

  return { removal, headForcePushedAt };
};

const graphqlErrorsSchema = z.object({
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const mergeQueueStateGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      mergeQueue: z.object({ id: z.string() }).nullable(),
      pullRequest: z.object({
        id: z.string(),
        isInMergeQueue: z.boolean(),
      }),
    }),
  }),
});

const enqueuePullRequestGraphqlResponseSchema = z.object({
  data: z.object({
    enqueuePullRequest: z.object({
      mergeQueueEntry: z
        .object({
          id: z.string(),
          position: z.number(),
        })
        .nullable(),
    }),
  }),
});

export interface MergeQueueState {
  enabled: boolean;
  pullRequestId: string;
  isInMergeQueue: boolean;
}

export interface MergeQueueEntry {
  id: string;
  position: number;
}

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const pullRequestGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        state: z.string(),
        merged: z.boolean(),
        isDraft: z.boolean(),
        author: nullableActorSchema.optional(),
        authorAssociation: z.string().optional(),
        headRefOid: z.string(),
        headRefName: z.string(),
        headRepository: z
          .object({
            nameWithOwner: z.string().nullable(),
          })
          .nullable(),
        baseRefName: z.string(),
        baseRepository: z.object({
          nameWithOwner: z.string(),
        }),
        labels: z.object({
          nodes: z.array(z.object({ name: z.string() })),
        }),
        commits: z.object({
          nodes: z.array(
            z.object({
              commit: z.object({
                committedDate: z.string(),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const reviewsGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviews: z.object({
          pageInfo: pageInfoSchema,
          nodes: z.array(reviewNodeSchema),
        }),
      }),
    }),
  }),
});

const reviewThreadsGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: pageInfoSchema,
          nodes: z.array(reviewThreadNodeSchema),
        }),
      }),
    }),
  }),
});

const issueCommentsGraphqlResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        comments: z.object({
          pageInfo: pageInfoSchema,
          nodes: z.array(issueCommentNodeSchema),
        }),
      }),
    }),
  }),
});

const issueCommentResponseSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string(),
    html_url: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    user: z.object({
      login: z.string().nullable(),
    }),
  }),
);

const createdIssueResponseSchema = z.object({
  number: z.number(),
  html_url: z.string(),
});

const checkRunsResponseSchema = z.object({
  check_runs: z.array(
    z.object({
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      started_at: z.string().nullable(),
      completed_at: z.string().nullable(),
    }),
  ),
});

const ENGINEER_HARNESS_LABEL_DEFINITIONS: LabelDefinition[] = [
  {
    name: 'agent:ready-for-local-claude',
    color: '1d76db',
    description: 'Codex plan issue is ready for local Claude Code execution.',
  },
  {
    name: 'agent:needs-local-claude',
    color: 'b60205',
    description: 'Engineer harness needs another local Claude repair round.',
  },
  {
    name: 'agent:awaiting-codex',
    color: '1d76db',
    description: 'Engineer harness is waiting for Codex review or CI.',
  },
  {
    name: 'agent:ready-human',
    color: 'fbca04',
    description: 'Automation is clean and waiting for a human approval.',
  },
  {
    name: 'agent:ready-merge',
    color: '0e8a16',
    description: 'Automation and merge policy are satisfied.',
  },
  {
    name: 'agent:halted',
    color: '5319e7',
    description: 'Engineer harness halted and needs manual intervention.',
  },
] satisfies LabelDefinition[];

const isEngineerHarnessPrLabel = (
  label: string,
): label is (typeof ENGINEER_HARNESS_PR_LABELS)[number] =>
  ENGINEER_HARNESS_PR_LABELS.some((candidateLabel) => candidateLabel === label);

const toReviewThreadComment = (
  comment: z.infer<typeof reviewThreadCommentNodeSchema>,
): ReviewThreadComment => ({
  id: comment.id,
  authorLogin: comment.author?.login ?? null,
  body: comment.body,
  url: comment.url,
  createdAt: comment.createdAt,
});

const toReviewThread = (thread: z.infer<typeof reviewThreadNodeSchema>): ReviewThread => ({
  id: thread.id,
  isResolved: thread.isResolved,
  comments: thread.comments.nodes.map(toReviewThreadComment),
});

const toPullRequestReview = (review: z.infer<typeof reviewNodeSchema>): PullRequestReview => ({
  id: review.id,
  authorLogin: review.author?.login ?? null,
  authorType: review.author?.__typename ?? null,
  authorAssociation: review.authorAssociation,
  body: review.body,
  state: review.state,
  submittedAt: review.submittedAt ?? '',
  url: review.url,
  commitOid: review.commit?.oid ?? null,
});

const collaboratorPermissionResponseSchema = z.object({ permission: z.string() });

const toGraphqlIssueComment = (comment: z.infer<typeof issueCommentNodeSchema>): IssueComment => ({
  id: comment.databaseId,
  body: comment.body,
  url: comment.url,
  authorLogin: comment.author?.login ?? null,
  createdAt: comment.createdAt,
  updatedAt: comment.updatedAt,
  ...(comment.authorAssociation === undefined
    ? {}
    : { authorAssociation: comment.authorAssociation }),
  reactionGroups:
    comment.reactionGroups?.map((group) => ({
      content: group.content,
      userLogins: group.users.nodes
        .map((user) => user.login)
        .filter((login): login is string => login !== null),
    })) ?? [],
});

const toIssueComment = (
  comment: z.infer<typeof issueCommentResponseSchema>[number],
): IssueComment => ({
  id: comment.id,
  body: comment.body,
  url: comment.html_url,
  authorLogin: comment.user.login,
  createdAt: comment.created_at,
  updatedAt: comment.updated_at,
});

const toCheckRunStatus = (
  checkRun: z.infer<typeof checkRunsResponseSchema>['check_runs'][number],
): CheckRunStatus => ({
  name: checkRun.name,
  status: checkRun.status,
  conclusion: checkRun.conclusion,
  startedAt: checkRun.started_at,
  completedAt: checkRun.completed_at,
});

const needsCommentPermissionCheck = (comment: IssueComment): boolean =>
  comment.authorLogin !== null &&
  comment.authorLogin !== 'github-actions[bot]' &&
  comment.authorLogin !== 'github-actions' &&
  (hasQueueRetryCommand(comment.body) || hasCodexReviewRequest(comment.body));

const needsReviewPermissionCheck = (review: PullRequestReview, headSha: string): boolean =>
  review.authorType !== 'Bot' &&
  review.authorLogin !== null &&
  review.state === 'APPROVED' &&
  review.commitOid === headSha;

export class GitHubClient {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly apiBaseUrl: string;

  public constructor(options: GitHubClientOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://api.github.com';
  }

  public async getPullRequestSnapshot(prNumber: number): Promise<PullRequestSnapshot> {
    const graphqlResponse = await this.requestJson('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: `
          query EngineerHarnessPullRequest($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
            repository(owner: $owner, name: $repo) {
              pullRequest(number: $pullRequestNumber) {
                number
                title
                url
                state
                merged
                isDraft
                author {
                  login
                }
                authorAssociation
                headRefOid
                headRefName
                headRepository {
                  nameWithOwner
                }
                baseRefName
                baseRepository {
                  nameWithOwner
                }
                labels(first: 100) {
                  nodes {
                    name
                  }
                }
                commits(last: 1) {
                  nodes {
                    commit {
                      committedDate
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          owner: this.owner,
          repo: this.repo,
          pullRequestNumber: prNumber,
        },
      }),
    });

    const parsedResponse = pullRequestGraphqlResponseSchema.parse(graphqlResponse);
    const pullRequest = parsedResponse.data.repository.pullRequest;
    const [ciChecks, listedComments, reviewThreads, listedReviews, mergeQueue] = await Promise.all([
      this.getCheckRuns(pullRequest.headRefOid),
      this.listGraphqlIssueComments(prNumber),
      this.listReviewThreads(prNumber),
      this.listReviews(prNumber),
      this.getMergeQueueRemoval(prNumber),
    ]);

    const headRepositoryNameWithOwner = pullRequest.headRepository?.nameWithOwner ?? null;
    const baseRepositoryNameWithOwner = pullRequest.baseRepository.nameWithOwner;
    const prAuthorLogin = pullRequest.author?.login ?? null;
    const shouldLookupPrAuthor =
      prAuthorLogin !== null && headRepositoryNameWithOwner === baseRepositoryNameWithOwner;

    const loginsToCheck = [
      ...new Set([
        ...(shouldLookupPrAuthor ? [prAuthorLogin] : []),
        ...listedComments
          .filter(needsCommentPermissionCheck)
          .flatMap((comment) => (comment.authorLogin === null ? [] : [comment.authorLogin])),
        ...listedReviews
          .filter((review) => needsReviewPermissionCheck(review, pullRequest.headRefOid))
          .flatMap((review) => (review.authorLogin === null ? [] : [review.authorLogin])),
      ]),
    ];
    const permissions = await this.lookupCollaboratorPermissions(loginsToCheck);

    const issueComments = listedComments.map((comment) => {
      const permission =
        comment.authorLogin !== null && needsCommentPermissionCheck(comment)
          ? permissions.get(comment.authorLogin)
          : undefined;
      return permission === undefined ? comment : { ...comment, authorPermission: permission };
    });

    const reviews = listedReviews.map((review) => {
      const permission =
        review.authorLogin !== null && needsReviewPermissionCheck(review, pullRequest.headRefOid)
          ? permissions.get(review.authorLogin)
          : undefined;
      return permission === undefined ? review : { ...review, authorPermission: permission };
    });

    const authorPermission =
      shouldLookupPrAuthor && prAuthorLogin !== null ? permissions.get(prAuthorLogin) : undefined;

    return {
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: pullRequest.state,
      merged: pullRequest.merged,
      isDraft: pullRequest.isDraft,
      headSha: pullRequest.headRefOid,
      headCommittedAt: pullRequest.commits.nodes[0]?.commit.committedDate ?? '',
      headRefName: pullRequest.headRefName,
      headRepositoryNameWithOwner,
      baseRefName: pullRequest.baseRefName,
      baseRepositoryNameWithOwner,
      ...(pullRequest.author === undefined ? {} : { authorLogin: prAuthorLogin }),
      ...(pullRequest.authorAssociation === undefined
        ? {}
        : { authorAssociation: pullRequest.authorAssociation }),
      ...(authorPermission === undefined ? {} : { authorPermission }),
      labels: pullRequest.labels.nodes.map((label) => label.name),
      reviewThreads,
      reviews,
      issueComments,
      ciChecks,
      mergeQueueRemoval: mergeQueue.removal,
      headForcePushedAt: mergeQueue.headForcePushedAt,
    };
  }

  public async getMergeQueueRemoval(
    prNumber: number,
  ): Promise<{ removal: MergeQueueRemoval | null; headForcePushedAt: string | null }> {
    const response = await this.requestGraphql(
      `
        query EngineerHarnessQueueTimeline($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $pullRequestNumber) {
              timelineItems(
                last: 100
                itemTypes: [
                  PULL_REQUEST_COMMIT
                  ADDED_TO_MERGE_QUEUE_EVENT
                  REMOVED_FROM_MERGE_QUEUE_EVENT
                  HEAD_REF_FORCE_PUSHED_EVENT
                ]
              ) {
                nodes {
                  __typename
                  ... on PullRequestCommit {
                    commit {
                      oid
                    }
                  }
                  ... on AddedToMergeQueueEvent {
                    createdAt
                  }
                  ... on RemovedFromMergeQueueEvent {
                    createdAt
                    reason
                    beforeCommit {
                      oid
                    }
                  }
                  ... on HeadRefForcePushedEvent {
                    createdAt
                    beforeCommit {
                      oid
                    }
                    afterCommit {
                      oid
                    }
                  }
                }
              }
            }
          }
        }
      `,
      { owner: this.owner, repo: this.repo, pullRequestNumber: prNumber },
    );
    const history = summarizeMergeQueueTimeline(
      mergeQueueTimelineGraphqlResponseSchema.parse(response).data.repository.pullRequest
        .timelineItems.nodes,
    );
    if (history.removal === null) {
      return { removal: null, headForcePushedAt: history.headForcePushedAt };
    }

    const run =
      history.removal.reason === 'failed_checks' && history.removal.mergeGroupSha !== null
        ? await this.getMergeGroupRun(history.removal.mergeGroupSha)
        : { runUrl: null, failedJobs: [] };

    return {
      removal: { ...history.removal, ...run },
      headForcePushedAt: history.headForcePushedAt,
    };
  }

  private async getMergeGroupRun(
    mergeGroupSha: string,
  ): Promise<{ runUrl: string | null; failedJobs: string[] }> {
    const runsResponse = await this.requestJson(
      `/repos/${this.owner}/${this.repo}/actions/workflows/${MERGE_QUEUE_CI_WORKFLOW_FILE}/runs?head_sha=${mergeGroupSha}&event=merge_group&per_page=10`,
      { method: 'GET' },
    );
    const run = workflowRunsResponseSchema.parse(runsResponse).workflow_runs[0];
    if (run === undefined) {
      return { runUrl: null, failedJobs: [] };
    }

    const jobsResponse = await this.requestJson(
      `/repos/${this.owner}/${this.repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
      { method: 'GET' },
    );
    const failedJobs = workflowRunJobsResponseSchema
      .parse(jobsResponse)
      .jobs.filter((job) => FAILED_JOB_CONCLUSIONS.includes(job.conclusion ?? ''))
      .map((job) => job.name);

    return { runUrl: run.html_url, failedJobs };
  }

  public async findHarnessStateComment(prNumber: number): Promise<HarnessStateComment | null> {
    const issueComments = await this.listIssueComments(prNumber);
    const existingComment = issueComments
      .slice()
      .reverse()
      .find(
        (comment) =>
          isTrustedHarnessStateAuthor(comment.authorLogin) && isHarnessStateComment(comment.body),
      );

    if (existingComment === undefined) {
      return null;
    }

    const parsedState =
      parseHarnessStateComment(existingComment.body) ?? createInitialHarnessState();
    return {
      id: existingComment.id,
      body: existingComment.body,
      state: parsedState,
    };
  }

  public async upsertHarnessStateComment(
    prNumber: number,
    existingCommentId: number | null,
    body: string,
  ): Promise<void> {
    if (existingCommentId === null) {
      await this.requestJson(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      return;
    }

    await this.requestJson(
      `/repos/${this.owner}/${this.repo}/issues/comments/${existingCommentId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ body }),
      },
    );
  }

  public async createIssueComment(prNumber: number, body: string): Promise<void> {
    await this.requestJson(`/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }

  public async createIssue(input: CreateIssueInput): Promise<CreatedIssue> {
    const response = await this.requestJson(`/repos/${this.owner}/${this.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    const parsedResponse = createdIssueResponseSchema.parse(response);

    return {
      number: parsedResponse.number,
      url: parsedResponse.html_url,
    };
  }

  public async ensureHarnessLabels(): Promise<void> {
    for (const definition of ENGINEER_HARNESS_LABEL_DEFINITIONS) {
      await this.requestJson(
        `/repos/${this.owner}/${this.repo}/labels`,
        {
          method: 'POST',
          body: JSON.stringify(definition),
        },
        [201, 422],
      );
    }
  }

  public async syncIssueLabels(
    prNumber: number,
    currentLabels: string[],
    desiredAgentLabels: string[],
  ): Promise<void> {
    const desiredSet = new Set(desiredAgentLabels.filter(isEngineerHarnessPrLabel));
    const currentAgentSet = new Set<string>(currentLabels.filter(isEngineerHarnessPrLabel));

    const labelsToAdd = [...desiredSet].filter((label) => !currentAgentSet.has(label));
    const labelsToRemove = ENGINEER_HARNESS_PR_LABELS.filter(
      (label) => currentAgentSet.has(label) && !desiredSet.has(label),
    );

    if (labelsToAdd.length > 0) {
      await this.requestJson(
        `/repos/${this.owner}/${this.repo}/issues/${prNumber}/labels`,
        {
          method: 'POST',
          body: JSON.stringify({ labels: labelsToAdd }),
        },
        [200, 201],
      );
    }

    for (const label of labelsToRemove) {
      await this.requestJson(
        `/repos/${this.owner}/${this.repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`,
        { method: 'DELETE' },
        [200, 204, 404],
      );
    }
  }

  public async createCheckRun(
    headSha: string,
    plan: ReadyCheckPlan,
    detailsUrl: string | null,
  ): Promise<void> {
    const requestBody = {
      name: ENGINEER_HARNESS_READY_CHECK,
      head_sha: headSha,
      status: plan.status,
      conclusion: plan.status === 'completed' ? plan.conclusion : undefined,
      details_url: detailsUrl ?? undefined,
      output: {
        title: plan.title,
        summary: plan.summary,
      },
    };

    await this.requestJson(`/repos/${this.owner}/${this.repo}/check-runs`, {
      method: 'POST',
      body: JSON.stringify(requestBody),
      headers: {
        Accept: 'application/vnd.github+json',
      },
    });
  }

  public async getMergeQueueState(prNumber: number, baseRefName: string): Promise<MergeQueueState> {
    const response = await this.requestGraphql(
      `
        query EngineerHarnessMergeQueue(
          $owner: String!
          $repo: String!
          $pullRequestNumber: Int!
          $baseRefName: String!
        ) {
          repository(owner: $owner, name: $repo) {
            mergeQueue(branch: $baseRefName) {
              id
            }
            pullRequest(number: $pullRequestNumber) {
              id
              isInMergeQueue
            }
          }
        }
      `,
      {
        owner: this.owner,
        repo: this.repo,
        pullRequestNumber: prNumber,
        baseRefName,
      },
    );
    const repository = mergeQueueStateGraphqlResponseSchema.parse(response).data.repository;
    return {
      enabled: repository.mergeQueue !== null,
      pullRequestId: repository.pullRequest.id,
      isInMergeQueue: repository.pullRequest.isInMergeQueue,
    };
  }

  public async enqueuePullRequest(
    pullRequestId: string,
    expectedHeadOid: string,
  ): Promise<MergeQueueEntry> {
    const response = await this.requestGraphql(
      `
        mutation EngineerHarnessEnqueue($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
          enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
            mergeQueueEntry {
              id
              position
            }
          }
        }
      `,
      { pullRequestId, expectedHeadOid },
    );
    const entry =
      enqueuePullRequestGraphqlResponseSchema.parse(response).data.enqueuePullRequest
        .mergeQueueEntry;
    if (entry === null) {
      throw new Error('GitHub accepted the enqueue request but returned no merge queue entry.');
    }
    return entry;
  }

  private async lookupCollaboratorPermissions(logins: string[]): Promise<Map<string, string>> {
    const permissions = new Map<string, string>();
    if (logins.length === 0) {
      return permissions;
    }

    await Promise.all(
      logins.map(async (login) => {
        try {
          const response = await this.requestJson(
            `/repos/${this.owner}/${this.repo}/collaborators/${encodeURIComponent(login)}/permission`,
            { method: 'GET' },
          );
          permissions.set(login, collaboratorPermissionResponseSchema.parse(response).permission);
        } catch (error) {
          permissions.set(login, 'unknown');
          console.error(
            `engineer-harness: no repository permission read for ${login}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );

    return permissions;
  }

  private async listIssueComments(prNumber: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let page = 1;

    while (true) {
      const response = await this.requestJson(
        `/repos/${this.owner}/${this.repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        {
          method: 'GET',
        },
      );

      const pageComments = issueCommentResponseSchema.parse(response).map(toIssueComment);
      comments.push(...pageComments);

      if (pageComments.length < 100) {
        break;
      }

      page += 1;
    }

    return comments;
  }

  private async listGraphqlIssueComments(prNumber: number): Promise<IssueComment[]> {
    const comments: IssueComment[] = [];
    let cursor: string | null = null;

    while (true) {
      const response = await this.requestJson('/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query: `
            query EngineerHarnessIssueComments(
              $owner: String!
              $repo: String!
              $pullRequestNumber: Int!
              $commentsCursor: String
            ) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $pullRequestNumber) {
                  comments(first: 100, after: $commentsCursor) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      databaseId
                      body
                      url
                      createdAt
                      updatedAt
                      authorAssociation
                      author {
                        login
                      }
                      reactionGroups {
                        content
                        users(first: 100) {
                          nodes {
                            login
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            owner: this.owner,
            repo: this.repo,
            pullRequestNumber: prNumber,
            commentsCursor: cursor,
          },
        }),
      });

      const parsedResponse = issueCommentsGraphqlResponseSchema.parse(response);
      const page = parsedResponse.data.repository.pullRequest.comments;
      comments.push(...page.nodes.map(toGraphqlIssueComment));

      if (!page.pageInfo.hasNextPage) {
        break;
      }

      cursor = page.pageInfo.endCursor;
      if (cursor === null) {
        throw new Error('GitHub reported more issue comments without a pagination cursor.');
      }
    }

    return comments;
  }

  private async listReviewThreads(prNumber: number): Promise<ReviewThread[]> {
    const reviewThreads: ReviewThread[] = [];
    let cursor: string | null = null;

    while (true) {
      const response = await this.requestJson('/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query: `
            query EngineerHarnessReviewThreads(
              $owner: String!
              $repo: String!
              $pullRequestNumber: Int!
              $reviewThreadsCursor: String
            ) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $pullRequestNumber) {
                  reviewThreads(first: 100, after: $reviewThreadsCursor) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      id
                      isResolved
                      comments(first: 1) {
                        nodes {
                          id
                          body
                          url
                          createdAt
                          author {
                            login
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            owner: this.owner,
            repo: this.repo,
            pullRequestNumber: prNumber,
            reviewThreadsCursor: cursor,
          },
        }),
      });

      const parsedResponse = reviewThreadsGraphqlResponseSchema.parse(response);
      const page = parsedResponse.data.repository.pullRequest.reviewThreads;
      reviewThreads.push(...page.nodes.map(toReviewThread));

      if (!page.pageInfo.hasNextPage) {
        break;
      }

      cursor = page.pageInfo.endCursor;
      if (cursor === null) {
        throw new Error('GitHub reported more review threads without a pagination cursor.');
      }
    }

    return reviewThreads;
  }

  private async listReviews(prNumber: number): Promise<PullRequestReview[]> {
    const reviews: PullRequestReview[] = [];
    let cursor: string | null = null;

    while (true) {
      const response = await this.requestJson('/graphql', {
        method: 'POST',
        body: JSON.stringify({
          query: `
            query EngineerHarnessReviews(
              $owner: String!
              $repo: String!
              $pullRequestNumber: Int!
              $reviewsCursor: String
            ) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $pullRequestNumber) {
                  reviews(
                    first: 100
                    after: $reviewsCursor
                    states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]
                  ) {
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                    nodes {
                      id
                      body
                      state
                      submittedAt
                      url
                      authorAssociation
                      author {
                        login
                        __typename
                      }
                      commit {
                        oid
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            owner: this.owner,
            repo: this.repo,
            pullRequestNumber: prNumber,
            reviewsCursor: cursor,
          },
        }),
      });

      const parsedResponse = reviewsGraphqlResponseSchema.parse(response);
      const page = parsedResponse.data.repository.pullRequest.reviews;
      reviews.push(...page.nodes.map(toPullRequestReview));

      if (!page.pageInfo.hasNextPage) {
        break;
      }

      cursor = page.pageInfo.endCursor;
      if (cursor === null) {
        throw new Error('GitHub reported more reviews without a pagination cursor.');
      }
    }

    return reviews;
  }

  private async getCheckRuns(headSha: string): Promise<CheckRunStatus[]> {
    const checkRuns: CheckRunStatus[] = [];
    let page = 1;

    while (true) {
      const suffix = page === 1 ? 'per_page=100' : `per_page=100&page=${page}`;
      const response = await this.requestJson(
        `/repos/${this.owner}/${this.repo}/commits/${headSha}/check-runs?${suffix}`,
        {
          method: 'GET',
        },
      );

      const pageRuns = checkRunsResponseSchema.parse(response).check_runs.map(toCheckRunStatus);
      checkRuns.push(...pageRuns);

      if (pageRuns.length < 100) {
        break;
      }

      page += 1;
    }

    return checkRuns;
  }

  private async requestGraphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.requestJson('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    const errors = graphqlErrorsSchema.parse(response).errors ?? [];
    if (errors.length > 0) {
      throw new Error(
        `GitHub GraphQL request failed: ${errors.map((error) => error.message).join('; ')}`,
      );
    }
    return response;
  }

  private async requestJson(
    path: string,
    init: RequestInit,
    allowedStatusCodes: number[] = [200, 201],
  ): Promise<unknown> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: 'application/vnd.github+json',
        ...init.headers,
      },
    });

    if (!allowedStatusCodes.includes(response.status)) {
      const responseText = await response.text();
      throw new Error(
        `GitHub API request failed (${response.status} ${response.statusText}): ${responseText}`,
      );
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }
}
