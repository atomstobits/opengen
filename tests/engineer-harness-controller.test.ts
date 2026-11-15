import { describe, expect, it } from 'vitest';
import {
  buildRunUrl,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MERGE_POLICY,
  loadConfigFromEnv,
  normalizeMergePolicy,
  parseMaxRounds,
} from '../scripts/engineer-harness/src/config.js';
import {
  createInitialHarnessState,
  ENGINEER_HARNESS_READY_CHECK,
  evaluateHarness,
  isTrustedInternalPullRequest,
  QUEUE_RETRY_COMMAND,
  REQUIRED_CI_CHECKS,
} from '../scripts/engineer-harness/src/controller.js';
import {
  formatCodexReviewPrompt,
  formatPlanIssueBody,
  LOCAL_CLAUDE_HANDOFF_PROMPT,
  PLAN_ISSUE_LABEL,
} from '../scripts/engineer-harness/src/plan-issue.js';
import {
  formatHarnessStateComment,
  isHarnessStateComment,
  isTrustedHarnessStateAuthor,
  parseHarnessStateComment,
} from '../scripts/engineer-harness/src/state-comment.js';
import type {
  CheckRunStatus,
  HarnessConfig,
  IssueComment,
  MergeQueueRemoval,
  PullRequestSnapshot,
  ReviewThread,
} from '../scripts/engineer-harness/src/types.js';

const HEAD_SHA = 'abc1234abc1234abc1234abc1234abc1234abc12';
const OTHER_SHA = 'def5678def5678def5678def5678def5678def56';

const passingChecks = (): CheckRunStatus[] =>
  REQUIRED_CI_CHECKS.map((name) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-11-14T00:00:00.000Z',
    completedAt: '2026-11-14T00:01:00.000Z',
  }));

const baseConfig = (overrides: Partial<HarnessConfig> = {}): HarnessConfig => ({
  mergePolicy: 'auto-merge',
  codexReviewActor: 'chatgpt-codex-connector',
  maxRounds: 5,
  now: '2026-11-14T00:05:00.000Z',
  runUrl: 'https://github.com/atomstobits/opengen/actions/runs/101',
  ...overrides,
});

