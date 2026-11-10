import { forward } from '../../../proxy';
export async function DELETE(request: Request) {
  return forward(request, '/v1/billing/mandate');
}
