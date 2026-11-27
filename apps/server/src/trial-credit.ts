import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  creditWorkspaceInTransaction,
  revalidateGovernanceAuthority,
  type KeyScope,
  type Principal,
} from '@media-router/engine';
import { requireBillingBrowserRecovery } from './billing.js';
import { verifyHumanIdentityTermsReceiptInTransaction } from './billing-terms-admission.js';
import { currentHumanTermsPolicy, type HumanTermsPolicy } from './terms-login.js';

/** Hard upper bound ($5.00) on operator-enabled starter promotional trial credit. */
export const MAX_TRIAL_CREDIT_MICROS = 5_000_000;

/**
 * Reserved noncash promotional ledger reference prefix.
 * Deliberately distinct from `stripe-topup:` and `stripe-recharge:` so 028/030 staff-refund
 * guards reject cash refunds against starter trial credits and 031 classifies them as noncash.
 */
export const TRIAL_CREDIT_REFERENCE_PREFIX = 'trial-credit:v1:';

export interface TrialCreditConfig {
  readonly enabled: boolean;
  readonly amountMicros: number;
}

export type TrialCreditIneligibleReason =
  | 'disabled'
  | 'already-claimed'
  | 'personal-workspace-required'
  | 'verified-human-required'
  | 'billing-hold'
  | 'terms-required'
  | 'terms-inactive';

export interface TrialCreditStatus {
  enabled: boolean;
  amountMicros: number;
  claimed: boolean;
  eligible: boolean;
  claimedAt?: string;
  claimedAmountMicros?: number;
  reason?: TrialCreditIneligibleReason;
}

export interface TrialCreditClaimResult {
  workspaceId: string;
  claimed: true;
  alreadyClaimed: boolean;
  amountMicros: number;
  ledgerId: string;
  reference: string;
  claimedAt: string;
  promotional: true;
  refundable: false;
}

export type TrialCreditTx = typeof creditWorkspaceInTransaction;

const error = (code: string, message: string, statusCode = 403) =>
  Object.assign(new Error(message), { code, statusCode });

const isDenied = (cause: unknown) => (cause as { statusCode?: number } | null)?.statusCode === 403;

/**
 * Strict, fail-closed parser for `OPENGEN_TRIAL_CREDIT_MICROS`.
 * Defaults to disabled (`0`) so self-hosted installations and existing tests stay untouched.
 */
