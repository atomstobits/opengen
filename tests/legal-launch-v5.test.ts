import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  dataProcessingPolicy,
  legalDraftNotice,
  legalPolicies,
  legalPolicyMarkdown,
  privacyPolicy,
  subprocessorsPolicy,
  termsPolicy,
} from '@media-router/contracts/legal-policies';
import * as legalPoliciesModule from '@media-router/contracts/legal-policies';
import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  HOSTED_LEGAL_POLICY_SLUGS,
  buildHostedLegalPublicationRecord,
  publishedLegalPolicyMarkdown,
  serializeHostedLegalPublication,
  validateHostedLegalPublication,
} from '@media-router/contracts/hosted-legal-publication';
import {
  currentHumanTermsPolicy,
  renderHumanLoginNotice,
  type HumanTermsPolicy,
} from '../apps/server/src/terms-login';
import { createHostedHumanTermsPolicyReader } from '../apps/server/src/hosted-legal';
import { GET as getTermsMd } from '../apps/web/app/terms.md/route';
import { GET as getRefundsMd } from '../apps/web/app/refunds.md/route';
import { GET as getPrivacyMd } from '../apps/web/app/privacy.md/route';
import { GET as getDpaMd } from '../apps/web/app/data-processing.md/route';
import { GET as getSubprocessorsMd } from '../apps/web/app/subprocessors.md/route';
import { sitemapPaths } from '../apps/web/app/seo';
import { legalSurfacePresentationFromPublication } from '../apps/web/app/legal/publication';
import { onboardingOutputs } from '../scripts/build-onboarding.mjs';
import { createTermsBrowserServer } from './helpers/terms-browser-server';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const temporary = await mkdtemp(join(process.cwd(), 'node_modules/.legal-ui-'));
const entry = join(temporary, 'legal-ui.cjs');
await build({
  stdin: {
    contents: [
      `export { LegalPresentationProvider } from './apps/web/app/legal/presentation';`,
      `export { LegalReviewPage } from './apps/web/app/legal/review-page';`,
      `export { Footer } from './apps/web/app/ui';`,
      `export { GatewayAccess } from './apps/web/app/gateway-access';`,
      `export { McpConsent } from './apps/web/app/oauth/consent/consent';`,
      `export { default as RefundsRedirectPage } from './apps/web/app/refunds/page';`,
      `export { generateMetadata as generateTermsMetadata } from './apps/web/app/terms/page';`,
      `export { generateMetadata as generatePrivacyMetadata } from './apps/web/app/privacy/page';`,
      `export { generateMetadata as generateDpaMetadata } from './apps/web/app/data-processing/page';`,
      `export { generateMetadata as generateSubprocessorsMetadata } from './apps/web/app/subprocessors/page';`,
      `export { default as DocsPage } from './apps/web/app/docs/page';`,
    ].join(' '),
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'next/navigation'],
  loader: { '.css': 'empty' },
});
const {
  LegalPresentationProvider,
  LegalReviewPage,
  Footer,
  GatewayAccess,
  McpConsent,
  RefundsRedirectPage,
  generateTermsMetadata,
  generatePrivacyMetadata,
  generateDpaMetadata,
  generateSubprocessorsMetadata,
  DocsPage,
} = createRequire(import.meta.url)(entry) as {
  LegalPresentationProvider: typeof import('../apps/web/app/legal/presentation').LegalPresentationProvider;
  LegalReviewPage: typeof import('../apps/web/app/legal/review-page').LegalReviewPage;
  Footer: typeof import('../apps/web/app/ui').Footer;
  GatewayAccess: typeof import('../apps/web/app/gateway-access').GatewayAccess;
  McpConsent: typeof import('../apps/web/app/oauth/consent/consent').McpConsent;
  RefundsRedirectPage: typeof import('../apps/web/app/refunds/page').default;
  generateTermsMetadata: typeof import('../apps/web/app/terms/page').generateMetadata;
  generatePrivacyMetadata: typeof import('../apps/web/app/privacy/page').generateMetadata;
  generateDpaMetadata: typeof import('../apps/web/app/data-processing/page').generateMetadata;
  generateSubprocessorsMetadata: typeof import('../apps/web/app/subprocessors/page').generateMetadata;
  DocsPage: typeof import('../apps/web/app/docs/page').default;
};
afterAll(() => rm(temporary, { recursive: true, force: true }));

