import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import {
  termsPolicy,
  legalPolicyMarkdown,
  legalDraftNotice,
} from '@media-router/contracts/legal-policies';

export const HUMAN_TERMS_NOTICE_VERSION = 'human-terms-continue-v1' as const;
const EMAIL_OTP_VERIFY_PURPOSE = 'human-email-otp-verify-v1' as const;
export const MAX_RETURN_TO_LENGTH = 512;

const BLOCKED_RETURN_TO_PREFIX = /^\/(?:api|auth|oauth|webhooks|v1|mcp|\.well-known)(?:\/|$)/i;

/**
 * Validates a same-origin relative return path (e.g. /playground?..., /billing, /app#...).
 * Strictly rejects protocol-relative //, external URLs, backslashes, whitespace, path traversal,
 * control characters, oversized strings, and internal API/auth/OAuth routes.
 */
export function validateSafeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH)
    return null;
  if (/[\u0000-\u001f\u007f\s\\]/.test(value)) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  const rawPathname = value.split(/[?#]/)[0]!;
  if (/%(?:2f|5c|00|2e)/i.test(rawPathname)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, 'https://opengen.invalid');
  } catch {
    return null;
  }
  if (
    parsed.origin !== 'https://opengen.invalid' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== rawPathname
  )
    return null;
  if (BLOCKED_RETURN_TO_PREFIX.test(parsed.pathname)) return null;
  const normalized = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (normalized.length > MAX_RETURN_TO_LENGTH) return null;
  return normalized;
}

const safeReturnToSchema = z
  .string()
  .max(MAX_RETURN_TO_LENGTH)
  .refine((value) => validateSafeReturnTo(value) === value, 'Unsafe returnTo path.');

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
  version: 'hosted-terms-draft-2026-11-16',
  digest: '06b1b9849544e2158b43e1fa79daa29e082a0bd0e41505ef38425f06fb142c6c',
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
    returnTo: safeReturnToSchema.nullable().optional(),
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

const emailOtpVerifyActionSchema = z
  .object({
    purpose: z.literal(EMAIL_OTP_VERIFY_PURPOSE),
    challengeId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    intentId: intentSchema.shape.id,
    expires: intentSchema.shape.expires,
  })
  .strict();

const transactionSchema = z
  .object({
    provider: z.enum(['oidc', 'github']).optional(),
    verifier: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    state: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    expires: intentSchema.shape.expires,
    continueIntent: intentSchema,
  })
  .strict();

const emailOtpCookieSchema = z
  .object({
    challengeId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    email: z.string().min(3).max(254),
    expires: intentSchema.shape.expires,
    continueIntent: intentSchema,
  })
  .strict();
export type EmailOtpChallengeCookie = z.infer<typeof emailOtpCookieSchema>;

export interface LoginNoticeProviders {
  oidc?: boolean;
  oidcLabel?: string;
  github?: boolean;
  emailOtp?: boolean;
}

export interface HumanLoginNoticeOptions {
  providers?: LoginNoticeProviders;
  returnTo?: string | null;
  errorMessage?: string;
}

const invalid = () =>
  Object.assign(new Error('This sign-in request is invalid or expired. Start sign-in again.'), {
    statusCode: 401,
    code: 'login_intent_invalid',
  });

const providerUnavailable = (code: 'email_otp_unavailable' | 'provider_unavailable') =>
  Object.assign(new Error('This sign-in method is not configured on this installation.'), {
    statusCode: 503,
    code,
  });

