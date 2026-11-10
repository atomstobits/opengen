import { forward } from '../proxy';
export const runtime = 'nodejs';
export const GET = (request: Request) => forward(request, '/openapi.json');
