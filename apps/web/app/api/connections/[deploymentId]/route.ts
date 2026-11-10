import { forward } from '../../../proxy';
export async function PUT(
  request: Request,
  context: { params: Promise<{ deploymentId: string }> },
) {
  const params = await context.params;
  return forward(request, `/v1/connections/${encodeURIComponent(params.deploymentId)}`);
}
export async function DELETE(
  request: Request,
  context: { params: Promise<{ deploymentId: string }> },
) {
  const params = await context.params;
  return forward(request, `/v1/connections/${encodeURIComponent(params.deploymentId)}`);
}
