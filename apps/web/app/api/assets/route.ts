import { forward } from '../../proxy';
export async function POST(request: Request) {
  return forward(request, '/v1/assets');
}
export async function DELETE(request: Request) {
  return forward(request, '/v1/assets');
}
