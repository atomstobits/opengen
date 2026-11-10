import {
  APPROVED_HOSTED_LEGAL_POLICIES,
  LEGAL_PUBLICATION_METADATA_PATH,
  type HostedLegalPublication,
} from '@media-router/contracts/hosted-legal-publication';
import { Footer, SiteHeader } from '../ui';
import { legalDraftNotice, legalPolicies, type LegalBlock, type LegalPolicy } from './policies';
import { LegalPresentationProvider } from './presentation';
import { legalSurfacePresentationFromPublication, readWebLegalPublication } from './publication';

function PolicyBlock({ block }: { block: LegalBlock }) {
  if (block.type === 'paragraph') return <p>{block.text}</p>;
  if (block.type === 'linkedParagraph')
    return (
      <p>
        {block.parts.map((part, index) =>
          typeof part === 'string' ? (
            part
          ) : (
            <a key={index} href={part.href}>
              {part.label}
            </a>
          ),
        )}
      </p>
    );
  if (block.type === 'list')
    return (
      <ul>
        {block.items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  return (
    <table className="docs-table">
      <thead>
        <tr>
          {block.columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {block.rows.map((row) => (
          <tr key={row[0]}>
            {row.map((cell, index) => (
              <td key={index}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Shared document chrome only; the approved legal text stays in policies.ts. */
export function LegalReviewPage({
  policy,
  publication,
  now,
}: {
  policy: LegalPolicy;
  publication?: HostedLegalPublication | null;
  now?: number;
}) {
  const currentNow = now ?? Date.now();
  const resolvedPublication = publication === undefined ? readWebLegalPublication() : publication;

  if (!resolvedPublication) {
    return (
      <>
        <SiteHeader />
        <main className="docs-page page-width">
          <span className="eyebrow">LEGAL / REVIEW DRAFT</span>
          <h1>{policy.title}</h1>
          <p className="docs-intro">Review date: {policy.reviewDate} · Not effective</p>
          <aside className="docs-callout" role="note" aria-label="Draft status">
            <p>
              <strong>{legalDraftNotice}</strong>
            </p>
          </aside>
          <nav className="page-breadcrumb" aria-label="Legal review drafts">
            {legalPolicies.map((item) => (
              <a
                key={item.slug}
                href={`/${item.slug}`}
                aria-current={item.slug === policy.slug ? 'page' : undefined}
              >
                {item.navigationLabel}
              </a>
            ))}
            <a href={`/${policy.slug}.md`}>Read this draft as Markdown</a>
          </nav>
          <p>
            Legal and privacy contact: <a href="mailto:legal@opengen.dev">legal@opengen.dev</a>.
            Account and billing support:{' '}
            <a href="mailto:support@opengen.dev">support@opengen.dev</a>.
          </p>
          {policy.introduction && <p>{policy.introduction}</p>}
          <div className="docs-grid">
            <nav className="docs-index legal-index" aria-label="On this page">
              <span className="eyebrow">ON THIS PAGE</span>
              {policy.sections.map((section) => (
                <a key={section.id} href={`#${section.id}`}>
                  {section.title}
                </a>
              ))}
            </nav>
            <article className="docs-body" aria-label={policy.title}>
              {policy.sections.map((section) => (
                <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                  <h2 id={`${section.id}-title`}>{section.title}</h2>
                  {section.blocks.map((block, index) => (
                    <PolicyBlock key={index} block={block} />
                  ))}
                </section>
              ))}
            </article>
          </div>
        </main>
        <Footer />
      </>
    );
  }

  const record = resolvedPublication.policies.find((item) => item.slug === policy.slug);
  if (!record) {
    throw new Error(`Validated legal publication is missing policy ${policy.slug}.`);
  }

  const presentation = legalSurfacePresentationFromPublication(resolvedPublication, currentNow);
  const isTemplate = record.mode === 'available-template-not-executed';
  const isEffective = record.effectiveAt !== null && Date.parse(record.effectiveAt) <= currentNow;
  const eyebrow = isTemplate
    ? 'LEGAL / BUSINESS TEMPLATE'
    : !isEffective
      ? 'LEGAL / SCHEDULED PUBLICATION'
      : record.mode === 'notice-published'
        ? 'LEGAL / PRIVACY NOTICE'
        : 'LEGAL / HOSTED POLICY';

  return (
    <LegalPresentationProvider presentation={presentation}>
      <SiteHeader />
      <main className="docs-page page-width">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{record.title}</h1>
        <p className="docs-intro">
          Version: {record.version} · Published: {resolvedPublication.publishedAt} ·{' '}
          {isTemplate
            ? 'Availability: template only — not executed by publication'
            : isEffective
              ? `Effective: ${record.effectiveAt}`
              : `Scheduled effective time: ${record.effectiveAt} (not yet effective)`}
        </p>
        <aside className="docs-callout" role="note" aria-label="Publication metadata">
          {isTemplate ? (
            <p>
              <strong>Template only — not executed by publication.</strong> Publication makes this
              template available for review and does not complete a customer record, supplier
              appointment, DPA, transfer instrument or signature.
            </p>
          ) : !isEffective ? (
            <p>
              <strong>Scheduled publication — not yet effective.</strong> This published document
              takes effect at {record.effectiveAt}.
            </p>
          ) : null}
          <p>
            Markdown SHA-256: <code>{record.publicationMarkdownSha256}</code> · Versioned metadata:{' '}
            <a href={LEGAL_PUBLICATION_METADATA_PATH}>{LEGAL_PUBLICATION_METADATA_PATH}</a>
          </p>
        </aside>
        <nav className="page-breadcrumb" aria-label="Legal documents">
          {legalPolicies.map((item) => (
            <a
              key={item.slug}
              href={`/${item.slug}`}
              aria-current={item.slug === policy.slug ? 'page' : undefined}
            >
              {APPROVED_HOSTED_LEGAL_POLICIES[item.slug].navigationLabel}
            </a>
          ))}
          <a href={`/${policy.slug}.md`}>Read as Markdown</a>
          <a href={LEGAL_PUBLICATION_METADATA_PATH}>Publication metadata (JSON)</a>
        </nav>
        <p>
          Legal and privacy contact: <a href="mailto:legal@opengen.dev">legal@opengen.dev</a>.
          Account and billing support: <a href="mailto:support@opengen.dev">support@opengen.dev</a>.
        </p>
        {policy.introduction && <p>{policy.introduction}</p>}
        <div className="docs-grid">
          <nav className="docs-index legal-index" aria-label="On this page">
            <span className="eyebrow">ON THIS PAGE</span>
            {policy.sections.map((section) => (
              <a key={section.id} href={`#${section.id}`}>
                {section.title}
              </a>
            ))}
          </nav>
          <article className="docs-body" aria-label={record.title}>
            {policy.sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                {section.blocks.map((block, index) => (
                  <PolicyBlock key={index} block={block} />
                ))}
              </section>
            ))}
          </article>
        </div>
      </main>
      <Footer />
    </LegalPresentationProvider>
  );
}
