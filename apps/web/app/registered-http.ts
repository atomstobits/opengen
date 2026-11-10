import { operationTargets } from '@media-router/contracts';

const protocolTargets = [
  { method: 'POST', path: '/webhooks/stripe' },
  { method: 'GET', path: '/v1/billing' },
  { method: 'GET', path: '/v1/billing/access' },
  { method: 'PUT', path: '/v1/billing/delegations' },
  { method: 'DELETE', path: '/v1/billing/delegations' },
  { method: 'POST', path: '/v1/billing/setup' },
  { method: 'GET', path: '/v1/billing/setups/:id' },
  { method: 'DELETE', path: '/v1/billing/mandate' },
  { method: 'POST', path: '/v1/billing/portal' },
  { method: 'POST', path: '/v1/billing/documents/sync' },
  { method: 'POST', path: '/v1/billing/recharges/:id/authentication' },
  { method: 'GET', path: '/v1/operator/billing' },
  { method: 'POST', path: '/v1/operator/billing/holds/resolve' },
  { method: 'POST', path: '/v1/operator/billing/recharges/resolve' },
  { method: 'POST', path: '/v1/billing/orders' },
  { method: 'GET', path: '/v1/billing/orders/:id' },
  { method: 'POST', path: '/v1/billing/orders/:id/checkout' },
  { method: 'GET', path: '/v1/comparisons' },
  { method: 'POST', path: '/v1/comparisons/quote' },
  { method: 'GET', path: '/v1/comparisons/:id' },
  { method: 'POST', path: '/v1/comparisons/:id/approve' },
  { method: 'GET', path: '/v1/session' },
  { method: 'POST', path: '/v1/session' },
  { method: 'DELETE', path: '/v1/session' },
  { method: 'POST', path: '/v1/session/workspace' },
  { method: 'GET', path: '/v1/oauth/grants' },
  { method: 'DELETE', path: '/v1/oauth/grants/:id' },
] as const;
const targets = [...Object.values(operationTargets), ...protocolTargets];
export function pathSegments(path: string): string[] | undefined {
  try {
    const result = path.split('/').slice(1).map(decodeURIComponent);
    return result.every(
      (value) =>
        /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/.test(value) && value !== '.' && value !== '..',
    )
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}
/** Registry matching is shared by the public routes and private frontend proxies. */
export function nativeRoute(pathname: string) {
  const input = pathSegments(pathname);
  if (!input) return undefined;
  const matching = targets.filter((target) => {
    const template = target.path.split('/').slice(1);
    return (
      template.length === input.length &&
      template.every((part, index) => part.startsWith(':') || part === input[index])
    );
  });
  if (!matching.length) return undefined;
  return {
    methods: [...new Set<string>(matching.map((target) => target.method))],
    path: '/' + input.map(encodeURIComponent).join('/'),
  };
}
export function registeredBackendPath(path: string, method: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#')) return false;
  const url = new URL(path, 'https://registered.invalid');
  if (url.origin !== 'https://registered.invalid' || url.pathname !== path.split('?')[0])
    return false;
  const native = nativeRoute(url.pathname);
  if (native)
    return native.path === '/webhooks/stripe'
      ? path === '/webhooks/stripe' && method === 'POST'
      : native.methods.includes(method === 'HEAD' ? 'GET' : method);
  return (
    (method === 'GET' &&
      [
        '/auth/login',
        '/auth/callback',
        '/openapi.json',
        '/health',
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
        '/.well-known/oauth-authorization-server',
        '/oauth/authorize',
        '/oauth/login',
        '/oauth/consent',
      ].includes(url.pathname)) ||
    (['POST', 'OPTIONS'].includes(method) &&
      ['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(url.pathname)) ||
    (method === 'POST' && url.pathname === '/auth/login') ||
    (method === 'POST' && url.pathname === '/oauth/consent') ||
    (method === 'POST' && url.pathname === '/mcp')
  );
}
