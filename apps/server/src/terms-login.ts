import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  termsPolicy,
  legalPolicyMarkdown,
  legalDraftNotice,
} from '@media-router/contracts/legal-policies';

export const HUMAN_TERMS_NOTICE_VERSION = 'human-terms-continue-v1' as const;
const policySchema = z
  .object({
    version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(['draft', 'active']),
    effectiveAt: z.iso.datetime().nullable(),
  })
  .strict();
export type HumanTermsPolicy = z.infer<typeof policySchema>;
const frozenDraft = Object.freeze({
  version: 'hosted-terms-v4-draft-2026-11-09',
  digest: '17e9c824b1338651ae9e8570f7b6ec265b0b0d3a805d90b049aa584c70987ad5',
  status: 'draft' as const,
  effectiveAt: null,
});
/** No environment switch adopts this draft. Publication/effective-date activation is separate. */
export function currentHumanTermsPolicy(): HumanTermsPolicy {
  if (
    createHash('sha256').update(legalPolicyMarkdown(termsPolicy)).digest('hex') !==
    frozenDraft.digest
  )
    throw new Error('The human Terms copy changed without a reviewed policy snapshot.');
  return frozenDraft;
}
const intentSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expires: z.number().int().positive(),
    policy: policySchema,
    consentRequest: z
      .string()
      .regex(/^og_req_[A-Za-z0-9_-]{43}$/)
      .nullable(),
  })
  .strict();
export type HumanLoginIntent = z.infer<typeof intentSchema>;
const actionSchema = z
  .object({
    purpose: z.literal(HUMAN_TERMS_NOTICE_VERSION),
    intentId: intentSchema.shape.id,
    expires: intentSchema.shape.expires,
  })
  .strict();
const transactionSchema = z
  .object({
    verifier: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    expires: intentSchema.shape.expires,
    continueIntent: intentSchema,
  })
  .strict();
const invalid = () =>
  Object.assign(new Error('This sign-in request is invalid or expired. Start sign-in again.'), {
    statusCode: 401,
    code: 'login_intent_invalid',
  });
