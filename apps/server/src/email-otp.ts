import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createResendHttpTransport, type ResendTransport } from './email-relay.js';

export interface EmailOtpDeliveryInput {
  deliveryId: string;
  to: string;
  subject: string;
  text: string;
}

export type EmailOtpTransport = (input: EmailOtpDeliveryInput) => Promise<{ statusCode: number }>;

export interface EmailOtpConfiguration {
  secret: string;
  issuer: string;
  fromAddress: string;
  send: EmailOtpTransport;
}

export interface EmailOtpChallenge {
  id: string;
  emailHash: string;
  salt: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  maxAttempts: number;
  usedAt: number | null;
}

export interface EmailOtpRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface EmailOtpVerifyResult {
  status: 'ok' | 'invalid' | 'locked' | 'missing_or_expired';
  attemptsRemaining?: number;
}

export interface EmailOtpStore {
  checkSendLimit(emailHash: string, ip: string, now?: number): EmailOtpRateLimitResult;
  checkVerifyLimit(ip: string, now?: number): EmailOtpRateLimitResult;
  createChallenge(input: {
    emailHash: string;
    code: string;
    secret: string;
    expiresAt: number;
    maxAttempts?: number;
    now?: number;
  }): { challengeId: string; expiresAt: number };
  revokeChallenge(challengeId: string): void;
  verifyAndConsume(input: {
    challengeId: string;
    emailHash: string;
    code: string;
    secret: string;
    now?: number;
  }): EmailOtpVerifyResult;
}

const MAX_CHALLENGES = 10_000;
const MAX_BUCKETS = 10_000;
const SEND_WINDOW_MS = 15 * 60_000;
const MAX_SENDS_PER_EMAIL = 3;
const MAX_SENDS_PER_IP = 10;
const VERIFY_WINDOW_MS = 15 * 60_000;
const MAX_VERIFIES_PER_IP = 15;
const DEFAULT_MAX_ATTEMPTS = 5;
export const EMAIL_OTP_TTL_MS = 10 * 60_000;

export const emailOtpUnavailableError = () =>
  Object.assign(new Error('Email code sign-in is not configured on this installation.'), {
    statusCode: 503,
    code: 'email_otp_unavailable',
  });

export const emailOtpRateLimitedError = (retryAfterSeconds: number) =>
  Object.assign(new Error('Too many sign-in attempts. Wait a few minutes and try again.'), {
    statusCode: 429,
    code: 'email_otp_rate_limited',
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
  });

export function normalizeOtpEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (
    trimmed.length < 3 ||
    trimmed.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(trimmed) ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(trimmed)
  )
    return null;
  const [local, domain] = trimmed.split('@');
  if (
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !domain?.includes('.') ||
    domain.includes('..')
  )
    return null;
  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
  )
    return null;
  return trimmed.toLowerCase();
}

function validFromHeader(value: string): boolean {
  if (value.length === 0 || value.length > 320 || /[\u0000-\u001f\u007f\r\n]/.test(value))
    return false;
  const bracket = value.match(/^([^<>]{1,120})<([^<>]+)>$/);
  if (bracket) return normalizeOtpEmail(bracket[2]!.trim()) !== null;
  return normalizeOtpEmail(value.trim()) !== null;
}

export function hashOtpEmail(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail).digest('hex');
}

export function emailOtpSubject(normalizedEmail: string): string {
  return `email:${hashOtpEmail(normalizedEmail)}`;
}

