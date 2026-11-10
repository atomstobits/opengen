import { afterEach, describe, expect, it } from 'vitest';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  legalDraftNotice,
  legalPolicies,
  legalPolicyMarkdown,
} from '@media-router/contracts/legal-policies';
import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  LEGAL_POLICIES_SOURCE_GIT_BLOB,
  LEGAL_POLICIES_SOURCE_SHA256,
  publishedLegalPolicyMarkdown,
} from '@media-router/contracts/hosted-legal-publication';
import { currentHumanTermsPolicy } from '../apps/server/src/terms-login';
import {
  HOSTED_LEGAL_BASE,
  canonicalLegalBody,
  hostedLegalCandidateFiles,
  prepareHostedLegalCandidate,
  publicationBodyMarkdown,
  verifySharedLegalPoliciesModule,
} from '../scripts/prepare-hosted-legal-candidate';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const directories: string[] = [];
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const versions = {
  terms: 'hosted-terms-v4-2026-11-09',
  refunds: 'hosted-refunds-v4-2026-11-09',
  privacy: 'hosted-privacy-v4-2026-11-09',
  'data-processing': 'business-dpa-template-v2-2026-11-09',
  subprocessors: 'business-subprocessors-template-v2-2026-11-09',
} as const;

async function temporary() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opengen-legal-candidate-')));
  directories.push(directory);
  return directory;
}