/** Redact malformed form, provider and receipt internals at this public identity boundary. */
export function humanLoginError(error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  const cause = error as { code?: string; statusCode?: number };
  const status =
    cause.code === 'login_intent_invalid' || cause.code === 'unauthorized'
      ? 401
      : cause.statusCode === 403
        ? 403
        : [400, 413, 415].includes(cause.statusCode ?? 0)
          ? cause.statusCode!
          : 503;
  const code =
    status === 401
      ? 'login_intent_invalid'
      : status === 403
        ? 'origin_denied'
        : status < 500
          ? 'invalid_request'
          : 'sign_in_unavailable';
  if (status === 401) {
    // A stale MCP cookie must not trap a signed-out user in repeated failed entry.
    // Existing authenticated sessions and accepted-job recovery are untouched.
    for (const name of ['og_login_intent', 'og_oidc', 'og_mcp_consent'])
      reply.clearCookie(name, { path: '/' });
  }
  return reply
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .code(status)
    .send({
      error: {
        code,
        message:
          status === 403
            ? 'Sign-in continuation requires the exact public origin.'
            : status < 500
              ? 'This sign-in request is invalid or expired. Start sign-in again.'
              : 'Sign-in could not be completed. Please start again.',
      },
    });
}
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signedValue<T>(
  reply: FastifyReply,
  cookie: string | undefined,
  schema: z.ZodType<T>,
  limit = 4096,
): T {
  if (!cookie || cookie.length > limit) throw invalid();
  const signed = reply.unsignCookie(cookie);
  if (!signed.valid || !signed.value || !/^[A-Za-z0-9_-]+$/.test(signed.value)) throw invalid();
  try {
    return schema.parse(JSON.parse(Buffer.from(signed.value, 'base64url').toString('utf8')));
  } catch {
    throw invalid();
  }
}
function selectedPolicy(readPolicy: () => HumanTermsPolicy): HumanTermsPolicy {
  const policy = policySchema.parse(readPolicy());
  if (
    policy.status === 'draft'
      ? policy.effectiveAt !== null
      : !policy.effectiveAt || Date.parse(policy.effectiveAt) > Date.now()
  )
    throw Object.assign(new Error('The human Terms policy is not ready for adoption.'), {
      statusCode: 503,
      code: 'terms_inactive',
    });
  return policy;
}
type Context = {
  policy: () => HumanTermsPolicy;
  pendingAuthorization: (id: string) => Promise<unknown>;
};
export async function validateHumanLoginIntent(
  intent: HumanLoginIntent,
  request: FastifyRequest,
  context: Context,
) {
  const policy = selectedPolicy(context.policy);
  if (
    intent.expires <= Date.now() ||
    intent.expires > Date.now() + 600_000 ||
    JSON.stringify(policy) !== JSON.stringify(intent.policy) ||
    (request.cookies.og_mcp_consent ?? null) !== intent.consentRequest
  )
    throw invalid();
  if (intent.consentRequest && !(await context.pendingAuthorization(intent.consentRequest)))
    throw invalid();
  return intent;
}
export async function readHumanLoginTransaction(
  request: FastifyRequest,
  reply: FastifyReply,
  context: Context,
) {
  const transaction = signedValue(reply, request.cookies.og_oidc, transactionSchema);
  if (transaction.expires !== transaction.continueIntent.expires) throw invalid();
  await validateHumanLoginIntent(transaction.continueIntent, request, context);
  return transaction;
}
export function oidcHumanTransaction(
  intent: HumanLoginIntent,
  value: { verifier: string; state: string; nonce: string },
) {
  return encode(
    transactionSchema.parse({ ...value, expires: intent.expires, continueIntent: intent }),
  );
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const css =
  'body{margin:0;background:#071c16;color:#f7f6ec;font:18px/1.6 ui-sans-serif,sans-serif}main{max-width:620px;margin:8vh auto;padding:28px}h1{line-height:1.1;font-size:42px;letter-spacing:-.035em}a{color:#c7e5cc;text-underline-offset:4px}aside{border:1px solid #476354;padding:18px;border-radius:10px}button{background:#e81859;color:white;border:0;border-radius:8px;font:inherit;font-weight:600;padding:13px 22px;cursor:pointer}button:focus-visible,a:focus-visible{outline:3px solid #c7e5cc;outline-offset:4px}small{display:block;overflow-wrap:anywhere;color:#b1c6bb}form{margin:26px 0}';
const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;
export function renderHumanLoginNotice(policy: HumanTermsPolicy, actionToken: string): string {
  const status =
    policy.status === 'draft'
      ? `<aside role="note"><strong>${escapeHtml(legalDraftNotice)}</strong><p>Continuing signs you in. It does not accept these drafts.</p><p>The proposed eligibility requirements include being at least 18, having legal capacity and having authority for any organization you represent.</p></aside>`
      : `<p>By continuing, you agree to the <a href="/terms">OpenGen Terms shown here</a> and confirm you meet the eligibility requirements. You must be at least 18, have legal capacity and have authority for any organization you represent.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Continue to OpenGen</title><style>${css}</style></head><body><main><a href="/">OpenGen</a><h1>A clear start.</h1>${status}<p><a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Notice</a></p><p>Read our Privacy Notice for how information is handled.</p><small>Terms version: ${escapeHtml(policy.version)}${policy.effectiveAt ? ` · Effective: ${escapeHtml(policy.effectiveAt)}` : ' · Not effective'}</small><details><summary>Policy fingerprint</summary><small>SHA-256: ${policy.digest}</small></details><form method="post" action="/auth/login"><input type="hidden" name="action" value="continue"><input type="hidden" name="actionToken" value="${escapeHtml(actionToken)}"><button type="submit">Continue to sign-in</button></form><p>This signs in your account. Agent permissions, workspace spending, funding approval and any customer DPA remain separate decisions.</p><a href="/start">Back to account setup</a></main></body></html>`;
}
/** A form-action 'self' policy can block an IdP redirect chain. Finish the POST
 * with a script-free page, then perform a normal navigation to the verified endpoint. */
export function sendOidcHandoff(reply: FastifyReply, target: URL) {
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    target.hash ||
    target.href.length > 8192
  )
    throw invalid();
  const href = escapeHtml(target.href);
  return reply
    .type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('Content-Security-Policy', csp)
    .header('X-Content-Type-Options', 'nosniff')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0; url=${href}"><title>Opening sign-in | OpenGen</title><style>${css}</style></head><body><main><h1>Opening sign-in…</h1><p>If you are not redirected, <a id="oidc-handoff" href="${href}" rel="noreferrer">continue to the identity provider</a>.</p><p><a href="/start">Return to account setup</a></p></main></body></html>`,
    );
}

