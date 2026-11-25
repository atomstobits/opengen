import { forward } from '../../proxy';

const notificationFilters = ['limit', 'cursor', 'unreadOnly'];

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !notificationFilters.includes(key)) ||
    [...input.keys()].some((key) => input.getAll(key).length !== 1)
  )
    return Response.json(
      { error: 'Unsupported notification filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/notifications${input.size ? `?${input.toString()}` : ''}`);
}