export function maskEmailAddress(normalizedEmail: string): string {
  const [local, domain] = normalizedEmail.split('@');
  if (!local || !domain) return '***';
  const visible = local.length <= 2 ? local[0]! : local.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function digestOtpCode(
  secret: string,
  challengeId: string,
  salt: string,
  emailHash: string,
  code: string,
): string {
  return createHmac('sha256', secret)
    .update(`opengen-email-otp-v1:${challengeId}:${salt}:${emailHash}:${code}`)
    .digest('hex');
}

export class InMemoryEmailOtpStore implements EmailOtpStore {
  private readonly challenges = new Map<string, EmailOtpChallenge>();
  private readonly sendByEmail = new Map<string, number[]>();
  private readonly sendByIp = new Map<string, number[]>();
  private readonly verifyByIp = new Map<string, number[]>();
  private readonly maxSendsPerEmail: number;
  private readonly maxSendsPerIp: number;
  private readonly maxVerifiesPerIp: number;
  private readonly sendWindowMs: number;
  private readonly verifyWindowMs: number;

  constructor(
    options: {
      maxSendsPerEmail?: number;
      maxSendsPerIp?: number;
      maxVerifiesPerIp?: number;
      sendWindowMs?: number;
      verifyWindowMs?: number;
    } = {},
  ) {
    this.maxSendsPerEmail = options.maxSendsPerEmail ?? MAX_SENDS_PER_EMAIL;
    this.maxSendsPerIp = options.maxSendsPerIp ?? MAX_SENDS_PER_IP;
    this.maxVerifiesPerIp = options.maxVerifiesPerIp ?? MAX_VERIFIES_PER_IP;
    this.sendWindowMs = options.sendWindowMs ?? SEND_WINDOW_MS;
    this.verifyWindowMs = options.verifyWindowMs ?? VERIFY_WINDOW_MS;
  }

  private pruneChallenges(now: number): void {
    for (const [id, entry] of this.challenges) {
      if (entry.expiresAt <= now) this.challenges.delete(id);
    }
    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (!oldest) break;
      this.challenges.delete(oldest);
    }
  }

  private pruneBuckets(map: Map<string, number[]>, windowMs: number, now: number): void {
    const cutoff = now - windowMs;
    for (const [key, timestamps] of map) {
      const recent = timestamps.filter((ts) => ts > cutoff);
      if (recent.length === 0) map.delete(key);
      else map.set(key, recent);
    }
    while (map.size >= MAX_BUCKETS) {
      const oldest = map.keys().next().value;
      if (!oldest) break;
      map.delete(oldest);
    }
  }

  private consumeBucket(
    map: Map<string, number[]>,
    key: string,
    limit: number,
    windowMs: number,
    now: number,
  ): EmailOtpRateLimitResult {
    const cutoff = now - windowMs;
    const recent = (map.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= limit) {
      const oldestInWindow = recent[0]!;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInWindow + windowMs - now) / 1000));
      map.set(key, recent);
      return { allowed: false, retryAfterSeconds };
    }
    if (map.size >= MAX_BUCKETS) this.pruneBuckets(map, windowMs, now);
    recent.push(now);
    map.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  checkSendLimit(emailHash: string, ip: string, now = Date.now()): EmailOtpRateLimitResult {
    const ipKey = createHash('sha256')
      .update(ip || 'unknown')
      .digest('hex');
    const cutoff = now - this.sendWindowMs;
    const ipRecent = (this.sendByIp.get(ipKey) ?? []).filter((ts) => ts > cutoff);
    if (ipRecent.length >= this.maxSendsPerIp) {
      this.sendByIp.set(ipKey, ipRecent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((ipRecent[0]! + this.sendWindowMs - now) / 1000)),
      };
    }
    const emailRecent = (this.sendByEmail.get(emailHash) ?? []).filter((ts) => ts > cutoff);
    if (emailRecent.length >= this.maxSendsPerEmail) {
      this.sendByEmail.set(emailHash, emailRecent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((emailRecent[0]! + this.sendWindowMs - now) / 1000),
        ),
      };
    }
    if (this.sendByIp.size >= MAX_BUCKETS) this.pruneBuckets(this.sendByIp, this.sendWindowMs, now);
    if (this.sendByEmail.size >= MAX_BUCKETS)
      this.pruneBuckets(this.sendByEmail, this.sendWindowMs, now);
    ipRecent.push(now);
    emailRecent.push(now);
    this.sendByIp.set(ipKey, ipRecent);
    this.sendByEmail.set(emailHash, emailRecent);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  checkVerifyLimit(ip: string, now = Date.now()): EmailOtpRateLimitResult {
    const ipKey = createHash('sha256')
      .update(ip || 'unknown')
      .digest('hex');
    return this.consumeBucket(
      this.verifyByIp,
      ipKey,
      this.maxVerifiesPerIp,
      this.verifyWindowMs,
      now,
    );
  }

  createChallenge(input: {
    emailHash: string;
    code: string;
    secret: string;
    expiresAt: number;
    maxAttempts?: number;
    now?: number;
  }): { challengeId: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    this.pruneChallenges(now);
    const challengeId = randomBytes(24).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const codeHash = digestOtpCode(input.secret, challengeId, salt, input.emailHash, input.code);
    this.challenges.set(challengeId, {
      id: challengeId,
      emailHash: input.emailHash,
      salt,
      codeHash,
      expiresAt: input.expiresAt,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      usedAt: null,
    });
    return { challengeId, expiresAt: input.expiresAt };
  }

  revokeChallenge(challengeId: string): void {
    this.challenges.delete(challengeId);
  }

  verifyAndConsume(input: {
    challengeId: string;
    emailHash: string;
    code: string;
    secret: string;
    now?: number;
  }): EmailOtpVerifyResult {
    const now = input.now ?? Date.now();
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.expiresAt <= now || challenge.usedAt !== null) {
      if (challenge && challenge.expiresAt <= now) this.challenges.delete(input.challengeId);
      return { status: 'missing_or_expired' };
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      this.challenges.delete(input.challengeId);
      return { status: 'locked' };
    }
    const candidateHash = digestOtpCode(
      input.secret,
      challenge.id,
      challenge.salt,
      input.emailHash,
      input.code,
    );
    const expected = Buffer.from(challenge.codeHash, 'hex');
    const presented = Buffer.from(candidateHash, 'hex');
    const sameEmail =
      challenge.emailHash.length === input.emailHash.length &&
      timingSafeEqual(
        Buffer.from(challenge.emailHash, 'utf8'),
        Buffer.from(input.emailHash, 'utf8'),
      );
    const sameCode = expected.length === presented.length && timingSafeEqual(expected, presented);

    if (sameEmail && sameCode) {
      challenge.usedAt = now;
      challenge.codeHash = '';
      this.challenges.delete(input.challengeId);
      return { status: 'ok' };
    }
    challenge.attempts += 1;
    if (challenge.attempts >= challenge.maxAttempts) {
      this.challenges.delete(input.challengeId);
      return { status: 'locked' };
    }
    return { status: 'invalid', attemptsRemaining: challenge.maxAttempts - challenge.attempts };
  }
}

