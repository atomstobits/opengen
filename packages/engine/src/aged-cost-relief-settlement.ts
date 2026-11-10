import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

interface ReliefSettlementInput {
  workspaceId: string;
  jobId: string;
  reservedMicros: number;
  chargedMicros: number;
  upstreamCostMicros: number | null;
  settleLedgerId: string;
  releaseLedgerId: string;
}

export interface AgedCostReliefSettlement {
  advanceMicros: number;
  grossChargeMicros: number;
  recoveredMicros: number;
  operatorFundedMicros: number;
  customerNetChargeMicros: 0;
  supplierCostScope: 'current-attempt';
  unverifiedPredecessorCount: number;
}

interface CurrentCostScope {
  attemptId: string;
  attemptNumber: number;
  routeId: string;
  deploymentId: string;
  upstreamReference: string | null;
  providerCostMicros: number;
  scope: 'current-attempt';
}

interface UnverifiedPredecessor {
  attemptId: string;
  attemptNumber: number;
  routeId: string;
  deploymentId: string;
  state: string;
  credentialIdentity: string | null;
  upstreamReference: string | null;
  supplierCostMicros: null;
}

interface FrozenJob {
  attemptCount: number;
  upstreamId: string | null;
}

interface LedgerRow {
  id: string;
  workspace_id: string;
  job_id: string | null;
  kind: string;
  amount_micros: string;
  available_delta_micros: string;
  reserved_delta_micros: string;
  reference: string | null;
  details: Record<string, unknown>;
}

interface Balance {
  availableMicros: number;
  reservedMicros: number;
}

interface SettlementReceipt extends AgedCostReliefSettlement {
  workspaceId: string;
  jobId: string;
  reservedMicros: number;
  chargedMicros: number;
  upstreamCostMicros: number | null;
  settleLedgerId: string;
  releaseLedgerId: string;
  offsetLedgerId: string;
  currentCostScope: CurrentCostScope;
  unverifiedPredecessors: UnverifiedPredecessor[];
  beforeOffset: Balance;
  afterOffset: Balance;
}

interface SettlementRow {
  advance_micros: string;
  gross_charge_micros: string;
  recovered_micros: string;
  operator_funded_micros: string;
  settle_ledger_id: string;
  release_ledger_id: string;
  offset_ledger_id: string;
  receipt: SettlementReceipt;
}

function conflict(): never {
  throw Object.assign(new Error('Aged cost relief does not match the original settlement.'), {
    code: 'aged_cost_relief_settlement_conflict',
    statusCode: 409,
  });
}

function money(value: unknown): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) conflict();
  return amount;
}

async function supplierScope(
  client: PoolClient,
  input: ReliefSettlementInput,
  frozenJob: FrozenJob,
): Promise<{
  currentCostScope: CurrentCostScope;
  unverifiedPredecessors: UnverifiedPredecessor[];
}> {
  const job = (
    await client.query<{ attempt_count: number; upstream_id: string | null }>(
      'SELECT attempt_count,upstream_id FROM mr_jobs WHERE workspace_id=$1 AND id=$2',
      [input.workspaceId, input.jobId],
    )
  ).rows[0];
  const attempts = (
    await client.query<{
      id: string;
      number: number;
      route_id: string;
      deployment_id: string;
      state: string;
      credential_identity: string | null;
    }>(
      `SELECT a.id,a.number,a.route_id,a.deployment_id,a.state,c.identity AS credential_identity
      FROM mr_attempts a LEFT JOIN mr_attempt_credentials c
        ON c.job_id=a.job_id AND c.attempt_number=a.number AND c.workspace_id=$1
      WHERE a.job_id=$2 ORDER BY a.number LIMIT 101`,
      [input.workspaceId, input.jobId],
    )
  ).rows;
  if (
    !job ||
    !Number.isSafeInteger(job.attempt_count) ||
    job.attempt_count < 1 ||
    attempts.length > 100 ||
    attempts.length !== job.attempt_count ||
    attempts.some((attempt, index) => attempt.number !== index + 1) ||
    input.upstreamCostMicros === null
  )
    conflict();
  const current = attempts.find((attempt) => attempt.number === job.attempt_count);
  if (!current) conflict();
  return {
    currentCostScope: {
      attemptId: current.id,
      attemptNumber: current.number,
      routeId: current.route_id,
      deploymentId: current.deployment_id,
      upstreamReference: job.upstream_id,
      providerCostMicros: input.upstreamCostMicros,
      scope: 'current-attempt',
    },
    unverifiedPredecessors: attempts
      .filter((attempt) => attempt.id !== current.id)
      .map((attempt) => ({
        attemptId: attempt.id,
        attemptNumber: attempt.number,
        routeId: attempt.route_id,
        deploymentId: attempt.deployment_id,
        state: attempt.state,
        credentialIdentity: attempt.credential_identity,
        upstreamReference: attempt.number === frozenJob.attemptCount ? frozenJob.upstreamId : null,
        supplierCostMicros: null,
      })),
  };
}

