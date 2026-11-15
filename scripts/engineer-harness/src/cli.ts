import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadConfigFromEnv } from './config.js';
import { createInitialHarnessState, evaluateHarness } from './controller.js';
import { GitHubClient } from './github-client.js';
import { landPullRequest } from './merge.js';
import { formatPlanIssueBody, PLAN_ISSUE_LABEL, type PlanIssueInput } from './plan-issue.js';
import { formatHarnessStateComment } from './state-comment.js';

const execFileAsync = promisify(execFile);

const parseRepository = (repository: string | undefined): { owner: string; repo: string } => {
  if (repository === undefined) {
    throw new Error('GITHUB_REPOSITORY is required.');
  }

  const [owner, repo] = repository.split('/');
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`Invalid GITHUB_REPOSITORY value: ${repository}`);
  }

  return { owner, repo };
};

const parseRepositoryFromRemote = (remoteUrl: string): { owner: string; repo: string } | null => {
  const httpsMatch = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch !== null) {
    const [, owner, repo] = httpsMatch;
    if (owner !== undefined && repo !== undefined) {
      return { owner, repo };
    }
  }

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch !== null) {
    const [, owner, repo] = sshMatch;
    if (owner !== undefined && repo !== undefined) {
      return { owner, repo };
    }
  }

  return null;
};

const resolveRepository = async (): Promise<{ owner: string; repo: string }> => {
  const environmentRepository = process.env['GITHUB_REPOSITORY'] ?? process.env['GH_REPO'];
  if (environmentRepository !== undefined) {
    return parseRepository(environmentRepository);
  }

  try {
    const commandResult = await execFileAsync('git', ['remote', 'get-url', 'origin']);
    const parsedRepository = parseRepositoryFromRemote(commandResult.stdout.trim());
    if (parsedRepository !== null) {
      return parsedRepository;
    }
  } catch {
    // Fall through to the explicit error below.
  }

  throw new Error('GITHUB_REPOSITORY or GH_REPO is required, or origin must point at GitHub.');
};

const parsePrNumber = (value: string | undefined): number => {
  if (value === undefined) {
    throw new Error('PR_NUMBER is required.');
  }

  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`Invalid PR_NUMBER value: ${value}`);
  }

  return parsedValue;
};

const createRepositoryClientFromEnv = async (): Promise<GitHubClient> => {
  const token = process.env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new Error('GITHUB_TOKEN or GH_TOKEN is required.');
  }

  const repository = await resolveRepository();
  return new GitHubClient({
    owner: repository.owner,
    repo: repository.repo,
    token,
  });
};

const createQueueClientFromEnv = async (): Promise<GitHubClient | null> => {
  const token = process.env['ENGINEER_HARNESS_QUEUE_TOKEN'];
  if (token === undefined || token.trim() === '') {
    return null;
  }
  const repository = await resolveRepository();
  return new GitHubClient({ owner: repository.owner, repo: repository.repo, token });
};

const createPullRequestClientFromEnv = async (): Promise<{
  client: GitHubClient;
  prNumber: number;
}> => ({
  client: await createRepositoryClientFromEnv(),
  prNumber: parsePrNumber(process.env['PR_NUMBER']),
});