function createRelayHttpTransport(options: {
  endpoint: string;
  authToken?: string;
  timeoutMs?: number;
}): EmailOtpTransport {
  const timeoutMs = options.timeoutMs ?? 8_000;
  return async (input) => {
    const response = await fetch(options.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.deliveryId,
        ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
      },
      body: JSON.stringify({
        deliveryId: input.deliveryId,
        to: input.to,
        eventType: 'auth.email_otp',
        subject: input.subject,
        text: input.text,
      }),
    });
    await response.arrayBuffer().catch(() => undefined);
    return { statusCode: response.status };
  };
}

/**
 * Env-gated Email OTP configuration.
 * Reuses existing Resend HTTP transport (RESEND_API_KEY + RESEND_FROM_EMAIL/OPENGEN_EMAIL_OTP_FROM)
 * or an explicit HTTPS relay endpoint (OPENGEN_EMAIL_OTP_RELAY_URL), or an injected transport in tests.
 * Returns null when unconfigured or explicitly disabled (OPENGEN_EMAIL_OTP_ENABLED=0|false).
 */
export function readEmailOtpConfiguration(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    publicUrl: URL;
    transport?: EmailOtpTransport;
  },
): EmailOtpConfiguration | null {
  const flag = env.OPENGEN_EMAIL_OTP_ENABLED?.trim().toLowerCase();
  if (flag === '0' || flag === 'false') return null;
  const secret = env.MR_SESSION_SECRET ?? '';
  if (!secret) return null;

  const issuer = new URL('/auth/email-otp', options.publicUrl).href;

  if (options.transport) {
    if (secret.length < 32)
      throw new Error('MR_SESSION_SECRET must contain at least 32 characters for Email OTP.');
    return {
      secret,
      issuer,
      fromAddress: (
        env.OPENGEN_EMAIL_OTP_FROM ??
        env.RESEND_FROM_EMAIL ??
        'OpenGen <auth@opengen.dev>'
      ).trim(),
      send: options.transport,
    };
  }

  const resendApiKey = env.RESEND_API_KEY?.trim() ?? '';
  const fromAddress = (env.OPENGEN_EMAIL_OTP_FROM ?? env.RESEND_FROM_EMAIL ?? '').trim();
  const relayUrl = env.OPENGEN_EMAIL_OTP_RELAY_URL?.trim() ?? '';

  if (resendApiKey && fromAddress) {
    if (secret.length < 32)
      throw new Error('MR_SESSION_SECRET must contain at least 32 characters for Email OTP.');
    if (!validFromHeader(fromAddress))
      throw new Error('RESEND_FROM_EMAIL / OPENGEN_EMAIL_OTP_FROM must be a valid email address.');
    const endpoint = env.RESEND_API_ENDPOINT?.trim() || 'https://api.resend.com/emails';
    const parsedEndpoint = new URL(endpoint);
    if (parsedEndpoint.protocol !== 'https:' || parsedEndpoint.username || parsedEndpoint.password)
      throw new Error('RESEND_API_ENDPOINT must be a canonical HTTPS URL.');
    const resend: ResendTransport = createResendHttpTransport({
      apiKey: resendApiKey,
      endpoint: parsedEndpoint.href,
    });
    return {
      secret,
      issuer,
      fromAddress,
      send: async (input) => {
        const result = await resend({
          deliveryId: input.deliveryId,
          from: fromAddress,
          to: input.to,
          subject: input.subject,
          text: input.text,
        });
        return { statusCode: result.statusCode };
      },
    };
  }

  if (relayUrl) {
    if (secret.length < 32)
      throw new Error('MR_SESSION_SECRET must contain at least 32 characters for Email OTP.');
    const parsedRelay = new URL(relayUrl);
    if (parsedRelay.protocol !== 'https:' || parsedRelay.username || parsedRelay.password)
      throw new Error('OPENGEN_EMAIL_OTP_RELAY_URL must be a canonical HTTPS URL.');
    return {
      secret,
      issuer,
      fromAddress: fromAddress || 'OpenGen <auth@opengen.dev>',
      send: createRelayHttpTransport({
        endpoint: parsedRelay.href,
        authToken: env.OPENGEN_EMAIL_OTP_RELAY_AUTH_TOKEN?.trim() || undefined,
      }),
    };
  }

  return null;
}

export async function deliverEmailOtpCode(
  config: EmailOtpConfiguration,
  params: { to: string; code: string; publicOrigin: string },
): Promise<void> {
  const deliveryId = randomUUID();
  const response = await config.send({
    deliveryId,
    to: params.to,
    subject: 'Your OpenGen sign-in code',
    text: `Your OpenGen sign-in code is: ${params.code}\n\nThis code expires in 10 minutes and can only be used once.\n\nIf you did not request to sign in to ${params.publicOrigin}, you can safely ignore this email.`,
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Object.assign(new Error('Email code delivery failed.'), {
      statusCode: 503,
      code: 'sign_in_unavailable',
    });
  }
}
