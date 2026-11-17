#!/usr/bin/env node
// Bounded local operator CLI for StaffRefundStore (docs/billing/staff-refunds.md).
// Reads case/request JSON strictly from a private 0600 file; never accepts secrets or PII in argv.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';

const { Pool } = pg;

const MAX_PACKET_BYTES = 524_288;
const ALLOWED_ACTIONS = new Set(['rehearse', 'prepare', 'dispatch', 'observe', 'apply']);
const MUTATING_ACTIONS = new Set(['prepare', 'dispatch', 'observe', 'apply']);

class StaffRefundCliError extends Error {
  constructor(code, exitCode = 1) {
    super(code);
    this.name = 'StaffRefundCliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, exitCode = 1) {
  throw new StaffRefundCliError(code, exitCode);
}

async function loadStaffRefundModules() {
  try {
    const [staffRefunds, billingCustomer, producer] = await Promise.all([
      import('../packages/engine/src/staff-refunds.ts'),
      import('../packages/engine/src/billing-customer.ts'),
      import('../apps/server/src/staff-refund-evidence-producer.ts'),
    ]);
    return { ...staffRefunds, ...billingCustomer, ...producer };
  } catch {
    const { tsImport } = await import('tsx/esm/api');
    const [staffRefunds, billingCustomer, producer] = await Promise.all([
      tsImport('../packages/engine/src/staff-refunds.ts', import.meta.url),
      tsImport('../packages/engine/src/billing-customer.ts', import.meta.url),
      tsImport('../apps/server/src/staff-refund-evidence-producer.ts', import.meta.url),
    ]);
    return { ...staffRefunds, ...billingCustomer, ...producer };
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
    fail('invalid_staff_refund_packet', 2);
  }
  return value;
}

export async function readPrivateStaffPacket(path) {
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
    if (!isPlainObject(parsed)) fail('invalid_staff_refund_packet', 2);
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

function decodeRawDelivery(delivery) {
  if (!isPlainObject(delivery) || typeof delivery.signature !== 'string' || !delivery.signature) {
    fail('invalid_raw_delivery_packet', 2);
  }
  if (typeof delivery.rawBodyBase64 === 'string' && delivery.rawBodyBase64.length > 0) {
    return {
      rawBody: Buffer.from(delivery.rawBodyBase64, 'base64'),
      signature: delivery.signature,
    };
  }
  if (typeof delivery.rawBodyUtf8 === 'string' && delivery.rawBodyUtf8.length > 0) {
    return {
      rawBody: Buffer.from(delivery.rawBodyUtf8, 'utf8'),
      signature: delivery.signature,
    };
  }
  fail('invalid_raw_delivery_packet', 2);
}

async function loadCanonicalPaymentBinding(pool, environment, { workspaceId, orderId, chargeId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const { rows } = await client.query(
      `SELECT o.workspace_id, o.id, o.payment_intent_id, o.amount_cents,
              o.processor_environment_id, o.processor_account_id, o.livemode
       FROM mr_payment_orders o
       JOIN mr_billing_processor_environments e ON e.id = o.processor_environment_id
       JOIN mr_billing_payment_ownership p ON p.processor_environment_id = e.id
         AND p.payment_intent_id = o.payment_intent_id
       WHERE o.workspace_id = $1 AND o.id = $2
         AND o.processor_environment_id = $3 AND o.processor_account_id = $4
         AND e.account_id = $4 AND e.livemode = $5 AND o.livemode = $5
         AND o.status = 'credited' AND o.credited_at IS NOT NULL`,
      [workspaceId, orderId, environment.id, environment.accountId, environment.livemode],
    );
    await client.query('COMMIT');
    const row = rows[0];
    if (!row) fail('staff_refund_payment_mismatch');
    return Object.freeze({
      workspaceId: row.workspace_id,
      orderId: row.id,
      processorEnvironmentId: row.processor_environment_id,
      processorAccountId: row.processor_account_id,
      livemode: row.livemode,
      paymentIntentId: row.payment_intent_id,
      chargeId: chargeId ?? null,
      amountCents: row.amount_cents,
      currency: 'USD',
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function executeStaffRefundCommand({
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
  if (MUTATING_ACTIONS.has(action) && confirm !== true) {
    fail('human_confirmation_flag_required', 2);
  }
  if (action === 'rehearse' && confirm === true) {
    fail('rehearse_is_read_only', 2);
  }

  const packet = suppliedPacket ?? (await readPrivateStaffPacket(inputPath));
  const actorId = boundedId(packet.actorId);
  const activation = packet.activation;
  if (!['fixture', 'sandbox', 'manual'].includes(activation)) {
    fail('invalid_activation_mode', 2);
  }
  if (!isPlainObject(packet.processorEnvironment)) fail('invalid_processor_environment', 2);
  const processorEnvironment = {
    id: boundedId(packet.processorEnvironment.id, 120),
    accountId: boundedId(packet.processorEnvironment.accountId, 120),
    livemode: Boolean(packet.processorEnvironment.livemode),
  };

  let approvalMeta = null;
  if (MUTATING_ACTIONS.has(action)) {
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

  const { StaffRefundStore, StaffRefundError, createStaffRefundEvidenceProducer } =
    await loadStaffRefundModules();

  const ownedPool = injectedPool ? null : new Pool({ connectionString, max: 2 });
  const activePool = injectedPool ?? ownedPool;
  const invocationContext = Object.freeze({ token: Symbol('staff-refund-cli'), actorId });

  try {
    const store = new StaffRefundStore(activePool, {
      activation,
      processorEnvironment,
      authorize: async (_client, supplied) => {
        if (supplied !== invocationContext) fail('staff_refund_authority_required');
        return { kind: 'installation-operator', id: actorId };
      },
      ...(MUTATING_ACTIONS.has(action)
        ? {
            approveAllocation: async (_client, supplied, request) => {
              if (supplied !== invocationContext || !approvalMeta) {
                fail('staff_refund_allocation_unapproved');
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

    const buildProducer = () => {
      const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) fail('stripe_webhook_secret_env_required', 2);
      const effectiveEnv =
        activation === 'fixture'
          ? Object.freeze({ ...processorEnvironment, livemode: false })
          : Object.freeze({ ...processorEnvironment });
      const effectiveTransport = Object.freeze({
        processorEnvironment: effectiveEnv,
        assertProcessorEnvironment(expected) {
          if (
            expected !== undefined &&
            (expected.id !== effectiveEnv.id ||
              expected.accountId !== effectiveEnv.accountId ||
              expected.livemode !== effectiveEnv.livemode)
          ) {
            throw new Error('Processor environment mismatch.');
          }
        },
      });
      return createStaffRefundEvidenceProducer({
        activation: activation === 'fixture' ? 'sandbox' : activation,
        processorEnvironment: effectiveEnv,
        processorTransport: effectiveTransport,
        webhookSecret,
      });
    };

    let output;
    if (action === 'rehearse') {
      const workspaceId = boundedId(packet.workspaceId, 120);
      const review = await store.reviewEvidence(workspaceId, invocationContext);
      let processor = null;
      if (packet.delivery !== undefined) {
        const orderId = boundedId(packet.orderId, 80);
        const refundId = boundedId(packet.refundId, 240);
        const payment = await loadCanonicalPaymentBinding(activePool, processorEnvironment, {
          workspaceId,
          orderId,
          chargeId: packet.chargeId ?? null,
        });
        const verified = buildProducer().verifyRaw(decodeRawDelivery(packet.delivery), {
          payment,
          refundId,
        });
        processor =
          verified.kind === 'refund'
            ? {
                kind: 'refund',
                eventId: verified.evidence.eventId,
                eventCreated: verified.evidence.eventCreated,
                payloadFingerprint: verified.evidence.payloadFingerprint,
                status: verified.evidence.status,
                amountCents: verified.evidence.amountCents,
              }
            : { kind: 'review', reason: verified.reason };
      }
      output = {
        action: 'rehearse',
        applyAllowed: false,
        snapshot: review.snapshot,
        financialRowCounts: Object.fromEntries(
          Object.entries(review.financialRows).map(([k, rows]) => [k, rows.length]),
        ),
        processor,
      };
    } else if (action === 'prepare') {
      if (!isPlainObject(packet.prepare)) fail('missing_prepare_payload', 2);
      let existingRefundEvidence = packet.prepare.existingRefundEvidence;
      if (!existingRefundEvidence && packet.prepare.origin === 'reconcile-existing') {
        const payment = await loadCanonicalPaymentBinding(activePool, processorEnvironment, {
          workspaceId: boundedId(packet.prepare.workspaceId, 120),
          orderId: boundedId(packet.prepare.orderId, 80),
          chargeId: packet.chargeId ?? null,
        });
        const refundId = boundedId(packet.refundId, 240);
        const verified = buildProducer().verifyRaw(decodeRawDelivery(packet.delivery), {
          payment,
          refundId,
        });
        if (verified.kind !== 'refund') fail(`evidence_unverified:${verified.reason}`);
        existingRefundEvidence = verified.evidence;
      }
      const prepared = await store.prepare(
        {
          workspaceId: packet.prepare.workspaceId,
          orderId: packet.prepare.orderId,
          reference: packet.prepare.reference,
          origin: packet.prepare.origin,
          eligibleMicros: packet.prepare.eligibleMicros,
          worksheet: packet.prepare.worksheet,
          worksheetHash: packet.prepare.worksheetHash,
          ...(existingRefundEvidence ? { existingRefundEvidence } : {}),
        },
        invocationContext,
      );
      output = { action: 'prepare', case: prepared };
    } else if (action === 'dispatch') {
      const caseId = boundedId(packet.caseId, 80);
      if (!isPlainObject(packet.dispatch)) fail('missing_dispatch_payload', 2);
      const dispatched = await store.dispatch(caseId, packet.dispatch, invocationContext);
      output = { action: 'dispatch', case: dispatched };
    } else if (action === 'observe') {
      const caseId = boundedId(packet.caseId, 80);
      if (!isPlainObject(packet.observation)) fail('missing_observation_payload', 2);
      let verifiedEvidence = packet.verifiedEvidence;
      if (!verifiedEvidence) {
        const workspaceId = boundedId(packet.workspaceId, 120);
        const orderId = boundedId(packet.orderId, 80);
        const refundId = boundedId(packet.refundId, 240);
        const payment = await loadCanonicalPaymentBinding(activePool, processorEnvironment, {
          workspaceId,
          orderId,
          chargeId: packet.chargeId ?? null,
        });
        const verified = buildProducer().verifyRaw(decodeRawDelivery(packet.delivery), {
          payment,
          refundId,
        });
        if (verified.kind !== 'refund') fail(`evidence_unverified:${verified.reason}`);
        verifiedEvidence = verified.evidence;
      }
      const observed = await store.observeVerifiedProcessorEvidence(
        caseId,
        verifiedEvidence,
        packet.observation,
        invocationContext,
      );
      output = { action: 'observe', case: observed };
    } else if (action === 'apply') {
      const caseId = boundedId(packet.caseId, 80);
      if (!isPlainObject(packet.reconcile)) fail('missing_reconcile_payload', 2);
      let reaffirmLatestEvidence = packet.reconcile.reaffirmLatestEvidence;
      if (!reaffirmLatestEvidence && packet.delivery !== undefined) {
        const workspaceId = boundedId(packet.workspaceId, 120);
        const orderId = boundedId(packet.orderId, 80);
        const refundId = boundedId(packet.refundId, 240);
        const payment = await loadCanonicalPaymentBinding(activePool, processorEnvironment, {
          workspaceId,
          orderId,
          chargeId: packet.chargeId ?? null,
        });
        const verified = buildProducer().verifyRaw(decodeRawDelivery(packet.delivery), {
          payment,
          refundId,
        });
        if (verified.kind !== 'refund') fail(`evidence_unverified:${verified.reason}`);
        reaffirmLatestEvidence = verified.evidence;
      }
      const applied = await store.reconcile(
        caseId,
        {
          action: packet.reconcile.action ?? 'apply-success',
          reference: packet.reconcile.reference,
          note: packet.reconcile.note,
          evidenceReference: packet.reconcile.evidenceReference,
          ...(packet.reconcile.worksheet !== undefined
            ? { worksheet: packet.reconcile.worksheet }
            : {}),
          ...(packet.reconcile.worksheetHash !== undefined
            ? { worksheetHash: packet.reconcile.worksheetHash }
            : {}),
          ...(packet.reconcile.resolveHoldIds !== undefined
            ? { resolveHoldIds: packet.reconcile.resolveHoldIds }
            : {}),
          ...(packet.reconcile.holdResolutionEvidenceUrl !== undefined
            ? { holdResolutionEvidenceUrl: packet.reconcile.holdResolutionEvidenceUrl }
            : {}),
          ...(reaffirmLatestEvidence ? { reaffirmLatestEvidence } : {}),
        },
        invocationContext,
      );
      output = { action: 'apply', case: applied };
    }

    if (outputPath) await writePrivateOutput(outputPath, output);
    return output;
  } catch (error) {
    if (error instanceof StaffRefundCliError) throw error;
    if (error instanceof StaffRefundError || typeof error?.code === 'string') {
      fail(String(error.code));
    }
    fail('staff_refund_operation_failed');
  } finally {
    if (ownedPool) await ownedPool.end();
  }
}

export async function runStaffRefundCli(args = process.argv.slice(2), deps = {}) {
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
        'node scripts/staff-refund.mjs --action <rehearse|prepare|dispatch|observe|apply> --input /absolute/private/0600-packet.json [--confirm] [--output /absolute/private/0600-receipt.json]',
    };
  }
  if (!values.action || !values.input) fail('invalid_cli_arguments', 2);
  return executeStaffRefundCommand({
    action: values.action,
    confirm: values.confirm === true,
    inputPath: values.input,
    outputPath: values.output,
    ...deps,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runStaffRefundCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const code = error instanceof StaffRefundCliError ? error.code : 'staff_refund_failed';
    const exitCode = error instanceof StaffRefundCliError ? error.exitCode : 1;
    console.error(JSON.stringify({ outcome: 'aborted', errorCode: code }));
    process.exitCode = exitCode;
  }
}
