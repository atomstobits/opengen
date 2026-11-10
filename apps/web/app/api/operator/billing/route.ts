import { forward } from '../../../proxy';
export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !['workspaceId'].includes(key)) ||
    input.getAll('workspaceId').length > 1
  )
    return Response.json(
      { error: 'Unsupported operator billing filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/operator/billing${input.size ? `?${input.toString()}` : ''}`);
}
