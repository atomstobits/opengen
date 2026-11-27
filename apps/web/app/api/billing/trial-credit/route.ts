import { forward } from '../../../proxy';

export async function GET(request: Request) {
  const response = await forward(request, '/v1/billing/trial-credit');
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}

export async function POST(request: Request) {
  const response = await forward(request, '/v1/billing/trial-credit');
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}
