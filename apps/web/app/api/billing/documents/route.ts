import { forward } from '../../../proxy';
export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !['type', 'limit', 'before'].includes(key)) ||
    [...input.keys()].some((key) => input.getAll(key).length !== 1)
  )
    return Response.json(
      { error: 'Unsupported billing document filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/billing/documents${input.size ? `?${input.toString()}` : ''}`);
}
