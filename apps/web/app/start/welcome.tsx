'use client';
import { useState } from 'react';
import { GatewayAccess, type BrowserSession } from '../gateway-access';
import { SiteHeader, Footer } from '../ui';
import { FirstSteps } from '../onboarding/journey';
import styles from '../onboarding/onboarding.module.css';
export function Welcome() {
  const [authenticated, setAuthenticated] = useState(false);
  const [session, setSession] = useState<BrowserSession | null>(null);
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
        {authenticated ? (
          <>
            <nav className={styles.nav} aria-label="Your account">
              <a className="button button-dark" href="/app#start">
                Open your workspace ↗
              </a>
              <a href="/app#activity">View activity ↗</a>
              <a href="/app#team">Manage team ↗</a>
            </nav>
            <FirstSteps workspaceId={session?.workspaceId} />
          </>
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
