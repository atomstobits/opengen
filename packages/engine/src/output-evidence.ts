/** Customer-safe summaries only. Provider descriptors, reports and free-text errors stay private. */
export type OutputEvidenceCode =
  | 'attempt_changed'
  | 'source_expired'
  | 'inline_output_lost'
  | 'owned_output_missing'
  | 'delivery_retry_exhausted'
  | 'output_delivery_failed'
  | 'output_decode_failed'
  | 'output_nonconformant'
  | 'output_unusable'
  | 'storage_unavailable'
  | 'url_refresh_failed'
  | 'output_unavailable';
type NoticeField =
  | 'width'
  | 'height'
  | 'minWidth'
  | 'minHeight'
  | 'durationSeconds'
  | 'durationToleranceSeconds'
  | 'requiresAudio'
  | 'videoCodec'
  | 'outputCount';
export interface OutputConformanceNotice {
  code:
    | 'measurement_unknown'
    | 'requested_output_mismatch'
    | 'output_decode_failed'
    | 'full_decode_unknown';
  field?: NoticeField;
  requested?: number | boolean | string;
  delivered?: number | boolean | string;
}
export interface OutputInspectionSummary {
  metadata: { status: 'available' | 'unknown' | 'unavailable' | 'invalid' };
  decode: { status: 'passed' | 'failed' | 'unknown'; coverage: 'full' | 'none' };
  /** Probe/container observations; duration is not decoded timing. */
  measured: {
    width: number | null;
    height: number | null;
    durationSeconds: number | null;
    hasAudio: boolean | null;
    videoCodec: string | null;
    audioCodec: string | null;
    frameCount: number | null;
  };
  conformance: {
    status: 'conformant' | 'nonconformant' | 'unknown';
    notices: OutputConformanceNotice[];
  };
  contentSafety: {
    status: 'not_checked' | 'passed' | 'flagged' | 'unknown';
    checkedBy: 'provider' | 'opengen' | null;
    checkedAt?: string;
  };
}
export interface OutputEvidence {
  /** Original upstream output slot, including slots with no deliverable bytes. */
  index: number;
  state: 'available' | 'failed' | 'expired' | 'pending';
  /** Index into the customer outputs array; null when there is no usable capability. */
  outputIndex: number | null;
  code?: OutputEvidenceCode;
  inspection: OutputInspectionSummary;
}
/** Receipt identity is stable; evidence.outputIndex and position may compact during recovery. */
export function originalOutputSlot(
  output: { outputIndex?: number },
  position: number,
  evidence: OutputEvidence[],
): number {
  if (
    Number.isSafeInteger(output.outputIndex) &&
    output.outputIndex! >= 0 &&
    output.outputIndex! < 20
  )
    return output.outputIndex!;
  // Outputs retained before slot metadata was persisted still have the receipt-to-array mapping.
  return evidence.find((item) => item.outputIndex === position)?.index ?? position;
}
const codes = new Set<OutputEvidenceCode>([
  'attempt_changed',
  'source_expired',
  'inline_output_lost',
  'owned_output_missing',
  'delivery_retry_exhausted',
  'output_delivery_failed',
  'output_decode_failed',
  'output_nonconformant',
  'output_unusable',
  'storage_unavailable',
  'url_refresh_failed',
  'output_unavailable',
]);
const fields = new Set<NoticeField>([
  'width',
  'height',
  'minWidth',
  'minHeight',
  'durationSeconds',
  'durationToleranceSeconds',
  'requiresAudio',
  'videoCodec',
  'outputCount',
]);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const integer = (value: unknown, minimum: number, maximum: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
const number = (value: unknown, minimum: number, maximum: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
const codec = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : null;
const timestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function noticeValue(field: NoticeField, value: unknown): number | boolean | string | undefined {
  if (field === 'requiresAudio') return typeof value === 'boolean' ? value : undefined;
  if (field === 'videoCodec')
    return typeof value === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(value) ? value : undefined;
  if (['durationSeconds', 'durationToleranceSeconds'].includes(field))
    return number(value, 0, 600) ?? undefined;
  return (
    integer(value, field === 'outputCount' ? 0 : 1, field === 'outputCount' ? 100 : 32768) ??
    undefined
  );
}
function notices(value: unknown): OutputConformanceNotice[] {
  if (!Array.isArray(value)) return [];
  const result: OutputConformanceNotice[] = [];
  for (const raw of value.slice(0, 20)) {
    const item = object(raw);
    if (item.code === 'output_decode_failed' || item.code === 'full_decode_unknown') {
      result.push({ code: item.code });
      continue;
    }
    if (
      !['measurement_unknown', 'requested_output_mismatch'].includes(String(item.code)) ||
      !fields.has(item.field as NoticeField)
    )
      continue;
    const field = item.field as NoticeField;
    const requested = noticeValue(field, item.requested);
    const delivered = noticeValue(field, item.delivered);
    result.push({
      code: item.code as 'measurement_unknown' | 'requested_output_mismatch',
      field,
      ...(requested !== undefined ? { requested } : {}),
      ...(item.code === 'requested_output_mismatch' && delivered !== undefined
        ? { delivered }
        : {}),
    });
  }
  return result;
}
function inspectionSummary(value: unknown): OutputInspectionSummary {
  const input = object(value),
    metadata = object(input.metadata),
    decoded = object(input.decode);
  const measured = object(input.measured),
    conformance = object(input.conformance),
    safety = object(input.contentSafety);
  const metadataStatus = ['available', 'unavailable', 'invalid'].includes(String(metadata.status))
    ? (metadata.status as 'available' | 'unavailable' | 'invalid')
    : 'unknown';
  const decodeStatus =
    metadataStatus === 'invalid' || decoded.status === 'failed'
      ? 'failed'
      : decoded.status === 'passed' && decoded.coverage === 'full'
        ? 'passed'
        : 'unknown';
  const conformanceNotices = notices(conformance.notices);
  const conformanceStatus =
    decodeStatus === 'failed' ||
    conformance.status === 'nonconformant' ||
    conformanceNotices.some((notice) => notice.code === 'requested_output_mismatch')
      ? 'nonconformant'
      : conformance.status === 'conformant' && decodeStatus === 'passed'
        ? 'conformant'
        : 'unknown';
  let contentSafety: OutputInspectionSummary['contentSafety'] = {
    status: 'unknown',
    checkedBy: null,
  };
  if (safety.status === 'not_checked') contentSafety = { status: 'not_checked', checkedBy: null };
  else if (
    ['passed', 'flagged', 'unknown'].includes(String(safety.status)) &&
    ['provider', 'opengen'].includes(String(safety.checkedBy)) &&
    timestamp(safety.checkedAt)
  ) {
    contentSafety = {
      status: safety.status as 'passed' | 'flagged' | 'unknown',
      checkedBy: safety.checkedBy as 'provider' | 'opengen',
      checkedAt: safety.checkedAt,
    };
  }
  return {
    metadata: { status: metadataStatus },
    decode: { status: decodeStatus, coverage: decodeStatus === 'passed' ? 'full' : 'none' },
    measured: {
      width: integer(measured.width, 1, 32768),
      height: integer(measured.height, 1, 32768),
      durationSeconds: number(measured.durationSeconds, Number.MIN_VALUE, 600),
      hasAudio: typeof measured.hasAudio === 'boolean' ? measured.hasAudio : null,
      videoCodec: codec(measured.videoCodec),
      audioCodec: codec(measured.audioCodec),
      frameCount: integer(measured.frameCount, 1, 36_000_000),
    },
    conformance: { status: conformanceStatus, notices: conformanceNotices },
    contentSafety,
  };
}

/** Normalize the receipt-derived array; this accepts no URLs, keys, reports or arbitrary errors. */
export function projectOutputEvidence(value: unknown): OutputEvidence[] {
  if (!Array.isArray(value)) return [];
  const result: OutputEvidence[] = [],
    seen = new Set<number>();
  for (const raw of value.slice(0, 20)) {
    const item = object(raw),
      index = integer(item.index, 0, 19);
    if (
      index === null ||
      seen.has(index) ||
      !['available', 'failed', 'expired', 'pending'].includes(String(item.state))
    )
      continue;
    seen.add(index);
    const code = codes.has(item.code as OutputEvidenceCode)
      ? (item.code as OutputEvidenceCode)
      : undefined;
    result.push({
      index,
      state: item.state as OutputEvidence['state'],
      outputIndex: item.state === 'available' ? integer(item.outputIndex, 0, 19) : null,
      ...(code ? { code } : {}),
      inspection: inspectionSummary(item.inspection),
    });
  }
  return result.sort((left, right) => left.index - right.index);
}
