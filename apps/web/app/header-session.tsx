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
  checkingAuthority: boolean;
  balance: WorkspaceBalance | null;
  balanceStatus: HeaderBalanceStatus;
  signingOut: boolean;
  signOutError: string;
}

export interface HeaderSessionState extends HeaderSessionSnapshot {
  signOut: () => Promise<boolean>;
  refreshBalance: () => void;
}

const sessionEvent = 'opengen:session-changed';
const balanceEvent = 'opengen:balance-changed';
const sessionSignal = 'opengen:session-signal';
const sessionChannel = 'opengen-session';

const BALANCE_POLL_INTERVAL_MS = 15_000;
const MAX_IDLE_BALANCE_POLLS = 20;

export function notifyHeaderBalanceChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(balanceEvent));
}

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
  checkingAuthority: false,
  balance: null,
  balanceStatus: 'idle',
  signingOut: false,
  signOutError: '',
};

let state: HeaderSessionSnapshot = { ...initialSnapshot };
let verifiedSession: BrowserSession | null = null;
const listeners = new Set<() => void>();
let activeConsumers = 0;
let teardownListeners: (() => void) | null = null;
let sessionVersion = 0;
let balanceVersion = 0;
let sessionController: AbortController | null = null;
let balanceController: AbortController | null = null;
let balanceInFlight = false;
let balancePollTimer: number | null = null;
let idleBalancePolls = 0;
let mutationActive = false;
let queuedRefresh = false;
let signalSource = '';

function update(patch: Partial<HeaderSessionSnapshot>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function stopBalancePolling() {
  if (balancePollTimer !== null) {
    window.clearInterval(balancePollTimer);
    balancePollTimer = null;
  }
}

function startBalancePolling() {
  if (
    typeof window === 'undefined' ||
    activeConsumers === 0 ||
    balancePollTimer !== null ||
    !canReadBalance(verifiedSession)
  ) {
    return;
  }
  balancePollTimer = window.setInterval(() => {
    if (
      activeConsumers === 0 ||
      typeof document === 'undefined' ||
      document.hidden ||
      document.visibilityState !== 'visible'
    ) {
      return;
    }
    if (mutationActive || state.checkingAuthority || balanceInFlight) return;
    if (!canReadBalance(verifiedSession)) {
      stopBalancePolling();
      return;
    }
    if (idleBalancePolls >= MAX_IDLE_BALANCE_POLLS) {
      stopBalancePolling();
      return;
    }
    idleBalancePolls++;
    fetchBalanceFor(verifiedSession, sessionVersion);
  }, BALANCE_POLL_INTERVAL_MS);
}

function suspendPrivateHeader() {
  balanceVersion++;
  balanceInFlight = false;
  balanceController?.abort();
  stopBalancePolling();
  if (state.session?.authenticated || verifiedSession?.authenticated) {
    update({
      session: null,
      balance: null,
      balanceStatus: 'idle',
      checkingAuthority: true,
    });
  }
}

function fetchBalanceFor(current: BrowserSession, expectedSessionVersion: number) {
  balanceController?.abort();
  if (!canReadBalance(current)) {
    balanceInFlight = false;
    stopBalancePolling();
    update({ balance: null, balanceStatus: current.authenticated ? 'unavailable' : 'idle' });
    return;
  }
  const controller = new AbortController();
  balanceController = controller;
  const version = ++balanceVersion;
  balanceInFlight = true;
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
        balanceInFlight = false;
        update({ balance: null, balanceStatus: 'unavailable' });
        refreshSession();
        return;
      }
      if (!response.ok) {
        balanceInFlight = false;
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
      balanceInFlight = false;
      const parsed = parseBalance(body);
      if (!parsed) {
        update({ balance: null, balanceStatus: 'unavailable' });
        return;
      }
      if (
        !state.balance ||
        state.balance.availableMicros !== parsed.availableMicros ||
        state.balance.reservedMicros !== parsed.reservedMicros
      ) {
        idleBalancePolls = 0;
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
      balanceInFlight = false;
      update({ balance: null, balanceStatus: 'unavailable' });
    });
}

