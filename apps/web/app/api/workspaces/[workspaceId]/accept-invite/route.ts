import { forward } from '../../../../proxy';
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await context.params;
  return forward(request, `/v1/workspaces/${encodeURIComponent(workspaceId)}/accept-invite`);
}
