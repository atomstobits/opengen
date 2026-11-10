import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/** Provider declarations are retained separately; neither a declaration nor a signature proves origin. */
export interface MediaDeclaration {
  width?: number;
  height?: number;
  durationSeconds?: number;
  hasAudio?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  frameCount?: number;
}
export interface RequestedMedia {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  durationSeconds?: number;
  durationToleranceSeconds?: number;
  requiresAudio?: boolean;
  videoCodec?: string;
}
export interface MeasuredMedia {
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameCount: number | null;
}
export interface ConformanceNotice {
  code: string;
  field?: keyof RequestedMedia | 'outputCount';
  requested?: number | boolean | string;
  delivered?: number | boolean | string;
}
export interface OutputInspection {
  checkedAt: string;
  sha256: string;
  byteLength: number;
  declared: MediaDeclaration | null;
  /** Probe observations, not provider declarations. Duration is container/stream metadata, not decoded timing. */
  measured: MeasuredMedia;
  metadata: { status: 'available' | 'unknown' | 'unavailable' | 'invalid'; reason?: string };
  decode: { status: 'passed' | 'failed' | 'unknown'; coverage: 'full' | 'none'; reason?: string };
  conformance: { status: 'conformant' | 'nonconformant' | 'unknown'; notices: ConformanceNotice[] };
  contentSafety:
    | { status: 'not_checked'; checkedBy: null }
    | {
        status: 'passed' | 'flagged' | 'unknown';
        checkedBy: 'provider' | 'opengen';
        method: string;
        checkedAt: string;
      };
}
interface ToolOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
}
interface ToolResult {
  stdout: string;
  stderr: string;
  exitCode: number | string;
  killed?: boolean;
}
export type InspectionRunner = (
  executable: string,
  args: string[],
  options: ToolOptions,
) => Promise<ToolResult>;
export interface InspectionOptions {
  declared?: MediaDeclaration;
  requested?: RequestedMedia;
  /** Explicit evidence supplied by the content checker; decoding never invents a safety check. */
  contentSafety?: Exclude<OutputInspection['contentSafety'], { status: 'not_checked' }>;
  /** Deploy these trusted binaries in an OS/container sandbox with network egress disabled. */
  probePath?: string;
  decodePath?: string;
  networkIsolated?: boolean;
  run?: InspectionRunner;
}
const maxBytes = 100 * 1024 * 1024;
const maxReportBytes = 512 * 1024;
const emptyMeasurements = (): MeasuredMedia => ({
  width: null,
  height: null,
  durationSeconds: null,
  hasAudio: null,
  videoCodec: null,
  audioCodec: null,
  frameCount: null,
});
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const positiveNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const positiveInteger = (value: unknown): number | null => {
  const parsed = positiveNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
};
const codec = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(value) ? value : null;
function declaration(value: MediaDeclaration | undefined): MediaDeclaration | null {
  if (!value) return null;
  const result: MediaDeclaration = {};
  for (const field of ['width', 'height', 'frameCount'] as const) {
    const parsed = positiveInteger(value[field]);
    if (parsed !== null) result[field] = parsed;
  }
  const duration = positiveNumber(value.durationSeconds);
  if (duration !== null) result.durationSeconds = duration;
  if (typeof value.hasAudio === 'boolean') result.hasAudio = value.hasAudio;
  for (const field of ['videoCodec', 'audioCodec'] as const) {
    const parsed = codec(value[field]);
    if (parsed !== null) result[field] = parsed;
  }
  return result;
}
function contentSafety(
  value: InspectionOptions['contentSafety'],
): OutputInspection['contentSafety'] {
  if (
    value &&
    ['passed', 'flagged', 'unknown'].includes(value.status) &&
    ['provider', 'opengen'].includes(value.checkedBy) &&
    /^[a-zA-Z0-9_.:-]{1,80}$/.test(value.method) &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.checkedAt) &&
    Number.isFinite(Date.parse(value.checkedAt))
  )
    return {
      status: value.status,
      checkedBy: value.checkedBy,
      method: value.method,
      checkedAt: value.checkedAt,
    };
  return { status: 'not_checked', checkedBy: null };
}
const invalidMedia = (stderr: string) =>
  /invalid data found|corrupt decoded frame|error while decoding|truncated|input buffer exhausted|invalid png signature|invalid jpeg/i.test(
    stderr,
  );
const limited = (result: ToolResult) =>
  result.killed ||
  result.exitCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
  Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxReportBytes;
const unavailable = (result: ToolResult) =>
  result.exitCode === 'ENOENT' || result.exitCode === 'EACCES';
const runTool: InspectionRunner = (executable, args, options) =>
  new Promise((resolve) => {
    execFile(
      executable,
      args,
      { ...options, encoding: 'utf8', shell: false, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & { code?: number | string | null; killed?: boolean; signal?: string | null })
          | null;
        resolve({
          stdout,
          stderr,
          exitCode: failure
            ? failure.signal
              ? `signal:${failure.signal}`
              : (failure.code ?? 'process_failed')
            : 0,
          killed: failure?.killed || Boolean(failure?.signal),
        });
      },
    );
  });

