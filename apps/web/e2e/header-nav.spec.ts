import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

function buildSession(options: {
  authenticated: boolean;
  oidcEnabled?: boolean;
  workspaceId?: string;
  scopes?: string[];
  role?: 'admin' | 'member';
}) {
  if (!options.authenticated)
    return { authenticated: false, oidcEnabled: options.oidcEnabled ?? true };
  const workspaceId = options.workspaceId ?? 'studio-a';
  const scopes = options.scopes ?? ['read', 'generate', 'keys:write'];
  const membershipId = '00000000-0000-4000-8000-000000000501';
  const recoveryScope = createHash('sha256')
    .update(JSON.stringify([workspaceId, membershipId, [...scopes].sort()]))
    .digest('hex');
  return {
    authenticated: true,
    workspaceId,
    membershipId,
    recoveryScope,
    scopes,
    role: options.role ?? 'admin',
    canSwitchWorkspace: true,
    oidcEnabled: options.oidcEnabled ?? true,
  };
}

async function noOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(result.scrollWidth).toBeLessThanOrEqual(result.innerWidth);
}

async function assertHeaderClearance(page: Page) {
  await noOverflow(page);
  const geometry = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.site-header');
    const brand = document.querySelector<HTMLElement>('.site-header .brand');
    const actions = document.querySelector<HTMLElement>('.header-actions');
    if (!header || !brand || !actions) return null;
    const headerRect = header.getBoundingClientRect();
    const brandRect = brand.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const visibleLinks = Array.from(document.querySelectorAll<HTMLElement>('.header-links a'))
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { text: el.textContent?.trim() ?? '', left: rect.left, right: rect.right };
      });
    return {
      headerLeft: headerRect.left,
      headerRight: headerRect.right,
      brandRight: brandRect.right,
      actionsLeft: actionsRect.left,
      actionsRight: actionsRect.right,
      visibleLinks,
    };
  });
  expect(geometry).not.toBeNull();
  expect(geometry!.brandRight).toBeLessThanOrEqual(geometry!.actionsLeft + 0.5);
  expect(geometry!.actionsRight).toBeLessThanOrEqual(geometry!.headerRight + 0.5);
  for (const link of geometry!.visibleLinks) {
    expect(link.left).toBeGreaterThanOrEqual(geometry!.brandRight - 0.5);
    expect(link.right).toBeLessThanOrEqual(geometry!.actionsLeft + 0.5);
  }
}

