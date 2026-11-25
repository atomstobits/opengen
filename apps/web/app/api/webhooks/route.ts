import { forward } from '../../proxy';
export async function GET(request: Request) {
  return forward(request, '/v1/webhooks');
}
export async function POST(request: Request) {
  return forward(request, '/v1/webhooks');
}
