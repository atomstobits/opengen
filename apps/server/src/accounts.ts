import {
  currentHumanTermsPolicy,
  humanLoginError,
  sendOidcHandoff,
  registerHumanLogin,
  readHumanLoginTransaction,
  oidcHumanTransaction,
  validateHumanLoginIntent,
  type HumanTermsPolicy,
} from './terms-login.js';
import { TermsReceiptStore } from '@media-router/engine';
import { governancePolicySchema } from './governance.js';
import { sessionRecoveryScope } from './session-recovery.js';
import { assertBrowserRecoveryScope } from './browser-recovery.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';
import { z } from 'zod';
import {
  keyScopes,
  notificationEmailIdentityFromVerifiedOidcClaims,
  AccountGovernanceStore,
  RoutingPolicyStore,
  revalidateGovernanceAuthority,
  type Principal,
  type KeyScope,
  type AccountStore,
  type AssetStore,
  type McpOAuthStore,
  type NotificationEmailStore,
} from '@media-router/engine';
import { catalog } from '@media-router/catalog';
import { routingSchema } from './validation.js';
import { createOAuthResource } from './oauth.js';
import {
  teamCreateSchema,
  memberInviteSchema,
  memberRoleSchema,
  sessionWorkspaceSchema,
} from './team-schemas.js';

export interface AccountsEngine {
  accounts?: AccountStore;
  mcpOAuth?: McpOAuthStore;
  notificationEmail?: NotificationEmailStore;
  storage?: AssetStore;
  ensureWorkspace?(id: string, balance?: number): Promise<unknown>;
  creditWorkspace?(id: string, amount: number, reference: string): Promise<unknown>;
}
const unauthorized = () =>
  Object.assign(new Error('A valid OpenGen session or bearer token is required.'), {
    statusCode: 401,
    code: 'unauthorized',
  });
