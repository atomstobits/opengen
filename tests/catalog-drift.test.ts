import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { runDriftCli } from '../packages/catalog/src/maintenance/drift-cli';
import { catalog, quote, validateCatalog } from '@media-router/catalog';
import { canonicalModelId } from '@media-router/contracts';
import {
  diffDriftSnapshots,
  driftLimits,
  importDriftSnapshot,
  sha256,
} from '../packages/catalog/src/maintenance/drift';

const fixtures = resolve('tests/fixtures/catalog-maintenance');
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'opengen-catalog-drift-'));
  temporary.push(dir);
  const manifest = JSON.parse(await readFile(join(fixtures, 'baseline.json'), 'utf8'));
  for (const entry of manifest.entries)
    await writeFile(
      join(dir, entry.source.path),
      await readFile(join(fixtures, entry.source.path)),
    );
  const path = join(dir, 'manifest.json');
  const save = () => writeFile(path, JSON.stringify(manifest));
  await save();
  return { dir, manifest, path, save };
}

describe('bounded read-only catalog drift evidence', () => {
  it('reports exact-endpoint addition/removal, defaults, bounds, capabilities, deprecation and tariff dimensions', async () => {
    const before = await importDriftSnapshot(join(fixtures, 'baseline.json'));
    const after = await importDriftSnapshot(join(fixtures, 'candidate.json'));
    const report = diffDriftSnapshots(before, after);
    expect(report.disposition).toBe('review-required');
    expect(new Set(report.changes.map((v) => v.category))).toEqual(
      new Set([
        'endpoint',
        'default',
        'bound',
        'schema',
        'deprecation',
        'capability',
        'region',
        'tariff',
        'unit',
        'rounding',
        'account-scope',
        'source',
      ]),
    );
    expect(report.changes).toContainEqual(
      expect.objectContaining({
        path: '/inputSchema/properties/duration/default',
        before: 5,
        after: 6,
      }),
    );
    expect(report.changes).toContainEqual(
      expect.objectContaining({
        path: '/inputSchema/properties/prompt/minLength',
        kind: 'removed',
        before: 1,
        after: null,
        afterPresent: false,
      }),
    );
    expect(report.changes).toContainEqual(
      expect.objectContaining({
        path: '/capabilities/audio',
        before: true,
        after: null,
        afterPresent: true,
      }),
    );
    expect(
      report.changes
        .filter((v) => v.category === 'endpoint')
        .map((v) => [v.kind, v.identity.endpointId]),
    ).toEqual([
      ['removed', 'minimax/h3-max-turbo/text-to-video'],
      ['added', 'minimax/h3-max/image-to-video'],
    ]);
    expect(report.notices.join(' ')).toContain('Missing observation is not proof of retirement');
    expect(report.observations[0]?.before).toMatchObject({
      checkedAt: '2026-11-03',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      url: expect.stringContaining('https://fal.ai/'),
    });
    expect(report.observations[0]?.beforeFactsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.candidate.evidenceKind).toBe('synthetic');
  });

  it('does not fetch, mutate the catalog, promote routes or alter evidence files', async () => {
    const fetch = vi.fn(() => {
      throw new Error('network is forbidden');
    });
    vi.stubGlobal('fetch', fetch);
    const names = (await readdir(fixtures)).sort();
    const hashes = await Promise.all(
      names.map(async (name) => sha256(await readFile(join(fixtures, name)))),
    );
    const catalogBefore = JSON.stringify(catalog);
    const input = {
      modelId: 'minimax/h3-max',
      operation: 'text-to-video' as const,
      input: { prompt: 'Synthetic check.', duration: 5, resolution: '480p' },
    };
    const quoteBefore = quote(input);
    const snapshot = await importDriftSnapshot(join(fixtures, 'baseline.json'));
    expect(diffDriftSnapshots(snapshot, snapshot)).toMatchObject({
      disposition: 'no-change',
      changes: [],
    });
    expect(
      diffDriftSnapshots(snapshot, await importDriftSnapshot(join(fixtures, 'candidate.json')))
        .disposition,
    ).toBe('review-required');
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(catalog)).toBe(catalogBefore);
    expect(quote(input)).toEqual(quoteBefore);
    expect(canonicalModelId('fal/h3-max')).toBe('minimax/h3-max');
    expect(catalog.models.find((v) => v.id === 'minimax/h3-max')?.authorProviderIds).toContain(
      'minimax',
    );
    expect(validateCatalog()).toEqual([]);
    expect(
      await Promise.all(names.map(async (name) => sha256(await readFile(join(fixtures, name))))),
    ).toEqual(hashes);
  });

  it('preserves unknown facts and distinguishes absent defaults from explicit null', async () => {
    const box = await sandbox();
    const before = await importDriftSnapshot(box.path);
    const first = box.manifest.entries[0];
    expect(
      before.observations.find((v) => v.identity.endpointId === first.identity.endpointId)?.facts
        .region.endpointRegion,
    ).toBeNull();
    const raw = JSON.parse(await readFile(join(box.dir, first.source.path), 'utf8'));
    raw.input_schema.properties.prompt.default = null;
    const data = JSON.stringify(raw);
    await writeFile(join(box.dir, first.source.path), data);
    first.source.sha256 = sha256(data);
    await box.save();
    const report = diffDriftSnapshots(before, await importDriftSnapshot(box.path));
    expect(report.changes).toContainEqual(
      expect.objectContaining({
        category: 'default',
        kind: 'added',
        before: null,
        after: null,
        beforePresent: false,
        afterPresent: true,
      }),
    );
  });

  it('rejects tampering and source URLs that contain credentials or secret query parameters', async () => {
    const box = await sandbox();
    box.manifest.entries[0].source.sha256 = '0'.repeat(64);
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('hash mismatch');
    box.manifest.entries[0].source.url = 'https://user:secret@fal.ai/docs';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('credential-free HTTPS');
    box.manifest.entries[0].source.url = 'https://fal.ai/docs?token=secret';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('credential-free HTTPS');
  });

  it.each(['2026-02-30', 'yesterday', '2026-11-04T00:00:00Z'])(
    'rejects invalid evidence date %s',
    async (date) => {
      const box = await sandbox();
      box.manifest.entries[0].source.checkedAt = date;
      await box.save();
      await expect(importDriftSnapshot(box.path)).rejects.toThrow('ISO date');
    },
  );

  it('accepts only one OpenAPI endpoint_id matching the explicit scoped endpoint', async () => {
    const box = await sandbox();
    const entry = box.manifest.entries[0];
    const base = 'https://fal.ai/api/openapi/queue/openapi.json';
    entry.source.url = `${base}?endpoint_id=${encodeURIComponent(entry.identity.endpointId)}`;
    await box.save();
    await expect(importDriftSnapshot(box.path)).resolves.toMatchObject({
      evidenceKind: 'synthetic',
    });
    entry.source.url = `${base}?endpoint_id=unreviewed%2Fendpoint`;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('match exact endpoint once');
    entry.source.url = `${base}?endpoint_id=${encodeURIComponent(entry.identity.endpointId)}&endpoint_id=duplicate`;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('match exact endpoint once');
  });

  it('rejects relabeling synthetic evidence as documented evidence', async () => {
    const box = await sandbox();
    const before = await importDriftSnapshot(box.path);
    box.manifest.evidenceKind = 'documented';
    await box.save();
    const after = await importDriftSnapshot(box.path);
    expect(() => diffDriftSnapshots(before, after)).toThrow(
      'fixture provenance cannot be promoted',
    );
  });

  it('requires opaque private scope references, decimal rates and valid retirement dates', async () => {
    const box = await sandbox();
    const facts = box.manifest.entries[0].facts;
    facts.tariff.accountScope = 'private-byok';
    facts.tariff.accountRef = 'Customer email@example.com';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('opaque');
    facts.tariff.accountRef = 'synthetic-account-A';
    facts.tariff.rate = '-0.05';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('decimal');
    facts.tariff.rate = '0.05';
    facts.retirement.retirementAt = '2026-02-30';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('ISO date');
    facts.retirement.retirementAt = null;
    facts.tariff.accountScope = null;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('unknown scope');
  });

  it('rejects private-rate provenance from public scope and unknown runtime flags', async () => {
    const box = await sandbox();
    box.manifest.entries[0].facts.tariff.accountRef = 'synthetic-private-account';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('public-list');
    box.manifest.entries[0].facts.tariff.accountRef = null;
    box.manifest.entries[0].facts.executable = true;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('unsupported fields');
  });

  it('rejects inferred regions, derivatives, duplicate observations and changed comparison scope', async () => {
    const box = await sandbox();
    const baseline = await importDriftSnapshot(box.path);
    box.manifest.entries[0].identity = {
      ...box.manifest.entries[0].identity,
      deploymentId: 'fal-eu-inferred',
    };
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('unscoped');
    box.manifest.entries[0].identity = box.manifest.scope[0];
    box.manifest.entries.push(box.manifest.entries[0]);
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('duplicate');
    box.manifest.entries.pop();
    box.manifest.scope[2] = { ...box.manifest.scope[2], modelId: 'unreviewed/derivative' };
    await box.save();
    const candidate = await importDriftSnapshot(box.path);
    expect(() => diffDriftSnapshots(baseline, candidate)).toThrow('same exact endpoint scope');
  });

  it('rejects traversal, absolute paths and symlinks outside evidence directory', async () => {
    const box = await sandbox();
    const outside = await sandbox();
    const path = join(outside.dir, outside.manifest.entries[0].source.path);
    box.manifest.entries[0].source.path = path;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('relative');
    await symlink(path, join(box.dir, 'escaped.json'));
    box.manifest.entries[0].source.path = 'escaped.json';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('escapes');
    box.manifest.entries[0].source.path = `../${outside.dir.split('/').at(-1)}/${outside.manifest.entries[0].source.path}`;
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('escapes');
  });

  it('bounds bytes, JSON complexity and endpoint counts', async () => {
    const box = await sandbox();
    await writeFile(box.path, ' '.repeat(driftLimits.manifestBytes + 1));
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('size');
    await box.save();
    const first = box.manifest.entries[0];
    await writeFile(join(box.dir, first.source.path), ' '.repeat(driftLimits.artifactBytes + 1));
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('size');
    box.manifest.scope = Array.from({ length: 33 }, (_, i) => ({
      ...box.manifest.scope[0],
      endpointId: `synthetic/endpoint-${i}`,
    }));
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('1..32');
    await writeFile(box.path, '{"nested":'.repeat(30) + 'null' + '}'.repeat(30));
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('complexity');
  });

  it('requires explicit present local input-schema pointers', async () => {
    const box = await sandbox();
    box.manifest.entries[0].inputSchemaPointer = '/missing';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('missing');
    box.manifest.entries[0].inputSchemaPointer = 'https://fal.ai/schema';
    await box.save();
    await expect(importDriftSnapshot(box.path)).rejects.toThrow('local JSON pointer');
    box.manifest.entries[0].inputSchemaPointer = null;
    await box.save();
    const snapshot = await importDriftSnapshot(box.path);
    expect(
      snapshot.observations.find(
        (v) => v.identity.endpointId === box.manifest.entries[0].identity.endpointId,
      )?.facts.inputSchema,
    ).toBeNull();
  });

  it('CLI emits JSON and meaningful statuses without apply/write options', async () => {
    const run = async (...args: string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const status = await runDriftCli(
        args,
        (value) => stdout.push(value),
        (value) => stderr.push(value),
      );
      return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
    };
    const before = join(fixtures, 'baseline.json');
    expect((await run(before, before)).status).toBe(0);
    const changed = await run(before, join(fixtures, 'candidate.json'));
    expect(changed.status).toBe(2);
    expect(JSON.parse(changed.stdout).disposition).toBe('review-required');
    expect((await run(before, before, '--apply')).status).toBe(1);
    expect((await run('/missing.json', before)).stderr).toBe(
      'Catalog drift: evidence could not be read',
    );
  });
});