/** Redact malformed form, provider and receipt internals at this public identity boundary. */
export function humanLoginError(error: unknown, _request: FastifyRequest, reply: FastifyReply) {
  const cause = error as { code?: string; statusCode?: number; retryAfterSeconds?: number };
  const status =
    cause.code === 'login_intent_invalid' || cause.code === 'unauthorized'
      ? 401
      : cause.statusCode === 403
        ? 403
        : cause.statusCode === 429
          ? 429
          : [400, 413, 415].includes(cause.statusCode ?? 0)
            ? cause.statusCode!
            : 503;
  const code =
    status === 401
      ? 'login_intent_invalid'
      : status === 403
        ? 'origin_denied'
        : status === 429
          ? cause.code === 'email_otp_rate_limited'
            ? 'email_otp_rate_limited'
            : 'rate_limited'
          : status < 500
            ? 'invalid_request'
            : cause.code === 'email_otp_unavailable' || cause.code === 'provider_unavailable'
              ? cause.code
              : 'sign_in_unavailable';
  if (status === 401) {
    // A stale MCP or login cookie must not trap a signed-out user in repeated failed entry.
    // Existing authenticated sessions and accepted-job recovery are untouched.
    for (const name of ['og_login_intent', 'og_oidc', 'og_email_otp', 'og_mcp_consent'])
      reply.clearCookie(name, { path: '/' });
  }
  if (
    status === 429 &&
    typeof cause.retryAfterSeconds === 'number' &&
    Number.isSafeInteger(cause.retryAfterSeconds) &&
    cause.retryAfterSeconds > 0
  ) {
    reply.header('Retry-After', String(cause.retryAfterSeconds));
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
            : status === 429
              ? 'Too many sign-in attempts. Wait a few minutes and try again.'
              : status < 500
                ? 'This sign-in request is invalid or expired. Start sign-in again.'
                : code === 'email_otp_unavailable' || code === 'provider_unavailable'
                  ? 'This sign-in method is not configured on this installation.'
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
    (request.cookies.og_mcp_consent ?? null) !== intent.consentRequest ||
    (intent.returnTo != null && validateSafeReturnTo(intent.returnTo) !== intent.returnTo)
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
  value: { verifier: string; state: string; nonce: string; provider?: 'oidc' | 'github' },
) {
  return encode(
    transactionSchema.parse({
      ...(value.provider ? { provider: value.provider } : {}),
      verifier: value.verifier,
      state: value.state,
      nonce: value.nonce,
      expires: intent.expires,
      continueIntent: intent,
    }),
  );
}

export function encodeEmailOtpCookie(value: EmailOtpChallengeCookie): string {
  return encode(emailOtpCookieSchema.parse(value));
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const effectiveDateFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatHumanEffectiveDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return effectiveDateFormatter.format(new Date(ms));
}

const wordmarkSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="142" height="34" viewBox="0 0 142 34" aria-hidden="true"><path fill="#f7f6ec" d="M2 1H16V3H18V5H4V17H2V19H0V3H2ZM30 33H16V31H14V29H28V17H30V15H32V31H30Z"/><g transform="translate(10 11)"><path fill="#d81757" d="M2 0H12V10H10V12H0V2H2Z"/></g><g fill="#f7f6ec"><path d="M47.95 25.0H47.7V24.05H45.8V23.1H44.85V21.2H43.9V19.3H42.95V12.65H43.9V10.75H44.85V8.85H45.8V7.9H47.7V6.95H53.4V7.9H55.3V8.85H56.25V10.75H57.2V12.65H58.15V19.3H57.2V21.2H56.25V23.1H55.3V24.05H53.4V25.0ZM47.95 23.1H53.4V22.15H54.35V21.2H55.3V19.3H56.25V12.65H55.3V10.75H54.35V9.8H53.4V8.85H47.7V9.8H46.75V10.75H45.8V12.65H44.85V19.3H45.8V21.2H46.75V22.15H47.7V23.1Z"/><path d="M63.25 13.6V12.65H64.2V11.7H68.95V12.65H69.9V13.6H70.85V14.55H71.8V22.15H70.85V23.1H69.9V24.05H68.95V25.0H64.2V24.05H63.25V23.1H68.0V22.15H68.95V21.2H69.9V15.5H68.95V14.55H68.0V13.6ZM60.65 28.8H60.4V11.7H62.3V13.6H63.25V15.5H62.3V21.2H63.25V23.1H62.3V28.8Z"/><path d="M76.2 25.0H75.95V24.05H75.0V23.1H74.05V21.2H73.1V15.5H74.05V13.6H75.0V12.65H75.95V11.7H81.65V12.65H82.6V13.6H83.55V15.5H84.5V19.3H75.0V21.2H75.95V22.15H76.9V23.1H81.65V22.15H82.6V21.2H84.5V23.1H83.55V24.05H81.65V25.0ZM75.25 17.4H82.6V15.5H81.65V14.55H80.7V13.6H76.9V14.55H75.95V15.5H75.0V17.4Z"/><path d="M95.55 25.0H95.3V14.55H94.35V13.6H89.6V12.65H90.55V11.7H95.3V12.65H96.25V13.6H97.2V25.0ZM87.0 25.0H86.75V11.7H88.65V13.6H89.6V14.55H88.65V25.0Z"/><path d="M104.45 25.0H104.2V24.05H102.3V23.1H101.35V21.2H100.4V19.3H99.45V12.65H100.4V10.75H101.35V8.85H102.3V7.9H104.2V6.95H110.85V7.9H112.75V8.85H113.7V10.75H114.65V12.65H112.75V10.75H111.8V9.8H110.85V8.85H104.2V9.8H103.25V10.75H102.3V12.65H101.35V19.3H102.3V21.2H103.25V22.15H104.2V23.1H111.8V24.05H110.85V25.0ZM113.0 25.0H112.75V23.1H111.8V22.15H112.75V18.35H107.05V16.45H114.65V25.0Z"/><path d="M119.05 25.0H118.8V24.05H117.85V23.1H116.9V21.2H115.95V15.5H116.9V13.6H117.85V12.65H118.8V11.7H124.5V12.65H125.45V13.6H126.4V15.5H127.35V19.3H117.85V21.2H118.8V22.15H119.75V23.1H124.5V22.15H125.45V21.2H127.35V23.1H126.4V24.05H124.5V25.0ZM118.1 17.4H125.45V15.5H124.5V14.55H123.55V13.6H119.75V14.55H118.8V15.5H117.85V17.4Z"/><path d="M138.4 25.0H138.15V14.55H137.2V13.6H132.45V12.65H133.4V11.7H138.15V12.65H139.1V13.6H140.05V25.0ZM129.85 25.0H129.6V11.7H131.5V13.6H132.45V14.55H131.5V25.0Z"/></g></svg>';

const css =
  '*{box-sizing:border-box}body{margin:0;background:#061c15;color:#faf8f2;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;min-height:100vh}main{max-width:540px;width:100%;margin:6vh auto;padding:16px}.card{background:#0c271e;border:1px solid rgba(246,243,236,.18);border-radius:12px;padding:28px;box-shadow:5px 5px 0 rgba(4,19,14,.55)}.brand{display:inline-flex;align-items:center;text-decoration:none;color:#faf8f2;margin-bottom:20px}.brand svg{display:block;height:30px;width:auto}h1{margin:0 0 14px;line-height:1.12;font-size:34px;letter-spacing:-.03em}p{margin:0 0 14px;color:#d6e0da}a{color:#8ee5ea;text-underline-offset:4px}aside{background:#082018;border:1px solid rgba(246,243,236,.2);padding:16px;border-radius:8px;margin:0 0 16px}aside p:last-child{margin-bottom:0}.alert{background:rgba(216,23,87,.16);border:1px solid rgba(216,23,87,.55);color:#ffd6e2;padding:12px 14px;border-radius:8px;margin:0 0 16px}.effective-date{font-size:14px;color:#b8c9bf;margin:0 0 10px}.return-hint{font-size:14px;color:#b8c9bf;margin:0 0 16px}.return-hint code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#faf8f2;background:#061c15;padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}.providers{display:flex;flex-direction:column;gap:12px;margin:22px 0}.providers form{margin:0}button{display:block;width:100%;background:#d81757;color:#ffffff;border:1px solid #d81757;border-radius:8px;font:inherit;font-weight:600;padding:13px 20px;cursor:pointer;box-shadow:3px 3px 0 rgba(4,19,14,.5)}button:hover{background:#c0144d;border-color:#c0144d}button.secondary{background:#123328;color:#faf8f2;border-color:rgba(246,243,236,.28)}button.secondary:hover{background:#184133;border-color:rgba(246,243,236,.45)}.divider{display:flex;align-items:center;gap:12px;color:#93aba0;font-size:13px;margin:4px 0}.divider::before,.divider::after{content:"";flex:1;height:1px;background:rgba(246,243,236,.16)}label{display:block;font-size:14px;font-weight:600;color:#faf8f2;margin:0 0 6px}input[type=email],input[type=text]{display:block;width:100%;margin:0 0 12px;padding:12px 14px;border-radius:8px;border:1px solid rgba(246,243,236,.28);background:#061c15;color:#faf8f2;font:inherit;font-size:16px}input.otp-code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:22px;letter-spacing:.28em;text-align:center}button:focus-visible,a:focus-visible,input:focus-visible,summary:focus-visible{outline:3px solid #f6f3ec;outline-offset:3px}small{display:block;overflow-wrap:anywhere;color:#b8c9bf;font-size:13px;line-height:1.5}details{margin:12px 0 0;border-top:1px solid rgba(246,243,236,.12);padding-top:12px}summary{cursor:pointer;color:#b8c9bf;font-size:13px;font-weight:500}details small{margin-top:6px;font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}.footnote{font-size:14px;color:#b8c9bf;margin:18px 0 14px}.back-row{margin:16px 0 0}.back-link{display:inline-block;font-size:14px}form{margin:22px 0}';

const csp = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(css).digest('base64')}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

