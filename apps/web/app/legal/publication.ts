import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Metadata } from 'next';
import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  publishedLegalPolicyMarkdown,
  serializeHostedLegalPublication,
  validateHostedLegalPublication,
  type HostedLegalPolicySlug,
  type HostedLegalPublication,
} from '@media-router/contracts/hosted-legal-publication';
import { pageMetadata, siteOrigin } from '../seo';
import { legalPolicies, legalPolicyMarkdown } from './policies';
import { DEFAULT_LEGAL_PRESENTATION, type LegalSurfacePresentation } from './presentation';

const MAX_WEB_LEGAL_PUBLICATION_BYTES = 262_144;

const FORBIDDEN_BARE_LEGAL_ENV_KEYS = [
  'OPENGEN_LEGAL_ACTIVE',
  'OPENGEN_TERMS_ACTIVE',
  'OPENGEN_TERMS_STATUS',
  'OPENGEN_HUMAN_TERMS_ACTIVE',
] as const;

const DRAFT_TITLES: Readonly<Record<HostedLegalPolicySlug, string>> = Object.freeze({
  terms: 'Terms of Service — review draft | OpenGen',
  refunds: 'Prepaid credit and refunds — review draft | OpenGen',
  privacy: 'Privacy Notice — review draft | OpenGen',
  'data-processing': 'Data Processing Addendum — review draft | OpenGen',
  subprocessors: 'Subprocessor Schedule — review draft | OpenGen',
});

const PUBLISHED_METADATA: Readonly<
  Record<HostedLegalPolicySlug, { readonly title: string; readonly description: string }>
> = Object.freeze({
  terms: Object.freeze({
    title: 'OpenGen Hosted Terms of Service | OpenGen',
    description:
      'Hosted Terms of Service governing OpenGen account access, workspace usage, API and MCP calls at opengen.dev.',
  }),
  refunds: Object.freeze({
    title: 'OpenGen Prepaid Credit and Refund Policy | OpenGen',
    description:
      'Prepaid USD service credit, reservation, settlement and refund policy for the hosted OpenGen service.',
  }),
  privacy: Object.freeze({
    title: 'OpenGen Privacy Notice | OpenGen',
    description:
      'How OpenGen handles account, billing, generation and operational information and the privacy controls available.',
  }),
  'data-processing': Object.freeze({
    title: 'OpenGen Business Data Processing Addendum (Template) | OpenGen',
    description:
      'Available Business Data Processing Addendum template for OpenGen. Template only — not executed by publication.',
  }),
  subprocessors: Object.freeze({
    title: 'OpenGen Business Subprocessor Schedule (Template) | OpenGen',
    description:
      'Available Business Subprocessor Schedule template accompanying the OpenGen DPA template. Not executed by publication.',
  }),
});

type EnvRecord = Readonly<Record<string, string | undefined>>;

function expectedWebOrigin(env: EnvRecord): string {
  const configured =
    env.OPENGEN_PUBLIC_URL ?? env.MEDIA_ROUTER_PUBLIC_URL ?? LEGAL_PUBLICATION_CANONICAL_ORIGIN;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('Hosted legal publication requires canonical https://opengen.dev origin.');
  }
  if (
    parsed.origin !== LEGAL_PUBLICATION_CANONICAL_ORIGIN ||
    parsed.pathname !== '/' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Hosted legal publication requires canonical https://opengen.dev origin.');
  }
  if (env === process.env && siteOrigin() !== LEGAL_PUBLICATION_CANONICAL_ORIGIN) {
    throw new Error('Hosted legal publication requires canonical https://opengen.dev siteOrigin.');
  }
  return parsed.origin;
}

