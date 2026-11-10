import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  assessOutputCount,
  inspectOutput,
  type InspectionOptions,
  type InspectionRunner,
} from '../packages/engine/src/inspection.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const tools = {
  probePath: '/sandbox/ffprobe',
  decodePath: '/sandbox/ffmpeg',
  networkIsolated: true,
};
const videoMetadata = (
  options: { width?: number; height?: number; duration?: string; audio?: boolean } = {},
) => ({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: options.width ?? 1280,
      height: options.height ?? 720,
      duration: options.duration ?? '5.000000',
      // This container declaration must never be mistaken for a decoded count.
      nb_frames: '999',
    },
    ...(options.audio ? [{ codec_type: 'audio', codec_name: 'aac' }] : []),
  ],
});
const success = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
const fixtureRun = (probe = videoMetadata(), decode = success('frame=120\nprogress=end\n')) =>
  vi.fn<InspectionRunner>(async (path) =>
    path === tools.probePath ? success(JSON.stringify(probe)) : decode,
  );

describe('bounded per-file inspection evidence', () => {
  it('keeps declarations separate and keeps decode, model origin and safety unknown without tools', async () => {
    const declared = { width: 2048, height: 2048, hasAudio: true, videoCodec: 'h264' };
    const result = await inspectOutput(png, 'image/png', { declared, requested: { width: 2048 } });
    expect(result).toMatchObject({
      sha256: createHash('sha256').update(png).digest('hex'),
      byteLength: png.length,
      declared,
      measured: { width: null, hasAudio: null, frameCount: null },
      metadata: { status: 'unavailable', reason: 'tool_not_configured' },
      decode: { status: 'unknown', coverage: 'none' },
      conformance: { status: 'unknown' },
      contentSafety: { status: 'not_checked', checkedBy: null },
    });
    expect(result).not.toHaveProperty('modelOrigin');
    expect(result).not.toHaveProperty('c2pa');
    expect(result.conformance.notices).toContainEqual({
      code: 'measurement_unknown',
      field: 'width',
      requested: 2048,
    });
  });

  it('requires absolute trusted tool paths and asserted network isolation before launching', async () => {
    const run = fixtureRun();
    expect(
      (await inspectOutput(png, 'image/png', { ...tools, networkIsolated: false, run })).metadata
        .reason,
    ).toBe('network_isolation_required');
    expect(
      (await inspectOutput(png, 'image/png', { ...tools, probePath: 'ffprobe', run })).metadata
        .reason,
    ).toBe('absolute_tool_path_required');
    expect(
      (await inspectOutput(png, 'image/png', { ...tools, decodePath: 'ffmpeg', run })).metadata
        .reason,
    ).toBe('absolute_tool_path_required');
    expect(run).not.toHaveBeenCalled();
  });

  it('bounds files, native process options and output while fully decoding all allowed media streams', async () => {
    let inputPath: string | undefined;
    const run: InspectionRunner = vi.fn(async (path, args, options) => {
      expect(options.timeout).toBe(15_000);
      expect(options.maxBuffer).toBe(512 * 1024);
      expect(Object.keys(options.env).sort()).toEqual([
        'HOME',
        'LANG',
        'NODE_ENV',
        'PATH',
        'TMPDIR',
      ]);
      expect(options.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
      expect(args).toContain('file,pipe');
      expect(args).toContain('1');
      if (path === tools.probePath) {
        inputPath = args.at(-1)!;
        expect((await stat(inputPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(inputPath)).toEqual(png);
        return success(JSON.stringify(videoMetadata({ audio: true })));
      }
      expect(args).toContain('-xerror');
      expect(args).toContain('0:v:0');
      expect(args).toContain('0:a?');
      expect(args).toContain('passthrough');
      return success('frame=60\nprogress=continue\nframe=120\nprogress=end\n');
    });
    const result = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run,
      declared: { width: 1920, durationSeconds: 9, frameCount: 999 },
      requested: {
        width: 1280,
        height: 720,
        durationSeconds: 5,
        requiresAudio: true,
        videoCodec: 'h264',
      },
    });
    expect(result.declared).toMatchObject({ width: 1920, durationSeconds: 9, frameCount: 999 });
    expect(result.measured).toEqual({
      width: 1280,
      height: 720,
      durationSeconds: 5,
      hasAudio: true,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameCount: 120,
    });
    expect(result.decode).toEqual({ status: 'passed', coverage: 'full' });
    expect(result.conformance).toEqual({ status: 'conformant', notices: [] });
    await expect(stat(inputPath!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never treats probing or container frame counts as full decoding', async () => {
    const run = fixtureRun();
    const result = await inspectOutput(png, 'video/mp4', {
      ...tools,
      decodePath: undefined,
      run,
      requested: { width: 1280 },
    });
    expect(result.metadata.status).toBe('available');
    expect(result.measured.width).toBe(1280);
    expect(result.measured.frameCount).toBeNull();
    expect(result.decode.status).toBe('unknown');
    expect(result.conformance.status).toBe('unknown');
    expect(run).toHaveBeenCalledOnce();
  });

  it('records exact undersized, short, missing-audio and codec mismatches without silent downgrade', async () => {
    const result = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run: fixtureRun(videoMetadata({ width: 640, height: 360, duration: '2.5' })),
      requested: {
        minWidth: 1280,
        minHeight: 720,
        durationSeconds: 5,
        requiresAudio: true,
        videoCodec: 'hevc',
      },
    });
    expect(result.conformance.status).toBe('nonconformant');
    expect(result.conformance.notices).toEqual([
      { code: 'requested_output_mismatch', field: 'minWidth', requested: 1280, delivered: 640 },
      { code: 'requested_output_mismatch', field: 'minHeight', requested: 720, delivered: 360 },
      { code: 'requested_output_mismatch', field: 'durationSeconds', requested: 5, delivered: 2.5 },
      {
        code: 'requested_output_mismatch',
        field: 'requiresAudio',
        requested: true,
        delivered: false,
      },
      {
        code: 'requested_output_mismatch',
        field: 'videoCodec',
        requested: 'hevc',
        delivered: 'h264',
      },
    ]);
  });

  it('separates malformed/truncated media from missing tools and arbitrary tool errors', async () => {
    for (const stderr of ['Invalid data found when processing input', 'truncated image file']) {
      const result = await inspectOutput(png, 'image/png', {
        ...tools,
        run: async () => ({ stdout: '', stderr, exitCode: 1 }),
      });
      expect(result).toMatchObject({
        metadata: { status: 'invalid', reason: 'invalid_media' },
        decode: { status: 'failed' },
        conformance: { status: 'nonconformant' },
      });
    }
    const truncated = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run: fixtureRun(videoMetadata(), {
        stdout: '',
        stderr: 'Error while decoding stream https://private.invalid/asset',
        exitCode: 1,
      }),
    });
    expect(truncated.decode).toEqual({
      status: 'failed',
      coverage: 'none',
      reason: 'decode_rejected',
    });
    expect(JSON.stringify(truncated)).not.toContain('private.invalid');
    const unknown = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run: fixtureRun(videoMetadata(), {
        stdout: '',
        stderr: 'missing decoder private provider URL',
        exitCode: 1,
      }),
    });
    expect(unknown.decode).toMatchObject({ status: 'unknown', reason: 'decoder_failed' });
    const absent = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run: async () => ({ stdout: '', stderr: '', exitCode: 'ENOENT' }),
    });
    expect(absent.metadata).toEqual({ status: 'unavailable', reason: 'tool_unavailable' });
  });

  it('rejects incomplete, excessive, timed-out and unrecognized reports without false failure evidence', async () => {
    for (const decoded of [
      success('frame=120\nprogress=continue\n'),
      success('progress=end\n'),
      { ...success('frame=120\nprogress=end\n'), killed: true },
      success('x'.repeat(512 * 1024 + 1)),
    ]) {
      const result = await inspectOutput(png, 'video/mp4', {
        ...tools,
        run: fixtureRun(videoMetadata(), decoded),
      });
      expect(result.decode.status).toBe('unknown');
      expect(result.conformance.status).toBe('unknown');
    }
    const invalidJson = await inspectOutput(png, 'video/mp4', {
      ...tools,
      run: async () => success('not JSON https://private.invalid'),
    });
    expect(invalidJson.metadata).toEqual({ status: 'unknown', reason: 'inspection_unavailable' });
    expect(JSON.stringify(invalidJson)).not.toContain('private.invalid');
  });

  it('stops before decode for excessive dimensions/duration and unsupported stream layouts', async () => {
    for (const metadata of [
      videoMetadata({ width: 32768, height: 32768 }),
      videoMetadata({ duration: '601' }),
    ]) {
      const run = fixtureRun(metadata);
      const result = await inspectOutput(png, 'video/mp4', { ...tools, run });
      expect(result.decode).toMatchObject({ status: 'unknown', reason: 'decode_resource_limit' });
      expect(run).toHaveBeenCalledOnce();
    }
    const run = fixtureRun({ streams: [...videoMetadata().streams, ...videoMetadata().streams] });
    expect((await inspectOutput(png, 'video/mp4', { ...tools, run })).metadata.reason).toBe(
      'unsupported_stream_layout',
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('retains only explicit bounded checker attribution and does not manufacture gateway moderation coverage', async () => {
    const safety = {
      status: 'unknown',
      checkedBy: 'provider',
      method: 'provider-response:v1',
      checkedAt: '2026-11-04T00:00:00.000Z',
    } as const;
    const result = await inspectOutput(png, 'image/png', {
      contentSafety: safety,
      declared: { width: 1, raw: 'https://private.invalid' } as InspectionOptions['declared'],
    });
    expect(result.contentSafety).toEqual(safety);
    expect(JSON.stringify(result)).not.toContain('private.invalid');
    expect(
      (
        await inspectOutput(png, 'image/png', {
          contentSafety: { ...safety, method: 'https://private.invalid' },
        })
      ).contentSafety,
    ).toEqual({ status: 'not_checked', checkedBy: null });
  });

  it('assesses observed retained count without counting missing output slots as delivered', () => {
    expect(assessOutputCount(2, 1)).toEqual({
      status: 'nonconformant',
      notices: [
        { code: 'requested_output_mismatch', field: 'outputCount', requested: 2, delivered: 1 },
      ],
    });
    expect(assessOutputCount(1, 1)).toEqual({ status: 'conformant', notices: [] });
    expect(() => assessOutputCount(1, Infinity)).toThrow(/count/);
    expect(() => assessOutputCount(1, -1)).toThrow(/count/);
  });
});
