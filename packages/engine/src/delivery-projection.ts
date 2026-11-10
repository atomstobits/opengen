import { generationFeeSettlementView } from './generation-billing.js';
import { normalizeJobError, normalizeJobProgress } from './execution-telemetry.js';
import type {
  AssetRef,
  C2paVerification,
  GenerateInput,
  GenerationArguments,
  Job,
  OutputAsset,
} from '@media-router/contracts';
import type { AssetStore } from './storage.js';
import {
  originalOutputSlot,
  projectOutputEvidence,
  type OutputEvidence,
  type OutputEvidenceCode,
} from './output-evidence.js';

export type CustomerDeliveryStatus =
  'pending' | 'available' | 'partial' | 'failed' | 'expired' | 'unverified';
export type CustomerJob = Omit<Job, 'deliveryStatus'> & {
  deliveryStatus: CustomerDeliveryStatus;
  outputEvidence?: OutputEvidence[];
};
type OutputSigner = Pick<AssetStore, 'sign'> & Partial<Pick<AssetStore, 'assertOutputAvailable'>>;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const keyPattern = new RegExp(`^outputs/(${uuid})/(${uuid})\\.(png|jpg|webp|mp4)$`);
const mediaTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  mp4: 'video/mp4',
};
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001f]/.test(value);
const date = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
const pick = <T extends object, K extends keyof T>(value: T, fields: readonly K[]): Pick<T, K> =>
  Object.fromEntries(
    fields.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]),
  ) as Pick<T, K>;
function asset(value: AssetRef): AssetRef {
  return typeof value.assetKey === 'string' ? { assetKey: value.assetKey } : { url: value.url! };
}

/** Retain the caller's canonical request, excluding private or future unreviewed extensions. */
function request(value: GenerateInput): GenerateInput {
  const input: GenerationArguments = pick(value.input, [
    'prompt',
    'negativePrompt',
    'duration',
    'resolution',
    'aspectRatio',
    'count',
    'quality',
    'outputFormat',
    'outputCompression',
    'background',
    'seed',
    'audio',
    'draft',
    'draftJobId',
    'codec',
    'bitrateMode',
    'promptExpansion',
    'thinkingLevel',
    'systemPrompt',
    'grounding',
    'layers',
    'strength',
    'watermark',
    'promptExtend',
    'thinking',
  ]);
  for (const field of ['firstFrame', 'lastFrame', 'sourceVideo', 'mask', 'targetAudio'] as const)
    if (value.input[field]) input[field] = asset(value.input[field]!);
  if (value.input.size) input.size = pick(value.input.size, ['width', 'height']);
  if (value.input.references)
    input.references = value.input.references.map((reference) => ({
      type: reference.type,
      asset: asset(reference.asset),
    }));
  if (value.input.keyframes)
    input.keyframes = value.input.keyframes.map((frame) => ({
      ...pick(frame, ['at']),
      image: asset(frame.image),
    }));
  if (value.input.shots)
    input.shots = value.input.shots.map((shot) => pick(shot, ['prompt', 'duration']));
  if (value.input.elements)
    input.elements = value.input.elements.map((element) => ({
      ...pick(element, ['id', 'description']),
      ...(element.images
        ? { images: element.images.map(asset) }
        : { video: asset(element.video!) }),
      ...(element.voice ? { voice: asset(element.voice) } : {}),
    }));
  return {
    ...pick(value, [
      'modelId',
      'operation',
      'billing',
      'routeId',
      'maxCostMicros',
      'previousJobId',
      'queueStartDeadlineAt',
    ]),
    input,
    ...(value.feeAcceptance
      ? { feeAcceptance: pick(value.feeAcceptance, ['policyId', 'policyVersion']) }
      : {}),
    ...(value.routing
      ? {
          routing: pick(value.routing, [
            'modelIds',
            'modelProviderExceptions',
            'authorOnly',
            'processingScopes',
            'providerIds',
            'deploymentIds',
            'endpointRegions',
            'processingRegions',
            'fidelity',
            'preference',
            'fallback',
          ]),
        }
      : {}),
  };
}
function provenance(value: C2paVerification | undefined): C2paVerification | undefined {
  if (
    !value ||
    !['trusted', 'valid', 'invalid', 'absent', 'unknown', 'unavailable'].includes(value.status) ||
    value.tool !== 'c2patool' ||
    !date(value.checkedAt) ||
    !hash(value.sha256)
  )
    return undefined;
  return {
    status: value.status,
    checkedAt: value.checkedAt,
    sha256: value.sha256,
    tool: 'c2patool',
    validationCodes: Array.isArray(value.validationCodes)
      ? value.validationCodes
          .filter((code) => typeof code === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(code))
          .slice(0, 50)
      : [],
    ...(typeof value.reason === 'string' && /^[a-z_]{1,80}$/.test(value.reason)
      ? { reason: value.reason }
      : {}),
    ...(text(value.manifestLabel) ? { manifestLabel: value.manifestLabel } : {}),
    ...(text(value.signer) ? { signer: value.signer } : {}),
    ...(hash(value.reportSha256) ? { reportSha256: value.reportSha256 } : {}),
  };
}
function ownedOutputKey(jobId: string, output: OutputAsset): string | undefined {
  if (typeof output.storageKey !== 'string') return undefined;
  const match = keyPattern.exec(output.storageKey);
  return match && match[1] === jobId && mediaTypes[match[3]!] === output.mediaType
    ? output.storageKey
    : undefined;
}
function signedOutput(output: OutputAsset, signed: OutputAsset): OutputAsset {
  const url = new URL(signed.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !date(signed.expiresAt) ||
    Date.parse(signed.expiresAt) <= Date.now()
  )
    throw new Error('Output capability unavailable.');
  const c2pa = provenance(output.c2pa);
  return {
    url: signed.url,
    expiresAt: signed.expiresAt,
    mediaType: output.mediaType,
    fidelity: 'unverified',
    ...(hash(output.sha256) ? { sha256: output.sha256 } : {}),
    ...(Number.isSafeInteger(output.byteLength) && output.byteLength! > 0
      ? { byteLength: output.byteLength }
      : {}),
    ...(c2pa ? { c2pa } : {}),
  };
}

