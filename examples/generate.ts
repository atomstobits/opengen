import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import {
  JobWaitTimeoutError,
  OpenGen,
  SubmissionUncertainError,
  type GenerateInput,
} from '@media-router/sdk';

const { values } = parseArgs({
  options: {
    input: { type: 'string' },
    receipt: { type: 'string' },
    'max-cost-micros': { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});
const baseUrl = process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310';
const receiptPath = values.receipt
  ? resolve(values.receipt)
  : fileURLToPath(new URL('../.local/examples/generation.json', import.meta.url));
interface Receipt {
  version: 1;
  baseUrl: string;
  input: GenerateInput;
  idempotencyKey: string;
  requestHash: string;
  jobId?: string;
  /** Missing on older receipts means acceptance must be treated as unknown. */
  submission?: 'not-started' | 'attempted';
}
const hash = (input: GenerateInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const client = new OpenGen({ baseUrl, apiKey: process.env.MEDIA_ROUTER_TOKEN });

async function save(receipt: Receipt) {
  const temporary = `${receiptPath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, receiptPath);
}
async function main() {
  let receipt: Receipt | undefined;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let requested: GenerateInput | undefined;
  if (values.input) {
    const parsed: unknown = JSON.parse(await readFile(resolve(values.input), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Input must be a native GenerateInput JSON object.');
    const maximum = Number(values['max-cost-micros'] ?? receipt?.input.maxCostMicros);
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error('Set a positive --max-cost-micros limit before creating a receipt.');
    const input = parseGenerationRequest(parsed);
    if (input.billing === 'byok')
      throw new Error(
        'This example uses managed credit only. BYOK charges cannot be guaranteed by a gateway spending limit.',
      );
    if (
      input.maxCostMicros !== undefined &&
      (!Number.isSafeInteger(input.maxCostMicros) || input.maxCostMicros < 0)
    )
      throw new Error('Invalid input maxCostMicros.');
    requested = { ...input, maxCostMicros: Math.min(maximum, input.maxCostMicros ?? maximum) };
  }
  if (receipt) {
    if (
      receipt.version !== 1 ||
      receipt.baseUrl !== baseUrl ||
      hash(receipt.input) !== receipt.requestHash ||
      (requested && hash(requested) !== receipt.requestHash)
    )
      throw new Error(
        'The receipt does not match this gateway and original input. Recover it before starting different work.',
      );
  } else {
    if (!requested)
      throw new Error(
        'First run requires --input /path/request.json and --max-cost-micros. Keep the private receipt to resume.',
      );
    receipt = {
      version: 1,
      baseUrl,
      input: requested,
      idempotencyKey: randomUUID(),
      requestHash: hash(requested),
      submission: 'not-started',
    };
    await mkdir(dirname(receiptPath), { recursive: true, mode: 0o700 });
    // Reserve the local receipt before any paid request. A concurrent invocation must reuse it.
    try {
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(
          'Another run created this receipt. Rerun to recover it; do not choose another key.',
        );
      throw error;
    }
  }
  if (!receipt.jobId && receipt.submission !== 'not-started') {
    try {
      const existing = await client.lookupJob(receipt.idempotencyKey);
      receipt.jobId = existing.id;
      await save(receipt);
    } catch (cause) {
      throw new SubmissionUncertainError(receipt.idempotencyKey, undefined, cause);
    }
  }
  if (!receipt.jobId) {
    const quote = await client.quote(receipt.input);
    console.log(
      JSON.stringify(
        {
          selectedRouteId: quote.selectedRouteId,
          reservationMicros: quote.reservationMicros,
          estimateOnly: quote.estimateOnly,
        },
        null,
        2,
      ),
    );
    if (!values.execute) {
      console.log(
        'Read-only quote complete. Review it, then rerun with --execute using this same receipt.',
      );
      return;
    }
    if (!process.env.MEDIA_ROUTER_TOKEN)
      throw new Error('Configure MEDIA_ROUTER_TOKEN securely before generation.');
    if (
      !quote.selectedRouteId ||
      !quote.candidates.some(
        (candidate) => candidate.routeId === quote.selectedRouteId && candidate.executable,
      )
    )
      throw new Error(
        'No executable route. Inspect the quote and configured installation; no generation was submitted.',
      );
    // Persist the attempt before sending: a crash or unknown response must become lookup-only.
    receipt.submission = 'attempted';
    await save(receipt);
    const accepted = await client.submit(receipt.input, { idempotencyKey: receipt.idempotencyKey });
    receipt.jobId = accepted.id;
    await save(receipt);
  }
  const job = await client.wait(receipt.jobId);
  console.log(
    JSON.stringify(
      {
        id: job.id,
        status: job.status,
        routeId: job.routeId,
        deliveryStatus: job.deliveryStatus,
        outputCount: job.outputs.length,
        settledMicros: job.settledMicros,
      },
      null,
      2,
    ),
  );
  if (job.status === 'submission-unknown')
    console.log(
      'Keep this receipt and reconcile the existing provider attempt. No replacement was submitted.',
    );
}
try {
  await main();
} catch (error) {
  if (error instanceof SubmissionUncertainError)
    console.error(
      'Acceptance is unknown. Keep the receipt; rerunning only looks up the original key. A missing job is not proof of rejection. Ask the operator to reconcile; never create a replacement submission.',
    );
  else if (error instanceof JobWaitTimeoutError)
    console.error(`Wait timed out. Resume existing job ${error.jobId} with this receipt.`);
  else console.error(error instanceof Error ? error.message : 'Example failed.');
  process.exitCode = 1;
}
