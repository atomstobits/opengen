import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForwarder, forward } from '../apps/web/app/proxy';
import { registeredBackendPath } from '../apps/web/app/registered-http';
import * as activityRoute from '../apps/web/app/api/activity/route';
import * as activityAnalyticsRoute from '../apps/web/app/api/activity/analytics/route';
import * as webhooksRoute from '../apps/web/app/api/webhooks/route';
import * as webhookIdRoute from '../apps/web/app/api/webhooks/[id]/route';
import * as webhookRotateRoute from '../apps/web/app/api/webhooks/[id]/rotate-secret/route';
import * as webhookDeliveriesRoute from '../apps/web/app/api/webhook-deliveries/route';
import * as alertsRoute from '../apps/web/app/api/alerts/route';
import * as alertsSettingsRoute from '../apps/web/app/api/alerts/settings/route';
import * as notificationsRoute from '../apps/web/app/api/notifications/route';
import * as notificationsPrefsRoute from '../apps/web/app/api/notifications/preferences/route';
import * as notificationsReadRoute from '../apps/web/app/api/notifications/[id]/read/route';
import * as governanceKeysRoute from '../apps/web/app/api/governance/keys/route';
import * as governancePoliciesRoute from '../apps/web/app/api/governance/policies/route';
import * as catalogRoute from '../apps/web/app/api/catalog/route';
import * as keysIdRoute from '../apps/web/app/api/keys/[id]/route';
import * as keysRotateRoute from '../apps/web/app/api/keys/[id]/rotate/route';
import * as policiesIdRoute from '../apps/web/app/api/policies/[id]/route';
import * as policiesArchiveRoute from '../apps/web/app/api/policies/[id]/archive/route';

vi.mock('../apps/web/app/proxy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../apps/web/app/proxy')>()),
  forward: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const origin = 'https://opengen.example';
const backend = 'https://gateway.example';
const httpMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function walkFiles(dir: string, skipDir?: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDir && full === skipDir) continue;
      results.push(...walkFiles(full, skipDir));
    } else {
      results.push(full);
    }
  }
  return results;
}

function normalizeNextRoute(filePath: string, appRoot: string): string {
  const rel = relative(appRoot, dirname(filePath)).replaceAll('\\', '/');
  return (
    '/' +
    rel
      .split('/')
      .map((segment) => (/^\[[^/]+\]$/.test(segment) ? '[param]' : segment))
      .join('/')
  );
}

function collectApiHandlers(appRoot: string): Map<string, Set<string>> {
  const apiRoot = join(appRoot, 'api');
  const handlers = new Map<string, Set<string>>();
  for (const file of walkFiles(apiRoot)) {
    if (!file.endsWith('/route.ts') && !file.endsWith('\\route.ts')) continue;
    const source = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const methods = new Set<string>();
    for (const stmt of sf.statements) {
      const exported =
        ts.canHaveModifiers(stmt) &&
        ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name && httpMethods.has(stmt.name.text)) {
        methods.add(stmt.name.text);
      } else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && httpMethods.has(decl.name.text)) {
            methods.add(decl.name.text);
          }
        }
      }
    }
    handlers.set(normalizeNextRoute(file, appRoot), methods);
  }
  return handlers;
}

function normalizeApiExpression(node: ts.Expression): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    if (!node.text.startsWith('/api/') || node.text === '/api/') return undefined;
    return node.text.split('?')[0]!;
  }
  if (ts.isTemplateExpression(node)) {
    if (!node.head.text.startsWith('/api/')) return undefined;
    let route = node.head.text;
    let inQuery = route.includes('?');
    if (inQuery) route = route.split('?')[0]!;
    for (const span of node.templateSpans) {
      if (!inQuery) {
        if (route.endsWith('/')) route += '[param]';
        const lit = span.literal.text;
        if (lit.includes('?')) {
          route += lit.split('?')[0]!;
          inQuery = true;
        } else if (lit.startsWith('/')) {
          route += lit;
        }
      }
    }
    return route.length > '/api/'.length ? route.replace(/\/+$/, '') : undefined;
  }
  return undefined;
}

function extractApiRoutes(expr: ts.Expression): string[] {
  const unwrapped = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  const direct = normalizeApiExpression(unwrapped);
  if (direct) return [direct];
  if (ts.isConditionalExpression(unwrapped)) {
    return [...extractApiRoutes(unwrapped.whenTrue), ...extractApiRoutes(unwrapped.whenFalse)];
  }
  return [];
}

