import { agentSkill } from '@media-router/contracts';
import { siteOrigin } from '../seo';
export const GET = () =>
  new Response(agentSkill(siteOrigin()), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=60',
    },
  });
