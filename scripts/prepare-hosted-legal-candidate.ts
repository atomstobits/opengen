import { constants } from 'node:fs';
import { chmod, mkdir, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  legalPolicies,
  legalPolicyMarkdown,
  type LegalBlock,
} from '@media-router/contracts/legal-policies';
import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  HOSTED_LEGAL_POLICY_SLUGS,
  LEGAL_BODY_SEMANTIC_FORMAT,
  LEGAL_POLICIES_SOURCE_GIT_BLOB,
  LEGAL_POLICIES_SOURCE_MODULE_PATH,
  LEGAL_POLICIES_SOURCE_SHA256,
  LEGAL_PUBLICATION_METADATA_PATH,
  canonicalLegalBody,
  canonicalUtcIsoTimestamp,
  publicationBodyMarkdown,
  publishedLegalPolicyMarkdown,
} from '@media-router/contracts/hosted-legal-publication';

export { canonicalLegalBody, publicationBodyMarkdown };

export const HOSTED_LEGAL_BASE = Object.freeze({
  policyModule: LEGAL_POLICIES_SOURCE_MODULE_PATH,
  policyBlob: LEGAL_POLICIES_SOURCE_GIT_BLOB,
  policySha256: LEGAL_POLICIES_SOURCE_SHA256,
});

const scriptPath = 'scripts/prepare-hosted-legal-candidate.ts';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const gitBlobSha1 = (bytes: Uint8Array) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export const hostedLegalCandidateFiles = Object.freeze(
  [
    ...HOSTED_LEGAL_POLICY_SLUGS.flatMap((slug) => [
      `source/${slug}.md`,
      `publication-body/${slug}.md`,
      `semantic/${slug}.json`,
      `publication/${slug}.md`,
    ]),
    'preview.html',
    'manifest.json',
  ].sort(),
);

export interface HostedLegalCandidateOptions {
  outputDirectory: string;
  /** A display-only fixture, never actual publication/adoption/effectiveness. */
  previewPublicationTime?: string;
}

async function readRegular(path: string, limit = 1_000_000): Promise<Buffer> {
  if ((await realpath(path)) !== path) {
    throw new Error('Candidate source and tool inputs must not use symlinks.');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) {
      throw new Error('Candidate inputs must be bounded regular files.');
    }
    const bytes = await file.readFile();
    if (bytes.length > limit) {
      throw new Error('Candidate input exceeded its byte limit.');
    }
    return bytes;
  } finally {
    await file.close();
  }
}

export async function verifySharedLegalPoliciesModule(rootDirectory = repositoryRoot) {
  const root = await realpath(rootDirectory);
  const moduleBytes = await readRegular(join(root, HOSTED_LEGAL_BASE.policyModule));
  const moduleSha256 = sha256(moduleBytes);
  const moduleBlob = gitBlobSha1(moduleBytes);
  if (
    moduleSha256 !== HOSTED_LEGAL_BASE.policySha256 ||
    moduleBlob !== HOSTED_LEGAL_BASE.policyBlob
  ) {
    throw new Error(
      'Shared policy bytes differ from the exact approved base; prepare a separately reviewed copy delta first.',
    );
  }
  return { root, moduleBytes, moduleSha256, moduleBlob };
}

function previewTime(value: string | undefined) {
  if (value === undefined) return null;
  try {
    return canonicalUtcIsoTimestamp(value);
  } catch {
    throw new Error('Use an explicit valid UTC ISO fixture timestamp for the simulated preview.');
  }
}

const html = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