function extractMethodStrings(expr: ts.Expression): string[] {
  const unwrapped = ts.isParenthesizedExpression(expr) ? expr.expression : expr;
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    const upper = unwrapped.text.toUpperCase();
    return httpMethods.has(upper) ? [upper] : [];
  }
  if (ts.isConditionalExpression(unwrapped)) {
    return [
      ...extractMethodStrings(unwrapped.whenTrue),
      ...extractMethodStrings(unwrapped.whenFalse),
    ];
  }
  return [];
}

function findMethodProperty(obj: ts.ObjectLiteralExpression): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ((ts.isIdentifier(prop.name) && prop.name.text === 'method') ||
        (ts.isStringLiteral(prop.name) && prop.name.text === 'method'))
    ) {
      return prop.initializer;
    }
  }
  return undefined;
}

function pairRoutesAndMethods(
  routeExpr: ts.Expression,
  methodExpr: ts.Expression | undefined,
  sf: ts.SourceFile,
): { route: string; method: string }[] {
  if (!methodExpr) {
    return extractApiRoutes(routeExpr).map((route) => ({ route, method: 'GET' }));
  }
  const uRoute = ts.isParenthesizedExpression(routeExpr) ? routeExpr.expression : routeExpr;
  const uMethod = ts.isParenthesizedExpression(methodExpr) ? methodExpr.expression : methodExpr;
  if (
    ts.isConditionalExpression(uRoute) &&
    ts.isConditionalExpression(uMethod) &&
    uRoute.condition.getText(sf) === uMethod.condition.getText(sf)
  ) {
    return [
      ...pairRoutesAndMethods(uRoute.whenTrue, uMethod.whenTrue, sf),
      ...pairRoutesAndMethods(uRoute.whenFalse, uMethod.whenFalse, sf),
    ];
  }
  const routes = extractApiRoutes(uRoute);
  const methods = extractMethodStrings(uMethod);
  const resolved = methods.length ? methods : ['GET'];
  return routes.flatMap((route) => resolved.map((method) => ({ route, method })));
}

