import { forward } from '../../../proxy';
export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  const includeArchived = input.getAll('includeArchived');
  if (
    [...input.keys()].some((key) => key !== 'includeArchived') ||
    includeArchived.length > 1 ||
    (includeArchived.length === 1 && !['true', 'false'].includes(includeArchived[0]!))
  )
    return Response.json(
      { error: 'Unsupported governance policy filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/governance/policies${input.size ? `?${input.toString()}` : ''}`);
}
