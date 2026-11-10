import { randomUUID, createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { OutputAsset } from '@media-router/contracts';
import type { AssetStore } from '../packages/engine/src/storage.js';
import {
  archiveOutputs,
  collectOutputBytes,
  detectedMediaType,
  readPublicAsset,
} from '../packages/engine/src/output.js';
import { parseC2paReport, verifyC2pa } from '../packages/engine/src/provenance.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const providerAsset: OutputAsset = {
  url: 'https://outputs.example.com/result.png',
  mediaType: 'image/png',
  fidelity: 'unverified',
};
const report = (state: string) => ({
  active_manifest: 'urn:example:manifest',
  manifests: { 'urn:example:manifest': { signature_info: { issuer: 'Synthetic signer' } } },
  validation_state: state,
  validation_results: {
    activeManifest: {
      success: [{ code: 'claimSignature.validated' }],
      informational: [],
      failure: [] as { code: string }[],
    },
  },
});

describe('bounded output delivery', () => {
  it('enforces byte limits while streaming and detects supported signatures without claiming fidelity', async () => {
    expect(detectedMediaType(png)).toBe('image/png');
    expect(detectedMediaType(Buffer.from('<svg onload="alert(1)">'))).toBeNull();
    await expect(
      collectOutputBytes(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10),
    ).rejects.toThrow(/limit/);
    await expect(collectOutputBytes(Readable.from([]), 10)).rejects.toThrow(/empty/);
    expect(
      (await collectOutputBytes(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]), 10)).length,
    ).toBe(10);
  });
  it('binds download credentials to explicit hosts before any lookup or request', async () => {
    let lookedUp = false;
    const resolve = async () => {
      lookedUp = true;
      return [{ address: '1.1.1.1', family: 4 }];
    };
    await expect(
      readPublicAsset('https://evil.example/output', {
        headers: { Authorization: 'synthetic' },
        credentialHosts: ['.replicate.delivery'],
        resolve,
      }),
    ).rejects.toThrow(/not permitted/);
    expect(lookedUp).toBe(false);
    await expect(
      readPublicAsset('https://replicate.delivery/output', {
        headers: { Host: 'internal.example' },
        credentialHosts: ['.replicate.delivery'],
        resolve,
      }),
    ).rejects.toThrow(/Unsupported/);
    expect(lookedUp).toBe(false);
    await expect(
      readPublicAsset('https://outputs.example.com/result.png', { maxBytes: Infinity }),
    ).rejects.toThrow(/limit/);
  });
  it('retains exact bytes privately, includes their hash, and keeps C2PA/fidelity unknown without a verifier', async () => {
    const jobId = randomUUID();
    let saved: Uint8Array | undefined;
    const storage = {
      putOutput: async ({ bytes }: { bytes: Uint8Array }) => {
        saved = bytes;
        return {
          ...providerAsset,
          url: 'https://signed.example/temporary',
          storageKey: `outputs/${jobId}/${randomUUID()}.png`,
        };
      },
    } as unknown as AssetStore;
    const result = await archiveOutputs(jobId, [providerAsset], storage, {
      download: async () => png,
      provenance: { toolPath: '' },
    });
    expect(result.deliveryStatus).toBe('available');
    expect(Buffer.from(saved!)).toEqual(png);
    expect(result.outputs[0]).toMatchObject({
      sha256: createHash('sha256').update(png).digest('hex'),
      byteLength: png.length,
      fidelity: 'unverified',
      c2pa: { status: 'unavailable' },
    });
    expect(result.outputs[0]!.url).not.toBe(providerAsset.url);
  });
  it('separates missing storage and delivery failure from upstream generation status', async () => {
    expect(await archiveOutputs(randomUUID(), [providerAsset])).toMatchObject({
      outputs: [],
      deliveryStatus: 'failed',
    });
    const storage = {
      putOutput: async () => {
        throw new Error('must not run');
      },
    } as unknown as AssetStore;
    const failed = await archiveOutputs(randomUUID(), [providerAsset], storage, {
      download: async () => {
        throw new Error('synthetic private URL detail');
      },
    });
    expect(failed).toEqual({
      outputs: [],
      deliveryStatus: 'failed',
      deliveryErrors: [{ index: 0, code: 'output_delivery_failed' }],
    });
    expect(JSON.stringify(failed)).not.toContain('private URL');
  });
  it('reads existing owned output keys via storage and refuses another job prefix', async () => {
    const jobId = randomUUID(),
      key = `outputs/${jobId}/${randomUUID()}.png`;
    let reads = 0;
    const storage = {
      bucket: 'private',
      client: {
        send: async () => {
          reads++;
          return { Body: Readable.from([png]), ContentLength: png.length };
        },
      },
      sign: async (storageKey: string) => ({
        ...providerAsset,
        storageKey,
        url: 'https://signed.example/new',
      }),
    } as unknown as AssetStore;
    const result = await archiveOutputs(jobId, [{ ...providerAsset, storageKey: key }], storage, {
      provenance: { toolPath: '' },
    });
    expect(result.deliveryStatus).toBe('available');
    expect(reads).toBe(1);
    expect(
      (await archiveOutputs(randomUUID(), [{ ...providerAsset, storageKey: key }], storage))
        .deliveryStatus,
    ).toBe('failed');
    expect(reads).toBe(1);
  });
});

