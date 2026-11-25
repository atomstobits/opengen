import { forward } from '../../../proxy';
export async function GET(request: Request) {
  if (new URL(request.url).searchParams.size)
    return Response.json(
      { error: 'Unsupported governance key filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, '/v1/governance/keys');
}
