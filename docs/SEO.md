# OpenGen search and answer-engine foundations

SEO, AEO and GEO are release requirements for the home, model catalog, company and model-series pages. The production canonical origin is `https://opengen.dev`, configured only through the public `OPENGEN_PUBLIC_URL` (or legacy `MEDIA_ROUTER_PUBLIC_URL`) setting. Never build canonical URLs from a request host, provider endpoint or credential.

## What is implemented

- Server-rendered catalog text, company collections, exact variants, provider names, regional rows, source links, license notes and direct internal anchors. A crawler does not need to execute JavaScript to discover the model collection or read the provider table.
- Unique page titles and descriptions, one H1 per primary page, canonical links, Open Graph/Twitter metadata and an original OpenGen social image generated without external media fetching.
- The home page includes short visible answers about OpenGen, comparison methodology and the difference between a documented offering and an executable route. Model pages include specific variant/provider summaries, limits of pricing/performance evidence and source-check dates.
- JSON-LD emitted in the initial HTML: OpenGen Organization/WebSite/SoftwareApplication; landing WebPage for home; CollectionPage and ItemList for the `/models` catalog and directories; BreadcrumbList; CreativeWorkSeries and separately identified model SoftwareApplications. The model catalog lists each exact variant with a selectable series URL. Series ownership stays separate from derivative authorship. Provider companies are not falsely described as model authors.
- No invented ratings, popularity, offers, free generation or benchmark results in structured data. Per-provider prices stay in their published units in the visible comparison table; unqualified price formulas remain unknown.
- `/sitemap.xml` includes canonical public home, `/models`, company/series, documentation and agent-guide paths. No variant aliases, fragments, operational `/playground` URLs or private API paths are listed. No fake `lastModified` timestamps are emitted on every build.
- `/robots.txt` allows public crawling and disallows private/API paths. Preview deployments (`VERCEL_ENV=preview`) and explicitly disabled installations (`OPENGEN_NOINDEX=true`) opt out. Public robots rules do not grant access to authenticated data or override authorization.
- `/models` is the indexable discovery page; `/playground` is a separate `noindex,follow` generation workspace with its own clean canonical. Its model/route query preserves the exact generation choice rather than creating indexable landing pages. Valid `?variant=` deep links canonicalize to the series page because all variants remain present there. Unknown companies/series/invalid variant selections return 404 and non-indexable metadata.
- `/llms.txt` is a public navigation/evidence index. It never contains keys, private account details or an authorization to spend money. It is a convenience for agents, not a ranking requirement or guarantee.

## Content and evidence policy

The main navigation separates **Models** (discover, filter and compare before choosing a series/provider) from **Playground** (supply inputs, quote and create). Company names on model/series cards and pages still link to their canonical publisher pages. Removing the Companies navigation tab does not delete those pages, their APIs or the existing `/companies` directory. Company and series breadcrumbs lead back through Models. Home keeps the approved agent/CLI/API hero and curated model discovery rather than duplicating the full catalog workspace.

Keep the pages useful to humans and quoteable by an answer engine: state what each exact model is, who created it, how its variants differ, where each API offering is documented, what the provider actually bills and what observations exist. Link every model and route to original provider evidence. Publish dates when facts were checked, not a false “updated today” label.

Do not treat a regional endpoint as proof of inference residency. Do not treat a generation success rate as uptime. Do not call an open-weight model unrestricted commercial software unless its license supports that claim. Do not create thin duplicate landing pages for every query combination. Do not add unsupported FAQ/HowTo schema or pretend generic API catalog pages are eligible for unrelated rich-result types.

## Release checks

`tests/seo.test.ts` verifies canonical identity, unique metadata, preview/operational indexing behavior, safe JSON-LD, truthful authorship, server-rendered overview answers and canonical sitemap coverage. The browser suite covers navigation and real 404s. Before deployment, fetch home, a company page and a model page without executing JavaScript and check title, description, canonical, JSON-LD, provider facts, internal links and H1 count; then test the deployed origin and CDN response rather than assuming local output proves production crawlability.

Use the `seo-site-health` audit skill against the deployed canonical domain to establish a baseline. Verify the domain in search webmaster tools, submit the sitemap, and review crawl/indexing reports. Set up a recurring audit only when requested. Native browser accessibility, performance, responsive layout and truthful source data remain part of the experience.

Production release still needs the final selected visual identity, deployment/DNS/redirect verification, public URL configuration, production `robots.txt`/sitemap fetch, Search Console/Bing verification, and measured field performance. A code-level check cannot establish rankings, indexing, answer-engine citations or conversion performance.

## Primary guidance

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features) — standard technical and content fundamentals apply; there is no special AI-search schema requirement and inclusion is not guaranteed.
- [Google: structured data introduction](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data) — markup must describe visible page content.
- [Google: canonical URL guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls) — consistent canonicals, redirects and sitemap signals; robots.txt is not a canonicalization tool.
- [Schema.org CollectionPage](https://schema.org/CollectionPage) — describes catalog collections and their subjects/breadcrumbs.
