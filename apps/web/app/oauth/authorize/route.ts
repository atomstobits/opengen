import { forward } from '../../proxy';
export const maxDuration = 60;
export async function GET(request: Request) {
  return forward(request, '/oauth/authorize' + new URL(request.url).search);
}
