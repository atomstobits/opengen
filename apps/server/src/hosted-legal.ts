import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  validateHostedLegalPublication,
  type HostedLegalPublication,
} from '@media-router/contracts/hosted-legal-publication';
import { currentHumanTermsPolicy, type HumanTermsPolicy } from './terms-login.js';

export const MAX_HOSTED_LEGAL_PUBLICATION_BYTES = 262_144;

const FORBIDDEN_BARE_LEGAL_ENV_KEYS = [
  'OPENGEN_LEGAL_ACTIVE',
  'OPENGEN_TERMS_ACTIVE',
  'OPENGEN_TERMS_STATUS',
  'OPENGEN_HUMAN_TERMS_ACTIVE',
] as const;

function assertCanonicalHostedPublicUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Hosted legal publication requires the canonical https://opengen.dev URL.');
  }
  if (
    parsed.origin !== LEGAL_PUBLICATION_CANONICAL_ORIGIN ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Hosted legal publication requires the canonical https://opengen.dev origin.');
  }
  return parsed.origin;
}

function readBoundedRegularPublicationFile(filePath: string): string {
  if (!filePath || filePath.includes('\0') || !isAbsolute(filePath)) {
    throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE must be an absolute regular file path.');
  }
  const resolved = resolve(filePath);
  let fd: number;
  try {
    fd = openSync(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error('Unable to open OPENGEN_LEGAL_PUBLICATION_FILE as a non-symlink regular file.');
  }
  try {
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch {
      throw new Error('Unable to resolve canonical path for OPENGEN_LEGAL_PUBLICATION_FILE.');
    }
    if (real !== resolved) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE must not traverse symlinks.');
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HOSTED_LEGAL_PUBLICATION_BYTES) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE must be a non-empty bounded regular file.');
    }
    const bytes = readFileSync(fd);
    if (bytes.length <= 0 || bytes.length > MAX_HOSTED_LEGAL_PUBLICATION_BYTES) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE exceeded the allowed byte limit.');
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** Validate optional hosted legal publication configuration before database initialization. */
export function readHostedLegalPublicationConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  options?: { publicUrl?: string },
): HostedLegalPublication | undefined {
  for (const key of FORBIDDEN_BARE_LEGAL_ENV_KEYS) {
    if (env[key] !== undefined) {
      throw new Error(
        'Hosted legal publication requires a validated publication artifact, not a bare environment flag.',
      );
    }
  }

  const filePath = env.OPENGEN_LEGAL_PUBLICATION_FILE;
  const inlineJson = env.OPENGEN_LEGAL_PUBLICATION_JSON;

  if (filePath !== undefined && filePath.trim() === '') {
    throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE cannot be empty.');
  }
  if (inlineJson !== undefined && inlineJson.trim() === '') {
    throw new Error('OPENGEN_LEGAL_PUBLICATION_JSON cannot be empty.');
  }
  if (filePath !== undefined && inlineJson !== undefined) {
    throw new Error(
      'Specify at most one of OPENGEN_LEGAL_PUBLICATION_FILE or OPENGEN_LEGAL_PUBLICATION_JSON.',
    );
  }
  if (filePath === undefined && inlineJson === undefined) {
    return undefined;
  }

  if ((env.OPENGEN_BILLING_SANDBOX ?? 'false') !== 'false') {
    throw new Error('Hosted legal publication cannot be combined with billing sandbox activation.');
  }

  const expectedOrigin = assertCanonicalHostedPublicUrl(
    options?.publicUrl ?? env.OPENGEN_PUBLIC_URL ?? 'http://localhost:4320',
  );

  let rawJson: string;
  if (filePath !== undefined) {
    rawJson = readBoundedRegularPublicationFile(filePath);
  } else {
    if (Buffer.byteLength(inlineJson!, 'utf8') > MAX_HOSTED_LEGAL_PUBLICATION_BYTES) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_JSON exceeded the allowed byte limit.');
    }
    rawJson = inlineJson!;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Hosted legal publication artifact is not valid JSON.');
  }

  return validateHostedLegalPublication(parsed, { expectedOrigin });
}

/** Create one shared human Terms policy reader for auth and scoped live manual billing. */
export function createHostedHumanTermsPolicyReader(
  publication: HostedLegalPublication | undefined,
  now: () => number = () => Date.now(),
): () => HumanTermsPolicy {
  // Always verify the underlying frozen Draft copy at composition time.
  currentHumanTermsPolicy();

  if (publication === undefined) {
    return currentHumanTermsPolicy;
  }

  const verified = validateHostedLegalPublication(publication, {
    expectedOrigin: LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  });
  const termsPolicyRecord = verified.policies.find((item) => item.slug === 'terms');
  if (!termsPolicyRecord || !termsPolicyRecord.effectiveAt) {
    throw new Error('Validated hosted legal publication is missing an effective Terms record.');
  }

  const effectiveEpochMs = Date.parse(termsPolicyRecord.effectiveAt);
  const frozenActiveSnapshot: HumanTermsPolicy = Object.freeze({
    version: termsPolicyRecord.version,
    digest: termsPolicyRecord.publicationMarkdownSha256,
    status: 'active' as const,
    effectiveAt: termsPolicyRecord.effectiveAt,
  });

  return () => {
    const draft = currentHumanTermsPolicy();
    const currentMs = now();
    if (!Number.isFinite(currentMs)) {
      throw new Error('Hosted human Terms clock returned an invalid timestamp.');
    }
    if (currentMs < effectiveEpochMs) {
      return draft;
    }
    return frozenActiveSnapshot;
  };
}
