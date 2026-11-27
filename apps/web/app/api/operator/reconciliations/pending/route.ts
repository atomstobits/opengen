import { forward } from '../../../../proxy';

const ALLOWED_KEYS = new Set(['workspaceId', 'kind', 'minAgeMinutes', 'limit']);

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !ALLOWED_KEYS.has(key)) ||
    [...ALLOWED_KEYS].some((key) => input.getAll(key).length > 1)
  ) {
    return Response.json(
      { error: 'Unsupported pending reconciliation filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return forward(
    request,
    `/v1/operator/reconciliations/pending${input.size ? `?${input.toString()}` : ''}`,
  );
}
