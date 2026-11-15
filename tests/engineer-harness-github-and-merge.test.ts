import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, runMerge, runSync } from '../scripts/engineer-harness/src/cli.js';
import { REQUIRED_CI_CHECKS } from '../scripts/engineer-harness/src/controller.js';
import {
  GitHubClient,
  MERGE_QUEUE_CI_WORKFLOW_FILE,
  type MergeQueueState,
  summarizeMergeQueueTimeline,
} from '../scripts/engineer-harness/src/github-client.js';
import {
  type LandingSnapshot,
  landPullRequest,
  MERGE_BASE_BRANCH,
  MERGE_QUEUE_REQUIRED,
  QUEUE_TOKEN_MISSING,
  type QueueClient,
} from '../scripts/engineer-harness/src/merge.js';
import {
  ENGINEER_HARNESS_STATE_END,
  ENGINEER_HARNESS_STATE_START,
} from '../scripts/engineer-harness/src/state-comment.js';

const HEAD_SHA = 'b'.repeat(40);

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GitHubClient snapshots, permissions, and state comments', () => {
  it('paginates review threads and GraphQL issue comments and batches collaborator permission lookups once per login', async () => {
    const permissionLookups: string[] = [];
    const threadCursors: unknown[] = [];
    const commentCursors: unknown[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith(`/commits/${HEAD_SHA}/check-runs?per_page=100`)) {
          return jsonResponse({ check_runs: [] });
        }

        const permMatch = url.match(
          /\/repos\/atomstobits\/opengen\/collaborators\/([^/]+)\/permission$/,
        );
        if (permMatch !== null) {
          const login = decodeURIComponent(permMatch[1] ?? '');
          permissionLookups.push(login);
          const map: Record<string, string> = {
            maintainer: 'write',
            troll: 'none',
          };
          const permission = map[login];
          return permission === undefined
            ? new Response('Not Found', { status: 404 })
            : jsonResponse({ permission });
        }

        const body = JSON.parse(String(init?.body)) as {
          query: string;
          variables: Record<string, unknown>;
        };
        if (body.query.includes('EngineerHarnessPullRequest')) {
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  number: 17,
                  title: 'Test PR',
                  url: 'https://github.test/atomstobits/opengen/pull/17',
                  state: 'OPEN',
                  merged: false,
                  isDraft: false,
                  author: { login: 'maintainer' },
                  authorAssociation: 'MEMBER',
                  headRefOid: HEAD_SHA,
                  headRefName: 'codex/test',
                  headRepository: { nameWithOwner: 'atomstobits/opengen' },
                  baseRefName: 'main',
                  baseRepository: { nameWithOwner: 'atomstobits/opengen' },
                  labels: { nodes: [{ name: 'enhancement' }] },
                  commits: {
                    nodes: [{ commit: { committedDate: '2026-11-14T00:00:00.000Z' } }],
                  },
                  reviews: { nodes: [] },
                },
              },
            },
          });
        }

        if (body.query.includes('EngineerHarnessIssueComments')) {
          const cursor = body.variables['commentsCursor'];
          commentCursors.push(cursor);
          const firstPage = cursor === null;
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  comments: {
                    pageInfo: {
                      hasNextPage: firstPage,
                      endCursor: firstPage ? 'comment-cursor-1' : null,
                    },
                    nodes: firstPage
                      ? [
                          {
                            databaseId: 1,
                            body: `<!-- codex-auto-review:${HEAD_SHA} -->\n@codex review current head ${HEAD_SHA}`,
                            url: 'https://github.test/comment/1',
                            createdAt: '2026-11-14T00:01:00.000Z',
                            updatedAt: '2026-11-14T00:01:00.000Z',
                            authorAssociation: 'MEMBER',
                            author: { login: 'maintainer' },
                            reactionGroups: [],
                          },
                          {
                            databaseId: 2,
                            body: 'ordinary discussion comment',
                            url: 'https://github.test/comment/2',
                            createdAt: '2026-11-14T00:01:30.000Z',
                            updatedAt: '2026-11-14T00:01:30.000Z',
                            authorAssociation: 'NONE',
                            author: { login: 'bystander' },
                            reactionGroups: [],
                          },
                        ]
                      : [
                          {
                            databaseId: 3,
                            body: `/harness-requeue ${HEAD_SHA}`,
                            url: 'https://github.test/comment/3',
                            createdAt: '2026-11-14T00:02:00.000Z',
                            updatedAt: '2026-11-14T00:02:00.000Z',
                            authorAssociation: 'NONE',
                            author: { login: 'troll' },
                            reactionGroups: [],
                          },
                        ],
                  },
                },
              },
            },
          });
        }

        if (body.query.includes('EngineerHarnessReviewThreads')) {
          const cursor = body.variables['reviewThreadsCursor'];
          threadCursors.push(cursor);
          const firstPage = cursor === null;
          const idx = firstPage ? 1 : 2;
          return jsonResponse({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    pageInfo: {
                      hasNextPage: firstPage,
                      endCursor: firstPage ? 'thread-cursor-1' : null,
                    },
                    nodes: [
                      {
                        id: `THREAD_${idx}`,
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              id: `C_${idx}`,
                              body: `Finding ${idx}`,
                              url: `https://github.test/thread/${idx}`,
                              createdAt: '2026-11-14T00:00:00.000Z',
                              author: { login: 'reviewer' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          });
        }

        if (body.query.includes('EngineerHarnessQueueTimeline')) {
          return jsonResponse({
            data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } },
          });
        }

        return new Response('unexpected request', { status: 500 });
      }),
    );

    const client = new GitHubClient({
      owner: 'atomstobits',
      repo: 'opengen',
      token: 'test-token',
      apiBaseUrl: 'https://github.test',
    });

    const snapshot = await client.getPullRequestSnapshot(17);
    expect(snapshot.authorLogin).toBe('maintainer');
    expect(snapshot.authorPermission).toBe('write');
    expect(snapshot.reviewThreads.map((t) => t.id)).toEqual(['THREAD_1', 'THREAD_2']);
    expect(threadCursors).toEqual([null, 'thread-cursor-1']);
    expect(commentCursors).toEqual([null, 'comment-cursor-1']);
    // `maintainer` is both PR author and `@codex review` author -> looked up once; `bystander` -> skipped.
    expect(permissionLookups.sort()).toEqual(['maintainer', 'troll']);
    expect(snapshot.issueComments.map((c) => c.authorPermission)).toEqual([
      'write',
      undefined,
      'none',
    ]);
  });

  it('queries check.yml merge_group runs when summarizing a failed_checks merge queue removal', async () => {
    expect(MERGE_QUEUE_CI_WORKFLOW_FILE).toBe('check.yml');
    const mergeGroupSha = '1fa13ab4d80b7a355d88000a26b9d2cab4f3e3f8';
    const requestedUrls: string[] = [];

    const timelineNodes = [
      { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-14T01:00:00Z' },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: '2026-11-14T01:12:00Z',
        reason: 'failed_checks',
        beforeCommit: { oid: mergeGroupSha },
      },
    ];
    expect(summarizeMergeQueueTimeline(timelineNodes)).toEqual({
      removal: {
        enqueuedAt: '2026-11-14T01:00:00Z',
        removedAt: '2026-11-14T01:12:00Z',
        reason: 'failed_checks',
        mergeGroupSha,
      },
      headForcePushedAt: null,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url === 'https://github.test/graphql') {
          return jsonResponse({
            data: { repository: { pullRequest: { timelineItems: { nodes: timelineNodes } } } },
          });
        }
        if (
          url.includes(
            `/actions/workflows/check.yml/runs?head_sha=${mergeGroupSha}&event=merge_group`,
          )
        ) {
          return jsonResponse({
            workflow_runs: [
              {
                id: 501,
                html_url: 'https://github.com/atomstobits/opengen/actions/runs/501',
              },
            ],
          });
        }
        if (url.includes('/actions/runs/501/jobs?')) {
          return jsonResponse({
            jobs: [
              { name: 'verify', conclusion: 'success' },
              { name: 'containers', conclusion: 'failure' },
              { name: 'secrets', conclusion: 'timed_out' },
            ],
          });
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const client = new GitHubClient({
      owner: 'atomstobits',
      repo: 'opengen',
      token: 'test-token',
      apiBaseUrl: 'https://github.test',
    });

    const result = await client.getMergeQueueRemoval(17);
    expect(result).toEqual({
      removal: {
        enqueuedAt: '2026-11-14T01:00:00Z',
        removedAt: '2026-11-14T01:12:00Z',
        reason: 'failed_checks',
        mergeGroupSha,
        runUrl: 'https://github.com/atomstobits/opengen/actions/runs/501',
        failedJobs: ['containers', 'secrets'],
      },
      headForcePushedAt: null,
    });
    expect(requestedUrls.some((u) => u.includes('/actions/workflows/check.yml/runs'))).toBe(true);
  });

  it('ignores spoofed state comments from non-github-actions users when reading harness state', async () => {
    const trustedState = {
      version: 1,
      roundsUsed: 2,
      lastTaskSignature: 'sig-2',
      lastTaskHeadSha: HEAD_SHA,
      lastTaskItems: ['ci:verify'],
      halted: false,
      haltReason: null,
    };
    const spoofedState = {
      version: 1,
      roundsUsed: 0,
      lastTaskSignature: null,
      lastTaskHeadSha: null,
      lastTaskItems: null,
      halted: false,
      haltReason: null,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse([
          {
            id: 10,
            body: `${ENGINEER_HARNESS_STATE_START}\n${JSON.stringify(trustedState)}\n${ENGINEER_HARNESS_STATE_END}`,
            html_url: 'https://github.test/comment/10',
            created_at: '2026-11-14T00:01:00.000Z',
            updated_at: '2026-11-14T00:01:00.000Z',
            user: { login: 'github-actions[bot]' },
          },
          {
            id: 11,
            body: `${ENGINEER_HARNESS_STATE_START}\n${JSON.stringify(spoofedState)}\n${ENGINEER_HARNESS_STATE_END}`,
            html_url: 'https://github.test/comment/11',
            created_at: '2026-11-14T00:02:00.000Z',
            updated_at: '2026-11-14T00:02:00.000Z',
            user: { login: 'external-attacker' },
          },
        ]),
      ),
    );

    const client = new GitHubClient({
      owner: 'atomstobits',
      repo: 'opengen',
      token: 'test-token',
      apiBaseUrl: 'https://github.test',
    });

    const stateComment = await client.findHarnessStateComment(17);
    expect(stateComment?.id).toBe(10);
    expect(stateComment?.state).toEqual(trustedState);
  });
});

