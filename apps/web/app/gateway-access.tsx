'use client';

import { useEffect, useRef, useState } from 'react';
import { useLegalPresentation } from './legal/presentation';
import styles from './onboarding/onboarding.module.css';

const MAX_RETURN_TO_LENGTH = 512;
const BLOCKED_RETURN_TO_PREFIX = /^\/(?:api|auth|oauth|webhooks|v1|mcp|\.well-known)(?:\/|$)/i;

/**
 * Validates a same-origin relative return path for sign-in links.
 * Strictly rejects external URLs, protocol-relative paths, traversal, and internal API/auth routes.
 */
export function safeReturnToPath(candidate: string | null | undefined): string | null {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > MAX_RETURN_TO_LENGTH
  )
    return null;
  if (/[\u0000-\u001f\u007f\s\\]/.test(candidate)) return null;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  const rawPathname = candidate.split(/[?#]/)[0]!;
  if (/%(?:2f|5c|00|2e)/i.test(rawPathname)) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate, 'https://opengen.invalid');
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
  return normalized.length <= MAX_RETURN_TO_LENGTH ? normalized : null;
}

/**
 * Builds a sign-in href preserving a safe same-origin `returnTo` query parameter when appropriate.
 * Leaves non-default login URLs (e.g. `/oauth/login?request=...`) untouched, and avoids echoing
 * `/` or `/start` when auto-deriving from the current browser URL so sign-in lands on `/app#start`.
 */
