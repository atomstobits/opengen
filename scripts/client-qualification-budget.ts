/** Shared-budget coordinators for the fixed client and hosted-provider cohorts.
 * No command entry point or provider transport. Callbacks use the native gateway;
 * actual-client qualification still requires the named actual client.
 */
import { constants } from 'node:fs';
import { open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { GenerateInput, Job, Quote } from '@media-router/contracts';
import { parseGenerationRequest } from '@media-router/contracts/generation';
import { catalog } from '@media-router/catalog';
import {
  hashInput,
  liabilityMicros,
  validateServer,
  type SmokeEntry,
  type SmokeReceipt,
} from './live-smoke';

export const qualificationScope = 'opengen-onboarding-two-clients-2026-11-04';
export const qualificationRoute = 'alibaba/ap-southeast-1/wan-3.0';
export const providerQualificationScope = 'opengen-hosted-providers-2026-11-06';
const providerGateway = 'https://opengen.dev';
const providerCases = {
  'wan-standard-text': { model: 'alibaba/wan-3.0', operation: 'text-to-video', estimate: 100_000 },
  'wan-prime-text': {
    model: 'alibaba/wan-3.0-prime',
    operation: 'text-to-video',
    estimate: 136_000,
  },
  'wan-prime-image': {
    model: 'alibaba/wan-3.0-prime',
    operation: 'image-to-video',
    estimate: 136_000,
  },
} as const;
type ProviderCase = keyof typeof providerCases;
const ceiling = 50_000_000;
const estimate = 100_000;
const reserve = 200_000;
type ClientCase = 'hosted-assistant' | 'local-coding-agent';
type HoldAcknowledgement = {
  kind: 'retain-full-reservation';
  jobId: string;
  inputHash: string;
  reserveMicros: number;
  outputHashes: string[];
  acknowledgedAt: string;
};
type Entry = SmokeEntry & {
  billingHoldAcknowledgement?: HoldAcknowledgement;
  historicalObservation?: {
    kind: 'original-native-gateway' | 'original-datastore-snapshot';
    snapshotSha256?: string;
    observedAt: string;
  };
  clientQualification?: {
    scope: typeof qualificationScope;
    case: ClientCase;
    client: { name: string; version: string; date: string };
    gateway: string;
    workspaceId: string;
  };
  providerQualification?: {
    scope: typeof providerQualificationScope;
    case: ProviderCase;
    gateway: typeof providerGateway;
    workspaceId: string;
    apiSource: string;
    workerSource: string;
  };
};
type Journal = Omit<SmokeReceipt, 'entries'> & { entries: Entry[] };
export type HistoricalObservation = {
  /** Original authority provenance, not an assertion of an HTTP request. */
  gateway: string;
  evidence:
    | { kind: 'original-native-gateway' }
    | { kind: 'original-datastore-snapshot'; snapshotSha256: string };
  job: Pick<Job, 'id' | 'workspaceId' | 'routeId' | 'input' | 'status' | 'deliveryStatus'> & {
    outputs: { sha256?: string; storageKey?: string; mediaType?: string; byteLength?: number }[];
  };
};
export type QualificationObservation = {
  gateway: string;
  job: Job;
  settlement: null | {
    kind: 'settle';
    jobId: string;
    workspaceId: string;
    source: 'ledger.details.upstreamCostMicros';
    upstreamCostMicros: number;
  };
};

const money = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function fail(message: string): never {
  throw new Error(message);
}

function validateJournal(value: unknown): Journal {
  const receipt = value as Journal;
  if (
    !receipt ||
    receipt.version !== 1 ||
    receipt.budgetMicros !== ceiling ||
    typeof receipt.server !== 'string' ||
    validateServer(receipt.server) !== receipt.server ||
    typeof receipt.workspaceId !== 'string' ||
    !receipt.workspaceId ||
    !Array.isArray(receipt.entries)
  )
    fail(
      'Use the existing version-one shared USD50 authority. Never initialize or rebind a journal.',
    );
  for (const entry of receipt.entries) {
    if (
      !entry.input ||
      entry.inputHash !== hashInput(entry.input) ||
      !entry.idempotencyKey ||
      !money(entry.estimateMicros) ||
      !money(entry.reserveMicros) ||
      entry.reserveMicros < Math.max(entry.estimateMicros * 2, entry.estimateMicros + 10_000) ||
      (entry.actualCostMicros !== null && !money(entry.actualCostMicros))
    )
      fail('Existing journal evidence is invalid; reconcile without discarding history.');
    // Historical requests use their original canonical schema/price snapshot.
    // Do not reinterpret them using this checkout's newer model defaults.
    if (entry.clientQualification && entry.clientQualification.scope !== qualificationScope)
      fail('An unrecognized client cohort must be reviewed before further admission.');
    if (Object.hasOwn(entry, 'providerQualification')) {
      const cohort = entry.providerQualification;
      if (
        !cohort ||
        entry.clientQualification ||
        cohort.scope !== providerQualificationScope ||
        !Object.hasOwn(providerCases, cohort.case) ||
        cohort.gateway !== providerGateway ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(cohort.workspaceId) ||
        !/^[a-f0-9]{40}$/.test(cohort.apiSource) ||
        !/^[a-f0-9]{40}$/.test(cohort.workerSource)
      )
        fail('Invalid hosted provider cohort or observer authority.');
      const selected = providerCases[cohort.case];
      if (
        entry.input.modelId !== selected.model ||
        entry.input.operation !== selected.operation ||
        entry.routeId !== `alibaba/ap-southeast-1/${selected.model.split('/')[1]}` ||
        entry.estimateMicros !== selected.estimate ||
        entry.reserveMicros !== selected.estimate * 2
      )
        fail('Recorded hosted provider case differs from its reviewed scope.');
    }
  }
  if (!money(liabilityMicros(receipt))) fail('Invalid aggregate budget.');
  return receipt;
}
function retained(entry: Entry) {
  const acknowledgement = entry.billingHoldAcknowledgement;
  return (
    entry.actualCostMicros === null &&
    entry.phase === 'accepted' &&
    Boolean(entry.jobId) &&
    entry.jobStatus === 'succeeded' &&
    entry.deliveryStatus === 'available' &&
    entry.outputHashes?.length === (entry.input.input.count ?? 1) &&
    entry.outputHashes.every((hash) => /^[a-f0-9]{64}$/i.test(hash)) &&
    acknowledgement?.kind === 'retain-full-reservation' &&
    acknowledgement.jobId === entry.jobId &&
    acknowledgement.inputHash === entry.inputHash &&
    acknowledgement.reserveMicros === entry.reserveMicros &&
    Number.isFinite(Date.parse(acknowledgement.acknowledgedAt)) &&
    equal(acknowledgement.outputHashes, entry.outputHashes)
  );
}
async function locked<T>(
  path: string,
  expectedSha256: string,
  use: (receipt: Journal, save: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(expectedSha256))
    fail('Supply the exact existing private journal and reviewed SHA256.');
  const parent = dirname(path);
  if ((await realpath(parent)) !== parent || (await realpath(path)) !== path)
    fail('Journal paths must be real files/directories without symlinks.');
  const project = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  if (path.startsWith(project + '/')) fail('Keep private journal evidence outside source.');
  const lockPath = path + '.lock';
  const lock = await open(
    lockPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ).catch(() =>
    fail('The shared journal is locked. Never remove a lock until its owner is confirmed stopped.'),
  );
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 1_000_000 || (metadata.mode & 0o077) !== 0)
        fail('The existing journal must be bounded, regular and private (0600).');
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    if (bytes.length > 1_000_000 || sha256(bytes) !== expectedSha256)
      fail(
        'Shared accounting changed since review. Reconcile the current journal before admission.',
      );
    const receipt = validateJournal(JSON.parse(bytes.toString()));
    const save = async () => {
      const temporary = `${path}.${randomUUID()}.next`;
      const output = await open(temporary, 'wx', 0o600);
      try {
        await output.writeFile(JSON.stringify(receipt, null, 2) + '\n');
        await output.sync();
      } finally {
        await output.close();
      }
      try {
        await rename(temporary, path);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      const directory = await open(parent, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    };
    return await use(receipt, save);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
function requestForCase(input: GenerateInput, workspaceId: string) {
  const parsed = parseGenerationRequest(input);
  const args = parsed.input;
  const allowed = new Set([
    'prompt',
    'firstFrame',
    'duration',
    'resolution',
    'aspectRatio',
    'count',
  ]);
  const rate = catalog.routes
    .find((route) => route.id === qualificationRoute)
    ?.rates.find(
      (rate) =>
        rate.operation === 'image-to-video' &&
        rate.resolution === '480p' &&
        rate.unit === 'output-second',
    );
  if (
    parsed.routeId !== qualificationRoute ||
    parsed.modelId !== 'alibaba/wan-3.0' ||
    parsed.operation !== 'image-to-video' ||
    parsed.billing !== 'managed' ||
    parsed.maxCostMicros !== estimate ||
    args.duration !== 2 ||
    args.resolution !== '480p' ||
    args.aspectRatio !== 'source' ||
    (args.count ?? 1) !== 1 ||
    !args.firstFrame ||
    !('assetKey' in args.firstFrame) ||
    !args.firstFrame.assetKey?.startsWith(`inputs/${workspaceId}/`) ||
    Object.keys(args).some((field) => !allowed.has(field)) ||
    !equal(parsed.routing, { fallback: false }) ||
    !rate ||
    rate.usdMicros * 2 !== estimate
  )
    fail(
      'Only the reviewed two-second 480p Singapore owned-first-frame managed case is approved. Requote any change.',
    );
  return parsed;
}
function matches(entry: Entry, job: Job) {
  const origin = entry.clientQualification ?? entry.providerQualification;
  if (!origin) return false;
  try {
    const { maxCostMicros: requestedCap, ...requested } = entry.input;
    const { maxCostMicros: acceptedCap, ...accepted } = parseGenerationRequest(job.input);
    return (
      job.workspaceId === origin.workspaceId &&
      job.routeId === entry.routeId &&
      (!entry.providerQualification ||
        job.deploymentId === 'alibaba-model-studio-ap-southeast-1') &&
      typeof acceptedCap === 'number' &&
      acceptedCap <= requestedCap! &&
      isDeepStrictEqual(accepted, requested) &&
      /^[a-f0-9-]{36}$/i.test(job.id)
    );
  } catch {
    return false;
  }
}
function historicalMatches(
  entry: Entry,
  observation: HistoricalObservation,
  origin: string,
  workspaceId: string,
) {
  const job = observation.job;
  return (
    (observation.evidence?.kind === 'original-native-gateway' ||
      (observation.evidence?.kind === 'original-datastore-snapshot' &&
        /^[a-f0-9]{64}$/.test(observation.evidence.snapshotSha256))) &&
    observation.gateway === origin &&
    job.id === entry.jobId &&
    job.workspaceId === workspaceId &&
    job.routeId === entry.routeId &&
    job.input.modelId === entry.input.modelId &&
    job.input.operation === entry.input.operation &&
    (job.input.billing ?? 'managed') === (entry.input.billing ?? 'managed') &&
    Object.entries(entry.input.input).every(([field, value]) =>
      isDeepStrictEqual((job.input.input as Record<string, unknown>)[field], value),
    )
  );
}

export interface ClientQualificationOptions {
  receiptPath: string;
  expectedReceiptSha256: string;
  /** Explicit existing authority, never the new gateway identity. */
  authority: { server: string; workspaceId: string };
  case: ClientCase;
  client: { name: string; version: string; date: string };
  gateway: string;
  workspaceId: string;
  input: GenerateInput;
  quote: Quote;
  approved: true;
  /** Read-only original gateway or authenticated original-datastore snapshot evidence; no provider billing requests. */
  observeHistorical(
    entry: Readonly<SmokeEntry>,
    origin: string,
    workspaceId: string,
  ): Promise<HistoricalObservation>;
}
/** Holds and intent are fsynced under the original lock before invoking one submit callback.
 * An exception never invokes the callback again, releases a hold, switches a key or replaces a job.
 */
export async function runClientQualification(
  options: ClientQualificationOptions,
  submitOnce: (admission: { input: GenerateInput; idempotencyKey: string }) => Promise<Job>,
) {
  if (
    options.approved !== true ||
    !['hosted-assistant', 'local-coding-agent'].includes(options.case) ||
    !options.client.name.trim() ||
    !options.client.version.trim() ||
    !/^\d{4}-\d{2}-\d{2}$/.test(options.client.date)
  )
    fail('Explicit approval and exact named client/version/date are required.');
  const gateway = validateServer(options.gateway);
  const input = requestForCase(options.input, options.workspaceId);
  const quoted = options.quote.candidates.find(
    (candidate) => candidate.routeId === qualificationRoute,
  );
  if (
    options.quote.modelId !== input.modelId ||
    options.quote.operation !== input.operation ||
    options.quote.selectedRouteId !== qualificationRoute ||
    options.quote.reservationMicros !== estimate ||
    quoted?.executable !== true ||
    quoted.estimatedCostMicros !== estimate
  )
    fail(
      'Obtain an executable quote for this exact request and paying workspace before admission.',
    );
  return locked(options.receiptPath, options.expectedReceiptSha256, async (receipt, save) => {
    if (
      receipt.server !== options.authority.server ||
      receipt.workspaceId !== options.authority.workspaceId
    )
      fail('Original journal authority does not match; never rebind it to a new gateway.');
    if (
      receipt.entries.some(
        (entry) => entry.actualCostMicros !== null && entry.actualCostMicros > entry.reserveMicros,
      )
    )
      fail(
        'An upstream cost exceeded its reviewed reservation. Preserve the recorded charge and review the overrun before another client admission.',
      );
    const cohort = receipt.entries.filter((entry) => entry.clientQualification);
    if (
      cohort.length >= 2 ||
      cohort.some((entry) => entry.clientQualification!.case === options.case)
    )
      fail(
        'This fixed two-client cohort already contains that case. Resume the recorded admission; never replace it.',
      );
    for (const entry of receipt.entries) {
      if (entry.actualCostMicros !== null) continue;
      if (entry.clientQualification)
        fail('An earlier client admission needs read-only reconciliation before a second case.');
      const observation = await options.observeHistorical(
        structuredClone(entry),
        receipt.server,
        receipt.workspaceId,
      );
      if (!historicalMatches(entry, observation, receipt.server, receipt.workspaceId))
        fail('Historical observer must match the original gateway, workspace, job and input.');
      const observed: Entry = {
        ...entry,
        jobStatus: observation.job.status,
        deliveryStatus: observation.job.deliveryStatus,
        outputHashes: observation.job.outputs.flatMap((output) =>
          output.sha256 ? [output.sha256] : [],
        ),
      };
      if (!retained(observed))
        fail('Historical unresolved evidence blocks new work; preserve its full hold.');
      // Historical unknown charges and their complete reservations are immutable here.
      // Reconciliation of those provider costs belongs to the original workstream.
      entry.jobStatus = observed.jobStatus;
      entry.deliveryStatus = observed.deliveryStatus;
      entry.outputHashes = observed.outputHashes;
      entry.checkedAt = new Date().toISOString();
      entry.historicalObservation = { ...observation.evidence, observedAt: entry.checkedAt };
      await save();
    }
    if (liabilityMicros(receipt) + reserve > ceiling)
      fail('Insufficient shared budget including all retained holds.');
    const entry: Entry = {
      routeId: qualificationRoute,
      input,
      inputHash: hashInput(input),
      idempotencyKey: `opengen-client-${randomUUID()}`,
      estimateMicros: estimate,
      reserveMicros: reserve,
      actualCostMicros: null,
      phase: 'reserved',
      sources: [catalog.routes.find((route) => route.id === qualificationRoute)!.pricingSource],
      createdAt: new Date().toISOString(),
      clientQualification: {
        scope: qualificationScope,
        case: options.case,
        client: { ...options.client },
        gateway,
        workspaceId: options.workspaceId,
      },
    };
    receipt.entries.push(entry);
    await save();
    entry.phase = 'submitting';
    await save();
    try {
      const job = await submitOnce({
        input: structuredClone(input),
        idempotencyKey: entry.idempotencyKey,
      });
      if (!matches(entry, job))
        fail('Client admission response did not match the recorded native request.');
      entry.phase = 'accepted';
      entry.jobId = job.id;
      entry.upstreamId = job.upstreamId;
      entry.jobStatus = job.status;
      entry.deliveryStatus = job.deliveryStatus;
      await save();
    } catch {
      entry.phase = 'admission-unknown';
      await save();
    }
    return {
      scope: qualificationScope,
      case: options.case,
      phase: entry.phase,
      jobId: entry.jobId ?? null,
      accountedMicros: liabilityMicros(receipt),
      retainedMicros: reserve,
      paidResubmissionAllowed: false as const,
    };
  });
}
function applyObservation(
  entry: Entry,
  result: QualificationObservation,
  gateway: string,
  workspaceId: string,
) {
  if (!Object.hasOwn(result, 'settlement'))
    fail('Linked upstream-cost settlement evidence is required; unknown remains null.');
  const settlement = result.settlement;
  if (
    result.gateway !== gateway ||
    !matches(entry, result.job) ||
    (entry.jobId && entry.jobId !== result.job.id) ||
    (entry.upstreamId && entry.upstreamId !== result.job.upstreamId) ||
    (settlement !== null &&
      (settlement.kind !== 'settle' ||
        settlement.jobId !== result.job.id ||
        settlement.workspaceId !== workspaceId ||
        settlement.source !== 'ledger.details.upstreamCostMicros' ||
        !money(settlement.upstreamCostMicros)))
  )
    fail('Existing job or linked upstream-cost settlement evidence differs.');
  const terminalJob = ['succeeded', 'failed', 'cancelled'].includes(result.job.status);
  if (!terminalJob && (settlement !== null || entry.actualCostMicros !== null))
    fail(
      'A terminal native job is required before accepting settlement or releasing its full hold. Nonterminal acceptance and billing remain unresolved.',
    );
  const actualCostMicros = settlement?.upstreamCostMicros ?? null;
  entry.phase = 'accepted';
  entry.jobId = result.job.id;
  entry.upstreamId = result.job.upstreamId;
  entry.jobStatus = result.job.status;
  entry.deliveryStatus = result.job.deliveryStatus;
  entry.outputHashes = result.job.outputs.flatMap((output) =>
    output.sha256 ? [output.sha256] : [],
  );
  if (
    entry.actualCostMicros !== null &&
    actualCostMicros !== null &&
    entry.actualCostMicros !== actualCostMicros
  )
    fail(
      'A previously reconciled charge requires separate reviewed correction; never silently release budget.',
    );
  if (actualCostMicros !== null) entry.actualCostMicros = actualCostMicros;
  entry.checkedAt = new Date().toISOString();
}

/** Read-only recovery/settlement. Caller retrieves the existing native job/key only. */
export async function reconcileClientQualification(
  options: Pick<
    ClientQualificationOptions,
    'receiptPath' | 'expectedReceiptSha256' | 'authority' | 'case' | 'gateway' | 'workspaceId'
  >,
  observe: (entry: Readonly<SmokeEntry>) => Promise<QualificationObservation>,
) {
  return locked(options.receiptPath, options.expectedReceiptSha256, async (receipt, save) => {
    if (
      receipt.server !== options.authority.server ||
      receipt.workspaceId !== options.authority.workspaceId
    )
      fail('Original journal authority differs.');
    const entries = receipt.entries.filter(
      (entry) => entry.clientQualification?.case === options.case,
    );
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (
      !entry ||
      entry.clientQualification!.gateway !== validateServer(options.gateway) ||
      entry.clientQualification!.workspaceId !== options.workspaceId
    )
      fail('Recorded client admission not found for this exact gateway/workspace.');
    const result = await observe(structuredClone(entry));
    applyObservation(entry, result, entry.clientQualification!.gateway, options.workspaceId);
    await save();
    return {
      phase: entry.phase,
      jobId: entry.jobId,
      accountedMicros: liabilityMicros(receipt),
      overBudget: liabilityMicros(receipt) > ceiling,
      reservationExceeded:
        entry.actualCostMicros !== null && entry.actualCostMicros > entry.reserveMicros,
      paidResubmissionAllowed: false as const,
    };
  });
}

export interface ProviderQualificationOptions {
  receiptPath: string;
  expectedReceiptSha256: string;
  authority: { server: string; workspaceId: string };
  case: ProviderCase;
  gateway: string;
  workspaceId: string;
  apiSource: string;
  workerSource: string;
  input: GenerateInput;
  quote: Quote;
  approved: true;
  acceptEstimateRisk: true;
  observeHistorical: ClientQualificationOptions['observeHistorical'];
  /** Observe each hosted entry using its own frozen gateway/workspace, never the original observer. */
  observeQualified(
    entry: Readonly<SmokeEntry>,
    gateway: string,
    workspaceId: string,
  ): Promise<QualificationObservation>;
}

/** Three once-only current-host cases. The two actual-client cases retain their original limits. */
export async function runProviderQualification(
  options: ProviderQualificationOptions,
  submitOnce: (admission: { input: GenerateInput; idempotencyKey: string }) => Promise<Job>,
) {
  if (
    options.approved !== true ||
    options.acceptEstimateRisk !== true ||
    !Object.hasOwn(providerCases, options.case) ||
    validateServer(options.gateway) !== providerGateway ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(options.workspaceId) ||
    !/^[a-f0-9]{40}$/.test(options.apiSource) ||
    !/^[a-f0-9]{40}$/.test(options.workerSource)
  )
    fail('Approve an exact hosted provider case, runtime sources and upstream estimate risk.');
  const selected = providerCases[options.case];
  const routeId = `alibaba/ap-southeast-1/${selected.model.split('/')[1]}`;
  const input = parseGenerationRequest(options.input);
  const args = input.input;
  const image = selected.operation === 'image-to-video';
  const fields = [
    'prompt',
    'duration',
    'resolution',
    'aspectRatio',
    'count',
    ...(image ? ['firstFrame'] : []),
  ];
  const rate = catalog.routes
    .find((route) => route.id === routeId)
    ?.rates.find(
      (rate) =>
        rate.operation === selected.operation &&
        rate.resolution === '480p' &&
        rate.unit === 'output-second',
    );
  const candidate = options.quote.candidates.find((candidate) => candidate.routeId === routeId);
  if (
    Object.keys(input).some(
      (field) =>
        ![
          'modelId',
          'operation',
          'input',
          'billing',
          'routing',
          'routeId',
          'maxCostMicros',
        ].includes(field),
    ) ||
    input.modelId !== selected.model ||
    input.operation !== selected.operation ||
    input.routeId !== routeId ||
    input.billing !== 'managed' ||
    input.maxCostMicros !== selected.estimate ||
    !equal(input.routing, { fallback: false }) ||
    args.duration !== 2 ||
    args.resolution !== '480p' ||
    (args.count ?? 1) !== 1 ||
    args.aspectRatio !== (image ? 'source' : '16:9') ||
    Object.keys(args).some((field) => !fields.includes(field)) ||
    (image &&
      (!args.firstFrame ||
        !('assetKey' in args.firstFrame) ||
        Object.keys(args.firstFrame).length !== 1 ||
        !args.firstFrame.assetKey?.startsWith(`inputs/${options.workspaceId}/`))) ||
    rate?.usdMicros !== selected.estimate / 2 ||
    options.quote.modelId !== input.modelId ||
    options.quote.operation !== input.operation ||
    options.quote.selectedRouteId !== routeId ||
    options.quote.reservationMicros !== selected.estimate ||
    candidate?.executable !== true ||
    candidate.estimatedCostMicros !== selected.estimate
  )
    fail(
      'Only the exact reviewed Singapore 480p two-second provider case and executable quote are approved.',
    );
  const reserveMicros = Math.max(selected.estimate * 2, selected.estimate + 10_000);
  return locked(options.receiptPath, options.expectedReceiptSha256, async (receipt, save) => {
    if (
      receipt.server !== options.authority.server ||
      receipt.workspaceId !== options.authority.workspaceId
    )
      fail('Original journal authority differs; never rebind it to the hosted gateway.');
    if (receipt.entries.some((entry) => entry.providerQualification?.case === options.case))
      fail('This hosted provider case already has an admission. Resume its recorded job/key.');
    for (const entry of receipt.entries) {
      if (entry.actualCostMicros !== null && entry.actualCostMicros > entry.reserveMicros)
        fail('An upstream cost exceeded its reservation; preserve it and review before admission.');
      const origin = entry.clientQualification ?? entry.providerQualification;
      if (origin) {
        if (entry.actualCostMicros === null)
          fail(
            'An earlier hosted admission or cost is unresolved. Reconcile its same job before new work.',
          );
        const observed = structuredClone(entry);
        applyObservation(
          observed,
          await options.observeQualified(
            structuredClone(entry),
            origin.gateway,
            origin.workspaceId,
          ),
          origin.gateway,
          origin.workspaceId,
        );
        if (
          observed.jobStatus !== 'succeeded' ||
          observed.deliveryStatus !== 'available' ||
          observed.outputHashes?.length !== (entry.input.input.count ?? 1) ||
          observed.outputHashes.some((hash) => !/^[a-f0-9]{64}$/i.test(hash)) ||
          !equal(observed.outputHashes, entry.outputHashes)
        )
          fail('Existing hosted delivery differs. Preserve its admission and financial history.');
      } else if (entry.actualCostMicros === null) {
        const observation = await options.observeHistorical(
          structuredClone(entry),
          receipt.server,
          receipt.workspaceId,
        );
        if (
          !historicalMatches(entry, observation, receipt.server, receipt.workspaceId) ||
          !retained({
            ...entry,
            jobStatus: observation.job.status,
            deliveryStatus: observation.job.deliveryStatus,
            outputHashes: observation.job.outputs.flatMap((output) =>
              output.sha256 ? [output.sha256] : [],
            ),
          })
        )
          fail('Original retained hold evidence differs. Keep its full reservation.');
      }
    }
    if (liabilityMicros(receipt) + reserveMicros > ceiling)
      fail('Insufficient shared budget including retained holds.');
    const entry: Entry = {
      routeId,
      input,
      inputHash: hashInput(input),
      idempotencyKey: `opengen-provider-${randomUUID()}`,
      estimateMicros: selected.estimate,
      reserveMicros,
      actualCostMicros: null,
      phase: 'reserved',
      sources: [catalog.routes.find((route) => route.id === routeId)!.pricingSource],
      createdAt: new Date().toISOString(),
      providerQualification: {
        scope: providerQualificationScope,
        case: options.case,
        gateway: providerGateway,
        workspaceId: options.workspaceId,
        apiSource: options.apiSource,
        workerSource: options.workerSource,
      },
    };
    receipt.entries.push(entry);
    await save();
    entry.phase = 'submitting';
    await save();
    try {
      const job = await submitOnce({
        input: structuredClone(input),
        idempotencyKey: entry.idempotencyKey,
      });
      if (!matches(entry, job))
        fail('Provider admission differs from the recorded native request.');
      entry.phase = 'accepted';
      entry.jobId = job.id;
      entry.upstreamId = job.upstreamId;
      entry.jobStatus = job.status;
      entry.deliveryStatus = job.deliveryStatus;
      await save();
    } catch {
      entry.phase = 'admission-unknown';
      await save();
    }
    return {
      scope: providerQualificationScope,
      case: options.case,
      phase: entry.phase,
      jobId: entry.jobId ?? null,
      accountedMicros: liabilityMicros(receipt),
      retainedMicros: reserveMicros,
      paidResubmissionAllowed: false as const,
    };
  });
}

/** Existing-job reads only. Never retries submission, replaces a key or refunds an unknown charge. */
export async function reconcileProviderQualification(
  options: Pick<
    ProviderQualificationOptions,
    'receiptPath' | 'expectedReceiptSha256' | 'authority' | 'case' | 'gateway' | 'workspaceId'
  >,
  observe: (entry: Readonly<SmokeEntry>) => Promise<QualificationObservation>,
) {
  return locked(options.receiptPath, options.expectedReceiptSha256, async (receipt, save) => {
    if (
      receipt.server !== options.authority.server ||
      receipt.workspaceId !== options.authority.workspaceId
    )
      fail('Original journal authority differs.');
    const entries = receipt.entries.filter(
      (entry) => entry.providerQualification?.case === options.case,
    );
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (
      !entry ||
      entry.providerQualification!.gateway !== validateServer(options.gateway) ||
      entry.providerQualification!.workspaceId !== options.workspaceId
    )
      fail('Recorded provider admission not found for this exact gateway/workspace.');
    applyObservation(
      entry,
      await observe(structuredClone(entry)),
      entry.providerQualification!.gateway,
      options.workspaceId,
    );
    await save();
    return {
      phase: entry.phase,
      jobId: entry.jobId,
      accountedMicros: liabilityMicros(receipt),
      overBudget: liabilityMicros(receipt) > ceiling,
      reservationExceeded:
        entry.actualCostMicros !== null && entry.actualCostMicros > entry.reserveMicros,
      paidResubmissionAllowed: false as const,
    };
  });
}
