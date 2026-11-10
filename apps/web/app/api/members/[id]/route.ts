import { forward } from '../../../proxy';
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/members/${encodeURIComponent(id)}`);
}
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/members/${encodeURIComponent(id)}`);
}
