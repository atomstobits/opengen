#!/usr/bin/env node
// Bounded local operator CLI for AgedCostReliefStore (docs/billing/aged-cost-relief.md).
// Reads case/request JSON strictly from a private 0600 file; never accepts secrets or PII in argv.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { Pool } = pg;

const MAX_PACKET_BYTES = 262_144;
const ALLOWED_ACTIONS = new Set(['review', 'grant', 'getReceipt']);

class AgedCostReliefCliError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.name = 'AgedCostReliefCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, exitCode = 1) {
  throw new AgedCostReliefCliError(code, exitCode);
}

async function loadAgedCostReliefModules() {
  try {
    const [relief, engine] = await Promise.all([
      import('../packages/engine/src/aged-cost-relief.ts'),
      import('../packages/engine/src/index.ts'),
    ]);
    return {
      AgedCostReliefStore: relief.AgedCostReliefStore,
      AgedCostReliefError: relief.AgedCostReliefError,
      creditWorkspaceInTransaction: engine.creditWorkspaceInTransaction,
    };
  } catch {
    const { tsImport } = await import('tsx/esm/api');
    const [relief, engine] = await Promise.all([
      tsImport('../packages/engine/src/aged-cost-relief.ts', import.meta.url),
      tsImport('../packages/engine/src/index.ts', import.meta.url),
    ]);
    return {
      AgedCostReliefStore: relief.AgedCostReliefStore,
      AgedCostReliefError: relief.AgedCostReliefError,
      creditWorkspaceInTransaction: engine.creditWorkspaceInTransaction,
    };
  }
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function boundedId(value, maxLen = 200) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maxLen ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('invalid_aged_cost_relief_packet', 2);
  }
  return value;
}

export async function readPrivateReliefPacket(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('input_path_not_absolute', 2);
  const parentReal = await realpath(dirname(path)).catch(() => null);
  if (parentReal !== dirname(path)) fail('input_parent_symlink_rejected', 2);
  const linkFacts = await lstat(path).catch(() => null);
  if (!linkFacts || !linkFacts.isFile() || linkFacts.isSymbolicLink()) {
    fail('input_file_not_regular', 2);
  }
  if ((linkFacts.mode & 0o077) !== 0) fail('input_file_permissions_too_open', 2);
  if (linkFacts.size < 2 || linkFacts.size > MAX_PACKET_BYTES) fail('input_file_size_invalid', 2);

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const facts = await handle.stat();
    if (!facts.isFile() || (facts.mode & 0o077) !== 0 || facts.size > MAX_PACKET_BYTES) {
      fail('input_file_invalid', 2);
    }
    let parsed;
    try {
      parsed = JSON.parse(await handle.readFile('utf8'));
    } catch {
      fail('input_json_malformed', 2);
    }
    if (!isPlainObject(parsed)) fail('invalid_aged_cost_relief_packet', 2);
    return parsed;
  } finally {
    await handle.close();
  }
}

async function writePrivateOutput(path, payload) {
  if (!isAbsolute(path)) fail('output_path_not_absolute', 2);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== dirname(path)) fail('output_parent_symlink_rejected', 2);
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