export function buildLoginHref(options?: {
  loginUrl?: string;
  returnTo?: string | null;
  currentLocation?: string | null;
}): string {
  const base = options?.loginUrl ?? '/auth/login';
  if (base !== '/auth/login') return base;
  let candidate: string | null = null;
  if (options?.returnTo !== undefined) {
    candidate = safeReturnToPath(options.returnTo);
  } else {
    const raw =
      options?.currentLocation !== undefined
        ? options.currentLocation
        : typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}${window.location.hash}`
          : null;
    const safe = safeReturnToPath(raw);
    if (safe) {
      const pathname = safe.split(/[?#]/)[0]!;
      if (pathname !== '/' && pathname !== '/start') candidate = safe;
    }
  }
  return candidate ? `/auth/login?returnTo=${encodeURIComponent(candidate)}` : '/auth/login';
}

export type AuthProviders = {
  oidc: boolean;
  oidcLabel?: string;
  github: boolean;
  emailOtp: boolean;
};

export type BrowserSession = {
  /** Opaque server namespace binding the current identity, workspace and authority. */
  recoveryScope?: string;
  membershipId?: string;
  authenticated: boolean;
  unavailable?: boolean;
  /** Existing private UI is suspended until the cookie's authority has been checked again. */
  checkingAuthority?: boolean;
  workspaceId?: string;
  scopes?: string[];
  oidcEnabled?: boolean;
  authProviders?: AuthProviders;
  canSwitchWorkspace?: boolean;
  isOperator?: boolean;
  role?: 'admin' | 'member';
};

const sessionEvent = 'opengen:session-changed';
const sessionSignal = 'opengen:session-signal';
const sessionChannel = 'opengen-session';

/** Only a random wake-up signal crosses tabs; account data and credentials never enter storage. */
export function notifyBrowserSessionChanged(source?: string): void {
  window.dispatchEvent(new CustomEvent(sessionEvent, { detail: { source } }));
  try {
    localStorage.setItem(sessionSignal, crypto.randomUUID());
  } catch {
    /* Focus/visibility checks remain available when storage is disabled. */
  }
  try {
    const channel = new BroadcastChannel(sessionChannel);
    channel.postMessage({ type: 'changed', source });
    channel.close();
  } catch {
    /* The storage signal supports browsers without BroadcastChannel. */
  }
}

const sessionIdentity = (session: BrowserSession | null) =>
  session &&
  JSON.stringify([
    session.authenticated,
    session.workspaceId,
    session.recoveryScope,
    [...(session.scopes ?? [])].sort(),
    session.role,
    session.isOperator,
    session.canSwitchWorkspace,
    session.oidcEnabled,
    session.authProviders?.oidc ?? null,
    session.authProviders?.oidcLabel ?? null,
    session.authProviders?.github ?? null,
    session.authProviders?.emailOtp ?? null,
  ]);

/** Customer sign-in reuses configured identity providers and opaque HttpOnly sessions. */
export function GatewayAccess({
  onChange,
  onSession,
  loginUrl = '/auth/login',
  returnTo,
}: {
  onChange: (authenticated: boolean) => void;
  onSession?: (session: BrowserSession) => void;
  loginUrl?: string;
  returnTo?: string;
}) {
  const legal = useLegalPresentation();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [resolvedLoginUrl, setResolvedLoginUrl] = useState(() =>
    returnTo !== undefined ? buildLoginHref({ loginUrl, returnTo }) : loginUrl,
  );
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [checkingAuthority, setCheckingAuthority] = useState(false);
  const sessionVersion = useRef(0);
  const verifiedSession = useRef<BrowserSession | null>(null);
  const readController = useRef<AbortController | null>(null);
  const mutationActive = useRef(false);
  const queuedRefresh = useRef(false);
  const signalSource = useRef<string>('');
  const callbacks = useRef({ onChange, onSession });
  callbacks.current = { onChange, onSession };
  const refreshAuthority = useRef<(preserveError?: boolean) => void>(() => {});

  useEffect(() => {
    const syncHref = () => setResolvedLoginUrl(buildLoginHref({ loginUrl, returnTo }));
    syncHref();
    window.addEventListener('hashchange', syncHref);
    window.addEventListener('popstate', syncHref);
    return () => {
      window.removeEventListener('hashchange', syncHref);
      window.removeEventListener('popstate', syncHref);
    };
  }, [loginUrl, returnTo]);

  function publishSession(current: BrowserSession) {
    const previous = verifiedSession.current;
    const verified = sessionIdentity(previous) === sessionIdentity(current) ? previous! : current;
    verifiedSession.current = verified;
    setSession(verified);
    setCheckingAuthority(false);
    callbacks.current.onChange(verified.authenticated);
    callbacks.current.onSession?.(verified);
  }
  function suspendPrivateUI() {
    if (verifiedSession.current?.authenticated) {
      callbacks.current.onChange(false);
      callbacks.current.onSession?.({
        ...verifiedSession.current,
        authenticated: false,
        checkingAuthority: true,
      });
    }
    setCheckingAuthority(true);
  }
  useEffect(() => {
    let mounted = true;
    signalSource.current ||= crypto.randomUUID();
    const refresh = (preserveError = false) => {
      if (mutationActive.current) {
        queuedRefresh.current = true;
        return;
      }
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      const version = ++sessionVersion.current;
      suspendPrivateUI();
      void fetch('/api/session', { signal: controller.signal, cache: 'no-store' })
        .then(async (response) => {
          if (!response.ok)
            throw new Error('Sign-in is temporarily unavailable. Please try again.');
          const body = await response.json();
          if (!mounted || controller.signal.aborted || version !== sessionVersion.current) return;
          const current = (body.data ?? body) as BrowserSession;
          if (typeof current?.authenticated !== 'boolean')
            throw new Error('Invalid session response.');
          publishSession(current);
          if (!preserveError) setError('');
        })
        .catch(() => {
          if (!mounted || controller.signal.aborted || version !== sessionVersion.current) return;
          verifiedSession.current = null;
          setSession(null);
          setCheckingAuthority(false);
          callbacks.current.onSession?.({ authenticated: false, unavailable: true });
          callbacks.current.onChange(false);
          if (!preserveError) setError('Sign-in is temporarily unavailable. Please try again.');
        });
    };
    refreshAuthority.current = refresh;
    const onFocus = () => {
      if (!document.hidden) refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === sessionSignal) refresh();
    };
    const onSignal = (event: Event) => {
      if ((event as CustomEvent<{ source?: string }>).detail?.source !== signalSource.current)
        refresh();
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(sessionChannel);
      channel.onmessage = (event: MessageEvent) => {
        if (event.data?.type === 'changed' && event.data?.source !== signalSource.current)
          refresh();
      };
    } catch {
      /* Focus/storage events cover browsers without this optional channel. */
    }
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('storage', onStorage);
    window.addEventListener(sessionEvent, onSignal);
    refresh();
    return () => {
      mounted = false;
      sessionVersion.current++;
      readController.current?.abort();
      refreshAuthority.current = () => {};
      channel?.close();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(sessionEvent, onSignal);
    };
  }, [retry]);
  async function changeSession(signIn: boolean) {
    const version = ++sessionVersion.current;
    mutationActive.current = true;
    readController.current?.abort();
    suspendPrivateUI();
    setBusy(true);
    setError('');
    let failed = false;
    try {
      const response = await fetch('/api/session', {
        method: signIn ? 'POST' : 'DELETE',
        ...(signIn
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }
          : {}),
      });
      if (!response.ok)
        throw new Error(
          signIn
            ? 'This workspace key could not be connected. Check its expiry and permissions with your administrator.'
            : 'Sign-out could not be completed. Please try again.',
        );
      const body = await response.json();
      if (version !== sessionVersion.current) return;
      const current = (body.data ?? body) as BrowserSession;
      publishSession(current);
      notifyBrowserSessionChanged(signalSource.current);
    } catch (cause) {
      if (version !== sessionVersion.current) return;
      failed = true;
      setError(cause instanceof Error ? cause.message : 'Sign-in could not be completed.');
    } finally {
      mutationActive.current = false;
      setToken('');
      setBusy(false);
      if (failed || queuedRefresh.current) {
        queuedRefresh.current = false;
        refreshAuthority.current(failed);
      }
    }
  }

  const providers = session?.authProviders;
  const signInAvailable = Boolean(
    session?.oidcEnabled || providers?.oidc || providers?.github || providers?.emailOtp,
  );
  const providerLabels: string[] = [];
  if (providers?.oidc) providerLabels.push(providers.oidcLabel || 'Single sign-on');
  if (providers?.github) providerLabels.push('GitHub');
  if (providers?.emailOtp) providerLabels.push('Email code');
  const showProviderSummary =
    providerLabels.length > 1 ||
    Boolean(providers?.oidcLabel) ||
    Boolean(providers?.github) ||
    Boolean(providers?.emailOtp);

  return (
    <section className={`${styles.access} gateway-access`} aria-label="OpenGen account">
      {session?.authenticated ? (
        <div className={`${styles.connected} gateway-connected`}>
          <span>
            <span className="status-dot" />{' '}
            {checkingAuthority ? 'Checking access to' : 'Connected to'}{' '}
            <strong>{session.workspaceId ?? 'your workspace'}</strong>
          </span>
          <button
            className="button button-outline"
            onClick={() => changeSession(false)}
            disabled={busy}
          >
            Sign out
          </button>
        </div>
      ) : (
        <>
          <span className="eyebrow">A PLACE FOR YOUR IDEAS</span>
          <h2>Welcome to OpenGen.</h2>
          <p>One account for creating in your browser, connecting an agent and using the API.</p>
          <p className="legal-review-links">
            {legal.mode === 'published' ? (
              <>
                Review the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/privacy">Privacy Notice</a>.
              </>
            ) : legal.mode === 'staged' ? (
              <>
                Review the <a href="/terms">Terms of Service</a> and{' '}
                <a href="/privacy">Privacy Notice</a>. Scheduled effective {legal.effectiveAt} — not
                yet effective.
              </>
            ) : (
              <>
                Review the <a href="/terms">Terms draft</a> and <a href="/privacy">Privacy draft</a>
                . These proposals are not yet effective.
              </>
            )}
          </p>
          {!session && !error && <p role="status">Checking available sign-in…</p>}
          {signInAvailable && (
            <>
              <div className={styles.actions}>
                <a className={styles.primary} href={resolvedLoginUrl}>
                  Sign in or create account
                </a>
                <a className={styles.quiet} href="/agents">
                  Explore agent setup ↗
                </a>
              </div>
              {showProviderSummary && (
                <p className="auth-providers-summary">Sign in with {providerLabels.join(' · ')}.</p>
              )}
              <p>
                First sign-in creates your account and a personal workspace. Your workspace starts
                with $0 credit.
              </p>
            </>
          )}
          {session && !signInAvailable && (
            <p role="status">
              Account sign-in is not configured on this installation yet. You can explore models and
              agent guides now. Contact your installation operator for account access.
            </p>
          )}
          {session && (
            <details>
              <summary>Self-hosted access with an existing workspace key</summary>
              <p>
                For customers who already have a scoped OpenGen workspace key. Get one from your
                workspace administrator. Installation and provider secrets belong in server
                configuration.
              </p>
              <label>
                Workspace API key
                <input
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Your scoped workspace key"
                />
              </label>
              <button
                className={styles.primary}
                onClick={() => changeSession(true)}
                disabled={busy || checkingAuthority || !token.trim()}
              >
                {busy ? 'Connecting…' : 'Connect workspace'}
              </button>
              <p>The key is exchanged for an HttpOnly session and cleared from this form.</p>
            </details>
          )}
        </>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <button
            className="button button-outline"
            disabled={busy}
            onClick={() => setRetry((value) => value + 1)}
          >
            Try again
          </button>
        </div>
      )}
    </section>
  );
}
