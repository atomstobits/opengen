import { catalog, companies, modelSeries } from '@media-router/catalog';
import { canonicalUrl, siteOrigin } from '../seo';
import { agentEntry } from '@media-router/contracts';

export function GET() {
  const text = `# OpenGen\n\n> Open-source catalog and gateway for image and video generation APIs. Compare exact variants and regional provider routes using source-linked evidence.\n\n## Start here\n\n- [Installable OpenGen skill](${canonicalUrl('/skill.md')})\n- [Image-to-video walkthrough](${canonicalUrl('/guides/image-to-video')})\n- [Image-to-video walkthrough in Markdown](${canonicalUrl('/guides/image-to-video.md')})\n\n${agentEntry(siteOrigin())}\n- [Home](${canonicalUrl('/')})\n- [Model catalog](${canonicalUrl('/models')})\n- [Playground](${canonicalUrl('/playground')})\n- [Model companies](${canonicalUrl('/companies')})\n- [API and self-hosting guide](${canonicalUrl('/docs')})\n- [Account entry](${canonicalUrl('/start')})\n- [Agent setup and support evidence](${canonicalUrl('/agents')})\n- [Local CLI setup](${canonicalUrl('/agents/cli')})\n- [Sitemap](${canonicalUrl('/sitemap.xml')})\n\n## Companies\n\n${companies.map((company) => `- [${company.name}](${canonicalUrl(`/${company.id}`)})`).join('\n')}\n\n## Model series\n\n${modelSeries.map((series) => `- [${series.name}](${canonicalUrl(`/${series.id}`)}): ${series.description}`).join('\n')}\n\n## Evidence and execution\n\nThe catalog currently includes ${catalog.models.length} exact variants and ${catalog.routes.length} documented routes. A listing does not mean a route is configured or live-verified. Original model and provider links, license notes and source-check dates are published on the series pages. Unknown prices and measurements remain unknown. Endpoint region, processing scope and data residency are different concepts.\n\nUse the operator's configured gateway for REST or MCP. Discovery is read-only. Paid generation needs authorization, a supported route, an exact model ID, a budget and a stable idempotency key. Retain the job ID and resume it; never blindly resubmit a request whose upstream acceptance is unknown. Provider keys stay on the gateway.\n`;
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}
