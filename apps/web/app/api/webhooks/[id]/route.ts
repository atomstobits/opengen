import { forward } from '../../../proxy';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/webhooks/${encodeURIComponent(id)}`);
}
