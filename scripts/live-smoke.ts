#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, stat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { Catalog, GenerateInput, Job, Quote, Source } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';

export const maxSmokeBudgetMicros = 50_000_000;
const prompt =
  'A simple red paper sailboat on still water, soft daylight, static camera, no lettering.';
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
export interface SmokeCase {
  routeId: string;
  modelId: string;
  deploymentId: string;
  adapter: string | null;
  input?: GenerateInput;
  estimateMicros: number | null;
  reserveMicros: number | null;
  state: 'ready' | 'blocked';
  reason: string | null;
  sources: Source[];
}
export interface SmokeEntry {
  routeId: string;
  input: GenerateInput;
  inputHash: string;
  idempotencyKey: string;
  estimateMicros: number;
  reserveMicros: number;
  actualCostMicros: number | null;
  phase: 'reserved' | 'submitting' | 'admission-unknown' | 'accepted';
  jobId?: string;
  upstreamId?: string | null;
  jobStatus?: Job['status'];
  deliveryStatus?: Job['deliveryStatus'];
  outputHashes?: string[];
  sources: Source[];
  createdAt: string;
  checkedAt?: string;
  /** Explicit review of unknown billing; never a settlement or permission to repeat this route. */
  billingHoldAcknowledgement?: {
    kind: 'retain-full-reservation';
    jobId: string;
    inputHash: string;
    reserveMicros: number;
    outputHashes: string[];
    acknowledgedAt: string;
  };
}
export interface SmokeReceipt {
  version: 1;
  server: string;
  workspaceId: string;
  budgetMicros: number;
  entries: SmokeEntry[];
}
const money = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const outputHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const deliveredGeneration = (entry: SmokeEntry) =>
  entry.phase === 'accepted' &&
  Boolean(entry.jobId) &&
  entry.jobStatus === 'succeeded' &&
  entry.deliveryStatus === 'available' &&
  entry.outputHashes?.length === (entry.input.input.count ?? 1) &&
  entry.outputHashes.every(outputHash);
const boundBillingHold = (entry: SmokeEntry) => {
  const acknowledgement = entry.billingHoldAcknowledgement;
  return Boolean(
    acknowledgement &&
    acknowledgement.kind === 'retain-full-reservation' &&
    acknowledgement.jobId === entry.jobId &&
    acknowledgement.inputHash === entry.inputHash &&
    acknowledgement.reserveMicros === entry.reserveMicros &&
    Array.isArray(acknowledgement.outputHashes) &&
    acknowledgement.outputHashes.length > 0 &&
    acknowledgement.outputHashes.every(outputHash) &&
    typeof acknowledgement.acknowledgedAt === 'string' &&
    Number.isFinite(Date.parse(acknowledgement.acknowledgedAt)),
  );
};
export const retainedBillingHold = (entry: SmokeEntry) =>
  entry.actualCostMicros === null &&
  deliveredGeneration(entry) &&
  boundBillingHold(entry) &&
  entry.billingHoldAcknowledgement!.outputHashes.length === entry.outputHashes!.length &&
  entry.billingHoldAcknowledgement!.outputHashes.every(
    (hash, index) => hash === entry.outputHashes![index],
  );
export function parseBudget(value: string): number {
  if (!/^\d+(\.\d{1,6})?$/.test(value))
    throw new Error('Budget must be USD with at most six decimal places.');
  const [dollars, fraction = ''] = value.split('.');
  const amount = Number(dollars) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!money(amount) || amount < 1 || amount > maxSmokeBudgetMicros)
    throw new Error('This smoke profile requires a positive budget of at most $50 total.');
  return amount;
}
export function validateServer(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error(
      'Use an HTTPS gateway origin, or a localhost HTTP origin, without credentials, path, query or fragment.',
    );
  return url.origin;
}
export const liabilityMicros = (receipt: SmokeReceipt) =>
  receipt.entries.reduce((sum, entry) => sum + (entry.actualCostMicros ?? entry.reserveMicros), 0);

