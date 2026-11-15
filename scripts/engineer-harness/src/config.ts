import type { HarnessConfig, MergePolicy } from './types.js';

export const DEFAULT_MAX_ROUNDS = 5;
export const DEFAULT_MERGE_POLICY: MergePolicy = 'auto-merge';

export const normalizeMergePolicy = (value: string | undefined): MergePolicy => {
  const normalizedValue = value?.trim();
  if (normalizedValue === undefined || normalizedValue === '' || normalizedValue === 'auto-merge') {
    return DEFAULT_MERGE_POLICY;
  }

  if (normalizedValue === 'human-approval-required') {
    return normalizedValue;
  }

  return 'human-approval-required';
};

export const parseMaxRounds = (value: string | undefined): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_MAX_ROUNDS;
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return DEFAULT_MAX_ROUNDS;
  }

  return parsedValue;
};

export const buildRunUrl = (environment: NodeJS.ProcessEnv): string | null => {
  const serverUrl = environment['GITHUB_SERVER_URL'];
  const repository = environment['GITHUB_REPOSITORY'];
  const runId = environment['GITHUB_RUN_ID'];

  if (serverUrl === undefined || repository === undefined || runId === undefined) {
    return null;
  }

  return `${serverUrl}/${repository}/actions/runs/${runId}`;
};

export const loadConfigFromEnv = (environment: NodeJS.ProcessEnv): HarnessConfig => ({
  mergePolicy: normalizeMergePolicy(environment['ENGINEER_HARNESS_MERGE_POLICY']),
  codexReviewActor: environment['CODEX_REVIEW_ACTOR']?.trim() || null,
  maxRounds: parseMaxRounds(environment['ENGINEER_HARNESS_MAX_ROUNDS']),
  now: new Date().toISOString(),
  runUrl: buildRunUrl(environment),
});