async function listFiles(directory: string, prefix = ''): Promise<string[]> {
  const output: string[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + item.name;
    expect(item.isSymbolicLink(), path).toBe(false);
    if (item.isDirectory()) {
      output.push(...(await listFiles(join(directory, item.name), path + '/')));
    } else {
      expect(item.isFile(), path).toBe(true);
      output.push(path);
    }
  }
  return output.sort();
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('deterministic hosted legal candidate packet', () => {
  it('freezes five approved source copies, unchanged bodies, semantic bytes and publication copies without requiring git', async () => {
    const directory = await temporary();
    const sourceBefore = legalPolicies.map((policy) => legalPolicyMarkdown(policy));
    const draftBefore = currentHumanTermsPolicy();
    const result = await prepareHostedLegalCandidate({
      outputDirectory: join(directory, 'packet'),
    });

    expect(result.fileCount).toBe(22);
    expect(await listFiles(result.outputDirectory)).toEqual([...hostedLegalCandidateFiles]);
    expect(HOSTED_LEGAL_BASE).toEqual({
      policyModule: 'packages/contracts/src/legal-policies.ts',
      policyBlob: LEGAL_POLICIES_SOURCE_GIT_BLOB,
      policySha256: LEGAL_POLICIES_SOURCE_SHA256,
    });
    expect(result.manifest).toMatchObject({
      schemaVersion: 1,
      kind: 'hosted-legal-candidate',
      status: 'candidate-not-published',
      source: {
        sharedPolicyModule: {
          path: 'packages/contracts/src/legal-policies.ts',
          gitBlob: '0754e4fd1599aa37f4733ae8664429d99c10bdb2',
          sha256: '530402dabe02b58d68cfe5b92f9af71da098b18bbc19824f023a1f3d5d89fc32',
        },
      },
      authority: {
        approvalRecord: null,
        adoptionStatus: 'pending-owner-adoption-record',
        publishedAt: null,
        effectiveAt: null,
      },
      simulation: null,
    });
    expect(result.manifest.source.sharedPolicyModule.sha256).toBe(
      sha256(await readFile(join(root, HOSTED_LEGAL_BASE.policyModule))),
    );
    expect(result.manifest.overlay).toMatchObject({
      path: 'scripts/prepare-hosted-legal-candidate.ts',
      status: 'local-source-candidate-not-published',
      sha256: sha256(await readFile(join(root, 'scripts/prepare-hosted-legal-candidate.ts'))),
    });
    expect(result.manifest.source.archiveScope).toContain('not included');
    expect(result.manifest.effectiveTimeProposal).toMatchObject({
      status: 'pending-actual-publication',
      metadataReference: '/legal-publication.json',
    });
    expect(result.manifest.files).toHaveLength(21);

    for (const file of result.manifest.files) {
      const bytes = await readFile(join(result.outputDirectory, file.path));
      expect(file.sha256, file.path).toBe(sha256(bytes));
      expect(file.bytes, file.path).toBe(bytes.length);
      expect(file.mode, file.path).toBe('0644');
      if (process.platform !== 'win32') {
        expect((await lstat(join(result.outputDirectory, file.path))).mode & 0o777).toBe(0o644);
      }
      expect(bytes.toString('utf8'), file.path).not.toContain(root);
      expect(bytes.toString('utf8'), file.path).not.toContain(directory);
    }

    for (const [index, policy] of legalPolicies.entries()) {
      const spec = APPROVED_HOSTED_LEGAL_POLICIES[policy.slug];
      const source = await readFile(
        join(result.outputDirectory, `source/${policy.slug}.md`),
        'utf8',
      );
      const body = await readFile(
        join(result.outputDirectory, `publication-body/${policy.slug}.md`),
        'utf8',
      );
      const semantic = await readFile(
        join(result.outputDirectory, `semantic/${policy.slug}.json`),
        'utf8',
      );
      const publication = await readFile(
        join(result.outputDirectory, `publication/${policy.slug}.md`),
        'utf8',
      );
      const header =
        [`# ${policy.title}`, `> ${legalDraftNotice}`, `Review date: ${policy.reviewDate}`].join(
          '\n\n',
        ) + '\n\n';

      expect(source).toBe(sourceBefore[index]);
      expect(source).toBe(header + body);
      expect(JSON.parse(semantic)).toEqual({
        introduction: policy.introduction ?? null,
        sections: policy.sections,
      });
      expect(canonicalLegalBody(policy)).toBe(semantic);
      expect(publicationBodyMarkdown(policy)).toBe(body);
      expect(publishedLegalPolicyMarkdown(policy.slug)).toBe(publication);
      expect(publication.endsWith(body)).toBe(true);
      expect(publication).toContain(`Version: ${versions[policy.slug]}`);
      expect(publication).toContain('Publication and effective time: /legal-publication.json');

      const document = result.manifest.policies.find((item) => item.slug === policy.slug)!;
      expect(document.proposedVersion).toBe(versions[policy.slug]);
      expect(document.proposedVersion).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/);
      expect(document.sourceMarkdown).toEqual({
        path: `source/${policy.slug}.md`,
        sha256: spec.sourceMarkdownSha256,
        bytes: spec.sourceMarkdownBytes,
      });
      expect(document.approvedBodyMarkdown).toEqual({
        path: `publication-body/${policy.slug}.md`,
        sha256: spec.approvedBodyMarkdownSha256,
        bytes: spec.approvedBodyMarkdownBytes,
      });
      expect(document.semanticCanonical).toEqual({
        path: `semantic/${policy.slug}.json`,
        sha256: spec.semanticCanonicalSha256,
        bytes: spec.semanticCanonicalBytes,
        format: 'opengen-legal-body-json-v1',
      });
      expect(document.publicationMarkdown).toEqual({
        path: `publication/${policy.slug}.md`,
        sha256: spec.publicationMarkdownSha256,
        bytes: spec.publicationMarkdownBytes,
      });
      expect(document.sourceTitle).toBe(policy.title);
      expect(document.sourceReviewDate).toBe(policy.reviewDate);
      expect(document.mode).toBe(
        policy.slug === 'privacy'
          ? 'notice-pending-publication'
          : policy.slug === 'terms' || policy.slug === 'refunds'
            ? 'contract-pending-adoption'
            : 'available-template-not-executed',
      );
      if (document.mode === 'available-template-not-executed') {
        expect(publication).toContain('Availability: template only — not executed by publication.');
      }
    }

    const manifestBytes = await readFile(join(result.outputDirectory, 'manifest.json'));
    expect(result.manifestSha256).toBe(sha256(manifestBytes));
    expect(JSON.parse(manifestBytes.toString('utf8'))).toEqual(result.manifest);
    expect(legalPolicies.map((policy) => legalPolicyMarkdown(policy))).toEqual(sourceBefore);
    expect(currentHumanTermsPolicy()).toEqual(draftBefore);
    expect(currentHumanTermsPolicy()).toMatchObject({ status: 'draft', effectiveAt: null });
  });

  it('verifies legal-policies.ts SHA-256 and Git blob SHA-1 in archive copies without .git and rejects drift or symlinks', async () => {
    const directory = await temporary();
    const archiveCopy = join(directory, 'archive-copy');
    await mkdir(join(archiveCopy, 'packages/contracts/src'), { recursive: true });
    const originalBytes = await readFile(join(root, HOSTED_LEGAL_BASE.policyModule));
    const copiedPolicy = join(archiveCopy, HOSTED_LEGAL_BASE.policyModule);
    await writeFile(copiedPolicy, originalBytes);

    const verified = await verifySharedLegalPoliciesModule(archiveCopy);
    expect(verified.moduleSha256).toBe(
      '530402dabe02b58d68cfe5b92f9af71da098b18bbc19824f023a1f3d5d89fc32',
    );
    expect(verified.moduleBlob).toBe('0754e4fd1599aa37f4733ae8664429d99c10bdb2');

    await writeFile(copiedPolicy, Buffer.concat([originalBytes, Buffer.from('\n')]));
    await expect(verifySharedLegalPoliciesModule(archiveCopy)).rejects.toThrow(
      'Shared policy bytes differ',
    );

    const symlinkArchive = join(directory, 'symlink-archive');
    await mkdir(join(symlinkArchive, 'packages/contracts/src'), { recursive: true });
    await symlink(
      join(root, HOSTED_LEGAL_BASE.policyModule),
      join(symlinkArchive, HOSTED_LEGAL_BASE.policyModule),
    );
    await expect(verifySharedLegalPoliciesModule(symlinkArchive)).rejects.toThrow('symlinks');
  });

  it('produces byte-identical packets in different local directories without generating a publication time', async () => {
    const directory = await temporary();
    const one = await prepareHostedLegalCandidate({ outputDirectory: join(directory, 'one') });
    const two = await prepareHostedLegalCandidate({ outputDirectory: join(directory, 'two') });
    for (const path of hostedLegalCandidateFiles) {
      expect(await readFile(join(one.outputDirectory, path)), path).toEqual(
        await readFile(join(two.outputDirectory, path)),
      );
    }
    expect(one.manifestSha256).toBe(two.manifestSha256);
    expect(one.manifest.authority).toMatchObject({
      publishedAt: null,
      effectiveAt: null,
      approvalRecord: null,
    });
    expect(one.manifest).not.toHaveProperty('generatedAt');
    expect(one.manifest).not.toHaveProperty('createdAt');
  });

  it('changes only preview metadata when a simulated publication-time fixture changes', async () => {
    const directory = await temporary();
    const one = await prepareHostedLegalCandidate({
      outputDirectory: join(directory, 'one'),
      previewPublicationTime: '2026-11-09T20:00:00Z',
    });
    const two = await prepareHostedLegalCandidate({
      outputDirectory: join(directory, 'two'),
      previewPublicationTime: '2027-02-01T08:30:00.000Z',
    });
    for (const path of hostedLegalCandidateFiles.filter(
      (path) => path !== 'preview.html' && path !== 'manifest.json',
    )) {
      expect(await readFile(join(one.outputDirectory, path)), path).toEqual(
        await readFile(join(two.outputDirectory, path)),
      );
    }
    expect(one.manifest.policies).toEqual(two.manifest.policies);
    expect(one.manifest.simulation).toEqual({
      status: 'simulated-preview-only',
      publicationTimeFixture: '2026-11-09T20:00:00.000Z',
      isActualPublication: false,
    });
    expect(two.manifest.authority).toEqual(one.manifest.authority);
    expect(two.manifest.authority.publishedAt).toBeNull();
    expect(two.manifest.authority.effectiveAt).toBeNull();
    expect(await readFile(join(one.outputDirectory, 'preview.html'), 'utf8')).toContain(
      'SIMULATION ONLY',
    );
    expect(await readFile(join(one.outputDirectory, 'preview.html'), 'utf8')).toContain(
      '2026-11-09T20:00:00.000Z',
    );
    for (const document of one.manifest.policies) {
      expect(
        await readFile(join(one.outputDirectory, document.publicationMarkdown.path), 'utf8'),
      ).not.toContain('2026-11-09T20:00:00');
    }
  });

  it('renders an inert local candidate preview with no script, form, remote asset or invented effectiveness', async () => {
    const directory = await temporary();
    const result = await prepareHostedLegalCandidate({
      outputDirectory: join(directory, 'packet'),
    });
    const preview = await readFile(join(result.outputDirectory, 'preview.html'), 'utf8');
    expect(preview).toContain('CANDIDATE — NOT PUBLISHED, ADOPTED OR EFFECTIVE');
    expect(preview).toContain('no timestamp has been generated');
    expect(preview).toContain('not part of that source archive');
    expect(preview).toContain('default-src &#39;none&#39;');
    expect(preview).toContain('form-action &#39;none&#39;');
    expect(preview).not.toMatch(/<script\b|<form\b|<iframe\b|<img\b|<link\b|\son[a-z]+\s*=/i);
    expect(preview.match(/<article\s/g)).toHaveLength(5);
    expect(
      [...preview.matchAll(/<a\b[^>]*href="([^"]+)"/g)].every((match) => match[1]!.startsWith('#')),
    ).toBe(true);
    for (const policy of legalPolicies) {
      expect(preview).toContain(`id="${policy.slug}"`);
      expect(preview).toContain(versions[policy.slug]);
    }
  });

  it('refuses existing directories, files and symlink destinations without changing unrelated data', async () => {
    const directory = await temporary();
    const existing = join(directory, 'existing');
    await mkdir(existing);
    await writeFile(join(existing, 'keep.txt'), 'unrelated local content');
    await expect(prepareHostedLegalCandidate({ outputDirectory: existing })).rejects.toThrow();

    const file = join(directory, 'existing-file');
    await writeFile(file, 'keep this file');
    await expect(prepareHostedLegalCandidate({ outputDirectory: file })).rejects.toThrow();

    const linked = join(directory, 'destination-link');
    await symlink(existing, linked, 'dir');
    await expect(prepareHostedLegalCandidate({ outputDirectory: linked })).rejects.toThrow();

    expect(await readdir(existing)).toEqual(['keep.txt']);
    expect(await readFile(join(existing, 'keep.txt'), 'utf8')).toBe('unrelated local content');
    expect(await readFile(file, 'utf8')).toBe('keep this file');
    expect((await lstat(linked)).isSymbolicLink()).toBe(true);
  });

  it.each([
    'now',
    '2026-11-09',
    '2026-11-09T20:00:00+00:00',
    '2026-02-31T20:00:00.000Z',
    '2026-11-09T20:00:00.123456Z',
  ])('rejects ambiguous or invalid simulated publication time %s without output', async (time) => {
    const directory = await temporary();
    const outputDirectory = join(directory, 'packet');
    await expect(
      prepareHostedLegalCandidate({ outputDirectory, previewPublicationTime: time }),
    ).rejects.toThrow();
    await expect(access(outputDirectory)).rejects.toThrow();
  });

  it('rejects relative destinations and caller-supplied adoption/activation fields', async () => {
    await expect(
      prepareHostedLegalCandidate({ outputDirectory: 'relative-candidate' }),
    ).rejects.toThrow('absolute');
    const directory = await temporary();
    const outputDirectory = join(directory, 'packet');
    await expect(
      prepareHostedLegalCandidate({
        outputDirectory,
        effectiveAt: '2026-11-09T20:00:00Z',
      } as never),
    ).rejects.toThrow('only');
    await expect(access(outputDirectory)).rejects.toThrow();
  });

  it('runs the local Node22 CLI without accepting environment activation or echoing private paths', async () => {
    const directory = await temporary();
    const outputDirectory = join(directory, 'packet');
    const result = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/prepare-hosted-legal-candidate.ts',
        '--out-dir',
        outputDirectory,
      ],
      {
        cwd: root,
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH,
          OPENGEN_TERMS_STATUS: 'active',
          HOSTED_LEGAL_EFFECTIVE_AT: 'synthetic-private-environment-value',
        },
        timeout: 15000,
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'candidate-not-published',
      files: 22,
      publishedAt: null,
      effectiveAt: null,
    });
    expect(result.stdout).not.toContain(directory);
    expect(result.stdout).not.toContain(root);
    const manifest = await readFile(join(outputDirectory, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain('synthetic-private-environment-value');
    expect(JSON.parse(manifest).authority.effectiveAt).toBeNull();
  });
});
