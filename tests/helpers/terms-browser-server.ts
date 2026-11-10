import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  currentHumanTermsPolicy,
  registerHumanLogin,
  sendOidcHandoff,
} from '../../apps/server/src/terms-login.js';

/**
 * Disposable browser fixture: real login notice/Continue handlers, no AccountStore,
 * database, identity provider or receipt writer. It cannot exercise active assent.
 * The browser test intercepts the synthetic authorization origin; no IdP is called.
 * Run with Node 22: node --import tsx tests/helpers/terms-browser-server.ts
 * Point Next's MEDIA_ROUTER_API_URL at http://127.0.0.1:4313.
 */
export async function createTermsBrowserServer(
  publicOrigin = process.env.TEST_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4323',
) {
  const parsed = new URL(publicOrigin);
  if (
    parsed.origin !== publicOrigin ||
    parsed.protocol !== 'http:' ||
    parsed.hostname !== '127.0.0.1'
  )
    throw new Error('The Terms browser fixture requires an explicit HTTP 127.0.0.1 origin.');
  const policy = currentHumanTermsPolicy();
  if (policy.status !== 'draft' || policy.effectiveAt !== null)
    throw new Error('The Terms browser fixture only permits the current inactive draft.');

  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'terms-browser-fixture-only'.repeat(2) });
  await registerHumanLogin(app, {
    publicOrigin,
    cookieOptions: { path: '/', httpOnly: true, secure: false, sameSite: 'lax' },
    policy: currentHumanTermsPolicy,
    pendingAuthorization: async () => null,
    authorize: async (intent, reply) => {
      if (intent.policy.status !== 'draft' || intent.policy.effectiveAt !== null)
        throw new Error('The Terms browser fixture refuses active-policy continuation.');
      return sendOidcHandoff(
        reply,
        new URL('https://identity.fixture.invalid/authorize?state=synthetic-fixture'),
      );
    },
  });
  app.get('/health', async () => ({ fixture: true, policyStatus: 'draft' }));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = await createTermsBrowserServer();
  await app.listen({ host: '127.0.0.1', port: 4313 });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, async () => {
      await app.close();
      process.exit(0);
    });
  process.stdout.write('Draft Terms browser fixture listening on http://127.0.0.1:4313\n');
}
