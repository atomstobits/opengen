import { forward } from '../../../proxy';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/generations/${encodeURIComponent(id)}`);
}