describe('landPullRequest merge-queue enforcement', () => {
  const snapshot = (overrides: Partial<LandingSnapshot> = {}): LandingSnapshot => ({
    number: 17,
    headSha: HEAD_SHA,
    baseRefName: 'main',
    ...overrides,
  });

  const fakeClient = (queue: MergeQueueState | Error) => ({
    getMergeQueueState: vi.fn(async () => {
      if (queue instanceof Error) {
        throw queue;
      }
      return queue;
    }),
  });

  const fakeQueueClient = (
    enqueue: { position: number } | Error = { position: 2 },
  ): QueueClient => ({
    enqueuePullRequest: vi.fn(async () => {
      if (enqueue instanceof Error) {
        throw enqueue;
      }
      return { id: 'MQE_1', position: enqueue.position };
    }),
  });

  it('refuses non-main base branches without calling GitHub', async () => {
    expect(MERGE_BASE_BRANCH).toBe('main');
    for (const baseRefName of ['codex/unified-inputs', 'Main', 'release/main', '']) {
      const client = fakeClient({
        enabled: true,
        pullRequestId: 'PR_17',
        isInMergeQueue: false,
      });
      const queueClient = fakeQueueClient();

      const result = await landPullRequest(client, snapshot({ baseRefName }), queueClient);
      expect(result).toMatchObject({ kind: 'refused-base', baseRefName });
      expect(client.getMergeQueueState).not.toHaveBeenCalled();
      expect(queueClient.enqueuePullRequest).not.toHaveBeenCalled();
    }
  });

  it('fails closed when merge queue is disabled or queue token is missing, and enqueues cleanly when enabled', async () => {
    await expect(
      landPullRequest(
        fakeClient({ enabled: false, pullRequestId: 'PR_17', isInMergeQueue: false }),
        snapshot(),
        fakeQueueClient(),
      ),
    ).rejects.toThrow(MERGE_QUEUE_REQUIRED);

    await expect(
      landPullRequest(
        fakeClient({ enabled: true, pullRequestId: 'PR_17', isInMergeQueue: false }),
        snapshot(),
        null,
      ),
    ).rejects.toThrow(QUEUE_TOKEN_MISSING);

    await expect(
      landPullRequest(
        fakeClient({ enabled: true, pullRequestId: 'PR_17', isInMergeQueue: true }),
        snapshot(),
        null,
      ),
    ).resolves.toEqual({ kind: 'already-queued' });

    const queueClient = fakeQueueClient({ position: 4 });
    await expect(
      landPullRequest(
        fakeClient({ enabled: true, pullRequestId: 'PR_17', isInMergeQueue: false }),
        snapshot(),
        queueClient,
      ),
    ).resolves.toEqual({ kind: 'enqueued', position: 4 });
    expect(queueClient.enqueuePullRequest).toHaveBeenCalledWith('PR_17', HEAD_SHA);
  });
});