function readBoundedRegularWebFile(filePath: string): string {
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
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WEB_LEGAL_PUBLICATION_BYTES) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE must be a non-empty bounded regular file.');
    }
    const bytes = readFileSync(fd);
    if (bytes.length <= 0 || bytes.length > MAX_WEB_LEGAL_PUBLICATION_BYTES) {
      throw new Error('OPENGEN_LEGAL_PUBLICATION_FILE exceeded the allowed byte limit.');
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function readWebLegalPublication(
  env: EnvRecord = process.env,
): HostedLegalPublication | null {
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
    return null;
  }

  const expectedOrigin = expectedWebOrigin(env);
  let rawJson: string;
  if (filePath !== undefined) {
    rawJson = readBoundedRegularWebFile(filePath);
  } else {
    if (Buffer.byteLength(inlineJson!, 'utf8') > MAX_WEB_LEGAL_PUBLICATION_BYTES) {
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

export function legalSurfacePresentationFromPublication(
  publication: HostedLegalPublication | null,
  now: number = Date.now(),
): LegalSurfacePresentation {
  if (!publication) {
    return DEFAULT_LEGAL_PRESENTATION;
  }
  const termsRecord = publication.policies.find((item) => item.slug === 'terms');
  if (!termsRecord?.effectiveAt) {
    throw new Error('Validated hosted legal publication is missing Terms effectiveAt.');
  }
  const isEffective = Date.parse(termsRecord.effectiveAt) <= now;
  return Object.freeze({
    mode: isEffective ? 'published' : 'staged',
    publishedAt: publication.publishedAt,
    effectiveAt: termsRecord.effectiveAt,
  });
}

export function readWebLegalSurfacePresentation(
  env: EnvRecord = process.env,
  now: number = Date.now(),
): LegalSurfacePresentation {
  return legalSurfacePresentationFromPublication(readWebLegalPublication(env), now);
}

export function legalPageMetadata(
  slug: HostedLegalPolicySlug,
  env: EnvRecord = process.env,
  now: number = Date.now(),
): Metadata {
  const policy = legalPolicies.find((item) => item.slug === slug);
  if (!policy) {
    throw new Error(`Unknown legal policy slug: ${slug}`);
  }
  const publication = readWebLegalPublication(env);
  if (!publication) {
    return pageMetadata({
      title: DRAFT_TITLES[slug],
      description: policy.description,
      path: `/${slug}`,
      noindex: true,
    });
  }
  const presentation = legalSurfacePresentationFromPublication(publication, now);
  const publishedMeta = PUBLISHED_METADATA[slug];
  return pageMetadata({
    title: publishedMeta.title,
    description: publishedMeta.description,
    path: `/${slug}`,
    noindex: presentation.mode !== 'published',
  });
}

export function renderWebLegalMarkdownResponse(
  slug: HostedLegalPolicySlug,
  env: EnvRecord = process.env,
  now: number = Date.now(),
): Response {
  const policy = legalPolicies.find((item) => item.slug === slug);
  if (!policy) {
    throw new Error(`Unknown legal policy slug: ${slug}`);
  }
  const publication = readWebLegalPublication(env);
  if (!publication) {
    return new Response(legalPolicyMarkdown(policy), {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }
  const presentation = legalSurfacePresentationFromPublication(publication, now);
  const body = publishedLegalPolicyMarkdown(slug);
  const expected = APPROVED_HOSTED_LEGAL_POLICIES[slug];
  if (Buffer.byteLength(body, 'utf8') !== expected.publicationMarkdownBytes) {
    throw new Error(`Unexpected byte length for published ${slug}.md.`);
  }
  return new Response(body, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(presentation.mode !== 'published' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  });
}

export function renderWebLegalPublicationManifestResponse(
  env: EnvRecord = process.env,
  now: number = Date.now(),
): Response {
  const publication = readWebLegalPublication(env);
  if (!publication) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'legal_publication_not_configured',
          message: 'No hosted legal publication manifest is configured for this installation.',
        },
      }) + '\n',
      {
        status: 404,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Robots-Tag': 'noindex, nofollow',
        },
      },
    );
  }
  const presentation = legalSurfacePresentationFromPublication(publication, now);
  return new Response(serializeHostedLegalPublication(publication), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(presentation.mode !== 'published' ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}),
    },
  });
}
