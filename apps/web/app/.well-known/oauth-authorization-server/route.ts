import { forward } from '../../proxy';
export async function GET(request: Request) {
  return forward(request, '/.well-known/oauth-authorization-server');
}