function blockHtml(block: LegalBlock) {
  if (block.type === 'paragraph') return `<p>${html(block.text)}</p>`;
  if (block.type === 'linkedParagraph')
    return `<p>${block.parts.map((part) => (typeof part === 'string' ? html(part) : `${html(part.label)} (${html(part.href)})`)).join('')}</p>`;
  if (block.type === 'list')
    return `<ul>${block.items.map((item) => `<li>${html(item)}</li>`).join('')}</ul>`;
  return `<div class="table"><table><thead><tr>${block.columns.map((column) => `<th scope="col">${html(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${row.map((cell) => `<td>${html(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const css =
  'body{margin:0;background:#10271e;color:#f5f2e8;font:17px/1.65 system-ui,sans-serif;overflow-wrap:anywhere}main{max-width:1040px;padding:32px;margin:auto}a{color:#ef91bf}aside{border:2px solid #ef91bf;padding:20px}article{margin:60px 0;padding-top:24px;border-top:1px solid #53715e}h1{font-size:42px;line-height:1.1}h2{font-size:30px}h3{font-size:22px}code,small{overflow-wrap:anywhere}.table{overflow-x:auto}table{border-collapse:collapse}th,td{padding:12px;border:1px solid #53715e;text-align:left;vertical-align:top}.mode{color:#ef91bf}nav{display:flex;gap:18px;flex-wrap:wrap}@media(max-width:600px){main{padding:18px}h1{font-size:32px}}';

function renderPreview(time: string | null) {
  const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="Content-Security-Policy" content="${html(csp)}"><title>Hosted legal candidate — local review only</title><style>${css}</style></head><body><main><aside role="note"><strong>CANDIDATE — NOT PUBLISHED, ADOPTED OR EFFECTIVE</strong><p>This local packet proposes exact copy and versions for owner review. It does not activate the hosted service or execute a customer DPA. Version dates identify copy revisions, not effective dates.</p><p>${time ? `SIMULATION ONLY — preview publication-time fixture: <code>${html(time)}</code>. This is not an actual publication or effective time.` : 'Actual publication UTC and effective time: pending the owner-controlled publication record; no timestamp has been generated.'}</p><p>Future metadata reference: <code>${LEGAL_PUBLICATION_METADATA_PATH}</code>. That reference is proposed wiring, not a claim that the qualified source or live host serves an adopted policy manifest.</p></aside><h1>Hosted legal publication candidate</h1><p>Approved shared policy module (<code>${HOSTED_LEGAL_BASE.policyModule}</code>): SHA-256 <code>${HOSTED_LEGAL_BASE.policySha256}</code>, blob <code>${HOSTED_LEGAL_BASE.policyBlob}</code>. This packet and exporter are a separate review overlay, not part of that source archive.</p><nav aria-label="Candidate documents">${legalPolicies.map((policy) => `<a href="#${policy.slug}">${html(APPROVED_HOSTED_LEGAL_POLICIES[policy.slug].title)}</a>`).join('')}</nav>${legalPolicies
    .map((policy) => {
      const candidate = APPROVED_HOSTED_LEGAL_POLICIES[policy.slug];
      return `<article id="${policy.slug}"><header><span class="mode">${html(candidate.candidateMode)}</span><h2>${html(candidate.title)}</h2><p>Proposed version: <code>${candidate.version}</code></p><p>Publication/effective metadata remains pending and separate from this immutable body.</p>${candidate.candidateMode === 'available-template-not-executed' ? '<p>Availability: template only — not executed by publication.</p>' : ''}</header>${policy.introduction ? `<p>${html(policy.introduction)}</p>` : ''}${policy.sections.map((section) => `<section><h3>${html(section.title)}</h3>${section.blocks.map(blockHtml).join('')}</section>`).join('')}</article>`;
    })
    .join('')}</main></body></html>\n`;
}

/** Read-only source verification and public-copy export. No network, activation or source mutation. */
export async function prepareHostedLegalCandidate(options: HostedLegalCandidateOptions) {
  if (
    Object.keys(options).some((key) => !['outputDirectory', 'previewPublicationTime'].includes(key))
  ) {
    throw new Error(
      'Candidate preparation accepts only a new output directory and an optional simulated preview timestamp.',
    );
  }
  if (!options.outputDirectory || !isAbsolute(options.outputDirectory)) {
    throw new Error('Choose a new absolute local output directory.');
  }
  const simulatedTime = previewTime(options.previewPublicationTime);
  const { root, moduleSha256, moduleBlob } = await verifySharedLegalPoliciesModule(repositoryRoot);
  const toolBytes = await readRegular(join(root, scriptPath));
  const files = new Map<string, Buffer>();
  const policyManifest = legalPolicies.map((policy) => {
    const proposed = APPROVED_HOSTED_LEGAL_POLICIES[policy.slug];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(proposed.version)) {
      throw new Error('Proposed versions must be bounded ASCII identifiers.');
    }
    const source = `source/${policy.slug}.md`;
    const body = `publication-body/${policy.slug}.md`;
    const canonical = `semantic/${policy.slug}.json`;
    const publication = `publication/${policy.slug}.md`;
    files.set(source, Buffer.from(legalPolicyMarkdown(policy)));
    files.set(body, Buffer.from(publicationBodyMarkdown(policy)));
    files.set(canonical, Buffer.from(canonicalLegalBody(policy)));
    files.set(publication, Buffer.from(publishedLegalPolicyMarkdown(policy.slug)));
    const record = (path: string) => ({
      path,
      sha256: sha256(files.get(path)!),
      bytes: files.get(path)!.length,
    });
    return {
      slug: policy.slug,
      proposedVersion: proposed.version,
      proposedTitle: proposed.title,
      mode: proposed.candidateMode,
      sourceTitle: policy.title,
      sourceReviewDate: policy.reviewDate,
      sourceMarkdown: record(source),
      approvedBodyMarkdown: record(body),
      semanticCanonical: { ...record(canonical), format: LEGAL_BODY_SEMANTIC_FORMAT },
      publicationMarkdown: record(publication),
    };
  });
  files.set('preview.html', Buffer.from(renderPreview(simulatedTime)));
  const records = [...files]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length, mode: '0644' }));
  const manifest = {
    schemaVersion: 1,
    kind: 'hosted-legal-candidate',
    status: 'candidate-not-published',
    source: {
      sharedPolicyModule: {
        path: HOSTED_LEGAL_BASE.policyModule,
        gitBlob: moduleBlob,
        sha256: moduleSha256,
      },
      archiveScope:
        'Base source attribution only. This candidate/exporter overlay is not included in the qualified base source archive.',
    },
    overlay: {
      path: scriptPath,
      sha256: sha256(toolBytes),
      status: 'local-source-candidate-not-published',
    },
    authority: {
      approvalRecord: null,
      adoptionStatus: 'pending-owner-adoption-record',
      publishedAt: null,
      effectiveAt: null,
    },
    effectiveTimeProposal: {
      status: 'pending-actual-publication',
      metadataReference: LEGAL_PUBLICATION_METADATA_PATH,
      mechanism:
        'Owner records one actual publication UTC timestamp only after verifying staged policy paths, proposed versions, exact publication/body hashes and the owner-approved publication manifest. The date in a proposed version identifies copy revision, not effectiveness. No preparation clock or simulated fixture supplies the actual time.',
    },
    simulation: simulatedTime
      ? {
          status: 'simulated-preview-only',
          publicationTimeFixture: simulatedTime,
          isActualPublication: false,
        }
      : null,
    policies: policyManifest,
    files: records,
    manifestSelfHash:
      'Not embedded; hash manifest.json externally after export if a packet receipt is required.',
  };
  files.set('manifest.json', Buffer.from(json(manifest)));
  if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(hostedLegalCandidateFiles)) {
    throw new Error('Candidate files do not match the exact export allowlist.');
  }
  for (const bytes of files.values()) {
    if (bytes.includes(root)) {
      throw new Error('Candidate output unexpectedly contains a private source path.');
    }
  }
  const requested = resolve(options.outputDirectory);
  const parent = await realpath(dirname(requested));
  const destination = join(parent, basename(requested));
  // mkdir without recursive refuses an existing directory, file or symlink, without clobbering it.
  await mkdir(destination, { mode: 0o700 });
  try {
    for (const folder of ['source', 'publication-body', 'semantic', 'publication']) {
      await mkdir(join(destination, folder), { mode: 0o755 });
    }
    for (const [path, bytes] of files) {
      await writeFile(join(destination, path), bytes, { flag: 'wx', mode: 0o644 });
      await chmod(join(destination, path), 0o644);
    }
    return {
      outputDirectory: destination,
      manifest,
      manifestSha256: sha256(files.get('manifest.json')!),
      fileCount: files.size,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function main(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'out-dir': { type: 'string' },
      'preview-publication-time': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Local candidate only: node --import tsx scripts/prepare-hosted-legal-candidate.ts --out-dir /absolute/new/folder [--preview-publication-time UTC_FIXTURE_ISO]',
    );
    return;
  }
  const result = await prepareHostedLegalCandidate({
    outputDirectory: values['out-dir'] ?? '',
    previewPublicationTime: values['preview-publication-time'],
  });
  console.log(
    json({
      status: result.manifest.status,
      files: result.fileCount,
      manifestSha256: result.manifestSha256,
      publishedAt: null,
      effectiveAt: null,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error(
      'Legal candidate export failed. Use --help and a new absolute local directory; no policy was published or activated.',
    );
    process.exitCode = 1;
  });
}
