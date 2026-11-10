import { forward } from '../../../proxy';
export async function GET(request: Request) {
  return forward(request, '/v1/billing/policy');
}
export async function PUT(request: Request) {
  return forward(request, '/v1/billing/policy');
}