export function readTrialCreditConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TrialCreditConfig {
  const raw = env.OPENGEN_TRIAL_CREDIT_MICROS;
  if (raw === undefined || raw.trim() === '') {
    return Object.freeze({ enabled: false, amountMicros: 0 });
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid OPENGEN_TRIAL_CREDIT_MICROS: expected an integer between 0 and ${MAX_TRIAL_CREDIT_MICROS} ($5.00 max).`,
    );
  }
  const amountMicros = Number(trimmed);
  if (
    !Number.isSafeInteger(amountMicros) ||
    amountMicros < 0 ||
    amountMicros > MAX_TRIAL_CREDIT_MICROS
  ) {
    throw new Error(
      `Invalid OPENGEN_TRIAL_CREDIT_MICROS: expected an integer between 0 and ${MAX_TRIAL_CREDIT_MICROS} ($5.00 max).`,
    );
  }
  return Object.freeze({ enabled: amountMicros > 0, amountMicros });
}

/** Deterministic, PII-free ledger reference bound uniquely to one verified human identity. */
export function trialCreditLedgerReference(identity: { issuer: string; subject: string }): string {
  if (
    typeof identity.issuer !== 'string' ||
    !identity.issuer ||
    /[\u0000-\u001f\u007f]/.test(identity.issuer) ||
    typeof identity.subject !== 'string' ||
    !identity.subject ||
    /[\u0000-\u001f\u007f]/.test(identity.subject)
  ) {
    throw error('verified_human_required', 'A verified human identity is required.');
  }
  const digest = createHash('sha256')
    .update(`${identity.issuer}\0${identity.subject}`)
    .digest('hex');
  return `${TRIAL_CREDIT_REFERENCE_PREFIX}${digest}`;
}

type VerifiedHumanBrowserPrincipal = Principal & {
  keyKind: 'browser';
  keyId: string;
  keySecretVersion: number;
  membershipId: string;
  role: 'admin';
  identity: { issuer: string; subject: string };
};

function assertHumanBrowserShape(actor: Principal): asserts actor is VerifiedHumanBrowserPrincipal {
  if (
    actor.bootstrap ||
    actor.externalOAuth ||
    actor.keyKind !== 'browser' ||
    !actor.keyId ||
    actor.keySecretVersion === undefined ||
    !actor.membershipId ||
    actor.role !== 'admin' ||
    !actor.identity?.issuer ||
    !actor.identity.subject ||
    actor.grantId ||
    actor.clientId ||
    actor.oauthResource ||
    actor.policy ||
    actor.maxCostMicros !== undefined ||
    actor.monthlyCapMicros !== undefined
  ) {
    throw error(
      'verified_human_required',
      'Sign in in your browser with a verified personal account to claim starter credit.',
    );
  }
}

async function revalidateHumanBrowserPrincipal(
  client: PoolClient,
  actor: Principal,
): Promise<VerifiedHumanBrowserPrincipal> {
  assertHumanBrowserShape(actor);
  const current = await revalidateGovernanceAuthority(client, actor, null);
  assertHumanBrowserShape(current);
  if (
    current.membershipId !== actor.membershipId ||
    current.keyId !== actor.keyId ||
    current.keySecretVersion !== actor.keySecretVersion ||
    current.identity.issuer !== actor.identity.issuer ||
    current.identity.subject !== actor.identity.subject
  ) {
    throw error('verified_human_required', 'Browser account authority changed; sign in again.');
  }
  return current;
}

export interface StarterTrialCreditStoreOptions {
  amountMicros: number;
  creditInTransaction?: TrialCreditTx;
  humanTermsPolicy?: () => HumanTermsPolicy;
}

/**
 * Operator-gated, strictly once-per-verified-human-identity starter promotional credit store.
 *
 * Uses `mr_identities` (`PRIMARY KEY (issuer, subject)` → 1 immutable personal `user-*` workspace)
 * together with `mr_ledger_credit_reference` (`UNIQUE (workspace_id, reference)`) under canonical
 * workspace-first row locking so concurrent claims are atomic and idempotent without a new table.
 */
export class StarterTrialCreditStore {
  readonly amountMicros: number;
  private readonly creditInTransaction: TrialCreditTx;
  private readonly humanTermsPolicy: () => HumanTermsPolicy;

  constructor(
    readonly pool: Pool,
    options: StarterTrialCreditStoreOptions,
  ) {
    if (
      typeof options.amountMicros !== 'number' ||
      !Number.isSafeInteger(options.amountMicros) ||
      options.amountMicros < 0 ||
      options.amountMicros > MAX_TRIAL_CREDIT_MICROS
    ) {
      throw new Error(
        `Starter trial credit amount must be an integer between 0 and ${MAX_TRIAL_CREDIT_MICROS} micros.`,
      );
    }
    this.amountMicros = options.amountMicros;
    this.creditInTransaction = options.creditInTransaction ?? creditWorkspaceInTransaction;
    this.humanTermsPolicy = options.humanTermsPolicy ?? currentHumanTermsPolicy;
  }

  get enabled(): boolean {
    return this.amountMicros > 0;
  }

  /**
   * Read-only availability check. Returns `null` when starter trial credit is disabled so callers
   * omit the field from `/v1/billing/access` and UI never advertises unavailable promotional credit.
   */
  async getStatus(principal: Principal): Promise<TrialCreditStatus | null> {
    if (!this.enabled) return null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let current: VerifiedHumanBrowserPrincipal;
      try {
        current = await revalidateHumanBrowserPrincipal(client, principal);
      } catch (cause) {
        if (isDenied(cause)) {
          await client.query('COMMIT');
          return {
            enabled: true,
            amountMicros: this.amountMicros,
            claimed: false,
            eligible: false,
            reason: 'verified-human-required',
          };
        }
        throw cause;
      }

      const identityRow = (
        await client.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM mr_identities WHERE issuer=$1 AND subject=$2',
          [current.identity.issuer, current.identity.subject],
        )
      ).rows[0];
      if (!identityRow || !identityRow.workspace_id.startsWith('user-')) {
        await client.query('COMMIT');
        return {
          enabled: true,
          amountMicros: this.amountMicros,
          claimed: false,
          eligible: false,
          reason: 'personal-workspace-required',
        };
      }

      const reference = trialCreditLedgerReference(current.identity);
      const existing = (
        await client.query<{ amount_micros: string; created_at: Date }>(
          'SELECT amount_micros, created_at FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
          [identityRow.workspace_id, reference],
        )
      ).rows[0];
      if (existing) {
        await client.query('COMMIT');
        return {
          enabled: true,
          amountMicros: this.amountMicros,
          claimed: true,
          eligible: false,
          claimedAt: existing.created_at.toISOString(),
          claimedAmountMicros: Number(existing.amount_micros),
          reason: 'already-claimed',
        };
      }

      if (current.workspaceId !== identityRow.workspace_id) {
        await client.query('COMMIT');
        return {
          enabled: true,
          amountMicros: this.amountMicros,
          claimed: false,
          eligible: false,
          reason: 'personal-workspace-required',
        };
      }

      const hold = await client.query(
        'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
        [current.workspaceId],
      );
      if (hold.rowCount) {
        await client.query('COMMIT');
        return {
          enabled: true,
          amountMicros: this.amountMicros,
          claimed: false,
          eligible: false,
          reason: 'billing-hold',
        };
      }

      try {
        await verifyHumanIdentityTermsReceiptInTransaction(
          client,
          current.identity,
          this.humanTermsPolicy,
        );
      } catch (cause) {
        if (isDenied(cause)) {
          const code = (cause as { code?: string }).code;
          await client.query('COMMIT');
          return {
            enabled: true,
            amountMicros: this.amountMicros,
            claimed: false,
            eligible: false,
            reason: code === 'current_human_terms_inactive' ? 'terms-inactive' : 'terms-required',
          };
        }
        throw cause;
      }

      await client.query('COMMIT');
      return {
        enabled: true,
        amountMicros: this.amountMicros,
        claimed: false,
        eligible: true,
      };
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
  }

  /**
   * Atomically claims the bounded starter promotional credit once per verified human identity into
   * their own immutable personal `user-*` workspace. Idempotent on replay.
   */
  async claim(principal: Principal): Promise<TrialCreditClaimResult> {
    if (!this.enabled) {
      throw error(
        'trial_credit_disabled',
        'Starter trial credit is not enabled on this installation.',
      );
    }
    assertHumanBrowserShape(principal);
    if (!principal.workspaceId.startsWith('user-')) {
      throw error(
        'personal_workspace_required',
        'Starter trial credit can only be claimed in your personal workspace.',
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Canonical workspace-first lock matching all ledger/payment/billing writers.
      const workspaceRow = await client.query(
        'SELECT id FROM mr_workspaces WHERE id=$1 FOR UPDATE',
        [principal.workspaceId],
      );
      if (!workspaceRow.rowCount) {
        throw error('workspace_not_found', 'Workspace not found.', 404);
      }

      const current = await revalidateHumanBrowserPrincipal(client, principal);

      const identityRow = (
        await client.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM mr_identities WHERE issuer=$1 AND subject=$2 FOR SHARE',
          [current.identity.issuer, current.identity.subject],
        )
      ).rows[0];
      if (
        !identityRow ||
        !identityRow.workspace_id.startsWith('user-') ||
        identityRow.workspace_id !== current.workspaceId
      ) {
        throw error(
          'personal_workspace_required',
          'Starter trial credit can only be claimed in your personal workspace.',
        );
      }

      const hold = await client.query(
        'SELECT 1 FROM mr_billing_holds WHERE workspace_id=$1 AND resolved_at IS NULL LIMIT 1',
        [current.workspaceId],
      );
      if (hold.rowCount) {
        throw error('billing_hold', 'Billing holds pause starter trial credit claims.');
      }

      const policy = await verifyHumanIdentityTermsReceiptInTransaction(
        client,
        current.identity,
        this.humanTermsPolicy,
      );

      const reference = trialCreditLedgerReference(current.identity);
      const existing = (
        await client.query<{ id: string; amount_micros: string; created_at: Date }>(
          'SELECT id, amount_micros, created_at FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
          [current.workspaceId, reference],
        )
      ).rows[0];
      if (existing) {
        await client.query('COMMIT');
        return {
          workspaceId: current.workspaceId,
          claimed: true,
          alreadyClaimed: true,
          amountMicros: Number(existing.amount_micros),
          ledgerId: existing.id,
          reference,
          claimedAt: existing.created_at.toISOString(),
          promotional: true,
          refundable: false,
        };
      }

      // Non-refundable promotional ledger entry; omit raw identity PII from customer-visible details.
      await this.creditInTransaction(client, current.workspaceId, this.amountMicros, reference, {
        source: 'starter-trial-credit',
        promotional: true,
        refundable: false,
        termsPolicyVersion: policy.version,
      });

      const inserted = (
        await client.query<{ id: string; amount_micros: string; created_at: Date }>(
          'SELECT id, amount_micros, created_at FROM mr_ledger WHERE workspace_id=$1 AND reference=$2',
          [current.workspaceId, reference],
        )
      ).rows[0];
      if (!inserted) {
        throw error('trial_credit_failed', 'Starter trial credit could not be recorded.', 500);
      }
      await client.query('COMMIT');
      return {
        workspaceId: current.workspaceId,
        claimed: true,
        alreadyClaimed: false,
        amountMicros: Number(inserted.amount_micros),
        ledgerId: inserted.id,
        reference,
        claimedAt: inserted.created_at.toISOString(),
        promotional: true,
        refundable: false,
      };
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    } finally {
      client.release();
    }
  }
}

type Authenticate = (
  request: Pick<FastifyRequest, 'headers' | 'cookies'>,
  scope: KeyScope | null,
) => Promise<Principal>;

const emptyBodySchema = z.object({}).strict();

/** Browser-session-only HTTP routes for opt-in starter trial credit status and claim. */
export async function registerTrialCreditRoutes(
  app: FastifyInstance,
  options: {
    store?: StarterTrialCreditStore;
    authenticate: Authenticate;
    publicUrl: string;
  },
): Promise<void> {
  const origin = new URL(options.publicUrl).origin;
  let windowStart = 0;
  let windowCount = 0;
  const checkClaimRateLimit = () => {
    const now = Date.now();
    if (now - windowStart >= 60_000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > 60) {
      throw Object.assign(new Error('Too many starter credit requests; wait a moment.'), {
        code: 'rate_limited',
        statusCode: 429,
        retryAfterSeconds: Math.max(1, Math.ceil((60_000 - (now - windowStart)) / 1000)),
      });
    }
  };

  app.get('/v1/billing/trial-credit', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    if (request.headers.authorization || !request.cookies?.og_session) {
      throw error(
        'browser_session_required',
        'Sign in in your browser to view starter trial credit status.',
        401,
      );
    }
    const principal = await options.authenticate(request, null);
    const recoveryScope = requireBillingBrowserRecovery(principal, request.headers);
    if (!options.store) {
      throw error('database_not_configured', 'Database is not configured.', 503);
    }
    const status = await options.store.getStatus(principal);
    return {
      workspaceId: principal.workspaceId,
      recoveryScope,
      ...(status ?? {
        enabled: false,
        amountMicros: 0,
        claimed: false,
        eligible: false,
        reason: 'disabled' as const,
      }),
    };
  });

  app.post('/v1/billing/trial-credit', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    checkClaimRateLimit();
    if (request.headers.authorization || !request.cookies?.og_session) {
      throw error(
        'browser_session_required',
        'Sign in in your browser to claim starter trial credit.',
        401,
      );
    }
    if (request.headers.origin !== origin) {
      throw error('origin_denied', 'Billing mutations require the configured website origin.');
    }
    const principal = await options.authenticate(request, null);
    requireBillingBrowserRecovery(principal, request.headers);
    emptyBodySchema.parse(request.body ?? {});
    if (!options.store) {
      throw error('database_not_configured', 'Database is not configured.', 503);
    }
    const result = await options.store.claim(principal);
    return reply.code(result.alreadyClaimed ? 200 : 201).send(result);
  });
}
