'use client';

import { useEffect, useRef, useState } from 'react';
import { useLegalPresentation } from './legal/presentation';
import styles from './onboarding/onboarding.module.css';

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
  ]);

/** Customer sign-in reuses configured OIDC and opaque HttpOnly sessions. */
export function GatewayAccess({
  onChange,
  onSession,
  loginUrl = '/auth/login',
}: {
  onChange: (authenticated: boolean) => void;
  onSession?: (session: BrowserSession) => void;
  loginUrl?: string;
}) {
  const legal = useLegalPresentation();
  const [session, setSession] = useState<BrowserSession | null>(null);
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
          {session?.oidcEnabled && (
            <>
              <div className={styles.actions}>
                <a className={styles.primary} href={loginUrl}>
                  Sign in or create account
                </a>
                <a className={styles.quiet} href="/agents">
                  Explore agent setup ↗
                </a>
              </div>
              <p>
                First sign-in creates your account and a personal workspace. Your workspace starts
                with $0 credit.
              </p>
            </>
          )}
          {session && !session.oidcEnabled && (
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
