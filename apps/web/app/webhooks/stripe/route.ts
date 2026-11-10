import { forward } from '../../proxy';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request) {
  return forward(request, '/webhooks/stripe');
}
