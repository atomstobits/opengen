import { forward } from '../../../proxy';

async function relay(request: Request) {
  const response = await forward(request, '/v1/billing/delegations');
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body, { status: response.status, headers });
}

export async function PUT(request: Request) {
  return relay(request);
}

export async function DELETE(request: Request) {
  return relay(request);
}
