#!/usr/bin/env node
// Audited DB-owner maintenance CLI implementing docs/TERMS-RECEIPT-DISPOSITION.md.
// One transaction, one exact 5-field target, private 0600 JSON input only (never CLI argv).
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { Pool } = pg;

const MAX_INPUT_BYTES = 65_536;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const CASE_REF = /^[A-Za-z0-9._:-]{1,120}$/;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const EXPECTED_TRIGGERS_ENABLED = [
  { tgname: 'mr_terms_receipts_no_truncate', tgenabled: 'O' },
  { tgname: 'mr_terms_receipts_no_update_delete', tgenabled: 'O' },
];
const EXPECTED_TRIGGERS_DURING_DELETE = [
  { tgname: 'mr_terms_receipts_no_truncate', tgenabled: 'O' },
  { tgname: 'mr_terms_receipts_no_update_delete', tgenabled: 'D' },
];
const RECEIPT_COLUMNS =
  'issuer, subject, policy_version AS "policyVersion", policy_digest AS "policyDigest", accepted_at::text AS "acceptedAtExact"';
const TARGET_PREDICATE =
  'issuer=$1 AND subject=$2 AND policy_version=$3 AND policy_digest=$4 AND accepted_at=$5::timestamptz';

class DispositionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DispositionError';
    this.code = code;
  }
}

function fail(code) {
  throw new DispositionError(code);
}

function quoteIdent(name) {
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) fail('invalid_schema_identifier');
  return `"${name}"`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function assertExactKeys(obj, allowed, required = allowed) {
  if (!isPlainObject(obj)) fail('invalid_disposition_packet');
  const keys = Object.keys(obj);
  if (keys.some((k) => !allowed.includes(k))) fail('invalid_disposition_packet');
  if (required.some((k) => !(k in obj))) fail('invalid_disposition_packet');
}

function validateBoundedText(value, maxLen = 200) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maxLen ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail('invalid_disposition_packet');
  }
  return value;
}

function validateTargetTuple(target) {
  assertExactKeys(target, [
    'issuer',
    'subject',
    'policyVersion',
    'policyDigest',
    'acceptedAtExact',
  ]);
  const { issuer, subject, policyVersion, policyDigest, acceptedAtExact } = target;
  if (
    typeof issuer !== 'string' ||
    Buffer.byteLength(issuer, 'utf8') < 1 ||
    Buffer.byteLength(issuer, 'utf8') > 1024 ||
    !/^https?:\/\//.test(issuer) ||
    /[\s\u0000-\u001f\u007f]/.test(issuer)
  ) {
    fail('invalid_target_tuple');
  }
  if (
    typeof subject !== 'string' ||
    Buffer.byteLength(subject, 'utf8') < 1 ||
    Buffer.byteLength(subject, 'utf8') > 512 ||
    /^\s*$/.test(subject) ||
    /[\u0000-\u001f\u007f]/.test(subject)
  ) {
    fail('invalid_target_tuple');
  }
  if (typeof policyVersion !== 'string' || !POLICY_VERSION.test(policyVersion)) {
    fail('invalid_target_tuple');
  }
  if (typeof policyDigest !== 'string' || !SHA256_HEX.test(policyDigest)) {
    fail('invalid_target_tuple');
  }
  if (
    typeof acceptedAtExact !== 'string' ||
    !acceptedAtExact ||
    acceptedAtExact.length > 80 ||
    acceptedAtExact.trim() !== acceptedAtExact ||
    /[\u0000-\u001f\u007f]/.test(acceptedAtExact) ||
    !Number.isFinite(Date.parse(acceptedAtExact))
  ) {
    fail('invalid_target_tuple');
  }
  return { issuer, subject, policyVersion, policyDigest, acceptedAtExact };
}

export function validateDispositionPacket(raw) {
  assertExactKeys(
    raw,
    [
      'caseReference',
      'reviewer',
      'operator',
      'reason',
      'holdCleared',
      'schema',
      'target',
      'retainedPeers',
    ],
    ['caseReference', 'reviewer', 'operator', 'reason', 'holdCleared', 'target'],
  );
  if (typeof raw.caseReference !== 'string' || !CASE_REF.test(raw.caseReference)) {
    fail('invalid_case_reference');
  }
  const reviewer = validateBoundedText(raw.reviewer, 200);
  const operator = validateBoundedText(raw.operator, 200);
  const reason = validateBoundedText(raw.reason, 1000);
  if (raw.holdCleared !== true) fail('preservation_hold_not_cleared');
  const schema = raw.schema === undefined ? 'public' : raw.schema;
  if (typeof schema !== 'string' || !IDENTIFIER.test(schema)) fail('invalid_schema_identifier');
  const target = validateTargetTuple(raw.target);
  let retainedPeers = [];
  if (raw.retainedPeers !== undefined) {
    if (!Array.isArray(raw.retainedPeers) || raw.retainedPeers.length > 50) {
      fail('invalid_disposition_packet');
    }
    retainedPeers = raw.retainedPeers.map(validateTargetTuple);
  }
  return {
    caseReference: raw.caseReference,
    reviewer,
    operator,
    reason,
    holdCleared: true,
    schema,
    target,
    retainedPeers,
  };
}

