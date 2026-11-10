import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { keyScopes, type KeyScope } from '@media-router/contracts';

/** Resource-server validation only. Authorization/client registration stays with the configured issuer. */
export function createOAuthResource(env: NodeJS.ProcessEnv, testKey?: JWTVerifyGetKey) {
  if (!env.OIDC_ISSUER || !env.OIDC_API_AUDIENCE || !env.OIDC_JWKS_URI) return undefined;
  const issuer = new URL(env.OIDC_ISSUER),
    jwks = new URL(env.OIDC_JWKS_URI),
    audience = new URL(env.OIDC_API_AUDIENCE);
  if (
    issuer.protocol !== 'https:' ||
    jwks.protocol !== 'https:' ||
    audience.protocol !== 'https:' ||
    issuer.username ||
    issuer.password ||
    jwks.username ||
    jwks.password
  )
    throw new Error(
      'OAuth issuer, JWKS and API audience must use HTTPS without embedded credentials.',
    );
  const allowed = (env.OIDC_ALLOWED_SCOPES ?? 'read generate').split(/\s+/).filter(Boolean);
  if (allowed.some((scope) => !keyScopes.includes(scope as KeyScope)))
    throw new Error('OIDC_ALLOWED_SCOPES contains an unknown OpenGen scope.');
  const key =
    testKey ?? createRemoteJWKSet(jwks, { timeoutDuration: 5000, cooldownDuration: 30000 });
  return {
    metadata: {
      resource: env.OIDC_API_AUDIENCE,
      authorization_servers: [env.OIDC_ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: allowed,
      resource_name: 'OpenGen',
    },
    async verify(token: string) {
      const { payload } = await jwtVerify(token, key, {
        issuer: env.OIDC_ISSUER,
        audience: env.OIDC_API_AUDIENCE,
        algorithms: ['RS256', 'ES256', 'EdDSA'],
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.scope !== 'string')
        throw new Error('Invalid access token.');
      // Administrative OAuth permissions require both issuer grant and explicit deployment opt-in.
      const scopes = payload.scope
        .split(' ')
        .filter(
          (scope): scope is KeyScope =>
            allowed.includes(scope) && keyScopes.includes(scope as KeyScope),
        );
      return {
        issuer: env.OIDC_ISSUER!,
        subject: payload.sub,
        scopes,
        expiresAt: new Date(payload.exp! * 1000).toISOString(),
      };
    },
  };
}
