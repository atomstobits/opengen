import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  legalDraftNotice,
  legalPolicies,
  legalPolicyMarkdown,
  type LegalBlock,
  type LegalPolicy,
} from './legal-policies';

export const LEGAL_PUBLICATION_CANONICAL_ORIGIN = 'https://opengen.dev' as const;
export const LEGAL_PUBLICATION_METADATA_PATH = '/legal-publication.json' as const;
export const LEGAL_PUBLICATION_NOTICE_VERSION = 'human-terms-continue-v1' as const;
export const LEGAL_BODY_SEMANTIC_FORMAT = 'opengen-legal-body-json-v1' as const;
export const LEGAL_POLICIES_SOURCE_MODULE_PATH =
  'packages/contracts/src/legal-policies.ts' as const;
export const LEGAL_POLICIES_SOURCE_SHA256 =
  'fb027137fe1130dcceee690f068be3a3213bc9c0397f82034e6e17808072c875' as const;
export const LEGAL_POLICIES_SOURCE_GIT_BLOB = '9761acb4ebe50ca11a4fea23f1d2e46b7e83cbce' as const;

export const HOSTED_LEGAL_POLICY_SLUGS = [
  'terms',
  'privacy',
  'data-processing',
  'subprocessors',
] as const;

export type HostedLegalPolicySlug = (typeof HOSTED_LEGAL_POLICY_SLUGS)[number];
export type HostedLegalCandidateMode =
  'contract-pending-adoption' | 'notice-pending-publication' | 'available-template-not-executed';
export type HostedLegalPublicationMode =
  'contract-adopted' | 'notice-published' | 'available-template-not-executed';
export type HostedLegalExecutionStatus = 'not-applicable' | 'not-executed';

export interface ApprovedHostedLegalPolicySpec {
  readonly slug: HostedLegalPolicySlug;
  readonly version: string;
  readonly title: string;
  readonly navigationLabel: string;
  readonly candidateMode: HostedLegalCandidateMode;
  readonly publicationMode: HostedLegalPublicationMode;
  readonly executionStatus: HostedLegalExecutionStatus;
  readonly sourceMarkdownSha256: string;
  readonly sourceMarkdownBytes: number;
  readonly approvedBodyMarkdownSha256: string;
  readonly approvedBodyMarkdownBytes: number;
  readonly semanticCanonicalSha256: string;
  readonly semanticCanonicalBytes: number;
  readonly publicationMarkdownSha256: string;
  readonly publicationMarkdownBytes: number;
}

export const APPROVED_HOSTED_LEGAL_POLICIES: Readonly<
  Record<HostedLegalPolicySlug, ApprovedHostedLegalPolicySpec>