export async function readPrivatePacketFile(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('input_path_not_absolute');
  const parentReal = await realpath(dirname(path)).catch(() => null);
  if (parentReal !== dirname(path)) fail('input_parent_symlink_rejected');
  const linkCheck = await lstat(path).catch(() => null);
  if (!linkCheck || !linkCheck.isFile() || linkCheck.isSymbolicLink()) {
    fail('input_file_not_regular');
  }
  if ((linkCheck.mode & 0o077) !== 0) fail('input_file_permissions_too_open');
  if (linkCheck.size < 2 || linkCheck.size > MAX_INPUT_BYTES) fail('input_file_size_invalid');

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const facts = await handle.stat();
    if (!facts.isFile() || (facts.mode & 0o077) !== 0 || facts.size > MAX_INPUT_BYTES) {
      fail('input_file_invalid');
    }
    const text = await handle.readFile('utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('input_json_malformed');
    }
    return validateDispositionPacket(parsed);
  } finally {
    await handle.close();
  }
}

async function writePrivateOutput(path, payload) {
  if (!isAbsolute(path)) fail('output_path_not_absolute');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== dirname(path)) fail('output_parent_symlink_rejected');
  await writeFile(path, JSON.stringify(payload, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

function tupleValues(tuple) {
  return [
    tuple.issuer,
    tuple.subject,
    tuple.policyVersion,
    tuple.policyDigest,
    tuple.acceptedAtExact,
  ];
}

function exactTupleMatches(row, expected) {
  return Boolean(
    row &&
    row.issuer === expected.issuer &&
    row.subject === expected.subject &&
    row.policyVersion === expected.policyVersion &&
    row.policyDigest === expected.policyDigest &&
    row.acceptedAtExact === expected.acceptedAtExact,
  );
}

async function readTriggers(queryable, qualifiedTable) {
  const { rows } = await queryable.query(
    'SELECT tgname, tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname',
    [qualifiedTable],
  );
  return rows.map((r) => ({ tgname: r.tgname, tgenabled: r.tgenabled }));
}

function triggersEqual(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every(
      (entry, index) =>
        entry.tgname === expected[index].tgname && entry.tgenabled === expected[index].tgenabled,
    )
  );
}

async function verifyPeers(client, qualifiedTable, peers) {
  for (const peer of peers) {
    const found = await client.query(
      `SELECT ${RECEIPT_COLUMNS} FROM ${qualifiedTable} WHERE ${TARGET_PREDICATE}`,
      tupleValues(peer),
    );
    if (found.rowCount !== 1 || !exactTupleMatches(found.rows[0], peer)) {
      fail('retained_peer_mismatch');
    }
  }
}

export async function disposeTermsReceipt({
  inputPath,
  packet: suppliedPacket,
  execute = false,
  outputPath,
  pool: injectedPool,
  databaseUrl,
  afterDelete,
}) {
  const packet = suppliedPacket
    ? validateDispositionPacket(suppliedPacket)
    : await readPrivatePacketFile(inputPath);
  const connectionString =
    databaseUrl ?? process.env.MAINTENANCE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!injectedPool && !connectionString) fail('maintenance_database_url_required');

  const ownedPool = injectedPool ? null : new Pool({ connectionString, max: 2 });
  const activePool = injectedPool ?? ownedPool;
  const qualifiedTable = `${quoteIdent(packet.schema)}.mr_terms_receipts`;

  let commitSent = false;
  try {
    const client = await activePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='5s'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='5s'");
      await client.query(`LOCK TABLE ${qualifiedTable} IN ACCESS EXCLUSIVE MODE`);

      const repl = await client.query('SHOW session_replication_role');
      if (repl.rows[0]?.session_replication_role !== 'origin') {
        fail('session_replication_role_not_origin');
      }
      const initialTriggers = await readTriggers(client, qualifiedTable);
      if (!triggersEqual(initialTriggers, EXPECTED_TRIGGERS_ENABLED)) {
        fail('unexpected_initial_trigger_state');
      }

      if (!execute) {
        const matched = await client.query(
          `SELECT ${RECEIPT_COLUMNS} FROM ${qualifiedTable} WHERE ${TARGET_PREDICATE}`,
          tupleValues(packet.target),
        );
        if (matched.rowCount !== 1 || !exactTupleMatches(matched.rows[0], packet.target)) {
          fail('receipt_disposition_target_mismatch');
        }
        await verifyPeers(client, qualifiedTable, packet.retainedPeers);
        if (!triggersEqual(await readTriggers(client, qualifiedTable), EXPECTED_TRIGGERS_ENABLED)) {
          fail('unexpected_trigger_state');
        }
        await client.query('ROLLBACK');
        const dryRunResult = {
          schemaVersion: 1,
          mode: 'dry-run',
          outcome: 'dry-run-verified',
          caseReference: packet.caseReference,
          schema: packet.schema,
          matchedCount: 1,
          affectedCount: 0,
          triggersEnabled: true,
        };
        if (outputPath) await writePrivateOutput(outputPath, dryRunResult);
        return dryRunResult;
      }

      await client.query(
        `ALTER TABLE ${qualifiedTable} DISABLE TRIGGER mr_terms_receipts_no_update_delete`,
      );
      if (
        !triggersEqual(await readTriggers(client, qualifiedTable), EXPECTED_TRIGGERS_DURING_DELETE)
      ) {
        fail('unexpected_disabled_trigger_state');
      }

      const deleted = await client.query(
        `DELETE FROM ${qualifiedTable} WHERE ${TARGET_PREDICATE} RETURNING ${RECEIPT_COLUMNS}`,
        tupleValues(packet.target),
      );
      if (deleted.rowCount !== 1 || !exactTupleMatches(deleted.rows[0], packet.target)) {
        fail('receipt_disposition_target_mismatch');
      }

      if (afterDelete) await afterDelete(client);

      await client.query(
        `ALTER TABLE ${qualifiedTable} ENABLE TRIGGER mr_terms_receipts_no_update_delete`,
      );
      if (!triggersEqual(await readTriggers(client, qualifiedTable), EXPECTED_TRIGGERS_ENABLED)) {
        fail('trigger_reenable_verification_failed');
      }
      const replAfter = await client.query('SHOW session_replication_role');
      if (replAfter.rows[0]?.session_replication_role !== 'origin') {
        fail('session_replication_role_not_origin');
      }
      await verifyPeers(client, qualifiedTable, packet.retainedPeers);

      commitSent = true;
      await client.query('COMMIT');
    } catch (error) {
      if (!commitSent) {
        await client.query('ROLLBACK').catch(() => {});
      } else {
        throw new DispositionError('commit_outcome_unknown_reconcile_readback');
      }
      if (error instanceof DispositionError) throw error;
      const pgCode = typeof error?.code === 'string' ? error.code : 'sql_error';
      fail(`database_operation_failed:${pgCode}`);
    } finally {
      client.release();
    }

    // Fresh post-commit readback verification on the pool.
    const postTriggers = await readTriggers(activePool, qualifiedTable);
    const postTarget = await activePool.query(
      `SELECT 1 FROM ${qualifiedTable} WHERE ${TARGET_PREDICATE}`,
      tupleValues(packet.target),
    );
    if (!triggersEqual(postTriggers, EXPECTED_TRIGGERS_ENABLED) || postTarget.rowCount !== 0) {
      fail('post_commit_readback_mismatch');
    }

    const committedResult = {
      schemaVersion: 1,
      mode: 'execute',
      outcome: 'committed',
      caseReference: packet.caseReference,
      schema: packet.schema,
      affectedCount: 1,
      triggersEnabled: true,
    };
    if (outputPath) await writePrivateOutput(outputPath, committedResult);
    return committedResult;
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

export async function runDisposeTermsReceiptCli(args = process.argv.slice(2), deps = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: {
        input: { type: 'string' },
        output: { type: 'string' },
        'dry-run': { type: 'boolean' },
        execute: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    });
  } catch {
    fail('invalid_cli_arguments');
  }
  const { values } = parsed;
  if (values.help) {
    return {
      usage:
        'node scripts/dispose-terms-receipt.mjs --input /absolute/private/0600-case.json [--dry-run|--execute] [--output /absolute/private/0600-receipt.json]',
    };
  }
  if (!values.input || (values['dry-run'] && values.execute)) {
    fail('invalid_cli_arguments');
  }
  return disposeTermsReceipt({
    inputPath: values.input,
    execute: values.execute === true,
    outputPath: values.output,
    ...deps,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDisposeTermsReceiptCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error instanceof DispositionError ? error.code : 'disposition_failed';
    console.error(JSON.stringify({ outcome: 'aborted', errorCode: code }));
    process.exitCode = code === 'invalid_cli_arguments' ? 2 : 1;
  }
}
