import { forward } from '../../proxy';

const activityFilters = [
  'modelId',
  'providerId',
  'deploymentId',
  'endpointRegion',
  'operation',
  'keyId',
  'status',
  'project',
  'since',
  'until',
  'limit',
  'cursor',
];

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !activityFilters.includes(key)) ||
    [...input.keys()].some((key) => input.getAll(key).length !== 1)
  )
    return Response.json(
      { error: 'Unsupported activity filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/activity${input.size ? `?${input.toString()}` : ''}`);
}
