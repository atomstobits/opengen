import type { Pool } from 'pg';

export interface VerifiedTermsAcceptance {
  issuer: string;
  subject: string;
  policyVersion: string;
  policyDigest: string;
}

export interface TermsReceipt extends VerifiedTermsAcceptance {
  noticeVersion: 'human-terms-continue-v1';
  action: 'continue';
  method: 'oidc-verified';
  acceptedAt: Date;
}

export class TermsReceiptError extends Error {
  constructor(
    public readonly code:
      'terms_receipt_input_invalid' | 'terms_receipt_policy_conflict' | 'terms_receipt_unavailable',
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'TermsReceiptError';
  }
}

const invalid = () =>
  new TermsReceiptError(
    'terms_receipt_input_invalid',
    'A receipt requires a verified issuer/subject and the server-selected policy version/digest only.',
    400,
  );
const controls = /[\u0000-\u001f\u007f]/;
const inputKeys = new Set(['issuer', 'subject', 'policyVersion', 'policyDigest']);

function validate(raw: VerifiedTermsAcceptance): VerifiedTermsAcceptance {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Reflect.ownKeys(raw).length !== inputKeys.size ||
    Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !inputKeys.has(key))
  )
    throw invalid();
  // Do not execute accessors or accept hidden caller-supplied timestamp/action fields.
  for (const key of inputKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string')
      throw invalid();
  }
  const { issuer, subject, policyVersion, policyDigest } = raw;
  if (
    !issuer ||
    Buffer.byteLength(issuer) > 1024 ||
    /\s/.test(issuer) ||
    controls.test(issuer) ||
    !subject.trim() ||
    Buffer.byteLength(subject) > 512 ||
    controls.test(subject) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(policyVersion) ||
    !/^[a-f0-9]{64}$/.test(policyDigest)
  )
    throw invalid();
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw invalid();
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw invalid();
  // Identity strings stay exact: no issuer URL normalization, subject trimming or email linking.
  return { issuer, subject, policyVersion, policyDigest };
}

const columns = `issuer,subject,policy_version AS "policyVersion",policy_digest AS "policyDigest",
  notice_version AS "noticeVersion",action,method,accepted_at AS "acceptedAt"`;

/** Internal writer only. Call after verified OIDC and validated active-policy Continue intent,
 * before issuing the browser session. Identity creation/membership alone is not assent. */
export class TermsReceiptStore {
  constructor(private readonly pool: Pool) {}

  async recordVerifiedAcceptance(raw: VerifiedTermsAcceptance): Promise<TermsReceipt> {
    const input = validate(raw);
    const inserted = await this.pool.query<TermsReceipt>(
      `INSERT INTO mr_terms_receipts(issuer,subject,policy_version,policy_digest)
       VALUES($1,$2,$3,$4) ON CONFLICT(issuer,subject,policy_version) DO NOTHING
       RETURNING ${columns}`,
      [input.issuer, input.subject, input.policyVersion, input.policyDigest],
    );
    if (inserted.rows[0]) return inserted.rows[0];
    // A separate READ COMMITTED statement observes a concurrent insert's committed winner.
    // No UPDATE (including a no-op update) is used: retries retain the first DB timestamp.
    const existing = (
      await this.pool.query<TermsReceipt>(
        `SELECT ${columns} FROM mr_terms_receipts
         WHERE issuer=$1 AND subject=$2 AND policy_version=$3`,
        [input.issuer, input.subject, input.policyVersion],
      )
    ).rows[0];
    if (!existing)
      throw new TermsReceiptError(
        'terms_receipt_unavailable',
        'The immutable Terms receipt could not be confirmed.',
        503,
      );
    if (existing.policyDigest !== input.policyDigest)
      throw new TermsReceiptError(
        'terms_receipt_policy_conflict',
        'A different digest is already recorded for this identity and policy version.',
        409,
      );
    return existing;
  }
}