export async function registerHumanLogin(
  app: FastifyInstance,
  options: Context & {
    publicOrigin: string;
    cookieOptions: { path: string; httpOnly: boolean; secure: boolean; sameSite: 'lax' };
    authorize: (intent: HumanLoginIntent, reply: FastifyReply) => Promise<unknown>;
  },
) {
  // Encapsulation prevents this intentionally raw parser from changing OAuth token/revoke forms.
  await app.register(async (login) => {
    login.setErrorHandler(humanLoginError);
    login.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'buffer', bodyLimit: 2048 },
      (_request, body, done) => done(null, body),
    );
    login.addHook('onRequest', async (_request, reply) => {
      // no-referrer would serialize a navigation form's Origin as null. Keep
      // same-origin POST verifiable while withholding cross-site referrers.
      reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .header('Referrer-Policy', 'same-origin')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', csp);
    });
    login.get('/auth/login', async (request, reply) => {
      if (Object.keys(request.query as object).length) throw invalid();
      const consentRequest = request.cookies.og_mcp_consent ?? null;
      const parsedIntent = intentSchema.safeParse({
        id: randomBytes(32).toString('base64url'),
        expires: Date.now() + 600_000,
        policy: selectedPolicy(options.policy),
        consentRequest,
      });
      if (!parsedIntent.success) throw invalid();
      const intent = parsedIntent.data;
      await validateHumanLoginIntent(intent, request, options);
      const actionToken = reply.signCookie(
        encode({
          purpose: HUMAN_TERMS_NOTICE_VERSION,
          intentId: intent.id,
          expires: intent.expires,
        }),
      );
      reply.clearCookie('og_oidc', { path: '/' });
      reply.setCookie('og_login_intent', encode(intent), {
        ...options.cookieOptions,
        maxAge: 600,
        signed: true,
      });
      return reply
        .type('text/html; charset=utf-8')
        .send(renderHumanLoginNotice(intent.policy, actionToken));
    });
    login.post(
      '/auth/login',
      {
        bodyLimit: 2048,
        onRequest: async (request) => {
          if (request.headers.origin !== options.publicOrigin)
            throw Object.assign(
              new Error('Sign-in continuation requires the exact public origin.'),
              { statusCode: 403, code: 'origin_denied' },
            );
        },
      },
      async (request, reply) => {
        if (
          Object.keys(request.query as object).length ||
          !/^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
            request.headers['content-type'] ?? '',
          ) ||
          !Buffer.isBuffer(request.body)
        )
          throw Object.assign(new Error('Use a bounded UTF-8 sign-in form.'), { statusCode: 415 });
        let form: URLSearchParams;
        try {
          form = new URLSearchParams(
            new TextDecoder('utf-8', { fatal: true }).decode(request.body),
          );
        } catch {
          throw invalid();
        }
        if (
          [...form].length !== 2 ||
          form.getAll('action').length !== 1 ||
          form.getAll('actionToken').length !== 1 ||
          form.get('action') !== 'continue'
        )
          throw invalid();
        const intent = signedValue(reply, request.cookies.og_login_intent, intentSchema);
        const action = signedValue(reply, form.get('actionToken') ?? undefined, actionSchema, 512);
        if (action.intentId !== intent.id || action.expires !== intent.expires) throw invalid();
        await validateHumanLoginIntent(intent, request, options);
        reply.clearCookie('og_login_intent', { path: '/' });
        return options.authorize(intent, reply);
      },
    );
  });
}
