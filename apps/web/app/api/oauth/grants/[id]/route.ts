import { forward } from '../../../../proxy';
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/oauth/grants/${encodeURIComponent(id)}`);
}