const parseFlagValues = (args: string[]): Map<string, string> => {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const currentArg = args[index];
    if (currentArg === undefined) {
      throw new Error(`Missing argument at position ${index}.`);
    }

    if (!currentArg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${currentArg}`);
    }

    const nextArg = args[index + 1];
    if (nextArg === undefined || nextArg.startsWith('--')) {
      throw new Error(`Missing value for ${currentArg}.`);
    }

    values.set(currentArg.slice(2), nextArg);
    index += 1;
  }

  return values;
};

const readFlagText = async (
  flags: Map<string, string>,
  name: string,
  fallback = '',
): Promise<string> => {
  const directValue = flags.get(name);
  if (directValue !== undefined) {
    return directValue;
  }

  const fileValue = flags.get(`${name}-file`);
  if (fileValue !== undefined) {
    return readFile(fileValue, 'utf8');
  }

  return fallback;
};

const readRequiredFlagText = async (flags: Map<string, string>, name: string): Promise<string> => {
  const value = await readFlagText(flags, name);
  if (value.trim() === '') {
    throw new Error(`--${name} or --${name}-file is required.`);
  }

  return value;
};

const readPlanIssueInput = async (args: string[]): Promise<PlanIssueInput> => {
  const flags = parseFlagValues(args);
  const title = flags.get('title');
  if (title === undefined || title.trim() === '') {
    throw new Error('--title is required.');
  }

  return {
    title,
    featureRequest: await readRequiredFlagText(flags, 'request'),
    codexPlan: await readRequiredFlagText(flags, 'plan'),
    acceptanceCriteria: await readFlagText(flags, 'acceptance', 'Not specified.'),
    riskAreas: await readFlagText(flags, 'risks', 'Not specified.'),
    validationCommands: await readFlagText(flags, 'validation', 'Not specified.'),
  };
};

export const runSync = async (): Promise<void> => {
  const config = loadConfigFromEnv(process.env);
  const { client, prNumber } = await createPullRequestClientFromEnv();

  const snapshot = await client.getPullRequestSnapshot(prNumber);
  if (snapshot.merged || snapshot.state !== 'OPEN') {
    process.stdout.write('Pull request is not open.\n');
    return;
  }

  const existingStateComment = await client.findHarnessStateComment(prNumber);
  const previousState = existingStateComment?.state ?? createInitialHarnessState();
  const evaluation = evaluateHarness(snapshot, previousState, config);
  const nextStateComment = formatHarnessStateComment(evaluation.state, evaluation);

  await client.ensureHarnessLabels();
  await client.syncIssueLabels(snapshot.number, snapshot.labels, evaluation.desiredLabels);
  await client.upsertHarnessStateComment(
    snapshot.number,
    existingStateComment?.id ?? null,
    nextStateComment,
  );

  await client.createCheckRun(snapshot.headSha, evaluation.readyCheck, config.runUrl);

  process.stdout.write(`${evaluation.status}\n`);
};

export const runMerge = async (): Promise<void> => {
  const config = loadConfigFromEnv(process.env);
  const { client, prNumber } = await createPullRequestClientFromEnv();
  const snapshot = await client.getPullRequestSnapshot(prNumber);

  if (snapshot.merged || snapshot.state !== 'OPEN') {
    process.stdout.write('Pull request is already closed.\n');
    return;
  }

  const existingStateComment = await client.findHarnessStateComment(prNumber);
  const previousState = existingStateComment?.state ?? createInitialHarnessState();
  const evaluation = evaluateHarness(snapshot, previousState, config);

  if (evaluation.status !== 'ready-merge') {
    process.stdout.write(`Pull request is not ready to merge: ${evaluation.status}\n`);
    return;
  }

  const landed = await landPullRequest(client, snapshot, await createQueueClientFromEnv());

  if (landed.kind === 'refused-base') {
    process.stdout.write(
      `::notice title=Engineer harness merge waits for retarget to main::${landed.notice}\n`,
    );
    process.stdout.write(`Not merging: ${landed.notice}\n`);
    return;
  }

  if (evaluation.state.lastEnqueuedHeadSha !== snapshot.headSha) {
    const enqueuedState = {
      ...evaluation.state,
      lastEnqueuedHeadSha: snapshot.headSha,
    };
    await client.upsertHarnessStateComment(
      snapshot.number,
      existingStateComment?.id ?? null,
      formatHarnessStateComment(enqueuedState, evaluation),
    );
  }

  if (landed.kind === 'already-queued') {
    process.stdout.write(`Pull request is already in the ${snapshot.baseRefName} merge queue.\n`);
    return;
  }

  process.stdout.write(
    `Added pull request to the ${snapshot.baseRefName} merge queue at position ${landed.position}.\n`,
  );
};

export const runCreatePlanIssue = async (args: string[]): Promise<void> => {
  const input = await readPlanIssueInput(args);
  const client = await createRepositoryClientFromEnv();
  await client.ensureHarnessLabels();

  const issue = await client.createIssue({
    title: input.title,
    body: formatPlanIssueBody(input),
    labels: [PLAN_ISSUE_LABEL],
  });

  process.stdout.write(`Created plan issue #${issue.number}: ${issue.url}\n`);
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  const command = argv[0];
  if (command === 'sync') {
    await runSync();
    return;
  }

  if (command === 'merge') {
    await runMerge();
    return;
  }

  if (command === 'create-plan-issue') {
    await runCreatePlanIssue(argv.slice(1));
    return;
  }

  throw new Error(
    'Usage: node --import tsx scripts/engineer-harness/src/cli.ts <sync|merge|create-plan-issue>',
  );
};

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
