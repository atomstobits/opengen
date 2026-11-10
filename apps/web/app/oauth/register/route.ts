import { forward } from '../../proxy';
export const maxDuration = 60;
export async function POST(request: Request) {
  return forward(request, '/oauth/register' + new URL(request.url).search);
}
export async function OPTIONS(request: Request) {
  return forward(request, '/oauth/register');
}