/** The caller owns the workspace/job locks and transaction. Ordinary settlement
 * has already released the original reservation. Recover only that unused
 * advance, on the same client, without changing reservations or key budgets. */
export async function finalizeAgedCostReliefInTransaction(
  client: PoolClient,
  input: ReliefSettlementInput,
): Promise<AgedCostReliefSettlement | null> {
  // Existing accepted jobs can be reconciled before the forward schema is
  // installed. No relief grant can exist in that older schema.
  const installed = (await client.query("SELECT to_regclass('mr_aged_cost_reliefs') AS name"))
    .rows[0].name;
  if (!installed) return null;
  const grant = (
    await client.query<{ amount_micros: string; snapshot: { job: FrozenJob } }>(
      'SELECT amount_micros,snapshot FROM mr_aged_cost_reliefs WHERE workspace_id=$1 AND job_id=$2 FOR UPDATE',
      [input.workspaceId, input.jobId],
    )
  ).rows[0];
  if (!grant) return null;

  const frozenJob = grant.snapshot?.job;
  if (
    !frozenJob ||
    !Number.isSafeInteger(frozenJob.attemptCount) ||
    frozenJob.attemptCount < 1 ||
    (frozenJob.upstreamId !== null && typeof frozenJob.upstreamId !== 'string')
  )
    conflict();

  const advance = money(input.reservedMicros);
  const charge = money(input.chargedMicros);
  if (
    advance === 0 ||
    money(grant.amount_micros) !== advance ||
    charge > advance ||
    input.upstreamCostMicros === null ||
    money(input.upstreamCostMicros) !== input.upstreamCostMicros
  )
    conflict();
  const recovered = advance - charge;
  const amounts = {
    advanceMicros: advance,
    grossChargeMicros: charge,
    recoveredMicros: recovered,
    operatorFundedMicros: charge,
    customerNetChargeMicros: 0 as const,
  };
  const reference = `aged-cost-relief:${input.jobId}:unused-advance`;
  const ledgers = (
    await client.query<LedgerRow>(
      'SELECT * FROM mr_ledger WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
      [input.workspaceId, [input.settleLedgerId, input.releaseLedgerId]],
    )
  ).rows;
  const settle = ledgers.find((row) => row.id === input.settleLedgerId);
  const release = ledgers.find((row) => row.id === input.releaseLedgerId);
  if (
    !settle ||
    !release ||
    settle.id === release.id ||
    settle.job_id !== input.jobId ||
    release.job_id !== input.jobId ||
    settle.kind !== 'settle' ||
    release.kind !== 'release' ||
    money(settle.amount_micros) !== charge ||
    Number(settle.available_delta_micros) !== 0 ||
    Number(settle.reserved_delta_micros) !== -charge ||
    settle.details?.upstreamCostMicros !== input.upstreamCostMicros ||
    money(release.amount_micros) !== recovered ||
    Number(release.available_delta_micros) !== recovered ||
    Number(release.reserved_delta_micros) !== -recovered
  )
    conflict();

  const prior = (
    await client.query<SettlementRow>(
      'SELECT * FROM mr_aged_cost_relief_settlements WHERE workspace_id=$1 AND job_id=$2',
      [input.workspaceId, input.jobId],
    )
  ).rows[0];
  if (prior) {
    const receipt = prior.receipt;
    if (
      !receipt ||
      !receipt.beforeOffset ||
      !receipt.afterOffset ||
      !receipt.currentCostScope ||
      !Array.isArray(receipt.unverifiedPredecessors) ||
      receipt.unverifiedPredecessors.length > 99
    )
      conflict();
    const current = receipt.currentCostScope;
    const predecessorIds = new Set<string>();
    const predecessorNumbers = new Set<number>();
    for (const predecessor of receipt.unverifiedPredecessors) {
      if (
        !predecessor ||
        typeof predecessor.attemptId !== 'string' ||
        predecessor.attemptId === current.attemptId ||
        predecessorIds.has(predecessor.attemptId) ||
        !Number.isSafeInteger(predecessor.attemptNumber) ||
        predecessor.attemptNumber < 1 ||
        predecessor.attemptNumber >= current.attemptNumber ||
        predecessorNumbers.has(predecessor.attemptNumber) ||
        typeof predecessor.routeId !== 'string' ||
        typeof predecessor.deploymentId !== 'string' ||
        typeof predecessor.state !== 'string' ||
        (predecessor.credentialIdentity !== null &&
          typeof predecessor.credentialIdentity !== 'string') ||
        predecessor.upstreamReference !==
          (predecessor.attemptNumber === frozenJob.attemptCount ? frozenJob.upstreamId : null) ||
        predecessor.supplierCostMicros !== null
      )
        conflict();
      predecessorIds.add(predecessor.attemptId);
      predecessorNumbers.add(predecessor.attemptNumber);
    }
    if (
      money(prior.advance_micros) !== advance ||
      money(prior.gross_charge_micros) !== charge ||
      money(prior.recovered_micros) !== recovered ||
      money(prior.operator_funded_micros) !== charge ||
      prior.settle_ledger_id !== input.settleLedgerId ||
      prior.release_ledger_id !== input.releaseLedgerId ||
      receipt.workspaceId !== input.workspaceId ||
      receipt.jobId !== input.jobId ||
      receipt.reservedMicros !== advance ||
      receipt.chargedMicros !== charge ||
      receipt.advanceMicros !== advance ||
      receipt.grossChargeMicros !== charge ||
      receipt.recoveredMicros !== recovered ||
      receipt.operatorFundedMicros !== charge ||
      receipt.customerNetChargeMicros !== 0 ||
      receipt.supplierCostScope !== 'current-attempt' ||
      receipt.unverifiedPredecessorCount !== receipt.unverifiedPredecessors.length ||
      current.scope !== 'current-attempt' ||
      current.providerCostMicros !== input.upstreamCostMicros ||
      typeof current.attemptId !== 'string' ||
      !Number.isSafeInteger(current.attemptNumber) ||
      current.attemptNumber !== receipt.unverifiedPredecessors.length + 1 ||
      typeof current.routeId !== 'string' ||
      typeof current.deploymentId !== 'string' ||
      (current.upstreamReference !== null && typeof current.upstreamReference !== 'string') ||
      receipt.upstreamCostMicros !== input.upstreamCostMicros ||
      receipt.settleLedgerId !== input.settleLedgerId ||
      receipt.releaseLedgerId !== input.releaseLedgerId ||
      receipt.offsetLedgerId !== prior.offset_ledger_id ||
      BigInt(money(receipt.beforeOffset.availableMicros)) +
        BigInt(money(receipt.beforeOffset.reservedMicros)) >
        BigInt(Number.MAX_SAFE_INTEGER) ||
      money(receipt.beforeOffset.reservedMicros) !== money(receipt.afterOffset.reservedMicros) ||
      money(receipt.beforeOffset.availableMicros) - recovered !==
        money(receipt.afterOffset.availableMicros)
    )
      conflict();
    const offset = (
      await client.query<LedgerRow>('SELECT * FROM mr_ledger WHERE id=$1', [prior.offset_ledger_id])
    ).rows[0];
    if (
      !offset ||
      offset.workspace_id !== input.workspaceId ||
      offset.job_id !== null ||
      offset.kind !== 'relief-offset' ||
      money(offset.amount_micros) !== recovered ||
      Number(offset.available_delta_micros) !== -recovered ||
      Number(offset.reserved_delta_micros) !== 0 ||
      offset.reference !== reference
    )
      conflict();
    return {
      ...amounts,
      supplierCostScope: 'current-attempt',
      unverifiedPredecessorCount: receipt.unverifiedPredecessorCount,
    };
  }

  const scope = await supplierScope(client, input, frozenJob);
  const summary: AgedCostReliefSettlement = {
    ...amounts,
    supplierCostScope: 'current-attempt',
    unverifiedPredecessorCount: scope.unverifiedPredecessors.length,
  };

  const wallet = (
    await client.query<{ available_micros: string; reserved_micros: string }>(
      'SELECT available_micros,reserved_micros FROM mr_workspaces WHERE id=$1',
      [input.workspaceId],
    )
  ).rows[0];
  if (!wallet) conflict();
  const beforeOffset = {
    availableMicros: money(wallet.available_micros),
    reservedMicros: money(wallet.reserved_micros),
  };
  if (
    beforeOffset.availableMicros < recovered ||
    BigInt(beforeOffset.availableMicros) + BigInt(beforeOffset.reservedMicros) >
      BigInt(Number.MAX_SAFE_INTEGER)
  )
    conflict();
  const afterOffset = {
    availableMicros: beforeOffset.availableMicros - recovered,
    reservedMicros: beforeOffset.reservedMicros,
  };
  const receipt: SettlementReceipt = {
    ...input,
    ...summary,
    ...scope,
    offsetLedgerId: randomUUID(),
    beforeOffset,
    afterOffset,
  };
  // Workspace ledger reads expose details. Recovery and credential identities
  // belong only to the private settlement receipt.
  const ledgerDetails = {
    purpose: 'aged-cost-relief-unused-advance',
    jobId: input.jobId,
    ...summary,
    beforeOffset,
    afterOffset,
  };
  const updated = await client.query(
    'UPDATE mr_workspaces SET available_micros=$2 WHERE id=$1 AND available_micros=$3 AND reserved_micros=$4',
    [
      input.workspaceId,
      afterOffset.availableMicros,
      beforeOffset.availableMicros,
      beforeOffset.reservedMicros,
    ],
  );
  if (updated.rowCount !== 1) conflict();
  await client.query(
    `INSERT INTO mr_ledger(id,workspace_id,job_id,kind,amount_micros,available_delta_micros,reserved_delta_micros,reference,details)
    VALUES($1,$2,NULL,'relief-offset',$3,-($3::bigint),0,$4,$5)`,
    [
      receipt.offsetLedgerId,
      input.workspaceId,
      recovered,
      reference,
      JSON.stringify(ledgerDetails),
    ],
  );
  await client.query(
    `INSERT INTO mr_aged_cost_relief_settlements(job_id,workspace_id,advance_micros,gross_charge_micros,recovered_micros,operator_funded_micros,settle_ledger_id,release_ledger_id,offset_ledger_id,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.jobId,
      input.workspaceId,
      advance,
      charge,
      recovered,
      charge,
      input.settleLedgerId,
      input.releaseLedgerId,
      receipt.offsetLedgerId,
      JSON.stringify(receipt),
    ],
  );
  return summary;
}
