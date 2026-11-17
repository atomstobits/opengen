export function GET() {
  return new Response(null, {
    status: 308,
    headers: {
      Location: '/terms.md',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
