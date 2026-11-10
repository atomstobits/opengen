import { forward } from '../../../proxy';
export async function POST(request: Request) {
  return forward(request, '/v1/billing/orders');
}