/** Only explicit list-rate configurations are proposed. Price discovery never infers billing units. */
export function catalogSmokeCases(catalog: Catalog): SmokeCase[] {
  return catalog.routes
    .filter((route) => route.status !== 'retired')
    .map((route) => {
      const model = catalog.models.find((model) => model.id === route.modelId)!;
      const operation = model.modality === 'image' ? 'text-to-image' : 'text-to-video';
      const duration = model.modality === 'video' ? Math.min(...route.durations) : undefined;
      const priced = route.rates
        .filter(
          (rate) =>
            (!rate.operation || rate.operation === operation) &&
            route.resolutions.includes(rate.resolution),
        )
        .map((rate) => ({
          rate,
          estimate: rate.usdMicros * (rate.unit === 'output-second' ? duration! : 1),
        }))
        .filter((value) => money(value.estimate))
        .sort(
          (a, b) => a.estimate - b.estimate || a.rate.resolution.localeCompare(b.rate.resolution),
        );
      const price = priced[0];
      const input: GenerateInput | undefined =
        price && route.operations.includes(operation)
          ? {
              billing: 'managed',
              modelId: model.id,
              routeId: route.id,
              operation,
              input: {
                prompt,
                resolution: price.rate.resolution,
                ...(duration === undefined ? {} : { duration }),
              },
              routing: { fallback: false },
              maxCostMicros: price.estimate,
            }
          : undefined;
      const reason = !route.adapter
        ? 'No qualified adapter.'
        : !route.operations.includes(operation)
          ? 'Requires a separately reviewed reference/edit test input.'
          : !price
            ? 'No qualified request price; live submission blocked.'
            : null;
      return {
        routeId: route.id,
        modelId: route.modelId,
        deploymentId: route.deploymentId,
        adapter: route.adapter,
        input,
        estimateMicros: price?.estimate ?? null,
        // This is a conservative test-budget hold, never a guaranteed provider ceiling.
        reserveMicros: price ? Math.max(price.estimate * 2, price.estimate + 10_000) : null,
        state: reason ? 'blocked' : 'ready',
        reason,
        sources: [route.source, route.pricingSource],
      };
    });
}
export class SmokeApi {
  readonly server: string;
  constructor(
    server: string,
    private token?: string,
    private request: typeof fetch = fetch,
  ) {
    this.server = validateServer(server);
  }
  async json<T>(path: string, method = 'GET', body?: unknown, idempotencyKey?: string): Promise<T> {
    const response = await this.request(`${this.server}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `Gateway ${method} ${path.split('?')[0]} returned HTTP ${response.status}. Response bodies and credentials were not printed.`,
      );
    return (await response.json()) as T;
  }
}
export async function smokePlan(api: SmokeApi): Promise<SmokeCase[]> {
  const catalog = await api.json<Catalog>('/v1/catalog');
  const cases = catalogSmokeCases(catalog);
  for (const entry of cases) {
    if (entry.state !== 'ready' || !entry.input) continue;
    try {
      const quote = await api.json<Quote>('/v1/quotes', 'POST', entry.input);
      const selected = quote.candidates.find((candidate) => candidate.routeId === entry.routeId);
      if (
        !selected?.executable ||
        quote.selectedRouteId !== entry.routeId ||
        selected.estimatedCostMicros !== entry.estimateMicros
      ) {
        entry.state = 'blocked';
        entry.reason = selected?.reason ?? 'Gateway did not qualify this exact route and price.';
      }
    } catch {
      entry.state = 'blocked';
      entry.reason = 'Gateway could not quote this exact configuration.';
    }
  }
  return cases;
}
async function saveReceipt(path: string, receipt: SmokeReceipt) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
function checkedReceipt(
  value: unknown,
  server: string,
  workspaceId: string,
  budgetMicros: number,
): SmokeReceipt {
  const data = value as Partial<SmokeReceipt> & {
    authorized_usd?: number;
    spent_usd?: number;
    provider_requests?: unknown[];
  };
  // Import only the existing empty approval receipt; never discard recorded spend.
  if (
    data.version === undefined &&
    data.authorized_usd !== undefined &&
    data.spent_usd === 0 &&
    Array.isArray(data.provider_requests) &&
    data.provider_requests.length === 0
  ) {
    if (!money(data.authorized_usd * 1_000_000) || budgetMicros > data.authorized_usd * 1_000_000)
      throw new Error('Requested budget exceeds the saved authorization.');
    return { version: 1, server, workspaceId, budgetMicros, entries: [] };
  }
  if (
    data.version !== 1 ||
    data.server !== server ||
    data.workspaceId !== workspaceId ||
    data.budgetMicros !== budgetMicros ||
    !Array.isArray(data.entries)
  )
    throw new Error(
      'Receipt identity or budget differs. Never switch gateways, workspaces or budgets around an outstanding test.',
    );
  for (const entry of data.entries) {
    if (
      !money(entry.estimateMicros) ||
      !money(entry.reserveMicros) ||
      entry.reserveMicros < Math.max(entry.estimateMicros * 2, entry.estimateMicros + 10_000) ||
      (entry.actualCostMicros !== null && !money(entry.actualCostMicros)) ||
      !entry.input ||
      !entry.idempotencyKey ||
      entry.inputHash !== hashInput(entry.input)
    )
      throw new Error('Receipt is invalid; reconcile it before testing.');
    if (entry.billingHoldAcknowledgement !== undefined && !boundBillingHold(entry))
      throw new Error('Billing hold acknowledgement does not match its original receipt entry.');
  }
  return data as SmokeReceipt;
}

/** Extension entries retain their original observer; this runner never rebinds them. */
function assertObserverAuthority(value: unknown, server: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Receipt is invalid; reconcile it before testing.');
  const receipt = value as Partial<SmokeReceipt>;
  if (receipt.version === 1 && receipt.server !== server)
    throw new Error('Receipt identity or budget differs. Use its original gateway.');
  if (!Array.isArray(receipt.entries)) {
    if (receipt.version === 1) throw new Error('Receipt is invalid; reconcile it before testing.');
    return; // Legacy empty approvals are validated after authenticating the native workspace.
  }
  for (const entry of receipt.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Receipt is invalid; reconcile it before testing.');
    const metadata = entry as unknown as Record<string, unknown>;
    const client = Object.hasOwn(entry, 'clientQualification');
    const provider = Object.hasOwn(entry, 'providerQualification');
    if (!client && !provider) continue;
    const provenance =
      client !== provider
        ? metadata[client ? 'clientQualification' : 'providerQualification']
        : undefined;
    let native = false;
    if (provenance && typeof provenance === 'object' && !Array.isArray(provenance)) {
      const { gateway, workspaceId } = provenance as Record<string, unknown>;
      try {
        native =
          receipt.version === 1 &&
          typeof gateway === 'string' &&
          validateServer(gateway) === gateway &&
          gateway === receipt.server &&
          typeof workspaceId === 'string' &&
          /^[a-zA-Z0-9_-]{1,80}$/.test(workspaceId) &&
          workspaceId === receipt.workspaceId;
      } catch {
        // Never echo private origins, workspaces or malformed metadata in errors.
      }
    }
    if (!native)
      throw new Error(
        'Foreign or malformed entry observer authority. Use its owning coordinator; no observer request was made.',
      );
  }
}
export const hashInput = (input: GenerateInput) =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');
const jobMatches = (entry: SmokeEntry, job: Job) => {
  try {
    const saved = parseGenerationRequest(entry.input);
    const returned = parseGenerationRequest(job.input);
    // The gateway may legitimately narrow routing policy or spending limits. Those
    // admission controls do not change the immutable canonical generation arguments.
    return (
      job.routeId === entry.routeId &&
      saved.routeId === entry.routeId &&
      (returned.routeId ?? job.routeId) === entry.routeId &&
      returned.modelId === saved.modelId &&
      returned.operation === saved.operation &&
      (returned.billing ?? 'managed') === (saved.billing ?? 'managed') &&
      isDeepStrictEqual(returned.input, saved.input)
    );
  } catch {
    return false;
  }
};
async function refreshEntry(
  api: SmokeApi,
  receipt: SmokeReceipt,
  entry: SmokeEntry,
  path: string,
  skipBilling = false,
) {
  if (!entry.jobId && ['submitting', 'admission-unknown'].includes(entry.phase)) {
    const jobs = await api.json<Job[]>('/v1/generations');
    const matches = jobs.filter((job) => jobMatches(entry, job));
    if (matches.length === 1) {
      entry.jobId = matches[0]!.id;
      entry.phase = 'accepted';
    } else {
      entry.phase = 'admission-unknown';
      await saveReceipt(path, receipt);
      return;
    }
  }
  if (!entry.jobId) return;
  const job = await api.json<Job>(`/v1/generations/${encodeURIComponent(entry.jobId)}`);
  if (!jobMatches(entry, job))
    throw new Error('Returned job does not match the privately recorded test.');
  entry.upstreamId = job.upstreamId;
  entry.jobStatus = job.status;
  entry.deliveryStatus = job.deliveryStatus;
  entry.outputHashes = job.outputs.every((output) => outputHash(output.sha256))
    ? job.outputs.map((output) => output.sha256!)
    : [];
  entry.checkedAt = new Date().toISOString();
  if (terminal.has(job.status) && !skipBilling) {
    const ledger = await api.json<{
      data: { job_id?: string; kind?: string; details?: { upstreamCostMicros?: unknown } }[];
    }>('/v1/ledger');
    const settlement = ledger.data.find((row) => row.job_id === job.id && row.kind === 'settle');
    // A capped customer debit or BYOK's zero local charge is NOT actual upstream spend.
    if (money(settlement?.details?.upstreamCostMicros))
      entry.actualCostMicros = settlement.details.upstreamCostMicros;
  }
  await saveReceipt(path, receipt);
}
export interface ExecuteOptions {
  receiptPath: string;
  budgetMicros: number;
  routeId?: string;
  resume?: boolean;
  acceptEstimateRisk: boolean;
  waitMs?: number;
  retainBillingHoldJobId?: string;
}
export async function executeSmoke(api: SmokeApi, options: ExecuteOptions): Promise<SmokeReceipt> {
  if (
    options.retainBillingHoldJobId !== undefined &&
    (!options.resume ||
      options.routeId !== undefined ||
      options.acceptEstimateRisk ||
      options.waitMs !== undefined ||
      !options.retainBillingHoldJobId.trim() ||
      options.retainBillingHoldJobId.length > 200)
  )
    throw new Error(
      'Retain a billing hold only with --resume and its exact job ID, without execution, route, wait or estimate-risk flags.',
    );
  if (!options.resume && !options.acceptEstimateRisk)
    throw new Error(
      'Quotes are estimates, not provider spending ceilings. Obtain review and explicitly pass --accept-estimate-risk before execution.',
    );
  if (
    !money(options.budgetMicros) ||
    options.budgetMicros < 1 ||
    options.budgetMicros > maxSmokeBudgetMicros
  )
    throw new Error('A budget of at most $50 total is required.');
  if (!isAbsolute(options.receiptPath))
    throw new Error('Use an absolute private receipt path outside the repository.');
  if (!options.resume && !options.routeId)
    throw new Error('Select exactly one --route for each live invocation.');
  const waitMs = options.waitMs ?? 0;
  if (!money(waitMs) || waitMs > 60_000) throw new Error('Wait must be 0–60000 milliseconds.');
  await mkdir(dirname(options.receiptPath), { recursive: true, mode: 0o700 });
  const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  const receiptDirectory = await realpath(dirname(options.receiptPath));
  if (receiptDirectory === project || receiptDirectory.startsWith(project + sep))
    throw new Error('Keep smoke receipts outside the source repository.');
  const lockPath = `${options.receiptPath}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw new Error(
      'The smoke receipt is locked. Confirm no smoke process is running before removing a stale lock.',
    );
  });
  try {
    let savedReceipt: unknown;
    try {
      const metadata = await stat(options.receiptPath);
      if ((metadata.mode & 0o077) !== 0)
        throw new Error('Smoke receipt must be owner-readable/writable only (chmod 600).');
      savedReceipt = JSON.parse(await readFile(options.receiptPath, 'utf8'));
      assertObserverAuthority(savedReceipt, api.server);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const session = await api.json<{
      authenticated: boolean;
      workspaceId?: string;
      scopes?: string[];
    }>('/v1/session');
    if (
      !session.authenticated ||
      !session.workspaceId ||
      !(options.resume ? ['read'] : ['read', 'generate']).every((scope) =>
        session.scopes?.includes(scope),
      )
    )
      throw new Error(
        'Use a gateway key with read scope, plus generate scope for new tests. Provider keys stay on the server.',
      );
    const receipt: SmokeReceipt =
      savedReceipt === undefined
        ? {
            version: 1,
            server: api.server,
            workspaceId: session.workspaceId,
            budgetMicros: options.budgetMicros,
            entries: [],
          }
        : checkedReceipt(savedReceipt, api.server, session.workspaceId, options.budgetMicros);
    // Refresh/read-only recovery always precedes admission of another billable request.
    for (const entry of receipt.entries)
      if (entry.actualCostMicros === null)
        await refreshEntry(
          api,
          receipt,
          entry,
          options.receiptPath,
          boundBillingHold(entry) ||
            (options.retainBillingHoldJobId !== undefined &&
              entry.jobId === options.retainBillingHoldJobId),
        );
    if (liabilityMicros(receipt) > receipt.budgetMicros)
      throw new Error(
        'Reported upstream spend exceeded the test budget. No additional test was submitted.',
      );
    if (options.retainBillingHoldJobId !== undefined) {
      const matches = receipt.entries.filter(
        (entry) => entry.jobId === options.retainBillingHoldJobId,
      );
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry || entry.actualCostMicros !== null || !deliveredGeneration(entry))
        throw new Error(
          'A retained billing hold requires one accepted, succeeded job with available delivery and all archived output hashes; actual billing must remain unknown.',
        );
      entry.billingHoldAcknowledgement = {
        kind: 'retain-full-reservation',
        jobId: entry.jobId!,
        inputHash: entry.inputHash,
        reserveMicros: entry.reserveMicros,
        outputHashes: [...entry.outputHashes!],
        acknowledgedAt: new Date().toISOString(),
      };
      await saveReceipt(options.receiptPath, receipt);
      return receipt;
    }
    if (options.resume) return receipt;
    if (
      receipt.entries.some(
        (entry) => entry.actualCostMicros === null && !retainedBillingHold(entry),
      )
    )
      throw new Error(
        'An earlier test remains unsubmitted, unresolved or unsettled. Resume/reconcile it before another paid test.',
      );
    if (receipt.entries.some((entry) => entry.routeId === options.routeId))
      throw new Error('This route already has a test receipt; do not accidentally repeat it.');
    const entry = (await smokePlan(api)).find((entry) => entry.routeId === options.routeId);
    if (
      !entry ||
      entry.state !== 'ready' ||
      !entry.input ||
      entry.reserveMicros === null ||
      entry.estimateMicros === null
    )
      throw new Error('The selected route has no executable, source-priced smoke configuration.');
    if (liabilityMicros(receipt) + entry.reserveMicros > receipt.budgetMicros)
      throw new Error('Insufficient remaining test budget, including unresolved holds.');
    const input: GenerateInput = {
      ...entry.input,
      input: { ...entry.input.input, prompt: `${prompt} Smoke reference ${randomUUID()}.` },
    };
    const saved: SmokeEntry = {
      routeId: entry.routeId,
      input,
      inputHash: hashInput(input),
      idempotencyKey: `opengen-smoke-${randomUUID()}`,
      estimateMicros: entry.estimateMicros,
      reserveMicros: entry.reserveMicros,
      actualCostMicros: null,
      phase: 'reserved',
      sources: entry.sources,
      createdAt: new Date().toISOString(),
    };
    receipt.entries.push(saved);
    await saveReceipt(options.receiptPath, receipt);
    saved.phase = 'submitting';
    await saveReceipt(options.receiptPath, receipt); // Write intent before the only billable HTTP request.
    try {
      const job = await api.json<Job>('/v1/generations', 'POST', saved.input, saved.idempotencyKey);
      if (!jobMatches(saved, job)) throw new Error('Admission returned an unexpected job.');
      saved.jobId = job.id;
      saved.upstreamId = job.upstreamId;
      saved.jobStatus = job.status;
      saved.phase = 'accepted';
      await saveReceipt(options.receiptPath, receipt);
    } catch {
      saved.phase = 'admission-unknown';
      await saveReceipt(options.receiptPath, receipt);
      // No POST retry, no hold release, no raw error/response body in logs.
      return receipt;
    }
    const deadline = Date.now() + waitMs;
    do {
      await refreshEntry(api, receipt, saved, options.receiptPath);
      if (
        saved.actualCostMicros !== null ||
        saved.jobStatus === 'submission-unknown' ||
        Date.now() >= deadline
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
    } while (Date.now() < deadline);
    return receipt;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
export function automaticSmokeResult(entry: SmokeEntry): 'passed' | 'failed' | 'pending' {
  if (
    ['failed', 'cancelled'].includes(entry.jobStatus ?? '') ||
    ['failed', 'partial'].includes(entry.deliveryStatus ?? '')
  )
    return 'failed';
  return entry.phase === 'accepted' &&
    entry.jobStatus === 'succeeded' &&
    entry.deliveryStatus === 'available' &&
    entry.actualCostMicros !== null &&
    Boolean(entry.outputHashes?.length)
    ? 'passed'
    : 'pending';
}
const summary = (receipt: SmokeReceipt) => ({
  server: receipt.server,
  budgetMicros: receipt.budgetMicros,
  accountedMicros: liabilityMicros(receipt),
  entries: receipt.entries.map((entry) => ({
    routeId: entry.routeId,
    automaticResult: automaticSmokeResult(entry),
    phase: entry.phase,
    jobId: entry.jobId,
    upstreamId: entry.upstreamId,
    status: entry.jobStatus,
    deliveryStatus: entry.deliveryStatus,
    actualCostMicros: entry.actualCostMicros,
    heldMicros: entry.actualCostMicros === null ? entry.reserveMicros : 0,
    billingHoldAcknowledged: retainedBillingHold(entry),
  })),
});
export async function main(args: string[]) {
  const known = new Set([
    '--server',
    '--receipt',
    '--budget',
    '--route',
    '--wait-ms',
    '--retain-billing-hold',
    '--execute',
    '--resume',
    '--accept-estimate-risk',
    '--help',
  ]);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (!known.has(name) || values.has(name) || flags.has(name))
      throw new Error('Unknown or repeated option. Use --help.');
    if (['--execute', '--resume', '--accept-estimate-risk', '--help'].includes(name))
      flags.add(name);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}.`);
      values.set(name, value);
    }
  }
  if (flags.has('--execute') && flags.has('--resume'))
    throw new Error('Choose execution or resume, never both.');
  if (
    values.has('--retain-billing-hold') &&
    (!flags.has('--resume') ||
      flags.has('--execute') ||
      flags.has('--accept-estimate-risk') ||
      values.has('--route') ||
      values.has('--wait-ms'))
  )
    throw new Error(
      'Use --resume --retain-billing-hold <exact-job-id> without execution, route, wait or estimate-risk flags.',
    );
  if (flags.has('--help')) {
    console.log(
      "OpenGen live smoke — plan is read-only.\nPlan: node --import tsx scripts/live-smoke.ts [--server http://127.0.0.1:4310]\nExecute one reviewed case: add --execute --route <exact-id> --budget 50 --receipt /absolute/private/receipt.json --accept-estimate-risk\nRead-only resume: --resume --budget 50 --receipt /absolute/private/receipt.json\nRetain a reviewed successful job's full unresolved billing hold: --resume --retain-billing-hold <exact-job-id> --budget 50 --receipt /absolute/private/receipt.json (no new generation; billing remains pending).\nMEDIA_ROUTER_TOKEN is the private gateway key (read+generate). Provider keys remain server-side. No automatic POST retries; unresolved admission blocks later tests. Unsettled billing blocks unless its delivered job has an explicitly reviewed retained full hold.",
    );
    return;
  }
  const api = new SmokeApi(
    values.get('--server') ?? process.env.MEDIA_ROUTER_URL ?? 'http://127.0.0.1:4310',
    process.env.MEDIA_ROUTER_TOKEN,
  );
  if (!flags.has('--execute') && !flags.has('--resume')) {
    console.log(
      JSON.stringify(
        {
          mode: 'read-only-plan',
          estimateWarning:
            'Estimates are not guaranteed provider ceilings. Unknown prices are blocked.',
          cases: (await smokePlan(api)).map(({ input: _input, ...entry }) => entry),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!values.has('--budget') || !values.has('--receipt'))
    throw new Error('Explicit --budget and --receipt are required.');
  const receipt = await executeSmoke(api, {
    receiptPath: values.get('--receipt')!,
    budgetMicros: parseBudget(values.get('--budget')!),
    routeId: values.get('--route'),
    resume: flags.has('--resume'),
    acceptEstimateRisk: flags.has('--accept-estimate-risk'),
    ...(values.has('--wait-ms') ? { waitMs: Number(values.get('--wait-ms')) } : {}),
    ...(values.has('--retain-billing-hold')
      ? { retainBillingHoldJobId: values.get('--retain-billing-hold')! }
      : {}),
  });
  console.log(JSON.stringify(summary(receipt), null, 2));
  if (receipt.entries.some((entry) => automaticSmokeResult(entry) === 'failed'))
    process.exitCode = 1;
  else if (
    !receipt.entries.length ||
    receipt.entries.some((entry) => automaticSmokeResult(entry) !== 'passed') ||
    liabilityMicros(receipt) > receipt.budgetMicros
  )
    process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Live smoke stopped. Use --help or inspect the private receipt; no response bodies or credentials were printed.',
    );
    process.exitCode = 1;
  });
}
