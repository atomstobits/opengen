import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  hasCodexReviewRequest,
  hasQueueRetryCommand,
  QUEUE_RETRY_COMMAND,
  REQUIRED_CI_CHECKS,
} from '../scripts/engineer-harness/src/controller.js';

const repoRoot = resolve(import.meta.dirname, '..');
const harnessWorkflow = readFileSync(
  resolve(repoRoot, '.github/workflows/engineer-harness.yml'),
  'utf8',
);
const autoReviewWorkflow = readFileSync(
  resolve(repoRoot, '.github/workflows/codex-auto-review.yml'),
  'utf8',
);
const checkWorkflow = readFileSync(resolve(repoRoot, '.github/workflows/check.yml'), 'utf8');
const provenanceWorkflow = readFileSync(
  resolve(repoRoot, '.github/workflows/provenance.yml'),
  'utf8',
);
const controllerSource = readFileSync(
  resolve(repoRoot, 'scripts/engineer-harness/src/controller.ts'),
  'utf8',
);

const syncSection = harnessWorkflow.slice(harnessWorkflow.indexOf('\n  sync:\n'));
const jobCondition = (
  syncSection.match(/^ {4}if: >-\n {6}\$\{\{\n([\s\S]*?)\n {6}\}\}\n/m)?.[1] ?? ''
)
  .replace(/\s+/g, ' ')
  .trim();

const actorClause = (field: string): string =>
  `${field} == (vars.CODEX_REVIEW_ACTOR || 'chatgpt-codex-connector') || ${field} == format('{0}[bot]', vars.CODEX_REVIEW_ACTOR || 'chatgpt-codex-connector')`;

describe('engineer-harness.yml workflow contract and security invariants', () => {
  it('triggers on Checks workflow_run and dequeued PRs while filtering noisy events on the sync job', () => {
    const onBlock = harnessWorkflow.slice(
      harnessWorkflow.indexOf('\non:\n'),
      harnessWorkflow.indexOf('\npermissions:\n'),
    );
    expect([...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1])).toEqual([
      'workflow_dispatch',
      'pull_request_target',
      'pull_request_review',
      'pull_request_review_comment',
      'issue_comment',
      'workflow_run',
    ]);
    expect(onBlock).toMatch(
      /pull_request_target:\n {4}types: \[opened, synchronize, reopened, ready_for_review, dequeued\]\n/,
    );
    expect(onBlock).toMatch(
      /workflow_run:\n {4}workflows: \['Checks'\]\n {4}types: \[completed\]\n/,
    );

    const expectedClauses = [
      "( github.event_name != 'workflow_run' || (github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.pull_requests[0].number != null) )",
      `( github.event_name != 'issue_comment' || ( github.event.issue.pull_request != null && ( ${actorClause('github.event.comment.user.login')} || contains(github.event.comment.body, '@codex') || contains(github.event.comment.body, 'codex-auto-review') || contains(github.event.comment.body, '/harness-requeue') ) ) )`,
      `( github.event_name != 'pull_request_review' || ${actorClause('github.event.review.user.login')} || github.event.review.state == 'approved' || github.event.review.state == 'changes_requested' )`,
      `( github.event_name != 'pull_request_review_comment' || ( github.event.comment.user.login != (vars.CODEX_REVIEW_ACTOR || 'chatgpt-codex-connector') && github.event.comment.user.login != format('{0}[bot]', vars.CODEX_REVIEW_ACTOR || 'chatgpt-codex-connector') ) )`,
    ];
    expect(jobCondition).toBe(expectedClauses.join(' && '));
    expect(jobCondition).not.toContain('pull_request_target');
    expect(jobCondition).not.toContain('workflow_dispatch');
    expect(jobCondition).not.toContain('dequeued');
  });

  it('keeps workflow event filters coupled to controller.ts request and requeue syntax', () => {
    expect(controllerSource).toContain('<!--\\s*codex-auto-review:([a-f0-9]{7,40})\\s*-->');
    expect(controllerSource).toContain(
      '/@codex\\s+review[\\s\\S]*?\\bcurrent head\\s+([a-f0-9]{7,40})\\b/i',
    );

    const sha = '533c00a904b717af6f4c721354c51f425493b174';
    for (const body of [
      `<!-- codex-auto-review:${sha} -->\n@codex review current head ${sha}`,
      `@codex review — current head ${sha}`,
      `@Codex   Review\nplease, current head ${sha.slice(0, 7)}`,
      `<!--CODEX-AUTO-REVIEW:${sha}-->`,
    ]) {
      expect(hasCodexReviewRequest(body)).toBe(true);
      expect(
        body.toLowerCase().includes('@codex') || body.toLowerCase().includes('codex-auto-review'),
      ).toBe(true);
    }

    expect(QUEUE_RETRY_COMMAND).toBe('/harness-requeue');
    expect(jobCondition).toContain(`contains(github.event.comment.body, '${QUEUE_RETRY_COMMAND}')`);
    for (const retryBody of [
      `/harness-requeue ${sha}`,
      `flake in containers\n  /Harness-Requeue ${sha.slice(0, 7)}\n`,
    ]) {
      expect(hasQueueRetryCommand(retryBody)).toBe(true);
      expect(retryBody.toLowerCase().includes(QUEUE_RETRY_COMMAND)).toBe(true);
    }
  });

  it('uses job-level concurrency, checks out only default-branch code with persist-credentials: false, and SHA-pins all external actions', () => {
    expect(harnessWorkflow).not.toMatch(/^concurrency:/m);
    expect(syncSection).toMatch(
      /^ {4}concurrency:\n {6}group: engineer-harness-\$\{\{ inputs\.pr_number \|\| github\.event\.pull_request\.number \|\| github\.event\.issue\.number \|\| github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| github\.run_id \}\}\n {6}cancel-in-progress: false\n/m,
    );

    const checkouts = [
      ...harnessWorkflow.matchAll(/^ {6}- uses: actions\/checkout@[^\n]+\n((?: {8}[^\n]*\n)*)/gm),
    ].map((m) => m[1]);
    expect(checkouts).toEqual([
      '        with:\n          ref: ${{ github.event.repository.default_branch }}\n          persist-credentials: false\n',
    ]);
    expect(harnessWorkflow).not.toMatch(/pull_request\.head|head_ref|head_sha|head_branch/);

    // codex-auto-review.yml must NEVER check out repository or PR code.
    expect(autoReviewWorkflow).not.toMatch(/uses:\s*actions\/checkout/);

    // Every external `uses:` across harness + CI workflows must be pinned to a 40-char commit SHA.
    for (const wf of [harnessWorkflow, autoReviewWorkflow, checkWorkflow]) {
      const externalUses = [...wf.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)]
        .map((m) => m[1]!)
        .filter((target) => !target.startsWith('./'));
      expect(externalUses.length).toBeGreaterThan(0);
      for (const target of externalUses) {
        expect(target).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
    }
  });
});