describe('CLI runSync and runMerge end-to-end flows', () => {
  const mockGitHubEnvironment = (options: {
    headRepo: string;
    authorPermission?: string;
    humanApproved?: boolean;
    baseRefName?: string;
  }) => {
    const enqueuedCalls: Array<{ pullRequestId: string; expectedHeadOid: string; auth: string }> =
      [];
    const createdChecks: unknown[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const authHeader =
          (init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '';

        if (url.endsWith(`/commits/${HEAD_SHA}/check-runs?per_page=100`)) {
          return jsonResponse({
            check_runs: REQUIRED_CI_CHECKS.map((name) => ({
              name,
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-11-14T00:00:00.000Z',
              completed_at: '2026-11-14T00:01:00.000Z',
            })),
          });
        }
        if (url.includes('/collaborators/')) {
          return jsonResponse({ permission: options.authorPermission ?? 'write' });
        }
        if (url.includes('/issues/42/comments?per_page=100')) {
          return jsonResponse([]);
        }
        if (url.endsWith('/labels') && init?.method === 'POST') {
          return jsonResponse({}, 422);
        }
        if (url.endsWith('/issues/42/labels') && init?.method === 'PUT') {
          return jsonResponse([]);
        }
        if (url.endsWith('/issues/42/comments') && init?.method === 'POST') {
          return jsonResponse({ id: 99 }, 201);
        }
        if (url.endsWith('/check-runs') && init?.method === 'POST') {
          createdChecks.push(JSON.parse(String(init.body)));
          return jsonResponse({}, 201);
        }

        if (url.endsWith('/graphql')) {
          const body = JSON.parse(String(init?.body)) as {
            query: string;
            variables: { pullRequestId?: string; expectedHeadOid?: string };
          };
          if (body.query.includes('EngineerHarnessPullRequest')) {
            return jsonResponse({
              data: {
                repository: {
                  pullRequest: {
                    number: 42,
                    title: 'feat: harness',
                    url: 'https://github.com/atomstobits/opengen/pull/42',
                    state: 'OPEN',
                    merged: false,
                    isDraft: false,
                    author: { login: 'author-user' },
                    authorAssociation:
                      options.headRepo === 'atomstobits/opengen' ? 'MEMBER' : 'NONE',
                    headRefOid: HEAD_SHA,
                    headRefName: 'codex/feature',
                    headRepository: { nameWithOwner: options.headRepo },
                    baseRefName: options.baseRefName ?? 'main',
                    baseRepository: { nameWithOwner: 'atomstobits/opengen' },
                    labels: { nodes: [] },
                    commits: {
                      nodes: [{ commit: { committedDate: '2026-11-14T00:00:00.000Z' } }],
                    },
                    reviews: {
                      nodes: options.humanApproved
                        ? [
                            {
                              id: 'REV_OK',
                              body: 'Approved',
                              state: 'APPROVED',
                              submittedAt: '2026-11-14T00:04:00.000Z',
                              url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-1',
                              authorAssociation: 'MEMBER',
                              author: { login: 'maintainer', __typename: 'User' },
                              commit: { oid: HEAD_SHA },
                            },
                          ]
                        : [],
                    },
                  },
                },
              },
            });
          }
          if (body.query.includes('EngineerHarnessIssueComments')) {
            return jsonResponse({
              data: {
                repository: {
                  pullRequest: {
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        {
                          databaseId: 1,
                          body: `<!-- codex-auto-review:${HEAD_SHA} -->\n@codex review current head ${HEAD_SHA}`,
                          url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1',
                          createdAt: '2026-11-14T00:02:00.000Z',
                          updatedAt: '2026-11-14T00:02:00.000Z',
                          authorAssociation: 'MEMBER',
                          author: { login: 'maintainer' },
                          reactionGroups: [],
                        },
                        {
                          databaseId: 2,
                          body: `<!-- codex-review-receipt:v1 -->\nCodex Review: No issues found.\n**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
                          url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2',
                          createdAt: '2026-11-14T00:03:00.000Z',
                          updatedAt: '2026-11-14T00:03:00.000Z',
                          authorAssociation: 'NONE',
                          author: { login: 'chatgpt-codex-connector' },
                          reactionGroups: [],
                        },
                      ],
                    },
                  },
                },
              },
            });
          }
          if (body.query.includes('EngineerHarnessReviewThreads')) {
            return jsonResponse({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [],
                    },
                  },
                },
              },
            });
          }
          if (body.query.includes('EngineerHarnessQueueTimeline')) {
            return jsonResponse({
              data: { repository: { pullRequest: { timelineItems: { nodes: [] } } } },
            });
          }
          if (body.query.includes('EngineerHarnessMergeQueue')) {
            return jsonResponse({
              data: {
                repository: {
                  mergeQueue: { id: 'MQ_1' },
                  pullRequest: { id: 'PR_NODE_42', isInMergeQueue: false },
                },
              },
            });
          }
          if (body.query.includes('EngineerHarnessEnqueue')) {
            enqueuedCalls.push({
              pullRequestId: String(body.variables.pullRequestId),
              expectedHeadOid: String(body.variables.expectedHeadOid),
              auth: authHeader,
            });
            return jsonResponse({
              data: {
                enqueuePullRequest: { mergeQueueEntry: { id: 'MQE_42', position: 1 } },
              },
            });
          }
        }

        return new Response(`unexpected ${url}`, { status: 500 });
      }),
    );

    return { enqueuedCalls, createdChecks };
  };

  it('syncs and enqueues a trusted internal PR, refuses an unapproved fork PR, and enqueues an approved fork PR', async () => {
    const previousEnv = { ...process.env };
    try {
      process.env['GITHUB_TOKEN'] = 'test-wf';
      process.env['ENGINEER_HARNESS_QUEUE_TOKEN'] = 'test-mq';
      process.env['GITHUB_REPOSITORY'] = 'atomstobits/opengen';
      process.env['PR_NUMBER'] = '42';
      process.env['CODEX_REVIEW_ACTOR'] = 'chatgpt-codex-connector';
      process.env['ENGINEER_HARNESS_MERGE_POLICY'] = 'auto-merge';

      const stdout: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });

      // 1. Internal collaborator PR -> ready-merge -> enqueued with queue token.
      const internal = mockGitHubEnvironment({ headRepo: 'atomstobits/opengen' });
      await runSync();
      await runMerge();
      expect(stdout.join('')).toContain('ready-merge\n');
      expect(internal.enqueuedCalls).toEqual([
        {
          pullRequestId: 'PR_NODE_42',
          expectedHeadOid: HEAD_SHA,
          auth: 'Bearer test-mq',
        },
      ]);

      // 2. External fork PR without collaborator approval -> ready-human -> NOT enqueued.
      stdout.length = 0;
      const unapprovedFork = mockGitHubEnvironment({
        headRepo: 'fork-user/opengen',
        humanApproved: false,
      });
      await runSync();
      await runMerge();
      expect(stdout.join('')).toContain('ready-human\n');
      expect(stdout.join('')).toContain('Pull request is not ready to merge: ready-human');
      expect(unapprovedFork.enqueuedCalls).toEqual([]);

      // 3. External fork PR WITH collaborator approval on headSha -> ready-merge -> enqueued!
      stdout.length = 0;
      const approvedFork = mockGitHubEnvironment({
        headRepo: 'fork-user/opengen',
        humanApproved: true,
      });
      await runSync();
      await runMerge();
      expect(stdout.join('')).toContain(
        'Added pull request to the main merge queue at position 1.',
      );
      expect(approvedFork.enqueuedCalls).toHaveLength(1);

      // 4. Unknown CLI subcommand rejects with usage help.
      await expect(main(['unknown'])).rejects.toThrow('Usage: node --import tsx');
    } finally {
      process.env = previousEnv;
    }
  });
});
