import { forward } from '../../proxy';
export const runtime = 'nodejs';
export const GET = (request: Request) => forward(request, '/.well-known/oauth-protected-resource');
export const OPTIONS = (request: Request) =>
  forward(request, '/.well-known/oauth-protected-resource');