export function renderHumanLoginNotice(
  policy: HumanTermsPolicy,
  actionToken: string,
  options: HumanLoginNoticeOptions = {},
): string {
  const providers: LoginNoticeProviders = options.providers ?? { oidc: true };
  const showOidc = providers.oidc !== false && Boolean(providers.oidc);
  const showGitHub = Boolean(providers.github);
  const showEmailOtp = Boolean(providers.emailOtp);
  const multipleProviders = [showOidc, showGitHub, showEmailOtp].filter(Boolean).length > 1;
  const escapedToken = escapeHtml(actionToken);
  const oidcButtonText = providers.oidcLabel
    ? `Continue with ${escapeHtml(providers.oidcLabel)}`
    : 'Continue to sign-in';

  const status =
    policy.status === 'draft'
      ? `<aside role="note"><strong>${escapeHtml(legalDraftNotice)}</strong><p>Continuing signs you in. It does not accept these drafts.</p><p>The proposed eligibility requirements include being at least 18, having legal capacity and having authority for any organization you represent.</p></aside>`
      : `<p>By continuing, you agree to the <a href="/terms">OpenGen Terms shown here</a> and confirm you meet the eligibility requirements. You must be at least 18, have legal capacity and have authority for any organization you represent.</p>`;

  const effectiveMarkup = policy.effectiveAt
    ? `<p class="effective-date">Effective ${escapeHtml(formatHumanEffectiveDate(policy.effectiveAt))}</p>`
    : '<small>Not effective</small>';

  const fingerprintDetails = policy.effectiveAt
    ? `<details><summary>Policy fingerprint</summary><small>Effective: ${escapeHtml(policy.effectiveAt)}</small><small>SHA-256: ${policy.digest}</small></details>`
    : `<details><summary>Policy fingerprint</summary><small>SHA-256: ${policy.digest}</small></details>`;

  const returnHint =
    options.returnTo && options.returnTo !== '/app#start'
      ? `<p class="return-hint">After signing in, you will return to <code>${escapeHtml(options.returnTo)}</code>.</p>`
      : '';

  const errorBanner = options.errorMessage
    ? `<p class="alert" role="alert">${escapeHtml(options.errorMessage)}</p>`
    : '';

  const forms: string[] = [];
  if (showOidc) {
    forms.push(
      `<form method="post" action="/auth/login"><input type="hidden" name="action" value="continue"><input type="hidden" name="actionToken" value="${escapedToken}"><button type="submit">${oidcButtonText}</button></form>`,
    );
  }
  if (showGitHub) {
    const githubClass = showOidc ? ' class="secondary"' : '';
    forms.push(
      `<form method="post" action="/auth/login"><input type="hidden" name="action" value="continue_github"><input type="hidden" name="actionToken" value="${escapedToken}"><button type="submit"${githubClass}>Continue with GitHub</button></form>`,
    );
  }
  if (showEmailOtp) {
    if (showOidc || showGitHub)
      forms.push('<div class="divider"><span>or sign in with email</span></div>');
    const otpButtonClass = showOidc || showGitHub ? ' class="secondary"' : '';
    forms.push(
      `<form method="post" action="/auth/login"><input type="hidden" name="action" value="email_otp_send"><input type="hidden" name="actionToken" value="${escapedToken}"><label for="email-otp-address">Email address</label><input id="email-otp-address" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" placeholder="you@example.com"><button type="submit"${otpButtonClass}>Email me a sign-in code</button></form>`,
    );
  }
  const providerMarkup = multipleProviders
    ? `<div class="providers">${forms.join('')}</div>`
    : forms.join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Continue to OpenGen</title><style>${css}</style></head><body><main><div class="card"><a class="brand" href="/" aria-label="OpenGen">${wordmarkSvg}</a><h1>A clear start.</h1>${status}<p><a href="/terms">Terms of Service</a> · <a href="/privacy">Privacy Notice</a></p><p>Read our Privacy Notice for how information is handled.</p>${effectiveMarkup}${returnHint}${errorBanner}${providerMarkup}<p class="footnote">This signs in your account. Agent permissions, workspace spending, funding approval and any customer DPA remain separate decisions.</p>${fingerprintDetails}<p class="back-row"><a class="back-link" href="/start">Back to account setup</a></p></div></main></body></html>`;
}

export function renderEmailOtpVerifyNotice(params: {
  maskedEmail: string;
  actionToken: string;
  returnTo?: string | null;
  errorMessage?: string;
}): string {
  const errorBanner = params.errorMessage
    ? `<p class="alert" role="alert">${escapeHtml(params.errorMessage)}</p>`
    : '';
  const startOverHref =
    params.returnTo && validateSafeReturnTo(params.returnTo)
      ? `/auth/login?returnTo=${encodeURIComponent(params.returnTo)}`
      : '/auth/login';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Enter sign-in code | OpenGen</title><style>${css}</style></head><body><main><div class="card"><a class="brand" href="/" aria-label="OpenGen">${wordmarkSvg}</a><h1>Check your email.</h1><p>We sent a 6-digit single-use sign-in code to <strong>${escapeHtml(params.maskedEmail)}</strong>. It expires in 10 minutes.</p>${errorBanner}<form method="post" action="/auth/login"><input type="hidden" name="action" value="email_otp_verify"><input type="hidden" name="actionToken" value="${escapeHtml(params.actionToken)}"><label for="email-otp-code">6-digit sign-in code</label><input id="email-otp-code" class="otp-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required placeholder="000000"><button type="submit">Verify and sign in</button></form><p class="back-row"><a class="back-link" href="${escapeHtml(startOverHref)}">Start sign-in over</a></p></div></main></body></html>`;
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
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0; url=${href}"><title>Opening sign-in | OpenGen</title><style>${css}</style></head><body><main><div class="card"><a class="brand" href="/" aria-label="OpenGen">${wordmarkSvg}</a><h1>Opening sign-in…</h1><p>If you are not redirected, <a id="oidc-handoff" href="${href}" rel="noreferrer">continue to the identity provider</a>.</p><p><a class="back-link" href="/start">Return to account setup</a></p></div></main></body></html>`,
    );
}