describe('check.yml merge_group and required CI checks alignment', () => {
  it('runs Checks on push to main, pull_request, and merge_group, and emits all 4 REQUIRED_CI_CHECKS', () => {
    expect(checkWorkflow).toMatch(
      /on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n {2}merge_group:\n {4}types: \[checks_requested\]\n/,
    );
    expect(provenanceWorkflow).toMatch(/on:\n {2}workflow_call:\n/);
    expect(provenanceWorkflow).toMatch(/\n {2}provenance:\n/);
    expect(checkWorkflow).toMatch(/\n {2}provenance:\n {4}name: Isolated C2PA integration\n/);
    expect(checkWorkflow).toMatch(/\n {2}verify:\n/);
    expect(checkWorkflow).toMatch(/\n {2}secrets:\n/);
    expect(checkWorkflow).toMatch(/\n {2}containers:\n/);
    expect(REQUIRED_CI_CHECKS).toEqual([
      'Isolated C2PA integration / provenance',
      'verify',
      'secrets',
      'containers',
    ]);
  });
});

describe('codex-auto-review.yml request script behavior and OSS fork/permission guards', () => {
  const extractFirstScript = (): ((
    github: unknown,
    context: unknown,
    core: unknown,
  ) => Promise<void>) => {
    const lines = autoReviewWorkflow.split('\n');
    const start = lines.findIndex((line) => line.trim() === 'script: |');
    expect(start).toBeGreaterThan(0);
    const firstBodyLine = lines[start + 1] ?? '';
    const indent = firstBodyLine.match(/^ */)?.[0].length ?? 0;
    const bodyLines: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() !== '' && (line.match(/^ */)?.[0].length ?? 0) < indent) {
        break;
      }
      bodyLines.push(line.slice(indent));
    }
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
      ...args: string[]
    ) => (github: unknown, context: unknown, core: unknown) => Promise<void>;
    return new AsyncFunction('github', 'context', 'core', bodyLines.join('\n'));
  };

  const HEAD = '35892a7283c0ffee35892a7283c0ffee35892a72';
  const OTHER = 'b031ff295f00000000000000000000000000000a';

  const cleanReceipt = (sha: string): string =>
    `<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``;
  const findingsReceipt = (sha: string): string =>
    `<!-- codex-review-receipt:v1 -->\n\n### Codex Review\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\``;

  let clock = 0;
  const commentBy = (
    login: string,
    body: string,
    authorAssociation?: string,
  ): Record<string, unknown> => ({
    user: { login },
    body,
    ...(authorAssociation === undefined ? {} : { author_association: authorAssociation }),
    created_at: new Date(Date.UTC(2026, 10, 14, 1, clock++)).toISOString(),
  });

  const runRequestScript = async (options: {
    headFullName?: string | null;
    prAuthor?: string;
    authorPermission?: string | Error;
    comments?: Array<Record<string, unknown>>;
    reviews?: Array<Record<string, unknown>> | null;
  }) => {
    const posted: string[] = [];
    let permissionLookups = 0;
    const listCommentsToken = Symbol('listComments');
    const listReviewsToken = Symbol('listReviews');

    const github = {
      rest: {
        repos: {
          getCollaboratorPermissionLevel: async () => {
            permissionLookups += 1;
            if (options.authorPermission instanceof Error) {
              throw options.authorPermission;
            }
            return { data: { permission: options.authorPermission ?? 'write' } };
          },
        },
        users: {
          getAuthenticated: async () => ({ data: { login: 'lxa2b' } }),
        },
        issues: {
          listComments: listCommentsToken,
          createComment: async (args: { body: string }) => {
            posted.push(args.body);
          },
        },
        pulls: {
          listReviews: listReviewsToken,
        },
      },
      paginate: async (endpoint: unknown) => {
        if (endpoint === listCommentsToken) {
          return options.comments ?? [];
        }
        if (endpoint === listReviewsToken) {
          if (options.reviews === null) {
            throw new Error('Resource not accessible by personal access token');
          }
          return options.reviews ?? [];
        }
        throw new Error('Unexpected paginate endpoint');
      },
    };

    const context = {
      payload: {
        pull_request: {
          number: 7,
          user: { login: options.prAuthor ?? 'lxa2b' },
          head: {
            sha: HEAD,
            repo:
              options.headFullName === null
                ? null
                : { full_name: options.headFullName ?? 'atomstobits/opengen' },
          },
        },
      },
      repo: { owner: 'atomstobits', repo: 'opengen' },
    };

    await extractFirstScript()(github, context, {
      info: () => undefined,
      warning: () => undefined,
    });
    return { posted, permissionLookups };
  };

  it('skips cross-repository fork PRs and non-write authors without spending Codex review quota', async () => {
    const forkResult = await runRequestScript({ headFullName: 'external-fork/opengen' });
    expect(forkResult.posted).toEqual([]);
    expect(forkResult.permissionLookups).toBe(0);

    const deletedForkResult = await runRequestScript({ headFullName: null });
    expect(deletedForkResult.posted).toEqual([]);
    expect(deletedForkResult.permissionLookups).toBe(0);

    for (const perm of ['read', 'none', new Error('404 Not Found')]) {
      const nonWriteResult = await runRequestScript({
        prAuthor: 'external-user',
        authorPermission: perm,
      });
      expect(nonWriteResult.posted).toEqual([]);
      expect(nonWriteResult.permissionLookups).toBe(1);
    }
  });

  it('posts one head-bound @codex review request for write/admin collaborator PRs and deduplicates existing markers or receipts', async () => {
    const fresh = await runRequestScript({ authorPermission: 'write' });
    expect(fresh.posted).toHaveLength(1);
    expect(fresh.posted[0]).toMatch(
      new RegExp(`^<!-- codex-auto-review:${HEAD} -->\\n@codex review current head ${HEAD} `),
    );

    // Already requested by the authenticated marker author -> no duplicate comment.
    const alreadyRequested = await runRequestScript({
      comments: [
        commentBy(
          'lxa2b',
          `<!-- codex-auto-review:${HEAD} -->\n@codex review current head ${HEAD}`,
        ),
      ],
    });
    expect(alreadyRequested.posted).toEqual([]);

    // Already reviewed via clean receipt or formal review on HEAD -> no duplicate comment.
    for (const botLogin of ['chatgpt-codex-connector[bot]', 'chatgpt-codex-connector']) {
      const withCleanReceipt = await runRequestScript({
        comments: [
          commentBy('lxa2b', `@codex review current head ${HEAD}`, 'MEMBER'),
          commentBy(botLogin, cleanReceipt(HEAD), 'NONE'),
        ],
      });
      expect(withCleanReceipt.posted).toEqual([]);

      const withFormalReview = await runRequestScript({
        reviews: [{ ...commentBy(botLogin, findingsReceipt(HEAD)), commit_id: HEAD }],
      });
      expect(withFormalReview.posted).toEqual([]);
    }

    // External user (`author_association: 'NONE'`) trying to spoof an intervening request on OTHER
    // does not hide a valid collaborator request + Codex receipt on HEAD.
    const trollIntervening = await runRequestScript({
      comments: [
        commentBy('lxa2b', `@codex review current head ${HEAD}`, 'MEMBER'),
        commentBy('troll-user', `@codex review current head ${OTHER}`, 'NONE'),
        commentBy('chatgpt-codex-connector[bot]', cleanReceipt(HEAD), 'NONE'),
      ],
    });
    expect(trollIntervening.posted).toEqual([]);
  });
});