for (const viewport of [
  { name: 'desktop', width: 1440, height: 960 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`persistent top nav bar (${viewport.name})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('persists Connect an agent and Sign in across home overlay and inner pages when signed out', async ({
      page,
    }) => {
      let oidcEnabled = true;
      const balanceCalls: string[] = [];
      await page.route('**/api/session', (route) =>
        route.fulfill({ json: buildSession({ authenticated: false, oidcEnabled }) }),
      );
      await page.route('**/api/balance', (route) => {
        balanceCalls.push(route.request().url());
        return route.fulfill({ status: 401, json: { error: 'Unauthorized' } });
      });

      for (const path of ['/models', '/playground', '/docs', '/']) {
        await page.goto(path);
        const nav = page.getByRole('navigation', { name: 'Main navigation' });
        const connect = nav.getByRole('button', { name: 'Connect an agent', exact: true });
        const signIn = nav.getByRole('link', { name: 'Sign in', exact: true });
        await expect(connect).toBeVisible();
        await expect(signIn).toBeVisible();
        await expect(signIn).toHaveAttribute('href', '/auth/login');
        await expect(page.getByTestId('header-balance')).toHaveCount(0);
        await assertHeaderClearance(page);
      }

      // Clicking Connect an agent on the homepage overlay opens the setup dialog directly.
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      const connect = nav.getByRole('button', { name: 'Connect an agent', exact: true });
      await connect.click();
      const dialog = page.getByRole('dialog', { name: 'One catalog. Every interface.' });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(connect).toBeFocused();

      // Self-hosted / unconfigured OIDC links Sign in to /start instead of /auth/login.
      oidcEnabled = false;
      await page.goto('/models');
      await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
        'href',
        '/start',
      );
      expect(balanceCalls).toEqual([]);
    });

    test('always shows remaining credit, Connect an agent and workspace menu across the site when signed in', async ({
      page,
    }) => {
      let authenticated = true;
      let workspaceId = 'studio-a';
      let availableMicros = 9_600_000;
      let reservedMicros = 400_000;
      let signOutCalls = 0;

      await page.route('**/api/session', async (route) => {
        if (route.request().method() === 'DELETE') {
          signOutCalls++;
          authenticated = false;
        }
        await route.fulfill({
          json: buildSession({ authenticated, workspaceId }),
        });
      });
      await page.route('**/api/balance', (route) =>
        route.fulfill({
          json: { availableMicros, reservedMicros },
        }),
      );

      for (const path of ['/models', '/playground', '/docs', '/']) {
        await page.goto(path);
        const nav = page.getByRole('navigation', { name: 'Main navigation' });
        await expect(
          nav.getByRole('button', { name: 'Connect an agent', exact: true }),
        ).toBeVisible();
        const balancePill = page.getByTestId('header-balance');
        await expect(balancePill).toBeVisible();
        await expect(balancePill).toContainText('$9.60');
        await expect(balancePill).toHaveAttribute('href', '/billing');
        await expect(nav.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
        await assertHeaderClearance(page);
      }

      // Account popover shows workspace identity, available + reserved breakdown, Add credit and Sign out.
      const trigger = page.getByRole('button', { name: 'Account menu for studio-a', exact: true });
      await expect(trigger).toBeVisible();
      await trigger.click();
      const menu = page.getByRole('menu', { name: 'Workspace account', exact: true });
      await expect(menu).toBeVisible();
      await expect(menu).toContainText('studio-a');
      await expect(menu).toContainText('$9.60');
      await expect(menu).toContainText('Reserved for jobs');
      await expect(menu).toContainText('$0.40');
      await expect(menu.getByRole('menuitem', { name: 'Add credit' })).toHaveAttribute(
        'href',
        '/billing',
      );
      await noOverflow(page);

      // Escape closes the account menu and restores focus to the trigger.
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
      await expect(trigger).toBeFocused();

      // Workspace switch clears stale balance and loads the new workspace's remaining amount.
      workspaceId = 'studio-b';
      availableMicros = 0;
      reservedMicros = 0;
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('opengen:session-changed', { detail: { source: 'test-switch' } }),
        ),
      );
      const balancePill = page.getByTestId('header-balance');
      await expect(balancePill).toContainText('$0.00');
      await expect(balancePill).toHaveClass(/header-balance-zero/);
      await expect(
        page.getByRole('button', { name: 'Account menu for studio-b', exact: true }),
      ).toBeVisible();

      // Sign out from the account menu ends the session and returns to Sign in.
      await page.getByRole('button', { name: 'Account menu for studio-b', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
      await expect.poll(() => signOutCalls).toBe(1);
      await expect(page.getByTestId('header-balance')).toHaveCount(0);
      await expect(
        page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', {
          name: 'Sign in',
          exact: true,
        }),
      ).toBeVisible();
    });
  });
}

test('suspends private header data while rechecking authority after a cross-tab signal', async ({
  page,
}) => {
  let holdSession = false;
  let releaseSession: (() => void) | null = null;
  let authenticated = true;

  await page.route('**/api/session', async (route) => {
    if (holdSession) {
      await new Promise<void>((resolve) => {
        releaseSession = resolve;
      });
    }
    await route.fulfill({ json: buildSession({ authenticated, workspaceId: 'studio-a' }) });
  });
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 9_600_000, reservedMicros: 0 } }),
  );

  await page.goto('/models');
  await expect(page.getByTestId('header-balance')).toContainText('$9.60');
  const trigger = page.getByRole('button', { name: 'Account menu for studio-a', exact: true });
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Workspace account', exact: true })).toBeVisible();

  // Hold the revalidation GET and simulate another tab signing out.
  holdSession = true;
  authenticated = false;
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('opengen:session-changed', { detail: { source: 'other-tab' } }),
    ),
  );

  // Private credit, workspace name, and account menu disappear immediately before /api/session completes.
  await expect(page.getByTestId('header-checking')).toBeVisible();
  await expect(page.getByTestId('header-balance')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account menu for studio-a' })).toHaveCount(0);
  await expect(page.getByRole('menu', { name: 'Workspace account' })).toHaveCount(0);

  // Release the pending session response and verify clean transition to signed-out UI.
  await expect.poll(() => releaseSession !== null).toBe(true);
  releaseSession!();
  await expect(page.getByTestId('header-checking')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Sign in', exact: true }),
  ).toBeVisible();
});

test('preserves sign-out error across session revalidation until a new attempt succeeds', async ({
  page,
}) => {
  let authenticated = true;
  let failDelete = true;
  let sessionGets = 0;

  await page.route('**/api/session', async (route) => {
    if (route.request().method() === 'DELETE') {
      if (failDelete) {
        await route.fulfill({ status: 500, json: { error: 'Temporary failure' } });
        return;
      }
      authenticated = false;
      await route.fulfill({ status: 204 });
      return;
    } else {
      sessionGets++;
    }
    await route.fulfill({ json: buildSession({ authenticated, workspaceId: 'studio-a' }) });
  });
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 9_600_000, reservedMicros: 0 } }),
  );

  await page.goto('/models');
  await expect(page.getByTestId('header-balance')).toContainText('$9.60');
  const getsBeforeSignOut = sessionGets;

  await page.getByRole('button', { name: 'Account menu for studio-a', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();

  // Wait for the revalidation GET after failed DELETE and verify the error alert persists.
  await expect.poll(() => sessionGets).toBeGreaterThan(getsBeforeSignOut);
  const menu = page.getByRole('menu', { name: 'Workspace account', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('alert')).toContainText('Sign-out could not be completed.');

  // Retrying sign-out with HTTP 204 clears the error and preserves the OIDC Sign in target.
  failDelete = false;
  await menu.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.getByTestId('header-balance')).toHaveCount(0);
  const signIn = page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Sign in', exact: true });
  await expect(signIn).toBeVisible();
  await expect(signIn).toHaveAttribute('href', '/auth/login');
});

test('refreshes remaining credit via bounded visible-page polling without session-change events', async ({
  page,
}) => {
  let availableMicros = 9_600_000;
  let reservedMicros = 0;
  let balanceCalls = 0;

  await page.clock.install();
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: buildSession({ authenticated: true, workspaceId: 'studio-a' }) }),
  );
  await page.route('**/api/balance', (route) => {
    balanceCalls++;
    return route.fulfill({ json: { availableMicros, reservedMicros } });
  });

  await page.goto('/playground');
  const balancePill = page.getByTestId('header-balance');
  await expect(balancePill).toContainText('$9.60');

  // Simulate an in-page generation reserving and spending balance without emitting session-changed.
  availableMicros = 8_400_000;
  reservedMicros = 400_000;
  await page.clock.runFor(15_500);
  await expect(balancePill).toContainText('$8.40');

  // Polling stops after the bounded idle cap (20 unchanged ticks) instead of running forever.
  for (let i = 0; i < 20; i++) {
    const expected = balanceCalls + 1;
    await page.clock.runFor(15_000);
    await expect.poll(() => balanceCalls).toBe(expected);
  }
  const callsAtCap = balanceCalls;
  await page.clock.runFor(60_000);
  expect(balanceCalls).toBe(callsAtCap);
});

test('supports keyboard navigation and focus restoration for the account menu', async ({
  page,
}) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: buildSession({ authenticated: true, workspaceId: 'studio-a' }) }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 9_600_000, reservedMicros: 0 } }),
  );

  await page.goto('/models');
  const trigger = page.getByRole('button', { name: 'Account menu for studio-a', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.focus();

  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Workspace account', exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Add credit' })).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Workspace', exact: true })).toBeFocused();

  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeFocused();

  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Add credit' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('keeps header links clear of actions across responsive breakpoints for overlay and regular headers', async ({
  page,
}) => {
  let authenticated = false;
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: buildSession({ authenticated, workspaceId: 'studio-alpha' }) }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 1_234_560_000, reservedMicros: 0 } }),
  );

  const widths = [1440, 1151, 1024, 960, 850, 761, 760, 621, 390, 360];
  for (const signedIn of [false, true]) {
    authenticated = signedIn;
    for (const path of ['/', '/models']) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      if (signedIn) {
        await expect(page.getByTestId('header-balance')).toContainText('$1,234.56');
      } else {
        await expect(
          page
            .getByRole('navigation', { name: 'Main navigation' })
            .getByRole('link', { name: 'Sign in', exact: true }),
        ).toBeVisible();
      }
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 });
        await assertHeaderClearance(page);
      }
    }
  }
});

test('signed-in session without read scope never fabricates zero credit or calls /api/balance', async ({
  page,
}) => {
  let balanceCalls = 0;
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: buildSession({ authenticated: true, workspaceId: 'studio-a', scopes: ['keys:write'] }),
    }),
  );
  await page.route('**/api/balance', (route) => {
    balanceCalls++;
    return route.fulfill({ status: 403, json: { error: 'Read scope required.' } });
  });
  await page.goto('/models');
  const balancePill = page.getByTestId('header-balance');
  await expect(balancePill).toBeVisible();
  await expect(balancePill).toContainText('—');
  await expect(balancePill).not.toContainText('$0.00');
  expect(balanceCalls).toBe(0);
});

test('formats fractional balances compactly without rounding tiny positive credit down to zero', async ({
  page,
}) => {
  let availableMicros = 94_257_920;
  let reservedMicros = 0;

  await page.route('**/api/session', (route) =>
    route.fulfill({ json: buildSession({ authenticated: true, workspaceId: 'studio-a' }) }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros, reservedMicros } }),
  );

  await page.goto('/models');
  const balancePill = page.getByTestId('header-balance');
  await expect(balancePill).toHaveText('$94.26');

  availableMicros = 5_970;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('opengen:balance-changed')));
  await expect(balancePill).toHaveText('$0.006');

  availableMicros = 50;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('opengen:balance-changed')));
  await expect(balancePill).toHaveText('<$0.0001');
  await expect(balancePill).not.toHaveClass(/header-balance-zero/);
});

test('consolidates /start to /app#start once authenticated', async ({ page }) => {
  await page.route('**/api/session', (route) =>
    route.fulfill({ json: buildSession({ authenticated: true, workspaceId: 'studio-a' }) }),
  );
  await page.route('**/api/balance', (route) =>
    route.fulfill({ json: { availableMicros: 9_600_000, reservedMicros: 0 } }),
  );
  await page.route(/\/api\/activity(?:\?|$)/, (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  for (const path of ['ledger', 'policies', 'keys', 'workspaces', 'connections', 'oauth/grants']) {
    await page.route(`**/api/${path}`, (route) => route.fulfill({ json: { data: [] } }));
  }

  await page.goto('/start');
  await expect(page).toHaveURL(/\/app#start$/);
});
