import { forward } from '../../proxy';
export async function GET(request: Request) {
  return forward(request, '/auth/login' + new URL(request.url).search);
}
export async function POST(request: Request) {
  return forward(request, '/auth/login' + new URL(request.url).search);
}
