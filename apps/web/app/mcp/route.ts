import { forward } from '../proxy';
export const runtime = 'nodejs';
export const maxDuration = 60;
export const POST = (request: Request) => forward(request, '/mcp');
const unavailable = () =>
  Response.json(
    { error: 'Use Streamable HTTP POST /mcp.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
export const GET = unavailable;
export const DELETE = unavailable;
