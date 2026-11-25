import { forward } from '../../../proxy';
export async function GET(request: Request) {
  return forward(request, '/v1/alerts/settings');
}
export async function PUT(request: Request) {
  return forward(request, '/v1/alerts/settings');
}