describe('frontend /api/* route coverage', () => {
  it('ensures every /api/* endpoint and HTTP method fetched in apps/web/app/** has a matching Next.js route handler', () => {
    const appRoot = join(process.cwd(), 'apps/web/app');
    const handlers = collectApiHandlers(appRoot);
    const files = walkFiles(appRoot, join(appRoot, 'api')).filter(
      (file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('/robots.ts'),
    );

    const allRouteRefs: { file: string; line: number; route: string }[] = [];
    const allCallPairs: { file: string; line: number; route: string; method: string }[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('/api/')) continue;
      const sf = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const localVars = new Map<string, ts.Expression>();

      const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          if (extractApiRoutes(node.initializer).length > 0) {
            localVars.set(node.name.text, node.initializer);
          }
        }
        if (
          ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)
        ) {
          const normalized = normalizeApiExpression(node);
          if (normalized) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            allRouteRefs.push({ file: relative(process.cwd(), file), line, route: normalized });
          }
        }
        if (ts.isCallExpression(node)) {
          let routeArgIndex = -1;
          let routeExpr: ts.Expression | undefined;
          for (let i = 0; i < node.arguments.length; i++) {
            const arg = node.arguments[i]!;
            if (extractApiRoutes(arg).length > 0) {
              routeArgIndex = i;
              routeExpr = arg;
              break;
            }
            if (ts.isIdentifier(arg) && localVars.has(arg.text)) {
              routeArgIndex = i;
              routeExpr = localVars.get(arg.text);
              break;
            }
          }
          if (routeExpr) {
            let methodExpr: ts.Expression | undefined;
            for (let i = routeArgIndex + 1; i < node.arguments.length; i++) {
              const arg = node.arguments[i]!;
              if (ts.isObjectLiteralExpression(arg)) {
                const prop = findMethodProperty(arg);
                if (prop) {
                  methodExpr = prop;
                  break;
                }
              } else if (extractMethodStrings(arg).length > 0) {
                methodExpr = arg;
                break;
              }
            }
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            for (const pair of pairRoutesAndMethods(routeExpr, methodExpr, sf)) {
              allCallPairs.push({
                file: relative(process.cwd(), file),
                line,
                ...pair,
              });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    expect(allRouteRefs.length).toBeGreaterThanOrEqual(50);
    expect(allCallPairs.length).toBeGreaterThanOrEqual(50);

    const missingRoutes = allRouteRefs.filter((ref) => !handlers.has(ref.route));
    expect(missingRoutes, 'Frontend references /api/* routes without a Next.js route.ts').toEqual(
      [],
    );

    const missingMethods = allCallPairs.filter((call) => {
      const exported = handlers.get(call.route);
      return !exported || !exported.has(call.method);
    });
    expect(
      missingMethods,
      'Frontend invokes an HTTP method not exported by the matching Next.js route.ts',
    ).toEqual([]);

    // Confirm the newly added operations and governance endpoints were observed by the scanner.
    const observed = new Set(allCallPairs.map((call) => `${call.method} ${call.route}`));
    for (const required of [
      'GET /api/activity',
      'GET /api/activity/analytics',
      'GET /api/webhooks',
      'POST /api/webhooks',
      'PATCH /api/webhooks/[param]',
      'POST /api/webhooks/[param]/rotate-secret',
      'GET /api/webhook-deliveries',
      'GET /api/alerts',
      'GET /api/alerts/settings',
      'PUT /api/alerts/settings',
      'GET /api/notifications',
      'GET /api/notifications/preferences',
      'PUT /api/notifications/preferences',
      'POST /api/notifications/[param]/read',
      'GET /api/governance/keys',
      'GET /api/governance/policies',
      'GET /api/catalog',
      'PATCH /api/keys/[param]',
      'DELETE /api/keys/[param]',
      'POST /api/keys/[param]/rotate',
      'PATCH /api/policies/[param]',
      'POST /api/policies/[param]/archive',
    ]) {
      expect(observed, `Expected scanner to observe ${required}`).toContain(required);
    }
  }, 30_000);
});

describe('activity, webhook, alert, and notification relay handlers', () => {
  const mockedForward = vi.mocked(forward);

  it('forwards /api/activity with allowlisted filters and rejects unknown or duplicate params', async () => {
    const ok = Response.json({ items: [], nextCursor: null });
    mockedForward.mockResolvedValueOnce(ok);
    const bare = new Request(`${origin}/api/activity`);
    expect(await activityRoute.GET(bare)).toBe(ok);
    expect(mockedForward).toHaveBeenLastCalledWith(bare, '/v1/activity');

    const params = new URLSearchParams({
      modelId: 'minimax/h3-max',
      providerId: 'fal',
      deploymentId: 'fal/global',
      endpointRegion: 'global',
      operation: 'text-to-video',
      keyId: 'key-1',
      status: 'succeeded',
      project: 'studio & prod',
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-08T00:00:00.000Z',
      limit: '25',
      cursor: 'opaque+/=cursor',
    });
    mockedForward.mockResolvedValueOnce(ok);
    const filtered = new Request(`${origin}/api/activity?${params.toString()}`);
    expect(await activityRoute.GET(filtered)).toBe(ok);
    expect(mockedForward).toHaveBeenLastCalledWith(filtered, `/v1/activity?${params.toString()}`);

    mockedForward.mockClear();
    for (const badQuery of ['workspaceId=other', 'unknown=1', 'limit=10&limit=25']) {
      const response = await activityRoute.GET(new Request(`${origin}/api/activity?${badQuery}`));
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mockedForward).not.toHaveBeenCalled();
  });

  it('forwards /api/activity/analytics filters and rejects pagination, unknown, or duplicate params', async () => {
    const ok = Response.json({ sampleCount: 0, cohorts: [] });
    mockedForward.mockResolvedValueOnce(ok);
    const emptyQuery = new Request(`${origin}/api/activity/analytics?`);
    expect(await activityAnalyticsRoute.GET(emptyQuery)).toBe(ok);
    expect(mockedForward).toHaveBeenLastCalledWith(emptyQuery, '/v1/activity/analytics');

    const params = new URLSearchParams({
      modelId: 'alibaba/wan-3.0',
      since: '2026-11-01T00:00:00.000Z',
      until: '2026-11-08T00:00:00.000Z',
    });
    mockedForward.mockResolvedValueOnce(ok);
    const filtered = new Request(`${origin}/api/activity/analytics?${params.toString()}`);
    expect(await activityAnalyticsRoute.GET(filtered)).toBe(ok);
    expect(mockedForward).toHaveBeenLastCalledWith(
      filtered,
      `/v1/activity/analytics?${params.toString()}`,
    );

    mockedForward.mockClear();
    for (const badQuery of [
      'limit=25',
      'cursor=abc',
      'workspaceId=other',
      'since=2026-11-01T00:00:00Z&since=2026-11-02T00:00:00Z',
    ]) {
      const response = await activityAnalyticsRoute.GET(
        new Request(`${origin}/api/activity/analytics?${badQuery}`),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mockedForward).not.toHaveBeenCalled();
  });

  it('forwards webhooks, webhook-deliveries, and alerts endpoints with exact methods and encoded IDs', async () => {
    const ok = Response.json({ data: [] });
    const id = '11111111-2222-4333-8444-555555555555';

    mockedForward.mockResolvedValue(ok);
    const listWebhooks = new Request(`${origin}/api/webhooks?ignored=1`);
    await webhooksRoute.GET(listWebhooks);
    expect(mockedForward).toHaveBeenLastCalledWith(listWebhooks, '/v1/webhooks');

    const createWebhook = new Request(`${origin}/api/webhooks`, { method: 'POST', body: '{}' });
    await webhooksRoute.POST(createWebhook);
    expect(mockedForward).toHaveBeenLastCalledWith(createWebhook, '/v1/webhooks');

    const patchWebhook = new Request(`${origin}/api/webhooks/${id}`, {
      method: 'PATCH',
      body: '{"enabled":false}',
    });
    await webhookIdRoute.PATCH(patchWebhook, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(patchWebhook, `/v1/webhooks/${id}`);
    expect(webhookIdRoute).not.toHaveProperty('GET');
    expect(webhookIdRoute).not.toHaveProperty('DELETE');

    const encodedId = 'bad/id?x=1';
    await webhookIdRoute.PATCH(patchWebhook, { params: Promise.resolve({ id: encodedId }) });
    expect(mockedForward).toHaveBeenLastCalledWith(
      patchWebhook,
      `/v1/webhooks/${encodeURIComponent(encodedId)}`,
    );

    const rotateWebhook = new Request(`${origin}/api/webhooks/${id}/rotate-secret`, {
      method: 'POST',
    });
    await webhookRotateRoute.POST(rotateWebhook, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(
      rotateWebhook,
      `/v1/webhooks/${id}/rotate-secret`,
    );

    const deliveries = new Request(`${origin}/api/webhook-deliveries?ignored=1`);
    await webhookDeliveriesRoute.GET(deliveries);
    expect(mockedForward).toHaveBeenLastCalledWith(deliveries, '/v1/webhook-deliveries');

    const alerts = new Request(`${origin}/api/alerts?ignored=1`);
    await alertsRoute.GET(alerts);
    expect(mockedForward).toHaveBeenLastCalledWith(alerts, '/v1/alerts');

    const getAlertSettings = new Request(`${origin}/api/alerts/settings`);
    await alertsSettingsRoute.GET(getAlertSettings);
    expect(mockedForward).toHaveBeenLastCalledWith(getAlertSettings, '/v1/alerts/settings');

    const putAlertSettings = new Request(`${origin}/api/alerts/settings`, {
      method: 'PUT',
      body: '{}',
    });
    await alertsSettingsRoute.PUT(putAlertSettings);
    expect(mockedForward).toHaveBeenLastCalledWith(putAlertSettings, '/v1/alerts/settings');
  });

  it('forwards notification routes with strict query allowlisting and encoded IDs', async () => {
    const ok = Response.json({ items: [], nextCursor: null });
    mockedForward.mockResolvedValue(ok);

    const bare = new Request(`${origin}/api/notifications`);
    await notificationsRoute.GET(bare);
    expect(mockedForward).toHaveBeenLastCalledWith(bare, '/v1/notifications');

    const params = new URLSearchParams({
      limit: '25',
      cursor: 'cursor+/=1',
      unreadOnly: 'true',
    });
    const list = new Request(`${origin}/api/notifications?${params.toString()}`);
    await notificationsRoute.GET(list);
    expect(mockedForward).toHaveBeenLastCalledWith(list, `/v1/notifications?${params.toString()}`);

    mockedForward.mockClear();
    for (const badQuery of ['membershipId=other', 'limit=10&limit=25', 'extra=1']) {
      const response = await notificationsRoute.GET(
        new Request(`${origin}/api/notifications?${badQuery}`),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mockedForward).not.toHaveBeenCalled();

    const getPrefs = new Request(`${origin}/api/notifications/preferences`);
    await notificationsPrefsRoute.GET(getPrefs);
    expect(mockedForward).toHaveBeenLastCalledWith(getPrefs, '/v1/notifications/preferences');

    const putPrefs = new Request(`${origin}/api/notifications/preferences`, {
      method: 'PUT',
      body: '{}',
    });
    await notificationsPrefsRoute.PUT(putPrefs);
    expect(mockedForward).toHaveBeenLastCalledWith(putPrefs, '/v1/notifications/preferences');

    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const markRead = new Request(`${origin}/api/notifications/${id}/read`, { method: 'POST' });
    await notificationsReadRoute.POST(markRead, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(markRead, `/v1/notifications/${id}/read`);
  });
});

describe('governance, catalog, keys, and policies relay handlers', () => {
  const mockedForward = vi.mocked(forward);

  it('forwards /api/governance/keys and rejects any query parameters', async () => {
    const ok = Response.json({ data: [] });
    mockedForward.mockResolvedValueOnce(ok);
    const request = new Request(`${origin}/api/governance/keys`);
    expect(await governanceKeysRoute.GET(request)).toBe(ok);
    expect(mockedForward).toHaveBeenLastCalledWith(request, '/v1/governance/keys');

    mockedForward.mockClear();
    const invalid = await governanceKeysRoute.GET(
      new Request(`${origin}/api/governance/keys?workspaceId=other`),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(mockedForward).not.toHaveBeenCalled();
  });

  it('forwards /api/governance/policies with strict includeArchived allowlisting', async () => {
    const ok = Response.json({ data: [] });
    mockedForward.mockResolvedValue(ok);

    const bare = new Request(`${origin}/api/governance/policies`);
    await governancePoliciesRoute.GET(bare);
    expect(mockedForward).toHaveBeenLastCalledWith(bare, '/v1/governance/policies');

    for (const flag of ['true', 'false']) {
      const request = new Request(`${origin}/api/governance/policies?includeArchived=${flag}`);
      await governancePoliciesRoute.GET(request);
      expect(mockedForward).toHaveBeenLastCalledWith(
        request,
        `/v1/governance/policies?includeArchived=${flag}`,
      );
    }

    mockedForward.mockClear();
    for (const badQuery of [
      'includeArchived=yes',
      'includeArchived=true&includeArchived=false',
      'workspaceId=other',
      'includeArchived=true&extra=1',
    ]) {
      const response = await governancePoliciesRoute.GET(
        new Request(`${origin}/api/governance/policies?${badQuery}`),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(mockedForward).not.toHaveBeenCalled();
  });

  it('forwards /api/catalog, /api/keys/[id], /api/keys/[id]/rotate, /api/policies/[id], and /api/policies/[id]/archive', async () => {
    const ok = Response.json({});
    mockedForward.mockResolvedValue(ok);
    const id = '22222222-3333-4444-8555-666666666666';

    const cat = new Request(`${origin}/api/catalog?ignored=1`);
    await catalogRoute.GET(cat);
    expect(mockedForward).toHaveBeenLastCalledWith(cat, '/v1/catalog');

    const patchKey = new Request(`${origin}/api/keys/${id}`, { method: 'PATCH', body: '{}' });
    await keysIdRoute.PATCH(patchKey, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(patchKey, `/v1/keys/${id}`);

    const deleteKey = new Request(`${origin}/api/keys/${id}`, { method: 'DELETE' });
    await keysIdRoute.DELETE(deleteKey, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(deleteKey, `/v1/keys/${id}`);

    const rotateKey = new Request(`${origin}/api/keys/${id}/rotate`, {
      method: 'POST',
      body: '{"expectedSecretVersion":1}',
    });
    await keysRotateRoute.POST(rotateKey, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(rotateKey, `/v1/keys/${id}/rotate`);

    const patchPolicy = new Request(`${origin}/api/policies/${id}`, {
      method: 'PATCH',
      body: '{}',
    });
    await policiesIdRoute.PATCH(patchPolicy, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(patchPolicy, `/v1/policies/${id}`);
    expect(policiesIdRoute).not.toHaveProperty('GET');
    expect(policiesIdRoute).not.toHaveProperty('DELETE');

    const archivePolicy = new Request(`${origin}/api/policies/${id}/archive`, {
      method: 'POST',
      body: '{"expectedRevision":1}',
    });
    await policiesArchiveRoute.POST(archivePolicy, { params: Promise.resolve({ id }) });
    expect(mockedForward).toHaveBeenLastCalledWith(archivePolicy, `/v1/policies/${id}/archive`);
  });
});

describe('relay forwarder registration, traversal rejection, and no-store guarantees', () => {
  it('accepts every new relay backend path, forces Cache-Control: no-store, and supports empty-body POSTs', async () => {
    const calls: { url: string; method?: string; headers: Headers }[] = [];
    const realForward = createForwarder({
      env: { NODE_ENV: 'test', MEDIA_ROUTER_API_URL: backend },
      transport: async () => undefined,
      request: async (url, init) => {
        calls.push({ url: String(url), method: init?.method, headers: new Headers(init?.headers) });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'public, max-age=300',
          },
        });
      },
    });
    const id = '11111111-2222-4333-8444-555555555555';
    const cases: [string, string, string?][] = [
      ['GET', '/v1/activity?limit=25'],
      ['GET', '/v1/activity/analytics?since=2026-11-01T00%3A00%3A00.000Z'],
      ['GET', '/v1/webhooks'],
      ['POST', '/v1/webhooks', '{}'],
      ['PATCH', `/v1/webhooks/${id}`, '{"enabled":false}'],
      ['POST', `/v1/webhooks/${id}/rotate-secret`],
      ['GET', '/v1/webhook-deliveries'],
      ['GET', '/v1/alerts'],
      ['GET', '/v1/alerts/settings'],
      ['PUT', '/v1/alerts/settings', '{"enabled":false,"webhookFailures":false}'],
      ['GET', '/v1/notifications?limit=25'],
      ['GET', '/v1/notifications/preferences'],
      ['PUT', '/v1/notifications/preferences', '{"inApp":true,"eventTypes":[]}'],
      ['POST', `/v1/notifications/${id}/read`],
      ['GET', '/v1/governance/keys'],
      ['GET', '/v1/governance/policies?includeArchived=true'],
      ['GET', '/v1/catalog'],
      ['PATCH', `/v1/keys/${id}`, '{"name":"Updated"}'],
      ['DELETE', `/v1/keys/${id}`],
      ['POST', `/v1/keys/${id}/rotate`, '{"expectedSecretVersion":1}'],
      ['PATCH', `/v1/policies/${id}`, '{"expectedRevision":1,"name":"Updated"}'],
      ['POST', `/v1/policies/${id}/archive`, '{"expectedRevision":1}'],
      ['GET', '/v1/operator/reconciliations/pending?kind=supplier-cost&limit=50'],
    ];
    for (const [method, path, body] of cases) {
      expect(registeredBackendPath(path, method), `${method} ${path}`).toBe(true);
      const response = await realForward(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            cookie: 'og_session=private-session',
            origin,
            'x-opengen-workspace': 'ws-a',
            'x-opengen-recovery-scope': 'scope-a',
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body } : {}),
        }),
        path,
      );
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const sent = calls.at(-1)!;
      expect(sent.url).toBe(`${backend}${path}`);
      expect(sent.headers.get('cookie')).toBe('og_session=private-session');
      expect(sent.headers.get('x-opengen-workspace')).toBe('ws-a');
      expect(sent.headers.get('x-opengen-recovery-scope')).toBe('scope-a');
    }
  });

  it('rejects encoded path traversal and unregistered methods before reaching the backend', async () => {
    const request = vi.fn<typeof fetch>();
    const realForward = createForwarder({
      env: { NODE_ENV: 'test', MEDIA_ROUTER_API_URL: backend },
      transport: async () => undefined,
      request,
    });
    for (const badId of ['..', '.', 'a/b', 'id?workspaceId=other', 'id#fragment', '']) {
      const encoded = encodeURIComponent(badId);
      for (const [method, path] of [
        ['PATCH', `/v1/webhooks/${encoded}`],
        ['POST', `/v1/webhooks/${encoded}/rotate-secret`],
        ['POST', `/v1/notifications/${encoded}/read`],
        ['PATCH', `/v1/keys/${encoded}`],
        ['POST', `/v1/keys/${encoded}/rotate`],
        ['PATCH', `/v1/policies/${encoded}`],
        ['POST', `/v1/policies/${encoded}/archive`],
      ] as const) {
        const response = await realForward(new Request(`${origin}${path}`, { method }), path);
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    }
    expect(request).not.toHaveBeenCalled();
  });
});