export async function executeAgedCostReliefCommand({
  action,
  confirm = false,
  inputPath,
  packet: suppliedPacket,
  outputPath,
  pool: injectedPool,
  databaseUrl,
  env = process.env,
}) {
  if (!ALLOWED_ACTIONS.has(action)) fail('invalid_cli_action', 2);
  if (action === 'grant' && confirm !== true) {
    fail('human_confirmation_flag_required', 2);
  }
  if (action !== 'grant' && confirm === true) {
    fail('read_only_action_rejects_confirm', 2);
  }

  const packet = suppliedPacket ?? (await readPrivateReliefPacket(inputPath));
  const actorId = boundedId(packet.actorId);
  const policyVersion = boundedId(packet.policyVersion, 120);

  let approvalMeta = null;
  if (action === 'grant') {
    if (!isPlainObject(packet.approval)) fail('independent_approval_required', 2);
    const reviewerId = boundedId(packet.approval.reviewerId);
    const approvalReference = boundedId(packet.approval.approvalReference);
    if (reviewerId === actorId) fail('independent_reviewer_must_differ_from_actor', 2);
    approvalMeta = {
      reviewerId,
      approvalReference,
      expectedRequestHash:
        typeof packet.approval.expectedRequestHash === 'string'
          ? packet.approval.expectedRequestHash
          : undefined,
    };
  }

  const connectionString = databaseUrl ?? env.DATABASE_URL;
  if (!injectedPool && !connectionString) fail('database_url_required', 2);

  const { AgedCostReliefStore, AgedCostReliefError, creditWorkspaceInTransaction } =
    await loadAgedCostReliefModules();

  const ownedPool = injectedPool ? null : new Pool({ connectionString, max: 2 });
  const activePool = injectedPool ?? ownedPool;
  const invocationContext = Object.freeze({ token: Symbol('aged-cost-relief-cli'), actorId });

  try {
    const store = new AgedCostReliefStore(activePool, {
      activation: 'staff-approved',
      policyVersion,
      creditInTransaction: creditWorkspaceInTransaction,
      authorize: async (_client, supplied) => {
        if (supplied !== invocationContext) fail('aged_cost_relief_authority_required');
        return { kind: 'installation-operator', id: actorId };
      },
      ...(action === 'grant'
        ? {
            approveRelief: async (_client, supplied, request) => {
              if (supplied !== invocationContext || !approvalMeta) {
                fail('aged_cost_relief_approval_required');
              }
              if (
                approvalMeta.expectedRequestHash !== undefined &&
                approvalMeta.expectedRequestHash !== request.requestHash
              ) {
                fail('approval_request_hash_mismatch');
              }
              return {
                approvalReference: approvalMeta.approvalReference,
                requestHash: request.requestHash,
              };
            },
          }
        : {}),
    });

    let output;
    if (action === 'review') {
      const reviewed = await store.review(
        {
          workspaceId: packet.workspaceId,
          jobId: packet.jobId,
          allocation: packet.allocation,
        },
        invocationContext,
      );
      output = {
        action: 'review',
        amountMicros: reviewed.amountMicros,
        snapshotHash: reviewed.snapshotHash,
        allocation: reviewed.allocation,
      };
    } else if (action === 'grant') {
      const granted = await store.grant(
        {
          workspaceId: packet.workspaceId,
          jobId: packet.jobId,
          allocation: packet.allocation,
          reference: packet.reference,
          note: packet.note,
          evidenceUrl: packet.evidenceUrl,
          snapshotHash: packet.snapshotHash,
        },
        invocationContext,
      );
      output = {
        action: 'grant',
        receipt: {
          ...granted,
          createdAt:
            granted.createdAt instanceof Date ? granted.createdAt.toISOString() : granted.createdAt,
        },
      };
    } else if (action === 'getReceipt') {
      const found = await store.getReceipt(
        {
          workspaceId: packet.workspaceId,
          jobId: packet.jobId,
        },
        invocationContext,
      );
      output = {
        action: 'getReceipt',
        grant: {
          ...found.grant,
          createdAt:
            found.grant.createdAt instanceof Date
              ? found.grant.createdAt.toISOString()
              : found.grant.createdAt,
        },
        settlement: found.settlement,
      };
    }

    if (outputPath) await writePrivateOutput(outputPath, output);
    return output;
  } catch (error) {
    if (error instanceof AgedCostReliefCliError) throw error;
    if (error instanceof AgedCostReliefError || typeof error?.code === 'string') {
      fail(String(error.code));
    }
    fail('aged_cost_relief_operation_failed');
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

export async function runAgedCostReliefCli(args = process.argv.slice(2), deps = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        action: { type: 'string' },
        input: { type: 'string' },
        output: { type: 'string' },
        confirm: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    fail('invalid_cli_arguments', 2);
  }
  const { values } = parsed;
  if (values.help) {
    return {
      usage:
        'node scripts/aged-cost-relief.mjs --action <review|grant|getReceipt> --input /absolute/private/0600-packet.json [--confirm] [--output /absolute/private/0600-receipt.json]',
    };
  }
  if (!values.action || !values.input) fail('invalid_cli_arguments', 2);
  return executeAgedCostReliefCommand({
    action: values.action,
    confirm: values.confirm === true,
    inputPath: values.input,
    outputPath: values.output,
    ...deps,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runAgedCostReliefCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error instanceof AgedCostReliefCliError ? error.code : 'aged_cost_relief_failed';
    const exitCode = error instanceof AgedCostReliefCliError ? error.exitCode : 1;
    console.error(JSON.stringify({ outcome: 'aborted', errorCode: code }));
    process.exitCode = exitCode;
  }
}
