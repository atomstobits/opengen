import { forward } from '../../../proxy';

const analyticsFilters = [
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
];

export async function GET(request: Request) {
  const input = new URL(request.url).searchParams;
  if (
    [...input.keys()].some((key) => !analyticsFilters.includes(key)) ||
    [...input.keys()].some((key) => input.getAll(key).length !== 1)
  )
    return Response.json(
      { error: 'Unsupported activity analytics filter.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  return forward(request, `/v1/activity/analytics${input.size ? `?${input.toString()}` : ''}`);
}
