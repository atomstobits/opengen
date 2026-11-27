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

      for (const path of ['/', '/models', '/playground', '/docs']) {
        await page.goto(path);
        const nav = page.getByRole('navigation', { name: 'Main navigation' });
        const connect = nav.getByRole('button', { name: 'Connect an agent', exact: true });
        const signIn = nav.getByRole('link', { name: 'Sign in', exact: true });
        await expect(connect).toBeVisible();
        await expect(signIn).toBeVisible();
        await expect(signIn).toHaveAttribute('href', '/auth/login');
        await expect(page.getByTestId('header-balance')).toHaveCount(0);
        await noOverflow(page);
      }

      // Clicking Connect an agent on the homepage overlay opens the setup dialog directly.
      await page.goto('/');
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      await nav.getByRole('button', { name: 'Connect an agent', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'One catalog. Every interface.' });
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();

      // Self-hosted / unconfigured OIDC links Sign in to /start instead of /auth/login.
      oidcEnabled = false;
      await page.reload();
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

      for (const path of ['/', '/models', '/playground', '/docs']) {
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
        await noOverflow(page);
      }

      // Account popover shows workspace identity, available + reserved breakdown, Add credit and Sign out.
      await page.goto('/');
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

      // Workspace switch clears stale balance and loads the new workspace's remaining amount.
      await page.keyboard.press('Escape');
      await expect(menu).not.toBeVisible();
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
