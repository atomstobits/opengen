import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { McpOAuthError, McpOAuthStore, mcpOAuthScopes, type Principal } from '@media-router/engine';

interface Context {
  store?: McpOAuthStore;
  publicUrl: string;
  signInEnabled?: boolean;
  /** Cookie session only: never treat a caller-supplied bearer token as browser consent. */
  authenticateBrowser(request: FastifyRequest): Promise<Principal>;
  authenticate(request: FastifyRequest): Promise<Principal>;
}
const scalar = z.string().max(4096);
const authorizationSchema = z
  .object({
    client_id: scalar,
    redirect_uri: scalar,
    response_type: z.literal('code'),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal('S256'),
    scope: z.string().max(200).optional(),
    state: scalar.optional(),
    resource: scalar.optional(),
  })
  .strict();
const tokenSchema = z.discriminatedUnion('grant_type', [
  z
    .object({
      grant_type: z.literal('authorization_code'),
      client_id: scalar,
      code: scalar,
      redirect_uri: scalar,
      code_verifier: scalar,
      resource: scalar.optional(),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal('refresh_token'),
      client_id: scalar,
      refresh_token: scalar,
      scope: z.string().max(200).optional(),
      resource: scalar.optional(),
    })
    .strict(),
]);
function protocolError(error: unknown, reply: FastifyReply) {
  if (error instanceof McpOAuthError) {
    if (error.statusCode === 429) reply.header('Retry-After', '3600');
    return reply
      .code(error.statusCode)
      .send({ error: error.code, error_description: error.message });
  }
  if (error instanceof z.ZodError)
    return reply.code(400).send({
      error: 'invalid_request',
      error_description: 'The request does not match the supported OAuth protocol.',
    });
  const status =
    error instanceof Error && 'statusCode' in error ? Number(error.statusCode) : undefined;
  if (status === 401 || status === 403)
    return reply.code(status).send({
      error: 'access_denied',
      error_description: 'An eligible browser session and the OpenGen consent origin are required.',
    });
  return reply.code(503).send({
    error: 'temporarily_unavailable',
    error_description:
      'Authorization is unavailable. No credentials or provider request was issued.',
  });
}
export async function registerMcpAuthorization(app: FastifyInstance, context: Context) {
  const issuer = new URL(context.publicUrl).origin;
  const signInEnabled =
    context.signInEnabled ??
    Boolean(
      process.env.OIDC_ISSUER &&
      process.env.OIDC_CLIENT_ID &&
      process.env.OIDC_CLIENT_SECRET &&
      process.env.MR_SESSION_SECRET,
    );
  const metadata = () =>
    context.store?.metadata() ?? {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...mcpOAuthScopes],
    };
  const store = () => {
    if (!context.store)
      throw new McpOAuthError(
        'temporarily_unavailable',
        'Configure the account database before authorization.',
        503,
      );
    return context.store;
  };
  app.get('/.well-known/oauth-authorization-server', async () => metadata());
  app.get(
    '/.well-known/oauth-protected-resource',
    async () =>
      context.store?.resourceMetadata() ?? {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: [...mcpOAuthScopes],
        bearer_methods_supported: ['header'],
      },
  );
  app.get(
    '/.well-known/oauth-protected-resource/mcp',
    async () =>
      context.store?.resourceMetadata() ?? {
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: [...mcpOAuthScopes],
        bearer_methods_supported: ['header'],
      },
  );
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded'))
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 16384 },
      (_request, body, done) => {
        const params = new URLSearchParams(String(body)),
          result: Record<string, string> = {};
        for (const [key, value] of params) {
          if (Object.hasOwn(result, key))
            return done(
              new McpOAuthError('invalid_request', 'Repeated OAuth parameters are not supported.'),
            );
          Object.defineProperty(result, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        done(null, result);
      },
    );
  for (const path of ['/oauth/token', '/oauth/register', '/oauth/revoke'])
    app.options(path, async (_request, reply) =>
      reply
        .header('Access-Control-Allow-Origin', '*')
        .header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'Content-Type')
        .header('Access-Control-Max-Age', '600')
        .code(204)
        .send(),
    );
  const oauth =
    (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'no-referrer');
      if (['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(request.url.split('?')[0]!))
        reply.header('Access-Control-Allow-Origin', '*');
      try {
        return await handler(request, reply);
      } catch (error) {
        return protocolError(error, reply);
      }
    };
  const protocolBody = {
    bodyLimit: 16384,
    errorHandler: (
      error: Error & { statusCode?: number },
      request: FastifyRequest,
      reply: FastifyReply,
    ) => {
      reply.header('Cache-Control', 'no-store').header('Pragma', 'no-cache');
      if (['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(request.url.split('?')[0]!))
        reply.header('Access-Control-Allow-Origin', '*');
      if ([400, 413, 415].includes(error.statusCode ?? 0) && !(error instanceof McpOAuthError))
        return reply.code(error.statusCode!).send({
          error: 'invalid_request',
          error_description: 'Use a supported request body no larger than 16 KiB.',
        });
      return protocolError(error, reply);
    },
  };
  app.post(
    '/oauth/register',
    protocolBody,
    oauth(async (request, reply) => {
      const input = z
        .object({
          client_name: z.string().max(120).optional(),
          redirect_uris: z.array(z.string().max(2048)).min(1).max(10),
          token_endpoint_auth_method: z.literal('none').optional(),
          grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
          response_types: z.array(z.literal('code')).optional(),
        })
        .parse(request.body);
      reply.code(201);
      return store().registerClient(
        { clientName: input.client_name, redirectUris: input.redirect_uris },
        request.ip,
      );
    }),
  );
  app.get(
    '/oauth/authorize',
    oauth(async (request, reply) => {
      const input = authorizationSchema.parse(request.query);
      const auth = await store().beginAuthorization(
        {
          clientId: input.client_id,
          redirectUri: input.redirect_uri,
          responseType: input.response_type,
          codeChallenge: input.code_challenge,
          codeChallengeMethod: input.code_challenge_method,
          scope: input.scope,
          state: input.state,
          resource: input.resource,
        },
        request.ip,
      );
      return reply.redirect(auth.consentUrl);
    }),
  );
  app.get(
    '/oauth/login',
    oauth(async (request, reply) => {
      if (!signInEnabled)
        throw new McpOAuthError(
          'temporarily_unavailable',
          'Account sign-in is not configured. Connect a scoped workspace key on the consent page.',
          503,
        );
      const { request: requestId } = z
        .object({ request: z.string() })
        .strict()
        .parse(request.query);
      if (!(await store().pendingAuthorization(requestId)))
        throw new McpOAuthError('invalid_request', 'Authorization request expired.');
      reply.setCookie('og_mcp_consent', requestId, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: issuer.startsWith('https:'),
        maxAge: 600,
      });
      return reply.redirect(`${issuer}/auth/login`);
    }),
  );
  app.get(
    '/oauth/consent',
    oauth(async (request, reply) => {
      const { request: requestId } = z
        .object({ request: z.string() })
        .strict()
        .parse(request.query);
      let actor: Principal;
      try {
        actor = await context.authenticateBrowser(request);
      } catch {
        return reply.code(401).send({
          error: 'login_required',
          loginUrl: signInEnabled ? `/oauth/login?request=${encodeURIComponent(requestId)}` : null,
        });
      }
      return store().consentView(requestId, actor);
    }),
  );
  app.post(
    '/oauth/consent',
    protocolBody,
    oauth(async (request) => {
      if (request.headers.origin !== issuer)
        throw new McpOAuthError(
          'access_denied',
          'Consent must be submitted from this OpenGen origin.',
          403,
        );
      const actor = await context.authenticateBrowser(request);
      const input = z
        .object({
          requestId: z.string(),
          workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
          scopes: z.array(z.enum(mcpOAuthScopes)).max(2),
          approve: z.boolean(),
        })
        .strict()
        .parse(request.body);
      return store().approve(
        input.requestId,
        actor,
        input.workspaceId,
        input.scopes,
        input.approve,
      );
    }),
  );
  app.post(
    '/oauth/token',
    protocolBody,
    oauth(async (request) => {
      await store().rateLimit('token-global', 'installation', 10000);
      await store().rateLimit('token', request.ip, 1000);
      const input = tokenSchema.parse(request.body);
      return input.grant_type === 'authorization_code'
        ? store().exchangeCode({
            clientId: input.client_id,
            code: input.code,
            redirectUri: input.redirect_uri,
            verifier: input.code_verifier,
            resource: input.resource,
          })
        : store().refresh({
            clientId: input.client_id,
            refreshToken: input.refresh_token,
            scope: input.scope,
            resource: input.resource,
          });
    }),
  );
  app.post(
    '/oauth/revoke',
    protocolBody,
    oauth(async (request, reply) => {
      await store().rateLimit('revoke', request.ip, 1000);
      const input = z
        .object({
          client_id: scalar,
          token: scalar,
          token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
        })
        .strict()
        .parse(request.body);
      await store().revoke(input.client_id, input.token);
      return reply.code(200).send();
    }),
  );
  app.get('/v1/oauth/grants', async (request) => ({
    data: await store().grants(await context.authenticate(request)),
  }));
  app.delete<{ Params: { id: string } }>('/v1/oauth/grants/:id', async (request) =>
    store().revokeGrant(await context.authenticate(request), z.uuid().parse(request.params.id)),
  );
}