describe('unified non-versioned Terms & Privacy policies and hosted publication integration', () => {
  it('exports clean non-versioned titles, folds refunds into Terms, and keeps self-hosted installs Draft by default', () => {
    expect(legalDraftNotice).toContain('Draft for review');
    expect('refundsPolicy' in legalPoliciesModule).toBe(false);
    expect(legalPolicies.map((policy) => policy.slug)).toEqual([
      'terms',
      'privacy',
      'data-processing',
      'subprocessors',
    ]);
    expect([...HOSTED_LEGAL_POLICY_SLUGS]).toEqual([
      'terms',
      'privacy',
      'data-processing',
      'subprocessors',
    ]);
    expect(sitemapPaths()).not.toContain('/refunds');

    expect(APPROVED_HOSTED_LEGAL_POLICIES.terms.title).toBe('OpenGen Terms of Service');
    expect(APPROVED_HOSTED_LEGAL_POLICIES.privacy.title).toBe('OpenGen Privacy Notice');
    expect(APPROVED_HOSTED_LEGAL_POLICIES['data-processing'].title).toBe(
      'OpenGen Business Data Processing Addendum',
    );
    expect(APPROVED_HOSTED_LEGAL_POLICIES.subprocessors.title).toBe(
      'OpenGen Business Subprocessor Schedule',
    );

    for (const policy of legalPolicies) {
      const candidate = APPROVED_HOSTED_LEGAL_POLICIES[policy.slug];
      expect(candidate.title).not.toMatch(/version\s*\d|\bv\d\b|1\.0/i);
      expect(policy.description).not.toMatch(/version\s*\d|\bv\d\b|1\.0/i);
    }
  });

  it('preserves corporate identity and contact addresses across hosted policies and DPA', () => {
    for (const policy of [termsPolicy, privacyPolicy, dataProcessingPolicy]) {
      const md = legalPolicyMarkdown(policy);
      expect(md).toContain(
        'ATOMSTOBITS LABS INC., 201 Folsom St, San Francisco, CA 94105, United States',
      );
      expect(md).toContain('legal@opengen.dev');
      expect(md).toContain('support@opengen.dev');
    }
  });

  it('unifies credit & refund rules at #credits-and-refunds and covers all 7 Terms reference-audit additions', () => {
    expect(termsPolicy.sections.some((section) => section.id === 'credits-and-refunds')).toBe(true);
    const termsMd = publishedLegalPolicyMarkdown('terms');

    expect(termsMd).toContain(
      '## 8. Prepaid credit, saved cards, automatic recharge and processing fees',
    );
    expect(termsMd).toContain('$5.00 to $9,999.00');
    expect(termsMd).toContain('0% OpenGen markup');
    expect(termsMd).toContain('2.9% + $0.30');
    expect(termsMd).toContain('ceil((credit + $0.30) / 0.971) - credit');
    expect(termsMd).toContain('4.4% + $0.30');
    expect(termsMd).toContain('ceil((credit + $0.30) / 0.956) - credit');
    expect(termsMd).toContain('one active human funding owner per workspace');
    expect(termsMd).toContain('3D Secure');
    expect(termsMd).toContain('## 9. Refunds, sub-cent rounding, aged holds and credit expiry');
    expect(termsMd).toContain('nonrefundable on ordinary voluntary unused-credit refunds');
    expect(termsMd).toContain('creditCents');
    expect(termsMd).toContain('$4.993456');
    expect(termsMd).toContain('no earlier than 365 days after purchase');

    // Gap 1–7 substantive additions
    expect(termsMd).toContain('C2PA Content Credentials');
    expect(termsMd).toContain('SynthID');
    expect(termsMd).toContain('National Center for Missing & Exploited Children (NCMEC)');
    expect(termsMd).toContain('voice cloning');
    expect(termsMd).toContain('real-time biometric identification');
    expect(termsMd).toContain('CBRN');
    expect(termsMd).toContain('enforce an 18+ minimum age requirement');
    expect(termsMd).toContain('17 U.S.C. § 512(c)(3)');
    expect(termsMd).toContain('17 U.S.C. § 512(g)(3)');
    expect(termsMd).toContain('under penalty of perjury');
    expect(termsMd).toContain('17 U.S.C. § 512(f)');
    expect(termsMd).toContain('distill or fine-tune a competing machine-learning model');
    expect(termsMd).toContain('Apache-2.0');
    expect(termsMd).toContain('free of customer tax withholding');
    expect(termsMd).toContain('bad-faith chargeback');
    expect(termsMd).toContain('14 days from concluding the contract');
    expect(termsMd).toContain('runaway scripts or agent loops');
    expect(termsMd).toContain('Office of Foreign Assets Control (OFAC)');
    expect(termsMd).toContain('Specially Designated Nationals (SDN)');
    expect(termsMd).toContain('Electronic Signatures in Global and National Commerce Act (E-SIGN)');
    expect(termsMd).toContain('FAR 12.212');
    expect(termsMd).toContain('DFARS 227.7202');

    expect(publishedLegalPolicyMarkdown('data-processing')).toContain(
      'credit and refund provisions of the Terms of Service',
    );
  });

  it('covers all 4 Privacy Notice reference-audit additions alongside payment & storage disclosures', () => {
    const privacyMd = publishedLegalPolicyMarkdown('privacy');

    expect(privacyMd).toContain('California Notice at Collection (CCPA/CPRA)');
    expect(privacyMd).toContain('1798.140');
    expect(privacyMd).toContain('Cal. Civ. Code § 1798.121');
    expect(privacyMd).toContain('Global Privacy Control (GPC)');
    expect(privacyMd).toContain('Cal. Civ. Code § 1798.83');
    expect(privacyMd).toContain('COPPA');
    expect(privacyMd).toContain('children under 13');
    expect(privacyMd).toContain('minors under 16');
    expect(privacyMd).toContain('Managed vs Bring Your Own Key (BYOK) routes');
    expect(privacyMd).toContain('ffprobe');
    expect(privacyMd).toContain('Virginia VCDPA');
    expect(privacyMd).toContain('Colorado CPA');
    expect(privacyMd).toContain('Attorney General');
    expect(privacyMd).toContain('Art. 6(1)(b)');
    expect(privacyMd).toContain('Art. 6(1)(f)');
    expect(privacyMd).toContain('Articles 45–46');
    expect(privacyMd).toContain('Standard Contractual Clauses (SCCs)');
    expect(privacyMd).toContain('two-letter ISO country code');
    expect(privacyMd).toContain('never full card numbers or CVC');
    expect(privacyMd).toContain('saved-card setup-recovery keys');
    expect(privacyMd).toContain('Scoped 3D Secure confirmation secrets');
  });

  it('redirects /refunds to /terms#credits-and-refunds and /refunds.md (308) to /terms.md, and emits zero public version strings when published', async () => {
    expect(() => RefundsRedirectPage()).toThrow(/NEXT_REDIRECT/);
    try {
      RefundsRedirectPage();
    } catch (error) {
      expect(String((error as { digest?: string }).digest)).toContain(
        '/terms#credits-and-refunds;308',
      );
    }

    const refundsMdResponse = getRefundsMd();
    expect(refundsMdResponse.status).toBe(308);
    expect(refundsMdResponse.headers.get('location')).toBe('/terms.md');

    const pub = buildHostedLegalPublicationRecord({
      publishedAt: '2026-11-16T00:00:00.000Z',
      effectiveAt: '2026-11-16T00:00:00.000Z',
      approvalReference: 'owner-legal-adoption-2026-11-16',
      operatingRecordReference: 'terms-receipt-operating-record-2026-11-16',
    });
    expect(validateHostedLegalPublication(pub)).toEqual(pub);

    vi.stubEnv('OPENGEN_PUBLIC_URL', 'https://opengen.dev');
    vi.stubEnv('OPENGEN_LEGAL_PUBLICATION_JSON', serializeHostedLegalPublication(pub));
    try {
      for (const [slug, route] of [
        ['terms', getTermsMd],
        ['privacy', getPrivacyMd],
        ['data-processing', getDpaMd],
        ['subprocessors', getSubprocessorsMd],
      ] as const) {
        const md = publishedLegalPolicyMarkdown(slug);
        expect(md).not.toContain('Version:');
        expect(md).not.toContain(APPROVED_HOSTED_LEGAL_POLICIES[slug].version);
        expect(md).not.toMatch(/\bv[45]\b|1\.0/);
        expect(await route().text()).toBe(md);
      }

      const publishedPresentation = legalSurfacePresentationFromPublication(
        pub,
        Date.parse('2026-11-16T01:00:00.000Z'),
      );
      for (const policy of legalPolicies) {
        const html = renderToStaticMarkup(
          createElement(LegalReviewPage, {
            policy,
            publication: pub,
            now: Date.parse('2026-11-16T01:00:00.000Z'),
          }),
        );
        expect(html).not.toContain(APPROVED_HOSTED_LEGAL_POLICIES[policy.slug].version);
        expect(html).not.toContain('Version:');
        expect(html).not.toContain('LEGAL / REVIEW DRAFT');
      }

      const footerHtml = renderToStaticMarkup(
        createElement(LegalPresentationProvider, {
          presentation: publishedPresentation,
          children: createElement(Footer),
        }),
      );
      expect(footerHtml).toContain('Terms of Service');
      expect(footerHtml).toContain('Privacy Notice');
      expect(footerHtml).not.toContain('/refunds');
      expect(footerHtml).not.toContain('draft');

      const accessHtml = renderToStaticMarkup(
        createElement(LegalPresentationProvider, {
          presentation: publishedPresentation,
          children: createElement(GatewayAccess, { onChange: () => {} }),
        }),
      );
      expect(accessHtml).toContain('Terms of Service');
      expect(accessHtml).not.toContain('/refunds');

      const consentHtml = renderToStaticMarkup(
        createElement(LegalPresentationProvider, {
          presentation: publishedPresentation,
          children: createElement(McpConsent, {
            requestId: `og_req_${'r'.repeat(43)}`,
            initialNeedsLogin: true,
          }),
        }),
      );
      expect(consentHtml).not.toContain('/refunds');

      const docsHtml = renderToStaticMarkup(createElement(DocsPage));
      expect(docsHtml).toContain('href="/terms#credits-and-refunds"');
      expect(docsHtml).not.toContain('href="/refunds"');

      for (const title of [
        String(generateTermsMetadata().title),
        String(generatePrivacyMetadata().title),
        String(generateDpaMetadata().title),
        String(generateSubprocessorsMetadata().title),
      ]) {
        expect(title.toLowerCase()).not.toContain('draft');
        expect(title).not.toMatch(/version\s*\d|\bv[45]\b|1\.0/i);
      }

      const activeNoticePolicy = createHostedHumanTermsPolicyReader(pub, () =>
        Date.parse('2026-11-16T01:00:00.000Z'),
      )();
      const activeHtml = renderHumanLoginNotice(activeNoticePolicy, 'signed-action-token');
      expect(activeHtml).toContain('By continuing, you agree to the');
      expect(activeHtml).toContain('<small>Effective: 2026-11-16T00:00:00.000Z</small>');
      expect(activeHtml).not.toContain('Terms version:');
      expect(activeHtml).not.toContain('hosted-terms-');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('pins the exact frozen draft Terms SHA-256 when unconfigured and fails closed on unreviewed edits', async () => {
    const policy = currentHumanTermsPolicy();
    expect(policy).toEqual({
      version: 'hosted-terms-draft-2026-11-16',
      digest: sha256(legalPolicyMarkdown(termsPolicy)),
      status: 'draft',
      effectiveAt: null,
    });

    const draftHtml = renderHumanLoginNotice(policy, 'signed-action-token');
    expect(draftHtml).toContain('Continuing signs you in. It does not accept these drafts.');
    expect(draftHtml).toContain('<small>Not effective</small>');
    expect(draftHtml).not.toContain('Terms version:');
    expect(draftHtml).not.toContain('hosted-terms-');

    const originalTitle = termsPolicy.title;
    try {
      (termsPolicy as { title: string }).title = `${originalTitle} (unreviewed mutation)`;
      expect(() => currentHumanTermsPolicy()).toThrow(
        'The human Terms copy changed without a reviewed policy snapshot.',
      );
    } finally {
      (termsPolicy as { title: string }).title = originalTitle;
    }
    expect(currentHumanTermsPolicy().digest).toBe(policy.digest);

    const draftApp = await createTermsBrowserServer('http://127.0.0.1:4323');
    try {
      const health = await draftApp.inject('/health');
      expect(health.json()).toEqual({ fixture: true, policyStatus: 'draft' });
      const getNotice = await draftApp.inject('/auth/login');
      expect(getNotice.statusCode).toBe(200);
      expect(getNotice.body).not.toContain('Terms version:');
      expect(getNotice.body).not.toContain('hosted-terms-');
    } finally {
      await draftApp.close();
    }

    const activeSynthetic: HumanTermsPolicy = {
      version: 'hosted-terms-2026-11-16',
      digest: 'a'.repeat(64),
      status: 'active',
      effectiveAt: '2026-11-16T00:00:00.000Z',
    };
    const activeSyntheticHtml = renderHumanLoginNotice(activeSynthetic, 'signed-token');
    expect(activeSyntheticHtml).toContain('Effective: 2026-11-16T00:00:00.000Z');
    expect(activeSyntheticHtml).not.toContain('Terms version:');
    expect(activeSyntheticHtml).not.toContain('hosted-terms-');
  });

  it('keeps generated skill, Claude plugin and onboarding contract outputs synchronized', async () => {
    for (const [path, expected] of await onboardingOutputs(root)) {
      expect(await readFile(join(root, path), 'utf8'), path).toBe(expected);
    }
  });
});
