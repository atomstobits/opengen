import { forward } from '../../proxy';
export async function GET(request: Request) {
  return forward(request, '/auth/callback' + new URL(request.url).search);
}
