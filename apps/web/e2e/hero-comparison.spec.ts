import { expect, test } from '@playwright/test';

const comparisonEnabled = Boolean(process.env.OPENGEN_HERO_MEDIA_BASE_URL);

test.describe('split comparison homepage hero', () => {
  test.skip(!comparisonEnabled, 'Requires OPENGEN_HERO_MEDIA_BASE_URL to be configured.');

  test('renders agent-first hero over split video with price badges, compact prompt and lazy modal', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const modalVideoRequests: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (/\/hero\/[^/]+\/case-\d+\/(?!hero-split\.)[^/]+\.mp4(?:$|\?)/.test(url)) {
        modalVideoRequests.push(url);
      }
    });

    await page.goto('/');

    const hero = page.locator('.hero');
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText(
      'Image & video models.One open gateway.',
    );
    await expect(hero.getByRole('region', { name: 'Give this to your agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: /pause/i })).toHaveCount(0);

    // Model + resolution + cheapest price badges link directly to canonical series pages.
    // Exact promotional dates/expiry are covered deterministically in tests/hero-comparisons.test.ts.
    const leftBadge = hero.getByTestId('hero-badge-left');
    const rightBadge = hero.getByTestId('hero-badge-right');
    await expect(leftBadge).toContainText('Seedance 2.5');
    await expect(leftBadge).toContainText('720p');
    await expect(leftBadge).toContainText(/\$\d+\.\d{3}\/s/);
    await expect(leftBadge).toHaveAttribute('href', '/bytedance/seedance-2.5');
    await expect(rightBadge).toContainText('Kling 4.0');
    await expect(rightBadge).toContainText('720p');
    await expect(rightBadge).toContainText(/\$\d+\.\d{3}\/s/);
    await expect(rightBadge).toHaveAttribute('href', '/kling/kling-4.0');

    // Compact prompt capsule has no model labels or video playlist, and zero modal videos loaded yet.
    const dock = hero.getByTestId('hero-prompt-dock');
    await expect(dock).toBeVisible();
    await expect(dock).not.toContainText('Seedance');
    await expect(dock).not.toContainText('Kling');
    await expect(dock.getByRole('button', { name: 'Generate', exact: true })).toBeVisible();
    expect(modalVideoRequests).toEqual([]);

    // Verify desktop corner badges do not overlap the centered prompt dock.
    const [leftBox, rightBox, dockBox] = await Promise.all([
      leftBadge.boundingBox(),
      rightBadge.boundingBox(),
      dock.boundingBox(),
    ]);
    expect(leftBox).not.toBeNull();
    expect(rightBox).not.toBeNull();
    expect(dockBox).not.toBeNull();
    if (leftBox && rightBox && dockBox && Math.abs(leftBox.y - dockBox.y) < 40) {
      expect(leftBox.x + leftBox.width).toBeLessThan(dockBox.x);
      expect(dockBox.x + dockBox.width).toBeLessThan(rightBox.x);
    }

    // Clicking Generate opens the lazy comparison modal with both videos and homepage actions.
    await dock.getByRole('button', { name: 'Generate', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Shared Input' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('hero-modal-bar-left')).toContainText('720p');
    await expect(dialog.getByTestId('hero-modal-bar-right')).toContainText('720p');
    await expect(dialog.locator('video')).toHaveCount(2);
    await expect(dialog.getByRole('button', { name: 'Audio: Muted' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Copy prompt' })).toBeVisible();
    const inputImg = dialog.locator('.hero-modal-input-grid img');
    await expect(inputImg).toBeVisible();
    await expect
      .poll(() => inputImg.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await expect(dialog.getByRole('link', { name: 'CLI setup' })).toHaveAttribute(
      'href',
      '/agents/cli',
    );
    await expect(dialog.getByRole('link', { name: 'API setup' })).toHaveAttribute(
      'href',
      '/docs#http-examples',
    );
    await expect(dialog.getByRole('link', { name: 'Continue in browser' })).toHaveAttribute(
      'href',
      '/playground?model=bytedance%2Fseedance-2.5&operation=image-to-video',
    );

    // Cycle audio and close cleanly via Escape.
    await dialog.getByRole('button', { name: 'Audio: Muted' }).click();
    await expect(dialog.getByRole('button', { name: 'Audio: Seedance 2.5' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Clicking the prompt text trigger opens the exact same modal.
    await dock.getByRole('button', { name: 'Inspect shared input and comparison videos' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close comparison' }).click();
    await expect(dialog).toHaveCount(0);

    // Modal video fetches occurred only after user interaction.
    expect(modalVideoRequests.length).toBeGreaterThanOrEqual(2);
  });

  test('renders poster-first SSR HTML without video tags and rotates through diverse models with multi-ref modal', async ({
    page,
    request,
  }) => {
    const ssrRes = await request.get('/');
    expect(ssrRes.status()).toBe(200);
    const html = await ssrRes.text();
    expect(html).toContain('hero-poster.webp');
    expect(html).not.toContain('<video');

    await page.goto('/');
    const hero = page.locator('.hero');
    const rightBadge = hero.getByTestId('hero-badge-right');
    const splitVideo = hero.locator('.hero-split-video');

    await expect(splitVideo).toBeVisible();
    await expect(rightBadge).toContainText('Kling 4.0');

    // Advance clip 0 (Kling 4.0) -> clip 1 (Gemini Omni 1.2 Flash) -> clip 2 (FLUX 3 Video) -> clip 3 (Wan 3.0, 4 refs)
    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('Gemini Omni 1.2 Flash');
    await expect(rightBadge).toHaveAttribute('href', '/google/gemini-omni-1.2-flash');

    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('FLUX 3 Video');
    await expect(rightBadge).toHaveAttribute('href', '/bfl/flux-3-video');

    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('Wan 3.0');
    await expect(rightBadge).toHaveAttribute('href', '/alibaba/wan-3.0');

    // Open multi-ref modal on case-18 (Wan 3.0, 4 shared reference images)
    await hero
      .getByTestId('hero-prompt-dock')
      .getByRole('button', { name: 'Generate', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Shared Input' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('hero-modal-bar-right')).toContainText('Wan 3.0');
    await expect(dialog.locator('.hero-modal-input-strip figure')).toHaveCount(4);
    await expect(dialog.locator('.hero-modal-video-stage video').nth(1)).toHaveAttribute(
      'src',
      /\/wan-3\.0\.mp4$/,
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Advance clip 3 (Wan 3.0) -> clip 4 (Seedance 2.0) -> clip 5 (Seedance 2.5 Flash)
    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('Seedance 2.0');
    await expect(rightBadge).toHaveAttribute('href', '/bytedance/seedance-2.0');

    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('Seedance 2.5 Flash');
    await expect(rightBadge).toHaveAttribute(
      'href',
      '/bytedance/seedance-2.5?variant=bytedance%2Fseedance-2.5-flash',
    );

    // Advance clip 5 (Seedance 2.5 Flash) -> clip 6 (slot #7: case-17 Kling 4.0 1080p)
    await splitVideo.dispatchEvent('ended');
    await expect(rightBadge).toContainText('Kling 4.0');
    await expect(rightBadge).toContainText('1080p');
  });

  test.describe('phone viewport', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('stays inside viewport, skips background autoplay video and keeps Explore models reachable', async ({
      page,
    }) => {
      await page.goto('/');
      const overflow = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(overflow.width).toBeLessThanOrEqual(overflow.viewport);
      await expect(page.locator('.hero-media-split video')).toHaveCount(0);
      await expect(page.locator('.hero').getByTestId('hero-prompt-dock')).toBeVisible();
      await page
        .locator('.hero')
        .getByRole('link', { name: 'Explore models', exact: true })
        .click();
      await expect(page).toHaveURL(/\/models$/);
    });
  });
});