export async function registerHumanLogin(
  app: FastifyInstance,
  options: Context & {
    publicOrigin: string;
    cookieOptions: { path: string; httpOnly: boolean; secure: boolean; sameSite: 'lax' };
    providers?: LoginNoticeProviders;
    resolveClientIp?: (request: FastifyRequest) => string;
    authorize?: (intent: HumanLoginIntent, reply: FastifyReply) => Promise<unknown>;
    authorizeGitHub?: (intent: HumanLoginIntent, reply: FastifyReply) => Promise<unknown>;
    sendEmailOtp?: (params: {
      intent: HumanLoginIntent;
      email: string;
      request: FastifyRequest;
      reply: FastifyReply;
      makeActionToken: (intent: HumanLoginIntent) => string;
      makeVerifyActionToken: (challenge: EmailOtpChallengeCookie) => string;
    }) => Promise<unknown>;
    verifyEmailOtp?: (params: {
      challenge: EmailOtpChallengeCookie;
      code: string;
      request: FastifyRequest;
      reply: FastifyReply;
      makeVerifyActionToken: (challenge: EmailOtpChallengeCookie) => string;
    }) => Promise<unknown>;
  },
) {
  const providers: LoginNoticeProviders = options.providers ?? {
    oidc: Boolean(options.authorize),
    github: Boolean(options.authorizeGitHub),
    emailOtp: Boolean(options.sendEmailOtp && options.verifyEmailOtp),
  };

  // Encapsulation prevents this intentionally raw parser and rate limiter from changing sibling routes.
  await app.register(async (login) => {
    await login.register(rateLimit, {
      global: true,
      max: 120,
      timeWindow: '1 minute',
      keyGenerator: (request) => options.resolveClientIp?.(request) ?? request.ip,
      errorResponseBuilder: (_request, context) =>
        Object.assign(new Error('Too many sign-in attempts. Wait a few minutes and try again.'), {
          statusCode: 429,
          code: 'rate_limited',
          retryAfterSeconds: Math.max(1, Math.ceil(context.ttl / 1000)),
        }),
    });
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

    const signActionToken = (reply: FastifyReply, intent: HumanLoginIntent) =>
      reply.signCookie(
        encode({
          purpose: HUMAN_TERMS_NOTICE_VERSION,
          intentId: intent.id,
          expires: intent.expires,
        }),
      );

    const signVerifyActionToken = (reply: FastifyReply, challenge: EmailOtpChallengeCookie) =>
      reply.signCookie(
        encode({
          purpose: EMAIL_OTP_VERIFY_PURPOSE,
          challengeId: challenge.challengeId,
          intentId: challenge.continueIntent.id,
          expires: challenge.expires,
        }),
      );

    login.get('/auth/login', async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const queryKeys = Object.keys(query);
      if (queryKeys.some((key) => key !== 'returnTo')) throw invalid();
      let returnTo: string | null = null;
      if ('returnTo' in query) {
        if (typeof query.returnTo !== 'string') throw invalid();
        const validated = validateSafeReturnTo(query.returnTo);
        if (!validated) throw invalid();
        returnTo = validated;
      }
      const consentRequest = request.cookies.og_mcp_consent ?? null;
      const parsedIntent = intentSchema.safeParse({
        id: randomBytes(32).toString('base64url'),
        expires: Date.now() + 600_000,
        policy: selectedPolicy(options.policy),
        consentRequest,
        returnTo,
      });
      if (!parsedIntent.success) throw invalid();
      const intent = parsedIntent.data;
      await validateHumanLoginIntent(intent, request, options);
      const actionToken = signActionToken(reply, intent);
      reply.clearCookie('og_oidc', { path: '/' });
      reply.clearCookie('og_email_otp', { path: '/' });
      reply.setCookie('og_login_intent', encode(intent), {
        ...options.cookieOptions,
        maxAge: 600,
        signed: true,
      });
      return reply.type('text/html; charset=utf-8').send(
        renderHumanLoginNotice(intent.policy, actionToken, {
          providers,
          returnTo: consentRequest ? null : returnTo,
        }),
      );
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
        if (form.getAll('action').length !== 1 || form.getAll('actionToken').length !== 1)
          throw invalid();
        const actionValue = form.get('action')!;

        if (actionValue === 'continue') {
          if ([...form].length !== 2) throw invalid();
          const intent = signedValue(reply, request.cookies.og_login_intent, intentSchema);
          const action = signedValue(
            reply,
            form.get('actionToken') ?? undefined,
            actionSchema,
            512,
          );
          if (action.intentId !== intent.id || action.expires !== intent.expires) throw invalid();
          await validateHumanLoginIntent(intent, request, options);
          if (!options.authorize) throw providerUnavailable('provider_unavailable');
          reply.clearCookie('og_login_intent', { path: '/' });
          return options.authorize(intent, reply);
        }

        if (actionValue === 'continue_github') {
          if ([...form].length !== 2) throw invalid();
          const intent = signedValue(reply, request.cookies.og_login_intent, intentSchema);
          const action = signedValue(
            reply,
            form.get('actionToken') ?? undefined,
            actionSchema,
            512,
          );
          if (action.intentId !== intent.id || action.expires !== intent.expires) throw invalid();
          await validateHumanLoginIntent(intent, request, options);
          if (!options.authorizeGitHub) throw providerUnavailable('provider_unavailable');
          reply.clearCookie('og_login_intent', { path: '/' });
          return options.authorizeGitHub(intent, reply);
        }

        if (actionValue === 'email_otp_send') {
          if ([...form].length !== 3 || form.getAll('email').length !== 1) throw invalid();
          if (!options.sendEmailOtp) throw providerUnavailable('email_otp_unavailable');
          const intent = signedValue(reply, request.cookies.og_login_intent, intentSchema);
          const action = signedValue(
            reply,
            form.get('actionToken') ?? undefined,
            actionSchema,
            512,
          );
          if (action.intentId !== intent.id || action.expires !== intent.expires) throw invalid();
          await validateHumanLoginIntent(intent, request, options);
          return options.sendEmailOtp({
            intent,
            email: form.get('email')!,
            request,
            reply,
            makeActionToken: (current) => signActionToken(reply, current),
            makeVerifyActionToken: (challenge) => signVerifyActionToken(reply, challenge),
          });
        }

        if (actionValue === 'email_otp_verify') {
          if ([...form].length !== 3 || form.getAll('code').length !== 1) throw invalid();
          if (!options.verifyEmailOtp) throw providerUnavailable('email_otp_unavailable');
          const challenge = signedValue(reply, request.cookies.og_email_otp, emailOtpCookieSchema);
          const verifyAction = signedValue(
            reply,
            form.get('actionToken') ?? undefined,
            emailOtpVerifyActionSchema,
            512,
          );
          if (
            verifyAction.challengeId !== challenge.challengeId ||
            verifyAction.intentId !== challenge.continueIntent.id ||
            verifyAction.expires !== challenge.expires ||
            challenge.expires <= Date.now() ||
            challenge.expires > challenge.continueIntent.expires
          )
            throw invalid();
          await validateHumanLoginIntent(challenge.continueIntent, request, options);
          return options.verifyEmailOtp({
            challenge,
            code: form.get('code')!,
            request,
            reply,
            makeVerifyActionToken: (current) => signVerifyActionToken(reply, current),
          });
        }

        throw invalid();
      },
    );
  });
}
