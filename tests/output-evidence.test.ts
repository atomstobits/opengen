import { expect, it } from 'vitest';
import { projectOutputEvidence } from '../packages/engine/src/output-evidence.js';

const inspection = {
  metadata: { status: 'available', reason: 'https://provider.example/secret' },
  decode: { status: 'passed', coverage: 'full', report: 'private report' },
  measured: {
    width: 1280,
    height: 720,
    durationSeconds: 5,
    hasAudio: true,
    videoCodec: 'h264',
    audioCodec: 'aac',
    frameCount: 120,
  },
  conformance: { status: 'conformant', notices: [] as unknown[] },
  contentSafety: { status: 'not_checked', checkedBy: null },
};
it('preserves bounded useful evidence and excludes receipt/report/source descriptors', () => {
  const result = projectOutputEvidence([
    {
      index: 0,
      outputIndex: 0,
      state: 'available',
      source_url: 'https://provider.example/secret',
      storageKey: 'private',
      inspection,
    },
  ]);
  expect(result).toEqual([
    {
      index: 0,
      outputIndex: 0,
      state: 'available',
      inspection: {
        metadata: { status: 'available' },
        decode: { status: 'passed', coverage: 'full' },
        measured: inspection.measured,
        conformance: { status: 'conformant', notices: [] },
        contentSafety: { status: 'not_checked', checkedBy: null },
      },
    },
  ]);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('report');
});
it('retains mismatch notices for failed slots even when no output capability exists', () => {
  const result = projectOutputEvidence([
    {
      index: 3,
      outputIndex: null,
      state: 'failed',
      code: 'output_nonconformant',
      inspection: {
        ...inspection,
        conformance: {
          status: 'nonconformant',
          notices: [
            {
              code: 'requested_output_mismatch',
              field: 'requiresAudio',
              requested: true,
              delivered: false,
              source_url: 'https://provider.example/secret',
            },
            {
              code: 'requested_output_mismatch',
              field: 'durationSeconds',
              requested: 5,
              delivered: 2,
            },
          ],
        },
      },
    },
  ]);
  expect(result[0]).toMatchObject({
    index: 3,
    state: 'failed',
    outputIndex: null,
    code: 'output_nonconformant',
    inspection: {
      conformance: {
        status: 'nonconformant',
        notices: [
          {
            code: 'requested_output_mismatch',
            field: 'requiresAudio',
            requested: true,
            delivered: false,
          },
          {
            code: 'requested_output_mismatch',
            field: 'durationSeconds',
            requested: 5,
            delivered: 2,
          },
        ],
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('keeps missing, malformed or unavailable inspection unknown', () => {
  const [result] = projectOutputEvidence([
    { index: 1, state: 'pending', code: 'raw private provider error' },
  ]);
  expect(result).toMatchObject({
    index: 1,
    state: 'pending',
    outputIndex: null,
    inspection: {
      decode: { status: 'unknown', coverage: 'none' },
      metadata: { status: 'unknown' },
      measured: {
        width: null,
        height: null,
        durationSeconds: null,
        hasAudio: null,
        videoCodec: null,
        audioCodec: null,
        frameCount: null,
      },
      contentSafety: { status: 'unknown', checkedBy: null },
    },
  });
  expect(result).not.toHaveProperty('code');
});
it.each([{ decode: { status: 'failed', coverage: 'full' } }, { metadata: { status: 'invalid' } }])(
  'does not promote known malformed/undecodable media to passed %#',
  (override) => {
    const [result] = projectOutputEvidence([
      { index: 0, outputIndex: 0, state: 'available', inspection: { ...inspection, ...override } },
    ]);
    expect(result?.inspection.decode).toEqual({ status: 'failed', coverage: 'none' });
    expect(result?.inspection.conformance.status).toBe('nonconformant');
  },
);
it('does not turn a metadata probe or incomplete decode into full decoding', () => {
  const [result] = projectOutputEvidence([
    {
      index: 0,
      state: 'available',
      inspection: { ...inspection, decode: { status: 'passed', coverage: 'none' } },
    },
  ]);
  expect(result?.inspection.decode).toEqual({ status: 'unknown', coverage: 'none' });
  expect(result?.inspection.conformance.status).toBe('unknown');
});
it('bounds dimensions/counts/duration and drops unsafe codecs and notice values', () => {
  const [result] = projectOutputEvidence([
    {
      index: 0,
      state: 'failed',
      code: 'output_decode_failed',
      inspection: {
        ...inspection,
        measured: {
          width: 32769,
          height: NaN,
          durationSeconds: Infinity,
          hasAudio: 'yes',
          videoCodec: 'https://provider.example/secret',
          audioCodec: 'secret\n',
          frameCount: 36_000_001,
        },
        conformance: {
          status: 'unknown',
          notices: [
            { code: 'raw provider secret', field: 'source_url', delivered: 'secret' },
            {
              code: 'requested_output_mismatch',
              field: 'videoCodec',
              delivered: 'https://provider.example/secret',
              requested: 'H264',
            },
          ],
        },
      },
    },
  ]);
  expect(result?.inspection.measured).toEqual({
    width: null,
    height: null,
    durationSeconds: null,
    hasAudio: null,
    videoCodec: null,
    audioCodec: null,
    frameCount: null,
  });
  expect(result?.inspection.conformance.notices).toEqual([
    { code: 'requested_output_mismatch', field: 'videoCodec', requested: 'H264' },
  ]);
  expect(JSON.stringify(result)).not.toContain('secret');
});
it('keeps checker identity and dates while dropping unchecked safety strings', () => {
  const [result] = projectOutputEvidence([
    {
      index: 0,
      state: 'available',
      inspection: {
        ...inspection,
        contentSafety: {
          status: 'passed',
          checkedBy: 'provider',
          checkedAt: '2026-11-04T00:00:00.000Z',
          method: 'private-token',
          report: 'private report',
        },
      },
    },
  ]);
  expect(result?.inspection.contentSafety).toEqual({
    status: 'passed',
    checkedBy: 'provider',
    checkedAt: '2026-11-04T00:00:00.000Z',
  });
  const [invalid] = projectOutputEvidence([
    {
      index: 0,
      state: 'available',
      inspection: {
        ...inspection,
        contentSafety: { status: 'passed', checkedBy: 'provider', checkedAt: 'unknown' },
      },
    },
  ]);
  expect(invalid?.inspection.contentSafety).toEqual({ status: 'unknown', checkedBy: null });
});
it('bounds slot/notice arrays, rejects bad indices and keeps first duplicate slot', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    index,
    state: 'available',
    outputIndex: index,
    inspection: {
      ...inspection,
      conformance: { status: 'unknown', notices: Array(30).fill({ code: 'full_decode_unknown' }) },
    },
  }));
  const result = projectOutputEvidence(rows);
  expect(result).toHaveLength(20);
  expect(result[0]?.inspection.conformance.notices).toHaveLength(20);
  expect(
    projectOutputEvidence([
      { index: -1, state: 'failed' },
      { index: '0', state: 'failed' },
      { index: 0, state: 'expired' },
      { index: 0, state: 'available' },
    ]),
  ).toMatchObject([{ index: 0, state: 'expired', outputIndex: null }]);
  expect(projectOutputEvidence({ receipts: rows })).toEqual([]);
});