function validateRequested(requested: RequestedMedia) {
  for (const field of ['width', 'height', 'minWidth', 'minHeight'] as const) {
    const value = requested[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 32768))
      throw new Error('Invalid requested inspection dimensions.');
  }
  for (const field of ['durationSeconds', 'durationToleranceSeconds'] as const) {
    const value = requested[field];
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 600))
      throw new Error('Invalid requested inspection duration.');
  }
  if (requested.videoCodec !== undefined && !codec(requested.videoCodec))
    throw new Error('Invalid requested inspection codec.');
}
function conformance(
  measured: MeasuredMedia,
  requested: RequestedMedia,
  decode: OutputInspection['decode'],
): OutputInspection['conformance'] {
  const notices: ConformanceNotice[] = [];
  let unknown = decode.status !== 'passed';
  const mismatch = (
    field: keyof RequestedMedia,
    requestedValue: number | boolean | string,
    delivered: number | boolean | string | null,
    matches: boolean,
  ) => {
    if (delivered === null) {
      unknown = true;
      notices.push({ code: 'measurement_unknown', field, requested: requestedValue });
    } else if (!matches)
      notices.push({
        code: 'requested_output_mismatch',
        field,
        requested: requestedValue,
        delivered,
      });
  };
  for (const field of ['width', 'height'] as const) {
    const value = requested[field];
    if (value !== undefined) mismatch(field, value, measured[field], measured[field] === value);
  }
  for (const [field, measuredField] of [
    ['minWidth', 'width'],
    ['minHeight', 'height'],
  ] as const) {
    const value = requested[field];
    if (value !== undefined)
      mismatch(field, value, measured[measuredField], (measured[measuredField] ?? 0) >= value);
  }
  if (requested.durationSeconds !== undefined)
    mismatch(
      'durationSeconds',
      requested.durationSeconds,
      measured.durationSeconds,
      measured.durationSeconds !== null &&
        Math.abs(requested.durationSeconds - measured.durationSeconds) <=
          (requested.durationToleranceSeconds ?? 0.1),
    );
  if (requested.requiresAudio)
    mismatch('requiresAudio', true, measured.hasAudio, measured.hasAudio === true);
  if (requested.videoCodec !== undefined)
    mismatch(
      'videoCodec',
      requested.videoCodec,
      measured.videoCodec,
      measured.videoCodec === requested.videoCodec,
    );
  if (decode.status !== 'passed')
    notices.push({
      code: decode.status === 'failed' ? 'output_decode_failed' : 'full_decode_unknown',
    });
  return {
    status:
      decode.status === 'failed' ||
      notices.some((notice) => notice.code === 'requested_output_mismatch')
        ? 'nonconformant'
        : unknown
          ? 'unknown'
          : 'conformant',
    notices,
  };
}

/**
 * Bounded evidence for exact retained bytes. ffprobe alone never establishes full decoding,
 * moderation, signature validity, model origin, or requested-parameter fidelity.
 */