> = Object.freeze({
  terms: Object.freeze({
    slug: 'terms',
    version: 'hosted-terms-2026-11-16',
    title: 'OpenGen Terms of Service',
    navigationLabel: 'Terms of Service',
    candidateMode: 'contract-pending-adoption',
    publicationMode: 'contract-adopted',
    executionStatus: 'not-applicable',
    sourceMarkdownSha256: '06b1b9849544e2158b43e1fa79daa29e082a0bd0e41505ef38425f06fb142c6c',
    sourceMarkdownBytes: 50702,
    approvedBodyMarkdownSha256: '03161e6e3d3ad88f4e7eeff1cb4a6861b293f122d337187ace105dbe4fe7e7f4',
    approvedBodyMarkdownBytes: 50553,
    semanticCanonicalSha256: '41a7f11dcb48d02c63cd1a4efcbecaa4759bcd4477e9904d0bfa64158377dec3',
    semanticCanonicalBytes: 54044,
    publicationMarkdownSha256: '84a1966196c7d241484bfd9e0abe2b5afc2095b024abe330a527ca628b8c57b0',
    publicationMarkdownBytes: 50638,
  }),
  privacy: Object.freeze({
    slug: 'privacy',
    version: 'hosted-privacy-2026-11-16',
    title: 'OpenGen Privacy Notice',
    navigationLabel: 'Privacy Notice',
    candidateMode: 'notice-pending-publication',
    publicationMode: 'notice-published',
    executionStatus: 'not-applicable',
    sourceMarkdownSha256: 'bc8b2db8c7250a4f8d75661ff3479ecc32a4e4d36039a2078a0991d619fc56c1',
    sourceMarkdownBytes: 33962,
    approvedBodyMarkdownSha256: '56dca962ed4654213421ce4291dcb768e3ca788bd438a473e3e0d74d730c9f40',
    approvedBodyMarkdownBytes: 33815,
    semanticCanonicalSha256: '48fd13fc6d8be8ddded7f5ae1304dc460f5e4ba49eb4219a0f68a8f31ff8b374',
    semanticCanonicalBytes: 36098,
    publicationMarkdownSha256: 'db7fa57fe9972a77a63ff7488c577624e5201b9c63d2f598962865910f17d25c',
    publicationMarkdownBytes: 33898,
  }),
  'data-processing': Object.freeze({
    slug: 'data-processing',
    version: 'business-dpa-template-2026-11-16',
    title: 'OpenGen Business Data Processing Addendum',
    navigationLabel: 'DPA Template',
    candidateMode: 'available-template-not-executed',
    publicationMode: 'available-template-not-executed',
    executionStatus: 'not-executed',
    sourceMarkdownSha256: 'ab90e622037278051331db8c8cb2b195a0ee4b8a0303dd4b3b5bb7b54f664efe',
    sourceMarkdownBytes: 27987,
    approvedBodyMarkdownSha256: '40a534bb303242ac35cec2710ac1674f0c0ce16ed2354cac60d1f4b365cd1a4c',
    approvedBodyMarkdownBytes: 27821,
    semanticCanonicalSha256: '1ee7d6151c5d1d05da1758f984e81ff3b9cf89296c044299d485b1e8f54e9c8c',
    semanticCanonicalBytes: 29948,
    publicationMarkdownSha256: 'bef9d6d31c42b1aab75d99e24b2e2d6748df67b2d3292244804ab750fa9018ec',
    publicationMarkdownBytes: 27985,
  }),
  subprocessors: Object.freeze({
    slug: 'subprocessors',
    version: 'business-subprocessors-template-2026-11-16',
    title: 'OpenGen Business Subprocessor Schedule',
    navigationLabel: 'Subprocessor Template',
    candidateMode: 'available-template-not-executed',
    publicationMode: 'available-template-not-executed',
    executionStatus: 'not-executed',
    sourceMarkdownSha256: '9b1f8030f80825dd8e932ba6a249be047892f2667792d8546ecaa93e206836b8',
    sourceMarkdownBytes: 8498,
    approvedBodyMarkdownSha256: '75ce53bb9269b0ef41669c0877eaea9a7a7a8f68e63e154ac68864e0ea07291b',
    approvedBodyMarkdownBytes: 8335,
    semanticCanonicalSha256: '20bf2d1ad9af1eefce5595cc5002b7b307074a66ecc6a71f05ec66c560c2eeec',
    semanticCanonicalBytes: 8827,
    publicationMarkdownSha256: 'beaa527bdaddd7d15c16a31b9bc148d605670e19d9a17c1c2fa29ef587c48ab0',
    publicationMarkdownBytes: 8496,
  }),
});

const sha256Hex = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');

function policyForSlug(slug: HostedLegalPolicySlug): LegalPolicy {
  const found = legalPolicies.find((item) => item.slug === slug);
  if (!found) {
    throw new Error(`Unknown legal policy slug: ${slug}`);
  }
  return found;
}

/** Validate an explicit UTC ISO-8601 timestamp (no offsets, no calendar overflow) and return normalized .000Z form. */
export function canonicalUtcIsoTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new Error('Legal publication timestamps must use explicit UTC ISO-8601 format.');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Legal publication timestamp is invalid.');
  }
  const canonical = date.toISOString();
  const expected = value.includes('.') ? value : value.replace(/Z$/, '.000Z');
  if (canonical !== expected) {
    throw new Error('Legal publication timestamp does not represent a real calendar UTC instant.');
  }
  return canonical;
}

/** Compact JSON with explicit stable key order (`opengen-legal-body-json-v1`); wrapper metadata is excluded. */
export function canonicalLegalBody(policy: LegalPolicy): string {
  const block = (value: LegalBlock): unknown => {
    if (value.type === 'paragraph') return { type: value.type, text: value.text };
    if (value.type === 'linkedParagraph')
      return {
        type: value.type,
        parts: value.parts.map((part) =>
          typeof part === 'string' ? part : { label: part.label, href: part.href },
        ),
      };
    if (value.type === 'list') return { type: value.type, items: [...value.items] };
    return {
      type: value.type,
      columns: [...value.columns],
      rows: value.rows.map((row) => [...row]),
    };
  };
  return (
    JSON.stringify({
      introduction: policy.introduction ?? null,
      sections: policy.sections.map((section) => ({
        id: section.id,
        title: section.title,
        blocks: section.blocks.map(block),
      })),
    }) + '\n'
  );
}

