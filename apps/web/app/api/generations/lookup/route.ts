import { forward } from '../../../proxy';

export async function GET(request: Request) {
  const key = request.headers.get('idempotency-key');
  if (!key || key.length > 200)
    return Response.json(
      { error: 'A saved submission key is required.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/generations/lookup?${new URLSearchParams({ idempotencyKey: key })}`);
}
