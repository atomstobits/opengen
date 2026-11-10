import { forward } from '../../../proxy';
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return forward(request, `/v1/keys/${encodeURIComponent(params.id)}`);
}
