import { forward } from '../../../proxy';
export async function GET(request: Request) {
  return forward(request, '/v1/oauth/grants');
}
