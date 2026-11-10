import { forward } from '../../../../../proxy';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return forward(request, `/v1/billing/recharges/${encodeURIComponent(id)}/authentication`);
}
