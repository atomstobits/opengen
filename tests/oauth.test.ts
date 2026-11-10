import { describe, it, expect } from 'vitest';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createOAuthResource } from '../apps/server/src/oauth';
import { buildApp } from '../apps/server/src/app';

describe('OAuth resource binding', () => {
  const env = {
    OIDC_ISSUER: 'https://identity.example',
    OIDC_API_AUDIENCE: 'https://opengen.example/mcp',
    OIDC_JWKS_URI: 'https://identity.example/keys',
    NODE_ENV: 'test',
  } as NodeJS.ProcessEnv;
  it('verifies issuer/audience/expiry and requires explicit opt-in for administrative OAuth scopes', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const resource = createOAuthResource(
      env,
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture-key' }] }),
    )!;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = (audience: string, expiry: string | number = expiresAt) =>
      new SignJWT({ scope: 'read generate keys:write' })
        .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' })
        .setSubject('user-123')
        .setIssuer(env.OIDC_ISSUER!)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiry)
        .sign(privateKey);
    expect(await resource.verify(await token(env.OIDC_API_AUDIENCE!))).toEqual({
      issuer: env.OIDC_ISSUER,
      subject: 'user-123',
      scopes: ['read', 'generate'],
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    });
    await expect(resource.verify(await token('https://unrelated.example/mcp'))).rejects.toThrow();
    await expect(resource.verify(await token(env.OIDC_API_AUDIENCE!, '-1h'))).rejects.toThrow();
    await expect(resource.verify('invalid-token')).rejects.toThrow();
    const opted = createOAuthResource(
      { ...env, OIDC_ALLOWED_SCOPES: 'read generate members:write' },
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'fixture-key' }] }),
    )!;
    const administrative = await new SignJWT({ scope: 'read members:write keys:write' })
      .setProtectedHeader({ alg: 'ES256', kid: 'fixture-key' })
      .setSubject('user-123')
      .setIssuer(env.OIDC_ISSUER!)
      .setAudience(env.OIDC_API_AUDIENCE!)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    expect((await opted.verify(administrative)).scopes).toEqual(['read', 'members:write']);
  });
  it('advertises canonical resource metadata and challenges protected MCP transport before tool execution', async () => {
    const app = await buildApp({ env, publicUrl: 'https://opengen.example' });
    try {
      const metadata = await app.inject({ url: '/.well-known/oauth-protected-resource/mcp' });
      expect(metadata.json()).toMatchObject({
        resource: 'https://opengen.example/mcp',
        authorization_servers: ['https://opengen.example'],
      });
      const denied = await app.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['www-authenticate']).toContain(
        '/.well-known/oauth-protected-resource/mcp',
      );
    } finally {
      await app.close();
    }
  });
  it('disables OAuth without complete trusted configuration and rejects credential-bearing configuration', () => {
    expect(createOAuthResource({ NODE_ENV: 'test' })).toBeUndefined();
    expect(() =>
      createOAuthResource({ ...env, OIDC_JWKS_URI: 'https://secret@identity.example/keys' }),
    ).toThrow();
  });
});