export async function registerAccounts(
  app: FastifyInstance,
  options: {
    engine?: AccountsEngine;
    apiToken?: string;
    workspaceId?: string;
    publicUrl?: string;
    env?: NodeJS.ProcessEnv;
    /** Internal fixture seam; hosted policy adoption is not enabled by environment flags. */
    humanTermsPolicy?: () => HumanTermsPolicy;
  },
) {
  const env = options.env ?? process.env;
  await app.register(cookie, { secret: env.MR_SESSION_SECRET });
  const publicUrl = new URL(options.publicUrl ?? env.OPENGEN_PUBLIC_URL ?? 'http://localhost:4320');
  const secure = publicUrl.protocol === 'https:';
  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    maxAge: 43200,
  };
  const oidcEnabled = Boolean(
    env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.MR_SESSION_SECRET,
  );
  const oauth = createOAuthResource(env);
  if (oauth && oauth.metadata.resource !== new URL('/mcp', publicUrl).href)
    throw new Error('OIDC_API_AUDIENCE must match the canonical public /mcp URL.');
  if (oidcEnabled && env.MR_SESSION_SECRET!.length < 32)
    throw new Error('MR_SESSION_SECRET must contain at least 32 characters for OIDC.');
  const store = () => {
    if (!options.engine?.accounts)
      throw Object.assign(new Error('The account database is not configured.'), {
        statusCode: 503,
        code: 'database_not_configured',
      });
    return options.engine.accounts;
  };
  const bootstrap = (token: string) => {
    if (!options.apiToken) return false;
    const a = Buffer.from(token),
      b = Buffer.from(options.apiToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authenticate = async (
    request: Pick<FastifyRequest, 'headers' | 'cookies'>,
    scope: KeyScope | null = 'read',
  ): Promise<Principal> => {
    const header = request.headers.authorization;
    const token = header?.match(/^Bearer +([^\s]+)$/i)?.[1];
    // An explicitly supplied credential must never select a different paying cookie session.
    if (header !== undefined && !token) throw unauthorized();
    let principal: Principal | null = null;
    if (token && bootstrap(token))
      principal = {
        workspaceId: options.workspaceId ?? 'local',
        scopes: [...keyScopes],
        bootstrap: true,
      };
    else if (token) {
      principal = (await options.engine?.accounts?.authenticate(token)) ?? null;
      if (!principal) principal = (await options.engine?.mcpOAuth?.authenticate(token)) ?? null;
      if (!principal && oauth && !token.startsWith('og_mcp_')) {
        try {
          const identity = await oauth.verify(token);
          principal = await store().identity(
            identity.issuer,
            identity.subject,
            identity.scopes,
            false,
          );
          principal.keyKind = 'oauth';
          principal.externalOAuth = true;
          principal.authorityExpiresAt = identity.expiresAt;
        } catch {
          throw unauthorized();
        }
      }
    } else if (request.cookies?.og_session)
      principal =
        (await options.engine?.accounts?.session(request.cookies.og_session, options.apiToken)) ??
        null;
    if (!principal) {
      if (!options.apiToken && !options.engine?.accounts)
        throw Object.assign(
          new Error('Configure database and authentication before enabling private operations.'),
          { statusCode: 503, code: 'authentication_not_configured' },
        );
      throw unauthorized();
    }
    assertBrowserRecoveryScope(principal, request.headers);
    if (scope && !principal.scopes.includes(scope))
      throw Object.assign(new Error(`This key requires the ${scope} scope.`), {
        statusCode: 403,
        code: 'insufficient_scope',
      });
    return principal;
  };
  app.addHook('onRequest', async (request) => {
    const publicOAuthProtocol = ['/oauth/token', '/oauth/register', '/oauth/revoke'].includes(
      request.url.split('?')[0]!,
    );
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      !(
        request.method === 'POST' &&
        (publicOAuthProtocol || request.url.split('?')[0] === '/webhooks/stripe')
      ) &&
      request.headers.origin &&
      request.headers.origin !== publicUrl.origin
    )
      throw Object.assign(new Error('Cross-origin mutation is not allowed.'), {
        statusCode: 403,
        code: 'origin_denied',
      });
  });
  app.get('/v1/session', async (request) => {
    try {
      const p = await authenticate(request, null);
      return {
        authenticated: true,
        workspaceId: p.workspaceId,
        recoveryScope: sessionRecoveryScope(p),
        membershipId: p.membershipId,
        scopes: p.scopes,
        identity: p.identity,
        role: p.role,
        canSwitchWorkspace: p.keyKind === 'browser',
        isOperator: p.bootstrap === true,
        oidcEnabled,
      };
    } catch {
      return { authenticated: false, oidcEnabled };
    }
  });
  app.post('/v1/session', async (request, reply) => {
    const { token } = z
      .object({ token: z.string().min(1).max(512) })
      .strict()
      .parse(request.body);
    let principal = await authenticate(
      {
        headers: { authorization: `Bearer ${token}` },
        cookies: {},
      },
      null,
    );
    if (principal.keyKind === 'oauth' || (!principal.keyId && !principal.bootstrap))
      throw Object.assign(new Error('Use browser OIDC sign-in to create a browser session.'), {
        statusCode: 400,
      });
    const session = await store().createSession(principal, options.apiToken);
    const current = await store().session(session, options.apiToken);
    if (!current)
      throw Object.assign(
        new Error('Authorization changed before the session could be returned.'),
        {
          code: 'policy_denied',
          statusCode: 403,
        },
      );
    principal = current;
    reply.setCookie('og_session', session, cookieOptions).header('Cache-Control', 'no-store');
    return {
      authenticated: true,
      isOperator: principal.bootstrap === true,
      identity: principal.identity,
      role: principal.role,
      canSwitchWorkspace: principal.keyKind === 'browser',
      workspaceId: principal.workspaceId,
      recoveryScope: sessionRecoveryScope(principal),
      membershipId: principal.membershipId,
      scopes: principal.scopes,
      oidcEnabled,
    };
  });
  app.delete('/v1/session', async (request, reply) => {
    if (request.cookies.og_session)
      await options.engine?.accounts?.deleteSession(request.cookies.og_session);
    reply.clearCookie('og_session', { path: '/' });
    return { authenticated: false, oidcEnabled };
  });
  app.get('/v1/workspaces', async (request) => ({
    data: await store().listWorkspaces(await authenticate(request)),
  }));
  app.post('/v1/teams', async (request, reply) => {
    const principal = await authenticate(request, 'members:write');
    const input = teamCreateSchema.parse(request.body);
    reply.code(201);
    return store().createTeam(principal, input.name);
  });
  app.get('/v1/members', async (request) => ({
    data: await store().listMembers(await authenticate(request, 'members:write')),
  }));
  app.post('/v1/members', async (request, reply) => {
    const principal = await authenticate(request, 'members:write');
    const input = memberInviteSchema.parse(request.body);
    reply.code(201);
    return store().inviteMember(principal, input);
  });
  app.patch<{ Params: { id: string } }>('/v1/members/:id', async (request) => {
    const principal = await authenticate(request, 'members:write');
    const input = memberRoleSchema.parse(request.body);
    return store().changeMember(principal, z.uuid().parse(request.params.id), input.role);
  });
  app.delete<{ Params: { id: string } }>('/v1/members/:id', async (request) =>
    store().changeMember(
      await authenticate(request, 'members:write'),
      z.uuid().parse(request.params.id),
      null,
    ),
  );
  app.post<{ Params: { id: string } }>('/v1/workspaces/:id/accept-invite', async (request) =>
    store().acceptInvite(
      await authenticate(request),
      sessionWorkspaceSchema.shape.workspaceId.parse(request.params.id),
    ),
  );
  app.post('/v1/session/workspace', async (request) => {
    const principal = await authenticate(request);
    if (!request.cookies.og_session || request.headers.authorization)
      throw Object.assign(new Error('Select a workspace through your signed-in browser session.'), {
        statusCode: 403,
        code: 'browser_session_required',
      });
    const { workspaceId } = sessionWorkspaceSchema.parse(request.body);
    const selected = await store().switchSession(
      request.cookies.og_session,
      principal,
      workspaceId,
    );
    return {
      authenticated: true,
      workspaceId: selected.workspaceId,
      recoveryScope: sessionRecoveryScope(selected),
      membershipId: selected.membershipId,
      scopes: selected.scopes,
      identity: selected.identity,
      role: selected.role,
      canSwitchWorkspace: true,
      isOperator: false,
      oidcEnabled,
    };
  });
  app.get('/v1/keys', async (request) => ({
    data: await store().listKeys((await authenticate(request, 'keys:write')).workspaceId),
  }));
  app.post('/v1/keys', async (request, reply) => {
    const p = await authenticate(request, 'keys:write');
    // A restricted key cannot mint a child key that escapes its policy or scope.
    if (p.policy || p.maxCostMicros !== undefined || p.monthlyCapMicros !== undefined)
      throw Object.assign(
        new Error('Use an unrestricted workspace administration session to create keys.'),
        { statusCode: 403 },
      );
    const input = z
      .object({
        name: z.string().min(1).max(80),
        scopes: z.array(z.enum(keyScopes)).min(1).max(keyScopes.length),
        policyId: z.uuid().optional(),
        monthlyCapMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
        expiresAt: z.iso
          .datetime()
          .refine((v) => Date.parse(v) > Date.now(), 'Expiry must be in the future')
          .optional(),
      })
      .strict()
      .parse(request.body);
    if (input.scopes.some((s) => !p.scopes.includes(s)))
      throw Object.assign(new Error('Cannot grant scopes this key does not hold.'), {
        statusCode: 403,
      });
    reply.code(201).header('Cache-Control', 'no-store');
    return new AccountGovernanceStore(store().pool).createKey(p, input);
  });
  app.delete<{ Params: { id: string } }>('/v1/keys/:id', async (request) => ({
    revoked: await new AccountGovernanceStore(store().pool).revokeKey(
      await authenticate(request, 'keys:write'),
      z.uuid().parse(request.params.id),
    ),
  }));
  app.get('/v1/policies', async (request) => ({
    data: await store().listPolicies((await authenticate(request, 'read')).workspaceId),
  }));
  app.post('/v1/policies', async (request, reply) => {
    const p = await authenticate(request, 'policies:write');
    if (p.policy || p.maxCostMicros !== undefined || p.monthlyCapMicros !== undefined)
      throw Object.assign(new Error('Restricted keys cannot administer routing policies.'), {
        statusCode: 403,
      });
    const input = z
      .object({
        name: z.string().min(1).max(80),
        policy: governancePolicySchema,
        maxCostMicros: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict()
      .parse(request.body);
    reply.code(201);
    return new RoutingPolicyStore(store().pool, catalog, revalidateGovernanceAuthority).create(
      p,
      input,
    );
  });
  app.post('/v1/workspaces', async (request, reply) => {
    if (!(await authenticate(request, 'keys:write')).bootstrap)
      throw Object.assign(
        new Error('Only the installation operator can create funded workspaces.'),
        { statusCode: 403 },
      );
    const input = z
      .object({
        id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
        openingBalanceMicros: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .default(0),
      })
      .strict()
      .parse(request.body);
    if (!options.engine?.ensureWorkspace)
      throw Object.assign(new Error('Database unavailable.'), { statusCode: 503 });
    reply.code(201);
    return options.engine.ensureWorkspace(input.id, input.openingBalanceMicros);
  });
  app.post<{ Params: { id: string } }>('/v1/workspaces/:id/credits', async (request) => {
    if (!(await authenticate(request, 'keys:write')).bootstrap)
      throw Object.assign(
        new Error('Only the installation operator can credit managed balances.'),
        { statusCode: 403 },
      );
    const input = z
      .object({
        amountMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        reference: z.string().min(1).max(200),
      })
      .strict()
      .parse(request.body);
    if (!options.engine?.creditWorkspace)
      throw Object.assign(new Error('Database unavailable.'), { statusCode: 503 });
    return options.engine.creditWorkspace(request.params.id, input.amountMicros, input.reference);
  });
  app.get('/v1/connections', async (request) => ({
    data: await store().listConnections(
      (await authenticate(request, 'connections:write')).workspaceId,
    ),
  }));
  app.put<{ Params: { deploymentId: string } }>(
    '/v1/connections/:deploymentId',
    async (request) => {
      const p = await authenticate(request, 'connections:write');
      const deployment = catalog.deployments.find((d) => d.id === request.params.deploymentId);
      if (!deployment?.credentialEnv)
        throw Object.assign(new Error('Unknown or unsupported deployment.'), { statusCode: 404 });
      const input = z
        .object({
          apiKey: z.string().min(1).max(2000),
          workspaceId: z
            .string()
            .regex(/^[a-zA-Z0-9-]+$/)
            .optional(),
        })
        .strict()
        .parse(request.body);
      if (deployment.providerId === 'alibaba' && !input.workspaceId)
        throw Object.assign(new Error('Alibaba requires a regional workspace ID.'), {
          statusCode: 400,
        });
      await store().putConnection(p.workspaceId, deployment.id, input);
      return { deploymentId: deployment.id, configured: true };
    },
  );
  app.delete<{ Params: { deploymentId: string } }>(
    '/v1/connections/:deploymentId',
    async (request) => ({
      deleted: await store().deleteConnection(
        (await authenticate(request, 'connections:write')).workspaceId,
        request.params.deploymentId,
      ),
    }),
  );
  // Library handles issuer validation, code exchange, PKCE, nonce and ID-token verification.
  let oidcConfig: Promise<oidc.Configuration> | undefined;
  const config = () =>
    (oidcConfig ??= oidc.discovery(
      new URL(env.OIDC_ISSUER!),
      env.OIDC_CLIENT_ID!,
      env.OIDC_CLIENT_SECRET!,
    ));
  if (oidcEnabled) {
    const loginContext = {
      policy: options.humanTermsPolicy ?? currentHumanTermsPolicy,
      pendingAuthorization: async (id: string) =>
        options.engine?.mcpOAuth?.pendingAuthorization(id),
    };
    await registerHumanLogin(app, {
      ...loginContext,
      publicOrigin: publicUrl.origin,
      cookieOptions,
      authorize: async (intent, reply) => {
        const verifier = oidc.randomPKCECodeVerifier(),
          state = oidc.randomState(),
          nonce = oidc.randomNonce();
        reply.setCookie('og_oidc', oidcHumanTransaction(intent, { verifier, state, nonce }), {
          ...cookieOptions,
          maxAge: 600,
          signed: true,
        });
        return sendOidcHandoff(
          reply,
          oidc.buildAuthorizationUrl(await config(), {
            redirect_uri: new URL('/auth/callback', publicUrl).href,
            scope: 'openid profile email',
            code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
            code_challenge_method: 'S256',
            state,
            nonce,
          }),
        );
      },
    });
    app.get('/auth/callback', { errorHandler: humanLoginError }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      reply.clearCookie('og_mcp_consent', { path: '/' });
      reply.clearCookie('og_oidc', { path: '/' });
      reply.clearCookie('og_login_intent', { path: '/' });
      const transaction = await readHumanLoginTransaction(request, reply, loginContext);
      const tokens = await oidc.authorizationCodeGrant(
        await config(),
        new URL(request.url, publicUrl),
        {
          pkceCodeVerifier: transaction.verifier,
          expectedState: transaction.state,
          expectedNonce: transaction.nonce,
          idTokenExpected: true,
        },
      );
      const claims = tokens.claims();
      if (typeof claims?.sub !== 'string' || !claims.sub || typeof claims.iss !== 'string')
        throw unauthorized();
      await validateHumanLoginIntent(transaction.continueIntent, request, loginContext);
      const principal = await store().identity(claims.iss, claims.sub);
      // The library verified these signed email-scoped claims above. Never feed
      // request JSON or an arbitrary bearer token's omitted email into this hook.
      if (options.engine?.notificationEmail && principal.membershipId) {
        const verifiedEmail = notificationEmailIdentityFromVerifiedOidcClaims(claims);
        // identity() chooses the personal workspace. Bind the same freshly
        // verified identity only to its currently accepted own memberships, so
        // team email does not depend on guessing an address during switching.
        for (const membership of await store().listWorkspaces(principal)) {
          if (
            !membership.accepted_at ||
            typeof membership.id !== 'string' ||
            typeof membership.membership_id !== 'string'
          )
            continue;
          const recipientActor: Principal = {
            workspaceId: membership.id,
            membershipId: membership.membership_id,
            scopes: ['read'],
            identity: { issuer: claims.iss, subject: claims.sub },
            keyKind: 'browser',
          };
          try {
            if (verifiedEmail)
              await options.engine.notificationEmail.recordVerifiedRecipient(
                recipientActor,
                verifiedEmail,
              );
            else await options.engine.notificationEmail.clearVerifiedRecipient(recipientActor);
          } catch (error) {
            // An unrelated team membership can be removed after enumeration.
            // That member stays unavailable for email; it cannot block sign-in.
            if ((error as { code?: string }).code !== 'notification_member_required') throw error;
          }
        }
      }
      await validateHumanLoginIntent(transaction.continueIntent, request, loginContext);
      const policy = transaction.continueIntent.policy;
      if (policy.status === 'active')
        await new TermsReceiptStore(store().pool).recordVerifiedAcceptance({
          issuer: claims.iss,
          subject: claims.sub,
          policyVersion: policy.version,
          policyDigest: policy.digest,
        });
      const session = await store().createSession(principal);
      // Recheck after asynchronous account/receipt/session work, before any MCP return or cookie issuance.
      await validateHumanLoginIntent(transaction.continueIntent, request, loginContext);
      reply.setCookie('og_session', session, cookieOptions);
      const consentRequest = transaction.continueIntent.consentRequest;
      if (consentRequest)
        return reply.redirect(
          new URL(`/oauth/consent?request=${encodeURIComponent(consentRequest)}`, publicUrl).href,
        );
      return reply.redirect(new URL('/app#start', publicUrl).href);
    });
  }
  return {
    authenticate,
    authenticateBrowser: (request: Pick<FastifyRequest, 'cookies'>) =>
      authenticate({ headers: {}, cookies: request.cookies }, null),
    oauthEnabled: Boolean(options.engine?.mcpOAuth || oauth),
    oidcEnabled,
  };
}