/** Strip only the exact source draft wrapper; all substantive body Markdown bytes remain unchanged. */
export function publicationBodyMarkdown(policy: LegalPolicy): string {
  const source = legalPolicyMarkdown(policy);
  const wrapper =
    [`# ${policy.title}`, `> ${legalDraftNotice}`, `Review date: ${policy.reviewDate}`].join(
      '\n\n',
    ) + '\n\n';
  if (!source.startsWith(wrapper)) {
    throw new Error('The shared policy renderer changed; review the legal publication boundary.');
  }
  return source.slice(wrapper.length);
}

/** Deterministic published Markdown (`publication/<slug>.md`), verified against the approved digest. */
export function publishedLegalPolicyMarkdown(slug: HostedLegalPolicySlug): string {
  const policy = policyForSlug(slug);
  const spec = APPROVED_HOSTED_LEGAL_POLICIES[slug];
  const markdown =
    [
      `# ${spec.title}`,
      `Publication and effective time: ${LEGAL_PUBLICATION_METADATA_PATH}`,
      ...(spec.publicationMode === 'available-template-not-executed'
        ? ['Availability: template only — not executed by publication.']
        : []),
    ].join('\n\n') +
    '\n\n' +
    publicationBodyMarkdown(policy);

  const digest = sha256Hex(markdown);
  const bytes = utf8Bytes(markdown);
  if (digest !== spec.publicationMarkdownSha256 || bytes !== spec.publicationMarkdownBytes) {
    throw new Error(
      `Published legal Markdown for ${slug} does not match the approved copy fingerprint.`,
    );
  }
  return markdown;
}

interface VerifiedPolicyDigests {
  readonly sourceMarkdownSha256: string;
  readonly sourceMarkdownBytes: number;
  readonly approvedBodyMarkdownSha256: string;
  readonly approvedBodyMarkdownBytes: number;
  readonly semanticCanonicalSha256: string;
  readonly semanticCanonicalBytes: number;
  readonly publicationMarkdownSha256: string;
  readonly publicationMarkdownBytes: number;
}

function computeVerifiedPolicyDigests(slug: HostedLegalPolicySlug): VerifiedPolicyDigests {
  const policy = policyForSlug(slug);
  const spec = APPROVED_HOSTED_LEGAL_POLICIES[slug];
  const source = legalPolicyMarkdown(policy);
  const body = publicationBodyMarkdown(policy);
  const semantic = canonicalLegalBody(policy);
  const publication = publishedLegalPolicyMarkdown(slug);

  const computed: VerifiedPolicyDigests = {
    sourceMarkdownSha256: sha256Hex(source),
    sourceMarkdownBytes: utf8Bytes(source),
    approvedBodyMarkdownSha256: sha256Hex(body),
    approvedBodyMarkdownBytes: utf8Bytes(body),
    semanticCanonicalSha256: sha256Hex(semantic),
    semanticCanonicalBytes: utf8Bytes(semantic),
    publicationMarkdownSha256: sha256Hex(publication),
    publicationMarkdownBytes: utf8Bytes(publication),
  };

  if (
    computed.sourceMarkdownSha256 !== spec.sourceMarkdownSha256 ||
    computed.sourceMarkdownBytes !== spec.sourceMarkdownBytes ||
    computed.approvedBodyMarkdownSha256 !== spec.approvedBodyMarkdownSha256 ||
    computed.approvedBodyMarkdownBytes !== spec.approvedBodyMarkdownBytes ||
    computed.semanticCanonicalSha256 !== spec.semanticCanonicalSha256 ||
    computed.semanticCanonicalBytes !== spec.semanticCanonicalBytes ||
    computed.publicationMarkdownSha256 !== spec.publicationMarkdownSha256 ||
    computed.publicationMarkdownBytes !== spec.publicationMarkdownBytes
  ) {
    throw new Error(`Shared legal source copy for ${slug} drifted from the approved digests.`);
  }

  return computed;
}

const boundedReferenceSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) => value.trim() === value && /^[\x20-\x7e]+$/.test(value),
    'Reference must be bounded printable ASCII without leading or trailing whitespace.',
  );

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const hostedLegalPolicyEntrySchema = z
  .object({
    slug: z.enum(HOSTED_LEGAL_POLICY_SLUGS),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
    title: z.string().min(1).max(200),
    htmlPath: z.string().regex(/^\/[a-z-]+$/),
    markdownPath: z.string().regex(/^\/[a-z-]+\.md$/),
    mode: z.enum(['contract-adopted', 'notice-published', 'available-template-not-executed']),
    executionStatus: z.enum(['not-applicable', 'not-executed']),
    effectiveAt: z.string().nullable(),
    sourceMarkdownSha256: sha256Schema,
    approvedBodyMarkdownSha256: sha256Schema,
    semanticCanonicalSha256: sha256Schema,
    publicationMarkdownSha256: sha256Schema,
    publicationMarkdownBytes: z.number().int().positive(),
  })
  .strict();

const rawHostedLegalPublicationSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('hosted-legal-publication'),
    canonicalOrigin: z.literal(LEGAL_PUBLICATION_CANONICAL_ORIGIN),
    metadataPath: z.literal(LEGAL_PUBLICATION_METADATA_PATH),
    noticeVersion: z.literal(LEGAL_PUBLICATION_NOTICE_VERSION),
    approvalReference: boundedReferenceSchema,
    operatingRecordReference: boundedReferenceSchema,
    publishedAt: z.string(),
    policies: z.array(hostedLegalPolicyEntrySchema).length(HOSTED_LEGAL_POLICY_SLUGS.length),
  })
  .strict();

export type HostedLegalPolicyPublication = Readonly<z.infer<typeof hostedLegalPolicyEntrySchema>>;
export type HostedLegalPublication = Readonly<
  Omit<z.infer<typeof rawHostedLegalPublicationSchema>, 'policies'> & {
    readonly policies: readonly HostedLegalPolicyPublication[];
  }
>;

export interface ValidateHostedLegalPublicationOptions {
  expectedOrigin?: string;
}

/** Validate a hosted legal publication record against the five approved policy copies and origin/T0 invariants. */
export function validateHostedLegalPublication(
  input: unknown,
  options?: ValidateHostedLegalPublicationOptions,
): HostedLegalPublication {
  if (options?.expectedOrigin !== undefined) {
    if (options.expectedOrigin !== LEGAL_PUBLICATION_CANONICAL_ORIGIN) {
      throw new Error(
        `Hosted legal publication requires canonical origin ${LEGAL_PUBLICATION_CANONICAL_ORIGIN}.`,
      );
    }
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Hosted legal publication must be a structured publication record object.');
  }

  const parsedResult = rawHostedLegalPublicationSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new Error('Hosted legal publication failed schema validation.');
  }
  const parsed = parsedResult.data;

  const publishedAt = canonicalUtcIsoTimestamp(parsed.publishedAt);
  const publishedMs = Date.parse(publishedAt);

  if (legalPolicies.length !== HOSTED_LEGAL_POLICY_SLUGS.length) {
    throw new Error('Shared legal policy inventory length drifted.');
  }

  let coordinatedEffectiveAt: string | null = null;
  const normalizedPolicies: HostedLegalPolicyPublication[] = parsed.policies.map((entry, index) => {
    const expectedSlug = HOSTED_LEGAL_POLICY_SLUGS[index]!;
    if (entry.slug !== expectedSlug) {
      throw new Error(
        `Hosted legal publication policies must appear in exact canonical order (${HOSTED_LEGAL_POLICY_SLUGS.join(', ')}).`,
      );
    }

    const spec = APPROVED_HOSTED_LEGAL_POLICIES[expectedSlug];
    const verified = computeVerifiedPolicyDigests(expectedSlug);

    if (
      entry.version !== spec.version ||
      entry.title !== spec.title ||
      entry.htmlPath !== `/${expectedSlug}` ||
      entry.markdownPath !== `/${expectedSlug}.md` ||
      entry.mode !== spec.publicationMode ||
      entry.executionStatus !== spec.executionStatus
    ) {
      throw new Error(`Hosted legal policy metadata mismatch for ${expectedSlug}.`);
    }

    if (
      entry.sourceMarkdownSha256 !== verified.sourceMarkdownSha256 ||
      entry.approvedBodyMarkdownSha256 !== verified.approvedBodyMarkdownSha256 ||
      entry.semanticCanonicalSha256 !== verified.semanticCanonicalSha256 ||
      entry.publicationMarkdownSha256 !== verified.publicationMarkdownSha256 ||
      entry.publicationMarkdownBytes !== verified.publicationMarkdownBytes
    ) {
      throw new Error(`Hosted legal policy digest mismatch for ${expectedSlug}.`);
    }

    let normalizedEffectiveAt: string | null;
    if (expectedSlug === 'data-processing' || expectedSlug === 'subprocessors') {
      if (entry.effectiveAt !== null) {
        throw new Error(
          `Template policy ${expectedSlug} is not executed by publication and must keep effectiveAt null.`,
        );
      }
      normalizedEffectiveAt = null;
    } else {
      if (entry.effectiveAt === null) {
        throw new Error(`Hosted policy ${expectedSlug} requires an explicit UTC effectiveAt.`);
      }
      normalizedEffectiveAt = canonicalUtcIsoTimestamp(entry.effectiveAt);
      if (Date.parse(normalizedEffectiveAt) < publishedMs) {
        throw new Error(`Hosted policy ${expectedSlug} effectiveAt cannot precede publishedAt.`);
      }
      if (coordinatedEffectiveAt === null) {
        coordinatedEffectiveAt = normalizedEffectiveAt;
      } else if (normalizedEffectiveAt !== coordinatedEffectiveAt) {
        throw new Error('Terms and Privacy must share the coordinated effectiveAt timestamp.');
      }
    }

    return Object.freeze({
      slug: expectedSlug,
      version: entry.version,
      title: entry.title,
      htmlPath: entry.htmlPath,
      markdownPath: entry.markdownPath,
      mode: entry.mode,
      executionStatus: entry.executionStatus,
      effectiveAt: normalizedEffectiveAt,
      sourceMarkdownSha256: entry.sourceMarkdownSha256,
      approvedBodyMarkdownSha256: entry.approvedBodyMarkdownSha256,
      semanticCanonicalSha256: entry.semanticCanonicalSha256,
      publicationMarkdownSha256: entry.publicationMarkdownSha256,
      publicationMarkdownBytes: entry.publicationMarkdownBytes,
    });
  });

  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'hosted-legal-publication' as const,
    canonicalOrigin: LEGAL_PUBLICATION_CANONICAL_ORIGIN,
    metadataPath: LEGAL_PUBLICATION_METADATA_PATH,
    noticeVersion: LEGAL_PUBLICATION_NOTICE_VERSION,
    approvalReference: parsed.approvalReference,
    operatingRecordReference: parsed.operatingRecordReference,
    publishedAt,
    policies: Object.freeze(normalizedPolicies),
  });
}