export async function inspectOutput(
  bytes: Uint8Array,
  mediaType: string,
  options: InspectionOptions = {},
): Promise<OutputInspection> {
  const requested = options.requested ?? {};
  validateRequested(requested);
  const result: OutputInspection = {
    checkedAt: new Date().toISOString(),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
    declared: declaration(options.declared),
    measured: emptyMeasurements(),
    metadata: { status: 'unavailable', reason: 'tool_not_configured' },
    decode: { status: 'unknown', coverage: 'none', reason: 'tool_not_configured' },
    conformance: { status: 'unknown', notices: [] },
    contentSafety: contentSafety(options.contentSafety),
  };
  let directory: string | undefined;
  try {
    const extension = new Map([
      ['image/png', 'png'],
      ['image/jpeg', 'jpg'],
      ['image/webp', 'webp'],
      ['video/mp4', 'mp4'],
    ]).get(mediaType);
    if (!bytes.byteLength || bytes.byteLength > maxBytes || !extension) {
      result.metadata = { status: 'unknown', reason: 'unsupported_asset' };
      result.decode.reason = 'unsupported_asset';
      return result;
    }
    if (!options.probePath) return result;
    if (!isAbsolute(options.probePath) || (options.decodePath && !isAbsolute(options.decodePath))) {
      result.metadata.reason = 'absolute_tool_path_required';
      result.decode.reason = 'absolute_tool_path_required';
      return result;
    }
    // protocol_whitelist is defense in depth, not a replacement for sandbox network isolation.
    if (!options.networkIsolated) {
      result.metadata.reason = 'network_isolation_required';
      result.decode.reason = 'network_isolation_required';
      return result;
    }
    directory = await mkdtemp(join(tmpdir(), 'opengen-inspect-'));
    const asset = join(directory, `asset.${extension}`);
    await writeFile(asset, bytes, { mode: 0o600 });
    const toolOptions = (path: string): ToolOptions => ({
      cwd: directory!,
      env: {
        NODE_ENV: 'production',
        PATH: dirname(path),
        HOME: directory!,
        TMPDIR: directory!,
        LANG: 'C',
      },
      timeout: 15_000,
      maxBuffer: maxReportBytes,
    });
    const run = options.run ?? runTool;
    const probe = await run(
      options.probePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        '1',
        '-show_entries',
        'stream=codec_type,codec_name,width,height,duration:format=duration',
        '-of',
        'json',
        asset,
      ],
      toolOptions(options.probePath),
    );
    if (limited(probe)) {
      result.metadata = { status: 'unknown', reason: 'inspector_resource_limit' };
      result.decode.reason = 'inspector_resource_limit';
      return result;
    }
    if (unavailable(probe)) {
      result.metadata.reason = 'tool_unavailable';
      return result;
    }
    if (probe.exitCode !== 0) {
      const invalid = invalidMedia(probe.stderr);
      result.metadata = {
        status: invalid ? 'invalid' : 'unknown',
        reason: invalid ? 'invalid_media' : 'probe_failed',
      };
      result.decode = {
        status: invalid ? 'failed' : 'unknown',
        coverage: 'none',
        reason: result.metadata.reason,
      };
      return result;
    }
    const report = object(JSON.parse(probe.stdout));
    if (!Array.isArray(report.streams) || !report.streams.length || report.streams.length > 16) {
      result.metadata = { status: 'invalid', reason: 'invalid_stream_layout' };
      result.decode = { status: 'failed', coverage: 'none', reason: 'invalid_stream_layout' };
      return result;
    }
    const streams = report.streams.map(object);
    const visual = streams.filter((stream) => stream.codec_type === 'video');
    const audio = streams.filter((stream) => stream.codec_type === 'audio');
    // A per-file image/video receipt has one visual stream; avoid pretending to inspect only the first.
    if (
      visual.length !== 1 ||
      audio.length > 1 ||
      visual.length + audio.length !== streams.length
    ) {
      result.metadata = { status: 'unknown', reason: 'unsupported_stream_layout' };
      result.decode.reason = 'unsupported_stream_layout';
      return result;
    }
    const video = visual[0]!;
    result.measured = {
      width: positiveInteger(video.width),
      height: positiveInteger(video.height),
      durationSeconds:
        positiveNumber(video.duration) ?? positiveNumber(object(report.format).duration),
      hasAudio: audio.length > 0,
      videoCodec: codec(video.codec_name),
      audioCodec: codec(audio[0]?.codec_name),
      frameCount: null,
    };
    result.metadata = { status: 'available' };
    const { width, height, durationSeconds } = result.measured;
    if (
      !width ||
      !height ||
      width > 32768 ||
      height > 32768 ||
      width * height > 40_000_000 ||
      (durationSeconds !== null && durationSeconds > 600)
    ) {
      result.decode.reason = 'decode_resource_limit';
      return result;
    }
    if (!options.decodePath) return result;
    const decoded = await run(
      options.decodePath,
      [
        '-v',
        'error',
        '-xerror',
        '-nostdin',
        '-protocol_whitelist',
        'file,pipe',
        '-threads',
        '1',
        '-i',
        asset,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-threads',
        '1',
        '-fps_mode',
        'passthrough',
        '-progress',
        'pipe:1',
        '-nostats',
        '-f',
        'null',
        '-',
      ],
      toolOptions(options.decodePath),
    );
    if (limited(decoded)) result.decode.reason = 'inspector_resource_limit';
    else if (unavailable(decoded)) result.decode.reason = 'tool_unavailable';
    else if (decoded.exitCode !== 0)
      result.decode = {
        status: invalidMedia(decoded.stderr) ? 'failed' : 'unknown',
        coverage: 'none',
        reason: invalidMedia(decoded.stderr) ? 'decode_rejected' : 'decoder_failed',
      };
    else {
      const frames = [...decoded.stdout.matchAll(/^frame=\s*(\d+)\s*$/gm)];
      const count = positiveInteger(frames.at(-1)?.[1]);
      if (!/^progress=end\s*$/m.test(decoded.stdout) || count === null)
        result.decode.reason = 'decode_report_incomplete';
      else {
        result.measured.frameCount = count;
        result.decode = { status: 'passed', coverage: 'full' };
      }
    }
    return result;
  } catch {
    result.metadata = { status: 'unknown', reason: 'inspection_unavailable' };
    result.decode = { status: 'unknown', coverage: 'none', reason: 'inspection_unavailable' };
    return result;
  } finally {
    result.conformance = conformance(result.measured, requested, result.decode);
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Retained count is an observed file count; missing slots never count as delivered. */
export function assessOutputCount(
  requested: number,
  retained: number,
): OutputInspection['conformance'] {
  if (
    ![requested, retained].every(
      (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100,
    )
  )
    throw new Error('Invalid output inspection count.');
  return {
    status: requested === retained ? 'conformant' : 'nonconformant',
    notices:
      requested === retained
        ? []
        : [
            {
              code: 'requested_output_mismatch',
              field: 'outputCount',
              requested,
              delivered: retained,
            },
          ],
  };
}