/**
 * The only customer-output boundary: authorize before minting capabilities, never
 * return provider URLs or reuse an old capability after a signing failure.
 * Pass the stored original canonical request, never dispatch-materialized provider
 * capabilities. Call for authenticated native, MCP, compatibility and customer events.
 */
export async function projectCustomerJob(
  workspaceId: string,
  value: Job & { outputEvidence?: unknown },
  storage?: OutputSigner,
): Promise<CustomerJob> {
  if (!workspaceId || value.workspaceId !== workspaceId)
    throw Object.assign(new Error('Job not found.'), {
      code: 'not_found',
      statusCode: 404,
    });
  const errors = new Map<number, string>();
  for (const error of value.deliveryErrors ?? [])
    if (Number.isSafeInteger(error.index) && error.index >= 0 && error.index < 20)
      errors.set(error.index, 'output_delivery_failed');
  const evidence = projectOutputEvidence(value.outputEvidence);
  const outputIndexes = new Map<number, number>();
  const issuanceErrors = new Map<number, OutputEvidenceCode>();
  const seen = new Set<string>();
  const outputs: OutputAsset[] = [];
  for (const [index, output] of value.outputs.slice(0, 20).entries()) {
    const slot = originalOutputSlot(output, index, evidence);
    const unusable = evidence.find(
      (item) =>
        item.outputIndex === index &&
        (item.inspection.decode.status === 'failed' ||
          item.inspection.conformance.status === 'nonconformant'),
    );
    if (unusable) {
      const code =
        unusable.inspection.decode.status === 'failed'
          ? 'output_decode_failed'
          : 'output_nonconformant';
      issuanceErrors.set(index, code);
      errors.set(slot, code);
      continue;
    }
    const key = ownedOutputKey(value.id, output);
    if (!storage || !key || seen.has(key)) {
      const code = !storage ? 'storage_unavailable' : 'output_unavailable';
      errors.set(slot, code);
      issuanceErrors.set(index, code);
      continue;
    }
    seen.add(key);
    try {
      await storage.assertOutputAvailable?.(value.id, key, output.mediaType, output.byteLength);
      const signed = signedOutput(output, await storage.sign(key, output.mediaType));
      outputIndexes.set(index, outputs.length);
      outputs.push({ ...signed, outputIndex: slot });
    } catch {
      errors.set(slot, 'url_refresh_failed');
      issuanceErrors.set(index, 'url_refresh_failed');
    }
  }
  const count = value.input.input.count;
  const expected = Math.max(
    value.outputs.length,
    Number.isSafeInteger(count) && count! > 0 ? count! : 1,
  );
  const declared = value.deliveryStatus as CustomerDeliveryStatus | undefined;
  const deliveryStatus: CustomerDeliveryStatus = outputs.length
    ? outputs.length === expected && !errors.size && declared !== 'partial'
      ? 'available'
      : 'partial'
    : declared === 'pending' ||
        ['queued', 'submitting', 'running', 'submission-unknown'].includes(value.status)
      ? 'pending'
      : declared === 'expired'
        ? 'expired'
        : 'failed';
  return {
    id: value.id,
    workspaceId: value.workspaceId,
    attribution: value.attribution
      ? pick(value.attribution, ['kind', 'keyId', 'membershipId', 'grantId', 'clientId'])
      : null,
    metadata: value.metadata ? pick(value.metadata, ['project', 'tags']) : {},
    progress: normalizeJobProgress(value.progress),
    structuredError: normalizeJobError(value.structuredError),
    status: value.status,
    deliveryStatus,
    ...(errors.size
      ? {
          deliveryErrors: [...errors].map(([index, code]) => ({ index, code })),
        }
      : {}),
    ...(evidence.length
      ? {
          outputEvidence: evidence.map((item) => {
            if (item.outputIndex === null) return item;
            const outputIndex = outputIndexes.get(item.outputIndex);
            return outputIndex !== undefined
              ? { ...item, outputIndex }
              : {
                  ...item,
                  state: 'failed' as const,
                  outputIndex: null,
                  code: issuanceErrors.get(item.outputIndex) ?? ('output_unavailable' as const),
                };
          }),
        }
      : {}),
    input: request(value.input),
    routeId: value.routeId,
    deploymentId: value.deploymentId,
    upstreamId: null,
    outputs,
    error: value.error
      ? value.status === 'succeeded'
        ? 'Output delivery is not available.'
        : value.status === 'submission-unknown'
          ? 'Provider acceptance is unknown.'
          : 'Generation did not complete.'
      : null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    reservedMicros: value.reservedMicros,
    settledMicros: value.settledMicros,
    ...(value.billing
      ? {
          billing:
            value.billing.costStatus === 'pending'
              ? pick(value.billing, [
                  'policyId',
                  'policyVersion',
                  'service',
                  'basisPoints',
                  'costStatus',
                ])
              : generationFeeSettlementView(value.billing),
        }
      : {}),
    attemptCount: value.attemptCount,
  };
}