export interface BuildHostedLegalPublicationInput {
  publishedAt: string;
  effectiveAt: string;
  approvalReference: string;
  operatingRecordReference: string;
}

/** Build and validate a canonical five-policy HostedLegalPublication record from the verified shared copy. */
export function buildHostedLegalPublicationRecord(
  input: BuildHostedLegalPublicationInput,
): HostedLegalPublication {
  const publishedAt = canonicalUtcIsoTimestamp(input.publishedAt);
  const effectiveAt = canonicalUtcIsoTimestamp(input.effectiveAt);

  const candidate = {
    schemaVersion: 1 as const,
    kind: 'hosted-legal-publication' as const,
    canonicalOrigin: LEGAL_PUBLICATION_CANONICAL_ORIGIN,
    metadataPath: LEGAL_PUBLICATION_METADATA_PATH,
    noticeVersion: LEGAL_PUBLICATION_NOTICE_VERSION,
    approvalReference: input.approvalReference,
    operatingRecordReference: input.operatingRecordReference,
    publishedAt,
    policies: HOSTED_LEGAL_POLICY_SLUGS.map((slug) => {
      const spec = APPROVED_HOSTED_LEGAL_POLICIES[slug];
      const verified = computeVerifiedPolicyDigests(slug);
      const isTemplate = slug === 'data-processing' || slug === 'subprocessors';
      return {
        slug,
        version: spec.version,
        title: spec.title,
        htmlPath: `/${slug}`,
        markdownPath: `/${slug}.md`,
        mode: spec.publicationMode,
        executionStatus: spec.executionStatus,
        effectiveAt: isTemplate ? null : effectiveAt,
        sourceMarkdownSha256: verified.sourceMarkdownSha256,
        approvedBodyMarkdownSha256: verified.approvedBodyMarkdownSha256,
        semanticCanonicalSha256: verified.semanticCanonicalSha256,
        publicationMarkdownSha256: verified.publicationMarkdownSha256,
        publicationMarkdownBytes: verified.publicationMarkdownBytes,
      };
    }),
  };

  return validateHostedLegalPublication(candidate, {
    expectedOrigin: LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  });
}

export function serializeHostedLegalPublication(publication: HostedLegalPublication): string {
  const validated = validateHostedLegalPublication(publication, {
    expectedOrigin: LEGAL_PUBLICATION_CANONICAL_ORIGIN,
  });
  return JSON.stringify(validated, null, 2) + '\n';
}