describe('C2PA evidence boundaries', () => {
  it('requires explicit verifier validity and configured trust, even when legacy errors are empty', () => {
    expect(parseC2paReport({ validation_status: [] })).toMatchObject({ status: 'unknown' });
    expect(parseC2paReport(report('Valid'))).toMatchObject({
      status: 'valid',
      signer: 'Synthetic signer',
    });
    expect(parseC2paReport(report('Trusted'))).toMatchObject({ status: 'valid' });
    expect(parseC2paReport(report('Trusted'), true)).toMatchObject({ status: 'trusted' });
    expect(parseC2paReport(report('Invalid'), true)).toMatchObject({ status: 'invalid' });
    const contradictory = report('Trusted');
    contradictory.validation_results.activeManifest.failure.push({
      code: 'assertion.dataHash.mismatch',
    });
    expect(parseC2paReport(contradictory, true)).toMatchObject({ status: 'invalid' });
  });
  it('does not launch a configured verifier unless network isolation is asserted', async () => {
    let called = false;
    const value = await verifyC2pa(png, 'image/png', {
      toolPath: '/trusted/c2patool',
      networkIsolated: false,
      run: async () => {
        called = true;
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    expect(value).toMatchObject({ status: 'unavailable', reason: 'network_isolation_required' });
    expect(called).toBe(false);
  });
  it('isolates files/environment, bounds execution and treats absent/error/timeout distinctly', async () => {
    const verified = await verifyC2pa(png, 'image/png', {
      toolPath: '/trusted/c2patool',
      networkIsolated: true,
      run: async (path, args, options) => {
        expect(path).toBe('/trusted/c2patool');
        expect(args[1]).toBe('--settings');
        expect(options.timeout).toBe(15000);
        expect(options.maxBuffer).toBe(2 * 1024 * 1024);
        expect(options.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
        expect(options.env).not.toHaveProperty('MR_VAULT_KEY');
        expect((await stat(args[0]!)).mode & 0o777).toBe(0o600);
        const settings = JSON.parse(await readFile(args[2]!, 'utf8'));
        expect(settings.core.allowed_network_hosts).toEqual([]);
        expect(settings.verify.remote_manifest_fetch).toBe(false);
        expect(settings.verify.ocsp_fetch).toBe(false);
        return { stdout: JSON.stringify(report('Valid')), stderr: '', exitCode: 0 };
      },
    });
    expect(verified.status).toBe('valid');
    const absent = await verifyC2pa(png, 'image/png', {
      toolPath: '/trusted/c2patool',
      networkIsolated: true,
      run: async () => ({ stdout: '', stderr: 'Error: No claim found\n', exitCode: 1 }),
    });
    expect(absent.status).toBe('absent');
    const timedOut = await verifyC2pa(png, 'image/png', {
      toolPath: '/trusted/c2patool',
      networkIsolated: true,
      run: async () => ({
        stdout: JSON.stringify(report('Trusted')),
        stderr: '',
        exitCode: 1,
        killed: true,
      }),
    });
    expect(timedOut.status).toBe('unknown');
    const unsupported = await verifyC2pa(png, 'image/png', {
      toolPath: '/trusted/c2patool',
      networkIsolated: true,
      run: async () => ({ stdout: 'not json', stderr: '', exitCode: 0 }),
    });
    expect(unsupported.status).toBe('unknown');
  });
});
