import { expect, test } from '@playwright/test';

test.skip(
  process.env.OPENGEN_TERMS_BROWSER_FIXTURE !== '1',
  'Requires the isolated inactive-draft login fixture.',
);

/**
 * Run against Next with MEDIA_ROUTER_API_URL=http://127.0.0.1:4313 and
 * tests/helpers/terms-browser-server.ts. Next/proxy/notice routes are real.
 * Only the synthetic cross-origin IdP destination is fulfilled locally, and all
 * other external traffic is aborted. There is no account DB or receipt writer.
 */
for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000, mobile: false },
  { name: 'phone', width: 390, height: 844, mobile: true },
]) {
  test.describe(`draft Terms notice · ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.mobile,
      hasTouch: viewport.mobile,
    });

    test('shows the inactive policy and sends the actual browser Continue form through Next', async ({
      page,
      request,
      baseURL,
    }, info) => {
      const origin = new URL(baseURL ?? 'http://127.0.0.1:4323').origin;
      const authorizationUrl = 'https://identity.fixture.invalid/authorize?state=synthetic-fixture';
      const identityOrigin = new URL(authorizationUrl).origin;
      const externalRequests: string[] = [];
      const unexpectedExternalRequests: string[] = [];
      let interceptedIdentityNavigations = 0;
      // Continue the actual Next/proxy requests. Never send a fixture request to
      // the public network, including if the handoff unexpectedly changes host.
      await page.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        unexpectedExternalRequests.push(route.request().url());
        return route.abort();
      });
      await page.route(
        (url) => url.origin === identityOrigin,
        async (route) => {
          const outgoing = route.request();
          if (
            outgoing.url() !== authorizationUrl ||
            outgoing.method() !== 'GET' ||
            !outgoing.isNavigationRequest()
          ) {
            unexpectedExternalRequests.push(outgoing.url());
            return route.abort();
          }
          interceptedIdentityNavigations++;
          expect((await outgoing.allHeaders()).referer).toBeUndefined();
          return route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            headers: {
              'cache-control': 'no-store',
              'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
              'referrer-policy': 'no-referrer',
            },
            body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Synthetic identity checkpoint</title></head><body><h1>Synthetic identity checkpoint</h1><p>Locally intercepted fixture. No identity provider, account, agreement acceptance or receipt.</p></body></html>',
          });
        },
      );
      page.on('request', (outbound) => {
        if (new URL(outbound.url()).origin !== origin) externalRequests.push(outbound.url());
      });
      const notice = await page.goto('/auth/login');
      expect(notice?.status()).toBe(200);
      const headers = await notice!.allHeaders();
      expect(headers['content-type']).toMatch(/^text\/html\b/);
      expect(headers['cache-control']).toContain('no-store');
      expect(headers['referrer-policy']).toBe('same-origin');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['content-security-policy']).toContain("default-src 'none'");
      expect(headers['content-security-policy']).toContain("form-action 'self'");
      expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(headers['content-security-policy']).not.toContain("'unsafe-inline'");
      expect(headers['content-security-policy']).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/);
      await expect(
        page.getByRole('heading', { name: 'A clear start.', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('note')).toContainText('Draft for review — not yet effective.');
      await expect(page.getByRole('note')).toContainText('It does not accept these drafts.');
      await expect(page.getByText(/Terms version:.*Not effective/)).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Terms of Service', exact: true }),
      ).toHaveAttribute('href', '/terms');
      await expect(page.getByRole('link', { name: 'Privacy Notice', exact: true })).toHaveAttribute(
        'href',
        '/privacy',
      );
      await expect(page.locator('script, [onclick], [onsubmit]')).toHaveCount(0);
      const form = page.locator('form');
      await expect(form).toHaveAttribute('method', 'post');
      await expect(form).toHaveAttribute('action', '/auth/login');
      await expect(form.locator('input')).toHaveCount(2);
      await expect(form.locator('input[name="action"]')).toHaveValue('continue');
      const actionToken = await form.locator('input[name="actionToken"]').inputValue();
      expect(actionToken.length).toBeGreaterThan(0);
      const intentCookie = (await page.context().cookies(origin)).find(
        (value) => value.name === 'og_login_intent',
      );
      expect(intentCookie?.httpOnly).toBe(true);
      expect(intentCookie?.sameSite).toBe('Lax');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`terms-notice-${viewport.name}.png`),
        fullPage: true,
      });
      await info.attach(`Draft Terms notice — ${viewport.name}`, {
        path: info.outputPath(`terms-notice-${viewport.name}.png`),
        contentType: 'image/png',
      });

      const submitted = page.waitForRequest(
        (outbound) =>
          new URL(outbound.url()).pathname === '/auth/login' && outbound.method() === 'POST',
      );
      const continued = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/auth/login' &&
          response.request().method() === 'POST',
      );
      const arrived = page.waitForURL(authorizationUrl);
      await page.getByRole('button', { name: 'Continue to sign-in', exact: true }).click();
      const outbound = await submitted;
      const outboundHeaders = await outbound.allHeaders();
      expect(outboundHeaders.origin).toBe(origin);
      expect(outboundHeaders['content-type']).toMatch(/^application\/x-www-form-urlencoded/);
      expect(new URLSearchParams(outbound.postData() ?? '').get('actionToken')).toBe(actionToken);
      const response = await continued;
      expect(response.status()).toBe(200);
      const handoffHeaders = await response.allHeaders();
      expect(handoffHeaders['content-type']).toMatch(/^text\/html\b/);
      expect(handoffHeaders['cache-control']).toContain('no-store');
      expect(handoffHeaders['content-security-policy']).toContain("default-src 'none'");
      expect(handoffHeaders['content-security-policy']).toContain("form-action 'self'");
      expect(handoffHeaders['content-security-policy']).not.toContain(identityOrigin);
      // Chromium may discard the handoff body after the immediate navigation.
      // HTTP unit fixtures check its full markup; this test checks the real
      // browser's POST, security headers and automatic cross-origin arrival.
      await arrived;
      await expect(
        page.getByRole('heading', { name: 'Synthetic identity checkpoint', exact: true }),
      ).toBeVisible();
      expect(
        (await page.context().cookies(origin)).some((value) => value.name === 'og_login_intent'),
      ).toBe(false);
      expect(interceptedIdentityNavigations).toBe(1);
      expect(externalRequests).toEqual([authorizationUrl]);
      expect(unexpectedExternalRequests).toEqual([]);

      // The separate API fixture has no browser cookies. The signed action value
      // alone cannot bypass the HttpOnly intent binding or repeat the action.
      const replay = await request.post(`${origin}/auth/login`, {
        headers: { origin },
        form: { action: 'continue', actionToken },
      });
      expect(replay.status()).toBe(401);
      expect(await replay.json()).toMatchObject({ error: { code: 'login_intent_invalid' } });
      expect(replay.headers()['cache-control']).toContain('no-store');
    });
  });
}
