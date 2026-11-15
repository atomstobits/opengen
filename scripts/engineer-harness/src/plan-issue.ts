export const PLAN_ISSUE_LABEL = 'agent:ready-for-local-claude';

export interface PlanIssueInput {
  title: string;
  featureRequest: string;
  codexPlan: string;
  acceptanceCriteria: string;
  riskAreas: string;
  validationCommands: string;
}

export const LOCAL_CLAUDE_HANDOFF_PROMPT = [
  'Refine the Codex plan in this issue into an execution checklist, implement it on a new branch, run validation, push the branch, and create a PR linked to this issue.',
  '',
  'Before editing, write the execution checklist with the files/modules you expect to touch, the test updates you expect to make, and the validation commands you will run.',
  '',
  'During implementation, follow AGENTS.md, docs/PLAN.md, and docs/STATUS.md. Do not introduce unrelated refactors, dependency churn, or opportunistic cleanup.',
].join('\n');

export const formatCodexReviewPrompt = (headSha: string): string =>
  [
    `@codex review current head ${headSha} with extra focus on linked issue completeness, unnecessary complexity, clean architecture, runtime safety, AI maintainability, tests, and type-safety regressions.`,
    'If this PR links issue(s), read the original issue(s) and verify the implementation addresses the stated request, acceptance criteria, and risk areas; treat clear gaps as blocking findings.',
  ].join(' ');

const formatSection = (title: string, body: string): string =>
  [`## ${title}`, '', body.trim().length > 0 ? body.trim() : 'Not specified.'].join('\n');

export const formatPlanIssueBody = (input: PlanIssueInput): string =>
  [
    formatSection('Feature Request', input.featureRequest),
    formatSection('Codex Plan', input.codexPlan),
    formatSection('Acceptance Criteria', input.acceptanceCriteria),
    formatSection('Risk Areas', input.riskAreas),
    formatSection('Validation Commands', input.validationCommands),
    formatSection('Local Claude Handoff', LOCAL_CLAUDE_HANDOFF_PROMPT),
    formatSection('Codex Review Prompt', formatCodexReviewPrompt('<PR_HEAD_SHA>')),
  ].join('\n\n');
