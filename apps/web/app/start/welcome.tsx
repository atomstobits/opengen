'use client';
import { useEffect, useState } from 'react';
import { GatewayAccess, type BrowserSession } from '../gateway-access';
import { SiteHeader, Footer } from '../ui';
import styles from '../onboarding/onboarding.module.css';

export function Welcome() {
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const readyToRedirect = authenticated && !session?.checkingAuthority;

  useEffect(() => {
    if (!readyToRedirect || typeof window === 'undefined') return;
    window.location.replace('/app#start');
  }, [readyToRedirect]);

  return (
    <>
      <SiteHeader />
      <main className={`page-width ${styles.start}`}>
        <span className="eyebrow">OPEN TO YOUR NEXT IDEA</span>
        <h1>
          A little setup.
          <br />A lot to create.
        </h1>
        <p className={styles.intro}>
          Images and video, through your favorite agent or right here in your browser. Start with a
          workspace that keeps your work together.
        </p>
        <GatewayAccess onChange={setAuthenticated} onSession={setSession} />
        {readyToRedirect ? (
          <section className={styles.journey} aria-live="polite">
            <p role="status">
              Signed in to <strong>{session?.workspaceId ?? 'your workspace'}</strong> — taking you
              to your workspace…
            </p>
            <nav className={styles.nav} aria-label="Your account">
              <a className="button button-dark" href="/app#start">
                Continue to your workspace ↗
              </a>
              <a href="/playground">Create in browser ↗</a>
              <a href="/billing">Credit &amp; billing ↗</a>
            </nav>
          </section>
        ) : (
          <nav className={styles.nav} aria-label="Explore OpenGen">
            <a href="/agents">Agent / CLI / API setup ↗</a>
            <a href="/playground">Create in browser ↗</a>
          </nav>
        )}
      </main>
      <Footer />
    </>
  );
}
