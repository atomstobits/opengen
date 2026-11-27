'use client';

import { useEffect, useState } from 'react';
import { notifyBrowserSessionChanged, type BrowserSession } from './gateway-access';
import { hasWorkspaceAuthority, privateWorkspaceHeaders } from './dashboard/activity-view';

export type WorkspaceBalance = {
  availableMicros: number;
  reservedMicros: number;
};

export type HeaderBalanceStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

export interface HeaderSessionSnapshot {
  session: BrowserSession | null;
  checked: boolean;
  balance: WorkspaceBalance | null;
  balanceStatus: HeaderBalanceStatus;
  signingOut: boolean;
  signOutError: string;
}

export interface HeaderSessionState extends HeaderSessionSnapshot {
  signOut: () => Promise<boolean>;
}

const sessionEvent = 'opengen:session-changed';
const sessionSignal = 'opengen:session-signal';
const sessionChannel = 'opengen-session';

export function formatRemainingUsd(micros: number | null | undefined): string {
  if (micros == null || !Number.isSafeInteger(micros)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / 1_000_000);
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

function parseBalance(body: unknown): WorkspaceBalance | null {
  if (!body || typeof body !== 'object') return null;
  const candidate =
    'data' in body && body.data && typeof body.data === 'object'
      ? (body.data as Record<string, unknown>)
      : (body as Record<string, unknown>);
  if (
    typeof candidate.availableMicros !== 'number' ||
    !Number.isSafeInteger(candidate.availableMicros)
  )
    return null;
  const reservedMicros =
    typeof candidate.reservedMicros === 'number' && Number.isSafeInteger(candidate.reservedMicros)
      ? candidate.reservedMicros
      : 0;
  return { availableMicros: candidate.availableMicros, reservedMicros };
}

function canReadBalance(session: BrowserSession | null): session is BrowserSession & {
  authenticated: true;
  workspaceId: string;
} {
  return Boolean(session?.authenticated && session.workspaceId && session.scopes?.includes('read'));
}

const initialSnapshot: HeaderSessionSnapshot = {
  session: null,
  checked: false,
  balance: null,
  balanceStatus: 'idle',
  signingOut: false,
  signOutError: '',
};

let state: HeaderSessionSnapshot = { ...initialSnapshot };
const listeners = new Set<() => void>();
let activeConsumers = 0;
let teardownListeners: (() => void) | null = null;
let sessionVersion = 0;
let balanceVersion = 0;
let sessionController: AbortController | null = null;
let balanceController: AbortController | null = null;
let mutationActive = false;
let queuedRefresh = false;
let signalSource = '';

function update(patch: Partial<HeaderSessionSnapshot>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function fetchBalanceFor(current: BrowserSession, expectedSessionVersion: number) {
  balanceController?.abort();
  if (!canReadBalance(current)) {
    update({ balance: null, balanceStatus: current.authenticated ? 'unavailable' : 'idle' });
    return;
  }
  const controller = new AbortController();
  balanceController = controller;
  const version = ++balanceVersion;
  if (state.balanceStatus !== 'ready') update({ balanceStatus: 'loading' });

  const authority = {
    workspaceId: current.workspaceId,
    recoveryScope: current.recoveryScope ?? null,
  };
  const headers = hasWorkspaceAuthority(authority) ? privateWorkspaceHeaders(authority) : undefined;
  void fetch('/api/balance', {
    signal: controller.signal,
    cache: 'no-store',
    ...(headers ? { headers } : {}),
  })
    .then(async (response) => {
      if (
        controller.signal.aborted ||
        version !== balanceVersion ||
        expectedSessionVersion !== sessionVersion
      )
        return;
      if (response.status === 401 || response.status === 409) {
        update({ balance: null, balanceStatus: 'unavailable' });
        refreshSession();
        return;
      }
      if (!response.ok) {
        update({ balance: null, balanceStatus: 'unavailable' });
        return;
      }
      const body = await response.json();
      if (
        controller.signal.aborted ||
        version !== balanceVersion ||
        expectedSessionVersion !== sessionVersion
      )
        return;
      const parsed = parseBalance(body);
      if (!parsed) {
        update({ balance: null, balanceStatus: 'unavailable' });
        return;
      }
      update({ balance: parsed, balanceStatus: 'ready' });
    })
    .catch(() => {
      if (
        controller.signal.aborted ||
        version !== balanceVersion ||
        expectedSessionVersion !== sessionVersion
      )
        return;
      update({ balance: null, balanceStatus: 'unavailable' });
    });
}

function refreshSession() {
  if (typeof window === 'undefined' || activeConsumers === 0) return;
  if (mutationActive) {
    queuedRefresh = true;
    return;
  }
  sessionController?.abort();
  const controller = new AbortController();
  sessionController = controller;
  const version = ++sessionVersion;

  void fetch('/api/session', { signal: controller.signal, cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('Session unavailable');
      const body = await response.json();
      if (controller.signal.aborted || version !== sessionVersion) return;
      const current = (body.data ?? body) as BrowserSession;
      if (typeof current?.authenticated !== 'boolean') throw new Error('Invalid session');

      const previous = state.session;
      const identityChanged = sessionIdentity(previous) !== sessionIdentity(current);
      const verified = identityChanged ? current : previous!;

      if (!verified.authenticated) {
        balanceVersion++;
        balanceController?.abort();
        update({
          session: verified,
          checked: true,
          balance: null,
          balanceStatus: 'idle',
          signOutError: '',
        });
        return;
      }

      if (identityChanged) {
        // Clear the previous workspace's balance immediately so it never flashes across switches.
        balanceVersion++;
        balanceController?.abort();
        update({
          session: verified,
          checked: true,
          balance: null,
          balanceStatus: canReadBalance(verified) ? 'loading' : 'unavailable',
          signOutError: '',
        });
      } else {
        update({ session: verified, checked: true, signOutError: '' });
      }

      fetchBalanceFor(verified, version);
    })
    .catch(() => {
      if (controller.signal.aborted || version !== sessionVersion) return;
      balanceVersion++;
      balanceController?.abort();
      update({ session: null, checked: true, balance: null, balanceStatus: 'idle' });
    });
}

async function signOut(): Promise<boolean> {
  const version = ++sessionVersion;
  balanceVersion++;
  mutationActive = true;
  sessionController?.abort();
  balanceController?.abort();
  update({ signingOut: true, signOutError: '' });
  let succeeded = false;
  try {
    const response = await fetch('/api/session', { method: 'DELETE' });
    if (!response.ok) throw new Error('Sign-out could not be completed. Please try again.');
    const body = await response.json();
    if (version !== sessionVersion) return false;
    const current = (body.data ?? body) as BrowserSession;
    update({
      session: current,
      checked: true,
      balance: null,
      balanceStatus: 'idle',
      signOutError: '',
    });
    succeeded = true;
    notifyBrowserSessionChanged(signalSource);
    return true;
  } catch (cause) {
    if (version !== sessionVersion) return false;
    update({
      signOutError: cause instanceof Error ? cause.message : 'Sign-out could not be completed.',
    });
    return false;
  } finally {
    mutationActive = false;
    update({ signingOut: false });
    if (!succeeded || queuedRefresh) {
      queuedRefresh = false;
      refreshSession();
    }
  }
}

function attachListeners() {
  if (typeof window === 'undefined' || teardownListeners) return;
  signalSource ||= crypto.randomUUID();

  const onFocus = () => {
    if (!document.hidden) refreshSession();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') refreshSession();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === sessionSignal) refreshSession();
  };
  const onSessionSignal = (event: Event) => {
    if ((event as CustomEvent<{ source?: string }>).detail?.source !== signalSource)
      refreshSession();
  };

  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(sessionChannel);
    channel.onmessage = (event: MessageEvent) => {
      if (event.data?.type === 'changed' && event.data?.source !== signalSource) refreshSession();
    };
  } catch {
    /* Focus and storage listeners cover browsers without BroadcastChannel. */
  }

  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('storage', onStorage);
  window.addEventListener(sessionEvent, onSessionSignal);

  teardownListeners = () => {
    sessionVersion++;
    balanceVersion++;
    sessionController?.abort();
    balanceController?.abort();
    channel?.close();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(sessionEvent, onSessionSignal);
    teardownListeners = null;
  };
}

export function useHeaderSession(): HeaderSessionState {
  // Always start from the deterministic SSR-safe snapshot, then sync on mount to avoid hydration mismatches.
  const [snapshot, setSnapshot] = useState<HeaderSessionSnapshot>(initialSnapshot);

  useEffect(() => {
    const sync = () => setSnapshot(state);
    listeners.add(sync);
    activeConsumers++;
    if (activeConsumers === 1) attachListeners();
    sync();
    refreshSession();

    return () => {
      listeners.delete(sync);
      activeConsumers = Math.max(0, activeConsumers - 1);
      if (activeConsumers === 0) teardownListeners?.();
    };
  }, []);

  return { ...snapshot, signOut };
}