const baseSnapshot = (overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot => ({
  number: 42,
  title: 'feat: engineer harness',
  url: 'https://github.com/atomstobits/opengen/pull/42',
  state: 'OPEN',
  merged: false,
  isDraft: false,
  headSha: HEAD_SHA,
  headCommittedAt: '2026-11-14T00:00:30.000Z',
  headRefName: 'codex/engineer-harness',
  headRepositoryNameWithOwner: 'atomstobits/opengen',
  baseRefName: 'main',
  baseRepositoryNameWithOwner: 'atomstobits/opengen',
  authorLogin: 'maintainer',
  authorAssociation: 'MEMBER',
  authorPermission: 'write',
  labels: [],
  reviewThreads: [],
  reviews: [],
  issueComments: [],
  ciChecks: passingChecks(),
  ...overrides,
});

const codexRequestAndCleanReceipt = (
  sha: string = HEAD_SHA,
  requestAt = '2026-11-14T00:02:00.000Z',
  receiptAt = '2026-11-14T00:03:00.000Z',
): IssueComment[] => [
  {
    id: 1000,
    authorLogin: 'maintainer',
    authorAssociation: 'MEMBER',
    authorPermission: 'write',
    body: `<!-- codex-auto-review:${sha} -->\n@codex review current head ${sha}`,
    url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1000',
    createdAt: requestAt,
    updatedAt: requestAt,
  },
  {
    id: 1001,
    authorLogin: 'chatgpt-codex-connector',
    body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``,
    url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1001',
    createdAt: receiptAt,
    updatedAt: receiptAt,
  },
];

const unresolvedThread = (id: string, body: string): ReviewThread => ({
  id,
  isResolved: false,
  comments: [
    {
      id: `COMMENT_${id}`,
      authorLogin: 'reviewer',
      body,
      url: `https://github.com/atomstobits/opengen/pull/42#discussion_${id}`,
      createdAt: '2026-11-14T00:02:30.000Z',
    },
  ],
});

describe('evaluateHarness: CI and Codex gates', () => {
  it('gates on all four required OpenGen CI check runs', () => {
    expect(REQUIRED_CI_CHECKS).toEqual([
      'Isolated C2PA integration / provenance',
      'verify',
      'secrets',
      'containers',
    ]);

    const missingOne = evaluateHarness(
      baseSnapshot({
        issueComments: codexRequestAndCleanReceipt(),
        ciChecks: passingChecks().filter((check) => check.name !== 'containers'),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(missingOne.status).toBe('awaiting-codex');
    expect(missingOne.ci.missingChecks).toEqual(['containers']);
    expect(missingOne.readyCheck.status).toBe('in_progress');
    expect(missingOne.readyCheck.summary).toContain('containers');

    const pendingOne = evaluateHarness(
      baseSnapshot({
        issueComments: codexRequestAndCleanReceipt(),
        ciChecks: passingChecks().map((check) =>
          check.name === 'verify'
            ? { ...check, status: 'in_progress', conclusion: null, completedAt: null }
            : check,
        ),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(pendingOne.status).toBe('awaiting-codex');
    expect(pendingOne.ci.pendingChecks).toEqual(['verify']);

    const failingOne = evaluateHarness(
      baseSnapshot({
        issueComments: codexRequestAndCleanReceipt(),
        ciChecks: passingChecks().map((check) =>
          check.name === 'secrets' ? { ...check, conclusion: 'failure' } : check,
        ),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(failingOne.status).toBe('needs-local-claude');
    expect(failingOne.ci.failingChecks).toEqual(['secrets']);
    expect(failingOne.readyCheck.conclusion).toBe('action_required');
  });

  it('uses the latest check run per required check name when re-run on the same head', () => {
    const evaluation = evaluateHarness(
      baseSnapshot({
        issueComments: codexRequestAndCleanReceipt(),
        ciChecks: [
          ...passingChecks().map((check) =>
            check.name === 'verify'
              ? {
                  ...check,
                  conclusion: 'failure',
                  completedAt: '2026-11-14T00:01:00.000Z',
                }
              : check,
          ),
          {
            name: 'verify',
            status: 'completed',
            conclusion: 'success',
            startedAt: '2026-11-14T00:02:00.000Z',
            completedAt: '2026-11-14T00:03:00.000Z',
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(evaluation.status).toBe('ready-merge');
    expect(evaluation.ci.state).toBe('passed');
  });

  it('reaches ready-merge for a trusted internal collaborator PR when CI and Codex are clean', () => {
    const evaluation = evaluateHarness(
      baseSnapshot({ issueComments: codexRequestAndCleanReceipt() }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(evaluation.status).toBe('ready-merge');
    expect(evaluation.desiredLabels).toEqual(['agent:ready-merge']);
    expect(evaluation.readyCheck).toEqual({
      name: ENGINEER_HARNESS_READY_CHECK,
      status: 'completed',
      conclusion: 'success',
      title: 'Engineer harness is ready',
      summary:
        'CI is green, Codex blocking findings are cleared, and merge policy requirements are satisfied.',
    });
  });

  it('waits when Codex EYES reaction indicates the review request is still in progress', () => {
    const comments = codexRequestAndCleanReceipt();
    const requestComment = comments[0];
    if (requestComment === undefined) {
      throw new Error('expected request comment fixture');
    }
    requestComment.reactionGroups = [{ content: 'EYES', userLogins: ['chatgpt-codex-connector'] }];

    const evaluation = evaluateHarness(
      baseSnapshot({ issueComments: comments }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(evaluation.status).toBe('awaiting-codex');
    expect(evaluation.codex.currentHeadReviewed).toBe(false);
  });

  it('rejects a Codex issue-comment receipt when Reviewed commit SHA is missing or does not match current head', () => {
    const missingSha = evaluateHarness(
      baseSnapshot({
        issueComments: [
          {
            id: 998,
            authorLogin: 'maintainer',
            authorPermission: 'write',
            body: `<!-- codex-auto-review:${HEAD_SHA} -->\n@codex review current head ${HEAD_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-998',
            createdAt: '2026-11-14T00:02:00.000Z',
            updatedAt: '2026-11-14T00:02:00.000Z',
          },
          {
            id: 999,
            authorLogin: 'chatgpt-codex-connector',
            body: '<!-- codex-review-receipt:v1 -->\n\nCodex Review: No issues found.',
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-999',
            createdAt: '2026-11-14T00:03:00.000Z',
            updatedAt: '2026-11-14T00:03:00.000Z',
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(missingSha.status).toBe('awaiting-codex');
    expect(missingSha.codex.currentHeadReviewed).toBe(false);

    const evaluation = evaluateHarness(
      baseSnapshot({
        issueComments: [
          {
            id: 1000,
            authorLogin: 'maintainer',
            authorPermission: 'write',
            body: `<!-- codex-auto-review:${HEAD_SHA} -->\n@codex review current head ${HEAD_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1000',
            createdAt: '2026-11-14T00:02:00.000Z',
            updatedAt: '2026-11-14T00:02:00.000Z',
          },
          {
            id: 1001,
            authorLogin: 'chatgpt-codex-connector',
            body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${OTHER_SHA.slice(0, 10)}\``,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1001',
            createdAt: '2026-11-14T00:03:00.000Z',
            updatedAt: '2026-11-14T00:03:00.000Z',
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(evaluation.status).toBe('awaiting-codex');
    expect(evaluation.codex.currentHeadReviewed).toBe(false);
  });

  it('recognizes both bare and [bot]-suffixed Codex actor logins across receipts, reviews, and reactions', () => {
    for (const [configuredActor, candidateLogin] of [
      ['chatgpt-codex-connector', 'chatgpt-codex-connector[bot]'],
      ['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector'],
    ] as const) {
      const cleanComments = codexRequestAndCleanReceipt();
      cleanComments[1] = { ...cleanComments[1]!, authorLogin: candidateLogin };

      const cleanEval = evaluateHarness(
        baseSnapshot({ issueComments: cleanComments }),
        createInitialHarnessState(),
        baseConfig({ codexReviewActor: configuredActor }),
      );
      expect(cleanEval.status).toBe('ready-merge');

      const inProgressComments = codexRequestAndCleanReceipt();
      inProgressComments[0] = {
        ...inProgressComments[0]!,
        reactionGroups: [{ content: 'EYES', userLogins: [candidateLogin] }],
      };
      inProgressComments[1] = { ...inProgressComments[1]!, authorLogin: candidateLogin };
      const eyesEval = evaluateHarness(
        baseSnapshot({ issueComments: inProgressComments }),
        createInitialHarnessState(),
        baseConfig({ codexReviewActor: configuredActor }),
      );
      expect(eyesEval.status).toBe('awaiting-codex');

      const findingEval = evaluateHarness(
        baseSnapshot({
          reviews: [
            {
              id: 'REV_BOT_FORM',
              authorLogin: candidateLogin,
              authorType: 'Bot',
              authorAssociation: 'NONE',
              body: '[P2] Validate pagination cursor.',
              state: 'COMMENTED',
              submittedAt: '2026-11-14T00:03:00.000Z',
              url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-9',
              commitOid: HEAD_SHA,
            },
          ],
        }),
        createInitialHarnessState(),
        baseConfig({ codexReviewActor: configuredActor }),
      );
      expect(findingEval.status).toBe('needs-local-claude');
      expect(findingEval.codex.topLevelFindings).toHaveLength(1);
    }
  });

  it('blocks on P0-P3 Codex findings and unresolved inline threads, and clears when a newer clean review arrives', () => {
    const blocked = evaluateHarness(
      baseSnapshot({
        reviewThreads: [unresolvedThread('THREAD_1', 'Validate tenant workspace isolation.')],
        reviews: [
          {
            id: 'REV_1',
            authorLogin: 'chatgpt-codex-connector',
            authorType: 'Bot',
            authorAssociation: 'NONE',
            body: '<!-- codex-review-receipt:v1 -->\n[P1] Missing expectedHeadOid check before enqueue.',
            state: 'COMMENTED',
            submittedAt: '2026-11-14T00:03:00.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-1',
            commitOid: HEAD_SHA,
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(blocked.status).toBe('needs-local-claude');
    expect(blocked.reviews.unresolvedThreads).toHaveLength(1);
    expect(blocked.codex.topLevelFindings).toEqual([
      {
        id: 'REV_1',
        url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-1',
        severity: 'P1',
        excerpt: '[P1] Missing expectedHeadOid check before enqueue.',
      },
    ]);
    expect(blocked.localClaudeRepairPrompt).toContain('THREAD_1');
    expect(blocked.localClaudeRepairPrompt).toContain('Top-level P1 finding REV_1');

    const supersededClean = evaluateHarness(
      baseSnapshot({
        reviews: [
          {
            id: 'REV_1',
            authorLogin: 'chatgpt-codex-connector',
            authorType: 'Bot',
            authorAssociation: 'NONE',
            body: '[P2] Check pagination bounds.',
            state: 'COMMENTED',
            submittedAt: '2026-11-14T00:03:00.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-1',
            commitOid: HEAD_SHA,
          },
        ],
        issueComments: [
          {
            id: 1002,
            authorLogin: 'maintainer',
            authorPermission: 'write',
            body: `@codex review current head ${HEAD_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1002',
            createdAt: '2026-11-14T00:04:00.000Z',
            updatedAt: '2026-11-14T00:04:00.000Z',
          },
          {
            id: 1003,
            authorLogin: 'chatgpt-codex-connector',
            body: `Codex Review: No issues found.\n\n**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-1003',
            createdAt: '2026-11-14T00:04:30.000Z',
            updatedAt: '2026-11-14T00:04:30.000Z',
          },
        ],
      }),
      blocked.state,
      baseConfig(),
    );

    expect(supersededClean.status).toBe('ready-merge');
    expect(supersededClean.codex.topLevelFindings).toEqual([]);
  });

  it('keeps ready-merge check green on a stacked PR while explaining merge waits for retarget to main', () => {
    const evaluation = evaluateHarness(
      baseSnapshot({
        baseRefName: 'codex/unified-inputs',
        issueComments: codexRequestAndCleanReceipt(),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );

    expect(evaluation.status).toBe('ready-merge');
    expect(evaluation.readyCheck.conclusion).toBe('success');
    expect(evaluation.readyCheck.title).toContain('retargeted to main');
    expect(evaluation.readyCheck.summary).toContain(
      'The base branch is codex/unified-inputs, not main',
    );
  });
});

describe('evaluateHarness: open-source public repository security boundaries', () => {
  it('forces human collaborator approval for cross-repository fork PRs even when mergePolicy is auto-merge', () => {
    const forkSnapshot = baseSnapshot({
      headRepositoryNameWithOwner: 'external-contributor/opengen',
      authorLogin: 'external-contributor',
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      issueComments: codexRequestAndCleanReceipt(),
    });

    expect(isTrustedInternalPullRequest(forkSnapshot)).toBe(false);

    const unapproved = evaluateHarness(forkSnapshot, createInitialHarnessState(), baseConfig());
    expect(unapproved.status).toBe('ready-human');
    expect(unapproved.approvals.required).toBe(true);
    expect(unapproved.approvals.hasValidHumanApproval).toBe(false);
    expect(unapproved.readyCheck.conclusion).toBe('action_required');

    // A bot approval or an approval on an older commit never unlocks ready-merge.
    const staleOrBotApproved = evaluateHarness(
      {
        ...forkSnapshot,
        reviews: [
          {
            id: 'REV_BOT',
            authorLogin: 'some-bot',
            authorType: 'Bot',
            authorAssociation: 'COLLABORATOR',
            body: 'LGTM',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:00.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-2',
            commitOid: HEAD_SHA,
          },
          {
            id: 'REV_STALE',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Approved earlier head',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:00.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-3',
            commitOid: OTHER_SHA,
          },
        ],
      },
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(staleOrBotApproved.status).toBe('ready-human');

    // A read-only organization MEMBER (`authorPermission: 'read'`) submitting APPROVED on HEAD_SHA
    // never unlocks ready-merge.
    const readOnlyMemberApproved = evaluateHarness(
      {
        ...forkSnapshot,
        reviews: [
          {
            id: 'REV_READONLY_MEMBER',
            authorLogin: 'readonly-member',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            authorPermission: 'read',
            body: 'LGTM',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:15.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-30',
            commitOid: HEAD_SHA,
          },
        ],
      },
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(readOnlyMemberApproved.status).toBe('ready-human');
    expect(readOnlyMemberApproved.approvals.validApprovers).toEqual([]);

    // Once a human collaborator approves the exact current headSha, the fork PR transitions to ready-merge.
    const collaboratorApproved = evaluateHarness(
      {
        ...forkSnapshot,
        reviews: [
          {
            id: 'REV_HUMAN',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Reviewed and approved for merge queue.',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:30.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-4',
            commitOid: HEAD_SHA,
          },
        ],
      },
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(collaboratorApproved.status).toBe('ready-merge');
    expect(collaboratorApproved.approvals.validApprovers).toEqual(['maintainer']);

    // A subsequent CHANGES_REQUESTED or DISMISSED review from the same collaborator on the same head
    // (including equal submittedAt timestamps) supersedes the earlier APPROVED review, whereas a
    // non-decision COMMENTED note leaves the approval intact.
    const supersededSameTimestamp = evaluateHarness(
      {
        ...forkSnapshot,
        reviews: [
          {
            id: 'REV_HUMAN_APPROVE',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Approved',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:30.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-4',
            commitOid: HEAD_SHA,
          },
          {
            id: 'REV_HUMAN_REJECT',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Wait, found a regression.',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-11-14T00:04:30.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-5',
            commitOid: HEAD_SHA,
          },
        ],
      },
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(supersededSameTimestamp.status).toBe('ready-human');
    expect(supersededSameTimestamp.approvals.validApprovers).toEqual([]);

    const commentedAfterApprove = evaluateHarness(
      {
        ...forkSnapshot,
        reviews: [
          {
            id: 'REV_HUMAN_APPROVE',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Approved',
            state: 'APPROVED',
            submittedAt: '2026-11-14T00:04:30.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-4',
            commitOid: HEAD_SHA,
          },
          {
            id: 'REV_HUMAN_COMMENT',
            authorLogin: 'maintainer',
            authorType: 'User',
            authorAssociation: 'MEMBER',
            body: 'Nit: follow-up in docs.',
            state: 'COMMENTED',
            submittedAt: '2026-11-14T00:04:45.000Z',
            url: 'https://github.com/atomstobits/opengen/pull/42#pullrequestreview-6',
            commitOid: HEAD_SHA,
          },
        ],
      },
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(commentedAfterApprove.status).toBe('ready-merge');
    expect(commentedAfterApprove.approvals.validApprovers).toEqual(['maintainer']);
  });

  it('forces human collaborator approval for same-repo PRs when author lacks write/admin permission', () => {
    for (const untrustedOverride of [
      { headRepositoryNameWithOwner: null },
      { authorPermission: 'read', authorAssociation: 'CONTRIBUTOR' },
      { authorPermission: 'none', authorAssociation: 'NONE' },
    ] satisfies Array<Partial<PullRequestSnapshot>>) {
      const snapshot = baseSnapshot({
        ...untrustedOverride,
        issueComments: codexRequestAndCleanReceipt(),
      });
      expect(isTrustedInternalPullRequest(snapshot)).toBe(false);
      const evaluation = evaluateHarness(snapshot, createInitialHarnessState(), baseConfig());
      expect(evaluation.status).toBe('ready-human');
      expect(evaluation.approvals.required).toBe(true);
    }
  });

  it('prevents non-collaborator @codex review comments from binding receipts or poisoning collaborator requests', () => {
    // 1. An external user's @codex review comment alone cannot bind a clean receipt.
    const externalRequestOnly = evaluateHarness(
      baseSnapshot({
        issueComments: [
          {
            id: 2000,
            authorLogin: 'stranger',
            authorAssociation: 'NONE',
            authorPermission: 'none',
            body: `@codex review current head ${HEAD_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2000',
            createdAt: '2026-11-14T00:02:00.000Z',
            updatedAt: '2026-11-14T00:02:00.000Z',
          },
          {
            id: 2001,
            authorLogin: 'chatgpt-codex-connector',
            body: `Codex Review: No issues found.\n\n**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2001',
            createdAt: '2026-11-14T00:03:00.000Z',
            updatedAt: '2026-11-14T00:03:00.000Z',
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(externalRequestOnly.status).toBe('awaiting-codex');

    // 2. An external user posting `@codex review current head <OTHER_SHA>` after a collaborator's valid
    //    request cannot DoS or invalidate Codex's receipt for the collaborator's request.
    const dosAttemptIgnored = evaluateHarness(
      baseSnapshot({
        issueComments: [
          {
            id: 2010,
            authorLogin: 'maintainer',
            authorAssociation: 'MEMBER',
            authorPermission: 'write',
            body: `<!-- codex-auto-review:${HEAD_SHA} -->\n@codex review current head ${HEAD_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2010',
            createdAt: '2026-11-14T00:02:00.000Z',
            updatedAt: '2026-11-14T00:02:00.000Z',
          },
          {
            id: 2011,
            authorLogin: 'troll-user',
            authorAssociation: 'NONE',
            authorPermission: 'none',
            body: `@codex review current head ${OTHER_SHA}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2011',
            createdAt: '2026-11-14T00:02:30.000Z',
            updatedAt: '2026-11-14T00:02:30.000Z',
          },
          {
            id: 2012,
            authorLogin: 'chatgpt-codex-connector',
            body: `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD_SHA.slice(0, 10)}\``,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-2012',
            createdAt: '2026-11-14T00:03:00.000Z',
            updatedAt: '2026-11-14T00:03:00.000Z',
          },
        ],
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(dosAttemptIgnored.status).toBe('ready-merge');
    expect(dosAttemptIgnored.codex.currentHeadReviewed).toBe(true);
  });

  it('trusts state comments exclusively from github-actions identities', () => {
    expect(isTrustedHarnessStateAuthor('github-actions[bot]')).toBe(true);
    expect(isTrustedHarnessStateAuthor('github-actions')).toBe(true);
    expect(isTrustedHarnessStateAuthor('maintainer')).toBe(false);
    expect(isTrustedHarnessStateAuthor('external-contributor')).toBe(false);
    expect(isTrustedHarnessStateAuthor(null)).toBe(false);
  });
});

describe('evaluateHarness: repair-round counting and halting', () => {
  it('deduplicates repeated evaluations on the same blocking set, halts past maxRounds, and resets on new head', () => {
    const config = baseConfig({ maxRounds: 2 });
    const snapshotRound1 = baseSnapshot({
      reviewThreads: [
        unresolvedThread('T1', 'Fix validation'),
        unresolvedThread('T2', 'Add unit test'),
      ],
    });

    const first = evaluateHarness(snapshotRound1, createInitialHarnessState(), config);
    expect(first.status).toBe('needs-local-claude');
    expect(first.startedRepairRound).toBe(true);
    expect(first.state.roundsUsed).toBe(1);

    // Re-evaluating identical blockers or a strict subset on the same head does not burn another round.
    const duplicate = evaluateHarness(snapshotRound1, first.state, config);
    expect(duplicate.startedRepairRound).toBe(false);
    expect(duplicate.state.roundsUsed).toBe(1);

    const subset = evaluateHarness(
      baseSnapshot({ reviewThreads: [unresolvedThread('T1', 'Fix validation')] }),
      first.state,
      config,
    );
    expect(subset.startedRepairRound).toBe(false);
    expect(subset.state.roundsUsed).toBe(1);

    // Introducing a new blocker on the same head starts round 2.
    const round2 = evaluateHarness(
      baseSnapshot({
        reviewThreads: [
          unresolvedThread('T1', 'Fix validation'),
          unresolvedThread('T3', 'Handle null cursor'),
        ],
      }),
      subset.state,
      config,
    );
    expect(round2.startedRepairRound).toBe(true);
    expect(round2.state.roundsUsed).toBe(2);

    // A third new blocker exceeds maxRounds=2 and halts the harness.
    const halted = evaluateHarness(
      baseSnapshot({
        reviewThreads: [unresolvedThread('T4', 'Still failing check')],
      }),
      round2.state,
      config,
    );
    expect(halted.status).toBe('halted');
    expect(halted.desiredLabels).toEqual(['agent:halted']);
    expect(halted.state.halted).toBe(true);
    expect(halted.readyCheck.conclusion).toBe('action_required');

    // Pushing a new commit resets the halted state and starts fresh at round 1.
    const resetOnNewHead = evaluateHarness(
      baseSnapshot({
        headSha: OTHER_SHA,
        reviewThreads: [unresolvedThread('T4', 'Still failing check')],
      }),
      halted.state,
      config,
    );
    expect(resetOnNewHead.status).toBe('needs-local-claude');
    expect(resetOnNewHead.state.halted).toBe(false);
    expect(resetOnNewHead.state.roundsUsed).toBe(1);
  });

  it('halts immediately when maxRounds is configured as 0', () => {
    const halted = evaluateHarness(
      baseSnapshot({ reviewThreads: [unresolvedThread('T1', 'Fix check')] }),
      createInitialHarnessState(),
      baseConfig({ maxRounds: 0 }),
    );
    expect(halted.status).toBe('halted');
    expect(halted.state.haltReason).toContain('ENGINEER_HARNESS_MAX_ROUNDS is set to 0');
  });
});

describe('evaluateHarness: merge queue rejection and /harness-requeue', () => {
  const queueRemoval = (overrides: Partial<MergeQueueRemoval> = {}): MergeQueueRemoval => ({
    enqueuedAt: '2026-11-14T00:03:30.000Z',
    removedAt: '2026-11-14T00:04:30.000Z',
    reason: 'failed_checks',
    mergeGroupSha: '9'.repeat(40),
    runUrl: 'https://github.com/atomstobits/opengen/actions/runs/999',
    failedJobs: ['containers'],
    ...overrides,
  });

  it('holds a head removed for failed_checks, persists queueHold in state comment, and honors collaborator /harness-requeue', () => {
    const rejectedSnapshot = baseSnapshot({
      issueComments: codexRequestAndCleanReceipt(),
      mergeQueueRemoval: queueRemoval(),
    });

    const held = evaluateHarness(rejectedSnapshot, createInitialHarnessState(), baseConfig());
    expect(held.status).toBe('needs-local-claude');
    expect(held.ci.queueRejection).toEqual({
      removedAt: '2026-11-14T00:04:30.000Z',
      mergeGroupSha: '9'.repeat(40),
      runUrl: 'https://github.com/atomstobits/opengen/actions/runs/999',
      failedJobs: ['containers'],
    });
    expect(held.localClaudeRepairPrompt).toContain(`${QUEUE_RETRY_COMMAND} ${HEAD_SHA}`);

    const renderedState = formatHarnessStateComment(held.state, held);
    expect(isHarnessStateComment(renderedState)).toBe(true);
    expect(renderedState).toContain('### Merge Queue Rejection');
    const parsedState = parseHarnessStateComment(renderedState);
    expect(parsedState).toEqual(held.state);

    // Non-collaborator, read-only organization MEMBER, or failed lookup (`unknown`) /harness-requeue does NOT release the hold.
    for (const [authorAssociation, authorPermission] of [
      ['NONE', 'read'],
      ['MEMBER', 'read'],
      ['MEMBER', 'unknown'],
      ['COLLABORATOR', 'none'],
    ] as const) {
      const unauthorizedRetry = evaluateHarness(
        {
          ...rejectedSnapshot,
          issueComments: [
            ...codexRequestAndCleanReceipt(),
            {
              id: 3000,
              authorLogin: 'readonly-member',
              authorAssociation,
              authorPermission,
              body: `/harness-requeue ${HEAD_SHA}`,
              url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-3000',
              createdAt: '2026-11-14T00:05:00.000Z',
              updatedAt: '2026-11-14T00:05:00.000Z',
            },
          ],
        },
        held.state,
        baseConfig(),
      );
      expect(unauthorizedRetry.status).toBe('needs-local-claude');
    }

    // Collaborator /harness-requeue after removedAt releases the hold back to ready-merge.
    const authorizedRetry = evaluateHarness(
      {
        ...rejectedSnapshot,
        issueComments: [
          ...codexRequestAndCleanReceipt(),
          {
            id: 3001,
            authorLogin: 'maintainer',
            authorAssociation: 'MEMBER',
            authorPermission: 'write',
            body: `/harness-requeue ${HEAD_SHA.slice(0, 10)}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-3001',
            createdAt: '2026-11-14T00:05:00.000Z',
            updatedAt: '2026-11-14T00:05:00.000Z',
          },
        ],
      },
      held.state,
      baseConfig(),
    );
    expect(authorizedRetry.status).toBe('ready-merge');

    // A second merge-queue rejection after that retry re-holds the head.
    const secondRejection = evaluateHarness(
      {
        ...rejectedSnapshot,
        mergeQueueRemoval: queueRemoval({
          enqueuedAt: '2026-11-14T00:05:30.000Z',
          removedAt: '2026-11-14T00:06:30.000Z',
          mergeGroupSha: '8'.repeat(40),
        }),
        issueComments: [
          ...codexRequestAndCleanReceipt(),
          {
            id: 3001,
            authorLogin: 'maintainer',
            authorAssociation: 'MEMBER',
            authorPermission: 'write',
            body: `/harness-requeue ${HEAD_SHA.slice(0, 10)}`,
            url: 'https://github.com/atomstobits/opengen/pull/42#issuecomment-3001',
            createdAt: '2026-11-14T00:05:00.000Z',
            updatedAt: '2026-11-14T00:05:00.000Z',
          },
        ],
      },
      authorizedRetry.state,
      baseConfig(),
    );
    expect(secondRejection.status).toBe('needs-local-claude');
  });

  it('does not bind an earlier head queue removal to a newly pushed normal or force-pushed head', () => {
    // 1. Force-push after enqueue before first rejection sync.
    const forcePushed = evaluateHarness(
      baseSnapshot({
        issueComments: codexRequestAndCleanReceipt(),
        mergeQueueRemoval: queueRemoval({
          enqueuedAt: '2026-11-14T00:01:00.000Z',
          removedAt: '2026-11-14T00:04:00.000Z',
        }),
        headForcePushedAt: '2026-11-14T00:02:00.000Z',
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(forcePushed.status).toBe('ready-merge');
    expect(forcePushed.ci.queueRejection).toBeNull();

    // 2. Normal push advances head A (HEAD_SHA) -> head B (OTHER_SHA) before first rejection sync,
    //    verified across timeline `enqueuedHeadSha`, persisted `lastEnqueuedHeadSha`, and commit timing.
    const timelineBound = evaluateHarness(
      baseSnapshot({
        headSha: OTHER_SHA,
        headCommittedAt: '2026-11-14T00:04:45.000Z',
        issueComments: codexRequestAndCleanReceipt(
          OTHER_SHA,
          '2026-11-14T00:05:00.000Z',
          '2026-11-14T00:05:30.000Z',
        ),
        mergeQueueRemoval: queueRemoval({
          enqueuedAt: '2026-11-14T00:01:00.000Z',
          removedAt: '2026-11-14T00:04:00.000Z',
          enqueuedHeadSha: HEAD_SHA,
          headAdvancedAfterEnqueue: true,
        }),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(timelineBound.status).toBe('ready-merge');
    expect(timelineBound.ci.queueRejection).toBeNull();
    expect(timelineBound.state.queueHold).toEqual({ key: '9'.repeat(40), headSha: HEAD_SHA });

    const commitTimingFallback = evaluateHarness(
      baseSnapshot({
        headSha: OTHER_SHA,
        headCommittedAt: '2026-11-14T00:04:45.000Z',
        issueComments: codexRequestAndCleanReceipt(
          OTHER_SHA,
          '2026-11-14T00:05:00.000Z',
          '2026-11-14T00:05:30.000Z',
        ),
        mergeQueueRemoval: queueRemoval({
          enqueuedAt: '2026-11-14T00:01:00.000Z',
          removedAt: '2026-11-14T00:04:00.000Z',
        }),
      }),
      createInitialHarnessState(),
      baseConfig(),
    );
    expect(commitTimingFallback.status).toBe('ready-merge');
    expect(commitTimingFallback.ci.queueRejection).toBeNull();
    expect(commitTimingFallback.state.queueHold).toEqual({ key: '9'.repeat(40), headSha: null });

    const persistedEnqueueBound = evaluateHarness(
      baseSnapshot({
        headSha: OTHER_SHA,
        headCommittedAt: '2026-11-14T00:00:30.000Z',
        issueComments: codexRequestAndCleanReceipt(OTHER_SHA),
        mergeQueueRemoval: queueRemoval({
          enqueuedAt: '2026-11-14T00:01:00.000Z',
          removedAt: '2026-11-14T00:04:00.000Z',
        }),
      }),
      { ...createInitialHarnessState(), lastEnqueuedHeadSha: HEAD_SHA },
      baseConfig(),
    );
    expect(persistedEnqueueBound.status).toBe('ready-merge');
    expect(persistedEnqueueBound.ci.queueRejection).toBeNull();
    expect(persistedEnqueueBound.state.queueHold).toEqual({
      key: '9'.repeat(40),
      headSha: HEAD_SHA,
    });
  });
});

describe('config, state-comment, and plan-issue helpers', () => {
  it('normalizes merge policy, max rounds, and GitHub Actions run URL', () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(5);
    expect(DEFAULT_MERGE_POLICY).toBe('auto-merge');
    expect(normalizeMergePolicy(undefined)).toBe('auto-merge');
    expect(normalizeMergePolicy('')).toBe('auto-merge');
    expect(normalizeMergePolicy('auto-merge')).toBe('auto-merge');
    expect(normalizeMergePolicy('human-approval-required')).toBe('human-approval-required');
    expect(normalizeMergePolicy('unknown-policy')).toBe('human-approval-required');

    expect(parseMaxRounds(undefined)).toBe(5);
    expect(parseMaxRounds('0')).toBe(0);
    expect(parseMaxRounds('3')).toBe(3);
    expect(parseMaxRounds('-1')).toBe(5);
    expect(parseMaxRounds('abc')).toBe(5);

    expect(buildRunUrl({})).toBeNull();
    expect(
      loadConfigFromEnv({
        ENGINEER_HARNESS_MERGE_POLICY: 'auto-merge',
        CODEX_REVIEW_ACTOR: 'chatgpt-codex-connector',
        ENGINEER_HARNESS_MAX_ROUNDS: '4',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'atomstobits/opengen',
        GITHUB_RUN_ID: '77',
      }),
    ).toMatchObject({
      mergePolicy: 'auto-merge',
      codexReviewActor: 'chatgpt-codex-connector',
      maxRounds: 4,
      runUrl: 'https://github.com/atomstobits/opengen/actions/runs/77',
    });
  });

  it('rejects malformed state comments and formats OpenGen plan issues cleanly', () => {
    expect(parseHarnessStateComment('plain comment')).toBeNull();
    expect(
      parseHarnessStateComment(
        '<!-- engineer-harness-state:start -->not-json<!-- engineer-harness-state:end -->',
      ),
    ).toBeNull();
    expect(
      parseHarnessStateComment(
        '<!-- engineer-harness-state:start -->{"version":2}<!-- engineer-harness-state:end -->',
      ),
    ).toBeNull();

    expect(PLAN_ISSUE_LABEL).toBe('agent:ready-for-local-claude');
    expect(LOCAL_CLAUDE_HANDOFF_PROMPT).toContain('AGENTS.md');
    expect(LOCAL_CLAUDE_HANDOFF_PROMPT).toContain('docs/PLAN.md');
    expect(LOCAL_CLAUDE_HANDOFF_PROMPT).toContain('docs/STATUS.md');
    expect(formatCodexReviewPrompt(HEAD_SHA)).toContain(`@codex review current head ${HEAD_SHA}`);

    const body = formatPlanIssueBody({
      title: 'Add harness',
      featureRequest: 'Port engineer harness.',
      codexPlan: '1. Add scripts/engineer-harness.',
      acceptanceCriteria: 'All tests green.',
      riskAreas: 'Public PR security.',
      validationCommands: 'npm run typecheck && npm test',
    });
    expect(body).toContain('## Feature Request');
    expect(body).toContain('## Local Claude Handoff');
    expect(body).toContain('## Codex Review Prompt');
  });
});