function refreshBalance() {
  if (
    typeof window === 'undefined' ||
    activeConsumers === 0 ||
    mutationActive ||
    state.checkingAuthority ||
    balanceInFlight
  ) {
    return;
  }
  if (!canReadBalance(verifiedSession)) return;
  idleBalancePolls = 0;
  startBalancePolling();
  fetchBalanceFor(verifiedSession, sessionVersion);
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
  suspendPrivateHeader();

  void fetch('/api/session', { signal: controller.signal, cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error('Session unavailable');
      const body = await response.json();
      if (controller.signal.aborted || version !== sessionVersion) return;
      const current = (body.data ?? body) as BrowserSession;
      if (typeof current?.authenticated !== 'boolean') throw new Error('Invalid session');

      const previous = verifiedSession;
      const identityChanged = sessionIdentity(previous) !== sessionIdentity(current);
      const verified = identityChanged ? current : previous!;
      verifiedSession = verified;

      if (!verified.authenticated) {
        balanceVersion++;
        balanceInFlight = false;
        balanceController?.abort();
        stopBalancePolling();
        update({
          session: verified,
          checked: true,
          checkingAuthority: false,
          balance: null,
          balanceStatus: 'idle',
          signOutError: '',
        });
        return;
      }

      idleBalancePolls = 0;
      update({
        session: verified,
        checked: true,
        checkingAuthority: false,
        balance: null,
        balanceStatus: canReadBalance(verified) ? 'loading' : 'unavailable',
        // Preserve any prior sign-out failure message if the unchanged session is still active.
        ...(identityChanged ? { signOutError: '' } : {}),
      });

      fetchBalanceFor(verified, version);
      if (canReadBalance(verified)) startBalancePolling();
      else stopBalancePolling();
    })
    .catch(() => {
      if (controller.signal.aborted || version !== sessionVersion) return;
      verifiedSession = null;
      balanceVersion++;
      balanceInFlight = false;
      balanceController?.abort();
      stopBalancePolling();
      update({
        session: null,
        checked: true,
        checkingAuthority: false,
        balance: null,
        balanceStatus: 'idle',
        signOutError: '',
      });
    });
}

async function signOut(): Promise<boolean> {
  const version = ++sessionVersion;
  balanceVersion++;
  balanceInFlight = false;
  mutationActive = true;
  stopBalancePolling();
  sessionController?.abort();
  balanceController?.abort();
  update({ signingOut: true, signOutError: '' });
  let succeeded = false;
  try {
    const response = await fetch('/api/session', { method: 'DELETE' });
    if (!response.ok) throw new Error('Sign-out could not be completed. Please try again.');
    const body =
      response.status === 204
        ? { authenticated: false, oidcEnabled: verifiedSession?.oidcEnabled }
        : await response.json();
    if (version !== sessionVersion) return false;
    const current = (body.data ?? body) as BrowserSession;
    verifiedSession = current;
    update({
      session: current,
      checked: true,
      checkingAuthority: false,
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
  const onBalanceSignal = () => {
    refreshBalance();
  };
  const onUserActivity = () => {
    if (idleBalancePolls > 0 || (balancePollTimer === null && canReadBalance(verifiedSession))) {
      idleBalancePolls = 0;
      if (!mutationActive && !state.checkingAuthority) startBalancePolling();
    }
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
  window.addEventListener(balanceEvent, onBalanceSignal);
  window.addEventListener('pointerdown', onUserActivity, { passive: true });
  window.addEventListener('keydown', onUserActivity, { passive: true });

  teardownListeners = () => {
    sessionVersion++;
    balanceVersion++;
    balanceInFlight = false;
    idleBalancePolls = 0;
    verifiedSession = null;
    stopBalancePolling();
    sessionController?.abort();
    balanceController?.abort();
    channel?.close();
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener(sessionEvent, onSessionSignal);
    window.removeEventListener(balanceEvent, onBalanceSignal);
    window.removeEventListener('pointerdown', onUserActivity);
    window.removeEventListener('keydown', onUserActivity);
    state = { ...initialSnapshot };
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

  return { ...snapshot, signOut, refreshBalance };
}
