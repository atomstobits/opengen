import { forward } from '../../../../../../proxy';
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string; id: string }> },
) {
  const p = await context.params;
  return forward(
    request,
    `/v1/workspaces/${encodeURIComponent(p.workspaceId)}/generations/${encodeURIComponent(p.id)}/reconcile`,
  );
}
